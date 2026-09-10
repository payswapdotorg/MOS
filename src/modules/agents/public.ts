/**
 * MarketingOS module: /agents
 * Authority: Logical agents/capabilities (spec/implementation-contract.md §1).
 *
 * MKT-020 implements this authority (AGENT-001; work-items.md: "implement
 * reusable logical Agent/Capability contracts without infrastructure
 * coupling"). The module owns:
 *
 *   - the LOGICAL AGENT record — a REUSABLE CAPABILITY DECLARATION
 *     (architecture.md §12: "Agent is a logical reusable capability. It
 *     does not own tenant data, workflow state, deployment state or
 *     infrastructure"): identity (a server-generated stable id + the
 *     reusable logical name agent_key + the declared contract version
 *     label), the declared capabilities, the contract text, the single
 *     lifecycle edge (active → retired, terminal) and the server-derived
 *     provenance — exactly the registry posture the /ai-runtime
 *     TaskProfile/model-registry layer (MKT-017/018) established for the
 *     AI side, reused here for ANY execution kind (AI, human, extension)
 *     that later declares capabilities through this contract;
 *   - the DECLARED CAPABILITIES — provider-neutral capability descriptors:
 *     each descriptor is exactly { capabilityKind, parameters } (a
 *     normalized kind label + a bounded parameter contract object). NO
 *     provider identifiers, NO model identifiers, NO SDK/adapter
 *     references, NO credentials and NO infrastructure coupling (no
 *     sandbox/pool/queue/runtime/deployment references) can appear in the
 *     contract surface: the module input guards REJECT provider/model/SDK/
 *     credential/infrastructure-shaped keys at the top level AND at every
 *     nesting level of the descriptor parameters, the API DTO layer
 *     rejects the same forbidden-key set caller-side, and the storage
 *     (migration 022) has no column capable of holding any of them plus a
 *     descriptor-shape CHECK — the provider-neutral capability contract;
 *   - SCOPE: a declaration is either PLATFORM-scoped (agency_id null — a
 *     platform-normalized reusable declaration, the model-registry
 *     posture) or AGENCY-scoped (the owning agency; tenant-runtime-model
 *     ownership matrix row "Agent | Platform/Agency/Client scope"). The
 *     scope is SERVER-DERIVED: routes resolve it from canonical durable
 *     state (the /agencies membership + owner authority) BEFORE the
 *     write, a caller-supplied scope is rejected, and the ownership is
 *     immutable once set (DB trigger). MKT-020 deliberately does NOT
 *     deliver Client-scoped declarations: the frozen acceptance criteria
 *     for this Work Item enforce "no client/workspace tables" statically;
 *   - VERSIONING, append-oriented: declared content is IMMUTABLE after
 *     registration — a correction RETIRES the old declaration and
 *     registers a NEW one (new identity, new version label); `retired`
 *     is TERMINAL. The (scope, agent_key) pair is unique among ACTIVE
 *     declarations (registration fence); retirement frees the key for the
 *     new version identity;
 *   - the §8-style idempotency fence: the logical register command is
 *     fingerprinted (scope + full declaration); a duplicate of the SAME
 *     command converges to the existing row (replayed=true); a key reused
 *     for a DIFFERENT command is a ConflictError — never a silent
 *     overwrite;
 *   - the APPEND-ONLY LIFECYCLE HISTORY: every applied transition
 *     (registered / retired) is recorded once in
 *     logical_agent_lifecycle_events (DB rejects UPDATE and DELETE; one
 *     event per transition per declaration — there is no second
 *     retirement), with reason and provenance.
 *
 * What this module deliberately does NOT do (bounded scope, MKT-020):
 *   - NO execution engine, NO dispatch, NO invocation: the logical Agent
 *     is a declaration, never a run (/executions owns runs; "Execution is
 *     the unit that acquires runtime resources", architecture.md §11);
 *   - NO workflow state, NO deployment state, NO infrastructure: no
 *     sandbox/pool/queue/runtime ownership or references (§12; enforced by
 *     the static architecture tests);
 *   - NO tenant data: no client/workspace/goal references exist anywhere
 *     in the module, the API surface or the storage (statically proven);
 *   - NO human agents and NO field agents (MKT-025 — in flight; the
 *     /field-agents authority owns Field Agent identity/availability);
 *   - NO extension registry (MKT-022) and NO policy engine (MKT-021);
 *   - NO provider SDKs (repo-wide prohibition; the provider adapter home
 *     is /ai-runtime's adapter directory, not here) and NO credentials.
 *
 * DEPENDENCY POSTURE (frozen matrix: /agents ──→ /executions, /ai-runtime,
 * /policies): MKT-020 needs NONE of the allowed dependencies — the logical
 * Agent contract is a standalone reusable declaration, so this public
 * entry imports ONLY platform ports (db/clock/ids). The matrix-sanctioned
 * dependencies remain available to later Work Items that compose runtime
 * behavior; the static architecture tests pin the MKT-020 import surface
 * to platform ports + intra-module files exactly.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// ---------------------------------------------------------------------------
// Lifecycle (the single registry edge)
// ---------------------------------------------------------------------------

/**
 * The logical Agent lifecycle. Declared content is immutable after
 * registration (corrections retire + re-register as a NEW identity); the
 * single lifecycle edge is `active → retired` and `retired` is TERMINAL
 * (a tombstone — history stays readable, the agent_key is freed for a new
 * version identity). There are deliberately no execution-flavored states:
 * a logical Agent is a declaration, not a run.
 */
