/**
 * MarketingOS module: /app-metering
 * Authority: App metering and commercial attribution (MKT-052 —
 * spec/effective-backlog-v1.5.md; spec/mos-app-ecosystem-v1.5.md
 * "Economics": "MOS may meter installations, invocation count,
 * compute/runtime, data volume and premium capabilities. Marketplace
 * attribution is separate from the core financial authority.";
 * spec/architecture-v1.5.md §9 + §13/§14; spec/architecture-lock-v1.5.md
 * #13 — Apps remain participants and cannot become alternate authorities).
 *
 * This module owns:
 *
 *   - the APPEND-ONLY METER EVENT TAIL (migration 044): one immutable row
 *     per metered usage observation over the REAL events — installation
 *     selections consumed from the MKT-048 install ledger through its
 *     PUBLIC CONTRACT, invocations consumed from the MKT-022 extension
 *     invocation ledger (the surface mos-app-ecosystem-v1.5.md "Install
 *     and invoke" names: "Invocation uses the existing short-lived
 *     Extension invocation context") through the /extensions PUBLIC
 *     CONTRACT, and runtime-host usage observations ingested through this
 *     module's recording command with validated canonical source
 *     references. Collection is EVENT CONSUMPTION over public contracts
 *     (pull, idempotent, at-most-once per source) — this module NEVER
 *     writes into another module's tables (the migration 044 tables are
 *     the only write surface: app_metering_events + the rebuildable
 *     app_metering_rollups projection);
 *   - the FROZEN METERING VOCABULARY (am-meter-v1): the spec's five
 *     dimensions with explicit per-dimension units — installations
 *     (selections), invocations (invocations), compute-runtime
 *     (milliseconds), data-volume (bytes), premium-capabilities
 *     (capability-uses) — versioned, never silently re-stated (the
 *     pi-calc-v1 discipline; the storage mirror is the migration-044
 *     CHECK-fenced dimension/unit pair);
 *   - the DERIVED ATTRIBUTION READ MODELS (am-attrib-v1): marketplace
 *     attribution aggregates (per app / per publisher / per workspace /
 *     per period) derived LIVE over the module's own append-only tail
 *     with source references, the frozen calculation version and the
 *     DISCLOSED aggregation assumption set — the /profit-intelligence
 *     derived-read-model precedent. DERIVED, NOT FINANCIAL AUTHORITY
 *     (the Economics rule + architecture-lock v1.5 #6's posture): the
 *     module exposes ZERO billing/charging mutation methods — no
 *     invoices, no payments, no balance mutations, no prices, no rates
 *     anywhere; marketplace attribution stays SEPARATE from the core
 *     financial authority (proven by the static boundary test);
 *   - the RECOMPUTABLE ROLLUP PROJECTION (migration 044): the derived
 *     (workspace, app, dimension, month) aggregates materialized from
 *     the tail, REBUILDABLE from it through the disclosed recompute path
 *     (the module-level operation — the operating-graph rebuild
 *     precedent: background workers and later v1.5 Work Items).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-052):
 *   - NO billing, charging, invoicing, payment, balance or pricing
 *     surface of ANY kind (the Economics rule: monetization is the core
 *     financial authority's, a future separately-governed surface — meter
 *     records carry quantities, never money);
 *   - NO app catalog, install, upgrade/rollback, trust, review or
 *     invocation mutation (the /apps, /app-installs, /app-marketplace,
 *     /extensions authorities — all consumed READ-ONLY through their
 *     public contracts);
 *   - NO HTTP mutation surface: the route layer registers EXACTLY three
 *     GET attribution views (workspace/agency/publisher scoped, GET-only
 *     read models); the collection, ingestion and recompute commands are
 *     MODULE-LEVEL operations for server-side callers (the
 *     operating-graph rebuild precedent);
 *   - NO second tenant, permission, identity, workflow or execution
 *     authority: the workspace/client/agency scope chain resolves through
 *     the /workspaces canonical ownership resolution, and attribution-read
 *     authorization stays the /agencies membership + platform-role
 *     authorities at the route layer.
 *
 * DEPENDENCY POSTURE (the disclosed MKT-052 registration row of
 * spec/module-dependency-matrix.md: /app-metering ──→ /apps,
 * /app-installs, /extensions, /workspaces): this public entry imports the
 * /apps, /app-installs and /extensions public contracts DIRECTLY (the
 * matrix-listed composition directions) and declares a STRUCTURAL PORT
 * for the /workspaces canonical ownership resolution (the narrow
 * public-contract view wired at the composition root — the /app-installs
 * /deployments posture; zero imports of any module's internals anywhere
 * under src/modules/app-metering, verified by tools/arch-check and
 * tests/architecture/app-metering-boundary.test.ts).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import {
  APP_METERING_DIMENSIONS,
  type AppMeteringDimension,
  appVersionInRange,
  type AppsModuleApi,
} from '../apps/public.ts';
import type { AppInstallsModuleApi } from '../app-installs/public.ts';
import type { ExtensionsModuleApi } from '../extensions/public.ts';

// ---------------------------------------------------------------------------
// The frozen metering vocabulary (am-meter-v1 — AC-2: the spec's five
// dimensions, each with an EXPLICIT unit; versioned, never silently
// re-stated — the pi-calc-v1 discipline)
// ---------------------------------------------------------------------------

/**
 * The closed five-dimension metering vocabulary of mos-app-ecosystem-v1.5.md
 * "Economics", verbatim: "MOS may meter installations, invocation count,
 * compute/runtime, data volume and premium capabilities." Re-exported from
 * the /apps public contract (the SAME closed set the MKT-047 registry
 * CHECK-fences on manifest meteringDimensions declarations) — one frozen
 * set, one owner.
 */
