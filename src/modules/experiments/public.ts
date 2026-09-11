/**
 * MarketingOS module: /experiments
 * Authority: Experiments (spec/implementation-contract.md §1).
 *
 * MKT-015 implements this authority (EXP-001): the EXPERIMENT DESIGN MODEL —
 * experiment design, treatment/comparison, assignment metadata and analysis
 * declarations (spec/work-items.md). This module owns:
 *
 *   - the FULL frozen Experiment contract (spec/implementation-contract.md
 *     §16 "Experiment contract"; spec/evidence-and-experimentation.md
 *     "Experiment contract"): hypothesis, the decision being informed
 *     (decision target), population/unit, treatment AND comparison, the
 *     primary metric identified BY NAME + DIMENSIONS (never a provider
 *     metric id — the metric identity of the measured series), guardrails,
 *     the assignment method, the analysis method (+version), the declared
 *     DESIGN TYPE (randomized / controlled comparison / quasi-experimental /
 *     observational / descriptive), the expected direction where
 *     applicable, start/stop criteria, the minimum evidence requirement,
 *     the DECLARED uncertainty representation, the result state and the
 *     resulting decision;
 *   - the frozen experiment LIFECYCLE (spec/state-machines.md):
 *     DRAFT → READY → RUNNING → ANALYZING → CONCLUDED, with STOPPED and
 *     INVALIDATED branching from RUNNING. Every transition is recorded in
 *     an APPEND-ONLY transition history table with server-derived
 *     provenance; the DECLARED DESIGN is immutable after creation (a DB
 *     trigger rejects any design-column rewrite — "Conclusion state must
 *     preserve the declared design and analysis metadata");
 *   - the CONCLUSION-TYPE taxonomy (EXP-AC-02): the result state is a
 *     CLOSED set in which the CAUSAL conclusion types
 *     ('causal_supported' / 'causal_not_supported') are DISTINCT type-level
 *     values from the attribution / observation / inconclusive types —
 *     never free strings, never interchangeable. The CAUSAL EVIDENCE
 *     STANDARD (implementation-contract §16: "An experiment cannot be
 *     marked CAUSAL_SUPPORTED unless its declared design and analysis
 *     satisfy the configured causal evidence standard") is enforced at the
 *     TYPE level (assertCausalConclusionAllowed), the MODULE level (the
 *     conclude transition refuses a causal result state for observational
 *     or descriptive designs) AND the DATABASE level (a CHECK constraint
 *     on every experiments row and every transition row) — scientific rule
 *     "Do not claim causality from observational correlation alone";
 *   - UNCERTAINTY AND ANALYSIS METADATA retention (EXP-AC-03): the
 *     conclusion carries the uncertainty payload MATCHING the declared
 *     representation (interval with lower/upper/level, a distribution
 *     descriptor, or a qualitative description — null only when the
 *     declared representation is 'none'), the assumptions, the sample
 *     limitations and the confounders. These are nullable exactly where
 *     the method permits, NEVER silently dropped: they round-trip through
 *     the store byte-for-byte ("Preserve uncertainty intervals where the
 *     method permits them. Report sample limitations and possible
 *     confounders.");
 *   - PROVENANCE as a SERVER-DERIVED dimension (the MKT-013/MKT-014
 *     pattern): the module API takes provenance as its own argument type
 *     that no request DTO feeds; route validation rejects every
 *     provenance-shaped authority field AND lifecycle/result authority
 *     fields (status, resultState, decision are never caller-supplied on
 *     create);
 *   - CLIENT OWNERSHIP: every experiment is owned by exactly one Client,
 *     resolved canonically THROUGH the /clients public contract BEFORE any
 *     write (the goals/evidence/metrics pattern); the optional Workspace
 *     scope is resolved THROUGH the /workspaces public contract and must
 *     live inside the owning Client;
 *   - optional EVIDENCE LINKAGE on the conclusion: the cited /evidence
 *     record ids must belong to the SAME Client (module guard AND the DB
 *     trigger — the migration 018 metric_evidence_ref pattern), giving the
 *     declared minimum evidence requirement a traceable, tenant-fenced
 *     citation set.
 *
 * What this module deliberately does NOT do (bounded scope, MKT-015):
 *   - no ASSIGNMENT EXECUTION / runtime traffic splitting (runtime work,
 *     not the design authority);
 *   - no OUTCOME ANALYSIS or computation (the conclusion is a DECLARED,
 *     validated record — the platform never computes lift here; analysis
 *     engines live elsewhere and arrive through later Work Items);
 *   - no Learnings (MKT-016 — /learnings owns those), no claims/inference
 *     graph, no /reporting read side (consumes this contract later);
 *   - no provider state of any kind (no SDK imports — frozen matrix);
 *   - a negative or inconclusive result is a VALID outcome (modeled: the
 *     closed result-state set contains 'causal_not_supported' and
 *     'inconclusive' — the model never biases toward "success").
 *
 * DEPENDENCY POSTURE (frozen matrix: /experiments ──→ /evidence, /metrics,
 * /goals): this public entry imports /evidence's public contract (the
 * evidence-linkage validation + the shared §21 material-key backstop).
 * /metrics is NOT imported: the frozen Experiment contract identifies the
 * primary metric BY NAME + DIMENSIONS — an experiment is declared BEFORE
 * observations exist, so there is nothing to validate against the
 * observation ledger (the allowed direction stays unused, like /goals).
 * The REQUIRED canonical Client/Workspace ownership resolution ("never
 * caller-supplied") is expressed as STRUCTURAL PORTS declared below —
 * narrow typed views of the /clients and /workspaces public contracts'
 * canonical ownership resolution methods, wired at the composition root
 * (identical posture to /metrics), so the frozen import matrix stays
 * intact (verified by tools/arch-check and
 * tests/architecture/experiments-boundary.test.ts).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';

// ---------------------------------------------------------------------------
// Declared design type (implementation-contract §16) + the causal evidence
// standard (evidence quality taxonomy, spec/evidence-and-experimentation.md)
// ---------------------------------------------------------------------------

/**
 * The frozen experiment DESIGN TYPES (implementation-contract §16:
 * "Experiments have a declared design type: randomized; controlled
 * comparison; quasi-experimental; observational; descriptive"). A closed
 * set — extension is a code + DB migration change, never a caller freedom.
 */
