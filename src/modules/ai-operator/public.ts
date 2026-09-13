/**
 * MarketingOS module: /ai-operator (MKT-045 — AI Operator / Attention Queue).
 *
 * Authority: DERIVED ATTENTION READ MODEL over the canonical authorities
 * (spec/architecture-v1.5.md §7: "Command Center may rank attention items:
 * blocked work, approvals, client risk, anomalies, scope leakage, margin
 * pressure, capacity constraints and opportunities. Consequential actions
 * continue through the existing policy/approval contracts";
 * spec/module-dependency-matrix.md "/ai-operator ──→ /clients,
 * /workspaces, /workflows, /executions, /deployments, /jobs, /policies,
 * /evidence, /experiments, /learnings, /field-agents, /profit-intelligence"
 * + the derived-read-model forbidden-direction bullet).
 *
 * The module ranks GOVERNED ACTION CANDIDATES as live-derived attention
 * items over the authorities' own rows through their PUBLIC CONTRACTS. It
 * RECOMMENDS at most: it ranks, it never executes and it never creates —
 * every item carries the EXISTING consequential-action contract the action
 * would flow through (a policy/approval REFERENCE, never a command). The
 * module owns NO state, exposes ZERO mutation methods of ANY kind and runs
 * ZERO SQL (the /profit-intelligence live-derivation precedent, exactly
 * like MKT-043: a PURE READ MODEL over the composed authorities' public
 * contracts — migration-free by design).
 *
 * THE FROZEN BOUNDARY (never an action authority):
 *
 *   - LIVE DERIVATION, NO PERSISTED QUEUE (AC-4 DISCLOSED CHOICE): every
 *     attention item is COMPUTED at read time from the authorities' own
 *     rows through their public contracts. There are NO ai_operator_*
 *     tables, NO persisted queue and NO refresh operation — nothing to
 *     rebuild, because nothing is stored. The expected-migration list stays
 *     UNCHANGED (038 is reserved for the MKT-048 sibling; this delivery
 *     takes no migration number at all);
 *   - RANKING DETERMINISM (AC-6): the priority score is a PURE function of
 *     the authority rows (NO time-based factor exists — the score never
 *     reads the clock). Same authority state + the same rank version ⇒
 *     byte-identical queue order (score DESC, category ASC, itemId ASC —
 *     the total deterministic tiebreak). The score, the category
 *     vocabulary and every assumption value are VERSIONED and exported —
 *     never silently re-stated;
 *   - DERIVED, NEVER AUTHORITATIVE (§7 + the lock): the module consumes
 *     every composed dependency READ-ONLY; margin-pressure and
 *     scope-leakage items CONSUME the /profit-intelligence public figures
 *     (its calculation version ships inside the item rationale) and never
 *     recompute them — there is no second margin or leakage derivation
 *     anywhere in this module;
 *   - ISOLATION BEFORE TRAVERSAL (§14): every scope resolves through
 *     canonical ownership (/clients, /workspaces publics) before any
 *     dependent read; items never cross the resolved tenant scope;
 *   - THE ACTION CONTRACT IS A REFERENCE, NOT A GATEWAY: each item's
 *     `actionContract` names the EXISTING MOS surface the consequential
 *     action flows through (the policy/approval contract where one gates
 *     it, plus the canonical record it would act on). No method on this
 *     contract executes, creates, approves or records anything.
 *
 * Dependency posture (the frozen matrix line added for MKT-045):
 * /ai-operator ──→ /clients, /workspaces, /workflows, /executions,
 * /deployments, /jobs, /policies, /evidence, /experiments, /learnings,
 * /field-agents, /profit-intelligence — every direction consumed READ-ONLY
 * through the public contracts. Cross-module access may only target this
 * public entry (public.ts); internal/ is unimportable from other modules
 * (enforced by tools/arch-check and
 * tests/architecture/ai-operator-boundary.test.ts).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { PolicyDimension } from '../policies/public.ts';
import type { ClientsModuleApi } from '../clients/public.ts';
import type { WorkspacesModuleApi } from '../workspaces/public.ts';
import type { WorkflowsModuleApi } from '../workflows/public.ts';
import type { ExecutionsModuleApi } from '../executions/public.ts';
import type { DeploymentsModuleApi } from '../deployments/public.ts';
import type { JobsModuleApi } from '../jobs/public.ts';
import type { PoliciesModuleApi } from '../policies/public.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { ExperimentsModuleApi } from '../experiments/public.ts';
import type { LearningsModuleApi } from '../learnings/public.ts';
import type { FieldAgentsModuleApi } from '../field-agents/public.ts';
import type { ProfitIntelligenceModuleApi } from '../profit-intelligence/public.ts';

// ---------------------------------------------------------------------------
// The frozen ranking vocabulary (AC-3/AC-6: versioned category vocabulary,
// versioned priority score, closed source/action vocabularies — extension
// is a code change, never a caller freedom)
// ---------------------------------------------------------------------------

/**
 * The CATEGORY VOCABULARY VERSION. The eight attention categories are the
 * frozen set of spec/architecture-v1.5.md §7. Adding, renaming or
 * re-scoping a category is a NEW vocabulary version — never a silent
 * restatement.
 */
