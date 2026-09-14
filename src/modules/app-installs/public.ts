/**
 * MarketingOS module: /app-installs
 * Authority: App installation lifecycle — workspace-scoped install,
 * upgrade and rollback over the /apps registry (MKT-048).
 *
 * This module owns the WORKSPACE-SCOPED APP LIFECYCLE (spec/
 * mos-app-ecosystem-v1.5.md "Install and invoke" + "Upgrade and rollback",
 * verbatim; spec/effective-backlog-v1.5.md MKT-048; spec/
 * architecture-lock-v1.5.md #10 "App permissions are least-privilege,
 * policy-gated, server-derived and revocable" and #11 "Published App
 * Versions are immutable; upgrades and rollback affect future selection
 * only"):
 *
 *   - the INSTALL LEDGER (migration 038): one APPEND-ORIENTED row per
 *     EXACT-VERSION SELECTION of a (workspace, app key) lineage. Install,
 *     upgrade and rollback each APPEND a new row (selection_seq 1, 2, 3,
 *     ...); the prior row is superseded by the SINGLE sanctioned UPDATE
 *     (status ACTIVE → SUPERSEDED with superseded_at set — the
 *     migration-035 operating-graph supersession pattern). Historical rows
 *     retain their ORIGINAL (app key, version) after upgrade AND rollback
 *     — history is never rewritten (DELETE and every other UPDATE are
 *     rejected at the storage layer);
 *   - the SERVER-DERIVED GRANTED SCOPES: the manifest's REQUESTED scopes
 *     intersected with the install-time FAIL-CLOSED policy evaluation and
 *     the frozen scope vocabularies (the closed MKT-047 sets — re-exported
 *     from the /apps public contract because the grants are constrained by
 *     the SAME frozen sets the registry validates on manifests). Granted
 *     scopes are NEVER caller-suppliable: the module API input has NO
 *     scopes field at all (structurally unreachable), and the
 *     migration-038 triggers re-fence the grants as a subset of the pinned
 *     manifest's requested scopes;
 *   - the INSTALL-TIME POLICY GATE: every install/upgrade/rollback is
 *     policy-gated through the merged /policies engine (the extension
 *     dimension — Apps are versioned composition packages over Extensions,
 *     so the frozen 'extension' boundary governs app installs): the
 *     operation-level gate ('install' | 'upgrade' | 'rollback') must be an
 *     EXPLICIT recorded allow (deny/unknown → PolicyDeniedError 403, zero
 *     rows — the /deployments policy-gate precedent), and every requested
 *     scope is evaluated per-scope so the derived grants are the honest
 *     intersection (a policy may deny one scope while allowing the install
 *     itself — least privilege);
 *   - the COMPATIBILITY VALIDATION: the selected target must pass the
 *     MKT-047 compatibility contract — the /apps public
 *     queryCompatibleAppVersions consumption surface (the exact purpose
 *     the MKT-047 public contract documents for this Work Item) evaluated
 *     against the SERVER-DECLARED platform version and the extension
 *     versions AUTHORIZED in the target workspace (the /deployments
 *     capability-check posture). Incompatible targets are rejected 422
 *     with the honest reasons, zero rows;
 *   - the READ SURFACE: the workspace's installed apps (current selection
 *     + full append-oriented history), the single selection row, the
 *     workspace's lifecycle event tail and the agency rollup of current
 *     selections. GET-only at the route layer; every mutation is a POST
 *     with server-derived identity.
 *
 * What this module deliberately does NOT do (bounded scope, MKT-048):
 *   - NO app invocation surface (the short-lived Extension invocation
 *     context of MKT-022 / later App SDK Work Items composes the CURRENT
 *     selection at invocation time — historical invocation records retain
 *     their original App Version by construction, because the ledger row
 *     pins it immutably);
 *   - NO manifest publication, certification or registry mutation (the
 *     /apps authority, MKT-047/MKT-050): this module READS the registry
 *     through its public contract and never writes it;
 *   - NO grant revocation/suspend surface (future Work Item territory —
 *     the frozen MKT-048 acceptance list has no suspend criterion; grants
 *     are re-derived fresh at every selection change, superseding a
 *     selection structurally revokes its grants as the current selection,
 *     and per-use policy gates stay fail-closed at invocation time —
 *     architecture-lock v1.5 #10's revocability is honored by selection
 *     supersession + use-time policy, disclosed in the runbook);
 *   - NO marketplace/trust surface (MKT-050), NO metering ledger (MKT-052),
 *     NO developer portal (MKT-049), NO app-owned state storage (bounded
 *     app state composes the existing authorities);
 *   - NO second tenant, permission, identity, workflow or execution
 *     authority: the workspace/client/agency scope chain resolves through
 *     the /workspaces canonical ownership resolution, authorization stays
 *     the /agencies membership authority at the route layer, and the
 *     policy gate delegates to the merged /policies engine.
 *
 * DEPENDENCY POSTURE (the disclosed MKT-048 registration row of
 * spec/module-dependency-matrix.md: /app-installs ──→ /apps, /extensions,
 * /policies, /workspaces): this public entry imports the /apps and
 * /policies public contracts DIRECTLY (the matrix-listed composition
 * directions; the /extensions precedent for /policies) and declares
 * STRUCTURAL PORTS for the /workspaces canonical ownership resolution and
 * the /extensions install availability (the narrow public-contract views
 * wired at the composition root — the /deployments posture; zero imports
 * of any module's internals anywhere under src/modules/app-installs,
 * verified by tools/arch-check and
 * tests/architecture/app-installs-boundary.test.ts).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
// Matrix-listed directions consumed DIRECTLY (public entries only — the
// /decisions precedent for matrix-listed contracts):
import {
  APP_DATA_SCOPES,
  APP_MUTATION_SCOPES,
  type AppDataScope,
  type AppMutationScope,
  type AppsModuleApi,
} from '../apps/public.ts';
import type { PoliciesModuleApi } from '../policies/public.ts';

// ---------------------------------------------------------------------------
// The frozen scope vocabularies (re-exported from the /apps public contract
// — the SAME closed sets the MKT-047 registry validates on manifests; the
// install grants are constrained by the identical frozen sets)
// ---------------------------------------------------------------------------

export type { AppDataScope, AppMutationScope };
export { APP_DATA_SCOPES, APP_MUTATION_SCOPES };

// ---------------------------------------------------------------------------
// The frozen selection lifecycle (mos-app-ecosystem-v1.5.md "Upgrade and
// rollback"; architecture-lock v1.5 #11)
// ---------------------------------------------------------------------------

/**
 * The closed selection-operation vocabulary: how one ledger row came to be.
 * 'install' is the lineage's FIRST selection (selection_seq 1); 'upgrade'
 * selects a NEW version for FUTURE invocations; 'rollback' reselects a
 * PREVIOUSLY INSTALLED approved version.
 */