export type ExperimentDesignType =
  | 'randomized'
  | 'controlled_comparison'
  | 'quasi_experimental'
  | 'observational'
  | 'descriptive';

export const EXPERIMENT_DESIGN_TYPES: readonly ExperimentDesignType[] = [
  'randomized',
  'controlled_comparison',
  'quasi_experimental',
  'observational',
  'descriptive',
];

export function isKnownExperimentDesignType(value: string): value is ExperimentDesignType {
  return (EXPERIMENT_DESIGN_TYPES as readonly string[]).includes(value);
}

/**
 * The evidence-quality grade each design type can support, per the frozen
 * ordered taxonomy (A: randomized experiment / strong controlled design;
 * B: strong quasi-experimental design; C: defensible observational/
 * time-series analysis; D: descriptive/attribution evidence). Interpretable
 * and traceable — the grade is derived from the DECLARED design, never
 * caller-asserted.
 */
export const DESIGN_TYPE_EVIDENCE_GRADE: Readonly<Record<ExperimentDesignType, string>> = {
  randomized: 'A',
  controlled_comparison: 'A',
  quasi_experimental: 'B',
  observational: 'C',
  descriptive: 'D',
};

/**
 * The CONFIGURED CAUSAL EVIDENCE STANDARD (implementation-contract §16: "An
 * experiment cannot be marked CAUSAL_SUPPORTED unless its declared design
 * and analysis satisfy the configured causal evidence standard"): only
 * designs whose evidence grade is A (randomized experiment / strong
 * controlled design) or B (strong quasi-experimental design) may carry a
 * causal conclusion. Observational (C) and descriptive (D) designs can
 * never — the scientific rule "Do not claim causality from observational
 * correlation alone" is a frozen invariant, enforced in type, module and
 * database.
 */
export const CAUSAL_EVIDENCE_STANDARD = {
  /** Minimum grade a design must support to carry a causal conclusion. */
  minimumGrade: 'B',
  /** Design types that satisfy the standard (grade A or B). */
  causalDesignTypes: [
    'randomized',
    'controlled_comparison',
    'quasi_experimental',
  ] as readonly ExperimentDesignType[],
} as const;

/**
 * Pure predicate: does the DECLARED design satisfy the configured causal
 * evidence standard? (Grades A/B designs only — see CAUSAL_EVIDENCE_STANDARD.)
 */
