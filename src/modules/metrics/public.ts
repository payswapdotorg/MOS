/**
 * MarketingOS module: /metrics
 * Authority: Metrics (spec/implementation-contract.md §1).
 *
 * MKT-014 implements this authority (METRIC-001; the INT-001 dependency is
 * POSTURE-only: provider data ARRIVES here as already-normalized,
 * source-tagged observation payloads — /metrics owns NO provider state: no
 * provider sessions, no provider cursors, no provider SDK imports; the
 * concrete provider adapters are MKT-023/024 behind /integrations). This
 * module owns:
 *
 *   - METRIC OBSERVATION normalization: every appended observation records
 *     the SOURCE SYSTEM (provider label or 'internal'), the metric
 *     identity (name + dimension key set), the value WITH its unit, the
 *     OBSERVATION timestamp observedAt (when the metric was true) kept
 *     DISTINCT from the RETRIEVAL timestamp retrievedAt (when the platform
 *     saw it), and a reference to the source record (sourceRef: provider
 *     report id; evidenceRef: an /evidence record id for internal
 *     observations) — the METRIC-001 "source/timestamp/reference mapping";
 *   - the DATA-QUALITY POSTURE taxonomy: a closed, interpretable 5-value
 *     set (ok, partial, estimated, restated, suspect) plus the optional
 *     declared aggregation method (implementation-contract §15
 *     "aggregation method; data-quality status"). Extension is a code + DB
 *     migration change, never a caller freedom;
 *   - PROVENANCE as a SERVER-DERIVED dimension, structurally separate from
 *     everything a caller can supply (the MKT-013 pattern): the module API
 *     takes provenance as its own argument type that no request DTO feeds
 *     (route validation rejects provenance-shaped authority fields AND the
 *     retrieval timestamp — retrievedAt is stamped by the module clock for
 *     HTTP appends; server-side integration emitters may pass the true
 *     retrieval moment through the module API only);
 *   - APPEND-ORIENTED history: rows are immutable after write (DB triggers
 *     reject UPDATE/DELETE — the migration 015 pattern). Corrections are
 *     NEW rows (a restated observation is a fresh append with the same
 *     metric identity); there is deliberately no supersession graph here —
 *     the measurement authority records observations as-is, interpretation
 *     belongs to later analysis (MKT-015+);
 *   - CLIENT OWNERSHIP: every observation is owned by exactly one Client,
 *     resolved canonically THROUGH the /clients public contract BEFORE any
 *     write (the goals/evidence pattern); the optional Workspace scope is
 *     resolved THROUGH the /workspaces public contract and must live inside
 *     the owning Client;
 *   - optional EVIDENCE LINKAGE: an observation may reference an /evidence
 *     record id (evidenceRef) — same Client enforced by the module guard
 *     AND the metric_evidence_ref_same_client DB trigger (cross-tenant
 *     rejection; /evidence stays the single evidence/provenance authority —
 *     this module never stores evidence content).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-014):
 *   - NO provider adapters/cursors/credentials (MKT-023/024 behind
 *     /integrations per INT-001) — provider data ARRIVES normalized;
 *   - no experiment structures (MKT-015), no Learnings (MKT-016), no
 *     analysis/attribution/prediction (scientific separation,
 *     architecture.md §2.6: "Observation, prediction, attribution,
 *     association, and causal inference are distinct");
 *   - no /reporting read side (architecture.md §6: "/reporting is read-side
 *     only" — it will CONSUME this module's public contract later);
 *   - no mutation of workflow/execution state (frozen matrix forbidden
 *     direction) and no second tenant/permission/audit authority.
 *
 * DEPENDENCY POSTURE (frozen matrix: /metrics ──→ /evidence, /integrations):
 * this public entry imports /evidence's public contract directly (the only
 * currently-merged allowed dependency — /integrations arrives with
 * MKT-023/024). The REQUIRED canonical Client/Workspace ownership
 * resolution (METRIC-001 acceptance: "resolve through /clients + optional
 * /workspaces public contracts — never caller-supplied") is expressed as
 * STRUCTURAL PORTS declared below: narrow typed views of the /clients and
 * /workspaces public contracts' canonical ownership resolution methods.
 * The concrete /clients and /workspaces public-contract instances satisfy
 * these ports structurally and are wired at the composition root — the
 * resolution still executes server-side, inside this module, THROUGH those
 * public contracts (identical behavior to /evidence's ownership chain),
 * while the frozen import matrix stays intact (no /clients//workspaces
 * import exists inside src/modules/metrics — verified by tools/arch-check
 * and tests/architecture/metrics-boundary.test.ts).
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
// Data-quality posture taxonomy (implementation-contract §15)
// ---------------------------------------------------------------------------

/**
 * The frozen metric data-quality statuses. Ordered from healthiest to
 * least-trusted; interpretable (every status has a frozen meaning) and
 * traceable (the status is stored on the immutable record). A separate
 * dimension from provenance: it describes the DATA, not who recorded it.
 */