export type AppInstallOperation = 'install' | 'upgrade' | 'rollback';

export const APP_INSTALL_OPERATIONS: readonly AppInstallOperation[] = [
  'install',
  'upgrade',
  'rollback',
];

/**
 * The frozen per-row lifecycle: every selection row is born ACTIVE (the
 * documented choice — install is fully gated BEFORE the row is written, so
 * there is no draft state); the ONLY sanctioned transition is ACTIVE →
 * SUPERSEDED, applied by the successor selection's append in the same
 * transaction (the operating-graph supersession pattern). A SUPERSEDED row
 * is terminal history: its exact (app key, version) identity, grants and
 * provenance stay readable forever.
 */
export type AppInstallStatus = 'ACTIVE' | 'SUPERSEDED';

export const APP_INSTALL_STATUSES: readonly AppInstallStatus[] = ['ACTIVE', 'SUPERSEDED'];

/** The selection-transition table: only the supersession edge exists. */
export const APP_INSTALL_TRANSITIONS: Readonly<
  Record<AppInstallStatus, readonly AppInstallStatus[]>
> = {
  ACTIVE: ['SUPERSEDED'],
  SUPERSEDED: [],
};

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalAppInstallTransition(from: AppInstallStatus, to: AppInstallStatus): boolean {
  return APP_INSTALL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// The pure selection/upgrade state machine (AC-11 — unit-tested)
// ---------------------------------------------------------------------------

/**
 * The lineage state a selection request is evaluated against: the CURRENT
 * selection (null when the app was never installed in the workspace) and
 * the set of versions EVER selected by the lineage (the rollback targets).
 */
export interface AppInstallLineageState {
  readonly current: {
    readonly installId: string;
    readonly version: string;
    readonly selectionSeq: number;
  } | null;
  /** Every version this lineage ever selected (install + upgrades + rollbacks). */
  readonly selectedVersions: readonly string[];
}

/** One selection request (the pure state-machine input). */
export interface AppInstallSelectionRequest {
  readonly operation: AppInstallOperation;
  /** The target EXACT version (upgrade target, or the rollback target's version). */
  readonly targetVersion: string;
}

/** The state-machine verdict: legal, or illegal with the honest reason. */
export type AppInstallSelectionVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * The PURE selection/upgrade state machine (AC-11). Frozen rules:
 *   - install      — legal exactly when the app was never installed in the
 *                    workspace (no current selection, empty lineage);
 *   - upgrade      — legal when a current selection exists, the target
 *                    version DIFFERS from the current version, and the
 *                    target was NEVER selected before (upgrades select a
 *                    NEW version for future invocations; a previously
 *                    installed version is reselected by ROLLBACK);
 *   - rollback     — legal when a current selection exists and the target
 *                    is a PREVIOUSLY INSTALLED approved version different
 *                    from the current one ("Rollback reselects an existing
 *                    approved version without rewriting history").
 */
export function evaluateSelectionRequest(
  state: AppInstallLineageState,
  request: AppInstallSelectionRequest,
): AppInstallSelectionVerdict {
  const selectedVersions = state.selectedVersions as readonly string[];
  const previouslySelected = selectedVersions.includes(request.targetVersion);
  if (request.operation === 'install') {
    if (state.current !== null) {
      return {
        ok: false,
        reason: `the lineage already has a current selection (${state.current.version}) — install is the first selection of a lineage; new versions arrive by upgrade and prior versions by rollback`,
      };
    }
    if (selectedVersions.length > 0) {
      return {
        ok: false,
        reason: 'the lineage already exists — install is the first selection of a lineage',
      };
    }
    return { ok: true };
  }
  if (state.current === null) {
    return {
      ok: false,
      reason: `the app is not installed in this workspace — ${request.operation} requires an existing installation`,
    };
  }
  if (request.targetVersion === state.current.version) {
    return {
      ok: false,
      reason: `version ${request.targetVersion} is already the current selection — a selection change must select a different version`,
    };
  }
  if (request.operation === 'upgrade') {
    if (previouslySelected) {
      return {
        ok: false,
        reason: `version ${request.targetVersion} was previously installed in this workspace — upgrade selects a NEW version; rollback reselects previously installed versions`,
      };
    }
    return { ok: true };
  }
  if (!previouslySelected) {
    return {
      ok: false,
      reason: `version ${request.targetVersion} was never installed in this workspace — rollback reselects a PREVIOUSLY INSTALLED approved version`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The pure scope-intersection derivation (AC-2/AC-11 — unit-tested)
// ---------------------------------------------------------------------------

/** The derived grants of one selection (SERVER-DERIVED, least-privilege). */
export interface AppInstallGrants {
  readonly grantedDataScopes: readonly AppDataScope[];
  readonly grantedMutationScopes: readonly AppMutationScope[];
}

/**
 * The PURE scope-intersection derivation (AC-2): the manifest's REQUESTED
 * scopes intersected with the policy-allowed scope labels and the FROZEN
 * scope vocabularies. Order follows the manifest declaration; the result is
 * always a subset of the request; labels outside the frozen vocabularies
 * are never granted (the vocabulary is the final filter). Pure.
 */
export function intersectGrantedScopes(
  requestedDataScopes: readonly AppDataScope[],
  requestedMutationScopes: readonly AppMutationScope[],
  allowedScopes: ReadonlySet<string>,
): AppInstallGrants {
  const knownData = new Set<string>(APP_DATA_SCOPES);
  const knownMutation = new Set<string>(APP_MUTATION_SCOPES);
  const grantedDataScopes = requestedDataScopes.filter(
    (scope) => allowedScopes.has(scope) && knownData.has(scope),
  );
  const grantedMutationScopes = requestedMutationScopes.filter(
    (scope) => allowedScopes.has(scope) && knownMutation.has(scope),
  );
  return { grantedDataScopes, grantedMutationScopes };
}

// ---------------------------------------------------------------------------
// The pure compatibility-eligibility resolution (AC-5/AC-11 — unit-tested)
// ---------------------------------------------------------------------------

/** One app-version identity as carried by a compatibility report. */
export interface AppCompatibilityVersionRef {
  readonly appKey: string;
  readonly version: string;
}

/**
 * The narrow structural view of the MKT-047 compatibility report this
 * module consumes (satisfied by AppCompatibilityReport — public-contract
 * DATA only; no /apps internals are imported).
 */
export interface AppInstallsCompatibilityReportView {
  readonly eligible: readonly AppCompatibilityVersionRef[];
  readonly ineligible: readonly {
    readonly appKey: string;
    readonly version: string;
    readonly reasons: readonly string[];
  }[];
}

/**
 * The PURE compatibility-eligibility resolution (AC-5): resolves the target
 * EXACT (app key, version) against a compatibility report — eligible, or
 * ineligible with the report's honest reasons (a missing entry carries the
 * honest "not present in the report" reason). Pure.
 */
export function resolveTargetCompatibility(
  target: AppCompatibilityVersionRef,
  report: AppInstallsCompatibilityReportView,
): { readonly eligible: true } | { readonly eligible: false; readonly reasons: readonly string[] } {
  if (
    report.eligible.some((entry) => entry.appKey === target.appKey && entry.version === target.version)
  ) {
    return { eligible: true };
  }
  const ineligible = report.ineligible.find(
    (entry) => entry.appKey === target.appKey && entry.version === target.version,
  );
  if (ineligible !== undefined) {
    return { eligible: false, reasons: ineligible.reasons };
  }
  return {
    eligible: false,
    reasons: [
      `app version ${target.appKey}@${target.version} is not present in the compatibility report for the target environment`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every selection mutation (the /deployments
 * pattern): built exclusively from the authenticated principal, the
 * ambient correlation context and the recording surface — never from a
 * request body (route validation rejects provenance-shaped authority
 * fields; this type is a separate module-API argument so no DTO can feed
 * it structurally).
 */
export interface AppInstallProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>'. */
  readonly actor: string;
  /** Server-derived surface label ('api' for the HTTP surface). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * One persisted ledger row — one EXACT-VERSION SELECTION of a (workspace,
 * app key) lineage. The scope chain is server-derived and immutable; the
 * granted scopes are SERVER-DERIVED (never caller-suppliable); the
 * lifecycle is born ACTIVE with the single sanctioned supersession
 * transition; historical rows retain their ORIGINAL (app key, version)
 * forever.
 */
export interface AppInstallRecord {
  readonly installId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly appKey: string;
  /** The pinned immutable registry row (the EXACT App Version identity). */
  readonly appVersionId: string;
  readonly version: string;
  readonly operation: AppInstallOperation;
  readonly grantedDataScopes: readonly AppDataScope[];
  readonly grantedMutationScopes: readonly AppMutationScope[];
  /** The recorded install-time policy decision that allowed this selection. */
  readonly policyDecisionId: string | null;
  readonly selectionSeq: number;
  readonly status: AppInstallStatus;
  readonly supersededAt: string | null;
  readonly installedBy: string | null;
  readonly installedAt: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
}

/**
 * One APPEND-ONLY lifecycle event — the immutable transition tail
 * ('installed' | 'upgraded' | 'rolled_back') with the prior → new selection
 * linkage and server-derived provenance. The database rejects UPDATE and
 * DELETE outright.
 */
export interface AppInstallEventRecord {
  readonly eventId: string;
  readonly installId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly appKey: string;
  readonly eventType: 'installed' | 'upgraded' | 'rolled_back';
  readonly priorInstallId: string | null;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly policyDecisionId: string | null;
  readonly idempotencyKey: string;
  readonly recordedActor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The outcome of one selection operation (§8 convergence included)
// ---------------------------------------------------------------------------

/**
 * The outcome of one install/upgrade/rollback: the selection record AFTER
 * the operation (the appended successor — or the already-recorded row when
 * this request was a REPLAY: a duplicate that converged with zero state
 * change), the SUPERSEDED prior selection (null on install/replay of an
 * install), and whether this request was a replay.
 */
export interface AppInstallOperationOutcome {
  readonly install: AppInstallRecord;
  readonly prior: AppInstallRecord | null;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Structural ports (the frozen-matrix-compliant consumed public contracts)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /workspaces canonical owner context (the
 * /deployments DeploymentsWorkspaceOwnershipSnapshot precedent): the
 * resolved Workspace, its owning Client and the owning Agency with their
 * boundary statuses. The real WorkspacesModuleApi satisfies this
 * structurally — /workspaces remains the ONLY Workspace ownership
 * authority; the install scope chain is always server-derived.
 */
export interface AppInstallsWorkspaceOwnershipSnapshot {
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
 * canonical server-side Workspace ownership resolution from durable state
 * (scope chain + boundary statuses). Satisfied structurally by
 * WorkspacesModuleApi; wired at the composition root.
 */
export interface AppInstallsWorkspaceOwnershipPort {
  resolveWorkspaceOwnership(workspaceId: string): Promise<AppInstallsWorkspaceOwnershipSnapshot | null>;
}

/** The narrow /extensions install view (workspace-scoped availability). */
export interface AppInstallsExtensionInstallSnapshot {
  readonly installId: string;
  readonly extensionId: string;
  readonly status: string;
}

/** The narrow /extensions registry view (the dependency-version identity). */
export interface AppInstallsExtensionVersionSnapshot {
  readonly extensionId: string;
  readonly extensionKey: string;
  readonly publisher: string;
  readonly version: string;
}

/**
 * The slice of the /extensions public contract this module depends on
 * (READ-ONLY): the Workspace's installs + registry version resolution for
 * the MKT-047 compatibility contract's extension-dependency satisfaction
 * (an extension version is AVAILABLE to a workspace install when its
 * install is AUTHORIZED — the /deployments capability-check posture).
 * Adapter-wired at the composition root; the module holds NO extension
 * mutation surface (composition, not authority transfer —
 * architecture-lock v1.5 #7).
 */
export interface AppInstallsExtensionsPort {
  listExtensionInstalls(workspaceId: string): Promise<readonly AppInstallsExtensionInstallSnapshot[]>;
  getExtensionVersion(extensionId: string): Promise<AppInstallsExtensionVersionSnapshot | null>;
}

// ---------------------------------------------------------------------------
// The server-declared platform version (the compatibility-contract input)
// ---------------------------------------------------------------------------

/**
 * The SERVER-DECLARED platform version of the running MOS v1.5 service —
 * the compatibility-range input of every install/upgrade/rollback
 * validation. A server-side architecture-epoch declaration, NEVER a
 * request field (the /apps compatibility QUERY is a caller-supplied pure
 * read surface; the install GATE consumes the server's own declaration).
 * Bumped by the platform when the architecture epoch moves.
 */
export const APP_INSTALLS_PLATFORM_VERSION = '1.5.0';

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface AppInstallsModuleApi {
  /**
   * INSTALLS one EXACT published App Version into a Workspace (the
   * lineage's first selection — selection_seq 1, born ACTIVE). The
   * canonical ownership resolves SERVER-SIDE through the /workspaces
   * structural port BEFORE anything else: unknown/tombstoned
   * Workspace/Client → uniform NotFoundError; a disabled
   * Workspace/Client/Agency boundary → ConflictError (disabled boundaries
   * block new use without rewriting history). The target must resolve
   * through the /apps public contract (unknown app/version → uniform 404)
   * and pass the MKT-047 compatibility contract against the
   * server-declared platform version + the workspace's AUTHORIZED
   * extension versions (incompatible → InvalidRequestError with the honest
   * reasons, zero rows). The install is POLICY-GATED (the extension
   * dimension 'install' operation must be an explicit recorded allow —
   * deny/unknown → PolicyDeniedError 403, zero rows) and the granted
   * scopes are DERIVED SERVER-SIDE (the manifest's requested scopes
   * intersected with the per-scope policy evaluations and the frozen
   * vocabularies). Idempotent per (workspace, idempotencyKey): an
   * identical replay converges to the recorded row; a divergent reuse of
   * the key is an IdempotencyConflictError.
   */
  installApp(
    input: {
      readonly workspaceId: string;
      readonly appKey: string;
      readonly version: string;
      readonly idempotencyKey: string;
      /** SERVER-DERIVED installer identity (the authenticated principal). */
      readonly actorId: string | null;
    },
    provenance: AppInstallProvenance,
  ): Promise<AppInstallOperationOutcome>;

  /**
   * UPGRADES the installation: selects a NEW exact version for FUTURE
   * invocations. The install row must be the lineage's CURRENT selection
   * (a superseded row → ConflictError — the selection moved); the target
   * version must differ from the current selection, must NOT have been
   * previously installed by the lineage (previously installed versions are
   * reselected by ROLLBACK — InvalidRequestError with the honest reason),
   * must resolve through /apps (uniform 404) and must pass the MKT-047
   * compatibility contract (422 with the honest reasons, zero rows). The
   * upgrade is policy-gated (extension dimension 'upgrade' — an explicit
   * recorded allow required) and the grants are re-derived SERVER-SIDE for
   * the new version. The append is ONE transaction: the prior row is
   * superseded (the single sanctioned UPDATE) and the successor row + the
   * 'upgraded' event are appended — the PRIOR row's historical identity is
   * preserved exactly. Idempotent per (workspace, idempotencyKey).
   */
  upgradeAppInstall(
    input: {
      /** The lineage's CURRENT selection row. */
      readonly installId: string;
      /** The NEW exact semantic version selected for future invocations. */
      readonly version: string;
      readonly idempotencyKey: string;
      /** SERVER-DERIVED operator identity (the authenticated principal). */
      readonly actorId: string | null;
    },
    provenance: AppInstallProvenance,
  ): Promise<AppInstallOperationOutcome>;

  /**
   * ROLLS BACK the installation: reselects a PREVIOUSLY INSTALLED approved
   * version (a prior — SUPERSEDED — selection row of the SAME lineage) for
   * future invocations WITHOUT rewriting history. The install row must be
   * the lineage's current selection; the target row must belong to the
   * same workspace + app key lineage (foreign/unknown → uniform 404), must
   * be a prior selection (the current row → ConflictError) and its version
   * must still pass the MKT-047 compatibility contract re-run at rollback
   * time (the strictest posture — 422 with the honest reasons, zero rows).
   * The rollback is policy-gated (extension dimension 'rollback' — an
   * explicit recorded allow required) and the grants are re-derived
   * SERVER-SIDE for the reselected version. The append is ONE transaction:
   * the current row is superseded, the successor row (operation
   * 'rollback') + the 'rolled_back' event are appended — every historical
   * row retains its ORIGINAL (app key, version). Idempotent per
   * (workspace, idempotencyKey).
   */
  rollbackAppInstall(
    input: {
      /** The lineage's CURRENT selection row. */
      readonly installId: string;
      /** A PRIOR selection row of the same lineage (the approved version reselected). */
      readonly targetInstallId: string;
      readonly idempotencyKey: string;
      /** SERVER-DERIVED operator identity (the authenticated principal). */
      readonly actorId: string | null;
    },
    provenance: AppInstallProvenance,
  ): Promise<AppInstallOperationOutcome>;

  /**
   * Raw ledger row by id (any status — the append-oriented history stays
   * readable forever). Null when unknown.
   */
  getAppInstall(installId: string): Promise<AppInstallRecord | null>;
  /**
   * The Workspace's FULL install history — every selection row of every
   * lineage (current ACTIVE selections + SUPERSEDED history), ordered
   * lineage-major (app key), selection sequence ascending. The module
   * lists by the server-resolved workspace scope; unknown workspaces
   * surface NotFoundError upstream at the route layer.
   */
  listWorkspaceAppInstalls(workspaceId: string): Promise<readonly AppInstallRecord[]>;
  /**
   * The agency rollup: the CURRENT (ACTIVE) selections across the agency's
   * workspaces, newest first. The agency scope is server-derived from the
   * durable rows themselves (never caller-supplied).
   */
  listAgencyAppInstalls(agencyId: string): Promise<readonly AppInstallRecord[]>;
  /**
   * The append-only lifecycle event tail of one Workspace (oldest first) —
   * the immutable installed/upgraded/rolled_back transition history.
   */
  listWorkspaceAppInstallEvents(workspaceId: string): Promise<readonly AppInstallEventRecord[]>;
}

export interface AppInstallsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Matrix-listed direction (/app-installs ──→ /apps): the App registry
   * authority — exact (app key, version) resolution + the MKT-047
   * compatibility contract. Consumed READ-ONLY through the public
   * contract; the registry is never mutated (composition, not authority
   * transfer).
   */
  readonly apps: AppsModuleApi;
  /**
   * Matrix-listed direction (/app-installs ──→ /policies): the merged
   * execution policy engine — the fail-closed install/upgrade/rollback
   * gate + the per-scope grant evaluations (only explicit recorded
   * allows proceed; every evaluation is recorded append-only).
   */
  readonly policies: PoliciesModuleApi;
  /**
   * Matrix-listed direction (/app-installs ──→ /workspaces), consumed
   * through the narrow canonical-ownership STRUCTURAL PORT (the
   * /deployments precedent — satisfied structurally by the real
   * WorkspacesModuleApi instance at the composition root).
   */
  readonly workspaceOwnership: AppInstallsWorkspaceOwnershipPort;
  /**
   * Matrix-listed direction (/app-installs ──→ /extensions), consumed
   * READ-ONLY through the narrow install-availability STRUCTURAL PORT
   * (adapter-wired at the composition root — the /deployments capability
   * precedent): the workspace's authorized extension versions are the
   * dependency-satisfaction inputs of the compatibility contract.
   */
  readonly extensions: AppInstallsExtensionsPort;
}

export { createAppInstallsModule } from './internal/module.ts';
/**
 * The input guards (selection-input/provenance validation with the §21
 * material-key backstop) and the pure derivation helpers — the §8-style
 * create fingerprint and the policy-action shapes of the gate/grant
 * evaluations — exported for unit tests and future server-side callers
 * (the App SDK / Developer Portal Work Items) so the guard semantics are
 * part of the module contract. Pure functions.
 */
export {
  appInstallCreateFingerprint,
  assertValidAppInstallProvenance,
  assertValidSelectionInput,
  buildInstallGateAction,
  buildScopeGrantAction,
  APP_INSTALLS_MATERIAL_SHAPED_KEYS,
} from './internal/store.ts';