export type { AppMeteringDimension };
export { APP_METERING_DIMENSIONS };

/**
 * The METERING VOCABULARY VERSION: the frozen dimension/unit pairs below
 * plus their semantics. Same tail + this version ⇒ byte-identical meter
 * aggregates (the pinning proof). A change to ANY dimension, ANY unit or
 * ANY semantics is a NEW version string — the vocabulary is versioned,
 * never silently re-stated.
 */
export const APP_METERING_VOCABULARY_VERSION = 'am-meter-v1' as const;

/** The frozen per-dimension unit vocabulary — one canonical unit each. */
export type AppMeteringUnit =
  | 'selections'
  | 'invocations'
  | 'milliseconds'
  | 'bytes'
  | 'capability-uses';

export const APP_METERING_UNITS: Readonly<Record<AppMeteringDimension, AppMeteringUnit>> = {
  installations: 'selections',
  invocations: 'invocations',
  'compute-runtime': 'milliseconds',
  'data-volume': 'bytes',
  'premium-capabilities': 'capability-uses',
};

export const APP_METERING_UNIT_MEANINGS: Readonly<Record<AppMeteringUnit, string>> = {
  selections: 'one per MKT-048 install-ledger selection row (install, upgrade or rollback — each selection counts once)',
  invocations: 'one per MKT-022 extension-invocation ledger row',
  milliseconds: 'runtime compute consumption in milliseconds (runtime-host-reported observation)',
  bytes: 'data-volume consumption in bytes (runtime-host-reported observation)',
  'capability-uses': 'one per premium-capability use (runtime-host-reported observation of a manifest-declared capability)',
};

/** Pure: the canonical unit of a dimension (the frozen mapping). */
export function unitOfDimension(dimension: AppMeteringDimension): AppMeteringUnit {
  return APP_METERING_UNITS[dimension];
}

/**
 * The closed SOURCE-KIND vocabulary — the real surfaces meter events are
 * collected from (AC-1: the metering sources):
 *   - 'app-install-selection'  — one MKT-048 install-ledger selection row
 *     (install/upgrade/rollback; source_id = installId, source_link_id =
 *     the lifecycle event id);
 *   - 'extension-invocation'   — one MKT-022 extension-invocation ledger
 *     row (source_id = invocationId, source_link_id = the execution id);
 *   - 'observed-usage'         — one runtime-host usage observation
 *     (source_id = the canonical invocation record the usage was observed
 *     in, source_link_id = its execution id).
 */
export type AppMeteringSourceKind = 'app-install-selection' | 'extension-invocation' | 'observed-usage';

export const APP_METERING_SOURCE_KINDS: readonly AppMeteringSourceKind[] = [
  'app-install-selection',
  'extension-invocation',
  'observed-usage',
];

/**
 * The usage dimensions ingestible through the module-level observation
 * command — the three runtime-usage dimensions of the spec's five. The
 * 'installations' and 'invocations' dimensions are COLLECTION-ONLY (they
 * meter the real MKT-048/MKT-022 ledger rows exactly once per source; a
 * usage observation can never fabricate them).
 */
