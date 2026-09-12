/**
 * MarketingOS module: /deployments
 * Authority: Deployment intent/lifecycle — the Marketing Cloud Deployment
 * control plane (spec/architecture.md §9, spec/marketing-cloud-deployment-
 * v1.4.md, spec/architecture-lock-v1.4.md, spec/change-request-004.md).
 *
 * MKT-040 implements DEPLOY-002: the authoritative control plane that
 * binds immutable Playbook/Workflow versions to authorized Client
 * Workspaces and manages validation, activation, pause/resume, redeploy
 * and rollback WITHOUT becoming a second workflow/execution engine.
 *
 * WHAT THIS MODULE OWNS (marketing-cloud-deployment-v1.4.md "Authority
 * boundary"): deployment intent, dependency resolution, activation state
 * and deployment history — EXACTLY the `deployments` +
 * `deployment_events` tables of migration 034. The operator loop is the
 * frozen product loop:
 *
 *   Configure → Validate → Deploy → Observe → Pause/Resume → Redeploy/Rollback
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO:
 *   - NO workflow or execution lifecycle mutation: deployment may REQUEST
 *     workflow execution (createExecution through the /executions public
 *     contract — the ONLY sanctioned interaction) but never transitions
 *     workflow/instance/execution state and never implements a second
 *     retry/orchestration engine (DEPLOY-AC-07; enforced by the static
 *     architecture tests and the zero-import boundary below);
 *   - NO runtime allocation: a Deployment does not imply one VM, process
 *     or sandbox. It DECLARES a runtime class (the closed four-class
 *     vocabulary of the /executions RuntimeClass) and passes it to
 *     requested executions; the Execution/Runtime authority decides the
 *     actual allocation (DEPLOY-AC-09). There is NO infrastructure
 *     identity anywhere in the deployment contract — the migration
 *     CHECK-fences the closed runtime shape;
 *   - NO history rewriting: redeploy/rollback change FUTURE version
 *     selection only (the selection columns move exactly on the
 *     redeploying→active / rolling_back→active completion edges — DB
 *     trigger fenced); existing Execution, Outcome, Evidence and
 *     Learning records are never rewritten (DEPLOY-AC-06);
 *   - NO second tenant/policy/credential/evidence authority: Client
 *     isolation is enforced server-side before dependent traversal
 *     (uniform 404s — DEPLOY-AC-08), the policy gate delegates to the
 *     /policies fail-closed evaluation surface, and credentials are
 *     validated as REFERENCES only (never material — implementation-
 *     contract §21).
 *
 * DEPENDENCY POSTURE (frozen matrix): the module-dependency-matrix.md has
 * NO /deployments line — /deployments holds an EMPTY allowance list in
 * the static checker (nothing inferred, nothing defaulted). EVERY
 * consumed public contract therefore arrives through DECLARED STRUCTURAL
 * PORTS (the /integrations MKT-023 precedent for /clients + /evidence,
 * extended to the whole dependency surface): narrow typed views of the
 * /workspaces, /playbooks, /workflows, /domain-packs, /extensions,
 * /integrations, /policies, /credentials and /executions public
 * contracts, satisfied structurally by the concrete instances and wired
 * at the composition root. The resolution/authorization still executes
 * server-side THROUGH those public contracts while the frozen import
 * matrix stays intact — there is NO import of another module anywhere
 * under src/modules/deployments (verified by tools/arch-check and
 * tests/architecture/deployments-boundary.test.ts).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// ---------------------------------------------------------------------------
// The frozen lifecycle (marketing-cloud-deployment-v1.4.md "Lifecycle")
// ---------------------------------------------------------------------------

/**
 * The frozen Deployment lifecycle state machine. `draft` is the born
 * state; `blocked` and `disabled` are TERMINAL — the frozen contract
 * lists NO exit edge from either (history stays readable forever; the
 * operator's path forward is a NEW deployment, never a resurrected row).
 */
export type DeploymentStatus =
  | 'draft'
  | 'validating'
  | 'ready'
  | 'active'
  | 'paused'
  | 'redeploying'
  | 'rolling_back'
  | 'blocked'
  | 'disabled';

export const DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  'draft',
  'validating',
  'ready',
  'active',
  'paused',
  'redeploying',
  'rolling_back',
  'blocked',
  'disabled',
];

