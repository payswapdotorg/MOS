/**
 * MarketingOS module: /evidence
 * Authority: Evidence/provenance (spec/implementation-contract.md §1).
 *
 * MKT-013 implements this authority (EVID-001, EVID-AC-01..03). Evidence is
 * the append-oriented, server-owned record of source facts, observations
 * and claims, with provenance and quality as separate dimensions
 * (spec/architecture.md §15; spec/evidence-and-experimentation.md). This
 * module owns:
 *
 *   - the EVIDENCE CLASS taxonomy (8 frozen classes: source_fact,
 *     observation, inference, hypothesis, attribution, prediction,
 *     causal_estimate, learning) and its two authority TIERS: the
 *     AUTHORITATIVE tier (source_fact/observation — directly observed /
 *     normalized from a source) and the CLAIM tier (the other six — model
 *     or human claims). Claims are NEVER auto-promoted to authoritative
 *     classes: supersession preserves the tier (module guard + DB trigger,
 *     EVID-AC-03), there is NO update path at all (records are immutable),
 *     and no promotion operation exists in this module's surface — a
 *     future explicit, authorized promotion path would be its own Work
 *     Item with its own audited route;
 *   - the QUALITY taxonomy A..F: ordered but non-absolute, interpretable
 *     (frozen meaning per grade) and traceable (the grade is stored on the
 *     immutable record). The grade is caller-DECLARED but validated
 *     against the closed set — extension is a code+DB migration change,
 *     never a caller freedom;
 *   - PROVENANCE as a SERVER-DERIVED dimension, structurally separate from
 *     everything a caller can supply: the module API takes provenance as
 *     its own argument type that no request DTO feeds (route validation
 *     rejects provenance-shaped authority fields). Provenance is separate
 *     from the caller-declared `confidence` score — confidence is claim
 *     metadata and can never touch provenance, class or tier
 *     (spec/evidence-and-experimentation.md "Provenance is a separate
 *     dimension from confidence");
 *   - APPEND-ORIENTED history: rows are immutable after write (DB triggers
 *     reject UPDATE/DELETE — the audit_events backstop pattern);
 *     corrections/supersession create NEW records that reference the prior
 *     record, fenced to exactly ONE superseding record per prior record;
 *   - CLIENT OWNERSHIP: every evidence record is owned by exactly one
 *     Client, resolved canonically THROUGH /clients before any write (the
 *     goals pattern); the optional Workspace scope is resolved THROUGH
 *     /workspaces and must live inside the owning Client;
 *   - the §21 secret-leak backstop: material-shaped keys can never appear
 *     in evidence content at any nesting level (implementation-contract
 *     §21: secrets may never appear in evidence payloads).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-013):
 *   - no metric normalization (MKT-014), no experiment structures
 *     (MKT-015), no Learning records (MKT-016), no AI runtime;
 *   - no execution linkage FK: architecture.md §11 places evidence
 *     references ON the Execution side; /evidence records provenance only
 *     (actor/system/correlation/timestamps) and content references;
 *   - no mutation of workflow/execution state (frozen matrix forbidden
 *     direction) and no second tenant/permission/audit authority.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /evidence ──→ /clients, /workspaces, /executions
 * (this Work Item uses the /clients + /workspaces subset).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type {
  ClientOwnerContext,
  ClientRecord,
  ClientsModuleApi,
} from '../clients/public.ts';
import type { WorkspaceRecord, WorkspacesModuleApi } from '../workspaces/public.ts';

// ---------------------------------------------------------------------------
// Evidence classes and authority tiers (spec/evidence-and-experimentation.md)
// ---------------------------------------------------------------------------

/**
 * The 8 frozen evidence classes:
 *   source_fact    — directly observed from an authoritative source;
 *   observation    — normalized measurement/event from a source;
 *   inference      — interpretation supported by observed evidence;
 *   hypothesis     — statement to be tested;
 *   attribution    — assignment of credit under a declared attribution method;
 *   prediction     — forecast/model output;
 *   causal_estimate— estimated effect under an appropriate design;
 *   learning       — durable conclusion with explicit applicability conditions.
 */
export type EvidenceClass =
  | 'source_fact'
  | 'observation'
  | 'inference'
  | 'hypothesis'
  | 'attribution'
  | 'prediction'
  | 'causal_estimate'
  | 'learning';

export const EVIDENCE_CLASSES: readonly EvidenceClass[] = [
  'source_fact',
  'observation',
  'inference',
  'hypothesis',
  'attribution',
  'prediction',
  'causal_estimate',
  'learning',
];

/** The two AUTHORITATIVE classes — direct observations from a source. */
export const AUTHORITATIVE_EVIDENCE_CLASSES: readonly EvidenceClass[] = [
  'source_fact',
  'observation',
];

/** The six CLAIM classes — model or human claims (EVID-AC-03). */
export const CLAIM_EVIDENCE_CLASSES: readonly EvidenceClass[] = [
  'inference',
  'hypothesis',
  'attribution',
  'prediction',
  'causal_estimate',
  'learning',
];

