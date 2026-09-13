/**
 * MarketingOS module: /profit-intelligence (MKT-043 — Profit Intelligence).
 *
 * Authority: DERIVED ANALYTICS over the canonical authorities
 * (spec/architecture-v1.5.md §5; spec/operating-graph-v1.5.md "Profit
 * Intelligence"; architecture-lock-v1.5 #6: "Profit Intelligence is derived
 * analytics and cannot become a financial system of record").
 *
 * Derived analytics over authoritative records calculate revenue, delivery
 * cost, human capacity cost, AI/provider cost, utilization, scope leakage,
 * estimated/realized margin and client/service/project contribution. The
 * module RECOMMENDS at most (it presents figures); it can never mutate
 * contracts, billing or any financial/accounting state — it owns NO state
 * and exposes ZERO mutation methods of ANY kind (the /reporting live
 * aggregation precedent: a PURE READ MODEL over the composed authorities'
 * PUBLIC CONTRACTS — migration-free by design, exactly like MKT-029/030).
 *
 * THE FROZEN BOUNDARY (never a financial system of record):
 *
 *   - LIVE DERIVATION, NO PERSISTED PROJECTION (AC-4 DISCLOSED CHOICE): every
 *     figure is COMPUTED at read time from the authorities' own rows through
 *     their public contracts. There are NO profit_intelligence_* tables, NO
 *     snapshot store and NO recompute/converge operation — nothing to
 *     rebuild, because nothing is stored. The expected-migration list stays
 *     UNCHANGED (038 is reserved for the MKT-048 sibling; this delivery takes
 *     no migration number at all);
 *   - EVERY MATERIAL FIGURE IS VERSIONED, SOURCED AND ASSUMPTION-EXPLICIT
 *     (AC-2): figures carry `calculationVersion` (the frozen vocabulary —
 *     figures are versioned, never silently re-stated), `sourceRefs` (the
 *     canonical record ids the figure was derived from) and `assumptionKeys`
 *     (the frozen assumption-set entries the figure depends on — no hidden
 *     constants: the full assumption record ships in every response);
 *   - FIGURES ARE COMPUTED, NOT STORED TRUTHS (AC-7): the same authority
 *     state + the same calculation version derive byte-identical figures
 *     (the version-pinning proof); authority changes flow through on the
 *     very next read (live-follow — there is no staleness window at all);
 *   - ZERO MUTATION METHODS (AC-3): the module API is three READ methods;
 *     every composed dependency is consumed READ-ONLY; the HTTP surface is
 *     GET-only (routes file) with no body, no DTO and no query parameters;
 *   - ISOLATION BEFORE TRAVERSAL (§14): every scope resolves through
 *     canonical ownership (/clients, /workspaces publics) before any
 *     dependent read; figures never cross the resolved tenant scope;
 *   - NO CURRENCY INVENTION: revenue figures group by their DECLARED unit;
 *     no FX conversion assumption exists. Margin is derived only when the
 *     revenue unit equals the assumed costing currency — otherwise the
 *     figure is null with an explicit notDerivableReason (fail-honest, the
 *     UNKNOWN posture of the execution authority).
 *
 * Dependency posture (the frozen matrix line added for MKT-043):
 * /profit-intelligence ──→ /clients, /workspaces, /goals, /playbooks,
 * /workflows, /executions, /deployments, /evidence, /metrics, /jobs,
 * /field-agents, /ai-runtime, /integrations — every direction consumed
 * READ-ONLY through the public contracts (the /operating-graph composition
 * posture). Cross-module access may only target this public entry
 * (public.ts); internal/ is unimportable from other modules (enforced by
 * tools/arch-check and tests/architecture/profit-intelligence-boundary.test.ts).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { ClientsModuleApi } from '../clients/public.ts';
import type { WorkspacesModuleApi } from '../workspaces/public.ts';
import type { GoalsModuleApi } from '../goals/public.ts';
import type { PlaybooksModuleApi } from '../playbooks/public.ts';
import type { WorkflowsModuleApi } from '../workflows/public.ts';
import type { ExecutionsModuleApi } from '../executions/public.ts';
import type { DeploymentsModuleApi } from '../deployments/public.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { MetricsModuleApi } from '../metrics/public.ts';
import type { JobsModuleApi } from '../jobs/public.ts';
import type { FieldAgentsModuleApi } from '../field-agents/public.ts';
import type { AiRuntimeModuleApi } from '../ai-runtime/public.ts';
import type { IntegrationsModuleApi } from '../integrations/public.ts';

// ---------------------------------------------------------------------------
// The frozen calculation vocabulary (AC-2: versioned figures, explicit
// assumptions, closed provenance states — extension is a code change,
// never a caller freedom)
// ---------------------------------------------------------------------------

/**
 * The CALCULATION VERSION of every figure this module derives. Same
 * authority inputs + this version ⇒ byte-identical figures (the pinning
 * proof). A change to ANY derivation rule or ANY assumption value is a NEW
 * version string — figures are versioned, never silently re-stated (the
 * figure carries the version; the response discloses the assumption record
 * it was computed under).
 */
