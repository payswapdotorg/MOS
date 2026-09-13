/**
 * MarketingOS module: /apps
 * Authority: App registry — versioned immutable App Version manifests
 * (MKT-047, spec/mos-app-ecosystem-v1.5.md "Manifest";
 * spec/effective-backlog-v1.5.md "expand EXT-001 into immutable App
 * Version manifests"; spec/change-request-005.md #4 "Expand the existing
 * Extension Registry into an App Ecosystem"; spec/architecture-lock-v1.5.md
 * #7 "Apps are versioned composition packages over Extensions, capability
 * contracts, UI surfaces and bounded app-owned state" and #11 "Published
 * App Versions are immutable").
 *
 * This module owns:
 *
 *   - the VERSIONED APP REGISTRY: one immutable row per (app key,
 *     semantic version) — publication is PUBLISHING (the v1.5 App
 *     Ecosystem's frozen model): the manifest content is IMMUTABLE after
 *     publication (re-publishing the same app key + version is rejected
 *     409; a new version is a NEW row — mos-app-ecosystem-v1.5.md
 *     "Upgrade and rollback"; the migration 028 extensions + 030
 *     domain_packs registry precedent, DB-fenced by migration 037);
 *   - the FROZEN MANIFEST SHAPE (mos-app-ecosystem-v1.5.md "Manifest",
 *     verbatim): app key + publisher identity (SERVER-DERIVED — AC-5),
 *     immutable semantic version + compatibility range, capabilities +
 *     capability versions, input/output schemas, requested data scopes,
 *     requested mutation scopes, network destinations, runtime class,
 *     event subscriptions, UI surfaces and routes, configuration schema,
 *     credential references BY NAME ONLY, app-owned state namespaces,
 *     migration version, dependency Apps/Extensions, certification state
 *     (frozen enum — platform territory, born UNVERIFIED), declared
 *     support level and metering dimensions;
 *   - the APP KEY OWNERSHIP lineages: the first publisher of an app key
 *     owns it (the apps table); every version of the key carries the
 *     SAME server-derived publisher (DB-fenced);
 *   - DEPENDENCY VALIDATION at publish (MKT-047 AC-6): dependency
 *     extensions must EXIST in the /extensions registry with a
 *     published version inside the declared compatibility range
 *     (REAL semver comparison); dependency apps must be published
 *     lineages with a version in range; self-dependencies are rejected;
 *     app-owned state namespaces must be namespaced under the app's OWN
 *     key and cannot claim core-authority namespaces (the singular
 *     authorities denylist); requested scopes are validated against the
 *     frozen scope vocabularies;
 *   - the COMPATIBILITY QUERY: given the runtime's platform version +
 *     runtime class + the available extension versions, the eligible
 *     app versions (compatibility range, runtime class and dependency
 *     range checks — the MKT-048 install / MKT-040 deployment-validation
 *     consumption surface).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-047):
 *   - NO app install/upgrade/rollback (MKT-048): workspace-scoped
 *     lifecycle, server-derived grants and version pinning are LATER
 *     Work Items — this registry only PUBLISHES and READS manifests;
 *   - NO App SDK / Developer Portal (MKT-049), NO Marketplace/trust
 *     review surfaces (MKT-050), NO metering ledger (MKT-052) — the
 *     manifest DECLARES certification state, support level and metering
 *     dimensions as metadata only. Certification transitions are
 *     PLATFORM territory: the registry starts every developer publish
 *     at UNVERIFIED and there is NO transition surface here (the
 *     migration-037 immutability trigger rejects UPDATE outright — even
 *     direct SQL cannot forge a certification on a published row);
 *   - NO mutation surface over /extensions whatsoever (architecture-lock
 *     v1.5 #7: composition, not authority transfer): the module imports
 *     NO other module — the extension registry dependency arrives as a
 *     DECLARED STRUCTURAL PORT (AppsExtensionsPort — the MKT-023
 *     structural-port precedent, exactly the /deployments posture)
 *     satisfied structurally by the concrete /extensions module public
 *     contract instance and wired at the composition root. The port is
 *     READ-ONLY (extension version lookups for dependency validation);
 *   - NO secret material, NO tenant identity, NO provenance, NO
 *     lifecycle authority from callers (mos-app-ecosystem-v1.5.md
 *     "Manifest": "No secret material, tenant identity, provenance or
 *     lifecycle authority is supplied by the caller in the manifest"):
 *     the input guards reject authority-shaped keys (publisher spoofing,
 *     tenant/workspace/agency identity, certification, provenance) with
 *     422 and certification-shaped keys with 403 (platform territory),
 *     and every material-shaped key is rejected at every nesting level
 *     (§21/CRED-001 — required credential references are LOGICAL NAMES
 *     ONLY);
 *   - NO workflow/execution/evidence/policy state, NO tenant store, NO
 *     retry engine: Apps are composition packages (architecture-lock
 *     v1.5 #13); every authority stays singular in its existing module.
 *
 * DEPENDENCY POSTURE: the /apps module holds an EMPTY dependency-matrix
 * allowance (the /deployments precedent for modules the frozen matrix
 * does not cover): EVERY consumed contract arrives through DECLARED
 * STRUCTURAL PORTS satisfied structurally by concrete public-contract
 * instances and wired at the composition root — there is NO import of
 * another module anywhere under src/modules/apps (verified by
 * tools/arch-check and tests/architecture/apps-boundary.test.ts). The
 * /extensions registry dependency is a READ-ONLY lookup port; the
 * runtime-class vocabulary is mirrored here (closed set + DB CHECK)
 * because the module may not import the /executions public contract.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// ---------------------------------------------------------------------------
// The frozen certification vocabulary (mos-app-ecosystem-v1.5.md "Trust
// levels"; spec/frozen-manifest-v1.5.json certificationLevels)
// ---------------------------------------------------------------------------

/**
 * The frozen App certification/trust vocabulary:
 * UNVERIFIED → COMMUNITY_VERIFIED → MOS_CERTIFIED. Trust is metadata and
 * a policy input; it NEVER grants authority by itself. Certification
 * transitions are PLATFORM territory (the MKT-050 marketplace/trust
 * surface): the registry starts EVERY developer publish at UNVERIFIED
 * and a developer can never self-certify — the module input guard
 * rejects caller-supplied certification state with 403 (ForbiddenError)
 * and the migration-037 immutability trigger rejects UPDATE outright.
 */