export type MetricQualityStatus = 'ok' | 'partial' | 'estimated' | 'restated' | 'suspect';

export const METRIC_QUALITY_STATUSES: readonly MetricQualityStatus[] = [
  'ok',
  'partial',
  'estimated',
  'restated',
  'suspect',
];

/** Interpretable meaning of every status (traceability requirement). */
export const METRIC_QUALITY_MEANINGS: Readonly<Record<MetricQualityStatus, string>> = {
  ok: 'complete measurement, trustworthy as retrieved',
  partial: 'incomplete coverage or missing dimensions, acknowledged',
  estimated: 'provider/model estimate rather than a direct count',
  restated: 'corrected value superseding an earlier source report (a NEW row — history is kept)',
  suspect: 'known data-quality issue; value retained as append-only history',
};

export function isKnownMetricQuality(value: string): value is MetricQualityStatus {
  return (METRIC_QUALITY_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Provenance (server-derived) — the dimension callers can never supply
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of one metric observation (the MKT-013
 * evidence pattern). Built exclusively by server code from the
 * authenticated principal, the ambient correlation context and the
 * recording system — never from a request body (route validation rejects
 * provenance-shaped authority fields; this type is a separate module-API
 * argument so no DTO can feed it structurally). `recordedAt` is stamped by
 * the module's clock at append time.
 */
export interface MetricProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording system label: 'api' today; later server-side emitters ('integration:<provider>', 'worker:<label>'). */
  readonly recordedVia: string;
  /** Correlation identity of the logical flow that appended the observation. */
  readonly correlationId: string;
  /** Causation identity (e.g. the job id) when the append was worker-caused. */
  readonly causationId: string | null;
}

/** Provenance block as persisted on the immutable record. */
export interface MetricRecordedProvenance extends MetricProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Record + input shapes (implementation-contract §15)
// ---------------------------------------------------------------------------

/**
 * Declared SOURCE of the observation — where the measured value came FROM
 * ('meta-ads', 'google-ads', 'internal', ...). Content dimension, not
 * provenance: provenance records WHO recorded it and HOW it entered MOS
 * (actor/recordedVia/correlation/recordedAt); the source descriptor records
 * WHERE the measurement itself originated.
 */
export interface MetricSource {
  readonly system: string;
  /** Opaque external source reference (provider report id, export batch...). */
  readonly ref: string | null;
}

/** Dimension values are scalars: the dimension SET identifies the series. */
export type MetricDimensionValue = string | number | boolean;

/** One immutable, append-only normalized metric observation. */
export interface MetricObservationRecord {
  readonly observationId: string;
  readonly clientId: string;
  /** Optional Workspace scope INSIDE the owning Client (null = client-wide). */
  readonly workspaceId: string | null;
  /** Metric identity: the name of the measured series. */
  readonly metricName: string;
  /** Metric identity: the dimension key → scalar set ('{}' = a dimensionless total). */
  readonly dimensions: Readonly<Record<string, MetricDimensionValue>>;
  /** The measured value. */
  readonly value: number;
  /** The value's declared unit (e.g. 'USD', 'count', 'ratio'). */
  readonly unit: string;
  readonly source: MetricSource;
  /** OBSERVATION timestamp — when the metric was true. */
  readonly observedAt: string;
  /** RETRIEVAL timestamp — when the platform saw it (distinct from observedAt). */
  readonly retrievedAt: string;
  /** Optional /evidence record reference backing an internal observation (same Client, DB-fenced). */
  readonly evidenceRef: string | null;
  /** Data-quality posture (closed 5-value set). */
  readonly quality: MetricQualityStatus;
  /** Optional declared aggregation method (e.g. 'sum', '7d_window'). */
  readonly aggregationMethod: string | null;
  readonly provenance: MetricRecordedProvenance;
}

/** Module input for appending one metric observation. */
export interface MetricObservationAppendInput {
  readonly clientId: string;
  /** Optional Workspace scope; resolved canonically, must be inside the Client. */
  readonly workspaceId: string | null;
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, MetricDimensionValue>>;
  readonly value: number;
  readonly unit: string;
  readonly source: MetricSource;
  /**
   * OBSERVATION timestamp (when the metric was true) — the caller-declared
   * source mapping half of the METRIC-001 timestamp pair.
   */
  readonly observedAt: string;
  /**
   * RETRIEVAL timestamp (when the platform saw it) — the server-derived
   * half. Null (the HTTP path — the route DTO REJECTS retrievedAt) lets the
   * module stamp its clock at append; a server-side caller (a future
   * /integrations emitter, MKT-023/024) may pass the true retrieval moment
   * through the module API. Never a request-body value.
   */
  readonly retrievedAt: string | null;
  /**
   * Optional /evidence record this observation is derived from (internal
   * observations). Same Client only — uniform NotFoundError otherwise; the
   * DB trigger is the race backstop.
   */
  readonly evidenceRef: string | null;
  readonly quality: MetricQualityStatus;
  readonly aggregationMethod: string | null;
}

// ---------------------------------------------------------------------------
// Canonical ownership ports (frozen-matrix-compliant /clients + /workspaces
// resolution — see the module header note)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /clients CANONICAL OWNER CONTEXT (the
 * public-contract shape /metrics consumes): the resolved Client's identity,
 * its owning Agency and its status. The real ClientOwnerContext satisfies
 * this structurally — /clients remains the ONLY Client ownership authority.
 */