export const PROFIT_INTELLIGENCE_CALCULATION_VERSION = 'pi-calc-v1' as const;

/**
 * The frozen two-value figure-provenance vocabulary (the honest epistemic
 * posture, mirroring the operating-graph's distinct-states rule):
 *   - 'observed'  — derived from authoritative records of what HAPPENED
 *                   (metric observations, executions, telemetry rows, jobs);
 *   - 'estimated' — derived from DECLARED INTENT plus assumptions (goal
 *                   targets, declared availability capacity).
 * The two are never conflated: estimated figures never mix into observed
 * totals (the estimated/realized margin split keeps them separate).
 */
export const PROFIT_FIGURE_PROVENANCES = ['observed', 'estimated'] as const;

export type ProfitFigureProvenance = (typeof PROFIT_FIGURE_PROVENANCES)[number];

/**
 * The frozen revenue-metric-name vocabulary — the ASSUMPTION that decides
 * which metric observations count as revenue. Metric names are caller-
 * chosen on the /metrics authority, so the derived revenue rollup declares
 * its interpretation explicitly: observations with one of these names are
 * revenue observations; every other name is not revenue (and is simply not
 * part of the revenue surface). Extension is a code change + version bump.
 */
export const PROFIT_INTELLIGENCE_REVENUE_METRIC_NAMES = [
  'revenue',
  'gross_revenue',
  'net_revenue',
  'recurring_revenue',
  'mrr',
  'arr',
] as const;

/**
 * The frozen assumption set every figure depends on (AC-2: structured,
 * explicit, no hidden constants). Every entry is exported, documented and
 * surfaced VERBATIM in every response (`calculation.assumptions`); every
 * figure lists the `assumptionKeys` it consumed. Changing ANY value is a
 * calculation-version bump — never a silent restatement.
 */
export interface ProfitAssumptionSet {
  /** The single costing currency cost figures are denominated in. */
  readonly costingCurrency: 'USD';
  /** Which metric names count as revenue (see the frozen vocabulary). */
  readonly revenueMetricNames: readonly string[];
  /**
   * Restatement handling on the append-only /metrics ledger: for each
   * metric identity (name + dimension set + workspace scope), the LATEST
   * observation by observedAt (recordedAt tiebreak) is the figure's row;
   * superseded predecessors stay referenced but do not sum (corrections
   * are NEW rows on the authority — interpretation belongs here).
   */
  readonly latestObservationWinsPerMetricIdentity: true;
  /** The /ai-runtime usage telemetry costAmount is denominated in this currency (the registry carries no unit). */
  readonly telemetryCostCurrency: 'USD';
  /** Assumed cost of one DELIVERED human job (status outcome_submitted) — the jobs-surface human delivery unit. */
  readonly humanDeliveredJobCostUsd: number;
  /** Assumed minutes of human work per delivered job — the utilization numerator unit. */
  readonly deliveredJobMinutes: number;
  /** Assumed cost of one deterministic-kind execution row (every lifecycle state — the attempt ledger). */
  readonly deterministicExecutionCostUsd: number;
  /** Assumed cost of one extension-kind execution row. */
  readonly extensionExecutionCostUsd: number;
  /** Assumed hourly rate for DECLARED human capacity (field-agents availability windows). */
  readonly humanHourlyRateUsd: number;
  /**
   * Availability windows are WEEKLY-RECURRING declarations: capacity is
   * normalized to minutes-per-week (the denominator unit of utilization).
   */
  readonly capacityWindowRecurrence: 'weekly';
  /**
   * Human-kind executions are disclosed as a runtime indicator but are
   * NOT costed: the delivered-jobs surface owns human delivery cost
   * (counting both would double-count one unit of human work).
   */
  readonly humanExecutionCostAttribution: 'utilization-indicator-only';
}