export type AppCertificationState = 'UNVERIFIED' | 'COMMUNITY_VERIFIED' | 'MOS_CERTIFIED';

export const APP_CERTIFICATION_STATES: readonly AppCertificationState[] = [
  'UNVERIFIED',
  'COMMUNITY_VERIFIED',
  'MOS_CERTIFIED',
];

export const APP_CERTIFICATION_STATE_MEANINGS: Readonly<
  Record<AppCertificationState, string>
> = {
  UNVERIFIED: 'no trust review yet — the state every developer publish is born in',
  COMMUNITY_VERIFIED: 'community-reviewed trust metadata (a policy input, never authority)',
  MOS_CERTIFIED: 'platform-certified trust metadata (a policy input, never authority)',
};

// ---------------------------------------------------------------------------
// The frozen runtime-class vocabulary (the closed /executions set,
// mirrored — the module holds no cross-module import allowance)
// ---------------------------------------------------------------------------

/**
 * The closed runtime-class vocabulary (the /executions RuntimeClass set,
 * mirrored here because /apps composes through structural ports only):
 * the runtime substrate the App Version declares; the Execution/Runtime
 * authority decides the actual allocation.
 */
export type AppRuntimeClass =
  | 'pooled-worker'
  | 'ephemeral-sandbox'
  | 'persistent-sandbox'
  | 'dedicated-runtime';

export const APP_RUNTIME_CLASSES: readonly AppRuntimeClass[] = [
  'pooled-worker',
  'ephemeral-sandbox',
  'persistent-sandbox',
  'dedicated-runtime',
];