/**
 * THE FROZEN TRANSITION TABLE (marketing-cloud-deployment-v1.4.md —
 * exactly the drawn edges, nothing more):
 *
 *   draft → validating → ready → active
 *                            ├→ blocked
 *   active → paused → active
 *   active → disabled
 *   active → redeploying → active
 *   active → rolling_back → active
 *
 * `validating` is reached and left INSIDE the atomic validate operation
 * (the row passes through it — the compound draft→validating→ready leg);
 * it is NOT an externally targetable transition end-state. Every other
 * edge is the single-authorized mutation port's target surface.
 */
export const DEPLOYMENT_TRANSITIONS: Readonly<
  Record<DeploymentStatus, readonly DeploymentStatus[]>
> = {
  draft: ['validating'],
  validating: ['ready'],
  ready: ['active', 'blocked'],
  active: ['paused', 'disabled', 'redeploying', 'rolling_back'],
  paused: ['active'],
  redeploying: ['active'],
  rolling_back: ['active'],
  blocked: [],
  disabled: [],
};

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalDeploymentTransition(
  from: DeploymentStatus,
  to: DeploymentStatus,
): boolean {
  return DEPLOYMENT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Runtime requirements (DEPLOY-AC-09 — runtime neutrality)
// ---------------------------------------------------------------------------

/**
 * The closed runtime-class vocabulary — the SAME four classes the
 * /executions RuntimeClass and PlaybookRuntimeClass declare. A deployment
 * REQUESTS one of these; runtime allocation (pooled workers, an
 * ephemeral sandbox, a persistent sandbox LEASE — Workspace-scoped,
 * Execution-leased — or a dedicated runtime) is decided by the
 * Execution/Runtime authority. NO infrastructure identity is encoded
 * anywhere in the deployment contract.
 */
export type DeploymentRuntimeClass =
  | 'pooled-worker'
  | 'ephemeral-sandbox'
  | 'persistent-sandbox'
  | 'dedicated-runtime';

export const DEPLOYMENT_RUNTIME_CLASSES: readonly DeploymentRuntimeClass[] = [
  'pooled-worker',
  'ephemeral-sandbox',
  'persistent-sandbox',
  'dedicated-runtime',
];

/** The declared runtime requirements — exactly the class, nothing else. */
export interface DeploymentRuntimeRequirements {
  readonly runtimeClass: DeploymentRuntimeClass;
}

// ---------------------------------------------------------------------------
// The version-selection contract (deployment identity + redeploy/rollback)
// ---------------------------------------------------------------------------

/** A required Domain Pack, optionally pinned to a version constraint. */
export interface DeploymentDomainPackRequirement {
  readonly name: string;
  readonly versionConstraint: string | null;
}

/**
 * A required Integration or Extension capability, optionally
 * version-pinned (the frozen PlaybookCapabilityRequirement shape).
 */
export interface DeploymentCapabilityRequirement {
  readonly kind: 'integration' | 'extension';
  readonly name: string;
  readonly versionConstraint: string | null;
}

/** One trigger/schedule configuration entry (the frozen trigger kinds). */
export interface DeploymentTrigger {
  readonly kind: 'manual' | 'schedule' | 'event';
  readonly config: Readonly<Record<string, string>> | null;
}

/**
 * The IMMUTABLE version selection a deployment pins — the unit
 * redeploy/rollback replace on the completion edges (future selection
 * only). This is the "resolved workflow version references, required
 * Domain Pack versions, required Integration/Extension capability
 * versions" block of the frozen deployment identity.
 */
export interface DeploymentSelection {
  readonly playbookVersionId: string;
  readonly workflowDefinitionIds: readonly string[];
  readonly requiredDomainPacks: readonly DeploymentDomainPackRequirement[];
  readonly requiredCapabilities: readonly DeploymentCapabilityRequirement[];
  readonly runtimeRequirements: DeploymentRuntimeRequirements;
  readonly triggerConfig: readonly DeploymentTrigger[];
}

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every module mutation (the MKT-013/023
 * pattern): built exclusively from the authenticated principal, the
 * ambient correlation context and the recording surface — never from a
 * request body (route validation rejects provenance-shaped authority
 * fields; this type is a separate module-API argument so no DTO can feed
 * it structurally).
 */
export interface DeploymentProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance as persisted on the append-only deployment event ledger. */
export interface DeploymentRecordedProvenance extends DeploymentProvenance {
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The validation report (the resolution contract's honest evidence)
// ---------------------------------------------------------------------------

/** The closed check vocabulary of the activation gate (resolution contract). */
export type DeploymentCheckName =
  | 'authorization'
  | 'playbook-version'
  | 'workflow-versions'
  | 'domain-packs'
  | 'capabilities'
  | 'credentials'
  | 'policy'
  | 'runtime'
  | 'triggers';

export const DEPLOYMENT_CHECK_NAMES: readonly DeploymentCheckName[] = [
  'authorization',
  'playbook-version',
  'workflow-versions',
  'domain-packs',
  'capabilities',
  'credentials',
  'policy',
  'runtime',
  'triggers',
];

/**
 * One named gate check result. The report ALWAYS records every failed
 * check honestly — the module never fabricates a pass, and a deployment
 * becomes ready/active only when EVERY check is green (DEPLOY-AC-04: no
 * partially validated deployment reaches ACTIVE).
 */
export interface DeploymentCheckResult {
  readonly check: DeploymentCheckName;
  readonly ok: boolean;
  readonly detail: string;
}

/** The full resolution outcome: every check plus the overall verdict. */
export interface DeploymentValidationReport {
  readonly ok: boolean;
  readonly checks: readonly DeploymentCheckResult[];
  /** The recorded /policies decision id of the gate evaluation (when gated). */
  readonly policyDecisionId: string | null;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * One persisted Deployment — the frozen identity shape
 * (marketing-cloud-deployment-v1.4.md "Deployment identity"): the
 * Agency/Client/Workspace scope chain (server-derived at creation,
 * immutable, DB-fenced), the pinned immutable playbook version, the
 * resolved workflow version references, the required pack/capability
 * versions, the policy snapshot/reference, the runtime requirements, the
 * trigger/schedule configuration, the lifecycle state + CAS version.
 */
export interface DeploymentRecord {
  readonly deploymentId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly playbookVersionId: string;
  readonly workflowDefinitionIds: readonly string[];
  readonly requiredDomainPacks: readonly DeploymentDomainPackRequirement[];
  readonly requiredCapabilities: readonly DeploymentCapabilityRequirement[];
  readonly policyReferenceId: string | null;
  readonly runtimeRequirements: DeploymentRuntimeRequirements;
  readonly triggerConfig: readonly DeploymentTrigger[];
  readonly status: DeploymentStatus;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One APPEND-ONLY deployment event — the immutable deployment history
 * (lifecycle transitions with the frozen from/to pair, validation
 * reports, full version-selection revisions, and execution-request
 * references). The ledger rejects UPDATE and DELETE at the database
 * level: the recorded past is durable exactly as recorded
 * (DEPLOY-AC-06's history half).
 */
export interface DeploymentEventRecord {
  readonly eventId: string;
  readonly deploymentId: string;
  readonly idempotencyKey: string;
  readonly eventType: DeploymentEventType;
  readonly fromStatus: DeploymentStatus | null;
  readonly toStatus: DeploymentStatus | null;
  readonly selection: DeploymentSelection | null;
  readonly validationReport: DeploymentValidationReport | null;
  readonly reason: string | null;
  readonly executionRef: string | null;
  readonly provenance: DeploymentRecordedProvenance;
}

/**
 * The closed event vocabulary of the append-only ledger:
 *   - created            — the deployment was configured (born draft; full
 *                          initial selection snapshot);
 *   - validated          — the compound draft→validating→ready leg (report);
 *   - activated          — ready→active gate pass (report + selection);
 *   - paused / resumed   — the control pair;
 *   - disabled / blocked — the terminal recording edges;
 *   - redeploy-requested — active→redeploying with the PENDING selection
 *                          (NOT yet applied — future selection changes on
 *                          completion only);
 *   - redeploy-applied   — redeploying→active, the pending selection
 *                          applied (report + selection);
 *   - rollback-requested — active→rolling_back targeting a prior revision;
 *   - rollback-applied   — rolling_back→active, the target applied;
 *   - execution-requested — an execution requested through the
 *                          /executions public contract (execution_ref).
 */
export type DeploymentEventType =
  | 'created'
  | 'validated'
  | 'activated'
  | 'paused'
  | 'resumed'
  | 'disabled'
  | 'blocked'
  | 'redeploy-requested'
  | 'redeploy-applied'
  | 'rollback-requested'
  | 'rollback-applied'
  | 'execution-requested';

export const DEPLOYMENT_EVENT_TYPES: readonly DeploymentEventType[] = [
  'created',
  'validated',
  'activated',
  'paused',
  'resumed',
  'disabled',
  'blocked',
  'redeploy-requested',
  'redeploy-applied',
  'rollback-requested',
  'rollback-applied',
  'execution-requested',
] as const;

// ---------------------------------------------------------------------------
// Structural ports (the frozen-matrix-compliant consumed public contracts)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /workspaces canonical owner context (the
 * public-contract shape /deployments consumes): the resolved Workspace,
 * its owning Client and the owning Agency with their boundary statuses.
 * The real WorkspaceOwnerContext satisfies this structurally —
 * /workspaces remains the ONLY Workspace ownership authority.
 */
export interface DeploymentsWorkspaceOwnershipSnapshot {
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
 * The slice of the /workspaces public contract /deployments depends on:
 * canonical server-side Workspace ownership resolution from durable
 * state (scope chain + boundary statuses). Satisfied structurally by
 * WorkspacesModuleApi; wired at the composition root.
 */
export interface DeploymentsWorkspaceOwnershipPort {
  resolveWorkspaceOwnership(workspaceId: string): Promise<DeploymentsWorkspaceOwnershipSnapshot | null>;
}

/** The narrow /playbooks version view /deployments resolves pins against. */
export interface DeploymentsPlaybookVersionSnapshot {
  readonly versionId: string;
  readonly playbookId: string;
  readonly status: string;
}

/** The narrow /playbooks playbook view (the ownership compatibility row). */
export interface DeploymentsPlaybookSnapshot {
  readonly playbookId: string;
  readonly agencyId: string;
  readonly clientId: string | null;
}

/**
 * The slice of the /playbooks public contract /deployments depends on:
 * EXPLICIT immutable version reference resolution (getPlaybookVersion)
 * plus the owning playbook row (getPlaybook). Satisfied structurally by
 * PlaybooksModuleApi; wired at the composition root.
 */
export interface DeploymentsPlaybooksPort {
  getPlaybookVersion(versionId: string): Promise<DeploymentsPlaybookVersionSnapshot | null>;
  getPlaybook(playbookId: string): Promise<DeploymentsPlaybookSnapshot | null>;
}

/** The narrow /workflows definition view (the pinned version reference). */
export interface DeploymentsWorkflowDefinitionSnapshot {
  readonly workflowDefinitionId: string;
  readonly workflowId: string;
  readonly status: string;
  readonly playbookVersionId: string | null;
}

/** The narrow /workflows workflow view (the workspace ownership row). */
export interface DeploymentsWorkflowSnapshot {
  readonly workflowId: string;
  readonly workspaceId: string;
}

/**
 * The slice of the /workflows public contract /deployments depends on
 * (READ-ONLY): explicit definition reference resolution + the owning
 * workflow row. The deployment authority holds NO workflow mutation
 * surface — structurally, this port cannot transition workflow state
 * (DEPLOY-AC-07). Satisfied structurally by WorkflowsModuleApi; wired at
 * the composition root.
 */
export interface DeploymentsWorkflowsPort {
  getWorkflowDefinition(definitionId: string): Promise<DeploymentsWorkflowDefinitionSnapshot | null>;
  getWorkflow(workflowId: string): Promise<DeploymentsWorkflowSnapshot | null>;
}

/** The narrow /domain-packs install view (workspace-scoped installs). */
export interface DeploymentsPackInstallSnapshot {
  readonly installId: string;
  readonly packId: string;
  readonly status: string;
}

/** The narrow /domain-packs registry view (the pack version identity). */
export interface DeploymentsPackVersionSnapshot {
  readonly packId: string;
  readonly packKey: string;
  readonly version: string;
}

/**
 * The slice of the /domain-packs public contract /deployments depends on
 * (READ-ONLY): the Workspace's installs + registry version resolution.
 * Satisfied structurally by DomainPacksModuleApi; wired at the
 * composition root.
 */
export interface DeploymentsDomainPacksPort {
  listDomainPackInstalls(workspaceId: string): Promise<readonly DeploymentsPackInstallSnapshot[]>;
  getDomainPackVersion(packId: string): Promise<DeploymentsPackVersionSnapshot | null>;
}

/** The narrow /extensions install view (workspace-scoped installs). */
export interface DeploymentsExtensionInstallSnapshot {
  readonly installId: string;
  readonly extensionId: string;
  readonly status: string;
  /** LOGICAL NAME → credential REFERENCE id (never material — CRED-001). */
  readonly secretBindings: Readonly<Record<string, string>>;
}

/** The narrow /extensions registry view (the extension version identity). */
export interface DeploymentsExtensionVersionSnapshot {
  readonly extensionId: string;
  readonly extensionKey: string;
  readonly version: string;
}

/**
 * The slice of the /extensions public contract /deployments depends on
 * (READ-ONLY): the Workspace's installs + registry version resolution.
 * Satisfied structurally by ExtensionsModuleApi; wired at the
 * composition root.
 */
export interface DeploymentsExtensionsPort {
  listExtensionInstalls(workspaceId: string): Promise<readonly DeploymentsExtensionInstallSnapshot[]>;
  getExtensionVersion(extensionId: string): Promise<DeploymentsExtensionVersionSnapshot | null>;
}

/** The narrow /integrations registry view (the adapter DATA surface). */
export interface DeploymentsAdapterSnapshot {
  readonly adapterKey: string;
}

/** The narrow /integrations connection view (the capability pipe). */
export interface DeploymentsIntegrationConnectionSnapshot {
  readonly connectionId: string;
  readonly clientId: string;
  readonly adapterKey: string;
  readonly status: string;
  readonly credentialReferenceId: string;
}

/**
 * The slice of the /integrations public contract /deployments depends on
 * (READ-ONLY): the adapter REGISTRY as data + the Client's connections.
 * Satisfied structurally by IntegrationsModuleApi; wired at the
 * composition root.
 */
export interface DeploymentsIntegrationsPort {
  listRegisteredAdapters(): readonly DeploymentsAdapterSnapshot[];
  listConnectionsForClient(clientId: string): Promise<readonly DeploymentsIntegrationConnectionSnapshot[]>;
}

/** The narrow /policies decision view (the fail-closed evaluation answer). */
export interface DeploymentsPolicyDecisionSnapshot {
  readonly decisionId: string;
  readonly outcome: 'allow' | 'deny' | 'unknown';
  readonly reasonCode: string;
}

/** The narrow /policies active-version view (the policy reference stamp). */
export interface DeploymentsPolicyVersionSnapshot {
  readonly policyId: string;
}

/**
 * The slice of the /policies public contract /deployments depends on: the
 * fail-closed 'deployment'-dimension evaluation surface (only an explicit
 * allow proceeds) + the ACTIVE version resolution for the policy
 * reference stamp. Satisfied structurally by PoliciesModuleApi; wired at
 * the composition root.
 */
export interface DeploymentsPoliciesPort {
  evaluateAction(
    input: {
      readonly action: {
        readonly dimension: 'deployment';
        readonly operation: string;
        readonly resource: string | null;
        readonly attributes: Readonly<Record<string, string>>;
      };
      readonly scope: { readonly agencyId: string; readonly clientId: string };
    },
    provenance: { readonly actor: string; readonly recordedVia: string; readonly correlationId: string; readonly causationId: string | null },
  ): Promise<DeploymentsPolicyDecisionSnapshot>;
  getActivePolicyVersion(input: {
    readonly scope: {
      readonly agencyId: string | null;
      readonly clientId: string | null;
    };
    readonly dimension: 'deployment';
  }): Promise<DeploymentsPolicyVersionSnapshot | null>;
}

/** The narrow /credentials reference view (references only — never material). */
export interface DeploymentsCredentialReferenceSnapshot {
  readonly credentialId: string;
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly status: string;
}

/**
 * The slice of the /credentials public contract /deployments depends on
 * (READ-ONLY, reference-only): raw reference lookup by id for the
 * credential-reference validation check. Satisfied structurally by
 * CredentialsModuleApi; wired at the composition root.
 */
export interface DeploymentsCredentialsPort {
  getCredentialReference(credentialId: string): Promise<DeploymentsCredentialReferenceSnapshot | null>;
}

/** The outcome of the request-execution surface (the /executions contract). */
export interface DeploymentsExecutionRequestOutcome {
  readonly executionId: string;
  readonly runtimeClass: string;
  readonly replayed: boolean;
}

/**
 * The slice of the /executions public contract /deployments depends on:
 * THE REQUEST-EXECUTION SURFACE — createExecution only. This is the
 * single sanctioned interaction with the execution authority
 * (architecture.md §9: "It may request workflow execution"): the
 * deployment module holds NO execution transition, retry, dispatch or
 * lease surface — structurally unreachable (DEPLOY-AC-07). Satisfied
 * structurally by ExecutionsModuleApi; wired at the composition root.
 */
export interface DeploymentsExecutionsPort {
  createExecution(input: {
    readonly workspaceId: string;
    readonly taskLink: {
      readonly kind: 'external-request';
      readonly externalRequestRef: string;
    };
    readonly executionKind: string;
    readonly runtimeClass: string;
    readonly idempotencyKey: string;
    readonly actorId: null;
  }): Promise<DeploymentsExecutionRequestOutcome>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL DEPLOYMENT OWNER CONTEXT: the single server-side
 * resolution of WHICH tenant owns the deployment (the Workspace → Client
 * → Agency chain), composed from durable state on every call.
 * Deployment-scoped operations authorize against this context — never
 * against caller-supplied tenant or deployment identity. A deployment
 * whose Workspace or Client is a deleted tombstone never resolves (null
 * — uniform 404 upstream, DEPLOY-AC-08).
 */
export interface DeploymentsOwnerContext {
  readonly scope: {
    readonly kind: 'deployment';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
    readonly deploymentId: string;
  };
  readonly deployment: DeploymentRecord;
  readonly workspaceOwnership: DeploymentsWorkspaceOwnershipSnapshot;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface DeploymentsModuleApi {
  /**
   * CONFIGURES one deployment (born DRAFT). The Workspace is resolved
   * canonically through the /workspaces structural port BEFORE any write:
   * unknown/tombstoned Workspace/Client → uniform NotFoundError; a
   * disabled Workspace/Client/Agency boundary → ConflictError (disabled
   * boundaries block new use without rewriting history). agency/client
   * ownership is SERVER-DERIVED from that chain (never caller-supplied —
   * DEPLOY-AC-08). The pinned playbook version must resolve through
   * /playbooks as PUBLISHED (immutable approved versions only — draft/
   * review versions are still editable, retired versions are withdrawn)
   * and its playbook must be usable inside the deployment's Client
   * (Agency-scoped reusable: same Agency; Client-scoped: same Client —
   * otherwise uniform NotFoundError). Every referenced workflow
   * definition must resolve through /workflows as ACTIVE, belong to a
   * workflow of the TARGET Workspace, and carry the deployment's
   * playbook version link (immutable-version compatibility). The full
   * initial selection is guarded (bounded shapes, closed vocabularies,
   * §21 material-key backstop) and recorded as the 'created' ledger
   * revision.
   */
  createDeployment(
    input: {
      readonly workspaceId: string;
      readonly selection: DeploymentSelection;
    },
    provenance: DeploymentProvenance,
  ): Promise<DeploymentRecord>;
  /** Raw record by id (any status — immutable history stays readable). */
  getDeployment(deploymentId: string): Promise<DeploymentRecord | null>;
  /**
   * Canonical ownership resolution: the deployment row + its owning
   * Workspace/Client/Agency chain, composed into the canonical owner
   * context. Null when the deployment does not exist OR its Workspace/
   * Client is a deleted tombstone — callers surface a uniform 404 so
   * foreign, unknown and orphaned identifiers are indistinguishable
   * (DEPLOY-AC-08 hard-boundary posture).
   */
  resolveDeploymentOwnership(
    deploymentId: string,
  ): Promise<DeploymentsOwnerContext | null>;
  /** The Workspace's deployments (newest first). Unknown Workspace → 404. */
  listDeploymentsForWorkspace(workspaceId: string): Promise<readonly DeploymentRecord[]>;
  /**
   * The append-only history ledger of one deployment, oldest first —
   * every lifecycle decision, validation report and version-selection
   * revision (the rollback revision chain reads this).
   */
  getDeploymentEvents(deploymentId: string): Promise<readonly DeploymentEventRecord[]>;

  /**
   * VALIDATE (the Configure→Validate step): the compound
   * draft→validating→ready leg in ONE operation. Runs the full
   * resolution contract against the deployment's pinned selection —
   * authorization (ACTIVE Workspace/Client/Agency boundaries), playbook
   * version existence/published/scope compatibility, workflow version
   * compatibility (ACTIVE + Workspace-owned + playbook-linked), Domain
   * Pack compatibility (installed in the Workspace, version satisfying
   * the constraint), capability availability (extension installs
   * authorized with satisfying versions; integration adapters registered
   * with CONNECTED Client connections), credential references (every
   * bound/connected reference LIVE and in scope), policy compatibility
   * (the fail-closed deployment-dimension 'deployment.deploy' evaluation
   * must explicitly allow), runtime requirements (the closed class) and
   * trigger validity — recording EVERY check result honestly in the
   * 'validated' ledger event. ALL checks green → the row moves
   * draft→validating→ready (the validating leg is the atomic in-flight
   * edge — never externally targetable) and the policy reference is
   * stamped. ANY failed check → the operation is REJECTED
   * (InvalidRequestError carrying the failed checks) and the deployment
   * stays DRAFT — no partially validated deployment becomes READY
   * (let alone ACTIVE — DEPLOY-AC-04). Idempotent: a replay of the same
   * idempotency key converges to the recorded outcome.
   */
  validateDeployment(
    input: {
      readonly deploymentId: string;
      readonly idempotencyKey: string;
      readonly expectedVersion: number;
    },
    provenance: DeploymentProvenance,
  ): Promise<DeploymentTransitionOutcome>;

  /**
   * THE SINGLE AUTHORIZED LIFECYCLE MUTATION PORT (the house pattern —
   * transitionWorkflowInstance/transitionExecution): one frozen edge per
   * call, CAS-guarded, idempotency-fenced (duplicate delivery converges to
   * the recorded event), every applied transition recorded append-only.
   *
   * Target surfaces (everything else is an invalid transition →
   * ConflictError, DEPLOY-AC-05):
   *   - to='active' from ready     — DEPLOY: the full activation gate
   *     re-runs FRESH (every resolution check + the 'deployment.deploy'
   *     policy allow) BEFORE the edge; any failure → rejected, the
   *     deployment stays READY;
   *   - to='active' from paused    — RESUME: the same full gate (the
   *     strictest reading of the frozen resolution contract: EVERY entry
   *     into ACTIVE is gated) + 'deployment.resume' policy allow;
   *   - to='active' from redeploying — REDEPLOY COMPLETION: the full gate
   *     against the PENDING selection (the latest 'redeploy-requested'
   *     ledger revision) + 'deployment.redeploy' policy allow; on success
   *     the pending selection is applied atomically with the edge (future
   *     selection changes HERE — DEPLOY-AC-06);
   *   - to='active' from rolling_back — ROLLBACK COMPLETION: the same
   *     against the targeted prior revision + 'deployment.rollback';
   *   - to='paused' from active    — PAUSE: 'deployment.pause' policy
   *     allow + the control edge (pure control recording — runtime
   *     allocation is the Execution authority's business);
   *   - to='disabled' from active  — DISABLE (terminal; no policy gate —
   *     the frozen dimension vocabulary lists deploy/pause/resume/
   *     redeploy/rollback; disclosed in docs/implementation/MKT-040.md);
   *   - to='blocked' from ready    — BLOCK (terminal; records why the
   *     ready deployment can no longer activate — dependency drift);
   *   - to='redeploying' from active — REDEPLOY REQUEST: carries the NEW
   *     immutable selection (shape-guarded; playbook/workflow references
   *     resolve like creation), policy-gated ('deployment.redeploy');
   *     recorded as 'redeploy-requested' with the PENDING selection —
   *     the row's selection is NOT yet changed;
   *   - to='rolling_back' from active — ROLLBACK REQUEST: carries the
   *     target revision eventId (a prior selection-bearing ledger event
   *     of THIS deployment — 'created' | 'activated' | 'redeploy-applied'
   *     | 'rollback-applied'; a foreign event id is a uniform 404),
   *     policy-gated ('deployment.rollback').
   *
   * 'validating' and 'ready' are NOT externally targetable (validate is
   * the only path into ready; validating is the atomic in-flight leg).
   */
  transitionDeployment(
    input: {
      readonly deploymentId: string;
      readonly to: DeploymentStatus;
      readonly idempotencyKey: string;
      readonly expectedVersion: number;
      readonly reason: string | null;
      readonly redeploySelection: DeploymentSelection | null;
      readonly rollbackTargetEventId: string | null;
    },
    provenance: DeploymentProvenance,
  ): Promise<DeploymentTransitionOutcome>;

  /**
   * REQUEST EXECUTION (the only sanctioned /executions interaction —
   * DEPLOY-AC-07/09): requests one execution for an ACTIVE deployment's
   * MANUAL trigger through the /executions public contract's
   * createExecution (taskLink external-request referencing this
   * deployment + trigger; executionKind 'deterministic'; runtimeClass =
   * the deployment's DECLARED class — runtime neutrality: the deployment
   * requests the class, the Execution/Runtime authority allocates).
   * Non-ACTIVE deployment or a non-manual trigger → ConflictError. The
   * request is recorded as an append-only 'execution-requested' ledger
   * event referencing the created execution. Idempotent per key. There
   * is deliberately NO dispatch, NO retry and NO workflow-instance
   * materialization here: the deployment REQUESTS, the runtime executes.
   */
  requestDeploymentExecution(
    input: {
      readonly deploymentId: string;
      readonly triggerIndex: number;
      readonly idempotencyKey: string;
    },
    provenance: DeploymentProvenance,
  ): Promise<{ readonly deployment: DeploymentRecord; readonly execution: DeploymentsExecutionRequestOutcome }>;
}

/**
 * The outcome of one lifecycle operation: the deployment record AFTER the
 * operation, the recorded ledger event, and whether this request was a
 * REPLAY (a duplicate that converged to the already-recorded event — no
 * state change, no new ledger row, no version bump).
 */
export interface DeploymentTransitionOutcome {
  readonly deployment: DeploymentRecord;
  readonly event: DeploymentEventRecord;
  readonly replayed: boolean;
}

export interface DeploymentsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Structural port: canonical /workspaces ownership resolution. */
  readonly workspaceOwnership: DeploymentsWorkspaceOwnershipPort;
  /** Structural port: /playbooks immutable version resolution. */
  readonly playbooks: DeploymentsPlaybooksPort;
  /** Structural port: /workflows definition reference resolution (read-only). */
  readonly workflows: DeploymentsWorkflowsPort;
  /** Structural port: /domain-packs installs + registry (read-only). */
  readonly domainPacks: DeploymentsDomainPacksPort;
  /** Structural port: /extensions installs + registry (read-only). */
  readonly extensions: DeploymentsExtensionsPort;
  /** Structural port: /integrations adapter registry + connections (read-only). */
  readonly integrations: DeploymentsIntegrationsPort;
  /** Structural port: /policies fail-closed deployment-dimension evaluation. */
  readonly policies: DeploymentsPoliciesPort;
  /** Structural port: /credentials reference lookup (references only). */
  readonly credentials: DeploymentsCredentialsPort;
  /** Structural port: /executions request surface (createExecution only). */
  readonly executions: DeploymentsExecutionsPort;
}

export { createDeploymentsModule } from './internal/module.ts';
/**
 * The input guards (creation/selection/transition/provenance validation
 * with the §21 material-key backstop), the version-constraint matcher and
 * the pure resolution evaluator — exported for unit tests and future
 * server-side callers so the gate semantics are part of the module
 * contract. Pure functions.
 */
export {
  assertValidDeploymentCreation,
  assertValidProvenance,
  assertValidRedeploySelection,
  assertValidTransitionRequest,
  containsMaterialShapedKey,
  evaluateDeploymentResolution,
  satisfiesVersionConstraint,
  type DeploymentResolutionInput,
  type DeploymentResolutionSnapshots,
} from './internal/resolution.ts';
