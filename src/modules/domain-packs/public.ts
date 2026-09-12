/**
 * MarketingOS module: /domain-packs
 * Authority: Domain Pack registry/composition authority (spec/
 * module-dependency-v1.3.md: "/domain-packs is the registry/composition
 * authority for installed Domain Pack versions"; spec/
 * implementation-contract.md §1).
 *
 * MKT-036 implements this authority (PACK-001 — "Provide versioned Domain
 * Packs that specialize MarketingOS without creating alternate platform
 * authorities"; dependencies PLAY-001, WF-001, EXT-001 per
 * requirements-v1.3.md). This module owns:
 *
 *   - the VERSIONED DOMAIN PACK REGISTRY: one immutable row per
 *     (publisher, pack key, version) — publication is the frozen
 *     domain-pack-v1.3.md §4 rule: "Pack versions are immutable once
 *     published ... A new version is required for semantic change" (the
 *     playbook-versioning and extension-registry precedent);
 *   - the PACK MANIFEST CONTRACT (domain-pack-v1.3.md §2): identity
 *     (pack key, publisher, version), display metadata, the platform
 *     compatibility range, declared pack dependencies, and the ARTIFACT
 *     DECLARATIONS — the closed 14-kind vocabulary that mirrors §2's
 *     allowed list (domain entities/views; goals and metrics;
 *     playbooks and workflow templates; AI capability definitions;
 *     human-agent capability profiles; policies; integration/extension
 *     bindings; evidence schemas/evaluators; UI surfaces). Every
 *     artifact carries the §5 EXPLICIT SCOPE distinction:
 *     'client' (pack-owned Client-scoped data — the default) or
 *     'agency-reusable' (an explicitly-declared Agency-scoped reusable
 *     artifact such as a playbook template);
 *   - WORKFLOW-TEMPLATE CONFORMANCE (implementation-contract §4): every
 *     'workflow-template' artifact payload is validated at publish
 *     through the /workflows authority's own definition-content
 *     validator (validateWorkflowDefinitionContent — imported from the
 *     /workflows PUBLIC contract, the matrix-allowed dependency). Pack
 *     workflow templates are DATA conforming to the frozen §4 contract;
 *     they materialize as Workflow Definitions ONLY through the
 *     /workflows authority and execute ONLY through the existing
 *     /workflows + /executions authorities — this module has NO
 *     execution path of its own (domain-pack-v1.3.md §3);
 *   - the INSTALLED-VERSION RECORDS (domain-pack-v1.3.md §4: "Installed
 *     Pack versions are recorded with the Workspace/Client context in
 *     which they are active"): installation records a specific published
 *     pack version against the authorized Workspace/Client context,
 *     with the scope SERVER-SUPPLIED by the caller (resolved from
 *     durable canonical ownership BEFORE authorize/execute — the
 *     /extensions scope-as-data posture) and re-fenced by the
 *     migration-030 scope-chain triggers. PACK-AC-01 is the
 *     DB/integration proof. Dependency checks run at publish and
 *     install: a self-dependency is rejected at publish; every declared
 *     dependency must be a PUBLISHED pack version at install
 *     (work-item-v1.3-overrides.md MKT-036 "dependency/compatibility
 *     checks");
 *   - the ARTIFACT SCOPE RECORDS (domain-pack-v1.3.md §5 / PACK-AC-03):
 *     installation MATERIALIZES one scope record per declared artifact
 *     against the installing context. A 'client' artifact record is
 *     confined to the installing Client boundary (client_id NOT NULL —
 *     pack-owned Client data cannot cross Client boundaries; cross-client
 *     aggregation requires explicit governance and is not implemented).
 *     An 'agency-reusable' artifact record is client-less (agency_id
 *     only) and reachable within its agency. The distinction is
 *     explicit in the manifest, in the records and in every query
 *     (the agency listing returns ONLY 'agency-reusable' records).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-036):
 *   - NO specific business pack (the Creator Operations pack is
 *     MKT-037; Performance Marketing/Field Acquisition arrive later) —
 *     this is the GENERIC, provider-neutral FRAMEWORK any pack
 *     registers through;
 *   - NO pack execution engine: pack workflows EXECUTE only through the
 *     existing /workflows + /executions authorities (domain-pack §3/§6)
 *     — there is no run/start/dispatch/instance surface here, no
 *     workflow-state mutation, no Execution creation, no Task creation;
 *   - NO AI routing (the /ai-runtime authority), NO credential anything
 *     (the /credentials authority — pack manifests declare artifacts,
 *     never secret material), NO evidence creation (the /evidence
 *     authority records evidence; pack 'evidence-schema' artifacts are
 *     DECLARATIONS), NO Job assignment (the /jobs authority);
 *   - NO second tenant, permission or audit authority: installation
 *     authorization stays exactly the /agencies membership authority
 *     composed with canonical /workspaces owner resolution at the route
 *     layer; /audit is wired at the ROUTE layer (recordMutationAudit —
 *     the same posture as every module);
 *   - NO UI, NO provider SDKs (domain-pack-v1.3.md §7: provider-specific
 *     implementations remain integration adapters or extensions).
 *
 * DEPENDENCY POSTURE (frozen matrix: /domain-packs ──→ /agencies,
 * /clients, /workspaces, /goals, /playbooks, /workflows, /executions,
 * /agents, /jobs, /evidence, /metrics, /experiments, /learnings,
 * /extensions, /policies, /audit): this public entry imports the
 * /workflows public contract ONLY — and ONLY its PURE §4 definition
 * validator (pack workflow-template conformance is validated by the
 * Workflow authority's own contract; PACK-AC-02). Every other matrix
 * allowance stays deliberately unused at module level: the install scope
 * arrives as SERVER-DERIVED data from the routes (scope-as-data — the
 * /extensions precedent), and runtime composition with the Execution,
 * Evidence, AI Router, Credential, Policy and Audit authorities happens
 * when pack workflows EXECUTE through /workflows + /executions, never
 * inside the framework.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// ---------------------------------------------------------------------------
// The artifact-kind vocabulary (domain-pack-v1.3.md §2 — the closed set)
// ---------------------------------------------------------------------------

/**
 * The closed artifact-kind vocabulary of domain-pack-v1.3.md §2 ("A
 * Domain Pack may provide: domain-specific entities and views; goals and
 * metrics; playbooks and workflow templates; AI capability definitions;
 * human-agent capability profiles; policies; integration/extension
 * bindings; evidence schemas and evaluators; UI surfaces"). Every
 * manifest artifact declares exactly one kind; a kind outside this list
 * is an INVALID DECLARATION rejected at publication. Kind is a code +
 * DB CHECK, never a caller freedom.
 */