export const APP_RUNTIME_CLASS_MEANINGS: Readonly<Record<AppRuntimeClass, string>> = {
  'pooled-worker': 'shares a long-lived pooled worker process (the /executions vocabulary)',
  'ephemeral-sandbox': 'runs in a fresh sandbox per invocation (the /executions vocabulary)',
  'persistent-sandbox': 'owns a leased persistent sandbox (the /executions vocabulary)',
  'dedicated-runtime': 'requires a dedicated runtime allocation (the /executions vocabulary)',
};

// ---------------------------------------------------------------------------
// The frozen scope vocabularies (MKT-047 AC-6: "requested scopes validated
// against a frozen scope vocabulary")
// ---------------------------------------------------------------------------

/**
 * The closed REQUESTED-DATA-SCOPE vocabulary: WHAT KIND of owning
 * Client/Workspace data an installed App may resolve (the frozen
 * /extensions data-scope set — the same tenant-data boundary kinds).
 * Scopes never carry tenant identifiers; install-time grants are
 * SERVER-DERIVED and revocable (architecture-lock v1.5 #10 — the
 * MKT-048 surface; v1 declares and validates only).
 */
export type AppDataScope = 'client:read' | 'client:write' | 'workspace:read' | 'workspace:write';

export const APP_DATA_SCOPES: readonly AppDataScope[] = [
  'client:read',
  'client:write',
  'workspace:read',
  'workspace:write',
];

export const APP_DATA_SCOPE_MEANINGS: Readonly<Record<AppDataScope, string>> = {
  'client:read': 'read the owning Client boundary data (the frozen tenant-data kinds)',
  'client:write': 'write app-scoped data inside the owning Client boundary',
  'workspace:read': 'read the owning Workspace boundary data (the frozen tenant-data kinds)',
  'workspace:write': 'write app-scoped data inside the owning Workspace boundary',
};

/**
 * The closed REQUESTED-MUTATION-SCOPE vocabulary: the MOS AUTHORITY
 * surfaces an App's commands may INVOKE — always server-mediated through
 * the existing public contracts (mos-app-ecosystem-v1.5.md "commands that
 * invoke existing MOS authorities"; "Direct database writes to MOS core
 * tables are forbidden"). An App can never declare a direct core-table
 * mutation: every mutation scope is an authority-invocation request the
 * existing gates (policy, scope chains) evaluate fail-closed.
 */
export type AppMutationScope =
  | 'workflow:dispatch'
  | 'execution:request'
  | 'evidence:append'
  | 'metric:append'
  | 'credential:bind';

export const APP_MUTATION_SCOPES: readonly AppMutationScope[] = [
  'workflow:dispatch',
  'execution:request',
  'evidence:append',
  'metric:append',
  'credential:bind',
];

export const APP_MUTATION_SCOPE_MEANINGS: Readonly<Record<AppMutationScope, string>> = {
  'workflow:dispatch':
    'request workflow execution through the /executions authority (never direct workflow-state mutation)',
  'execution:request':
    'request executions through the /executions authority contract',
  'evidence:append':
    'append evidence records through the /evidence authority (server-derived provenance only)',
  'metric:append':
    'append metric observations through the /metrics authority',
  'credential:bind':
    'bind required credential REFERENCES through the /credentials authority (logical name → reference; never material)',
};

// ---------------------------------------------------------------------------
// The frozen UI-surface-kind vocabulary (mos-app-ecosystem-v1.5.md
// "UI and developer model"; architecture-lock v1.5 #12: UI is
// presentation only)
// ---------------------------------------------------------------------------

/**
 * The closed UI-surface-kind vocabulary of mos-app-ecosystem-v1.5.md
 * "UI and developer model": "Apps may contribute command-center cards,
 * client-room panels, workspace tabs, report pages, editor panes and
 * action menus." UI is presentation only and invokes server
 * capabilities for mutations.
 */