export const PROFIT_INTELLIGENCE_ASSUMPTIONS: ProfitAssumptionSet = {
  costingCurrency: 'USD',
  revenueMetricNames: [...PROFIT_INTELLIGENCE_REVENUE_METRIC_NAMES],
  latestObservationWinsPerMetricIdentity: true,
  telemetryCostCurrency: 'USD',
  humanDeliveredJobCostUsd: 75,
  deliveredJobMinutes: 120,
  deterministicExecutionCostUsd: 0.05,
  extensionExecutionCostUsd: 0.02,
  humanHourlyRateUsd: 55,
  capacityWindowRecurrence: 'weekly',
  humanExecutionCostAttribution: 'utilization-indicator-only',
};

// ---------------------------------------------------------------------------
// Source references (AC-2: canonical record ids, never shadowed shape)
// ---------------------------------------------------------------------------

/** The closed source-reference vocabulary — the authorities figures cite. */
export const PROFIT_SOURCE_REF_KINDS = [
  'metric-observation',
  'evidence',
  'execution',
  'usage-telemetry',
  'task-profile',
  'job',
  'job-offer',
  'goal',
  'playbook',
  'playbook-version',
  'deployment',
  'workflow',
  'workflow-definition',
  'workflow-instance',
  'human-agent-profile',
  'integration-connection',
  'ingested-integration-event',
] as const;

export type ProfitSourceRefKind = (typeof PROFIT_SOURCE_REF_KINDS)[number];

/** One canonical record a figure was derived from. */
export interface ProfitSourceRef {
  readonly kind: ProfitSourceRefKind;
  readonly id: string;
}

// ---------------------------------------------------------------------------
// The figure shape — value + provenance + version + sources + assumptions
// ---------------------------------------------------------------------------

/**
 * ONE MATERIAL FIGURE (AC-2). `value` is null exactly when the figure is
 * not derivable — with an explicit `notDerivableReason` (never a silent
 * zero). `assumptionKeys` name the assumption-set entries consumed; the
 * full assumption record ships alongside in every view.
 */
export interface ProfitFigure {
  readonly value: number | null;
  /** The unit dimension the value is denominated in (currency code for money figures). */
  readonly currency: string;
  readonly provenance: ProfitFigureProvenance;
  readonly calculationVersion: string;
  readonly sourceRefs: readonly ProfitSourceRef[];
  readonly assumptionKeys: readonly string[];
  readonly notDerivableReason: string | null;
}

// ---------------------------------------------------------------------------
// The derived surfaces (AC-5)
// ---------------------------------------------------------------------------

/** Revenue in one declared currency unit (latest-observation-wins per identity). */
export interface RevenueCurrencyFigure {
  readonly currency: string;
  /** Σ of the latest observation per metric identity in this currency. */
  readonly total: ProfitFigure;
  /** Distinct metric identities (name + dimensions + workspace scope) contributing. */
  readonly identityCount: number;
  readonly sourceRefs: readonly ProfitSourceRef[];
}

/**
 * The REVENUE ROLLUP over /metrics observations with evidence provenance
 * (AC-5a). Grouped by declared unit — never converted, never mixed.
 */
export interface RevenueRollup {
  readonly byCurrency: readonly RevenueCurrencyFigure[];
  /** Total observations examined (the append-only ledger slice in window). */
  readonly observationCount: number;
  /** Identities whose latest row is a restatement (the correction disclosure). */
  readonly restatedIdentityCount: number;
  /** Superseded predecessors excluded by latest-wins (counted here, never summed). */
  readonly supersededObservationCount: number;
  /** Data-quality posture distribution over the contributing (latest) rows. */
  readonly qualityCounts: Readonly<Record<string, number>>;
  /** The /evidence records backing the contributing observations (provenance). */
  readonly evidenceRefs: readonly ProfitSourceRef[];
}

/** Per-execution-kind delivery counts (the honest kind breakdown). */
export interface ExecutionKindCounts {
  readonly deterministic: number;
  readonly ai: number;
  readonly human: number;
  readonly extension: number;
}

/** Per-status execution counts (the lifecycle disclosure over the attempt ledger). */
export type ExecutionStatusCounts = Readonly<Record<string, number>>;