export const ATTENTION_CATEGORY_VOCABULARY_VERSION = 'ao-categories-v1' as const;

/**
 * The frozen eight-category attention vocabulary (spec/architecture-v1.5.md
 * §7, verbatim order):
 *   - 'blocked-work'         — jobs/workflows/executions/deployments stuck
 *                              out of forward progress;
 *   - 'approval'             — actions pending decision on the policy/
 *                              approval contract (undecided evaluations);
 *   - 'client-risk'          — weak evidence posture on a Client;
 *   - 'anomaly'              — execution failure patterns (failed, unsafe
 *                              retries, UNKNOWN/unresolved, reconciling);
 *   - 'scope-leakage'        — delivery outside declared scope (consumed
 *                              from /profit-intelligence, never recomputed);
 *   - 'margin-pressure'      — realized margin below the frozen pressure
 *                              threshold (consumed from /profit-intelligence,
 *                              never recomputed);
 *   - 'capacity-constraint'  — projected human work demand over declared
 *                              field-agent availability;
 *   - 'opportunity'          — experiments/learnings ready to advance the
 *                              knowledge/decision loop.
 */
export const ATTENTION_CATEGORIES = [
  'blocked-work',
  'approval',
  'client-risk',
  'anomaly',
  'scope-leakage',
  'margin-pressure',
  'capacity-constraint',
  'opportunity',
] as const;

export type AttentionCategory = (typeof ATTENTION_CATEGORIES)[number];

/**
 * The RANK CALCULATION VERSION of every priority score this module
 * derives. Same authority inputs + this version ⇒ byte-identical queue
 * order (the pinning proof). A change to ANY scoring rule, category weight
 * or ANY assumption value is a NEW version string — scores are versioned,
 * never silently re-stated.
 */
export const AI_OPERATOR_RANK_VERSION = 'ao-rank-v1' as const;

/**
 * The frozen assumption set every priority score depends on (AC-3/AC-6:
 * structured, explicit, no hidden constants). Every entry is exported,
 * documented and surfaced VERBATIM in every response (`ranking.assumptions`);
 * every item lists the `scoreAssumptionKeys` it consumed. Changing ANY
 * value is a rank-version bump — never a silent restatement.
 */
