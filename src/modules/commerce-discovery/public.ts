/**
 * MarketingOS module: /commerce-discovery
 * Authority: Commerce Discovery Mission (MKT-072 —
 * spec/effective-backlog-v1.6.md section E: "discover viable
 * products/niches, test demand via social experiments, recommend listing
 * candidates and learn from actual orders. Acceptance: market → candidate
 * → content → traffic → order → learning golden path with economic
 * guardrails."; spec/architecture-v1.6.md §15 "Commerce loop", §16
 * "Attribution", §17 "Budget and quota"; spec/architecture-lock-v1.6.md
 * rules 32/33; the frozen v1.6 matrix row, VERBATIM:
 * /commerce-discovery → /growth-missions, /product-intelligence,
 * /content-intelligence, /experiment-analysis, /integrations,
 * /platform-health; spec/module-dependency-matrix-v1.6.md boundary rule 8:
 * "Commerce Discovery never writes directly to catalog/order tables; store
 * mutations flow through Integrations.").
 *
 * MKT-072 implements the DISCOVERY MISSION RUNTIME for a commerce-
 * discovery Growth Mission — the golden path as auditable records:
 *
 *   - MARKET/NICHE SELECTION grounded in /product-intelligence +
 *     /content-intelligence reads: the DETERMINISTIC pure core (cd-plan-v1)
 *     derives the ranked niche selection, the listing-candidate proposals
 *     (recommendations as DATA), the demand-test plan and the composed
 *     economic gates from a record-derived input snapshot — every emitted
 *     row carries its rationale and its FK-anchored, scope-fenced citation
 *     links (which product-intelligence derived models, content candidates,
 *     content hypotheses, platform-health evaluations and experiment
 *     analyses produced it — auditable, reproducible: the same input
 *     snapshot + the same declared bounds → the same input digest → the
 *     honest replay convergence);
 *   - the BOUNDED-SPEND DECLARATIONS (the acceptance's core, the MKT-054
 *     budget convention): every version record carries the declared spend
 *     currency, the demand-test budget in minor units, the max demand-test
 *     count and the minimum-order-count viability gate — honest seams,
 *     fail-closed (no demand test launches without a current version; a
 *     launch that would exceed the remaining budget or the test-count
 *     bound is REFUSED, never silently continued);
 *   - PRODUCT/LISTING CANDIDATES with their provenance (which signals
 *     produced them — the FK-anchored citation links), their demand-test
 *     hypotheses (inputs to /experiments, never conclusions) and their
 *     declared estimated economics (data toward the human listing
 *     decision);
 *   - THE DEMAND-TEST EXPERIMENT ARM: a discovery mission's demand tests
 *     ARE experiments through the EXISTING /experiments authority — the
 *     module derives the experiment design deterministically and creates
 *     the experiment THROUGH the authority via the declared narrow
 *     structural port (no second experiment engine; this module owns no
 *     experiment table and no experiment lifecycle — the conclusion is
 *     read back BY REFERENCE from the authority's own concluded record);
 *   - THE LEARNING LOOP: outcome records whose observed order counts and
 *     per-currency order values are DERIVED from the REAL MKT-071 commerce
 *     events (the provider-ingested order projections read READ-ONLY
 *     through the /integrations public contract — actual orders are the
 *     ONLY order truth; never simulated sales; no simulated-demand-outcome
 *     channel exists anywhere in this module) plus the cited /metrics
 *     observations; the viability verdict evaluates against the declared
 *     economic gates; the LISTING RECOMMENDATION is DATA (never an
 *     auto-listing — no store-mutation verb exists in this module);
 *   - THE ECONOMIC GUARDRAILS: the guardrail evaluation composes the
 *     declared bounds against the REAL observed spend/demand-test/order
 *     values, cites the ACTIVE /policies network versions on the program's
 *     scope chain as its policy context (the declared boundary the
 *     commerce integration rides; the provider-touching enforcement itself
 *     lives inside /integrations — the sole enforcement point) and produces
 *     its honest verdict; a BREACH transitions the program to
 *     'guardrail_blocked' (the honest blocked state — demand-test launches
 *     are refused while blocked) with an EXPLICIT re-evaluation resolution
 *     path (the block is never silently continued and never silently
 *     lifted: the resolve command re-evaluates under the CURRENT declared
 *     bounds and only an honestly within-bounds observation unblocks).
 *
 * What it is NOT (the bounded scope — the MKT-066/MKT-070 posture):
 *
 *   - NO second mission authority: the mission record, its versions, its
 *     goal mappings and its lifecycle belong to /growth-missions (MKT-053)
 *     — a discovery mission IS a growth mission of the frozen §3
 *     'commerce_discovery' objective family, composed READ-ONLY (the
 *     family gate refuses every other family honestly);
 *   - NO second order/inventory/catalog authority (lock rules 32/33): no
 *     catalog, order, listing, price or inventory record is created,
 *     mutated or shadowed here; store mutations flow through Integrations
 *     and NEVER through this module — the listing recommendation is
 *     recorded DATA toward a human decision;
 *   - NO second experiment engine: the demand tests reference the
 *     /experiments authority's rows by FK anchor; no experiment lifecycle
 *     exists here;
 *   - NO second workflow/execution engine: no task/job pickup, no
 *     execution lifecycle, no dispatch, no scheduler/timer/loop exists
 *     anywhere in this module (the Growth Operator's bounded role);
 *   - NO provider calls of any kind: no social provider HTTP, no commerce
 *     provider HTTP, no adapter invocation — the learning loop reads the
 *     ALREADY-INGESTED commerce-event projections (the webhook ingestion
 *     path owns the provider boundary);
 *   - NO goal-progress computation, NO distribution dispatch (the 065
 *     authority), NO console surface (Worker C owns console/**).
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row registered for this Work
 * Item: /commerce-discovery ──→ /growth-missions, /product-intelligence,
 * /content-intelligence, /experiment-analysis, /integrations,
 * /platform-health — verbatim, all six consumed READ-ONLY through their
 * public contracts). The Work Item's /experiments dependency (the
 * demand-test arm) is satisfied through the declared narrow EXPERIMENT
 * LAUNCH PORT below (the MKT-070 /research off-matrix structural-port
 * precedent: the /experiments direction is deliberately NOT an import of
 * this row — the port is wired at the composition root and disclosed in
 * the runbook; the experiments authority stays sole). The /metrics
 * observation reads and the /policies active-version context arrive
 * through the same disclosed structural-port pattern (READ-ONLY).
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
import type { IntegrationsModuleApi } from '../integrations/public.ts';
import type { PlatformHealthModuleApi } from '../platform-health/public.ts';
import type { ProductIntelligenceModuleApi } from '../product-intelligence/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (cd-vocab-v1 — CHECK-fenced in migration 062;
// pinned by unit + boundary tests)
// ---------------------------------------------------------------------------

/**
 * The frozen strategy version of the deterministic selection core: the
 * niche-scoring table, the candidate-proposal derivation rules, the
 * demand-test design template and the guardrail ruleset. A change to ANY
 * of them is a NEW version string — the scoring is versioned, never
 * silently re-stated (the pm-plan-v1 discipline).
 */
