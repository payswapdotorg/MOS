/**
 * MOS App SDK — the FROZEN RUNTIME COPIES of the /apps registry's closed
 * vocabularies + their meanings (MKT-049; the standalone outbound mirror
 * of the constants exported by src/modules/apps/public.ts).
 *
 * Community developers need these as RUNTIME VALUES (offline reference,
 * scaffolding, validation and docs), so the mirror is not type-only:
 * tests/unit/app-sdk-drift.test.ts asserts EVERY array and EVERY meaning
 * map is DEEP-EQUAL to the authority export — the drift pin that fails
 * when a frozen vocabulary changes without the SDK being regenerated.
 *
 * This file imports NOTHING from the MOS repository (standalone).
 */

import type {
  AppCertificationState,
  AppDataScope,
  AppMeteringDimension,
  AppMutationScope,
  AppRuntimeClass,
  AppSignatureAlgorithm,
  AppUiSurfaceKind,
} from './types.ts';

// --- certification / trust levels -----------------------------------------

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

// --- runtime classes (the closed /executions set, mirrored) ----------------

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

// --- requested data scopes --------------------------------------------------

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

// --- requested mutation scopes ----------------------------------------------

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

// --- UI surface kinds --------------------------------------------------------

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

// --- metering dimensions -----------------------------------------------------

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

// --- signature algorithms (MKT-049) ------------------------------------------

export const APP_SIGNATURE_ALGORITHMS: readonly AppSignatureAlgorithm[] = [
  'manifest-sha256-fingerprint',
];

// --- app-owned state namespaces ----------------------------------------------

/**
 * The SINGULAR AUTHORITIES denylist (spec/frozen-manifest-v1.5.json
 * singularAuthorities): the MOS core-authority namespaces an app-owned
 * state namespace can NEVER claim (app-owned state "must declare an
 * authority scope and may not shadow a MOS core object").
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

// --- material-shaped keys (the §21 backstop vocabulary) ---------------------

/**
 * Material-shaped keys that can never appear in ANY app payload (§21 —
 * secrets never appear in app manifests; credential references are
 * logical names only).
 */
export const APPS_MATERIAL_SHAPED_KEYS = [
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
  'credentialValue',
  'secretValue',
] as const;
