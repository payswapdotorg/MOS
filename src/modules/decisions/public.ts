/**
 * MarketingOS module: /decisions
 * Authority: the Decision Ledger (spec/architecture-v1.5.md §4; the primary
 * contract spec/operating-graph-v1.5.md "Decision Ledger"; frozen by
 * spec/architecture-lock-v1.5.md rule #5 and spec/change-request-005.md
 * change #2 — MKT-042).
 *
 * The append-oriented ledger for MATERIAL RECOMMENDATIONS AND COMMERCIAL
 * DECISIONS. One decision record carries the full frozen vocabulary of the
 * primary contract ("decision scope, objective, evidence, context, hypothesis
 * summary, expected impact and uncertainty, expected cost, proposer,
 * alternatives, disposition, execution/deployment reference, observed outcome,
 * learning reference and audit metadata"):
 *
 *   - DECISION SCOPE: the server-derived Client ownership (+ Agency through
 *     the canonical /clients chain, + the optional Workspace refinement
 *     inside that Client). Never a DTO dimension — the route resolves the
 *     Client from the PATH, canonical owner resolution runs BEFORE any
 *     authorization or write, and a foreign workspace identifier is a
 *     uniform 404 (no cross-tenant oracle);
 *   - OBJECTIVE, CONTEXT, HYPOTHESIS SUMMARY: bounded text fields of the
 *     reasoning core (objective + hypothesis summary required, context
 *     optional);
 *   - EVIDENCE: evidence_refs — /evidence record ids validated THROUGH the
 *     /evidence public contract at write time (same-Client; uniform 404 for
 *     foreign/unknown; the DB trigger is the race backstop);
 *   - HYPOTHESIS LINK: the optional experiment_ref — the /experiments record
 *     whose declared hypothesis informs this decision (same-Client; any
 *     lifecycle state: the hypothesis informs the proposal BEFORE its
 *     conclusion exists);
 *   - EXPECTED IMPACT + UNCERTAINTY: TWO SEPARATE structured columns —
 *     expected_impact (jsonb: summary + direction from a closed set +
 *     optional magnitude) and uncertainty (jsonb: an interval, distribution
 *     descriptor or qualitative description, or null when not declared).
 *     Uncertainty is never conflated with impact (the MKT-042 vocabulary
 *     keeps them distinct);
 *   - EXPECTED COST: bounded optional text (the declared cost expectation);
 *   - PROPOSER: SERVER-DERIVED identity + role at proposal time
 *     (proposer_actor 'user:<uuid>' | 'service:<label>'; proposer_role the
 *     agency role / platform role / service label the authenticated
 *     principal held when the decision was recorded). There is NO request
 *     DTO path to either column;
 *   - ALTERNATIVES: the considered alternatives (bounded string array);
 *   - DISPOSITION: the frozen lifecycle — proposed → accepted | rejected |
 *     superseded (all three terminal; a second disposition against a
 *     terminal record is a 409; concurrent dispositions converge to
 *     exactly one winner under the CAS update — the experiments
 *     precedent — with the DB legal-successor trigger as the race
 *     backstop);
 *   - EXECUTION/DEPLOYMENT REFERENCE: set exactly once, with the observed
 *     outcome, on an ACCEPTED decision — the /executions or /deployments
 *     record that carried the decision out (at most one of the two;
 *     same-Client; write-time validated);
 *   - OBSERVED OUTCOME: the structured outcome observation recorded exactly
 *     once on an ACCEPTED decision (summary + asExpected + notes — a
 *     corrected outcome is a NEW decision, never a rewrite);
 *   - LEARNING REFERENCE: the /learnings record derived from this
 *     decision's observed outcome (same-Client; set with the outcome);
 *   - AUDIT METADATA: the server-derived provenance block (actor, recording
 *     system, correlation, causation, recordedAt) — identical posture to
 *     every append-only authority; no DTO path.
 *
 * APPEND-ORIENTED SEMANTICS (lock rule #5: "Decision Ledger is
 * append-oriented and cannot rewrite historical execution, evidence, outcome
 * or learning records"): corrections create NEW records — the correction
 * declares its predecessor at create time (predecessor_decision_id), and the
 * superseded predecessor forward-links to its successor
 * (successor_decision_id, set by the supersede disposition). The proposal
 * columns of a decision row are IMMUTABLE after insert (a DB trigger rejects
 * any rewrite); only the lifecycle columns (disposition, successor,
 * disposition_at, observed_outcome, execution_ref, deployment_ref,
 * learning_ref, outcome_at) may ever change, and only along the frozen legal
 * edges. The event tail (decision_events) is APPEND-ONLY — UPDATE and DELETE
 * are rejected by DB triggers; not even server-side SQL can rewrite the
 * ledger's history.
 *
 * REPLAY CONVERGENCE (the §8 pattern, executions/deployments precedent):
 * every write surface carries a caller-supplied logical idempotency key,
 * uniqueness DB-enforced — a duplicate create of the SAME logical command
 * converges to the recorded record (replayed=true, 200, same rows); a key
 * reused for a DIFFERENT payload is a ConflictError (409). The create
 * fingerprint (a deterministic digest of the caller-visible payload) is the
 * convergence proof.
 *
 * What this module deliberately does NOT do (bounded scope, MKT-042):
 *   - no policy gating of recording (architecture-v1.5.md §7: consequential
 *     ACTIONS continue through the existing policy/approval contracts —
 *     RECORDING a decision is unconditional; the /policies allowance stays
 *     the reserved direction for the MKT-045 attention-queue flow, exactly
 *     like the deliberately-unused matrix allowances of /agents);
 *   - no mutation of any other authority — the ledger only READS the
 *     /evidence, /experiments, /learnings, /executions and /deployments
 *     public contracts for write-time reference validation (lock rule #5's
 *     "cannot rewrite" half);
 *   - no Operating Graph edges, no Profit Intelligence, no derived
 *     analytics (MKT-041/MKT-043 consume this ledger later);
 *   - no provider state of any kind (no SDK imports — frozen matrix).
 *
 * DEPENDENCY POSTURE (the MKT-042 registration row
 * /decisions ──→ /evidence, /experiments, /learnings, /executions,
 * /deployments, /policies, /clients, /workspaces — the reference-validation
 * authorities of the frozen vocabulary + the canonical ownership ports):
 * the module imports the /evidence, /experiments, /learnings, /executions
 * and /deployments public contracts DIRECTLY (read-only reference
 * validation). The REQUIRED canonical Client/Workspace ownership resolution
 * ("never caller-supplied") is expressed as STRUCTURAL PORTS declared below
 * — narrow typed views of the /clients and /workspaces public contracts'
 * canonical ownership resolution methods, wired at the composition root
 * (identical posture to /experiments, /metrics and /learnings), so the
 * frozen import posture stays intact (verified by tools/arch-check and
 * tests/architecture/decisions-boundary.test.ts). /policies is the
 * declared-but-unused reserved direction (the /agents precedent).
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
import type { ExecutionsModuleApi } from '../executions/public.ts';
import type { DeploymentsModuleApi } from '../deployments/public.ts';

// ---------------------------------------------------------------------------
// Disposition — the frozen lifecycle (PROPOSED → ACCEPTED | REJECTED |
// SUPERSEDED; all three terminal)
// ---------------------------------------------------------------------------

/**
 * The frozen decision DISPOSITIONS (operating-graph-v1.5.md "disposition").
 * A CLOSED set — extension is a code + DB migration change, never a caller
 * freedom. 'proposed' is the INITIAL state of every new record;
 * 'accepted', 'rejected' and 'superseded' are TERMINAL (a second
 * disposition against a terminal record is a ConflictError — history never
 * rewrites; a correction is a NEW record).
 */