export interface AiOperatorAssumptionSet {
  /**
   * The category base weights (the primary rank axis — the frozen
   * relative urgency of the eight §7 categories; approvals outrank
   * anomalies, which outrank blocked work, … down to opportunities).
   */
  readonly categoryBaseWeights: Readonly<Record<AttentionCategory, number>>;
  /** The closed severity-modifier range (per-item state severity, additive). */
  readonly severityModifierRange: readonly [number, number];
  /** The closed recurrence-modifier range (per-item state severity, additive). */
  readonly recurrenceModifierRange: readonly [number, number];
  /** Evidence quality grades counted as WEAK for the client-risk category. */
  readonly clientRiskWeakEvidenceGrades: readonly string[];
  /** Minimum weak-evidence count before a client-risk item exists. */
  readonly clientRiskWeakEvidenceThreshold: number;
  /** realizedMargin ÷ realizedRevenue below this ratio is margin pressure (when derivable). */
  readonly marginPressureThresholdRatio: number;
  /** A negative realized margin is ALWAYS margin pressure (highest severity). */
  readonly marginPressureNegativeIsAlwaysPressure: true;
  /** Projected demand minutes ÷ declared capacity minutes above this ratio is a constraint. */
  readonly capacityConstraintTriggerRatio: number;
  /** Assumed minutes of human work per OPEN or IN-FLIGHT job (the demand unit). */
  readonly capacityDemandMinutesPerJob: number;
  /** Availability windows are WEEKLY-RECURRING declarations (the capacity unit). */
  readonly capacityWindowRecurrence: 'weekly';
  /** Cap of the same-dimension recurrence modifier on approval items. */
  readonly approvalDimensionRecurrenceCap: number;
  /** Cap of the attempt recurrence modifier on anomaly items. */
  readonly anomalyAttemptRecurrenceCap: number;
  /** Cap of the severity modifier on scope-leakage items (leaked-unit count). */
  readonly scopeLeakageSeverityCap: number;
  /** Cap of the severity modifier on client-risk items (weak-evidence count). */
  readonly clientRiskSeverityCap: number;
}

export const AI_OPERATOR_ASSUMPTIONS: AiOperatorAssumptionSet = {
  categoryBaseWeights: {
    approval: 90,
    anomaly: 85,
    'blocked-work': 80,
    'client-risk': 75,
    'margin-pressure': 70,
    'capacity-constraint': 60,
    'scope-leakage': 55,
    opportunity: 40,
  },
  severityModifierRange: [0, 10],
  recurrenceModifierRange: [0, 5],
  clientRiskWeakEvidenceGrades: ['D', 'E', 'F'],
  clientRiskWeakEvidenceThreshold: 1,
  marginPressureThresholdRatio: 0.15,
  marginPressureNegativeIsAlwaysPressure: true,
  capacityConstraintTriggerRatio: 1.0,
  capacityDemandMinutesPerJob: 120,
  capacityWindowRecurrence: 'weekly',
  approvalDimensionRecurrenceCap: 5,
  anomalyAttemptRecurrenceCap: 5,
  scopeLeakageSeverityCap: 10,
  clientRiskSeverityCap: 10,
};

// ---------------------------------------------------------------------------
// Source references (AC-3: canonical record ids, never shadowed shape)
// ---------------------------------------------------------------------------

/**
 * The closed source-reference vocabulary — the canonical authorities
 * attention items cite. The /profit-intelligence pass-through kinds
 * (goal/playbook/playbook-version/metric-observation/usage-telemetry/
 * task-profile/integration-connection/ingested-integration-event/
 * workflow-definition) appear only on items that CONSUME a
 * /profit-intelligence figure and cite that figure's own canonical
 * source references verbatim (kind identity preserved, never dropped).
 */
export const ATTENTION_SOURCE_REF_KINDS = [
  'agency',
  'client',
  'workspace',
  'workflow',
  'workflow-definition',
  'workflow-instance',
  'deployment',
  'execution',
  'job',
  'job-offer',
  'policy-decision',
  'policy-version',
  'evidence',
  'experiment',
  'learning',
  'human-agent-profile',
  'goal',
  'playbook',
  'playbook-version',
  'metric-observation',
  'usage-telemetry',
  'task-profile',
  'integration-connection',
  'ingested-integration-event',
] as const;

export type AttentionSourceRefKind = (typeof ATTENTION_SOURCE_REF_KINDS)[number];

/** One canonical record an attention item was derived from. */
export interface AttentionSourceRef {
  readonly kind: AttentionSourceRefKind;
  readonly id: string;
}

// ---------------------------------------------------------------------------
// The consequential-action contract reference (AC-3: the EXISTING contract
// the action flows through — a REFERENCE, never a command)
// ---------------------------------------------------------------------------

