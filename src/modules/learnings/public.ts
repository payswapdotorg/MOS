/**
 * MarketingOS module: /learnings
 * Authority: Learnings (spec/implementation-contract.md §1, §17).
 *
 * MKT-016 implements this authority (LEARN-001, LEARN-AC-01..02). A
 * Learning is the DURABLE CONCLUSION of the business decision model
 * (spec/evidence-and-experimentation.md: "Learning — durable conclusion
 * with explicit applicability conditions"; spec/architecture.md §17:
 * "Learning is a durable conclusion linked to supporting evidence/outcomes
 * and applicability. Learning never erases contradictory history"). This
 * module owns:
 *
 *   - the LEARNING RECORD (implementation-contract §17): the statement
 *     (the durable conclusion), the APPLICABILITY conditions under which
 *     it holds ("Learnings have scope"), the supporting references to
 *     /evidence records and /experiments OUTCOMES (validated through
 *     those authorities' public contracts, same-Client, uniform 404), the
 *     caller-declared CONFIDENCE as a separate descriptive field
 *     ("confidence as a separate descriptive field" — provenance is a
 *     separate dimension, never confidence-reachable), and the
 *     scope-chain ownership (Client + optional Workspace INSIDE the
 *     Client, the same conventions the other authorities use);
 *   - the CONTRADICTION / SUPERSESSION / RETIREMENT relationships
 *     (LEARN-AC-02): each is a NEW append-only row in
 *     learning_relationships (migration 027) — 'contradicts' and
 *     'supersedes' carry a LATER learning recorded against an EARLIER
 *     one; 'retires' retires a learning with no successor. The Learning
 *     STATE ("active, superseded, contradicted, or retired",
 *     implementation-contract §17) is DERIVED at read time from that
 *     relationship history and is NEVER a stored, mutable column — the
 *     original learning row is fully immutable (DB triggers reject
 *     UPDATE and DELETE) and byte-stable through every contradiction,
 *     supersession and retirement. "Learning is never retroactive
 *     deletion of evidence" and "Repeated experimentation may update a
 *     learning but does not erase historical evidence";
 *   - PROVENANCE as a SERVER-DERIVED dimension (the /evidence and
 *     /experiments pattern): the module API takes provenance as its own
 *     argument type that no request DTO feeds (route validation rejects
 *     provenance-shaped authority fields);
 *   - the terminal fences at the database level: at most ONE superseding
 *     relationship per prior learning, at most ONE retirement per
 *     learning, and no relationship may target an already-superseded or
 *     already-retired learning. A CONTRADICTED learning is not terminal —
 *     later evidence may contradict it again ("Learnings have scope and
 *     may be contradicted by later evidence") and it may still be
 *     superseded or retired afterwards.
 *
 * What this module deliberately does NOT do (bounded scope, MKT-016):
 *   - no metric normalization (/metrics owns it), no experiment machinery
 *     (/experiments owns it — learnings only REFERENCE concluded
 *     experiment outcomes through the /experiments public contract), no
 *     evidence classes (/evidence owns it), no claims/inference graph;
 *   - no workflow/AI/field surfaces, no UI, no /reporting read side;
 *   - no promotion of confidence into authority (the descriptive score
 *     never touches ownership, provenance or references).
 *
 * DEPENDENCY POSTURE (frozen matrix: /learnings ──→ /evidence,
 * /experiments, /goals): this public entry imports the /evidence and
 * /experiments public contracts (the supporting-reference validation +
 * the shared §21 material-key backstop). /goals is NOT imported: the
 * Learning record carries its own applicability conditions and needs no
 * goal linkage (the allowed direction stays unused, like /metrics for
 * /experiments). The REQUIRED canonical Client/Workspace ownership
 * resolution ("never caller-supplied") is expressed as STRUCTURAL PORTS
 * declared below — narrow typed views of the /clients and /workspaces
 * public contracts' canonical ownership resolution methods, wired at the
 * composition root (identical posture to /experiments and /metrics), so
 * the frozen import matrix stays intact (verified by tools/arch-check
 * and tests/architecture/learnings-boundary.test.ts).
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

// ---------------------------------------------------------------------------
// The Learning state taxonomy (implementation-contract §17) + the
// relationship kinds (LEARN-AC-02)
// ---------------------------------------------------------------------------

/**
 * The frozen Learning states (implementation-contract §17: "state whether
 * it is active, superseded, contradicted, or retired"). A closed set —
 * and in this authority the state is DERIVED from the append-only
 * relationship history (never a stored, mutable column): 'active' (no
 * relationships target it), 'contradicted' (later evidence contradicts
 * it — NOT terminal), 'superseded' (a successor learning replaced it —
 * terminal), 'retired' (explicitly retired — terminal).
 */