export type AppUiSurfaceKind =
  | 'command-center-card'
  | 'client-room-panel'
  | 'workspace-tab'
  | 'report-page'
  | 'editor-pane'
  | 'action-menu';

export const APP_UI_SURFACE_KINDS: readonly AppUiSurfaceKind[] = [
  'command-center-card',
  'client-room-panel',
  'workspace-tab',
  'report-page',
  'editor-pane',
  'action-menu',
];

export const APP_UI_SURFACE_KIND_MEANINGS: Readonly<Record<AppUiSurfaceKind, string>> = {
  'command-center-card': 'a card on the Agency Command Center surface',
  'client-room-panel': 'a panel in the Client Decision Room surface',
  'workspace-tab': 'a tab in the Goal/Strategy/Playbook workspace',
  'report-page': 'a report page surface',
  'editor-pane': 'an editor pane surface (e.g. spreadsheet editing)',
  'action-menu': 'an action-menu entry invoking a server capability',
};

// ---------------------------------------------------------------------------
// The frozen metering-dimension vocabulary (mos-app-ecosystem-v1.5.md
// "Economics")
// ---------------------------------------------------------------------------

/**
 * The closed metering-dimension vocabulary of mos-app-ecosystem-v1.5.md
 * "Economics": "MOS may meter installations, invocation count,
 * compute/runtime, data volume and premium capabilities." MKT-052 owns
 * the metering ledger; the v1 manifest DECLARES dimensions only.
 */
export type AppMeteringDimension =
  | 'installations'
  | 'invocations'
  | 'compute-runtime'
  | 'data-volume'
  | 'premium-capabilities';

export const APP_METERING_DIMENSIONS: readonly AppMeteringDimension[] = [
  'installations',
  'invocations',
  'compute-runtime',
  'data-volume',
  'premium-capabilities',
];

export const APP_METERING_DIMENSION_MEANINGS: Readonly<Record<AppMeteringDimension, string>> = {
  installations: 'meter the number of active installations',
  invocations: 'meter the app capability invocation count',
  'compute-runtime': 'meter compute/runtime consumption',
  'data-volume': 'meter data volume consumption',
  'premium-capabilities': 'meter premium capability usage',
};

// ---------------------------------------------------------------------------
// The app-owned state-namespace contract (mos-app-ecosystem-v1.5.md
// "Bounded app state"; architecture-lock v1.5 #9)
// ---------------------------------------------------------------------------

/**
 * The SINGULAR AUTHORITIES denylist (spec/frozen-manifest-v1.5.json
 * singularAuthorities): the MOS core-authority namespaces an app-owned
 * state namespace can NEVER claim. App-owned state "must declare an
 * authority scope and may not shadow a MOS core object" — an app-owned
 * spreadsheet-document namespace is valid; an app-owned competing
 * Workflow state machine is not.
 */
export const APP_CORE_AUTHORITY_NAMESPACES: readonly string[] = [
  'client',
  'workspace',
  'goal',
  'playbook',
  'deployment',
  'workflow',
  'task',
  'execution',
  'evidence',
  'experiment',
  'learning',
  'policy',
  'credential',
  'job',
];

/** The structural namespace pattern: app:<owning app key>:<local>. */
export const APP_STATE_NAMESPACE_PATTERN = /^app:[a-z][a-z0-9-]{1,62}:[a-z][a-z0-9-]{1,30}$/;

// ---------------------------------------------------------------------------
// The manifest contract (mos-app-ecosystem-v1.5.md "Manifest" — verbatim)
// ---------------------------------------------------------------------------

/** One declared capability: bounded name + capability version (semver). */
export interface AppCapabilityDeclaration {
  readonly name: string;
  readonly version: string;
}

/** One declared network destination (egress target — policy-gated at use). */
export interface AppNetworkDestination {
  readonly host: string;
  readonly protocol: string;
  readonly port: number;
  readonly reason: string;
}

/** One declared UI surface: closed surface kind + bounded route. */
export interface AppUiSurfaceDeclaration {
  readonly surface: AppUiSurfaceKind;
  readonly route: string;
}