/**
 * The frozen consequential-action-contract vocabulary — the EXISTING MOS
 * surfaces a ranked action candidate flows through (§7: "Consequential
 * actions continue through the existing policy/approval contracts"). The
 * module names them; it NEVER drives them.
 */
export const ATTENTION_ACTION_CONTRACT_KINDS = [
  /** The pending approval itself: the /policies fail-closed evaluation surface. */
  'policy-evaluation',
  /** Resuming/abandoning blocked work: the /workflows instance transition surface. */
  'workflow-instance-transition',
  /** Re-aligning a blocked/disabled deployment: the /deployments operator path (new deployment/redeploy). */
  'deployment-lifecycle',
  /** Re-working a failed/expired job: the /jobs projection + outcome surface. */
  'job-outcome-submission',
  /** Resolving failed/UNKNOWN executions: the /executions transition/reconciliation surface. */
  'execution-reconciliation',
  /** Strengthening a weak evidence base: the /evidence append/supersession surface. */
  'evidence-append',
  /** Advancing an experiment: the /experiments lifecycle transition surface. */
  'experiment-lifecycle',
  /** Revising a contradicted learning: the /learnings append/supersession surface. */
  'learning-revision',
  /** Recording the commercial response (reprice/resize/stop/scope): the /decisions record surface. */
  'decision-recording',
  /** Adjusting the human pool or its availability: the /field-agents profile surface (field-policy-gated). */
  'field-agent-availability',
] as const;

export type AttentionActionContractKind = (typeof ATTENTION_ACTION_CONTRACT_KINDS)[number];

/**
 * The EXISTING consequential-action contract one attention item would flow
 * through (AC-3). This is a READ-ONLY REFERENCE: the module never
 * executes, creates, approves or records anything — the operator (or a
 * later governing surface) drives the named contract through its own
 * authorization path.
 */
export interface AttentionActionContract {
  readonly kind: AttentionActionContractKind;
  /** The existing MOS contract surface, named module-first (e.g. '/policies evaluateAction'). */
  readonly surface: string;
  /**
   * The policy/approval gate the action passes through, when the flow is
   * policy-gated (§7 reference) — null when the named authority's own
   * approval semantics govern the transition instead.
   */
  readonly policyDimension: PolicyDimension | null;
  /** The policy scope kind the gate is declared at, when policy-gated. */
  readonly policyScopeKind: 'platform' | 'agency' | 'client' | null;
  /** The canonical record the consequential action would act on (a reference, never a command). */
  readonly targetRef: AttentionSourceRef;
  /** The frozen one-line flow statement (what continues through the named contract). */
  readonly note: string;
}

// ---------------------------------------------------------------------------
// The structured rationale (AC-3: machine-checkable, frozen factor keys)
// ---------------------------------------------------------------------------

/**
 * The frozen rationale-factor key vocabulary — the closed set of keys a
 * rationale factor may carry (per category; extension is a code change +
 * rank-version bump, never a caller freedom).
 */
export const ATTENTION_RATIONALE_FACTOR_KEYS = [
  'instance-status',
  'deployment-status',
  'job-status',
  'job-outcome',
  'linked-failed-executions',
  'policy-outcome',
  'policy-reason',
  'policy-dimension',
  'policy-scope-kind',
  'same-dimension-undecided-count',
  'client-status',
  'weak-evidence-count',
  'weak-evidence-grades',
  'evidence-grade-counts',
  'execution-status',
  'execution-kind',
  'attempt-number',
  'retry-classification',
  'leakage-kind',
  'leaked-count',
  'source-calculation-version',
  'realized-margin',
  'realized-revenue',
  'margin-ratio',
  'pressure-threshold-ratio',
  'declared-capacity-minutes',
  'projected-demand-minutes',
  'open-job-count',
  'in-flight-job-count',
  'active-profile-count',
  'opportunity-kind',
  'experiment-status',
  'experiment-result-state',
  'learning-status',
] as const;

export type AttentionRationaleFactorKey = (typeof ATTENTION_RATIONALE_FACTOR_KEYS)[number];

/** One machine-checkable rationale factor (the observed value, verbatim). */
export interface AttentionRationaleFactor {
  readonly key: AttentionRationaleFactorKey;
  readonly value: string;
}