export const LEARNING_STATUSES = [
  'active',
  'superseded',
  'contradicted',
  'retired',
] as const;

export type LearningStatus = (typeof LEARNING_STATUSES)[number];

export function isKnownLearningStatus(value: string): value is LearningStatus {
  return (LEARNING_STATUSES as readonly string[]).includes(value);
}

/**
 * The frozen relationship kinds (LEARN-AC-02): each one is a NEW
 * append-only relationship row, never a mutation of an existing record.
 *   - 'contradicts': the LATER learning (to) contradicts the EARLIER one
 *     (from) — "Learnings have scope and may be contradicted by later
 *     evidence";
 *   - 'supersedes': the LATER learning (to) replaces the EARLIER one
 *     (from) as its explicit successor;
 *   - 'retires': the learning (from) is retired with no successor.
 */
export const LEARNING_RELATIONSHIP_KINDS = [
  'contradicts',
  'supersedes',
  'retires',
] as const;

export type LearningRelationshipKind = (typeof LEARNING_RELATIONSHIP_KINDS)[number];

export function isKnownLearningRelationshipKind(
  value: string,
): value is LearningRelationshipKind {
  return (LEARNING_RELATIONSHIP_KINDS as readonly string[]).includes(value);
}

/**
 * The DERIVED-STATUS precedence (deterministic; encoded in migration 027's
 * read-side derivation and mirrored by the store's SELECT): superseded >
 * retired > contradicted > active. Superseded and retired are terminal
 * (the fences allow exactly one each); contradicted is not.
 */
export const LEARNING_STATUS_PRECEDENCE: readonly LearningStatus[] = [
  'superseded',
  'retired',
  'contradicted',
  'active',
];

/** Terminal derived statuses — no further relationship may target them. */
export const TERMINAL_LEARNING_STATUSES: readonly LearningStatus[] = [
  'superseded',
  'retired',
];

export function isTerminalLearningStatus(status: LearningStatus): boolean {
  return TERMINAL_LEARNING_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Provenance (server-derived) — the dimension callers can never supply
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of one learning append or relationship append
 * (the /evidence and /experiments pattern). Built exclusively by server
 * code from the authenticated principal, the ambient correlation context
 * and the recording system — never from a request body (route validation
 * rejects provenance-shaped authority fields; this type is a separate
 * module-API argument so no DTO can feed it structurally). `recordedAt`
 * is stamped by the module's clock at append time.
 */
export interface LearningProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording system label: 'api' today; later server-side emitters. */
  readonly recordedVia: string;
  /** Correlation identity of the logical flow that appended the record. */
  readonly correlationId: string;
  /** Causation identity (e.g. the job id) when the append was worker-caused. */
  readonly causationId: string | null;
}

/** Provenance block as persisted on the immutable record. */
export interface LearningRecordedProvenance extends LearningProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Record + input shapes
// ---------------------------------------------------------------------------

/** Applicability condition values are scalars (JSON-safe, like the metric-dimension convention). */
export type LearningApplicabilityValue = string | number | boolean;