export const APP_METERING_INGESTIBLE_DIMENSIONS: readonly AppMeteringDimension[] = [
  'compute-runtime',
  'data-volume',
  'premium-capabilities',
];

/**
 * The RESERVED §8 command-key prefix of the collection commands: the
 * deterministic at-most-once keys the server derives per source event.
 * Ingestion keys may NOT take it (the module guard rejects the prefix —
 * a caller can never shadow a collection command's convergence identity).
 */
export const APP_METERING_COLLECT_KEY_PREFIX = 'collect:' as const;

// ---------------------------------------------------------------------------
// The frozen attribution assumption set (AC-3: disclosed aggregation
// assumptions — every attribution view ships them VERBATIM)
// ---------------------------------------------------------------------------

/**
 * The frozen assumption set every attribution derivation depends on
 * (the PROFIT_INTELLIGENCE_ASSUMPTIONS precedent): structured, explicit,
 * no hidden interpretation. Every entry is exported, documented and
 * surfaced VERBATIM in every attribution view; changing ANY value is an
 * attribution-calculation-version bump — never a silent restatement.
 */
export interface AppMeteringAssumptionSet {
  /**
   * The installations dimension counts ONE per MKT-048 install-ledger
   * SELECTION row — install, upgrade and rollback selections each count
   * once (the ledger's append-only rows ARE the installation events).
   */
  readonly installationUnit: 'one-per-selection-row';
  /**
   * The CURRENT installation count (per app) is the count of the ledger's
   * ACTIVE selection rows — never a tail total (superseded history stays
   * metered but is not "currently installed").
   */
  readonly currentInstallationBasis: 'active-selection-rows';
  /**
   * Invocation app attribution: an invocation meter event (a raw MKT-022
   * ledger fact) is attributed to the app whose CURRENT selection in the
   * same workspace declares a manifest DEPENDENCY on the invoked extension
   * (publisher + key) with a compatibility range containing the invoked
   * version — the dependency-declared current-selection linkage.
   */
  readonly invocationAppAttribution: 'dependency-declared-current-selection';
  /**
   * When ZERO or MULTIPLE current selections match the linkage, the
   * invocation is DISCLOSED as unattributed — counted in the raw totals
   * and the unattributed remainder, never silently dropped, never split.
   */
  readonly unattributedInvocationPolicy: 'disclosed-unattributed';
  /**
   * Period attribution uses the SOURCE EVENT's own occurred_at (the
   * install's installedAt / the invocation's issuedAt / the usage
   * observation's server timestamp), never the meter recording time — an
   * event metered late still counts in the period it happened. Buckets
   * are UTC calendar months.
   */
  readonly periodBasis: 'source-occurred-at-utc-calendar-month';
  /**
   * Premium-capability usage meters OBSERVED uses of capabilities the
   * pinned manifest DECLARES (the ingestion guard rejects a capability
   * the installed version's manifest does not declare, and rejects the
   * dimension when the manifest does not declare 'premium-capabilities'
   * metering at all).
   */
  readonly premiumCapabilityBasis: 'manifest-declared-capability-usage-observations';
  /**
   * Usage quantities (milliseconds/bytes/capability-uses) are
   * RUNTIME-HOST-REPORTED observations validated against a real (app,
   * workspace, invocation) context — the module validates the CONTEXT
   * (installed current selection, manifest-declared dimension and
   * capability, real invocation record of the same workspace), never the
   * measurement itself.
   */
  readonly usageQuantityBasis: 'runtime-host-reported-observations';
}

export const APP_METERING_ASSUMPTIONS: AppMeteringAssumptionSet = {
  installationUnit: 'one-per-selection-row',
  currentInstallationBasis: 'active-selection-rows',
  invocationAppAttribution: 'dependency-declared-current-selection',
  unattributedInvocationPolicy: 'disclosed-unattributed',
  periodBasis: 'source-occurred-at-utc-calendar-month',
  premiumCapabilityBasis: 'manifest-declared-capability-usage-observations',
  usageQuantityBasis: 'runtime-host-reported-observations',
};

/**
 * The ATTRIBUTION CALCULATION VERSION of every aggregate this module
 * derives (the PROFIT_INTELLIGENCE_CALCULATION_VERSION precedent): same
 * tail + this version ⇒ byte-identical attribution views (the pinning
 * proof). A change to ANY derivation rule or ANY assumption value is a
 * NEW version string — aggregates are versioned, never silently
 * re-stated.
 */