export type DomainPackArtifactKind =
  | 'domain-entity' // domain-specific entities (§2 "domain-specific entities")
  | 'view' // domain-specific views (§2 "and views")
  | 'goal-definition' // goals (§2 "goals and metrics")
  | 'metric-definition' // metrics (§2 "goals and metrics")
  | 'playbook-template' // playbooks (§2 "playbooks and workflow templates")
  | 'workflow-template' // workflow templates (§2 "playbooks and workflow templates")
  | 'ai-capability' // AI capability definitions (§2)
  | 'human-capability' // human-agent capability profiles (§2)
  | 'policy' // policies (§2)
  | 'integration-binding' // integration bindings (§2 "integration/extension bindings")
  | 'extension-binding' // extension bindings (§2 "integration/extension bindings")
  | 'evidence-schema' // evidence schemas (§2 "evidence schemas and evaluators")
  | 'evaluator' // evaluators (§2 "evidence schemas and evaluators")
  | 'ui-surface'; // UI surfaces (§2)

export const DOMAIN_PACK_ARTIFACT_KINDS: readonly DomainPackArtifactKind[] = [
  'domain-entity',
  'view',
  'goal-definition',
  'metric-definition',
  'playbook-template',
  'workflow-template',
  'ai-capability',
  'human-capability',
  'policy',
  'integration-binding',
  'extension-binding',
  'evidence-schema',
  'evaluator',
  'ui-surface',
];

/** Interpretable meaning of every artifact kind (traceability). */
export const DOMAIN_PACK_ARTIFACT_KIND_MEANINGS: Readonly<
  Record<DomainPackArtifactKind, string>