export const COMMERCE_DISCOVERY_STRATEGY_VERSION = 'cd-plan-v1' as const;

/**
 * The frozen vocabulary version: the discovery lifecycle states, the
 * transition table, the event kinds, the guardrail verdicts + breach
 * reasons, the viability verdicts, the listing recommendations, the
 * demand-test states and the demand metric names. A change to ANY of them
 * is a NEW version string.
 */
export const COMMERCE_DISCOVERY_VOCABULARY_VERSION = 'cd-vocab-v1' as const;

/**
 * THE DISCOVERY FAMILY GATE: this runtime serves the 'commerce_discovery'
 * objective family of the frozen MKT-053 §3 vocabulary (VERBATIM from the
 * /growth-missions public contract). A mission of any other family is an
 * honest ConflictError — the runtime never re-states another family's
 * metric vocabulary.
 */
export const COMMERCE_DISCOVERY_MISSION_FAMILY = 'commerce_discovery' as const;

/**
 * The frozen discovery lifecycle state vocabulary (cd-vocab-v1):
 *   - active            — the discovery program is operating (born state);
 *   - guardrail_blocked — an economic-guardrail breach was recorded (the
 *                         honest blocked state; explicit resolution only);
 *   - concluded         — terminal: the program honestly concluded;
 *   - stopped_by_user   — terminal: the honest user stop.
 */
export const COMMERCE_DISCOVERY_STATUSES = [
  'active',
  'guardrail_blocked',
  'concluded',
  'stopped_by_user',
] as const;

export type CommerceDiscoveryStatus = (typeof COMMERCE_DISCOVERY_STATUSES)[number];

export function isKnownCommerceDiscoveryStatus(value: string): value is CommerceDiscoveryStatus {
  return (COMMERCE_DISCOVERY_STATUSES as readonly string[]).includes(value);
}

/** The frozen terminal-state list (no outgoing transitions). */
export const COMMERCE_DISCOVERY_TERMINAL_STATUSES = [
  'concluded',
  'stopped_by_user',
] as const;

export type CommerceDiscoveryTerminalStatus = (typeof COMMERCE_DISCOVERY_TERMINAL_STATUSES)[number];