export interface MetricsClientOwnershipSnapshot {
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
 * The slice of the /clients public contract /metrics depends on: canonical
 * server-side Client ownership resolution from durable state. Satisfied
 * structurally by ClientsModuleApi; wired at the composition root.
 */
export interface ClientOwnershipResolutionPort {
  resolveClientOwnership(clientId: string): Promise<MetricsClientOwnershipSnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /workspaces canonical ownership resolution:
 * the resolved Workspace row's identity, owning Client and status. The real
 * WorkspaceOwnerContext satisfies this structurally — /workspaces remains
 * the ONLY Workspace authority.
 */
export interface MetricsWorkspaceOwnershipSnapshot {
  readonly workspace: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /workspaces public contract /metrics depends on: canonical
 * server-side Workspace ownership resolution. Satisfied structurally by
 * WorkspacesModuleApi; wired at the composition root.
 */
export interface WorkspaceOwnershipResolutionPort {
  resolveWorkspaceOwnership(workspaceId: string): Promise<MetricsWorkspaceOwnershipSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL METRIC OBSERVATION OWNER CONTEXT: the single server-side
 * resolution of WHICH Client owns the observation (and which Agency owns
 * that Client), plus the scoped Workspace ownership snapshot when
 * workspace-scoped — all derived from durable state on every call.
 * Metrics-scoped operations authorize against this context — never against
 * caller-supplied tenant or observation identity. `scope` mirrors the
 * pipeline OwnerScope shapes.
 *
 * The Client is the hard security boundary: a tombstoned (deleted) Client
 * never resolves (null — uniform 404 upstream). A tombstoned (deleted)
 * Workspace also resolves null here — the observation row itself stays
 * readable (immutable measurement history is never erased); authorization
 * depends only on the client/agency chain.
 */
export interface MetricOwnerContext {
  readonly scope: {
    readonly kind: 'metric';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly observationId: string;
  };
  readonly observation: MetricObservationRecord;
  /** The /clients canonical ownership snapshot this observation resolves through. */
  readonly clientOwnership: MetricsClientOwnershipSnapshot;
  /** The /workspaces ownership snapshot when workspace-scoped and still resolvable (null otherwise). */
  readonly workspace: MetricsWorkspaceOwnershipSnapshot | null;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical metric-observation owner context from
 * an ALREADY-RESOLVED /clients canonical ownership snapshot, the observation
 * record and (for workspace-scoped records) the /workspaces ownership
 * snapshot. Purity is asserted by unit tests — the same inputs always
 * compose the same context; a caller-supplied agency id appears nowhere in
 * the composition inputs.
 */
export function composeMetricOwnerContext(
  observation: MetricObservationRecord,
  clientOwnership: MetricsClientOwnershipSnapshot,
  workspace: MetricsWorkspaceOwnershipSnapshot | null,
  resolvedAt: string,
): MetricOwnerContext {
  return {
    scope: {
      kind: 'metric',
      agencyId: clientOwnership.scope.agencyId,
      clientId: observation.clientId,
      workspaceId: observation.workspaceId,
      observationId: observation.observationId,
    },
    observation,
    clientOwnership,
    workspace,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface MetricsModuleApi {
  /**
   * Appends one immutable metric observation (a normalization event: the
   * source-tagged payload becomes the append-only normalized record).
   * `provenance` is SERVER-DERIVED and is the only source of
   * actor/system/correlation/recordedAt on the row; `retrievedAt` is stamped
   * from the module clock unless a server-side caller supplied it.
   *
   * Client ownership is resolved canonically THROUGH the /clients public
   * contract BEFORE any write: unknown or tombstoned Client →
   * NotFoundError; disabled Client → ConflictError (new use blocked without
   * rewriting history). A supplied workspaceId is resolved THROUGH the
   * /workspaces public contract: unknown, tombstoned or belonging to a
   * DIFFERENT Client → NotFoundError (uniform — a foreign workspace
   * identifier is not a traversal/existence oracle); disabled Workspace →
   * ConflictError.
   *
   * Optional evidence linkage (fail closed): a supplied evidenceRef must
   * resolve to an /evidence record of the SAME Client (NotFoundError
   * otherwise — uniform across tenants, so a foreign evidence id is
   * indistinguishable from an unknown one; the DB trigger is the race
   * backstop).
   *
   * No provider state is read, held or mutated anywhere on this path.
   */
  appendMetricObservation(
    input: MetricObservationAppendInput,
    provenance: MetricProvenance,
  ): Promise<MetricObservationRecord>;
  /** Raw record by id — immutable history is always readable. */
  getMetricObservation(observationId: string): Promise<MetricObservationRecord | null>;
  /**
   * Canonical ownership resolution: the observation, its owning Client
   * resolved through the /clients public contract, and its scoped Workspace
   * ownership snapshot, composed into the canonical owner context. Null
   * when the observation does not exist OR its Client is a deleted
   * tombstone — callers surface a uniform 404 so foreign, unknown and
   * orphaned identifiers are indistinguishable (hard-boundary posture).
   */
  resolveMetricObservationOwnership(observationId: string): Promise<MetricOwnerContext | null>;
  /**
   * The Client's observations, newest first by server-recorded time
   * (bounded, server-chosen limit — the append-only ledger grows without
   * end). Client ownership is resolved canonically first; unknown or
   * deleted Client → NotFoundError.
   */
  listMetricObservationsForClient(clientId: string): Promise<readonly MetricObservationRecord[]>;
}

export interface MetricsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix: /metrics ──→ /evidence, /integrations — /evidence is the
   * merged authority this Work Item consumes (evidenceRef validation).
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

export { createMetricsModule } from './internal/metrics-module.ts';
/**
 * The append guard (identity/value/unit/source/timestamp/quality/
 * provenance-input validation + §21 secret-leak backstop on dimension keys)
 * — exported for unit tests and future server-side emitters so the guard
 * semantics are part of the module contract. Pure functions.
 */
export {
  assertValidMetricObservationAppend,
  assertValidMetricProvenance,
  classifyMetricInsertConflict,
} from './internal/metrics-store.ts';