> = {
  'domain-entity': 'domain-specific entity declarations of the vertical (§2)',
  view: 'domain-specific view declarations of the vertical (§2)',
  'goal-definition': 'goal definitions the pack specializes (§2 goals)',
  'metric-definition': 'metric definitions the pack specializes (§2 metrics)',
  'playbook-template': 'playbook templates for the vertical (§2 playbooks)',
  'workflow-template':
    'workflow templates conforming to the /workflows §4 definition contract — executed ONLY through the existing Workflow/Execution authorities (§2/§3/§6)',
  'ai-capability':
    'AI capability declarations — routed ONLY through the /ai-runtime AI Router at execution time (§2/§3)',
  'human-capability':
    'human-agent capability profiles — served ONLY through the existing Job/Task/Execution authorities (§2/§3)',
  policy:
    'policy declarations consumed through the /policies authority — the pack never evaluates policy itself (§2/§3)',
  'integration-binding':
    'provider-neutral integration capability bindings (§2; provider implementations stay integration adapters)',
  'extension-binding':
    'extension version bindings resolved through the /extensions registry/install lifecycle (§2/§3)',
  'evidence-schema':
    'evidence schema declarations — evidence records flow ONLY through the /evidence authority (§2/§3)',
  evaluator: 'evaluator declarations for evidence/quality evaluation (§2)',
  'ui-surface': 'UI surface declarations the pack contributes (§2)',
};

// ---------------------------------------------------------------------------
// The artifact scope vocabulary (domain-pack-v1.3.md §5 — PACK-AC-03)
// ---------------------------------------------------------------------------

/**
 * The closed artifact-scope vocabulary of domain-pack-v1.3.md §5
 * ("Pack-owned data is Client-scoped unless the pack contract explicitly
 * declares an Agency-scoped reusable artifact such as a playbook
 * template. Cross-client aggregation requires an explicit
 * privacy/governance policy"):
 *
 *   - 'client': pack-owned Client-scoped data (the DEFAULT — confined to
 *     the installing Client hard boundary; never crosses Client
 *     boundaries);
 *   - 'agency-reusable': an EXPLICITLY-declared Agency-scoped reusable
 *     artifact (e.g. a playbook template) — reachable within the
 *     installing agency.
 *
 * Cross-client aggregation is NOT expressible through this vocabulary at
 * all (it would require the explicit governance policy of §5 — out of
 * scope for the framework).
 */
export type DomainPackArtifactScope = 'client' | 'agency-reusable';

export const DOMAIN_PACK_ARTIFACT_SCOPES: readonly DomainPackArtifactScope[] = [
  'client',
  'agency-reusable',
];

export const DOMAIN_PACK_ARTIFACT_SCOPE_MEANINGS: Readonly<
  Record<DomainPackArtifactScope, string>
> = {
  client: 'pack-owned Client-scoped data — confined to the installing Client boundary (§5 default)',
  'agency-reusable':
    'explicitly-declared Agency-scoped reusable artifact — reachable within the installing agency (§5)',
};

// ---------------------------------------------------------------------------
// The manifest contract (domain-pack-v1.3.md §2 + §4 + §5)
// ---------------------------------------------------------------------------

/**
 * One declared artifact: kind (closed §2 set), bounded name (unique
 * within its kind in the manifest), description, the §5 EXPLICIT scope
 * (closed two-value set), and the kind-specific payload — a bounded
 * JSON object. 'workflow-template' payloads MUST satisfy the frozen
 * /workflows §4 definition-content contract (validated through the
 * /workflows authority's own validator at publication — the framework
 * has no workflow engine, §3). All payloads carry the §21 material-key
 * backstop: secrets never appear in pack declarations.
 */