/** The structured rationale every item carries (AC-3) — factors, not prose. */
export interface AttentionRationale {
  /** One human-readable headline line (derived, deterministic). */
  readonly headline: string;
  readonly factors: readonly AttentionRationaleFactor[];
}

// ---------------------------------------------------------------------------
// The attention item — the governed action candidate (AC-3)
// ---------------------------------------------------------------------------

/**
 * ONE RANKED ATTENTION ITEM. `priorityScore` is an integer computed by the
 * frozen ao-rank-v1 rules: category base weight + severity modifier (0..10)
 * + recurrence modifier (0..5) — a PURE function of the authority rows (no
 * clock factor: same inputs ⇒ same score, same order). `rank` is the 1-based
 * position in the owning queue (score DESC, category ASC, itemId ASC).
 */
export interface AttentionItem {
  /**
   * The DETERMINISTIC item identity: `ao:<category>:<primary-kind>:<primary-id>`
   * (+ `:<sub-kind>` where one record yields distinct items). Derived from
   * canonical ids only — stable across reads, resolvable by re-deriving
   * the queue (the detail surface). NOT a stored id: nothing is persisted.
   */
  readonly itemId: string;
  readonly category: AttentionCategory;
  /** The tenant scope the item was derived inside (never caller input). */
  readonly scope: {
    readonly agencyId: string;
    readonly clientId: string | null;
    readonly workspaceId: string | null;
  };
  readonly priorityScore: number;
  readonly rank: number;
  readonly sourceRefs: readonly AttentionSourceRef[];
  readonly rationale: AttentionRationale;
  readonly actionContract: AttentionActionContract;
  /** The frozen assumption-set entries the score consumed (no hidden constants). */
  readonly scoreAssumptionKeys: readonly string[];
}

/** Per-category counts over the whole queue (every category key always present). */
export type AttentionCategoryCounts = Readonly<Record<AttentionCategory, number>>;

/** The ranking disclosure carried by EVERY view (AC-3/AC-6). */
export interface RankingDisclosure {
  readonly rankVersion: string;
  readonly categoryVocabularyVersion: string;
  readonly assumptions: AiOperatorAssumptionSet;
  /** The total deterministic sort rule, stated verbatim. */
  readonly sortRule: string;
  readonly basis: 'live-derivation-over-canonical-authorities';
  readonly persistence: 'none-derived-read-model';
  /** The /profit-intelligence calculation version consumed (never recomputed here). */
  readonly consumedProfitIntelligenceVersion: string;
}

// ---------------------------------------------------------------------------
// The derived surfaces (AC-5: agency queue + item detail + client slice)
// ---------------------------------------------------------------------------

export interface AgencyAttentionQueueView {
  readonly scope: {
    readonly kind: 'agency-attention-queue';
    readonly agencyId: string;
    readonly clientCount: number;
    readonly humanAgentCount: number;
  };
  readonly items: readonly AttentionItem[];
  readonly counts: AttentionCategoryCounts;
  readonly ranking: RankingDisclosure;
  readonly generatedAt: string;
}

export interface ClientAttentionQueueView {
  readonly scope: {
    readonly kind: 'client-attention-queue';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceCount: number;
  };
  readonly items: readonly AttentionItem[];
  readonly counts: AttentionCategoryCounts;
  /**
   * Categories structurally absent from a client slice, with the honest
   * reason (e.g. the capacity-constraint item is agency-pool-scoped: it
   * lives in the agency queue only, never sliced per client).
   */
  readonly scopeExclusions: ReadonlyArray<{
    readonly category: AttentionCategory;
    readonly reason: string;
  }>;
  readonly ranking: RankingDisclosure;
  readonly generatedAt: string;
}

/**
 * The ITEM DETAIL view: one deterministic item re-derived in the agency
 * queue's context (the queue is recomputed — nothing is cached — and the
 * item located by its deterministic id). An unknown, malformed or foreign
 * itemId is the uniform 404 upstream (foreign ≡ unknown ≡ malformed).
 */