export const DECISION_DISPOSITIONS = ['proposed', 'accepted', 'rejected', 'superseded'] as const;

export type DecisionDisposition = (typeof DECISION_DISPOSITIONS)[number];

/** The terminal dispositions — no second disposition is ever legal. */
export const TERMINAL_DECISION_DISPOSITIONS: readonly DecisionDisposition[] = [
  'accepted',
  'rejected',
  'superseded',
];

export function isKnownDecisionDisposition(value: string): value is DecisionDisposition {
  return (DECISION_DISPOSITIONS as readonly string[]).includes(value);
}

export function isTerminalDecisionDisposition(disposition: DecisionDisposition): boolean {
  return TERMINAL_DECISION_DISPOSITIONS.includes(disposition);
}

/**
 * The explicit disposition commands (each maps to exactly one legal edge
 * from 'proposed'). There is deliberately no 'propose' command — creation
 * IS the proposal.
 */
export const DECISION_DISPOSITION_COMMANDS = ['accept', 'reject', 'supersede'] as const;

export type DecisionDispositionCommand = (typeof DECISION_DISPOSITION_COMMANDS)[number];

/**
 * The frozen disposition transition table: every command's single legal
 * edge. PROPOSED is the only source state (the three targets are terminal
 * — no outgoing edges anywhere).
 */