/** One configuration-field contract used to validate install configuration. */
export interface AppConfigFieldContract {
  readonly type: 'string' | 'number' | 'boolean' | 'object';
  readonly required: boolean;
  readonly description: string;
  readonly pattern: string | null;
}

/**
 * One declared dependency (an Extension or an App) with its declared
 * compatibility range (inclusive semver bounds). Extension dependencies
 * reference a (publisher, extensionKey) lineage of the /extensions
 * registry; App dependencies reference a published app key. The
 * dependency is valid at publish when the referenced lineage has at
 * least one PUBLISHED version inside the range (MKT-047 AC-6); a
 * self-dependency (the app's own key) is rejected.
 */
export interface AppDependencyDeclaration {
  readonly kind: 'extension' | 'app';
  /** The dependency extension's publisher (extension dependencies only). */
  readonly publisher: string | null;
  /** The dependency extension key / app key. */
  readonly key: string;
  readonly minVersion: string;
  readonly maxVersion: string;
}

/**
 * The DECLARED App Version manifest (the caller-suppliable content —
 * mos-app-ecosystem-v1.5.md "Manifest"): everything EXCEPT the
 * server-derived authority fields. PUBLISHER IDENTITY and CERTIFICATION
 * STATE are deliberately NOT manifest-input fields:
 *   - the publisher identity is SERVER-DERIVED from the authenticated
 *     platform developer (AC-5 — the MKT-032 platform_developer role
 *     precedent) and carried by the published record;
 *   - the certification state is PLATFORM TERRITORY (born UNVERIFIED
 *     on every publish; a caller-supplied value is rejected 403);
 *   - no secret material, tenant identity, provenance or lifecycle
 *     authority may appear anywhere in the manifest (guards reject
 *     authority-shaped and material-shaped keys; §21/CRED-001).
 * IMMUTABLE once published: re-publishing the same (app key, version)
 * is rejected 409; semantic change publishes a NEW version.
 */
export interface AppManifest {
  readonly appKey: string;
  /** The immutable semantic version of THIS App Version. */
  readonly version: string;
  /** Platform compatibility range (inclusive semver bounds). */
  readonly compatibility: {
    readonly minPlatform: string;
    readonly maxPlatform: string;
  };
  /** Capabilities + capability versions (bounded, unique names). */
  readonly capabilities: readonly AppCapabilityDeclaration[];
  /** Input/output schemas (bounded JSON objects). */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  /** Requested data scopes (closed vocabulary). */
  readonly dataScopes: readonly AppDataScope[];
  /** Requested mutation scopes (closed vocabulary). */
  readonly mutationScopes: readonly AppMutationScope[];
  /** Network destinations (policy-gated at use, not here). */
  readonly networkDestinations: readonly AppNetworkDestination[];
  /** Runtime class (closed vocabulary — the /executions set, mirrored). */
  readonly runtimeClass: AppRuntimeClass;
  /** Event subscriptions (bounded unique labels). */
  readonly eventSubscriptions: readonly string[];
  /** UI surfaces and routes (closed surface-kind vocabulary). */
  readonly uiSurfaces: readonly AppUiSurfaceDeclaration[];
  /** Configuration schema (field contracts — validated at install time). */
  readonly configSchema: Readonly<Record<string, AppConfigFieldContract>>;
  /** Credential references required BY LOGICAL NAME ONLY (never values). */
  readonly requiredCredentialNames: readonly string[];
  /** App-owned state namespaces (namespaced; core-authority denylist). */
  readonly stateNamespaces: readonly string[];
  /** The app's own storage migration version. */
  readonly migrationVersion: number;
  /** Dependency Apps/Extensions with compatibility ranges. */
  readonly dependencies: readonly AppDependencyDeclaration[];
  /** Declared support level (bounded publisher-declared label). */
  readonly supportLevel: string;
  /** Metering dimensions (closed economics vocabulary). */
  readonly meteringDimensions: readonly AppMeteringDimension[];
}