export const APP_METERING_ATTRIBUTION_CALCULATION_VERSION = 'am-attrib-v1' as const;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * One persisted APPEND-ONLY meter event row (migration 044). The scope
 * chain and provenance are SERVER-DERIVED and immutable; the app identity
 * columns carry the observation's OWN app identity only where the
 * observed fact includes it (installation selections and usage
 * observations — NULL for invocation observations, whose app attribution
 * is a view-time derivation under the versioned assumption set, never
 * materialized on the tail); the extension columns carry the RAW facts of
 * an invocation observation; the source references cite the canonical
 * records the event was collected from. UPDATE and DELETE are rejected
 * by the database outright.
 */
export interface AppMeterEventRecord {
  readonly eventId: string;
  readonly dimension: AppMeteringDimension;
  readonly unit: AppMeteringUnit;
  readonly quantity: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  /** The observation's OWN app identity (null for invocation observations). */
  readonly appKey: string | null;
  readonly appVersionId: string | null;
  readonly version: string | null;
  /** The RAW extension facts (present only for invocation observations). */
  readonly extensionId: string | null;
  readonly extensionKey: string | null;
  readonly extensionPublisher: string | null;
  readonly extensionVersion: string | null;
  /** The premium-capability label / the bounded app-state namespace. */
  readonly capability: string | null;
  readonly stateNamespace: string | null;
  readonly sourceKind: AppMeteringSourceKind;
  readonly sourceId: string;
  readonly sourceLinkId: string | null;
  /** The source event's own time (the period-bucketing basis). */
  readonly occurredAt: string;
  readonly recordedActor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
}

/**
 * The outcome of one metering COLLECTION over a workspace (the
 * event-consumption command): the counts of meter events APPENDED for
 * previously-unmetered sources, the counts of sources already metered
 * (the idempotent convergence — re-collection against unchanged
 * authorities appends ZERO rows), and the total.
 */
export interface AppMeteringCollectionOutcome {
  readonly workspaceId: string;
  readonly installationsCollected: number;
  readonly invocationsCollected: number;
  readonly installationsAlreadyMetered: number;
  readonly invocationsAlreadyMetered: number;
  readonly meterEventsAppended: number;
}

/** The outcome of one rollup RECOMPUTE (the disclosed rebuild path). */
export interface AppMeteringRecomputeOutcome {
  /** The rollup rows materialized by this rebuild. */
  readonly rollupRows: number;
  /** The meter events the rebuild aggregated (the whole tail). */
  readonly meterEventsConsidered: number;
  readonly rebuiltAt: string;
}

// ---------------------------------------------------------------------------
// The derived attribution read models (AC-3/AC-4 — GET-only views)
// ---------------------------------------------------------------------------

/** One dimension's aggregate over a meter-event slice. */
export interface AppMeteringDimensionAggregate {
  readonly dimension: AppMeteringDimension;
  readonly unit: AppMeteringUnit;
  /** Σ quantity over the slice's meter events of this dimension. */
  readonly quantity: number;
  readonly eventCount: number;
}

/**
 * One app's attribution row: the per-dimension aggregates attributed to
 * the app in the view's scope (installation selections by the ledger's
 * own app identity; usage observations by their own app identity;
 * invocations by the DISCLOSED dependency-declared current-selection
 * linkage), the count of the ledger's CURRENT (ACTIVE) selections in
 * scope, and the registry-resolved lineage publisher.
 */
export interface AppMeteringAppAttribution {
  readonly appKey: string;
  /**
   * The registry-resolved lineage publisher ('dev:<userId>' | 'svc:<label>')
   * — null when the lineage cannot be resolved through the /apps public
   * contract (the honest notDerivable posture).
   */
  readonly publisher: string | null;
  readonly dimensions: readonly AppMeteringDimensionAggregate[];
  /**
   * The count of CURRENT (ACTIVE) ledger selections in scope (the frozen
   * currentInstallationBasis assumption). Null in the PUBLISHER view: not
   * derivable at platform scope through the /app-installs public contract
   * (no global by-app listing) — the honest null, disclosed.
   */
  readonly currentSelectionCount: number | null;
}