export function designSatisfiesCausalStandard(designType: ExperimentDesignType): boolean {
  return CAUSAL_EVIDENCE_STANDARD.causalDesignTypes.includes(designType);
}

// ---------------------------------------------------------------------------
// Result state — the EXP-AC-02 conclusion-type taxonomy
// ---------------------------------------------------------------------------

/**
 * The frozen experiment RESULT STATES (implementation-contract §16 "result
 * state"; the §16-named mark CAUSAL_SUPPORTED appears here verbatim). A
 * CLOSED set — type-level values, DB CHECK backstop, never free strings.
 * A negative or inconclusive result is a valid outcome (scientific rules).
 */
export const EXPERIMENT_RESULT_STATES = [
  'undecided',
  'causal_supported',
  'causal_not_supported',
  'attribution',
  'observation',
  'inconclusive',
] as const;

export type ExperimentResultState = (typeof EXPERIMENT_RESULT_STATES)[number];

/**
 * The CAUSAL conclusion types — DISTINCT type-level values (EXP-AC-02: the
 * causal conclusion type is distinct from the attribution/observation
 * type). An attribution result can never be serialized as a causal
 * conclusion (implementation-contract §14) and vice versa.
 */
export type CausalResultState = 'causal_supported' | 'causal_not_supported';

/**
 * The NON-causal conclusion types: attribution (credit assignment under a
 * declared attribution method — never incremental lift), observation
 * (observational summary — explicitly not causal) and inconclusive.
 */
export type NonCausalResultState = 'attribution' | 'observation' | 'inconclusive';

export const CAUSAL_RESULT_STATES: readonly CausalResultState[] = [
  'causal_supported',
  'causal_not_supported',
];

export const NON_CAUSAL_RESULT_STATES: readonly NonCausalResultState[] = [
  'attribution',
  'observation',
  'inconclusive',
];

/** Type-level disjointness proof inputs (asserted by unit/architecture tests). */
export function isCausalResultState(value: string): value is CausalResultState {
  return (CAUSAL_RESULT_STATES as readonly string[]).includes(value);
}