/** Authority tier of an evidence class (EVID-AC-03 promotion boundary). */
export type EvidenceClassTier = 'authoritative' | 'claim';

export function isKnownEvidenceClass(value: string): value is EvidenceClass {
  return (EVIDENCE_CLASSES as readonly string[]).includes(value);
}

export function isAuthoritativeEvidenceClass(value: EvidenceClass): boolean {
  return (AUTHORITATIVE_EVIDENCE_CLASSES as readonly string[]).includes(value);
}

export function evidenceClassTier(value: EvidenceClass): EvidenceClassTier {
  return isAuthoritativeEvidenceClass(value) ? 'authoritative' : 'claim';
}

// ---------------------------------------------------------------------------
// Evidence quality taxonomy (spec/evidence-and-experimentation.md)
// ---------------------------------------------------------------------------

/**
 * The frozen A..F quality grades. Ordered but non-absolute; extensible only
 * through a code + DB-migration change (never a caller freedom) so quality
 * stays interpretable and traceable on every record.
 */
export type EvidenceQualityGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export const EVIDENCE_QUALITY_GRADES: readonly EvidenceQualityGrade[] = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
];

/** Interpretable meaning of every grade (traceability requirement). */
export const EVIDENCE_QUALITY_MEANINGS: Readonly<Record<EvidenceQualityGrade, string>> = {
  A: 'randomized experiment / strong controlled design',
  B: 'strong quasi-experimental design',
  C: 'defensible observational/time-series analysis',
  D: 'descriptive/attribution evidence',
  E: 'model inference or weak external signal',
  F: 'hypothesis with insufficient evidence',
};

export function isKnownEvidenceQuality(value: string): value is EvidenceQualityGrade {
  return (EVIDENCE_QUALITY_GRADES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Provenance (server-derived) — the dimension callers can never supply
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of one evidence record. Built exclusively by
 * server code from the authenticated principal, the ambient correlation
 * context and the recording system — never from a request body (route
 * validation rejects provenance-shaped authority fields; this type is a
 * separate module-API argument so no DTO can feed it structurally).
 * `recordedAt` is stamped by the module's clock at append time.
 */
export interface EvidenceProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording system label: 'api' today; later server-side emitters ('integration:<provider>', 'metrics', 'field-agent'). */
  readonly recordedVia: string;
  /** Correlation identity of the logical flow that appended the record. */
  readonly correlationId: string;
  /** Causation identity (e.g. the job id) when the append was worker-caused. */
  readonly causationId: string | null;
}

/** Provenance block as persisted on the immutable record. */
export interface EvidenceRecordedProvenance extends EvidenceProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Record + input shapes
// ---------------------------------------------------------------------------

/**
 * Declared SOURCE of the evidence — where the content came FROM (e.g.
 * 'meta-ads', 'internal', 'field-agent', 'human'). Content dimension, not
 * provenance: provenance records WHO recorded it and HOW it entered MOS
 * (actor/recordedVia/correlation/recordedAt); the source descriptor records
 * WHERE the evidence itself originated.
 */
export interface EvidenceSource {
  readonly system: string;
  /** Opaque external source reference (provider report id, export batch...). */
  readonly ref: string | null;
}

/** One immutable, append-only evidence record. */
export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly clientId: string;
  /** Optional Workspace scope INSIDE the owning Client (null = client-wide). */
  readonly workspaceId: string | null;
  readonly class: EvidenceClass;
  readonly source: EvidenceSource;
  /** The evidence's own timestamp (when it was observed/produced). */
  readonly observedAt: string;
  /** Traceable content payload (non-empty JSON object). */
  readonly content: Readonly<Record<string, unknown>>;
  /** Opaque reference to a durable artifact (object-store address etc.). */
  readonly contentRef: string | null;
  readonly quality: EvidenceQualityGrade;
  /** Optional caller-declared confidence 0..1 — SEPARATE from provenance; never promotes anything. */
  readonly confidence: number | null;
  /** The prior record this record replaces (null for a fresh record). */
  readonly supersedes: string | null;
  /** The record that replaced this one (null while this record is current). */
  readonly supersededBy: string | null;
  readonly provenance: EvidenceRecordedProvenance;
}