export const DECISION_DISPOSITION_TABLE: Readonly<
  Record<DecisionDispositionCommand, { readonly from: DecisionDisposition; readonly to: DecisionDisposition }>
> = {
  accept: { from: 'proposed', to: 'accepted' },
  reject: { from: 'proposed', to: 'rejected' },
  supersede: { from: 'proposed', to: 'superseded' },
};

export function isKnownDecisionDispositionCommand(value: string): value is DecisionDispositionCommand {
  return (DECISION_DISPOSITION_COMMANDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Expected-impact direction + the uncertainty payload (structured, and
// distinct from impact by construction — two separate columns)
// ---------------------------------------------------------------------------

/**
 * The closed DIRECTION vocabulary for the structured expected impact
 * (which way the impacted metric is expected to move). Mirrors the
 * experiment expected-direction taxonomy.
 */
export const DECISION_IMPACT_DIRECTIONS = ['increase', 'decrease', 'no_change', 'any'] as const;

export type DecisionImpactDirection = (typeof DECISION_IMPACT_DIRECTIONS)[number];

export function isKnownDecisionImpactDirection(value: string): value is DecisionImpactDirection {
  return (DECISION_IMPACT_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The structured EXPECTED IMPACT of the decision (jsonb on the row; its own
 * column — never conflated with uncertainty). `summary` is required;
 * `direction` and `magnitude` are optional declared detail.
 */
export interface DecisionExpectedImpact {
  /** What outcome the decision is expected to produce (required, bounded). */
  readonly summary: string;
  /** Expected movement of the impacted metric where applicable. */
  readonly direction: DecisionImpactDirection | null;
  /** Free-form expected magnitude, e.g. '+18% CVR' (optional, bounded). */
  readonly magnitude: string | null;
}

/**
 * The DECLARED UNCERTAINTY of the expected impact — a SEPARATE column and
 * payload (the vocabulary records "expected impact and uncertainty" as two
 * distinct things). A discriminated union: an interval can never be
 * misread as a distribution descriptor or a qualitative note. Null = no
 * uncertainty declared.
 */
export type DecisionUncertainty =
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
      /** Qualitative uncertainty description. */
      readonly description: string;
    };

// ---------------------------------------------------------------------------
// The observed outcome (recorded exactly once on an ACCEPTED decision)
// ---------------------------------------------------------------------------

/**
 * The structured OBSERVED OUTCOME recorded once the accepted decision has
 * been carried out: what was actually observed. `summary` is required;
 * `asExpected` compares the observation against the expected impact;
 * `notes` carries bounded supporting detail. A corrected outcome is a NEW
 * decision — this payload is written exactly once.
 */
export interface DecisionObservedOutcome {
  /** What was actually observed (required, bounded). */
  readonly summary: string;
  /** Whether the observation matched the expected impact (null = not assessed). */
  readonly asExpected: boolean | null;
  /** Bounded supporting notes (optional). */
  readonly notes: string | null;
}

// ---------------------------------------------------------------------------
// Provenance + proposer (server-derived — the dimensions callers can
// never supply)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of one decision mutation (the MKT-013/014/015
 * pattern). Built exclusively by server code from the authenticated
 * principal, the ambient correlation context and the recording system —
 * never from a request body. `recordedAt` is stamped by the module's clock.
 */
export interface DecisionProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording system label: 'api' today; later server-side emitters. */
  readonly recordedVia: string;
  /** Correlation identity of the logical flow that performed the mutation. */
  readonly correlationId: string;
  /** Causation identity (e.g. the job id) when the mutation was worker-caused. */
  readonly causationId: string | null;
}

/** Provenance block as persisted on the record / event rows. */
export interface DecisionRecordedProvenance extends DecisionProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

/**
 * The SERVER-DERIVED PROPOSER of a decision: identity + role at proposal
 * time ("proposer" in the frozen vocabulary). The route layer derives both
 * from the authenticated principal and its resolved agency membership —
 * there is NO request DTO path to either field.
 */
export interface DecisionProposer {
  /** Proposer identity label, e.g. 'user:<uuid>' or 'service:<label>'. */
  readonly actor: string;
  /**
   * The proposer's role when the decision was recorded: the agency
   * membership role ('agency_owner' | 'agency_admin' |
   * 'agency_collaborator'), 'platform_administrator', or 'service'.
   */
  readonly role: string;
}

// ---------------------------------------------------------------------------
// Records + inputs
// ---------------------------------------------------------------------------

/** One decision: the immutable proposal payload + the lifecycle columns. */
export interface DecisionRecord {
  readonly decisionId: string;
  readonly clientId: string;
  /** Optional Workspace scope INSIDE the owning Client (null = client-wide). */
  readonly workspaceId: string | null;
  /** The owning Agency, server-derived through the canonical /clients chain. */
  readonly agencyId: string;
  // --- the PROPOSAL payload (immutable after create) ---
  readonly objective: string;
  /** Decision context (null = none recorded). */
  readonly context: string | null;
  /** The hypothesis summary informing the decision. */
  readonly hypothesisSummary: string;
  /** The /experiments record whose hypothesis informs this decision (null = none). */
  readonly experimentRef: string | null;
  /** /evidence records cited by the proposal (possibly empty). */
  readonly evidenceRefs: readonly string[];
  /** The structured expected impact (own column, distinct from uncertainty). */
  readonly expectedImpact: DecisionExpectedImpact;
  /** The declared uncertainty of the expected impact (null = not declared). */
  readonly uncertainty: DecisionUncertainty | null;
  /** The declared expected cost (null = not declared). */
  readonly expectedCost: string | null;
  /** The considered alternatives (possibly empty). */
  readonly alternatives: readonly string[];
  /** The correction link: the decision this record corrects (null = original). */
  readonly predecessorDecisionId: string | null;
  /** SERVER-DERIVED proposer (identity + role at proposal time). */
  readonly proposer: DecisionProposer;
  // --- the lifecycle (the only mutable columns, legal edges only) ---
  readonly disposition: DecisionDisposition;
  /** Set by the supersede disposition: the successor decision (null otherwise). */
  readonly successorDecisionId: string | null;
  readonly dispositionAt: string | null;
  /** The observed outcome, recorded exactly once on an ACCEPTED decision. */
  readonly observedOutcome: DecisionObservedOutcome | null;
  /** The /executions record that carried the decision out (set with the outcome). */
  readonly executionRef: string | null;
  /** The /deployments record that carried the decision out (set with the outcome). */
  readonly deploymentRef: string | null;
  /** The /learnings record derived from the observed outcome (set with the outcome). */
  readonly learningRef: string | null;
  readonly outcomeAt: string | null;
  /** The §8 logical create key + convergence proof. */
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  // --- audit metadata (server-derived, immutable) ---
  readonly provenance: DecisionRecordedProvenance;
}

/** Module input for recording one decision (the full proposal payload). */
export interface DecisionCreateInput {
  readonly clientId: string;
  /** Optional Workspace scope; resolved canonically, must be inside the Client. */
  readonly workspaceId: string | null;
  readonly objective: string;
  readonly context: string | null;
  readonly hypothesisSummary: string;
  /** Optional /experiments reference (the hypothesis link). */
  readonly experimentRef: string | null;
  /** /evidence citations of the proposal (possibly empty). */
  readonly evidenceRefs: readonly string[];
  readonly expectedImpact: DecisionExpectedImpact;
  readonly uncertainty: DecisionUncertainty | null;
  readonly expectedCost: string | null;
  readonly alternatives: readonly string[];
  /**
   * The correction link: the decision this record corrects. Must exist,
   * belong to the SAME Client and NOT already be superseded (a superseded
   * decision already has its replacement — correct the successor instead).
   */
  readonly predecessorDecisionId: string | null;
  /** The §8 logical create key (caller-supplied; DB-fenced per Client). */
  readonly idempotencyKey: string;
}

/**
 * The disposition payload: the command (accept / reject / supersede), the
 * optional reason, and — for 'supersede' ONLY — the successor decision
 * (which must be a SAME-Client, still-'proposed' correction whose
 * predecessor IS this decision).
 */
export interface DecisionDispositionInput {
  readonly command: DecisionDispositionCommand;
  /** Bounded disposition reason (optional). */
  readonly reason: string | null;
  /** REQUIRED for 'supersede'; MUST be absent otherwise. */
  readonly successorDecisionId: string | null;
  /** The §8 logical command key (caller-supplied; DB-fenced per decision). */
  readonly idempotencyKey: string;
}

/**
 * The observed-outcome payload: recorded exactly once on an ACCEPTED
 * decision. Carries the structured observation plus the optional
 * execution/deployment reference (at most one of the two) and the optional
 * derived-learning reference — the post-execution linkage triple of the
 * frozen vocabulary.
 */
export interface DecisionOutcomeInput {
  readonly observedOutcome: DecisionObservedOutcome;
  /** The /executions record that carried the decision out (optional). */
  readonly executionRef: string | null;
  /** The /deployments record that carried the decision out (optional). */
  readonly deploymentRef: string | null;
  /** The /learnings record derived from this outcome (optional). */
  readonly learningRef: string | null;
  /** The §8 logical command key (caller-supplied; DB-fenced per decision). */
  readonly idempotencyKey: string;
}

/** One append-only ledger event (the immutable history tail). */
export interface DecisionEventRecord {
  readonly eventId: string;
  readonly decisionId: string;
  /** 'disposition' | 'outcome_observed' (creation IS the row, not an event). */
  readonly eventKind: 'disposition' | 'outcome_observed';
  /** The resulting disposition (disposition events only; null otherwise). */
  readonly disposition: DecisionDisposition | null;
  /** The disposition reason (disposition events only). */
  readonly reason: string | null;
  /** The successor decision (supersede events only). */
  readonly successorDecisionId: string | null;
  /** The observed-outcome payload (outcome events only). */
  readonly observedOutcome: DecisionObservedOutcome | null;
  /** The execution reference (outcome events only). */
  readonly executionRef: string | null;
  /** The deployment reference (outcome events only). */
  readonly deploymentRef: string | null;
  /** The learning reference (outcome events only). */
  readonly learningRef: string | null;
  readonly idempotencyKey: string;
  readonly provenance: DecisionRecordedProvenance;
}

/** Create outcome with the §8 replay flag. */
export interface DecisionCreateOutcome {
  readonly decision: DecisionRecord;
  /** True when the §8 fence converged a duplicate create to the recorded row. */
  readonly replayed: boolean;
}

/** Disposition/outcome outcome with the §8 replay flag. */
export interface DecisionDispositionOutcome {
  readonly decision: DecisionRecord;
  readonly event: DecisionEventRecord;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Canonical ownership ports (frozen-matrix-compliant /clients + /workspaces
// resolution — see the module header note)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /clients CANONICAL OWNER CONTEXT (the
 * public-contract shape /decisions consumes). The real
 * ClientOwnerContext satisfies this structurally — /clients remains the
 * ONLY Client ownership authority.
 */
export interface DecisionsClientOwnershipSnapshot {
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
 * The slice of the /clients public contract /decisions depends on:
 * canonical server-side Client ownership resolution from durable state.
 * Satisfied structurally by ClientsModuleApi; wired at the composition root.
 */
export interface DecisionsClientOwnershipPort {
  resolveClientOwnership(clientId: string): Promise<DecisionsClientOwnershipSnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /workspaces canonical ownership resolution.
 * The real WorkspaceOwnerContext satisfies this structurally — /workspaces
 * remains the ONLY Workspace authority.
 */
export interface DecisionsWorkspaceOwnershipSnapshot {
  readonly workspace: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /workspaces public contract /decisions depends on:
 * canonical server-side Workspace ownership resolution. Satisfied
 * structurally by WorkspacesModuleApi; wired at the composition root.
 */
export interface DecisionsWorkspaceOwnershipPort {
  resolveWorkspaceOwnership(workspaceId: string): Promise<DecisionsWorkspaceOwnershipSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL DECISION OWNER CONTEXT: the single server-side resolution
 * of WHICH Client owns the decision (and which Agency owns that Client),
 * plus the scoped Workspace ownership snapshot when workspace-scoped — all
 * derived from durable state on every call. Decision-scoped operations
 * authorize against this context — never against caller-supplied tenant or
 * decision identity.
 *
 * The Client is the hard security boundary: a tombstoned (deleted) Client
 * never resolves (null — uniform 404 upstream). A tombstoned Workspace
 * resolves null here — the decision row itself stays readable (ledger
 * history is never erased); authorization depends only on the
 * client/agency chain.
 */
export interface DecisionOwnerContext {
  readonly scope: {
    readonly kind: 'decision';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly decisionId: string;
  };
  readonly decision: DecisionRecord;
  /** The /clients canonical ownership snapshot this decision resolves through. */
  readonly clientOwnership: DecisionsClientOwnershipSnapshot;
  /** The /workspaces ownership snapshot when workspace-scoped and still resolvable (null otherwise). */
  readonly workspace: DecisionsWorkspaceOwnershipSnapshot | null;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical decision owner context from an
 * ALREADY-RESOLVED /clients canonical ownership snapshot and the decision
 * record. Purity is asserted by unit tests — the same inputs always
 * compose the same context; a caller-supplied agency id appears nowhere in
 * the composition inputs.
 */
export function composeDecisionOwnerContext(
  decision: DecisionRecord,
  clientOwnership: DecisionsClientOwnershipSnapshot,
  workspace: DecisionsWorkspaceOwnershipSnapshot | null,
  resolvedAt: string,
): DecisionOwnerContext {
  return {
    scope: {
      kind: 'decision',
      agencyId: clientOwnership.scope.agencyId,
      clientId: decision.clientId,
      workspaceId: decision.workspaceId,
      decisionId: decision.decisionId,
    },
    decision,
    clientOwnership,
    workspace,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface DecisionsModuleApi {
  /**
   * Records one decision (the proposal payload; the lifecycle starts at
   * 'proposed'). `provenance` and `proposer` are SERVER-DERIVED and are the
   * only sources of audit metadata and proposer identity/role on the row.
   *
   * Client ownership is resolved canonically THROUGH the /clients public
   * contract BEFORE any write: unknown or tombstoned Client →
   * NotFoundError; disabled Client → ConflictError (new use blocked
   * without rewriting history). A supplied workspaceId is resolved THROUGH
   * the /workspaces public contract: unknown, tombstoned or belonging to a
   * DIFFERENT Client → NotFoundError (uniform — a foreign workspace
   * identifier is not a traversal/existence oracle); disabled Workspace →
   * ConflictError.
   *
   * Write-time reference validation (fail closed): every evidenceRef must
   * resolve to an /evidence record of the SAME Client (uniform
   * NotFoundError); the experimentRef must resolve to an /experiments
   * record of the SAME Client (uniform NotFoundError; any lifecycle state
   * — the hypothesis informs the proposal); the predecessorDecisionId must
   * resolve to a SAME-Client decision that is NOT already superseded
   * (uniform NotFoundError for foreign/unknown; ConflictError for a
   * superseded predecessor). The DB triggers are the race backstops.
   *
   * §8 replay convergence: the idempotency key is DB-fenced per Client; a
   * duplicate of the SAME logical create converges to the recorded record
   * (replayed=true); a key reused for a DIFFERENT payload is a
   * ConflictError.
   */
  createDecision(
    input: DecisionCreateInput,
    proposer: DecisionProposer,
    provenance: DecisionProvenance,
  ): Promise<DecisionCreateOutcome>;
  /** Raw record by id — the ledger stays readable forever. */
  getDecision(decisionId: string): Promise<DecisionRecord | null>;
  /**
   * Canonical ownership resolution: the decision, its owning Client
   * resolved through the /clients public contract, and its scoped
   * Workspace ownership snapshot, composed into the canonical owner
   * context. Null when the decision does not exist OR its Client is a
   * deleted tombstone — callers surface a uniform 404 so foreign, unknown
   * and orphaned identifiers are indistinguishable (hard-boundary
   * posture).
   */
  resolveDecisionOwnership(decisionId: string): Promise<DecisionOwnerContext | null>;
  /**
   * The Client's decisions, newest first by server-recorded time (bounded,
   * server-chosen limit — the append-only ledger grows without end).
   * Client ownership is resolved canonically first; unknown or deleted
   * Client → NotFoundError.
   */
  listDecisionsForClient(clientId: string): Promise<readonly DecisionRecord[]>;
  /**
   * Records ONE disposition (the frozen state machine: accept / reject /
   * supersede from 'proposed' only). A second disposition against a
   * terminal record is a ConflictError (409); concurrent dispositions
   * converge to exactly one winner under the CAS update (the experiments
   * precedent; the DB legal-successor trigger is the race backstop).
   *
   * For 'supersede' the successor MUST be a SAME-Client, still-'proposed'
   * decision whose predecessor IS this decision (the two-step correction
   * flow — create the correction first, then supersede). The superseded
   * record forward-links to its successor; nothing is rewritten.
   *
   * §8 replay convergence: the idempotency key is DB-fenced per decision;
   * a duplicate of the SAME disposition command converges to the recorded
   * event (replayed=true); a key reused for a different command/payload is
   * a ConflictError.
   */
  recordDecisionDisposition(
    decisionId: string,
    input: DecisionDispositionInput,
    provenance: DecisionProvenance,
  ): Promise<DecisionDispositionOutcome>;
  /**
   * Records the OBSERVED OUTCOME of an accepted decision — exactly once.
   * Requires disposition 'accepted' (ConflictError otherwise: a
   * rejected/superseded decision was never carried out); a second outcome
   * is a ConflictError (a corrected outcome is a NEW decision, never a
   * rewrite). Carries the structured observation plus the optional
   * execution/deployment reference (at most ONE of the two — ConflictError
   * when both are supplied) and the optional derived-learning reference.
   *
   * Write-time reference validation (fail closed): the executionRef must
   * resolve to an /executions record of the SAME Client (uniform
   * NotFoundError); the deploymentRef to a /deployments record of the SAME
   * Client (uniform NotFoundError); the learningRef to a /learnings record
   * of the SAME Client (uniform NotFoundError). The DB triggers are the
   * race backstops.
   *
   * §8 replay convergence: the idempotency key is DB-fenced per decision;
   * a duplicate of the SAME outcome converges (replayed=true).
   */
  recordObservedOutcome(
    decisionId: string,
    input: DecisionOutcomeInput,
    provenance: DecisionProvenance,
  ): Promise<DecisionDispositionOutcome>;
  /** The append-only ledger event tail of one decision, oldest first. */
  listDecisionEvents(decisionId: string): Promise<readonly DecisionEventRecord[]>;
}

export interface DecisionsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The reference-validation authorities of the frozen vocabulary (the
   * MKT-042 registration row): /evidence citations + the shared §21
   * material-key backstop, /experiments hypothesis links, /learnings
   * derived-learning references, /executions + /deployments implementation
   * references — all consumed read-only through their public contracts.
   */
  readonly evidence: EvidenceModuleApi;
  readonly experiments: ExperimentsModuleApi;
  readonly learnings: LearningsModuleApi;
  readonly executions: ExecutionsModuleApi;
  readonly deployments: DeploymentsModuleApi;
  /**
   * Canonical Client ownership resolution THROUGH the /clients public
   * contract (structural port — see the module header note; the concrete
   * ClientsModuleApi instance is wired at the composition root).
   */
  readonly clients: DecisionsClientOwnershipPort;
  /**
   * Canonical Workspace ownership resolution THROUGH the /workspaces
   * public contract (structural port; wired at the composition root).
   */
  readonly workspaces: DecisionsWorkspaceOwnershipPort;
}

export { createDecisionsModule } from './internal/decisions-module.ts';
/**
 * The pure guards — decision create validation (the full proposal
 * vocabulary), disposition-input validation (the frozen command table +
 * successor presence rules), outcome-input validation (the observation
 * payload + the execution/deployment at-most-one rule), proposer +
 * provenance validation, the create fingerprint and the DB-conflict
 * classification — exported for unit tests and future server-side
 * emitters so the guard semantics are part of the module contract. Pure
 * functions.
 */
export {
  assertValidDecisionCreate,
  assertValidDecisionDispositionInput,
  assertValidDecisionOutcomeInput,
  assertValidDecisionProposer,
  assertValidDecisionProvenance,
  fingerprintDecisionCreate,
  classifyDecisionWriteConflict,
} from './internal/decisions-store.ts';