/** The AI/provider cost surface: telemetry spend + integrations adapter activity (AC-5c). */
export interface AiProviderCostSurface {
  /** Σ usage-telemetry costAmount (assumed telemetry currency; observed). */
  readonly telemetryCost: ProfitFigure;
  /** The Workspace's telemetry rows examined (bounded listing, disclosed). */
  readonly telemetryRowCount: number;
  /**
   * Integrations adapter activity (the provider-side surface with NO cost
   * data on today's authority): per-adapter connection + ingested-event
   * counts with full source references. Deliberately NOT costed — the
   * honest disclosure instead of an invented per-event price.
   */
  readonly adapterActivity: readonly AdapterActivityRow[];
  readonly adapterActivityNote: string;
}

/** One provider adapter's activity in scope (counts + references, no invented cost). */
export interface AdapterActivityRow {
  readonly adapterKey: string;
  readonly connectionCount: number;
  readonly ingestedEventCount: number;
  readonly connectionRefs: readonly ProfitSourceRef[];
  readonly eventRefs: readonly ProfitSourceRef[];
}

/** The delivery-cost breakdown (AC-5b): every component a separate versioned figure. */
export interface DeliveryCostBreakdown {
  /** Delivered human jobs × assumed per-job cost (the /jobs surface). */
  readonly humanDeliveryCost: ProfitFigure;
  /** Delivered (outcome_submitted) job count. */
  readonly deliveredJobCount: number;
  /** Accepted (in-flight) job count. */
  readonly inFlightJobCount: number;
  /** Deterministic + extension executions × per-kind assumed unit costs. */
  readonly automationDeliveryCost: ProfitFigure;
  /** Σ of every cost component in scope (human + automation + AI/provider). */
  readonly totalDeliveryCost: ProfitFigure;
  readonly executionCounts: ExecutionKindCounts;
  readonly executionStatusCounts: ExecutionStatusCounts;
  readonly aiProvider: AiProviderCostSurface;
  /**
   * The disclosed exclusion: human-kind executions are counted here as an
   * indicator but NOT costed (the jobs surface owns human cost — counting
   * both would double-count one unit of human work).
   */
  readonly humanExecutionCostAttribution: 'utilization-indicator-only';
}

/** Human capacity over the /field-agents surface (AC-5b) — agency-pool context. */
export interface HumanCapacitySurface {
  /** Active Human Agent profiles counted (authorization-state active). */
  readonly activeProfileCount: number;
  /** Membership users skipped: no profile, or profile not authorization-active. */
  readonly skippedProfileCount: number;
  /** Σ weekly availability minutes over the counted profiles. */
  readonly weeklyCapacityMinutes: number;
  /** weeklyCapacityMinutes × assumed hourly rate — the standing capacity commitment. */
  readonly weeklyCapacityCost: ProfitFigure;
  readonly profileRefs: readonly ProfitSourceRef[];
}

/** Utilization: delivered human work over declared capacity (AC-5b). */
export interface UtilizationSurface {
  /** Delivered jobs × assumed minutes per delivered job (the numerator, observed). */
  readonly deliveredWorkMinutes: ProfitFigure;
  /** The capacity denominator (weekly minutes, observed declarations). */
  readonly capacityMinutes: ProfitFigure;
  /** deliveredWorkMinutes ÷ capacityMinutes — null when capacity is zero (no declared capacity). */
  readonly utilization: ProfitFigure;
  /** Human-kind execution rows in scope (runtime indicator; NOT in the numerator — disclosed). */
  readonly humanExecutionCount: number;
  readonly numeratorNote: string;
}

/** One scope-leakage indicator: declared scope vs. delivered work (AC-5d). */
export interface ScopeLeakageIndicator {
  readonly kind:
    | 'executions-outside-deployed-envelope'
    | 'work-without-active-goal'
    | 'active-goals-without-delivery';
  /** The derivation rule, stated verbatim (assumptions are explicit, not hidden). */
  readonly rule: string;
  readonly count: number;
  readonly sourceRefs: readonly ProfitSourceRef[];
}

export interface ScopeLeakageSurface {
  readonly indicators: readonly ScopeLeakageIndicator[];
}

/** Estimated vs. realized margin (AC-5e) — the two provenance states kept distinct. */
export interface MarginSurface {
  /** Realized revenue (costing-currency slice of the revenue rollup, observed). */
  readonly realizedRevenue: ProfitFigure;
  /** Realized delivery cost (observed component sum). */
  readonly realizedDeliveryCost: ProfitFigure;
  /** realizedRevenue − realizedDeliveryCost; null on currency mismatch (no FX assumption). */
  readonly realizedMargin: ProfitFigure;
  /** Estimated revenue: Σ ACTIVE-goal success-criterion targets matching the revenue vocabulary + currency (estimated). */
  readonly estimatedRevenue: ProfitFigure;
  /** Estimated cost: the standing weekly human-capacity commitment (estimated). */
  readonly estimatedDeliveryCost: ProfitFigure;
  /** estimatedRevenue − estimatedDeliveryCost (estimated). */
  readonly estimatedMargin: ProfitFigure;
  readonly currencyPolicyNote: string;
}