export function isTerminalCommerceDiscoveryStatus(status: CommerceDiscoveryStatus): boolean {
  return (COMMERCE_DISCOVERY_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The frozen transition table (the GROWTH_MISSION_TRANSITIONS discipline):
 *
 *   active            → guardrail_blocked, concluded, stopped_by_user
 *   guardrail_blocked → active (the explicit re-evaluation resolution),
 *                       concluded, stopped_by_user
 *
 * TERMINAL states have NO outgoing transitions — the honest-state rule: a
 * blocked program can never be silently continued, and history is never
 * rewritten (the module transition table + the DB discipline are the
 * backstops).
 */
export const COMMERCE_DISCOVERY_TRANSITIONS: Readonly<
  Record<CommerceDiscoveryStatus, readonly CommerceDiscoveryStatus[]>
> = {
  active: ['guardrail_blocked', 'concluded', 'stopped_by_user'],
  guardrail_blocked: ['active', 'concluded', 'stopped_by_user'],
  concluded: [],
  stopped_by_user: [],
};

export function isLegalCommerceDiscoveryTransition(
  from: CommerceDiscoveryStatus,
  to: CommerceDiscoveryStatus,
): boolean {
  return COMMERCE_DISCOVERY_TRANSITIONS[from].includes(to);
}

/** The closed event-kind vocabulary of the append-only history tail. */
export const COMMERCE_DISCOVERY_EVENT_KINDS = [
  'discovery_created',
  'version_recorded',
  'state_transition',
  'candidate_recorded',
  'demand_test_launched',
  'demand_test_concluded',
  'outcome_recorded',
  'guardrail_evaluated',
  'guardrail_resolved',
] as const;

export type CommerceDiscoveryEventKind = (typeof COMMERCE_DISCOVERY_EVENT_KINDS)[number];

/** The closed demand-test state vocabulary. */
export const COMMERCE_DISCOVERY_DEMAND_TEST_STATES = [
  'launched',
  'concluded',
] as const;

export type CommerceDiscoveryDemandTestState =
  (typeof COMMERCE_DISCOVERY_DEMAND_TEST_STATES)[number];

/** The closed guardrail-verdict vocabulary (cd-guardrails-v1). */
export const COMMERCE_DISCOVERY_GUARDRAIL_VERDICTS = [
  'within_bounds',
  'breached',
] as const;

export type CommerceDiscoveryGuardrailVerdict =
  (typeof COMMERCE_DISCOVERY_GUARDRAIL_VERDICTS)[number];

/**
 * The closed breach-reason vocabulary: WHICH declared bound the REAL
 * observations crossed.
 */
export const COMMERCE_DISCOVERY_BREACH_REASONS = [
  'spend_exceeds_test_budget',
  'demand_tests_exceed_limit',
] as const;

export type CommerceDiscoveryBreachReason =
  (typeof COMMERCE_DISCOVERY_BREACH_REASONS)[number];

/** The closed viability-verdict vocabulary (the §15 economic gates). */
export const COMMERCE_DISCOVERY_VIABILITY_VERDICTS = [
  'viable',
  'not_viable',
  'insufficient_observations',
] as const;

export type CommerceDiscoveryViabilityVerdict =
  (typeof COMMERCE_DISCOVERY_VIABILITY_VERDICTS)[number];

/**
 * The closed listing-recommendation vocabulary — recorded DATA toward a
 * human decision (never an auto-listing).
 */
export const COMMERCE_DISCOVERY_RECOMMENDATIONS = [
  'recommend_listing',
  'recommend_iteration',
  'do_not_list',
] as const;

export type CommerceDiscoveryRecommendation =
  (typeof COMMERCE_DISCOVERY_RECOMMENDATIONS)[number];

/**
 * The frozen demand METRIC vocabulary (cd-metrics-v1): the closed metric
 * name set the derived experiment designs target — business-outcome-first
 * (observed orders are the honest demand truth; engagement signals ride
 * the cited /metrics observations, never the primary metric).
 */
export const COMMERCE_DISCOVERY_METRIC_NAMES = [
  'observed_order_count',
  'observed_order_value',
] as const;

export type CommerceDiscoveryMetricName =
  (typeof COMMERCE_DISCOVERY_METRIC_NAMES)[number];

/**
 * THE ORDER-TRUTH DISCLOSURE (shipped on every outcome view): actual
 * provider-ingested commerce events are the ONLY order truth — this
 * module never simulates sales, never fabricates demand outcomes and
 * performs no store mutation (lock rules 32/33).
 */
export const COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE =
  'observed orders derive exclusively from provider-ingested commerce events read through the integration boundary — actual orders are the only order truth, sales are never simulated, and no store mutation is performed by this module' as const;

/**
 * THE RECOMMENDATION DISCLOSURE (shipped on every candidate/outcome
 * view): the listing recommendation is recorded data toward a human
 * decision — never an auto-listing.
 */
export const COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE =
  'the listing recommendation is recorded data toward a human decision — never an auto-listing; this module holds no listing verb and performs no store mutation through any surface' as const;

/**
 * THE ATTRIBUTION-IS-NOT-CAUSALITY DISCLOSURE (the v1.6 rule, on every
 * outcome view): the observed orders are cited as learning observations —
 * attribution is distinct from causality and this record claims no causal
 * truth.
 */
export const COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE =
  'observed orders are cited as learning observations during the discovery window — attribution is distinct from causality and this record claims no causal truth' as const;

/**
 * THE GUARDRAIL DISCLOSURE (shipped on every evaluation view): the
 * economic guardrails evaluate the declared bounded-spend fields against
 * the real observations, cite the active policy context, and a breach
 * produces the honest blocked state — never a silent continue.
 */
export const COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE =
  'the economic guardrails evaluate the declared bounded-spend budget and demand-test bounds against the real observed spend and order facts with the active network policy versions cited as context — a breach produces the honest guardrail_blocked state, never a silent continue' as const;

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every discovery command (the
 * growth-missions precedent): built exclusively from the authenticated
 * principal, the ambient correlation context and the recording surface —
 * never from a request body.
 */
export interface CommerceDiscoveryProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface CommerceDiscoveryRecordedProvenance extends CommerceDiscoveryProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The pure-core input snapshots (record-derived facts ONLY — there is no
// verdict/plan/claim channel anywhere in these shapes)
// ---------------------------------------------------------------------------

/** The mission snapshot (the MKT-053 read model, consumed READ-ONLY). */
export interface DiscoveryMissionSnapshot {
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

/** The /product-intelligence context snapshot (the product-side input). */
export interface DiscoveryProductContextSnapshot {
  readonly productContextId: string;
  readonly currentVersionSeq: number;
  readonly name: string | null;
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
    readonly evidenceSourceFactIds: readonly string[];
  }[];
}

/** One /content-intelligence candidate (the niche-signal input). */
export interface DiscoveryContentCandidateSnapshot {
  readonly contentCandidateId: string;
  readonly topicEntity: string;
  readonly niche: string;
  readonly subNiche: string | null;
  readonly contentFormat: string;
  readonly audienceFit: string;
  readonly freshness: string;
  readonly novelty: string;
  readonly reuseRisk: string;
  /** The observed performance record (bounded scalar map). */
  readonly observedPerformance: Readonly<Record<string, unknown>>;
}

/** One /content-intelligence hypothesis (current, non-superseded only). */
export interface DiscoveryContentHypothesisSnapshot {
  readonly contentHypothesisId: string;
  readonly hypothesisKind: string;
}

/** One platform-health evaluation verdict (the platform-risk input). */
export interface DiscoveryHealthEvaluationSnapshot {
  readonly evaluationId: string;
  readonly socialAccountId: string;
  readonly platformId: string;
  readonly state: string;
  readonly confidence: string;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
}

/** One /experiment-analysis analysis result (the prior-analysis context). */
export interface DiscoveryExperimentAnalysisSnapshot {
  readonly analysisId: string;
  readonly experimentId: string;
  readonly outcome: string;
}

/**
 * The DECLARED bounded-spend bounds (the MKT-054 budget convention — the
 * acceptance's core): the honest seams the guardrails evaluate against.
 */
export interface CommerceDiscoveryDeclaredBounds {
  /** The currency of the budget and of every recorded demand-test spend. */
  readonly spendCurrency: string;
  /** The total demand-test spend bound, in minor units (0 = zero-budget). */
  readonly testBudgetMinorUnits: number;
  /** The maximum number of demand tests this program may launch (1..50). */
  readonly maxDemandTests: number;
  /** The minimum DISTINCT observed order count for candidate viability. */
  readonly minOrderCountForViability: number;
}

/**
 * THE PURE-CORE INPUT — the complete record-derived snapshot the
 * deterministic selection core consumes. Every field arrives from a durable
 * record of the consumed public contracts; there is NO channel for a
 * caller-declared verdict, score or plan fragment (the fabrication-
 * resistance discipline is STRUCTURAL: the pure core can only cite ids
 * present in this snapshot).
 */
export interface DiscoveryInput {
  readonly mission: DiscoveryMissionSnapshot;
  readonly productContext: DiscoveryProductContextSnapshot;
  /** The pursuit client's content candidates (bounded). */
  readonly contentCandidates: readonly DiscoveryContentCandidateSnapshot[];
  /** The pursuit client's CURRENT content hypotheses (bounded). */
  readonly contentHypotheses: readonly DiscoveryContentHypothesisSnapshot[];
  /** The pursuit client's platform-health evaluations (latest per account). */
  readonly healthEvaluations: readonly DiscoveryHealthEvaluationSnapshot[];
  /** The pursuit client's experiment analyses (newest first, bounded). */
  readonly experimentAnalyses: readonly DiscoveryExperimentAnalysisSnapshot[];
  /** The DECLARED bounded-spend bounds of this version. */
  readonly declared: CommerceDiscoveryDeclaredBounds;
}

// ---------------------------------------------------------------------------
// The pure-core output (the composed selection plan + its citation basis)
// ---------------------------------------------------------------------------

/** One typed citation — WHICH record produced a decision. */
export interface DiscoveryCitation {
  readonly kind:
    | 'product_derived_model'
    | 'content_candidate'
    | 'content_hypothesis'
    | 'platform_health_evaluation'
    | 'experiment_analysis';
  readonly refId: string;
}

/** One ranked niche-selection entry (the auditable market/niche row). */
export interface DiscoveryNicheSelectionEntry {
  readonly niche: string;
  readonly subNiches: readonly string[];
  /** The deterministic score (0..10000, basis-point scale). */
  readonly score: number;
  /** The weight share (basis points; the ranked top set sums to 10000). */
  readonly weightShareBps: number;
  readonly audienceFit: string;
  readonly freshness: string;
  readonly rationale: string;
  readonly citations: readonly DiscoveryCitation[];
}

/** One listing-candidate proposal (a recommendation as DATA). */
export interface DiscoveryCandidateProposalEntry {
  readonly label: string;
  readonly niche: string;
  readonly subNiche: string | null;
  readonly angle: string;
  readonly score: number;
  readonly rationale: string;
  readonly citations: readonly DiscoveryCitation[];
}

/**
 * THE BOUNDED-EXPERIMENT DISCLOSURE: the demand-test plan instantiates
 * through the EXISTING /experiments authority — this module creates the
 * experiment THROUGH the authority's public contract and owns no
 * experiment lifecycle (no second experiment engine).
 */
export const COMMERCE_DISCOVERY_EXPERIMENT_DISCLOSURE =
  'a discovery mission demand test is an experiment through the existing experiments authority — the design is derived deterministically and created through the authority contract, and this module owns no experiment lifecycle' as const;

/** The derived demand-test plan (the experiment design template). */
export interface DiscoveryDemandTestPlan {
  readonly designTemplate: {
    readonly designType: 'randomized';
    readonly primaryMetric: CommerceDiscoveryMetricName;
    readonly guardrailMetrics: readonly CommerceDiscoveryMetricName[];
    readonly analysisMethod: string;
    readonly analysisMethodVersion: string;
    readonly expectedDirection: 'increase';
    readonly minimumEvidenceRequirement: string;
    readonly uncertaintyRepresentation: 'interval';
  };
  readonly stopCriteriaTemplate: string;
  readonly boundedBy: 'experiments-authority';
  readonly disclosure: typeof COMMERCE_DISCOVERY_EXPERIMENT_DISCLOSURE;
  readonly rationale: string;
  readonly citations: readonly DiscoveryCitation[];
}

/** The composed economic gates (the declared bounds as the contract). */
export interface DiscoveryEconomicGates {
  readonly spendCurrency: string;
  readonly testBudgetMinorUnits: number;
  readonly maxDemandTests: number;
  readonly minOrderCountForViability: number;
  readonly disclosure: typeof COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE;
}

/** One auditable decision entry of the selection core. */
export interface DiscoveryDecisionEntry {
  readonly decisionKey: string;
  readonly summary: string;
  readonly rationale: string;
  readonly citations: readonly DiscoveryCitation[];
}

/** The composed discovery plan (the complete deterministic output). */
export interface ComposedCommerceDiscoveryPlan {
  readonly strategyVersion: typeof COMMERCE_DISCOVERY_STRATEGY_VERSION;
  readonly inputDigest: string;
  readonly nicheSelection: readonly DiscoveryNicheSelectionEntry[];
  readonly candidateProposals: readonly DiscoveryCandidateProposalEntry[];
  readonly demandTestPlan: DiscoveryDemandTestPlan;
  readonly economicGates: DiscoveryEconomicGates;
  readonly decisions: readonly DiscoveryDecisionEntry[];
  /** The deduplicated full citation set (the FK-anchored basis). */
  readonly citations: readonly DiscoveryCitation[];
}

// ---------------------------------------------------------------------------
// Records (the migration 062 storage shapes)
// ---------------------------------------------------------------------------

/** One persisted discovery-program header (ONE per mission; the state + CAS). */
export interface CommerceDiscoveryMissionRecord {
  readonly discoveryMissionId: string;
  readonly missionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly status: CommerceDiscoveryStatus;
  /** The program's CURRENT version (the version-tail pointer). */
  readonly currentVersionSeq: number;
  /** The CAS token (row-locked version advance). */
  readonly version: number;
  readonly createdActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One IMMUTABLE version record (the append-only tail). */
export interface CommerceDiscoveryVersionRecord {
  readonly discoveryVersionId: string;
  readonly discoveryMissionId: string;
  readonly versionSeq: number;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly storeConnectionId: string;
  readonly declared: CommerceDiscoveryDeclaredBounds;
  /** The REQUIRED reason every version carries. */
  readonly reason: string;
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
  readonly inputDigest: string;
  readonly nicheSelection: readonly DiscoveryNicheSelectionEntry[];
  readonly candidateProposals: readonly DiscoveryCandidateProposalEntry[];
  readonly demandTestPlan: DiscoveryDemandTestPlan;
  readonly economicGates: DiscoveryEconomicGates;
  readonly decisions: readonly DiscoveryDecisionEntry[];
  readonly strategyVersion: typeof COMMERCE_DISCOVERY_STRATEGY_VERSION;
  readonly provenance: CommerceDiscoveryRecordedProvenance;
  readonly createdAt: string;
}

/** The kind-specific structured detail of a history event (bounded data). */
export type CommerceDiscoveryEventDetail =
  | { readonly kind: 'version'; readonly versionSeq: number }
  | { readonly kind: 'candidate'; readonly candidateId: string }
  | { readonly kind: 'demand_test'; readonly demandTestId: string; readonly experimentId: string }
  | { readonly kind: 'outcome'; readonly outcomeId: string; readonly candidateId: string }
  | { readonly kind: 'evaluation'; readonly evaluationId: string; readonly verdict: string }
  | null;

/** One append-only history event of the discovery program. */
export interface CommerceDiscoveryEventRecord {
  readonly eventId: string;
  readonly discoveryMissionId: string;
  /** Gapless per-program sequence (assigned under the mission row lock). */
  readonly eventSeq: number;
  readonly eventKind: CommerceDiscoveryEventKind;
  readonly fromStatus: CommerceDiscoveryStatus | null;
  readonly toStatus: CommerceDiscoveryStatus | null;
  /** The REQUIRED reason every event carries. */
  readonly reason: string;
  readonly detail: CommerceDiscoveryEventDetail;
  readonly provenance: CommerceDiscoveryRecordedProvenance;
}

/** One APPEND-ONLY product/listing candidate record. */
export interface CommerceDiscoveryCandidateRecord {
  readonly candidateId: string;
  readonly discoveryMissionId: string;
  readonly missionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly label: string;
  readonly niche: string;
  readonly subNiche: string | null;
  readonly productDescriptor: string;
  readonly estimatedCostMinorUnits: number;
  readonly estimatedPriceMinorUnits: number;
  readonly economicsCurrency: string;
  /** The REQUIRED demand-test hypothesis (an input, never a conclusion). */
  readonly demandHypothesis: string;
  readonly provenance: CommerceDiscoveryRecordedProvenance;
  readonly createdAt: string;
}

/** One demand-test arm record (the experiment THROUGH the authority). */
export interface CommerceDiscoveryDemandTestRecord {
  readonly demandTestId: string;
  readonly discoveryMissionId: string;
  readonly candidateId: string;
  readonly missionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  /** The /experiments authority's experiment id (FK-anchored reference). */
  readonly experimentId: string;
  /** The RECORDED test-spend bookkeeping (minor units, declared currency). */
  readonly testSpendMinorUnits: number;
  readonly spendCurrency: string;
  /** The derived experiment design this test instantiated (auditable). */
  readonly derivedExperimentDesign: Readonly<Record<string, unknown>>;
  readonly state: CommerceDiscoveryDemandTestState;
  /** The conclusion read-back (set by the conclusion advance only). */
  readonly conclusionResultState: string | null;
  readonly conclusionUncertaintyRepresentation: string | null;
  readonly conclusionRecordedAt: string | null;
  readonly provenance: CommerceDiscoveryRecordedProvenance;
  readonly createdAt: string;
}

/** One APPEND-ONLY learning-loop outcome record. */
export interface CommerceDiscoveryOutcomeRecord {
  readonly outcomeId: string;
  readonly discoveryMissionId: string;
  readonly candidateId: string;
  readonly missionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  /** The observed DISTINCT order count (cancelled disclosed separately). */
  readonly observedOrderCount: number;
  readonly observedCancelledOrderCount: number;
  /** The observed order value per currency (NO cross-currency aggregation). */
  readonly observedOrderValues: Readonly<Record<string, number>>;
  readonly viabilityVerdict: CommerceDiscoveryViabilityVerdict;
  readonly listingRecommendation: CommerceDiscoveryRecommendation;
  readonly rationale: string;
  readonly reason: string;
  readonly provenance: CommerceDiscoveryRecordedProvenance;
  readonly createdAt: string;
}

/** One APPEND-ONLY economic-guardrail evaluation record. */
export interface CommerceDiscoveryGuardrailEvaluationRecord {
  readonly evaluationId: string;
  readonly discoveryMissionId: string;
  readonly missionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  /** The evaluated DECLARED bounds (copied from the current version). */
  readonly evaluated: {
    readonly spendCurrency: string;
    readonly testBudgetMinorUnits: number;
    readonly maxDemandTests: number;
  };
  /** The REAL observed values (derived from the durable records). */
  readonly observed: {
    readonly spendMinorUnits: number;
    readonly demandTestCount: number;
    readonly orderCount: number;
  };
  readonly verdict: CommerceDiscoveryGuardrailVerdict;
  readonly breachReasons: readonly CommerceDiscoveryBreachReason[];
  readonly rationale: string;
  readonly reason: string;
  readonly provenance: CommerceDiscoveryRecordedProvenance;
  readonly createdAt: string;
}

/** The composed candidate read-back (record + citations + disclosures). */
export interface CommerceDiscoveryCandidateDetail {
  readonly candidate: CommerceDiscoveryCandidateRecord;
  readonly citations: readonly DiscoveryCitation[];
  readonly recommendationDisclosure: typeof COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE;
}

/**
 * The composed honest read-back: the header, the CURRENT version, the
 * complete append-only version tail, the candidates, demand tests,
 * outcomes, guardrail evaluations, the complete history and the
 * disclosures — the golden path in one view.
 */
export interface CommerceDiscoveryDetail {
  readonly mission: CommerceDiscoveryMissionRecord;
  readonly currentVersion: CommerceDiscoveryVersionRecord;
  readonly versions: readonly CommerceDiscoveryVersionRecord[];
  readonly candidates: readonly CommerceDiscoveryCandidateDetail[];
  readonly demandTests: readonly CommerceDiscoveryDemandTestRecord[];
  readonly outcomes: readonly CommerceDiscoveryOutcomeRecord[];
  readonly guardrailEvaluations: readonly CommerceDiscoveryGuardrailEvaluationRecord[];
  readonly history: readonly CommerceDiscoveryEventRecord[];
  readonly orderTruthDisclosure: typeof COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE;
  readonly recommendationDisclosure: typeof COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE;
  readonly attributionDisclosure: typeof COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE;
  readonly guardrailDisclosure: typeof COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE;
}

// ---------------------------------------------------------------------------
// Structural ports (the disclosed off-matrix wiring — the MKT-070
// /research precedent: narrow declared surfaces; the real module
// instances satisfy them structurally at the composition root)
// ---------------------------------------------------------------------------

/**
 * The experiment read-back shape (a structural subset of the /experiments
 * authority's public record — the fields the demand-test arm consumes).
 */
export interface CommerceDiscoveryExperimentSnapshot {
  readonly experimentId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly status: string;
  readonly resultState: string;
  readonly uncertaintyRepresentation: string;
  readonly hypothesis: string;
  readonly decisionTarget: string;
}

/** The derived experiment design payload (mirrors the authority's create input). */
export interface CommerceDiscoveryDerivedExperimentDesign {
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly hypothesis: string;
  readonly decisionTarget: string;
  readonly populationUnit: string;
  readonly treatment: string;
  readonly comparison: string;
  readonly assignmentMethod: string;
  readonly designType: 'randomized';
  readonly primaryMetric: {
    readonly name: CommerceDiscoveryMetricName;
    readonly dimensions: Readonly<Record<string, string>>;
  };
  readonly guardrails: readonly {
    readonly name: CommerceDiscoveryMetricName;
    readonly dimensions: Readonly<Record<string, string>>;
  }[];
  readonly analysisMethod: string;
  readonly analysisMethodVersion: string | null;
  readonly expectedDirection: 'increase';
  readonly startCriteria: string | null;
  readonly stopCriteria: string;
  readonly minimumEvidenceRequirement: string;
  readonly uncertaintyRepresentation: 'interval';
}

/**
 * THE EXPERIMENT LAUNCH PORT — the demand-test experiment arm through the
 * EXISTING /experiments authority (the MKT-070 /research off-matrix
 * structural-port precedent: the /experiments direction is deliberately
 * NOT an import of this module's frozen row). The concrete
 * ExperimentsModuleApi satisfies this structurally at the composition
 * root; the authority stays sole — this port creates experiments THROUGH
 * the authority's own validated command and reads them back READ-ONLY.
 */
export interface CommerceDiscoveryExperimentLaunchPort {
  /** Creates one experiment THROUGH the authority (its full validated contract). */
  createExperiment(
    input: CommerceDiscoveryDerivedExperimentDesign,
    provenance: CommerceDiscoveryProvenance,
  ): Promise<CommerceDiscoveryExperimentSnapshot>;
  /** The experiment read-back (READ-ONLY — the authority's own record). */
  getExperiment(experimentId: string): Promise<CommerceDiscoveryExperimentSnapshot | null>;
}

/** The metric-observation read-back shape (a structural subset). */
export interface CommerceDiscoveryMetricObservationSnapshot {
  readonly observationId: string;
  readonly clientId: string;
  readonly metricName: string;
  readonly value: number;
  readonly unit: string;
}

/**
 * THE METRICS OBSERVATION PORT — the /metrics observation reads of the
 * learning loop (READ-ONLY; the same disclosed off-matrix wiring pattern;
 * the concrete MetricsModuleApi satisfies this structurally at the
 * composition root).
 */
export interface CommerceDiscoveryMetricsObservationPort {
  getMetricObservation(
    observationId: string,
  ): Promise<CommerceDiscoveryMetricObservationSnapshot | null>;
  listMetricObservationsForClient(
    clientId: string,
  ): Promise<readonly CommerceDiscoveryMetricObservationSnapshot[]>;
}

/** The active-policy-version read-back shape (a structural subset). */
export interface CommerceDiscoveryPolicyVersionSnapshot {
  readonly policyId: string;
  readonly dimension: string;
  readonly scopeKind: string;
  readonly agencyId: string | null;
  readonly clientId: string | null;
  readonly status: string;
  readonly versionSeq: number;
}

/**
 * THE POLICY CONTEXT PORT — the /policies ACTIVE network versions cited as
 * the guardrail evaluation's policy context (READ-ONLY declared-boundary
 * reads; the same disclosed off-matrix wiring pattern; the concrete
 * PoliciesModuleApi satisfies this structurally at the composition root).
 * The provider-touching enforcement itself lives inside /integrations (the
 * sole enforcement point) — this port supplies the declared-boundary
 * context the evaluation records, never a second policy engine.
 */
export interface CommerceDiscoveryPolicyContextPort {
  getActivePolicyVersion(input: {
    readonly scope: { readonly agencyId: string | null; readonly clientId: string | null };
    readonly dimension: 'network';
  }): Promise<CommerceDiscoveryPolicyVersionSnapshot | null>;
}

/**
 * The pursuit-scope workspace port (the Growth Operator's off-matrix
 * composition exactly — the MKT-068/MKT-070 precedent: the canonical
 * workspace → client → agency chain validates the pursuit scope; the
 * workspace is never mutated).
 */
export interface CommerceDiscoveryWorkspacePort {
  resolveWorkspace(workspaceId: string): Promise<{
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly status: string;
  } | null>;
}

/**
 * The canonical program owner context (the route-layer authorization
 * input): the program header resolved to its owning agency through the
 * mission anchor (the mission authority's own ownership chain — /agencies
 * is not an allowance of this module's row; the route layer resolves it).
 */
export interface CommerceDiscoveryOwnerContext {
  readonly scope: {
    readonly kind: 'commerce_discovery_program';
    readonly agencyId: string;
    readonly missionId: string;
    readonly discoveryMissionId: string;
  };
  readonly program: CommerceDiscoveryMissionRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface CommerceDiscoveryModuleApi {
  /**
   * COMPOSES (or convergently replays) the discovery program's plan for a
   * mission — the deterministic, auditable selection command:
   *
   *   1. resolves the mission through the /growth-missions public contract
   *      (READ-ONLY — the mission authority stays sole): unknown mission →
   *      the uniform 404; a TERMINAL mission is an honest ConflictError
   *      (terminal history is frozen); a mission whose declared objective
   *      family is NOT 'commerce_discovery' is an honest ConflictError
   *      (this runtime is family-scoped);
   *   2. resolves the cited /product-intelligence Product Context through
   *      its public contract (READ-ONLY): unknown context → the uniform
   *      404; a context of ANOTHER agency than the mission is the uniform
   *      404 (a foreign product context is not a traversal oracle);
   *   3. resolves the DECLARED STORE CONNECTION through the /integrations
   *      public contract (READ-ONLY — the commerce boundary anchor):
   *      unknown connection → the uniform 404; a connection of another
   *      client than the pursuit client is the uniform 404;
   *   4. resolves the PURSUIT SCOPE through the workspace port (the
   *      operator's pursuit-scope composition): unknown workspace or a
   *      workspace of another agency than the mission → the uniform 404;
   *      a disabled workspace → ConflictError;
   *   5. reads the pursuit client's content candidates, CURRENT content
   *      hypotheses, platform-health evaluations (latest per account) and
   *      experiment analyses (newest first, bounded) — all READ-ONLY
   *      through the frozen-row public contracts;
   *   6. validates the DECLARED bounded-spend bounds (the honest seams);
   *   7. runs the DETERMINISTIC pure core (cd-plan-v1) and appends ONE
   *      immutable version record (+ its FK-anchored citation links) with
   *      the REQUIRED reason + provenance — IDEMPOTENTLY: when the latest
   *      version's input digest equals the composed digest, the command
   *      converges to the EXISTING version (the honest replay — no
   *      duplicate version, no silent rewrite).
   *
   * The first composition creates the program header (ONE program per
   * mission — concurrent first compositions converge under the program row
   * lock; born 'active'). A compose input is exactly the durable
   * references + the declared bounds + the REQUIRED reason — there is NO
   * channel for a caller-declared selection, proposal, verdict or
   * citation (the fabrication-resistance discipline is structural).
   */
  composeCommerceDiscoveryPlan(
    input: {
      readonly missionId: string;
      readonly productContextId: string;
      readonly pursuitWorkspaceId: string;
      readonly storeConnectionId: string;
      readonly declared: CommerceDiscoveryDeclaredBounds;
      /** The REQUIRED reason this version is recorded (1..4000 chars). */
      readonly reason: string;
    },
    provenance: CommerceDiscoveryProvenance,
  ): Promise<CommerceDiscoveryDetail>;

  /** Raw program header by mission id (null when no program exists). */
  getCommerceDiscoveryMission(missionId: string): Promise<CommerceDiscoveryMissionRecord | null>;

  /**
   * Canonical program ownership resolution: the program header composed
   * into the canonical owner context. Null when no program exists for the
   * mission — callers surface the uniform 404 so foreign, unknown and
   * unmapped mission identifiers are indistinguishable.
   */
  resolveCommerceDiscoveryOwnership(
    missionId: string,
  ): Promise<CommerceDiscoveryOwnerContext | null>;

  /**
   * The composed honest read-back: the header + the CURRENT version + the
   * complete append-only version tail + the candidates with their
   * citations + the demand tests + the outcomes + the guardrail
   * evaluations + the complete history + the disclosures. Null when no
   * program exists.
   */
  getCommerceDiscoveryDetail(missionId: string): Promise<CommerceDiscoveryDetail | null>;

  /** The append-only version tail (oldest first). Null when no program exists. */
  getCommerceDiscoveryVersions(
    missionId: string,
  ): Promise<readonly CommerceDiscoveryVersionRecord[] | null>;

  /**
   * RECORDS one product/listing candidate — the provenance-cited proposal
   * being pursued. Requires a NON-TERMINAL program (terminal history is
   * frozen) and a NON-TERMINAL mission; every provenance citation must
   * resolve READ-ONLY through the frozen-row public contracts to records
   * of the program's scope (a foreign citation is the uniform 404, never a
   * traversal oracle); product-derived-model citations must belong to the
   * program's CURRENT cited product context. The candidate is APPEND-ONLY
   * (a new observation is a NEW candidate record). Appends one
   * 'candidate_recorded' event.
   */
  recordCommerceDiscoveryCandidate(
    input: {
      readonly missionId: string;
      readonly label: string;
      readonly niche: string;
      readonly subNiche: string | null;
      readonly productDescriptor: string;
      readonly estimatedCostMinorUnits: number;
      readonly estimatedPriceMinorUnits: number;
      readonly economicsCurrency: string;
      readonly demandHypothesis: string;
      /** The provenance citations (which signals produced this candidate). */
      readonly productDerivedModelIds: readonly string[];
      readonly contentCandidateIds: readonly string[];
      readonly contentHypothesisIds: readonly string[];
    },
    provenance: CommerceDiscoveryProvenance,
  ): Promise<CommerceDiscoveryCandidateDetail>;

  /** Raw candidate record by id (append-only history is always readable). */
  getCommerceDiscoveryCandidate(
    candidateId: string,
  ): Promise<CommerceDiscoveryCandidateRecord | null>;

  /** The program's candidates (oldest first). Null when no program exists. */
  listCommerceDiscoveryCandidates(
    missionId: string,
  ): Promise<readonly CommerceDiscoveryCandidateRecord[] | null>;

  /**
   * LAUNCHES one demand test — the experiment arm THROUGH the /experiments
   * authority:
   *
   *   1. requires an 'active' program (a guardrail_blocked or terminal
   *      program refuses new spend honestly — ConflictError) and a
   *      NON-TERMINAL mission;
   *   2. resolves the candidate (the program's own — the uniform 404
   *      otherwise);
   *   3. FAIL-CLOSED BUDGET PRE-GATE: the recorded spend must be in the
   *      CURRENT version's declared currency (never converted — no FX
   *      authority exists) and the cumulative observed spend + this test's
   *      spend must not exceed the declared test budget; the demand-test
   *      count must not exceed the declared max (ConflictError otherwise —
   *      the launch is REFUSED, never silently continued);
   *   4. derives the experiment design deterministically (cd-plan-v1) and
   *      creates the experiment THROUGH the authority's validated command
   *      (the launch port);
   *   5. appends the demand-test record (born 'launched') with the
   *      recorded spend bookkeeping + the derived design + the experiment
   *      reference, and one 'demand_test_launched' event.
   */
  launchCommerceDiscoveryDemandTest(
    input: {
      readonly missionId: string;
      readonly candidateId: string;
      /** The RECORDED test spend (minor units, the declared currency). */
      readonly testSpendMinorUnits: number;
      /** The REQUIRED reason this demand test launches (1..4000 chars). */
      readonly reason: string;
    },
    provenance: CommerceDiscoveryProvenance,
  ): Promise<CommerceDiscoveryDemandTestRecord>;

  /**
   * RECORDS the demand test's conclusion — the honest read-back from the
   * /experiments authority (READ-ONLY through the launch port): the
   * authority's experiment must itself be CONCLUDED (ConflictError
   * otherwise — never a fabricated conclusion); the SINGLE guarded advance
   * copies the authority's own result state + uncertainty representation
   * onto the demand-test record and appends one 'demand_test_concluded'
   * event. The advance is single-shot (a second conclusion attempt is an
   * honest ConflictError).
   */
  recordCommerceDiscoveryDemandTestConclusion(
    input: {
      readonly missionId: string;
      readonly demandTestId: string;
      /** The REQUIRED reason the conclusion is recorded (1..4000 chars). */
      readonly reason: string;
    },
    provenance: CommerceDiscoveryProvenance,
  ): Promise<CommerceDiscoveryDemandTestRecord>;

  /** The program's demand tests (oldest first). Null when no program exists. */
  listCommerceDiscoveryDemandTests(
    missionId: string,
  ): Promise<readonly CommerceDiscoveryDemandTestRecord[] | null>;

  /**
   * RECORDS one learning-loop outcome — the honest observation derived
   * from the REAL commerce events:
   *
   *   1. requires a NON-TERMINAL program (observations are recordable
   *      while 'active' AND while 'guardrail_blocked' — the learning loop
   *      feeds the resolution; a terminal program's history is frozen);
   *   2. resolves the candidate (the program's own — the uniform 404);
   *   3. reads the cited commerce events READ-ONLY through the
   *      /integrations public contract: every cited event id must be one
   *      of the pursuit client's INGESTED order events from the declared
   *      store connection (a foreign/unknown/non-order event is the
   *      uniform 404 — never a fabricated observation; actual orders are
   *      the ONLY order truth);
   *   4. resolves the optionally cited /metrics observations READ-ONLY
   *      (same client — the uniform 404 otherwise);
   *   5. DERIVES the observed values deterministically (the distinct
   *      non-cancelled order count, the cancelled count, the per-currency
   *      value sums with NO cross-currency aggregation), evaluates the
   *      viability verdict against the CURRENT version's declared economic
   *      gates and derives the listing recommendation AS DATA;
   *   6. appends the outcome record (+ its FK-anchored citation links)
   *      with the REQUIRED reason, and one 'outcome_recorded' event.
   */
  recordCommerceDiscoveryOutcome(
    input: {
      readonly missionId: string;
      readonly candidateId: string;
      /** The REAL commerce-event ids the observation derives from (≥1). */
      readonly commerceEventIds: readonly string[];
      /** The optionally co-cited /metrics observation ids. */
      readonly metricObservationIds: readonly string[];
      /** The REQUIRED reason this observation is recorded (1..4000 chars). */
      readonly reason: string;
    },
    provenance: CommerceDiscoveryProvenance,
  ): Promise<CommerceDiscoveryOutcomeRecord>;

  /** The program's outcomes (oldest first). Null when no program exists. */
  listCommerceDiscoveryOutcomes(
    missionId: string,
  ): Promise<readonly CommerceDiscoveryOutcomeRecord[] | null>;

  /**
   * EVALUATES the economic guardrails — the acceptance's core:
   *
   *   1. requires a NON-TERMINAL program;
   *   2. composes the REAL observations: the demand-test spend sum + count
   *      from the program's OWN demand-test records, and the observed
   *      order count derived from the pursuit client's INGESTED order
   *      events of the declared store connection (READ-ONLY through
   *      /integrations);
   *   3. composes the POLICY CONTEXT: the ACTIVE /policies network
   *      versions on the program's scope chain (platform / agency /
   *      client), read READ-ONLY through the policy context port and
   *      CITED on the evaluation record (the declared boundary the
   *      commerce integration rides — the provider-touching enforcement
   *      itself lives inside /integrations);
   *   4. evaluates the frozen ruleset (cd-guardrails-v1, deterministic):
   *      observed spend > declared budget → 'spend_exceeds_test_budget';
   *      observed demand-test count > declared max →
   *      'demand_tests_exceed_limit'; any breach → verdict 'breached';
   *   5. appends the evaluation record (+ its FK-anchored citation links)
   *      with the REQUIRED reason, and one 'guardrail_evaluated' event;
   *   6. A BREACH transitions the program to 'guardrail_blocked' (the
   *      honest blocked state — row-locked CAS with the transition event;
   *      never a silent continue).
   */
  evaluateCommerceDiscoveryGuardrails(
    input: {
      readonly missionId: string;
      /** The REQUIRED reason this evaluation runs (1..4000 chars). */
      readonly reason: string;
    },
    provenance: CommerceDiscoveryProvenance,
  ): Promise<CommerceDiscoveryGuardrailEvaluationRecord>;

  /**
   * RESOLVES a guardrail block — the EXPLICIT path (never a silent lift):
   * requires a 'guardrail_blocked' program, RE-EVALUATES the guardrails
   * under the CURRENT declared bounds (a budget-raising version may have
   * been recorded — an auditable declaration) and transitions back to
   * 'active' ONLY when the honest observation is within bounds (the
   * re-evaluation record + the 'guardrail_resolved' event are appended;
   * a still-breached observation is an honest ConflictError — the block
   * stands).
   */
  resolveCommerceDiscoveryGuardrailBlock(
    input: {
      readonly missionId: string;
      /** The REQUIRED reason the block is resolved (1..4000 chars). */
      readonly reason: string;
    },
    provenance: CommerceDiscoveryProvenance,
  ): Promise<CommerceDiscoveryDetail>;

  /** The program's guardrail evaluations (oldest first). Null when no program exists. */
  listCommerceDiscoveryGuardrailEvaluations(
    missionId: string,
  ): Promise<readonly CommerceDiscoveryGuardrailEvaluationRecord[] | null>;

  /**
   * CAS lifecycle transition guarded by the frozen
   * COMMERCE_DISCOVERY_TRANSITIONS table (row-locked transaction): append-only
   * 'state_transition' event with the REQUIRED reason + actor + provenance.
   * TERMINAL states have no outgoing transitions (the module table is the
   * guard; history is never rewritten). The 'guardrail_blocked' ↔ 'active'
   * pair is owned by the evaluation/resolve commands (passing those
   * targets here is an honest ConflictError — the guarded transitions
   * carry their own evidence).
   */
  setCommerceDiscoveryStatus(
    input: {
      readonly missionId: string;
      readonly status: CommerceDiscoveryStatus;
      /** The REQUIRED transition reason (bounded, honest). */
      readonly reason: string;
    },
    provenance: CommerceDiscoveryProvenance,
  ): Promise<CommerceDiscoveryDetail>;
}

export interface CommerceDiscoveryModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Frozen matrix: /commerce-discovery ──→ /growth-missions — the mission DATA MODEL, READ-ONLY. */
  readonly missions: GrowthMissionsModuleApi;
  /** Frozen matrix: /commerce-discovery ──→ /product-intelligence — the product context, READ-ONLY. */
  readonly productIntelligence: ProductIntelligenceModuleApi;
  /** Frozen matrix: /commerce-discovery ──→ /content-intelligence — the candidates/hypotheses surface, READ-ONLY. */
  readonly contentIntelligence: ContentIntelligenceModuleApi;
  /** Frozen matrix: /commerce-discovery ──→ /experiment-analysis — the prior-analysis context, READ-ONLY. */
  readonly experimentAnalysis: ExperimentAnalysisModuleApi;
  /** Frozen matrix: /commerce-discovery ──→ /integrations — the commerce boundary (connections + order events), READ-ONLY. */
  readonly integrations: IntegrationsModuleApi;
  /** Frozen matrix: /commerce-discovery ──→ /platform-health — the descriptive health states, READ-ONLY. */
  readonly platformHealth: PlatformHealthModuleApi;
  /**
   * The disclosed off-matrix experiment launch port (the demand-test arm
   * through the EXISTING /experiments authority — the MKT-070 /research
   * precedent): experiments are created THROUGH the authority and read
   * back READ-ONLY; no second experiment engine.
   */
  readonly experimentLaunches: CommerceDiscoveryExperimentLaunchPort;
  /**
   * The disclosed off-matrix metrics observation port (READ-ONLY — the
   * learning loop's co-cited observations).
   */
  readonly metricObservations: CommerceDiscoveryMetricsObservationPort;
  /**
   * The disclosed off-matrix policy context port (READ-ONLY — the ACTIVE
   * network versions cited as the guardrail evaluations' policy context).
   */
  readonly policyContext: CommerceDiscoveryPolicyContextPort;
  /**
   * The disclosed off-matrix pursuit-scope port (the Growth Operator's
   * exact composition — the MKT-070 precedent): workspace → client →
   * agency, READ-ONLY.
   */
  readonly workspaces: CommerceDiscoveryWorkspacePort;
}

export { createCommerceDiscoveryModule } from './internal/commerce-discovery-module.ts';
/**
 * The pure deterministic selection/guardrail/outcome cores (the cd-plan-v1
 * niche scoring, the candidate-proposal derivation, the demand-test design
 * template, the economic-gate composition, the deterministic input digest,
 * the cd-guardrails-v1 evaluation ruleset and the outcome derivation over
 * the real commerce-event shapes) and the input guards — exported for unit
 * tests and future server-side callers so the discovery semantics are part
 * of the module contract. Pure functions: no clock, no randomness, no
 * network, no I/O.
 */
export {
  composeCommerceDiscoveryPlanCore,
  computeDiscoveryInputDigest,
  evaluateGuardrailsCore,
  deriveOutcomeCore,
  deriveDemandTestDesign,
  cite,
  assertValidCommerceDiscoveryProvenance,
  assertValidComposeCommerceDiscoveryPlanInput,
  assertValidDeclaredBounds,
} from './internal/planning.ts';