/** Module input for appending one evidence record (or supersession). */
export interface EvidenceAppendInput {
  readonly clientId: string;
  /** Optional Workspace scope; resolved canonically, must be inside the Client. */
  readonly workspaceId: string | null;
  readonly class: EvidenceClass;
  readonly source: EvidenceSource;
  readonly observedAt: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentRef: string | null;
  readonly quality: EvidenceQualityGrade;
  readonly confidence: number | null;
  /**
   * Prior evidence record this append REPLACES (explicit supersession).
   * Same Client only; same authority TIER only (EVID-AC-03 — a claim can
   * never be superseded into an authoritative class); at most ONE
   * superseding record per prior record (DB-fenced).
   */
  readonly supersedesEvidenceId: string | null;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL EVIDENCE OWNER CONTEXT: the single server-side resolution
 * of WHICH Client owns the evidence record (and which Agency owns that
 * Client), plus the scoped Workspace row when workspace-scoped — all
 * derived from durable state on every call. Evidence-scoped operations
 * authorize against this context — never against caller-supplied tenant or
 * evidence identity. `scope` mirrors the pipeline OwnerScope evidence
 * variant.
 *
 * The Client is the hard security boundary: a tombstoned (deleted) Client
 * never resolves (null — uniform 404 upstream). The workspace row is
 * exposed as-is (deleting an organizational boundary never erases
 * Client-owned immutable evidence history).
 */
export interface EvidenceOwnerContext {
  readonly scope: {
    readonly kind: 'evidence';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly evidenceId: string;
  };
  readonly evidence: EvidenceRecord;
  readonly client: ClientRecord;
  /** The /clients canonical owner context this evidence resolves through. */
  readonly clientOwnership: ClientOwnerContext;
  /** The Workspace row when workspace-scoped (tombstones included). */
  readonly workspace: WorkspaceRecord | null;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical Evidence owner context from an
 * ALREADY-RESOLVED /clients canonical owner context, the evidence record
 * and (for workspace-scoped records) the workspace row. Purity is asserted
 * by unit tests — the same inputs always compose the same context.
 */
export function composeEvidenceOwnerContext(
  evidence: EvidenceRecord,
  clientOwnership: ClientOwnerContext,
  workspace: WorkspaceRecord | null,
  resolvedAt: string,
): EvidenceOwnerContext {
  return {
    scope: {
      kind: 'evidence',
      agencyId: clientOwnership.scope.agencyId,
      clientId: evidence.clientId,
      workspaceId: evidence.workspaceId,
      evidenceId: evidence.evidenceId,
    },
    evidence,
    client: clientOwnership.client,
    clientOwnership,
    workspace,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface EvidenceModuleApi {
  /**
   * Appends one immutable evidence record (or, when
   * `supersedesEvidenceId` is set, the explicit superseding record that
   * replaces a prior record). `provenance` is SERVER-DERIVED and is the
   * only source of actor/system/correlation/recordedAt on the row.
   *
   * Client ownership is resolved canonically THROUGH /clients before any
   * write: unknown or tombstoned Client → NotFoundError; disabled Client →
   * ConflictError (new use blocked without rewriting history). A supplied
   * workspaceId is resolved THROUGH /workspaces: unknown, tombstoned or
   * belonging to a DIFFERENT Client → NotFoundError (uniform — a foreign
   * workspace identifier is not a traversal/existence oracle); disabled
   * Workspace → ConflictError.
   *
   * Supersession invariants (fail closed): prior record must exist
   * (NotFoundError, uniform across tenants — a foreign evidence id is
   * indistinguishable from an unknown one); prior must belong to the SAME
   * Client (NotFoundError); the prior record must not already be
   * superseded (ConflictError — the DB fence is the race backstop); the
   * superseding record's class TIER must equal the prior's (a CLAIM can
   * never be superseded into an AUTHORITATIVE class — EVID-AC-03 — and an
   * authoritative record cannot be replaced by a claim either).
   *
   * Content is guarded: non-empty JSON object; material-shaped keys are
   * rejected at every nesting level (§21 — secrets never appear in
   * evidence payloads); attribution and causal_estimate classes must
   * declare their method (content.method — the frozen scientific
   * separation).
   */
  appendEvidence(
    input: EvidenceAppendInput,
    provenance: EvidenceProvenance,
  ): Promise<EvidenceRecord>;
  /**
   * Raw record by id (superseded records included — immutable history is
   * always readable), with `supersededBy` resolved server-side.
   */
  getEvidence(evidenceId: string): Promise<EvidenceRecord | null>;
  /**
   * Canonical ownership resolution: the evidence record, its owning Client
   * resolved through /clients resolveClientOwnership, and its scoped
   * Workspace row, composed into the canonical owner context. Null when
   * the record does not exist OR its Client is a deleted tombstone —
   * callers surface a uniform 404 so foreign, unknown and orphaned
   * identifiers are indistinguishable (hard-boundary posture).
   */
  resolveEvidenceOwnership(evidenceId: string): Promise<EvidenceOwnerContext | null>;
  /**
   * The Client's evidence records, newest first by server-recorded time
   * (bounded, server-chosen limit — the append-only ledger grows without
   * end). Client ownership is resolved canonically first; unknown or
   * deleted Client → NotFoundError.
   */
  listEvidenceForClient(clientId: string): Promise<readonly EvidenceRecord[]>;
}

export interface EvidenceModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix: /evidence ──→ /clients, /workspaces, /executions (this Work Item: /clients + /workspaces). */
  readonly clients: ClientsModuleApi;
  readonly workspaces: WorkspacesModuleApi;
}

export { createEvidenceModule } from './internal/evidence-module.ts';
/**
 * The append guard (class/quality/content/provenance-input validation +
 * §21 secret-leak backstop + supersession tier rules) — exported for unit
 * tests and future server-side emitters so the guard semantics are part of
 * the module contract. Pure functions.
 */
export {
  assertValidEvidenceAppend,
  assertValidEvidenceProvenance,
  containsMaterialKey,
} from './internal/evidence-store.ts';