/** Per-client contribution (the client dimension of AC-5e). */
export interface ClientContributionRow {
  readonly clientId: string;
  readonly revenue: ProfitFigure;
  readonly deliveryCost: ProfitFigure;
  readonly margin: ProfitFigure;
}

/**
 * Per-service (Playbook) contribution: the cost side attributes through
 * instance → pinned definition → playbook version; revenue carries no
 * playbook reference today (MKT-046 attribution is future) — the revenue
 * figure is null WITH reason, never fabricated.
 */
export interface ServiceContributionRow {
  readonly playbookId: string;
  readonly deliveryCost: ProfitFigure;
  readonly revenue: ProfitFigure;
  readonly deliveredJobCount: number;
  readonly executionCount: number;
}

/**
 * Per-project (Deployment) contribution: executions/jobs whose instance's
 * pinned definition is one of the deployment's declared definitions.
 * Revenue attribution is null with reason (same honesty rule).
 */
export interface ProjectContributionRow {
  readonly deploymentId: string;
  readonly deploymentStatus: string;
  readonly deliveryCost: ProfitFigure;
  readonly revenue: ProfitFigure;
  readonly deliveredJobCount: number;
  readonly executionCount: number;
}

/** The calculation disclosure carried by EVERY view (AC-2/AC-7). */
export interface CalculationDisclosure {
  readonly calculationVersion: string;
  readonly assumptions: ProfitAssumptionSet;
  readonly basis: 'live-derivation-over-canonical-authorities';
  readonly persistence: 'none-derived-read-model';
}

// ---------------------------------------------------------------------------
// The three views (AC-5: agency / client / workspace scoped)
// ---------------------------------------------------------------------------

