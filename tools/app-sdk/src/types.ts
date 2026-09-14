/**
 * MOS App SDK — the frozen-mirror TypeScript types of the /apps (and, for
 * read-model awareness, /app-installs) PUBLIC contracts
 * (MKT-049, spec/mos-app-ecosystem-v1.5.md "UI and developer model":
 * "Community developers receive SDKs generated from stable capability
 * contracts"; spec/effective-backlog-v1.5.md MKT-049).
 *
 * THIS FILE IS THE OUTBOUND ARTIFACT: it imports NOTHING from the MOS
 * repository source (standalone — copy tools/app-sdk/src out of the repo
 * and it keeps working). It is a HAND-FROZEN MIRROR of
 * src/modules/apps/public.ts (+ the /app-installs read-model types),
 * kept honest by the DRIFT TESTS in tests/unit/app-sdk-drift.test.ts:
 *
 *   - TYPE-level pins (compile-time): the mirror types are asserted
 *     EQUAL to the authority types — `npm run typecheck` FAILS when the
 *     public contract changes shape without the SDK being regenerated;
 *   - RUNTIME pins: the frozen vocabulary arrays (vocabularies.ts) are
 *     asserted DEEP-EQUAL to the authority exports.
 *
 * Regeneration contract: when the /apps public contract changes, update
 * this mirror (and vocabularies.ts / semver.ts / fingerprint.ts /
 * validate.ts) in the SAME change — the drift tests fail otherwise
 * ("a drift test that fails when the public contract changes without the
 * SDK being regenerated" — the MKT-049 dispatch AC-1).
 */

// ---------------------------------------------------------------------------
// The frozen certification vocabulary (mos-app-ecosystem-v1.5.md
// "Trust levels": UNVERIFIED → COMMUNITY_VERIFIED → MOS_CERTIFIED)
// ---------------------------------------------------------------------------

export type AppCertificationState = 'UNVERIFIED' | 'COMMUNITY_VERIFIED' | 'MOS_CERTIFIED';

// ---------------------------------------------------------------------------
// The frozen runtime-class vocabulary (the closed /executions set)
// ---------------------------------------------------------------------------

export type AppRuntimeClass =
  | 'pooled-worker'
  | 'ephemeral-sandbox'
  | 'persistent-sandbox'
  | 'dedicated-runtime';

// ---------------------------------------------------------------------------
// The frozen scope vocabularies (the closed data/mutation sets)
// ---------------------------------------------------------------------------

export type AppDataScope = 'client:read' | 'client:write' | 'workspace:read' | 'workspace:write';

export type AppMutationScope =
  | 'workflow:dispatch'
  | 'execution:request'
  | 'evidence:append'
  | 'metric:append'
  | 'credential:bind';

// ---------------------------------------------------------------------------
// The frozen UI-surface-kind vocabulary (mos-app-ecosystem-v1.5.md
// "UI and developer model": command-center cards, client-room panels,
// workspace tabs, report pages, editor panes, action menus —
// presentation only; architecture-lock v1.5 #12)
// ---------------------------------------------------------------------------

export type AppUiSurfaceKind =
  | 'command-center-card'
  | 'client-room-panel'
  | 'workspace-tab'
  | 'report-page'
  | 'editor-pane'
  | 'action-menu';

// ---------------------------------------------------------------------------
// The frozen metering-dimension vocabulary (mos-app-ecosystem-v1.5.md
// "Economics")
// ---------------------------------------------------------------------------

export type AppMeteringDimension =
  | 'installations'
  | 'invocations'
  | 'compute-runtime'
  | 'data-volume'
  | 'premium-capabilities';

// ---------------------------------------------------------------------------
// The frozen signature-algorithm vocabulary (MKT-049 — the optional
// publish-envelope hash attestation)
// ---------------------------------------------------------------------------

export type AppSignatureAlgorithm = 'manifest-sha256-fingerprint';

export interface AppManifestSignature {
  readonly algorithm: AppSignatureAlgorithm;
  readonly digest: string;
}

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
 * registry; App dependencies reference a published app key. A
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
 * STATE are deliberately NOT manifest-input fields (server-derived /
 * platform territory). IMMUTABLE once published: re-publishing the same
 * (app key, version) is rejected 409; semantic change publishes a NEW
 * version.
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
  /** Network destinations (policy-gated at use, not at publish). */
  readonly networkDestinations: readonly AppNetworkDestination[];
  /** Runtime class (closed vocabulary — the /executions set). */
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
 * One immutable REGISTRY row (a published App Version) — the read model
 * as the Developer Portal / registry routes serialize it. `publisher`
 * and `certificationState` are SERVER-DERIVED (never request fields).
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
  /**
   * The canonical-manifest sha256 fingerprint — the SAME value the
   * optional publish signature must attest (manifest-sha256-fingerprint);
   * persisted on the immutable row, so a signed publish's attested digest
   * is verifiable FOREVER offline (compute it again and compare).
   */
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// The compatibility query (the /apps registry public query contract)
// ---------------------------------------------------------------------------

/** One extension version available in the target environment. */
export interface AppQueryExtensionVersion {
  readonly publisher: string;
  readonly extensionKey: string;
  readonly version: string;
}

/** The runtime/environment inputs of the compatibility query. */
export interface AppCompatibilityQuery {
  readonly platformVersion: string;
  readonly runtimeClass: AppRuntimeClass | null;
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
// The server-derived publisher identity (for SDK tooling labels only —
// the identity itself is ALWAYS derived server-side, never a request)
// ---------------------------------------------------------------------------

export type AppPublisherIdentity =
  | { readonly kind: 'platform_developer'; readonly userId: string }
  | { readonly kind: 'platform_service'; readonly label: string };

// ---------------------------------------------------------------------------
// The /app-installs read-model types (MKT-048 — what an installed app
// looks like on a workspace; read-model awareness for community
// developers building install-aware tooling. The install/upgrade/rollback
// mutations are workspace-admin surfaces, NOT part of the SDK client.)
// ---------------------------------------------------------------------------

export type AppInstallOperation = 'install' | 'upgrade' | 'rollback';

export type AppInstallStatus = 'ACTIVE' | 'SUPERSEDED';

/** One persisted install-ledger row — one EXACT-VERSION selection. */
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
  readonly policyDecisionId: string | null;
  readonly selectionSeq: number;
  readonly status: AppInstallStatus;
  readonly supersededAt: string | null;
  readonly installedBy: string | null;
  readonly installedAt: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
}

// ---------------------------------------------------------------------------
// SDK-specific result types
// ---------------------------------------------------------------------------

/**
 * The offline manifest-validation verdict (the SDK mirror of the registry
 * guard — see validate.ts): `rejectionClass` mirrors the registry's error
 * mapping — certification-shaped keys are PLATFORM TERRITORY (the
 * registry answers 403), every other violation is 422-invalid.
 */
export interface AppManifestValidationResult {
  readonly valid: boolean;
  readonly problems: readonly string[];
  readonly rejectionClass: 'certification-territory' | 'invalid' | null;
  /** The error summary the registry would surface (null when valid). */
  readonly summary: string | null;
}

/** The per-file verdict of the project validator (validate.ts). */
export interface AppProjectValidationResult {
  readonly valid: boolean;
  /** Every problem, file-prefixed, developer-readable. */
  readonly problems: readonly string[];
  /** The raw manifest-level verdict (drift-test comparable). */
  readonly manifest: AppManifestValidationResult;
}