/**
 * One immutable, append-only Learning record. The `status` field is the
 * DERIVED state (active/superseded/contradicted/retired) and
 * `supersededBy` is the DERIVED successor pointer — both computed
 * server-side from the relationship history at read time, never stored,
 * never mutable, so the underlying row is byte-stable forever (LEARN-AC-02).
 */
export interface LearningRecord {
  readonly learningId: string;
  readonly clientId: string;
  /** Optional Workspace scope INSIDE the owning Client (null = client-wide). */
  readonly workspaceId: string | null;
  /** The durable conclusion statement. */
  readonly statement: string;
  /**
   * The APPLICABILITY conditions under which the Learning holds
   * ("durable conclusion with explicit applicability conditions") — a
   * non-empty object of dimension-like scalar conditions.
   */
  readonly applicability: Readonly<Record<string, LearningApplicabilityValue>>;
  /** Supporting /evidence record ids (same Client, validated through the /evidence public contract). */
  readonly evidenceRefs: readonly string[];
  /** Supporting /experiments ids (same Client, CONCLUDED outcomes, validated through the /experiments public contract). */
  readonly experimentRefs: readonly string[];
  /** Caller-declared descriptive confidence 0..1 — SEPARATE from provenance (implementation-contract §17). */
  readonly confidence: number | null;
  /** The DERIVED state (implementation-contract §17) — never stored, never mutated. */
  readonly status: LearningStatus;
  /** The DERIVED successor learning id (null unless superseded). */
  readonly supersededBy: string | null;
  readonly provenance: LearningRecordedProvenance;
}

/** Module input for appending one Learning record. */
export interface LearningCreateInput {
  readonly clientId: string;
  /** Optional Workspace scope; resolved canonically, must be inside the Client. */
  readonly workspaceId: string | null;
  readonly statement: string;
  readonly applicability: Readonly<Record<string, LearningApplicabilityValue>>;
  readonly evidenceRefs: readonly string[];
  readonly experimentRefs: readonly string[];
  readonly confidence: number | null;
}

/** Module input for recording one contradiction/supersession/retirement relationship. */
export interface LearningRelationshipInput {
  readonly kind: LearningRelationshipKind;
  /**
   * The LATER learning that contradicts or supersedes the target. REQUIRED
   * for 'contradicts' and 'supersedes'; MUST be absent for 'retires'.
   */
  readonly toLearningId: string | null;
}

/** One append-only relationship row (LEARN-AC-02 — the history-preserving state change). */
export interface LearningRelationshipRecord {
  readonly relationshipId: string;
  /** The EARLIER (target) learning the relationship is recorded against. */
  readonly fromLearningId: string;
  /** The LATER learning recording the relationship (null for 'retires'). */
  readonly toLearningId: string | null;
  readonly kind: LearningRelationshipKind;
  readonly provenance: LearningRecordedProvenance;
}

// ---------------------------------------------------------------------------
// Canonical ownership ports (frozen-matrix-compliant /clients + /workspaces
// resolution — the /experiments posture)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /clients CANONICAL OWNER CONTEXT (the
 * public-contract shape /learnings consumes). The real ClientOwnerContext
 * satisfies this structurally — /clients remains the ONLY Client
 * ownership authority.
 */