export interface WorkspaceProfitIntelligenceView {
  readonly scope: {
    readonly kind: 'workspace-profit-intelligence';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  /** Workspace-tagged observations only (client-wide rows are attributed at the client rollup — no allocation assumption). */
  readonly revenue: RevenueRollup;
  readonly costs: DeliveryCostBreakdown;
  readonly utilization: UtilizationSurface;
  readonly scopeLeakage: ScopeLeakageSurface;
  readonly margin: MarginSurface;
  readonly calculation: CalculationDisclosure;
  readonly generatedAt: string;
}

export interface ClientProfitIntelligenceView {
  readonly scope: {
    readonly kind: 'client-profit-intelligence';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceCount: number;
  };
  readonly revenue: RevenueRollup;
  readonly costs: DeliveryCostBreakdown;
  /** The agency human-capacity pool context (capacity is agency-scoped; disclosed as context). */
  readonly capacity: HumanCapacitySurface;
  readonly utilization: UtilizationSurface;
  readonly scopeLeakage: ScopeLeakageSurface;
  readonly margin: MarginSurface;
  readonly serviceContributions: readonly ServiceContributionRow[];
  /** Delivery cost with NO playbook attribution — the disclosed remainder, never silently dropped. */
  readonly unattributedServiceDeliveryCost: ProfitFigure;
  readonly projectContributions: readonly ProjectContributionRow[];
  /** Delivery cost attributed to NO deployment — the disclosed remainder. */
  readonly unattributedProjectDeliveryCost: ProfitFigure;
  readonly calculation: CalculationDisclosure;
  readonly generatedAt: string;
}

export interface AgencyProfitIntelligenceView {
  readonly scope: {
    readonly kind: 'agency-profit-intelligence';
    readonly agencyId: string;
    readonly clientCount: number;
    readonly humanAgentCount: number;
  };
  /** Per-client contribution rows (the client dimension). */
  readonly perClient: readonly ClientContributionRow[];
  readonly serviceContributions: readonly ServiceContributionRow[];
  /** Delivery cost with NO playbook attribution — the disclosed portfolio remainder. */
  readonly unattributedServiceDeliveryCost: ProfitFigure;
  readonly projectContributions: readonly ProjectContributionRow[];
  /** Delivery cost attributed to NO deployment — the disclosed portfolio remainder. */
  readonly unattributedProjectDeliveryCost: ProfitFigure;
  readonly revenue: RevenueRollup;
  readonly costs: DeliveryCostBreakdown;
  readonly capacity: HumanCapacitySurface;
  readonly utilization: UtilizationSurface;
  readonly scopeLeakage: ScopeLeakageSurface;
  readonly margin: MarginSurface;
  readonly calculation: CalculationDisclosure;
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

export interface ProfitIntelligenceModuleDeps {
  readonly clock: Clock;
  /**
   * The frozen matrix line added for MKT-043 (read-only composition):
   * /profit-intelligence ──→ /clients, /workspaces, /goals, /playbooks,
   * /workflows, /executions, /deployments, /evidence, /metrics, /jobs,
   * /field-agents, /ai-runtime, /integrations.
   */
  readonly clients: ClientsModuleApi;
  readonly workspaces: WorkspacesModuleApi;
  readonly goals: GoalsModuleApi;
  readonly playbooks: PlaybooksModuleApi;
  readonly workflows: WorkflowsModuleApi;
  readonly executions: ExecutionsModuleApi;
  readonly deployments: DeploymentsModuleApi;
  readonly evidence: EvidenceModuleApi;
  readonly metrics: MetricsModuleApi;
  readonly jobs: JobsModuleApi;
  readonly fieldAgents: FieldAgentsModuleApi;
  readonly aiRuntime: AiRuntimeModuleApi;
  readonly integrations: IntegrationsModuleApi;
}

export interface ProfitIntelligenceModuleApi {
  /**
   * The CLIENT's profit intelligence — the full derived surface (revenue,
   * delivery/capacity/utilization, scope leakage, margins, service/project
   * contributions) over the Client's own authority rows. Canonical Client
   * ownership resolves FIRST (/clients public contract — isolation before
   * traversal): unknown or tombstoned Client → the uniform 404 upstream.
   *
   * `humanAgentUserIds` is SERVER-DERIVED aggregation input (the route
   * resolved the agency's ACTIVE human_agent memberships from durable
   * state — the scope-as-data posture of the /operating-graph reads; the
   * module never imports /agencies).
   */
  getClientProfitIntelligence(input: {
    readonly clientId: string;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<ClientProfitIntelligenceView>;

  /**
   * The WORKSPACE's profit intelligence — the workspace-scoped slice
   * (workspace-tagged revenue observations, the workspace's executions and
   * telemetry, the workspace slice of scope leakage). Canonical Workspace
   * ownership resolves FIRST (/workspaces public contract): unknown,
   * tombstoned or foreign Workspace → the uniform 404 upstream.
   */
  getWorkspaceProfitIntelligence(input: {
    readonly workspaceId: string;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<WorkspaceProfitIntelligenceView>;

  /**
   * The AGENCY's profit intelligence — the portfolio rollup over the
   * agency's Clients (per-client contribution rows, service/project
   * contributions across the portfolio, capacity, utilization, leakage
   * totals, portfolio margins). The client scope arrives as SERVER-DERIVED
   * data (the route resolved the agency's LIVE Clients from durable
   * state); the module derives each Client's figures from that Client's
   * own authority rows and rolls them up.
   */
  getAgencyProfitIntelligence(input: {
    readonly agencyId: string;
    readonly clients: ReadonlyArray<{ readonly clientId: string }>;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<AgencyProfitIntelligenceView>;
}

export { createProfitIntelligenceModule } from './internal/profit-intelligence-module.ts';

// The pure derivation functions + snapshot types (unit-tested; re-exported
// so tests and future read-side emitters compose the exact module
// semantics). See internal/profit-derivation.ts.
export type {
  ClientAuthoritySnapshot,
  MetricIdentityKey,
  ProjectContributionResult,
  ResolvedJobRef,
  ServiceContributionResult,
} from './internal/profit-derivation.ts';
export {
  aggregateAiProviderCostSurfaces,
  aggregateDeliveryCostBreakdowns,
  aggregateProjectContributions,
  aggregateRevenueRollups,
  aggregateServiceContributions,
  composeCalculationDisclosure,
  deriveAiProviderCostSurface,
  deriveClientContributionRow,
  deriveDeliveryCostBreakdown,
  deriveHumanCapacitySurface,
  deriveMarginSurface,
  deriveProjectContributions,
  deriveRevenueRollup,
  deriveScopeLeakageSurface,
  deriveServiceContributions,
  deriveUtilizationSurface,
  metricIdentityKeyOf,
} from './internal/profit-derivation.ts';