/** One period bucket (UTC calendar month) with its per-dimension aggregates. */
export interface AppMeteringPeriodRow {
  /** The UTC month-bucket start (e.g. '2026-09-01T00:00:00.000Z'). */
  readonly periodStart: string;
  readonly dimensions: readonly AppMeteringDimensionAggregate[];
}

/** One publisher's aggregate (apps grouped by their registry publisher). */
export interface AppMeteringPublisherRow {
  readonly publisher: string;
  readonly appKeys: readonly string[];
  readonly dimensions: readonly AppMeteringDimensionAggregate[];
}

/**
 * The invocations that could NOT be attributed to exactly one installed
 * app — the honest unattributed remainder (counted in the raw totals,
 * never dropped, never split).
 */
export interface AppMeteringUnattributedInvocations {
  readonly count: number;
  readonly policy: 'disclosed-unattributed';
  readonly reason: string;
}

/** The calculation disclosure carried by EVERY attribution view. */
export interface AppMeteringCalculationDisclosure {
  readonly calculationVersion: string;
  readonly vocabularyVersion: string;
  readonly assumptions: AppMeteringAssumptionSet;
  readonly basis: 'live-derivation-over-own-append-only-tail';
  readonly persistence: 'append-only-tail-plus-rebuildable-rollups';
}