export type LogicalAgentStatus = 'active' | 'retired';

export const LOGICAL_AGENT_TRANSITIONS: Readonly<
  Record<LogicalAgentStatus, readonly LogicalAgentStatus[]>
> = {
  active: ['retired'],
  retired: [],
};

export function isLegalLogicalAgentTransition(
  from: LogicalAgentStatus,
  to: LogicalAgentStatus,
): boolean {
  return LOGICAL_AGENT_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Scope (server-derived ownership)
// ---------------------------------------------------------------------------

/**
 * The ownership scope of one declaration: 'platform' (a platform-normalized
 * reusable declaration — the /ai-runtime model-registry posture) or
 * 'agency' (reusable operational IP of exactly one Agency). Server-derived
 * on every write path; a caller-supplied scope is never trusted.
 */
export type LogicalAgentScopeKind = 'platform' | 'agency';

// ---------------------------------------------------------------------------
// Capability descriptors — the provider-neutral declared capabilities
// ---------------------------------------------------------------------------

/**
 * One declared capability: WHAT the agent can do, expressed
 * provider-neutrally — a normalized capability KIND label (e.g.
 * 'text-generation', 'web-browsing', 'human-review') plus the bounded
 * parameter CONTRACT object interpreted by consumers (routing, policies,
 * matching). The descriptor is EXACTLY these two keys: provider/model
 * identifiers, SDK/adapter references, credentials, infrastructure
 * references (sandbox/pool/queue/runtime/deployment) and tenant/workflow/
 * execution references are structurally unrepresentable — the input guards
 * reject such keys at every nesting level of `parameters`, and the storage
 * CHECK (migration 022) rejects any descriptor shape other than this one.
 */
export interface AgentCapabilityDescriptor {
  readonly capabilityKind: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * The exact MKT-020 declaration field list — the machine-checkable
 * provider-neutral contract surface. Deliberately EXCLUDES provider/model/
 * SDK/credential/infrastructure/tenant/execution fields: this constant is
 * the static contract proof (architecture tests assert the migration
 * columns and the record shape against it).
 */
export const LOGICAL_AGENT_CONTRACT_FIELDS = [
  'agentKey',
  'displayName',
  'versionLabel',
  'description',
  'capabilities',
] as const;

/**
 * Input keys that can NEVER appear in a caller-supplied logical-agent
 * registration payload: server-derived identity/scope/lifecycle/provenance
 * (authority fields) PLUS every provider/model/SDK/credential-shaped key
 * PLUS every infrastructure-coupling key PLUS every workflow/execution/
 * deployment/tenant-data key — the provider-neutrality and
 * no-infrastructure-coupling guard for AGENT-001 (the logical Agent owns
 * NO tenant data, workflow state, deployment state or infrastructure,
 * architecture.md §12).
 */
export const LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS = [
  // Server-derived authority fields.
  'agentId',
  'scopeKind',
  'agencyId',
  'status',
  'version',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  'lifecycleEvents',
  // Provider/model authority — NEVER in a logical capability declaration.
  'provider',
  'providerName',
  'providerLabel',
  'providerId',
  'model',
  'modelName',
  'modelId',
  'modelKey',
  'modelRegistryId',
  'routingStrategy',
  // SDK/adapter-shaped keys — the declaration is data, never a package.
  'sdk',
  'sdkPackage',
  'clientLibrary',
  'adapter',
  'adapterConfig',
  // Credential-shaped keys — never in capability declarations.
  'credential',
  'credentialId',
  'secretHandle',
  'secret',
  'secretMaterial',
  'material',
  'apiKey',
  'api_key',
  'token',
  'password',
  // Infrastructure coupling — the logical Agent owns NO infrastructure
  // (§12; ADR-0002 "Agent Is a Logical Capability, Not a VM").
  'sandbox',
  'sandboxId',
  'pool',
  'poolId',
  'workerPool',
  'queue',
  'queueId',
  'queueName',
  'runtime',
  'runtimeClass',
  'deployment',
  'deploymentId',
  'endpoint',
  'url',
  'baseUrl',
  // Workflow/execution state — owned by /workflows and /executions.
  'executionId',
  'workflowId',
  'workflowState',
  'taskId',
  // Tenant data — the logical Agent owns NO tenant data (§12).
  'clientId',
  'workspaceId',
  'goalId',
] as const;

/**
 * Descriptor-level forbidden keys: keys that can NEVER appear on a
 * capability descriptor object. The descriptor is EXACTLY
 * { capabilityKind, parameters } — unknown keys are rejected outright by
 * the strict DTO validator, and this contract names the
 * provider/model/credential/infrastructure/tenant shapes explicitly so
 * the route DTO and the module guard share one frozen list.
 */
export const AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS = [
  // Server-derived / descriptor-shape authority.
  'agentId',
  'capabilityId',
  // Provider/model authority — never inside a capability descriptor.
  'provider',
  'providerName',
  'providerLabel',
  'providerId',
  'model',
  'modelName',
  'modelId',
  'modelKey',
  'modelRegistryId',
  // SDK/adapter-shaped keys.
  'sdk',
  'sdkPackage',
  'clientLibrary',
  'adapter',
  'adapterConfig',
  // Credential-shaped keys.
  'credential',
  'credentialId',
  'secretHandle',
  'secret',
  'secretMaterial',
  'material',
  'apiKey',
  'api_key',
  'token',
  'password',
  // Infrastructure coupling.
  'sandbox',
  'sandboxId',
  'pool',
  'poolId',
  'workerPool',
  'queue',
  'queueId',
  'queueName',
  'runtime',
  'runtimeClass',
  'deployment',
  'deploymentId',
  'endpoint',
  'url',
  'baseUrl',
  // Workflow/execution state.
  'executionId',
  'workflowId',
  'taskId',
  // Tenant data.
  'clientId',
  'workspaceId',
  'goalId',
] as const;

// ---------------------------------------------------------------------------
// Record + input shapes
// ---------------------------------------------------------------------------

/**
 * The registration input: the full provider-neutral declaration. The
 * ownership scope, identity, lifecycle and provenance are NOT part of the
 * input — they are derived server-side (the module API carries the scope
 * as an explicit server-derived argument resolved by the caller from
 * canonical ownership state; the DB scope trigger is the backstop).
 */
export interface LogicalAgentRegistrationInput {
  /** The reusable logical name (normalized label, 2..100 chars). */
  readonly agentKey: string;
  readonly displayName: string;
  /** The declared contract version label of THIS declaration (e.g. '1.0.0'). */
  readonly versionLabel: string;
  /** The contract text (1..2000 chars). */
  readonly description: string;
  /**
   * The declared capabilities — at least ONE descriptor (an agent that
   * declares nothing is not a capability declaration), at most 64.
   */
  readonly capabilities: readonly AgentCapabilityDescriptor[];
}

/**
 * Immutable storage shape of one persisted logical Agent — the declared
 * contract (exactly LOGICAL_AGENT_CONTRACT_FIELDS) plus the server-derived
 * scope, §8-style idempotency identity, provenance and the CAS version.
 * Content is immutable after registration; only the lifecycle
 * (active → retired, terminal) and its CAS token ever move.
 */
export interface LogicalAgentRecord {
  readonly agentId: string;
  /** The reusable logical name (identity, immutable). */
  readonly agentKey: string;
  readonly displayName: string;
  /** The declared contract version label (identity, immutable). */
  readonly versionLabel: string;
  readonly description: string;
  /** The declared capabilities (immutable, provider-neutral descriptors). */
  readonly capabilities: readonly AgentCapabilityDescriptor[];
  /** Server-derived ownership scope: 'platform' | 'agency'. */
  readonly scopeKind: LogicalAgentScopeKind;
  /** The owning Agency for agency-scoped declarations; null for platform scope. */
  readonly agencyId: string | null;
  readonly status: LogicalAgentStatus;
  /** The §8-style logical register-command key (unique per scope, DB-fenced). */
  readonly idempotencyKey: string;
  /** The §8-style digest of the fenced logical register command (convergence proof). */
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  /** The CAS token (bumped on the single lifecycle edge). */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One APPEND-ONLY lifecycle history row: the applied transition
 * ('registered' — born active, from_status null; 'retired' — the single
 * edge active → retired), the server-recorded reason and the provenance.
 * Written once; the DB rejects UPDATE and DELETE; (agentId, transition)
 * is unique — there is no second retirement.
 */
export interface LogicalAgentLifecycleEventRecord {
  readonly eventId: string;
  readonly agentId: string;
  readonly transition: 'registered' | 'retired';
  readonly fromStatus: LogicalAgentStatus | null;
  readonly toStatus: LogicalAgentStatus;
  readonly reason: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * The outcome of a logical-agent registration: the record and whether this
 * request was a REPLAY of an already-recorded logical register command
 * (the §8-style idempotency fence converged the duplicate to the existing
 * identity — no second declaration row).
 */
export interface LogicalAgentRegistrationOutcome {
  readonly agent: LogicalAgentRecord;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface AgentsModuleApi {
  /**
   * Registers one logical Agent declaration — born ACTIVE with content
   * IMMUTABLE from creation (corrections retire + re-register; retiring is
   * the single lifecycle edge, terminal). `scope.agencyId` is the
   * SERVER-DERIVED ownership input resolved by the caller from canonical
   * ownership state (null = platform scope — the platform surfaces; a
   * concrete agency = the owning Agency, resolved through the /agencies
   * authority BEFORE the write): a caller-supplied scope is never
   * trusted, and the migration-022 scope immutability + FK are the
   * backstops.
   *
   * The §8-style idempotency key is REQUIRED and DB-fenced per scope: a
   * duplicate of the same logical command (same create fingerprint)
   * converges (replayed=true); a key reused for a DIFFERENT command is a
   * ConflictError. The (scope, agent_key) pair is unique among ACTIVE
   * declarations — registering a key that already has an ACTIVE
   * declaration in the same scope is a ConflictError (deterministic
   * duplicate fence; a retired declaration frees the key for a NEW
   * identity).
   *
   * Provider/model/SDK/credential/infrastructure/tenant-shaped input keys
   * are REJECTED at the top level AND at every nesting level of the
   * capability descriptor parameters (the AGENT-001 module-side guard).
   */
  registerAgent(input: {
    /**
     * The server-derived ownership scope: null = platform scope; a
     * concrete agency id = the owning Agency (resolved canonically by the
     * caller, never caller-supplied through a DTO).
     */
    readonly scope: { readonly agencyId: string | null };
    readonly agent: LogicalAgentRegistrationInput;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<LogicalAgentRegistrationOutcome>;
  /** Raw record by id (retired tombstones included) — module/route internal reads. */
  getAgent(agentId: string): Promise<LogicalAgentRecord | null>;
  /**
   * The declarations of one scope, oldest first. Platform scope
   * (agencyId null) lists platform declarations; agency scope lists the
   * Agency's declarations. `includeRetired` keeps the tombstone history
   * visible (the platform catalog surface lists ACTIVE only; the agency
   * registry surface lists every state).
   */
  listAgents(input: {
    readonly agencyId: string | null;
    readonly includeRetired: boolean;
  }): Promise<readonly LogicalAgentRecord[]>;
  /**
   * The single lifecycle transition: ACTIVE → RETIRED (terminal). CAS on
   * the presented version; the DB terminal/immutability triggers are the
   * backstops. Retiring a declaration never rewrites its declared content
   * and never erases the lifecycle history (the 'retired' event is
   * appended in the same transaction). A second retirement is a
   * ConflictError.
   */
  retireAgent(input: {
    readonly agentId: string;
    readonly expectedVersion: number;
    /** Bounded server-recorded reason (0..512 chars). */
    readonly reason: string;
    readonly actorId: string | null;
  }): Promise<LogicalAgentRecord>;
  /** The append-only lifecycle history of one declaration, oldest first. */
  listLifecycleEvents(agentId: string): Promise<readonly LogicalAgentLifecycleEventRecord[]>;
}

export interface AgentsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix (/agents ──→ /executions, /ai-runtime, /policies):
   * MKT-020 needs NONE of them — the logical Agent contract is a
   * standalone reusable capability declaration with no execution state,
   * no AI routing state and no policy state. The module imports ONLY
   * platform ports (db/clock/ids); the allowed dependencies remain
   * available to the later Work Items that compose runtime behavior
   * (MKT-021 policies, the execution engine, extensions).
   */
}

export { createAgentsModule } from './internal/module.ts';
/**
 * The input guards (validation + provider-neutrality + authority-field
 * rejection, including the deep nested forbidden-key walk over capability
 * descriptor parameters) — exported for unit tests and future server-side
 * callers so the guard semantics are part of the module contract. Pure
 * functions.
 */
export {
  assertValidIdempotencyKey,
  assertValidLogicalAgentRegistrationInput,
  assertValidLogicalAgentRetireReason,
  containsForbiddenCapabilityKey,
} from './internal/store.ts';