export interface DomainPackArtifactDeclaration {
  readonly kind: DomainPackArtifactKind;
  readonly name: string;
  readonly description: string;
  readonly scope: DomainPackArtifactScope;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * One declared pack dependency: an EXACT published (publisher, pack key,
 * version) reference. Validated at publish (no self-dependency) and at
 * install (every dependency must be a published pack version) — the
 * MKT-036 "dependency/compatibility checks".
 */
export interface DomainPackRequiredPack {
  readonly publisher: string;
  readonly packKey: string;
  readonly version: string;
}

/**
 * The versioned Domain Pack manifest (domain-pack-v1.3.md §2 — the
 * allowed artifact list; §4 — immutable after publication; §5 — the
 * explicit artifact scope distinction). IMMUTABLE once published:
 * re-publication of the same (publisher, packKey, version) is rejected;
 * semantic change publishes a NEW version.
 */
export interface DomainPackManifest {
  readonly packKey: string;
  readonly publisher: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  /** Platform compatibility range (inclusive labels; catalog data). */
  readonly compatibility: {
    readonly minPlatform: string;
    readonly maxPlatform: string;
  };
  /** Declared pack dependencies (exact published version references). */
  readonly requiredPacks: readonly DomainPackRequiredPack[];
  /** The §2 artifact declarations, each carrying the §5 explicit scope. */
  readonly artifacts: readonly DomainPackArtifactDeclaration[];
}

/** One immutable REGISTRY row (a published Domain Pack version). */
export interface DomainPackRegistryRecord {
  readonly packId: string;
  readonly manifest: DomainPackManifest;
  /** The §8-style logical publish command key (convergence proof). */
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Installation lifecycle (domain-pack-v1.3.md §4 — installed-version records)
// ---------------------------------------------------------------------------

/**
 * The frozen Domain Pack INSTALL lifecycle. The frozen pack contract
 * records installed versions "with the Workspace/Client context in which
 * they are active"; the framework lifecycle is deliberately minimal:
 *
 *   installed  → disabled | uninstalled
 *   disabled   → installed | uninstalled
 *   uninstalled: TERMINAL (tombstone — history stays readable,
 *   identifiers never replay back to life)
 *
 * There is no configure/authorize subset (packs carry no configuration
 * contract in the framework — extension bindings resolve through the
 * /extensions install lifecycle, which owns configuration).
 */
export type DomainPackInstallStatus = 'installed' | 'disabled' | 'uninstalled';

export const DOMAIN_PACK_INSTALL_STATUSES: readonly DomainPackInstallStatus[] = [
  'installed',
  'disabled',
  'uninstalled',
];

export const DOMAIN_PACK_INSTALL_TRANSITIONS: Readonly<
  Record<DomainPackInstallStatus, readonly DomainPackInstallStatus[]>
> = {
  installed: ['disabled', 'uninstalled'],
  disabled: ['installed', 'uninstalled'],
  uninstalled: [],
};

/** Terminal install rows — frozen, reject every change. */
export const DOMAIN_PACK_INSTALL_TERMINAL_STATUSES: readonly DomainPackInstallStatus[] = [
  'uninstalled',
];

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalDomainPackInstallTransition(
  from: DomainPackInstallStatus,
  to: DomainPackInstallStatus,
): boolean {
  return DOMAIN_PACK_INSTALL_TRANSITIONS[from].includes(to);
}

/**
 * One installed-version record (a specific published pack version
 * recorded against the authorized Workspace/Client context —
 * PACK-AC-01). The scope is SERVER-DERIVED at install from the
 * workspace's canonical ownership and immutable (DB-fenced).
 */
export interface DomainPackInstallRecord {
  readonly installId: string;
  readonly packId: string;
  /** Canonical scope — server-derived at install, immutable (DB-fenced). */
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly status: DomainPackInstallStatus;
  readonly idempotencyKey: string;
  readonly version: number;
  readonly createdBy: string | null;
  readonly uninstalledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DomainPackInstallOutcome {
  readonly install: DomainPackInstallRecord;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// The artifact scope records (domain-pack-v1.3.md §5 / PACK-AC-03)
// ---------------------------------------------------------------------------

/**
 * One MATERIALIZED artifact scope record: the explicit §5 scope
 * distinction recorded against the installing context. A 'client'
 * record carries its client (pack-owned Client data confined to the
 * Client boundary); an 'agency-reusable' record is client-less
 * (reachable within the agency). The artifact's declared content
 * (payload) is served from the IMMUTABLE registry row through this
 * record — the artifactId selects the scope record, never the content.
 */
export interface DomainPackArtifactRecord {
  readonly artifactId: string;
  readonly installId: string;
  readonly packId: string;
  readonly artifactKind: DomainPackArtifactKind;
  readonly artifactName: string;
  /** The explicit §5 scope — distinguished in the record AND in queries. */
  readonly scope: DomainPackArtifactScope;
  /** The resolved access boundary (immutable, DB-fenced). */
  readonly agencyId: string;
  /** NOT NULL iff scope = 'client' (the structural CHECK). */
  readonly clientId: string | null;
  /** The materializing install's workspace (provenance + listing). */
  readonly workspaceId: string;
  /** The declared artifact content — served from the immutable registry row. */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/**
 * Pure resolution of one artifact's ACCESS BOUNDARY from the artifact's
 * declared scope and the installing context: a 'client' artifact
 * resolves to the installing (agency, client, workspace); an
 * 'agency-reusable' artifact resolves to the installing AGENCY only
 * (client null — the artifact is reachable within the agency, never
 * confined to one client). Purity is asserted by unit tests.
 */
export function resolveDomainPackArtifactBoundary(
  declaration: Pick<DomainPackArtifactDeclaration, 'scope'>,
  installScope: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  },
): {
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly workspaceId: string;
} {
  if (declaration.scope === 'agency-reusable') {
    return {
      agencyId: installScope.agencyId,
      clientId: null,
      workspaceId: installScope.workspaceId,
    };
  }
  return {
    agencyId: installScope.agencyId,
    clientId: installScope.clientId,
    workspaceId: installScope.workspaceId,
  };
}

/**
 * Pure predicate: is the artifact record REACHABLE from the given
 * caller scope? A 'client' record is reachable only from scopes whose
 * client matches the record's client (the workspace is the boundary
 * hop: a caller addressing ANOTHER client's workspace context never
 * reaches it — PACK-AC-03). An 'agency-reusable' record is reachable
 * from any scope of its AGENCY (the explicit §5 distinction), never
 * from another agency.
 */
export function isDomainPackArtifactReachable(
  artifact: Pick<
    DomainPackArtifactRecord,
    'scope' | 'agencyId' | 'clientId' | 'workspaceId'
  >,
  callerScope: {
    readonly agencyId: string;
    readonly clientId: string | null;
    readonly workspaceId: string | null;
  },
): boolean {
  if (callerScope.agencyId !== artifact.agencyId) return false;
  if (artifact.scope === 'agency-reusable') return true;
  // Client-scoped: the caller must be in the record's own client
  // boundary (the workspace hop that materialized it).
  return (
    artifact.clientId !== null &&
    callerScope.clientId === artifact.clientId &&
    callerScope.workspaceId === artifact.workspaceId
  );
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface DomainPacksModuleApi {
  /**
   * PUBLISHES one Domain Pack version (the only registry creation
   * path). The manifest is validated against the full §2/§5 shape guard
   * — the closed artifact-kind vocabulary, the closed scope vocabulary,
   * unique (kind, name) artifact identities, the §21 material-key
   * backstop, and §4 WORKFLOW-TEMPLATE CONFORMANCE: every
   * 'workflow-template' payload must pass the /workflows authority's
   * frozen definition-content validator (a template that fails the §4
   * contract is REJECTED at publication). A self-dependency
   * (requiredPacks naming this very version) is rejected. The
   * (publisher, packKey, version) triple is DB-fenced IMMUTABLE:
   * re-publication of the same version is a ConflictError; a new
   * version is a new record. `actorId` and `idempotencyKey` are
   * server-derived provenance only.
   */
  publishDomainPackVersion(input: {
    readonly manifest: DomainPackManifest;
    readonly actorId: string | null;
    readonly idempotencyKey: string;
  }): Promise<DomainPackRegistryRecord>;
  /** Raw registry row by id — immutable history is always readable. */
  getDomainPackVersion(packId: string): Promise<DomainPackRegistryRecord | null>;
  /** Registry listing (optionally narrowed to one pack key), newest first. */
  listDomainPackVersions(input: {
    readonly packKey: string | null;
  }): Promise<readonly DomainPackRegistryRecord[]>;

  /**
   * INSTALLS a published Domain Pack version against a canonical
   * Workspace/Client context (PACK-AC-01: the installed version is
   * RECORDED against the authorized Workspace/Client context). The
   * scope is SERVER-SUPPLIED by the caller (resolved from durable
   * canonical ownership BEFORE authorize/execute — scope-as-data; the
   * migration-030 triggers re-fence the chain). DEPENDENCY CHECKS: a
   * self-referencing install is impossible (publish-time guard), and
   * every manifest-declared required pack must be PUBLISHED (unknown or
   * unpublished dependency → InvalidRequestError, fail closed).
   * Installation also MATERIALIZES one artifact scope record per
   * declared artifact with the §5 explicit distinction resolved against
   * the installing context (one transaction — install + artifacts are
   * atomic). One install per (workspace, pack version): a duplicate
   * logical install command converges (replayed=true).
   */
  installDomainPack(input: {
    readonly scope: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string;
    };
    readonly packId: string;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<DomainPackInstallOutcome>;
  /** Raw install row by id (tombstones included). */
  getDomainPackInstall(installId: string): Promise<DomainPackInstallRecord | null>;
  /** The installs of one Workspace in every state (terminal history stays visible), newest first. */
  listDomainPackInstalls(workspaceId: string): Promise<readonly DomainPackInstallRecord[]>;

  /**
   * CAS lifecycle transition on the frozen
   * DOMAIN_PACK_INSTALL_TRANSITIONS table ('disable' → disabled,
   * 'enable' → installed, 'uninstall' → uninstalled — terminal
   * tombstone). `uninstalled` is terminal and the identifiers never
   * replay back to life.
   */
  setDomainPackInstallStatus(input: {
    readonly installId: string;
    readonly status: DomainPackInstallStatus;
    readonly expectedVersion: number;
    readonly actorId: string | null;
  }): Promise<DomainPackInstallRecord>;

  /**
   * One artifact scope record by id, with its declared content served
   * from the IMMUTABLE registry row. Callers authorize against the
   * record's resolved boundary (the routes enforce the §5 scope matrix:
   * client-scoped records need the owning client's boundary;
   * agency-reusable records need the owning agency).
   */
  getDomainPackArtifact(artifactId: string): Promise<DomainPackArtifactRecord | null>;
  /**
   * The artifact scope records materialized by the installs of ONE
   * Workspace (both scopes — the workspace's own install artifacts),
   * oldest first. The listing derives from the workspace's OWN installs
   * only: pack-owned Client data of OTHER workspaces/clients never
   * appears (PACK-AC-03 data-level Client boundary).
   */
  listDomainPackArtifactsForWorkspace(
    workspaceId: string,
  ): Promise<readonly DomainPackArtifactRecord[]>;
  /**
   * The AGENCY-SCOPED REUSABLE artifact surface of one agency — ONLY
   * scope='agency-reusable' records materialized by installs anywhere in
   * the agency, oldest first. This is the §5 explicit distinction as a
   * QUERY: Client-scoped pack-owned data is NEVER returned at agency
   * scope (cross-client aggregation stays forbidden without explicit
   * governance, which the framework does not implement).
   */
  listDomainPackArtifactsForAgency(
    agencyId: string,
  ): Promise<readonly DomainPackArtifactRecord[]>;
}

export interface DomainPacksModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  // NOTE (dependency posture): the frozen matrix allows /domain-packs ──→
  // sixteen module dependencies, but the framework composes NONE of them
  // at module level (the /agents precedent of deliberately-unused
  // allowances): the install scope arrives as SERVER-DERIVED data from
  // the routes, and /workflows template conformance is validated through
  // the PURE /workflows public validator imported by internal/store.ts
  // (see the module header — PACK-AC-02).
}

export { createDomainPacksModule } from './internal/module.ts';
/**
 * The input guards (manifest shape/artifact-declaration validation with
 * the §4 workflow-template conformance check and the §21 material-key
 * backstop, install input validation) and the pure helpers — exported
 * for unit tests and future server-side callers so the guard semantics
 * are part of the module contract. Pure functions.
 */
export {
  assertValidDomainPackManifest,
  assertValidDomainPackInstallInput,
  domainPackCreateFingerprint,
  payloadHasNoDomainPackMaterialKeys,
} from './internal/store.ts';