export function isKnownExperimentResultState(value: string): value is ExperimentResultState {
  return (EXPERIMENT_RESULT_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Lifecycle (spec/state-machines.md) — DRAFT → READY → RUNNING → ANALYZING
// → CONCLUDED; RUNNING → STOPPED | INVALIDATED
// ---------------------------------------------------------------------------

export const EXPERIMENT_STATUSES = [
  'draft',
  'ready',
  'running',
  'analyzing',
  'concluded',
  'stopped',
  'invalidated',
] as const;

export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** The explicit lifecycle commands (each maps to exactly one legal edge). */
export const EXPERIMENT_TRANSITIONS = [
  'mark_ready',
  'start',
  'begin_analysis',
  'conclude',
  'stop',
  'invalidate',
] as const;

export type ExperimentTransition = (typeof EXPERIMENT_TRANSITIONS)[number];

/**
 * The frozen transition table (spec/state-machines.md):
 * mark_ready: DRAFT→READY; start: READY→RUNNING; begin_analysis:
 * RUNNING→ANALYZING; conclude: ANALYZING→CONCLUDED (carries the conclusion
 * payload); stop: RUNNING→STOPPED; invalidate: RUNNING→INVALIDATED.
 * TERMINAL states (concluded/stopped/invalidated) have no outgoing edges.
 */
export const EXPERIMENT_TRANSITION_TABLE: Readonly<
  Record<ExperimentTransition, { readonly from: ExperimentStatus; readonly to: ExperimentStatus }>
> = {
  mark_ready: { from: 'draft', to: 'ready' },
  start: { from: 'ready', to: 'running' },
  begin_analysis: { from: 'running', to: 'analyzing' },
  conclude: { from: 'analyzing', to: 'concluded' },
  stop: { from: 'running', to: 'stopped' },
  invalidate: { from: 'running', to: 'invalidated' },
};

export function isKnownExperimentTransition(value: string): value is ExperimentTransition {
  return (EXPERIMENT_TRANSITIONS as readonly string[]).includes(value);
}

/** The legal successor states of one status under the frozen state machine. */
export function legalExperimentSuccessors(status: ExperimentStatus): readonly ExperimentStatus[] {
  const successors: ExperimentStatus[] = [];
  for (const transition of EXPERIMENT_TRANSITIONS) {
    if (EXPERIMENT_TRANSITION_TABLE[transition].from === status) {
      successors.push(EXPERIMENT_TRANSITION_TABLE[transition].to);
    }
  }
  return successors;
}

// ---------------------------------------------------------------------------
// Declared-direction + uncertainty-representation taxonomies
// ---------------------------------------------------------------------------

/**
 * Expected direction of the primary metric, where applicable (the frozen
 * contract marks it optional: "expected direction where applicable").
 */
export const EXPERIMENT_EXPECTED_DIRECTIONS = ['increase', 'decrease', 'no_change', 'any'] as const;

export type ExperimentExpectedDirection = (typeof EXPERIMENT_EXPECTED_DIRECTIONS)[number];

export function isKnownExperimentExpectedDirection(
  value: string,
): value is ExperimentExpectedDirection {
  return (EXPERIMENT_EXPECTED_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The DECLARED uncertainty representation (implementation-contract §16
 * "uncertainty representation"): how the conclusion's uncertainty WILL be
 * expressed. 'none' is a declared method property — some methods do not
 * permit intervals ("Preserve uncertainty intervals where the method
 * permits them") — and a 'none' design must conclude with uncertainty null,
 * never a silently dropped payload.
 */
export const EXPERIMENT_UNCERTAINTY_REPRESENTATIONS = [
  'interval',
  'distribution',
  'qualitative',
  'none',
] as const;

export type ExperimentUncertaintyRepresentation =
  (typeof EXPERIMENT_UNCERTAINTY_REPRESENTATIONS)[number];

export function isKnownUncertaintyRepresentation(
  value: string,
): value is ExperimentUncertaintyRepresentation {
  return (EXPERIMENT_UNCERTAINTY_REPRESENTATIONS as readonly string[]).includes(value);
}

/**
 * The conclusion's UNCERTAINTY PAYLOAD — a discriminated union whose `kind`
 * must equal the DECLARED uncertainty representation (the module and the
 * round-trip tests enforce the match; 'none' designs conclude with null).
 * Discriminated at the TYPE level: an interval can never be misread as a
 * distribution descriptor.
 */
export type ExperimentUncertainty =
  | {
      readonly kind: 'interval';
      /** Lower bound of the uncertainty interval. */
      readonly lower: number;
      /** Upper bound of the uncertainty interval. */
      readonly upper: number;
      /** Declared coverage level, e.g. 0.95. */
      readonly level: number;
    }
  | {
      readonly kind: 'distribution';
      /** Declared distribution descriptor, e.g. 'normal(mean=1.2, sd=0.3)'. */
      readonly descriptor: string;
    }
  | {
      readonly kind: 'qualitative';
      /** Qualitative uncertainty description (methods without intervals). */
      readonly description: string;
    };

// ---------------------------------------------------------------------------
// Metric identity — BY NAME + DIMENSIONS, never a provider metric id
// ---------------------------------------------------------------------------

/** Dimension values are scalars: the dimension SET identifies the series. */
export type ExperimentMetricDimensionValue = string | number | boolean;

/**
 * The metric identity an experiment declares for its primary metric and
 * guardrails: the NAME of the measured series plus its dimension key set
 * (spec/evidence-and-experimentation.md "primary metric"; architecture.md
 * §16 "primary/guardrail outcomes"). Deliberately NOT a metric observation
 * id and NOT a provider metric id: experiments are declared before
 * observations exist, and provider identifiers never become MOS identities.
 */
export interface ExperimentMetricIdentity {
  readonly name: string;
  readonly dimensions: Readonly<Record<string, ExperimentMetricDimensionValue>>;
}

// ---------------------------------------------------------------------------
// Provenance (server-derived) — the dimension callers can never supply
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of one experiment mutation (the MKT-013/014
 * pattern). Built exclusively by server code from the authenticated
 * principal, the ambient correlation context and the recording system —
 * never from a request body. `recordedAt` is stamped by the module's clock.
 */
export interface ExperimentProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording system label: 'api' today; later server-side emitters. */
  readonly recordedVia: string;
  /** Correlation identity of the logical flow that performed the mutation. */
  readonly correlationId: string;
  /** Causation identity (e.g. the job id) when the mutation was worker-caused. */
  readonly causationId: string | null;
}

/** Provenance block as persisted on the record. */
export interface ExperimentRecordedProvenance extends ExperimentProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Records + inputs
// ---------------------------------------------------------------------------

/** One experiment: the immutable declared design + the mutable lifecycle. */
export interface ExperimentRecord {
  readonly experimentId: string;
  readonly clientId: string;
  /** Optional Workspace scope INSIDE the owning Client (null = client-wide). */
  readonly workspaceId: string | null;
  // --- the DECLARED (immutable after create) Experiment contract ---
  readonly hypothesis: string;
  /** The decision being informed (implementation-contract §16 "decision target"). */
  readonly decisionTarget: string;
  readonly populationUnit: string;
  readonly treatment: string;
  readonly comparison: string;
  readonly assignmentMethod: string;
  readonly designType: ExperimentDesignType;
  /** Primary metric identity (name + dimensions) — never a provider metric id. */
  readonly primaryMetric: ExperimentMetricIdentity;
  /** Guardrail metric identities (possibly empty). */
  readonly guardrails: readonly ExperimentMetricIdentity[];
  readonly analysisMethod: string;
  /** Optional analysis method version (implementation-contract §16 "analysis method/version"). */
  readonly analysisMethodVersion: string | null;
  /** Expected direction where applicable (null = not declared). */
  readonly expectedDirection: ExperimentExpectedDirection | null;
  /** Start conditions where applicable (null = not declared). */
  readonly startCriteria: string | null;
  /** Stop criteria (frozen contract: required). */
  readonly stopCriteria: string;
  /** The declared minimum evidence requirement (e.g. 'B — strong quasi-experimental at minimum'). */
  readonly minimumEvidenceRequirement: string;
  /** The DECLARED uncertainty representation for conclusions. */
  readonly uncertaintyRepresentation: ExperimentUncertaintyRepresentation;
  // --- the lifecycle ---
  readonly status: ExperimentStatus;
  readonly resultState: ExperimentResultState;
  /** The resulting decision (null while undecided — the initial state). */
  readonly resultingDecision: string | null;
  readonly concludedAt: string | null;
  readonly provenance: ExperimentRecordedProvenance;
}

/** Module input for declaring one experiment (the full design payload). */
export interface ExperimentCreateInput {
  readonly clientId: string;
  /** Optional Workspace scope; resolved canonically, must be inside the Client. */
  readonly workspaceId: string | null;
  readonly hypothesis: string;
  readonly decisionTarget: string;
  readonly populationUnit: string;
  readonly treatment: string;
  readonly comparison: string;
  readonly assignmentMethod: string;
  readonly designType: ExperimentDesignType;
  readonly primaryMetric: ExperimentMetricIdentity;
  readonly guardrails: readonly ExperimentMetricIdentity[];
  readonly analysisMethod: string;
  readonly analysisMethodVersion: string | null;
  readonly expectedDirection: ExperimentExpectedDirection | null;
  readonly startCriteria: string | null;
  readonly stopCriteria: string;
  readonly minimumEvidenceRequirement: string;
  readonly uncertaintyRepresentation: ExperimentUncertaintyRepresentation;
}

/**
 * The conclusion payload carried by the `conclude` transition
 * (ANALYZING → CONCLUDED). Uncertainty and analysis metadata are retained
 * verbatim (EXP-AC-03); the result state is one closed-set value (EXP-AC-02);
 * a causal result state requires a design satisfying the causal evidence
 * standard; the cited evidence refs must belong to the SAME Client.
 */
export interface ExperimentConclusion {
  readonly resultState: Exclude<ExperimentResultState, 'undecided'>;
  /**
   * The uncertainty payload. Its `kind` MUST equal the experiment's DECLARED
   * uncertainty representation; null only when the representation is 'none'.
   */
  readonly uncertainty: ExperimentUncertainty | null;
  /** Analysis assumptions (retained verbatim; empty allowed). */
  readonly assumptions: readonly string[];
  /** Sample limitations ("Report sample limitations"). */
  readonly sampleLimitations: readonly string[];
  /** Possible confounders ("Report ... possible confounders"). */
  readonly confounders: readonly string[];
  /** The resulting decision (null = undecided/not applicable). */
  readonly resultingDecision: string | null;
  /** /evidence records cited by the conclusion (SAME Client; DB-fenced). */
  readonly evidenceRefs: readonly string[];
}

/** Module input for one lifecycle transition. */
export interface ExperimentTransitionInput {
  readonly transition: ExperimentTransition;
  /** REQUIRED for 'conclude'; MUST be absent otherwise. */
  readonly conclusion: ExperimentConclusion | null;
}

/** One append-only transition-history row. */
export interface ExperimentTransitionRecord {
  readonly transitionId: string;
  readonly experimentId: string;
  readonly transition: ExperimentTransition;
  readonly fromStatus: ExperimentStatus;
  readonly toStatus: ExperimentStatus;
  /** The conclusion payload when this transition is the conclusion (null otherwise). */
  readonly conclusion: {
    readonly resultState: Exclude<ExperimentResultState, 'undecided'>;
    readonly uncertainty: ExperimentUncertainty | null;
    readonly assumptions: readonly string[];
    readonly sampleLimitations: readonly string[];
    readonly confounders: readonly string[];
    readonly resultingDecision: string | null;
    readonly evidenceRefs: readonly string[];
  } | null;
  readonly provenance: ExperimentRecordedProvenance;
}

// ---------------------------------------------------------------------------
// Canonical ownership ports (frozen-matrix-compliant /clients + /workspaces
// resolution — see the module header note)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /clients CANONICAL OWNER CONTEXT (the
 * public-contract shape /experiments consumes). The real
 * ClientOwnerContext satisfies this structurally — /clients remains the
 * ONLY Client ownership authority.
 */
export interface ExperimentsClientOwnershipSnapshot {
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
 * The slice of the /clients public contract /experiments depends on:
 * canonical server-side Client ownership resolution from durable state.
 * Satisfied structurally by ClientsModuleApi; wired at the composition root.
 */
export interface ClientOwnershipResolutionPort {
  resolveClientOwnership(clientId: string): Promise<ExperimentsClientOwnershipSnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /workspaces canonical ownership resolution.
 * The real WorkspaceOwnerContext satisfies this structurally — /workspaces
 * remains the ONLY Workspace authority.
 */
export interface ExperimentsWorkspaceOwnershipSnapshot {
  readonly workspace: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /workspaces public contract /experiments depends on:
 * canonical server-side Workspace ownership resolution. Satisfied
 * structurally by WorkspacesModuleApi; wired at the composition root.
 */
export interface WorkspaceOwnershipResolutionPort {
  resolveWorkspaceOwnership(workspaceId: string): Promise<ExperimentsWorkspaceOwnershipSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL EXPERIMENT OWNER CONTEXT: the single server-side resolution
 * of WHICH Client owns the experiment (and which Agency owns that Client),
 * plus the scoped Workspace ownership snapshot when workspace-scoped — all
 * derived from durable state on every call. Experiments-scoped operations
 * authorize against this context — never against caller-supplied tenant or
 * experiment identity. `scope` mirrors the pipeline OwnerScope shapes.
 *
 * The Client is the hard security boundary: a tombstoned (deleted) Client
 * never resolves (null — uniform 404 upstream). A tombstoned Workspace also
 * resolves null here — the experiment row itself stays readable (declared
 * design history is never erased); authorization depends only on the
 * client/agency chain.
 */
export interface ExperimentOwnerContext {
  readonly scope: {
    readonly kind: 'experiment';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly experimentId: string;
  };
  readonly experiment: ExperimentRecord;
  /** The /clients canonical ownership snapshot this experiment resolves through. */
  readonly clientOwnership: ExperimentsClientOwnershipSnapshot;
  /** The /workspaces ownership snapshot when workspace-scoped and still resolvable (null otherwise). */
  readonly workspace: ExperimentsWorkspaceOwnershipSnapshot | null;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical experiment owner context from an
 * ALREADY-RESOLVED /clients canonical ownership snapshot, the experiment
 * record and (for workspace-scoped records) the /workspaces ownership
 * snapshot. Purity is asserted by unit tests — the same inputs always
 * compose the same context; a caller-supplied agency id appears nowhere in
 * the composition inputs.
 */
export function composeExperimentOwnerContext(
  experiment: ExperimentRecord,
  clientOwnership: ExperimentsClientOwnershipSnapshot,
  workspace: ExperimentsWorkspaceOwnershipSnapshot | null,
  resolvedAt: string,
): ExperimentOwnerContext {
  return {
    scope: {
      kind: 'experiment',
      agencyId: clientOwnership.scope.agencyId,
      clientId: experiment.clientId,
      workspaceId: experiment.workspaceId,
      experimentId: experiment.experimentId,
    },
    experiment,
    clientOwnership,
    workspace,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ExperimentsModuleApi {
  /**
   * Declares one experiment (the full frozen design payload; the lifecycle
   * starts at DRAFT with result state 'undecided' and a null resulting
   * decision). `provenance` is SERVER-DERIVED and is the only source of
   * actor/system/correlation/recordedAt on the row.
   *
   * Client ownership is resolved canonically THROUGH the /clients public
   * contract BEFORE any write: unknown or tombstoned Client →
   * NotFoundError; disabled Client → ConflictError (new use blocked
   * without rewriting history). A supplied workspaceId is resolved THROUGH
   * the /workspaces public contract: unknown, tombstoned or belonging to a
   * DIFFERENT Client → NotFoundError (uniform — a foreign workspace
   * identifier is not a traversal/existence oracle); disabled Workspace →
   * ConflictError.
   */
  createExperiment(
    input: ExperimentCreateInput,
    provenance: ExperimentProvenance,
  ): Promise<ExperimentRecord>;
  /** Raw record by id — the declared design stays readable forever. */
  getExperiment(experimentId: string): Promise<ExperimentRecord | null>;
  /**
   * Canonical ownership resolution: the experiment, its owning Client
   * resolved through the /clients public contract, and its scoped Workspace
   * ownership snapshot, composed into the canonical owner context. Null
   * when the experiment does not exist OR its Client is a deleted
   * tombstone — callers surface a uniform 404 so foreign, unknown and
   * orphaned identifiers are indistinguishable (hard-boundary posture).
   */
  resolveExperimentOwnership(experimentId: string): Promise<ExperimentOwnerContext | null>;
  /**
   * The Client's experiments, newest first by server-recorded time
   * (bounded, server-chosen limit). Client ownership is resolved canonically
   * first; unknown or deleted Client → NotFoundError.
   */
  listExperimentsForClient(clientId: string): Promise<readonly ExperimentRecord[]>;
  /**
   * Applies one lifecycle transition (the frozen state machine): the
   * transition must be legal for the CURRENT status (ConflictError
   * otherwise — 409), the design is never rewritten, and every application
   * appends one immutable transition-history row carrying the server-derived
   * provenance. The `conclude` transition requires its conclusion payload:
   * the result state is validated against the CLOSED taxonomy, a CAUSAL
   * result state requires a design satisfying the causal evidence standard
   * (EXP-AC-02 — InvalidRequestError otherwise), the uncertainty payload
   * must match the DECLARED uncertainty representation, the analysis
   * metadata (assumptions/sample limitations/confounders) is retained
   * verbatim (EXP-AC-03), and every cited evidence ref must resolve to an
   * /evidence record of the SAME Client (uniform NotFoundError otherwise;
   * the DB trigger is the race backstop).
   */
  applyExperimentTransition(
    experimentId: string,
    input: ExperimentTransitionInput,
    provenance: ExperimentProvenance,
  ): Promise<ExperimentRecord>;
  /** The append-only transition history, oldest first. */
  listExperimentTransitions(
    experimentId: string,
  ): Promise<readonly ExperimentTransitionRecord[]>;
}

export interface ExperimentsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix: /experiments ──→ /evidence, /metrics, /goals — /evidence
   * is the merged authority this Work Item consumes (conclusion evidence
   * citation validation + the shared §21 material-key backstop).
   */
  readonly evidence: EvidenceModuleApi;
  /**
   * Canonical Client ownership resolution THROUGH the /clients public
   * contract (structural port — see the module header note; the concrete
   * ClientsModuleApi instance is wired at the composition root).
   */
  readonly clients: ClientOwnershipResolutionPort;
  /**
   * Canonical Workspace ownership resolution THROUGH the /workspaces public
   * contract (structural port; wired at the composition root).
   */
  readonly workspaces: WorkspaceOwnershipResolutionPort;
}

export { createExperimentsModule } from './internal/experiments-module.ts';
/**
 * The pure guards — experiment-design validation (the full §16 contract),
 * conclusion validation (closed result-state taxonomy, the causal evidence
 * standard gate, uncertainty-representation matching, analysis-metadata
 * shapes), provenance validation and the transition-legality check —
 * exported for unit tests and future server-side emitters so the guard
 * semantics are part of the module contract. Pure functions.
 */
export {
  assertValidExperimentCreate,
  assertValidExperimentConclusion,
  assertValidExperimentProvenance,
  assertValidExperimentTransitionInput,
  classifyExperimentWriteConflict,
} from './internal/experiments-store.ts';