export interface AttentionItemDetailView {
  readonly scope: {
    readonly kind: 'agency-attention-item';
    readonly agencyId: string;
  };
  readonly item: AttentionItem;
  readonly totalItemCount: number;
  readonly categoryCounts: AttentionCategoryCounts;
  readonly ranking: RankingDisclosure;
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

export interface AiOperatorModuleDeps {
  readonly clock: Clock;
  /**
   * The frozen matrix line added for MKT-045 (read-only composition):
   * /ai-operator ──→ /clients, /workspaces, /workflows, /executions,
   * /deployments, /jobs, /policies, /evidence, /experiments, /learnings,
   * /field-agents, /profit-intelligence.
   */
  readonly clients: ClientsModuleApi;
  readonly workspaces: WorkspacesModuleApi;
  readonly workflows: WorkflowsModuleApi;
  readonly executions: ExecutionsModuleApi;
  readonly deployments: DeploymentsModuleApi;
  readonly jobs: JobsModuleApi;
  readonly policies: PoliciesModuleApi;
  readonly evidence: EvidenceModuleApi;
  readonly experiments: ExperimentsModuleApi;
  readonly learnings: LearningsModuleApi;
  readonly fieldAgents: FieldAgentsModuleApi;
  readonly profitIntelligence: ProfitIntelligenceModuleApi;
}

export interface AiOperatorModuleApi {
  /**
   * The AGENCY's attention queue — every live-derived ranked item across
   * the agency's LIVE Clients (blocked work, undecided approvals, client
   * risk, anomalies, scope leakage, margin pressure, the agency capacity
   * constraint and opportunities). The aggregation scope arrives as
   * SERVER-DERIVED data (the route resolved the agency's LIVE Clients and
   * ACTIVE human_agent membership users from durable state — the
   * scope-as-data posture of the /profit-intelligence reads); canonical
   * Client ownership re-resolves FIRST inside the module for every Client
   * (isolation before traversal).
   */
  getAgencyAttentionQueue(input: {
    readonly agencyId: string;
    readonly clients: ReadonlyArray<{ readonly clientId: string }>;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<AgencyAttentionQueueView>;

  /**
   * The CLIENT's attention queue — the client-scoped slice of the ranked
   * items (this Client's blocked work, its client-scoped undecided
   * approvals, its risk/anomaly/leakage/margin items and its
   * opportunities; the agency-pool capacity-constraint item is excluded
   * with a disclosed reason). Canonical Client ownership resolves FIRST
   * (/clients public contract): unknown or tombstoned Client → the
   * uniform 404 upstream.
   */
  getClientAttentionQueue(input: {
    readonly clientId: string;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<ClientAttentionQueueView>;

  /**
   * ONE attention item by its DETERMINISTIC id, re-derived in the agency
   * queue's full context (the queue recomputes — no cache, no store — and
   * the item is located by its deterministic key). An unknown, malformed
   * or FOREIGN item id (an item of another agency's queue) is the uniform
   * 404 upstream: foreign ≡ unknown ≡ malformed, no existence oracle.
   */
  getAttentionItem(input: {
    readonly agencyId: string;
    readonly itemId: string;
    readonly clients: ReadonlyArray<{ readonly clientId: string }>;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<AttentionItemDetailView>;
}

export { createAiOperatorModule } from './internal/ai-operator-module.ts';

// The pure derivation + ranking functions and snapshot types (unit-tested;
// re-exported so tests and future read-side emitters compose the exact
// module semantics). See internal/attention-derivation.ts.
export type {
  AgencyScopeSnapshot,
  CapacityJobRows,
  ClientScopeRows,
} from './internal/attention-derivation.ts';
export {
  attentionItemKey,
  composeRankingDisclosure,
  deriveAgencyAttentionItems,
  deriveApprovalItems,
  deriveAnomalyItems,
  deriveBlockedWorkItems,
  deriveCapacityConstraintItem,
  deriveClientRiskItems,
  deriveMarginPressureItems,
  deriveOpportunityItems,
  deriveScopeLeakageItems,
  rankAttentionItems,
  tallyCategoryCounts,
} from './internal/attention-derivation.ts';