/**
 * One immutable REGISTRY row (a published App Version) — the read model.
 * `publisher` and `certificationState` are SERVER-DERIVED: the publisher
 * is the authenticated platform developer (or the internal service
 * principal) that published THIS version; the certification state is
 * born UNVERIFIED and is platform territory (MKT-050 owns transitions —
 * the migration-037 trigger rejects UPDATE outright).
 */
export interface AppVersionRecord {
  readonly appVersionId: string;
  readonly appKey: string;
  /** SERVER-DERIVED publisher identity: 'dev:<userId>' | 'svc:<label>'. */
  readonly publisher: string;
  readonly manifest: AppManifest;
  /** PLATFORM TERRITORY: born UNVERIFIED on every developer publish. */
  readonly certificationState: AppCertificationState;
  /** The §8-style logical publish command key (convergence proof). */
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// The server-derived publisher identity (MKT-047 AC-5)
// ---------------------------------------------------------------------------

/**
 * The SERVER-DERIVED publisher identity of a publish: the authenticated
 * platform developer (the MKT-032 extension-portal platform_developer
 * role precedent) or the internal service principal. Derived at the
 * ROUTE layer from the authenticated principal — NEVER a request field;
 * the store serializes it as 'dev:<userId>' | 'svc:<label>'.
 */
export type AppPublisherIdentity =
  | { readonly kind: 'platform_developer'; readonly userId: string }
  | { readonly kind: 'platform_service'; readonly label: string };

/** Pure: serialize the server-derived publisher identity string. */
export function appPublisherIdentityString(identity: AppPublisherIdentity): string {
  return identity.kind === 'platform_developer' ? `dev:${identity.userId}` : `svc:${identity.label}`;
}

// ---------------------------------------------------------------------------
// The /extensions structural port (the MKT-023 structural-port precedent —
// composition over the /extensions authority via PUBLIC-contract-shaped
// DATA only; ZERO imports of extensions internals)
// ---------------------------------------------------------------------------

/**
 * The narrow READ-ONLY structural view of an /extensions registry row the
 * App registry composes over for dependency validation. TypeScript
 * structural typing: the concrete /extensions public-contract instance
 * satisfies this view WITHOUT any module import (the /deployments
 * posture — wired at the composition root).
 */
export interface AppExtensionView {
  readonly extensionId: string;
  readonly manifest: {
    readonly extensionKey: string;
    readonly publisher: string;
    readonly version: string;
  };
}

/**
 * The READ-ONLY /extensions registry port: extension-version lookups for
 * App dependency validation (existence + compatibility-range checks).
 * The App registry composes OVER the /extensions authority through this
 * port only — it adds NO mutation surface over extensions (composition,
 * not authority transfer — architecture-lock v1.5 #7).
 */
export interface AppsExtensionsPort {
  /** One extension version by registry id (null when unknown). */
  getExtensionVersion(extensionId: string): Promise<AppExtensionView | null>;
  /** The published versions of one extension key, newest first. */
  listExtensionVersions(input: {
    readonly extensionKey: string | null;
  }): Promise<readonly AppExtensionView[]>;
}

// ---------------------------------------------------------------------------
// The compatibility query (MKT-047 AC-8)
// ---------------------------------------------------------------------------

/** One extension version available in the target environment. */
export interface AppQueryExtensionVersion {
  readonly publisher: string;
  readonly extensionKey: string;
  readonly version: string;
}

/** The runtime/environment inputs of the compatibility query. */
export interface AppCompatibilityQuery {
  /** The target platform version (the app's range must contain it). */
  readonly platformVersion: string;
  /** Optional runtime-class filter (the closed vocabulary). */
  readonly runtimeClass: AppRuntimeClass | null;
  /**
   * The extension versions available in the target environment: every
   * declared extension dependency must be satisfied by at least one of
   * them (the dependency range must contain a provided version of the
   * declared publisher + key).
   */
  readonly extensionVersions: readonly AppQueryExtensionVersion[];
}

/** One ineligible app version with its honest ineligibility reasons. */
export interface AppIneligibleVersion {
  readonly record: AppVersionRecord;
  readonly reasons: readonly string[];
}

/** The compatibility-query result: eligible versions + honest reasons. */
export interface AppCompatibilityReport {
  readonly eligible: readonly AppVersionRecord[];
  readonly ineligible: readonly AppIneligibleVersion[];
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface AppsModuleApi {
  /**
   * PUBLISHES one immutable App Version (the only registry creation
   * path). The full frozen manifest shape guard runs BEFORE any write
   * (closed vocabularies, namespaced app-owned state namespaces with the
   * core-authority denylist, §21 material-key backstop, authority-shaped
   * key rejection — 422 — and certification-shaped key rejection — 403,
   * platform territory). DEPENDENCY VALIDATION (AC-6) then resolves
   * every declared dependency extension through the /extensions
   * structural port (must EXIST with a published version inside the
   * declared range — REAL semver comparison) and every dependency app
   * against this registry (must be a published lineage with a version
   * in range; self-dependencies rejected). PUBLISHER IDENTITY is
   * SERVER-DERIVED from `identity` (the authenticated platform
   * developer / service principal) and the certification state is born
   * UNVERIFIED. The (app key, version) pair is DB-fenced IMMUTABLE:
   * re-publishing is a ConflictError; a new version is a new row. A
   * publish under an app key owned by ANOTHER publisher is a
   * ConflictError (the key-lineage fence). `idempotencyKey` is a
   * server-side logical command identity only.
   */
  publishAppVersion(input: {
    readonly manifest: AppManifest;
    readonly identity: AppPublisherIdentity;
    readonly idempotencyKey: string;
  }): Promise<AppVersionRecord>;
  /** Raw registry row by id — immutable history is always readable. */
  getAppVersion(appVersionId: string): Promise<AppVersionRecord | null>;
  /** The registry row for an EXACT (app key, semantic version) pair. */
  findAppVersion(appKey: string, version: string): Promise<AppVersionRecord | null>;
  /** Registry listing (optionally narrowed to one app key), newest first. */
  listAppVersions(input: {
    readonly appKey: string | null;
  }): Promise<readonly AppVersionRecord[]>;

  /**
   * The COMPATIBILITY QUERY (AC-8): given the runtime's platform version,
   * an optional runtime class and the available extension versions, the
   * report lists the ELIGIBLE app versions (compatibility range contains
   * the platform version; runtime class matches when provided; every
   * declared extension dependency is satisfied by a provided extension
   * version inside the dependency range; every declared app dependency
   * has a published version in range) and every INELIGIBLE version with
   * its honest reasons (the deployment-validation honest-report
   * posture). Pure read: no state changes.
   */
  queryCompatibleAppVersions(query: AppCompatibilityQuery): Promise<AppCompatibilityReport>;
}

export interface AppsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The /extensions structural port (READ-ONLY): dependency-extension
   * existence + range validation compose over the /extensions authority
   * through this narrow view of its public contract — wired at the
   * composition root, never imported here.
   */
  readonly extensions: AppsExtensionsPort;
}

export { createAppsModule } from './internal/module.ts';
/**
 * The input guards (manifest shape/vocabulary validation, the
 * authority-shaped-key rejection contract with the 403
 * certification-territory rule, the §21 material-key backstop), the REAL
 * semver comparator, the compatibility-range matcher, the
 * state-namespace denylist predicate and the create fingerprint —
 * exported for unit tests and future server-side callers (the App SDK
 * / Developer Portal Work Items) so the guard semantics are part of the
 * module contract. Pure functions.
 */
export {
  compareSemver,
  appVersionInRange,
  isLegalAppStateNamespace,
  assertValidAppManifest,
  assertValidCompatibilityQuery,
  appCreateFingerprint,
  APPS_MATERIAL_SHAPED_KEYS,
  appDependenciesValid,
} from './internal/store.ts';