/** The WORKSPACE-scoped attribution view (AC-4: GET-only read model). */
export interface WorkspaceAppMeteringView {
  readonly scope: {
    readonly kind: 'workspace-app-metering';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  /**
   * The RAW per-dimension totals over ALL the workspace's meter events —
   * ≡ the rollup projection ≡ direct SQL over the tail (the ground truth).
   */
  readonly totals: readonly AppMeteringDimensionAggregate[];
  readonly perApp: readonly AppMeteringAppAttribution[];
  readonly unattributedInvocations: AppMeteringUnattributedInvocations;
  readonly calculation: AppMeteringCalculationDisclosure;
  readonly generatedAt: string;
}

/**
 * The AGENCY-scoped attribution view: the portfolio rollup over the
 * agency's workspaces (per app, per publisher, per period, totals).
 */
export interface AgencyAppMeteringView {
  readonly scope: {
    readonly kind: 'agency-app-metering';
    readonly agencyId: string;
  };
  readonly totals: readonly AppMeteringDimensionAggregate[];
  readonly perApp: readonly AppMeteringAppAttribution[];
  readonly perPublisher: readonly AppMeteringPublisherRow[];
  readonly perPeriod: readonly AppMeteringPeriodRow[];
  readonly unattributedInvocations: AppMeteringUnattributedInvocations;
  readonly calculation: AppMeteringCalculationDisclosure;
  readonly generatedAt: string;
}

/**
 * The PUBLISHER-scoped attribution view: the commercial rollup of ONE
 * platform developer's published apps across the platform (per app, per
 * period, totals). Tenant identities NEVER surface here — the publisher
 * view aggregates per app and per period ONLY (no workspace/agency
 * breakdowns, no tenant identifiers: the cross-tenant boundary).
 */
export interface PublisherAppMeteringView {
  readonly scope: {
    readonly kind: 'publisher-app-metering';
    /** The server-derived publisher identity ('dev:<userId>'). */
    readonly publisher: string;
    readonly publisherUserId: string;
  };
  readonly totals: readonly AppMeteringDimensionAggregate[];
  readonly perApp: readonly AppMeteringAppAttribution[];
  readonly perPeriod: readonly AppMeteringPeriodRow[];
  readonly unattributedInvocations: AppMeteringUnattributedInvocations;
  readonly calculation: AppMeteringCalculationDisclosure;
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every metering command (the
 * /app-installs AppInstallProvenance precedent): built exclusively from
 * the authenticated principal, the ambient correlation context and the
 * recording surface — never from a request body. The ingestion surface
 * is MODULE-LEVEL (never an HTTP route), so this block is derived by the
 * server-side caller (tests, background workers, future invocation
 * hosts).
 */
export interface AppMeteringProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived surface label ('module' for module-level commands). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Structural ports (the frozen-matrix-compliant consumed public contracts)
// ---------------------------------------------------------------------------

/**
 * The narrow STRUCTURAL view of the /workspaces canonical owner context
 * (the AppInstallsWorkspaceOwnershipSnapshot precedent): the resolved
 * Workspace, its owning Client and the owning Agency with their boundary
 * statuses. The real WorkspacesModuleApi satisfies this structurally —
 * /workspaces remains the ONLY Workspace ownership authority; the
 * metering scope chain is always server-derived.
 */
export interface AppMeteringWorkspaceOwnershipSnapshot {
  readonly scope: {
    readonly kind: 'workspace';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  readonly workspace: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly status: string;
  };
  readonly client: {
    readonly clientId: string;
    readonly agencyId: string;
    readonly status: string;
  };
  readonly clientOwnership: {
    readonly agency: {
      readonly agencyId: string;
      readonly status: string;
    };
  };
}

/**
 * The slice of the /workspaces public contract this module depends on:
 * canonical server-side Workspace ownership resolution from durable
 * state (scope chain + boundary statuses). Satisfied structurally by
 * WorkspacesModuleApi; wired at the composition root.
 */
export interface AppMeteringWorkspaceOwnershipPort {
  resolveWorkspaceOwnership(workspaceId: string): Promise<AppMeteringWorkspaceOwnershipSnapshot | null>;
}

// ---------------------------------------------------------------------------
// The invocation-app attribution linkage (pure — AC-2/AC-8 unit-tested)
// ---------------------------------------------------------------------------

/** One current-selection dependency manifest view for the linkage. */
export interface AppMeteringDependencyView {
  readonly appKey: string;
  readonly dependencies: ReadonlyArray<{
    readonly kind: string;
    readonly publisher: string | null;
    readonly key: string;
    readonly minVersion: string;
    readonly maxVersion: string;
  }>;
}

/**
 * The PURE invocation-app attribution linkage (the frozen assumption
 * 'dependency-declared-current-selection'): resolves which app an
 * invocation of (extension publisher, key, version) attributes to among
 * the workspace's CURRENT selection manifests — exactly ONE declaring
 * app (the attribution), ZERO (unattributed: no declaring current
 * selection) or MULTIPLE (ambiguous: disclosed as unattributed, never
 * split). Uses the /apps REAL semver range comparator. Pure.
 */
export function attributeInvocationToApp(
  invocation: {
    readonly extensionPublisher: string;
    readonly extensionKey: string;
    readonly extensionVersion: string;
  },
  currentSelections: readonly AppMeteringDependencyView[],
): { readonly appKey: string } | { readonly unattributed: true; readonly reason: string } {
  const matches = currentSelections.filter((selection) =>
    selection.dependencies.some(
      (dependency) =>
        dependency.kind === 'extension' &&
        dependency.publisher === invocation.extensionPublisher &&
        dependency.key === invocation.extensionKey &&
        appVersionInRange(invocation.extensionVersion, dependency.minVersion, dependency.maxVersion),
    ),
  );
  if (matches.length === 1) {
    return { appKey: matches[0]!.appKey };
  }
  if (matches.length === 0) {
    return {
      unattributed: true,
      reason: `no current app selection in the workspace declares a dependency on extension ${invocation.extensionPublisher}/${invocation.extensionKey} with a range containing ${invocation.extensionVersion}`,
    };
  }
  return {
    unattributed: true,
    reason: `multiple current app selections (${matches.map((match) => match.appKey).sort().join(', ')}) declare a dependency on extension ${invocation.extensionPublisher}/${invocation.extensionKey} — the invocation is ambiguous and disclosed as unattributed, never split`,
  };
}

/** Pure: the UTC calendar-month bucket start of an ISO timestamp. */
export function meteringPeriodStartOf(occurredAtIso: string): string {
  const date = new Date(occurredAtIso);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return start.toISOString();
}

/** Pure: composes the calculation disclosure every attribution view ships. */
export function composeAppMeteringCalculationDisclosure(): AppMeteringCalculationDisclosure {
  return {
    calculationVersion: APP_METERING_ATTRIBUTION_CALCULATION_VERSION,
    vocabularyVersion: APP_METERING_VOCABULARY_VERSION,
    assumptions: APP_METERING_ASSUMPTIONS,
    basis: 'live-derivation-over-own-append-only-tail',
    persistence: 'append-only-tail-plus-rebuildable-rollups',
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface AppMeteringModuleApi {
  /**
   * COLLECTS the workspace's metering from the REAL sources through
   * their public contracts (AC-1 — event consumption, never a write into
   * another module's tables): every NOT-yet-metered MKT-048 install-ledger
   * selection row appends ONE 'installations' meter event (quantity 1,
   * the row's exact app identity, the ledger row id + the lifecycle event
   * id as the canonical source references, the row's installedAt as
   * occurredAt) and every NOT-yet-metered MKT-022 extension-invocation
   * ledger row appends ONE 'invocations' meter event (quantity 1, the
   * invocation's RAW extension facts re-verified against the registry,
   * the invocation id + the execution id as the source references, the
   * invocation's issuedAt as occurredAt). IDEMPOTENT: re-collection
   * against unchanged authorities appends ZERO rows (the at-most-once
   * source fence + the deterministic 'collect:' §8 command keys);
   * concurrent collections converge to exactly one meter event per
   * source. The workspace ownership resolves SERVER-SIDE through the
   * /workspaces structural port BEFORE anything else (unknown/tombstoned
   * → uniform NotFoundError; a disabled boundary → ConflictError — the
   * /app-installs posture).
   */
  collectWorkspaceMetering(
    input: {
      readonly workspaceId: string;
    },
    provenance: AppMeteringProvenance,
  ): Promise<AppMeteringCollectionOutcome>;

  /**
   * RECORDS one runtime-host usage observation (AC-1's usage dimensions —
   * the MODULE-LEVEL ingestion command for server-side callers; never an
   * HTTP route): appends ONE meter event of dimension 'compute-runtime'
   * (milliseconds), 'data-volume' (bytes) or 'premium-capabilities'
   * (capability-uses) with the observed quantity. Guards (fail-closed,
   * zero rows): the workspace ownership resolves through the /workspaces
   * structural port (uniform 404); the app must be the workspace's
   * CURRENT (ACTIVE) MKT-048 selection (through the /app-installs public
   * contract — a foreign/unknown app-for-this-workspace is the uniform
   * 404); the dimension must be one the pinned manifest's
   * meteringDimensions DECLARES (422 with the honest reason — metering
   * dimensions are manifest-declared); a premium-capability observation
   * must name a capability the pinned manifest declares (422); a
   * data-volume observation may name one of the manifest's declared
   * app-state namespaces (422 when foreign); the source invocation must
   * resolve through the /extensions public contract and belong to the
   * SAME workspace (uniform 404 — the canonical provenance reference);
   * the quantity is a bounded positive integer; §8 replays converge
   * (identical fingerprint → the recorded event, replayed: true) and a
   * divergent reuse of the key is an IdempotencyConflictError; a
   * 'collect:'-prefixed key is rejected (the reserved server prefix).
   * The observed quantity itself is RUNTIME-HOST-REPORTED (the module
   * validates the context, never the measurement — disclosed).
   */
  recordMeterObservation(
    input: {
      readonly workspaceId: string;
      readonly appKey: string;
      readonly dimension: AppMeteringDimension;
      readonly quantity: number;
      /** The premium-capability label (required for premium-capabilities). */
      readonly capability: string | null;
      /** The bounded app-state namespace (optional for data-volume). */
      readonly stateNamespace: string | null;
      /** The canonical invocation record the usage was observed in. */
      readonly sourceInvocationId: string;
      readonly idempotencyKey: string;
    },
    provenance: AppMeteringProvenance,
  ): Promise<{ readonly event: AppMeterEventRecord; readonly replayed: boolean }>;

  /**
   * RECOMPUTES the rollup projection from the append-only tail (AC-5's
   * disclosed rebuild path — the module-level operation, the
   * operating-graph rebuild precedent): ONE transaction replaces the
   * whole app_metering_rollups table with the deterministic (workspace,
   * app-or-unattributed, dimension, month) GROUP BY aggregates over the
   * tail. Re-running against an unchanged tail converges to IDENTICAL
   * aggregate rows (the convergence proof — rebuilt_at is the only
   * non-deterministic column, disclosed). The tail is the sole source of
   * truth; rollups never feed the attribution views (they are a durable
   * reporting projection for background workers and future Work Items).
   */
  recomputeAttributionRollups(): Promise<AppMeteringRecomputeOutcome>;

  /**
   * The WORKSPACE attribution view (AC-3/AC-4): the derived read model
   * LIVE over the module's own tail — the raw per-dimension totals, the
   * per-app attribution (installation selections + usage observations by
   * their own app identity; invocations by the disclosed
   * dependency-declared current-selection linkage derived against the
   * workspace's CURRENT selections read through the /app-installs public
   * contract), and the honest unattributed-invocations remainder. The
   * workspace ownership resolves SERVER-SIDE (uniform 404 for
   * unknown/tombstoned/foreign).
   */
  getWorkspaceAppMetering(workspaceId: string): Promise<WorkspaceAppMeteringView>;

  /**
   * The AGENCY attribution view (AC-3/AC-4): the portfolio rollup over
   * the agency's workspaces — per app, per publisher (registry-resolved),
   * per period (UTC calendar months of occurredAt) and totals, all LIVE
   * over the module's own tail (the tail rows carry the server-derived
   * agency scope chain). The agency scope is validated at the route
   * layer (the module reads only the agency's own rows).
   */
  getAgencyAppMetering(agencyId: string): Promise<AgencyAppMeteringView>;

  /**
   * The PUBLISHER attribution view (AC-3/AC-4): the commercial rollup of
   * one platform developer's published apps across the platform — per
   * app, per period and totals over the module's own tail, with the
   * invocation attribution linkage derived per workspace. TENANT
   * IDENTITIES NEVER SURFACE: the publisher view aggregates per app and
   * per period only (no workspace/agency identifiers — the cross-tenant
   * boundary). The publisher's app lineages resolve through the /apps
   * public registry contract; an unknown publisher identity yields the
   * honest empty view (the route layer surfaces the uniform 404 for
   * unknown/foreign publisher ids).
   */
  getPublisherAppMetering(publisher: string): Promise<PublisherAppMeteringView>;

  /** Raw meter event row by id — append-only history is always readable. */
  getAppMeterEvent(eventId: string): Promise<AppMeterEventRecord | null>;

  /** The workspace's append-only meter event tail (oldest first). */
  listWorkspaceMeterEvents(workspaceId: string): Promise<readonly AppMeterEventRecord[]>;
}

export interface AppMeteringModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Matrix-listed direction (/app-metering ──→ /apps): the App registry
   * authority — exact App Version resolution (the pinned manifests the
   * ingestion guards and the attribution linkage consume) + the lineage
   * listings (the publisher view's app keys). Consumed READ-ONLY through
   * the public contract; the registry is never mutated.
   */
  readonly apps: AppsModuleApi;
  /**
   * Matrix-listed direction (/app-metering ──→ /app-installs): the App
   * installation authority — the install ledger + lifecycle event tail
   * (the COLLECTION SOURCES) and the current selections (the ingestion
   * context guard + the invocation attribution linkage). Consumed
   * READ-ONLY through the public contract; the ledger is never mutated
   * and never written from here.
   */
  readonly appInstalls: AppInstallsModuleApi;
  /**
   * Matrix-listed direction (/app-metering ──→ /extensions): the
   * extension registry + invocation ledger authority — the invocation
   * ledger rows (the COLLECTION SOURCE) and the invocation/extension
   * version resolution (the ingestion provenance validation + the
   * invocation facts' registry re-verification). Consumed READ-ONLY
   * through the public contract.
   */
  readonly extensions: ExtensionsModuleApi;
  /**
   * Matrix-listed direction (/app-metering ──→ /workspaces), consumed
   * through the narrow canonical-ownership STRUCTURAL PORT (the
   * /app-installs precedent — satisfied structurally by the real
   * WorkspacesModuleApi instance at the composition root).
   */
  readonly workspaceOwnership: AppMeteringWorkspaceOwnershipPort;
}

export { createAppMeteringModule } from './internal/module.ts';
/**
 * The input guards (observation/collection input + provenance validation
 * with the §21 material-key backstop), the pure aggregation helpers of
 * the attribution derivation, the §8-style create fingerprints and the
 * write-conflict classification — exported for unit tests and future
 * server-side callers (the background workers / invocation hosts that
 * compose the collection + ingestion commands) so the guard semantics
 * are part of the module contract. Pure functions.
 */
export {
  APP_METERING_MATERIAL_SHAPED_KEYS,
  appMeterObservationCreateFingerprint,
  assertValidMeteringProvenance,
  assertValidObservationInput,
  assertValidWorkspaceMeteringInput,
  classifyAppMeteringWriteConflict,
  collectInstallSelectionKey,
  collectInvocationKey,
  replayOrConflict,
} from './internal/store.ts';
export {
  aggregateDimensionTotals,
  aggregatePerAppAttribution,
  aggregatePerPublisher,
  buildAppAttribution,
  groupByPeriod,
  unattributedInvocationsOf,
} from './internal/attribution.ts';
export type { AppMeterEventSlice } from './internal/attribution.ts';