export interface LearningsClientOwnershipSnapshot {
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
 * The slice of the /clients public contract /learnings depends on:
 * canonical server-side Client ownership resolution from durable state.
 * Satisfied structurally by ClientsModuleApi; wired at the composition root.
 */
export interface ClientOwnershipResolutionPort {
  resolveClientOwnership(clientId: string): Promise<LearningsClientOwnershipSnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /workspaces canonical ownership resolution.
 * The real WorkspaceOwnerContext satisfies this structurally — /workspaces
 * remains the ONLY Workspace authority.
 */
export interface LearningsWorkspaceOwnershipSnapshot {
  readonly workspace: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /workspaces public contract /learnings depends on:
 * canonical server-side Workspace ownership resolution. Satisfied
 * structurally by WorkspacesModuleApi; wired at the composition root.
 */
export interface WorkspaceOwnershipResolutionPort {
  resolveWorkspaceOwnership(workspaceId: string): Promise<LearningsWorkspaceOwnershipSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL LEARNING OWNER CONTEXT: the single server-side resolution
 * of WHICH Client owns the Learning (and which Agency owns that Client),
 * plus the scoped Workspace ownership snapshot when workspace-scoped —
 * all derived from durable state on every call. Learnings-scoped
 * operations authorize against this context — never against
 * caller-supplied tenant or learning identity. `scope` mirrors the
 * pipeline OwnerScope shapes.
 *
 * The Client is the hard security boundary: a tombstoned (deleted) Client
 * never resolves (null — uniform 404 upstream). A tombstoned Workspace
 * also resolves null here — the learning row itself stays readable
 * (learning history is never erased); authorization depends only on the
 * client/agency chain.
 */
export interface LearningOwnerContext {
  readonly scope: {
    readonly kind: 'learning';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly learningId: string;
  };
  readonly learning: LearningRecord;
  /** The /clients canonical ownership snapshot this learning resolves through. */
  readonly clientOwnership: LearningsClientOwnershipSnapshot;
  /** The /workspaces ownership snapshot when workspace-scoped and still resolvable (null otherwise). */
  readonly workspace: LearningsWorkspaceOwnershipSnapshot | null;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical Learning owner context from an
 * ALREADY-RESOLVED /clients canonical ownership snapshot, the learning
 * record and (for workspace-scoped records) the /workspaces ownership
 * snapshot. Purity is asserted by unit tests — the same inputs always
 * compose the same context; a caller-supplied agency id appears nowhere
 * in the composition inputs.
 */
export function composeLearningOwnerContext(
  learning: LearningRecord,
  clientOwnership: LearningsClientOwnershipSnapshot,
  workspace: LearningsWorkspaceOwnershipSnapshot | null,
  resolvedAt: string,
): LearningOwnerContext {
  return {
    scope: {
      kind: 'learning',
      agencyId: clientOwnership.scope.agencyId,
      clientId: learning.clientId,
      workspaceId: learning.workspaceId,
      learningId: learning.learningId,
    },
    learning,
    clientOwnership,
    workspace,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface LearningsModuleApi {
  /**
   * Appends one immutable Learning record. `provenance` is SERVER-DERIVED
   * and is the only source of actor/system/correlation/recordedAt on the
   * row.
   *
   * Client ownership is resolved canonically THROUGH the /clients public
   * contract BEFORE any write: unknown or tombstoned Client →
   * NotFoundError; disabled Client → ConflictError (new use blocked
   * without rewriting history). A supplied workspaceId is resolved
   * THROUGH the /workspaces public contract: unknown, tombstoned or
   * belonging to a DIFFERENT Client → NotFoundError (uniform — a foreign
   * workspace identifier is not a traversal/existence oracle); disabled
   * Workspace → ConflictError.
   *
   * Supporting references (fail closed, LEARN-AC-01): every evidenceRef
   * must resolve to an /evidence record of the SAME Client (uniform
   * NotFoundError — a foreign evidence identifier is indistinguishable
   * from an unknown one; the DB trigger is the race backstop); every
   * experimentRef must resolve to an /experiments record of the SAME
   * Client (uniform NotFoundError) that has CONCLUDED (an outcome
   * reference requires a declared outcome — InvalidRequestError
   * otherwise; the module validates through the /experiments public
   * contract, never its internals).
   */
  createLearning(
    input: LearningCreateInput,
    provenance: LearningProvenance,
  ): Promise<LearningRecord>;
  /**
   * Raw record by id — the full row plus the DERIVED status and successor
   * pointer (superseded and retired learnings included: immutable
   * history is always readable, LEARN-AC-02).
   */
  getLearning(learningId: string): Promise<LearningRecord | null>;
  /**
   * Canonical ownership resolution: the learning record, its owning Client
   * resolved through the /clients public contract, and its scoped
   * Workspace ownership snapshot, composed into the canonical owner
   * context. Null when the record does not exist OR its Client is a
   * deleted tombstone — callers surface a uniform 404 so foreign, unknown
   * and orphaned identifiers are indistinguishable (hard-boundary
   * posture).
   */
  resolveLearningOwnership(learningId: string): Promise<LearningOwnerContext | null>;
  /**
   * The Client's learnings, newest first by server-recorded time (bounded,
   * server-chosen limit — the append-only ledger grows without end).
   * Client ownership is resolved canonically first; unknown or deleted
   * Client → NotFoundError.
   */
  listLearningsForClient(clientId: string): Promise<readonly LearningRecord[]>;
  /**
   * Records ONE contradiction / supersession / retirement relationship
   * (LEARN-AC-02): a NEW append-only row, never a mutation of any
   * existing record. `provenance` is SERVER-DERIVED.
   *
   * Fail-closed invariants: the TARGET learning (from) must exist and its
   * client chain must resolve (uniform NotFoundError otherwise — a
   * foreign learning identifier is indistinguishable from an unknown
   * one); the LATER learning (to) must exist and belong to the SAME
   * Client (uniform NotFoundError); the target must not be terminal —
   * already superseded or retired targets are rejected (ConflictError;
   * the DB terminal-target trigger is the race backstop); a second
   * supersession or retirement of the same target is rejected
   * (ConflictError — the DB fences are the race backstop). A CONTRADICTED
   * target stays legal: later evidence may contradict it again, and it
   * may still be superseded or retired afterwards.
   */
  recordLearningRelationship(
    fromLearningId: string,
    input: LearningRelationshipInput,
    provenance: LearningProvenance,
  ): Promise<LearningRelationshipRecord>;
  /**
   * The FULL relationship chain around one learning, oldest first: every
   * relationship recorded AGAINST it (contradictions, supersessions,
   * retirement) and every relationship IT recorded against earlier
   * learnings — the complete history-preserving state trail (LEARN-AC-02).
   */
  listLearningRelationships(
    learningId: string,
  ): Promise<readonly LearningRelationshipRecord[]>;
}

export interface LearningsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix: /learnings ──→ /evidence, /experiments, /goals — the
   * two merged authorities this Work Item consumes (supporting-reference
   * validation + the shared §21 material-key backstop from /evidence;
   * outcome-reference validation from /experiments). /goals stays an
   * unused allowed direction.
   */
  readonly evidence: EvidenceModuleApi;
  readonly experiments: ExperimentsModuleApi;
  /**
   * Canonical Client ownership resolution THROUGH the /clients public
   * contract (structural port — see the module header note; the concrete
   * ClientsModuleApi instance is wired at the composition root).
   */
  readonly clients: ClientOwnershipResolutionPort;
  /**
   * Canonical Workspace ownership resolution THROUGH the /workspaces
   * public contract (structural port; wired at the composition root).
   */
  readonly workspaces: WorkspaceOwnershipResolutionPort;
}

export { createLearningModule } from './internal/learnings-module.ts';
/**
 * The pure guards — Learning append validation (statement, applicability
 * conditions, reference shapes, confidence), relationship-input validation
 * (closed kind taxonomy, to-learning presence rules) and provenance
 * validation — exported for unit tests and future server-side emitters so
 * the guard semantics are part of the module contract. Pure functions.
 */
export {
  assertValidLearningCreate,
  assertValidLearningProvenance,
  assertValidLearningRelationshipInput,
  classifyLearningWriteConflict,
} from './internal/learnings-store.ts';
