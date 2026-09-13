/**
 * MarketingOS module: /ai-runtime
 * Authority: AI routing/evaluation/usage (spec/implementation-contract.md §1).
 *
 * MKT-017 implements the REGISTRY LAYER of this authority (work-items.md:
 * "implement provider-neutral TaskProfile and normalized model
 * capability/telemetry registry"; requirements.md AI-001 "Provide
 * provider-neutral AI TaskProfiles, model registry, routing and usage
 * telemetry" — the routing/eligibility/cascade slice is AI-002/MKT-018, the
 * evaluation slice is AI-003/MKT-019). This module owns:
 *
 *   - the PROVIDER-NEUTRAL TaskProfile (implementation-contract §10):
 *     task class, quality target, risk class, context requirements, latency
 *     target, maximum cost, privacy class, tool requirements, output schema,
 *     evaluator contract and escalation policy. A TaskProfile is the NEUTRAL
 *     REQUEST CONTRACT ("The AI Runtime is provider-neutral and receives a
 *     TaskProfile rather than a raw provider request", architecture.md §18)
 *     that routing (MKT-018) and adapters (later Work Items) consume: it
 *     carries NO provider names, NO model names and NO credentials — the
 *     module input guards REJECT provider/model/credential-shaped keys, and
 *     the storage has no column capable of holding them (AI-AC-01);
 *   - the normalized MODEL REGISTRY (ai-runtime-and-routing.md §3): model
 *     records with provider/model identity as LABELS — data, never SDK
 *     imports (AI-AC-02) — plus the capability matrix, context limits, cost
 *     signals, latency signals, reliability, evaluator-performance-by-task-
 *     class quality signals, privacy characteristics and the CURRENT
 *     availability state derived from append-only observations;
 *   - the USAGE TELEMETRY record shape (architecture.md §24: "AI usage
 *     records model/provider, request class, tokens/compute where available,
 *     cost, latency, evaluator outcome and escalation count when
 *     authoritative"): append-oriented rows linking the TaskProfile, the
 *     registry model ref, the execution context reference, the correlation
 *     identity and the observed outcome signals;
 *   - the EVALUATION LAYER (MKT-019, AI-003): the provider-neutral
 *     evaluator REGISTRY (normalized task-level evaluator definitions
 *     referenced by TaskProfile evaluatorIds BY LABEL — no provider/model
 *     names as anything but labels, no credentials ever), the task-level
 *     EVALUATION RUN (evaluation requests derived from a TaskProfile's
 *     evaluator contract, executed by built-in deterministic evaluators
 *     and/or caller-supplied evaluator engines — model judges are advisory
 *     evidence, per implementation-contract §12), the append-only
 *     EVALUATION OUTCOME records (verdict/score, rubric dimensions,
 *     evidence citations, uncertainty — linked to the Execution and the
 *     usage-telemetry row, AI-AC-08-independent of business outcomes) and
 *     the HUMAN-REVIEW HOOK (review-request records with the pending →
 *     approved/rejected/dismissed lifecycle and append-only transitions —
 *     the hook records review intent/outcome, it never executes human
 *     work).
 *
 * What this module deliberately does NOT do (post-MKT-019 scope bounds):
 *   - NO provider adapters of its own at route time and NO model
 *     invocation: no provider SDK may be imported by this module's domain
 *     code — SDKs may only ever appear inside /ai-runtime ADAPTER
 *     implementations (AI-AC-02). The registry is data + contracts, not a
 *     provider client; the adapter is supplied by the caller at route
 *     time (MKT-018);
 *   - NO credentials: the TaskProfile, evaluation and telemetry records
 *     carry no credential references (routing-time credential resolution
 *     is MKT-018 composing /credentials);
 *   - NO business-outcome measurement (AI-AC-08): the evaluation layer
 *     reads TaskProfile/execution/usage context ONLY — it never imports
 *     /metrics or /experiments surfaces, and its input guards reject
 *     business-outcome-shaped keys. Model evaluations and business
 *     outcomes remain separate datasets (spec/ai-runtime-and-routing.md
 *     §8);
 *   - NO second human-execution engine: the review hook records review
 *     intent/outcome (pending → approved/rejected/dismissed) — humans ACT
 *     through the existing Job/Task/Execution authorities (/jobs,
 *     /field-agents).
 *
 * Registry posture (append-oriented, per the architecture's history rules):
 * TaskProfile and model-registry CONTENT is immutable after creation —
 * corrections retire the record and create a NEW one; `retired` is terminal
 * (DB-triggered); availability/telemetry observations and usage telemetry
 * are append-only history (the DB rejects UPDATE and DELETE).
 *
 * Tenancy (implementation-contract §2 scope chain): TaskProfiles and usage
 * telemetry are WORKSPACE-scoped with server-derived immutable Client/Agency
 * ownership (routes resolve the canonical owner BEFORE authorize; a
 * caller-supplied UUID is never authorization); the model registry is
 * platform-level normalized data. The module composes the /executions public
 * API exactly where the frozen dependency matrix sanctions it
 * (/ai-runtime ──→ /executions, /policies, /credentials, /evidence) — to
 * validate telemetry execution references; it imports NOTHING else.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { ExecutionsModuleApi } from '../executions/public.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';

// ---------------------------------------------------------------------------
// TaskProfile — the provider-neutral request contract (§10)
// ---------------------------------------------------------------------------

/**
 * The TaskProfile lifecycle. Registry content is immutable; the single
 * lifecycle edge is `active → retired` and `retired` is TERMINAL (a retired
 * profile is a tombstone — corrections register a NEW profile). There are
 * deliberately no execution-flavored states: a TaskProfile is a contract
 * declaration, not a run.
 */
export type TaskProfileStatus = 'active' | 'retired';

export const TASK_PROFILE_TRANSITIONS: Readonly<
  Record<TaskProfileStatus, readonly TaskProfileStatus[]>
> = {
  active: ['retired'],
  retired: [],
};

export function isLegalTaskProfileTransition(
  from: TaskProfileStatus,
  to: TaskProfileStatus,
): boolean {
  return TASK_PROFILE_TRANSITIONS[from].includes(to);
}

/**
 * The normalized risk classification (implementation-contract §10
 * "riskClass"). Closed vocabulary v1: the routing hard filters (MKT-018)
 * consume these labels as data.
 */
export const TASK_PROFILE_RISK_CLASSES = ['low', 'medium', 'high'] as const;
export type TaskProfileRiskClass = (typeof TASK_PROFILE_RISK_CLASSES)[number];

/**
 * The normalized privacy classification (implementation-contract §10
 * "privacyClass"; the routing hard filters include "privacy/data residency").
 * Closed vocabulary v1: `public` | `internal` | `confidential` | `restricted`.
 */
export const TASK_PROFILE_PRIVACY_CLASSES = [
  'public',
  'internal',
  'confidential',
  'restricted',
] as const;
export type TaskProfilePrivacyClass = (typeof TASK_PROFILE_PRIVACY_CLASSES)[number];

/**
 * The exact §10 TaskProfile field list — the provider-neutral contract
 * surface. Deliberately EXCLUDES provider/model/credential fields: this
 * constant is the machine-checkable AI-AC-01 contract proof (architecture
 * tests assert the migration columns and the record shape against it).
 */
export const TASK_PROFILE_CONTRACT_FIELDS = [
  'taskClass',
  'qualityTarget',
  'riskClass',
  'contextRequirements',
  'latencyTargetMs',
  'maxCostPerInvocation',
  'privacyClass',
  'toolRequirements',
  'outputSchema',
  'evaluatorIds',
  'escalationPolicy',
] as const;

/**
 * Input keys that can NEVER appear in a caller-supplied TaskProfile payload:
 * server-derived identity/scope/lifecycle/provenance (authority fields)
 * PLUS every provider/model/credential-shaped key — the provider-neutrality
 * guard (AI-AC-01). A TaskProfile is the neutral request contract: routing
 * (MKT-018) resolves providers/models from the registry, and credentials
 * never live in task declarations.
 */
export const TASK_PROFILE_FORBIDDEN_INPUT_KEYS = [
  // Server-derived authority fields.
  'taskProfileId',
  'workspaceId',
  'clientId',
  'agencyId',
  'status',
  'version',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Provider/model authority — NEVER caller-supplied in a TaskProfile.
  'provider',
  'providerName',
  'providerLabel',
  'model',
  'modelName',
  'modelId',
  'modelKey',
  'modelRegistryId',
  'routingStrategy',
  'candidateModels',
  // Credential-shaped keys — never in task declarations.
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
] as const;

/**
 * The provider-neutral TaskProfile INPUT contract (§10, exactly the eleven
 * fields). `contextRequirements` is the INPUT contract (a bounded JSON
 * object — e.g. token bounds); `outputSchema` is the OUTPUT contract (a
 * JSON-schema-shaped object — an output failing schema validation is never
 * accepted); `evaluatorIds` are evaluation-hook placeholders (MKT-019);
 * `escalationPolicy` is a declarative object interpreted by routing
 * (MKT-018).
 */
export interface TaskProfileInput {
  readonly taskClass: string;
  readonly qualityTarget: string;
  readonly riskClass: TaskProfileRiskClass;
  readonly contextRequirements: Readonly<Record<string, unknown>>;
  readonly latencyTargetMs: number;
  readonly maxCostPerInvocation: number;
  readonly privacyClass: TaskProfilePrivacyClass;
  readonly toolRequirements: readonly string[];
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly evaluatorIds: readonly string[];
  readonly escalationPolicy: Readonly<Record<string, unknown>>;
}

/**
 * Immutable storage shape of one persisted TaskProfile — the neutral request
 * contract plus the server-derived scope chain, §8-style idempotency
 * identity and provenance. Content is immutable after creation; only the
 * lifecycle (active → retired, terminal) and its CAS version ever move.
 */
export interface TaskProfileRecord {
  readonly taskProfileId: string;
  /** The §10 contract fields (exactly TASK_PROFILE_CONTRACT_FIELDS). */
  readonly taskClass: string;
  readonly qualityTarget: string;
  readonly riskClass: TaskProfileRiskClass;
  readonly contextRequirements: Readonly<Record<string, unknown>>;
  readonly latencyTargetMs: number;
  readonly maxCostPerInvocation: number;
  readonly privacyClass: TaskProfilePrivacyClass;
  readonly toolRequirements: readonly string[];
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly evaluatorIds: readonly string[];
  readonly escalationPolicy: Readonly<Record<string, unknown>>;
  /** Server-derived from the canonical Workspace owner at creation. */
  readonly workspaceId: string;
  /** Server-derived from the canonical Workspace owner at creation. */
  readonly clientId: string;
  /** Server-derived from the canonical Workspace owner at creation. */
  readonly agencyId: string;
  readonly status: TaskProfileStatus;
  /** The §8-style logical create-command key (unique per workspace, DB-fenced). */
  readonly idempotencyKey: string;
  /** The §8-style digest of the fenced logical create command (convergence proof). */
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The outcome of a TaskProfile create: the record and whether this request
 * was a REPLAY of an already-recorded logical create command (the §8-style
 * idempotency fence converged the duplicate to the existing identity — no
 * second profile row).
 */
export interface TaskProfileCreateOutcome {
  readonly taskProfile: TaskProfileRecord;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Model registry — normalized model records (ai-runtime-and-routing.md §3)
// ---------------------------------------------------------------------------

/**
 * The model-registry lifecycle. Registry content is immutable after
 * registration (corrections retire + re-register); the single lifecycle edge
 * is `active → retired` and `retired` is TERMINAL.
 */
export type ModelRegistryStatus = 'active' | 'retired';

export const MODEL_REGISTRY_TRANSITIONS: Readonly<
  Record<ModelRegistryStatus, readonly ModelRegistryStatus[]>
> = {
  active: ['retired'],
  retired: [],
};

export function isLegalModelRegistryTransition(
  from: ModelRegistryStatus,
  to: ModelRegistryStatus,
): boolean {
  return MODEL_REGISTRY_TRANSITIONS[from].includes(to);
}

/**
 * The CURRENT availability state of a registry entry — SERVER-DERIVED from
 * the LATEST appended observation, never caller-supplied and never directly
 * updatable. `unavailable` is an observed signal, not a lifecycle: a model
 * whose observations report `unavailable` remains an active registry entry
 * (routing eligibility decides what it means, MKT-018).
 */
export const MODEL_AVAILABILITY_STATES = ['available', 'degraded', 'unavailable'] as const;
export type ModelAvailabilityState = (typeof MODEL_AVAILABILITY_STATES)[number];

/**
 * Input keys that can NEVER appear in a caller-supplied model-registration
 * payload: server-derived identity/lifecycle/current-state/provenance fields
 * PLUS SDK/credential-shaped keys. The registry record is DATA — the
 * provider label is a normalized label, never a package import, a client
 * configuration or a credential.
 */
export const MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS = [
  // Server-derived authority fields.
  'modelRegistryId',
  'status',
  'availabilityState',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  // SDK/adapter/credential-shaped keys — never registry data.
  'sdk',
  'sdkPackage',
  'clientLibrary',
  'adapter',
  'adapterConfig',
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
] as const;

/**
 * The model-registration input: the normalized model record as DECLARED
 * data. Cost/latency/reliability signals are nullable (NULL = unknown —
 * a signal is never fabricated); `capabilities`/`toolFeatures` are
 * normalized label arrays (the modality/capability matrix and supported tool
 * features); `qualitySignals` is evaluator-performance-by-task-class data;
 * `privacyCharacteristics` is a normalized privacy declaration object.
 */
export interface ModelRegistrationInput {
  readonly providerLabel: string;
  readonly modelKey: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly toolFeatures: readonly string[];
  readonly contextLimitTokens: number;
  readonly costInputPerMtok: number | null;
  readonly costOutputPerMtok: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly reliability: number | null;
  readonly qualitySignals: Readonly<Record<string, unknown>>;
  readonly privacyCharacteristics: Readonly<Record<string, unknown>>;
}

/**
 * Immutable storage shape of one persisted registry model — the declared
 * signals are immutable after registration; `availabilityState` is the
 * observation-derived current state; `status` moves along the single
 * lifecycle edge; `version` is the CAS token.
 */
export interface ModelRegistryRecord {
  readonly modelRegistryId: string;
  /** Provider LABEL — data, never an SDK import (AI-AC-02). */
  readonly providerLabel: string;
  /** Normalized model key label — data. */
  readonly modelKey: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly toolFeatures: readonly string[];
  readonly contextLimitTokens: number;
  readonly costInputPerMtok: number | null;
  readonly costOutputPerMtok: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly reliability: number | null;
  readonly qualitySignals: Readonly<Record<string, unknown>>;
  readonly privacyCharacteristics: Readonly<Record<string, unknown>>;
  readonly availabilityState: ModelAvailabilityState;
  readonly status: ModelRegistryStatus;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One APPEND-ONLY availability/telemetry observation of a registry model —
 * written once, never updated or deleted (DB-enforced). The registry row's
 * `availabilityState` is the latest observation's state, derived on append.
 */
export interface ModelObservationRecord {
  readonly observationId: string;
  readonly modelRegistryId: string;
  readonly availabilityState: ModelAvailabilityState;
  readonly observedLatencyP50Ms: number | null;
  readonly observedLatencyP95Ms: number | null;
  /** Observation source label (e.g. 'platform-probe', 'usage-aggregate'). */
  readonly source: string;
  readonly notes: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * The outcome of an observation append: the observation row (append-only
 * history) and the registry record AFTER the current-state derivation.
 */
export interface ModelObservationOutcome {
  readonly observation: ModelObservationRecord;
  readonly model: ModelRegistryRecord;
}

// ---------------------------------------------------------------------------
// Usage telemetry — the append-oriented invocation-outcome record (§24)
// ---------------------------------------------------------------------------

/**
 * The routing/invocation outcome recorded by one telemetry row. `unknown`
 * follows the frozen UNKNOWN semantics: the external outcome could not be
 * proven — it is never success and is not automatically retriable; a
 * resolution appends a NEW record (never an overwrite).
 */
export const USAGE_TELEMETRY_OUTCOMES = [
  'succeeded',
  'failed',
  'escalated',
  'unknown',
] as const;
export type UsageTelemetryOutcome = (typeof USAGE_TELEMETRY_OUTCOMES)[number];

/**
 * Input keys that can NEVER appear in a caller-supplied telemetry payload:
 * the server-derived identity/scope/provenance fields, the correlation
 * identity (derived from the ambient correlation context), the create
 * fingerprint, PLUS provider/model-authority keys — the model ref is the
 * registry entry id (`modelRegistryId` is an explicit REFERENCE input, the
 * provider/model labels themselves are never inputs) — and credential-shaped
 * keys.
 */
export const USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS = [
  // Server-derived authority fields.
  'usageId',
  'workspaceId',
  'clientId',
  'agencyId',
  'correlationId',
  'causationId',
  'createFingerprint',
  'createdBy',
  'createdAt',
  // Provider/model authority — the model ref is modelRegistryId only.
  'provider',
  'providerName',
  'providerLabel',
  'model',
  'modelName',
  'modelKey',
  'routingStrategy',
  // Credential-shaped keys — never in telemetry records.
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
] as const;

/**
 * The usage-telemetry append input. `taskProfileId` and `modelRegistryId`
 * are REFERENCE inputs (scope-checked: the profile must belong to the same
 * Workspace; the model must exist in the registry); `executionId` is an
 * OPTIONAL execution-context reference (same-Workspace, validated through
 * the /executions public API); `idempotencyKey` is the §8-style logical
 * append-command key; `evaluationRef` is the opaque evaluation-outcome link
 * (placeholder until MKT-019).
 */
export interface UsageTelemetryInput {
  readonly taskProfileId: string;
  readonly modelRegistryId: string;
  readonly executionId: string | null;
  readonly outcome: UsageTelemetryOutcome;
  readonly latencyMs: number;
  readonly costAmount: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly evaluationRef: string | null;
  readonly escalationCount: number;
  readonly idempotencyKey: string;
}

/**
 * Immutable storage shape of one persisted usage-telemetry row — the
 * append-oriented record of a routing/invocation outcome. Written once; the
 * table rejects UPDATE and DELETE at the database level.
 */
export interface UsageTelemetryRecord {
  readonly usageId: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly taskProfileId: string;
  readonly modelRegistryId: string;
  readonly executionId: string | null;
  /** Server-derived from the ambient correlation context. */
  readonly correlationId: string;
  readonly outcome: UsageTelemetryOutcome;
  readonly latencyMs: number;
  readonly costAmount: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly evaluationRef: string | null;
  readonly escalationCount: number;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * The outcome of a telemetry append: the record and whether this request was
 * a REPLAY of the already-recorded logical append command (the §8-style
 * idempotency fence converged the duplicate — no second row, no rewrite).
 */
export interface UsageTelemetryAppendOutcome {
  readonly record: UsageTelemetryRecord;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface AiRuntimeModuleApi {
  /**
   * Registers a Workspace-scoped TaskProfile — the provider-neutral request
   * contract, born ACTIVE with content IMMUTABLE from creation (corrections
   * register a NEW profile; retiring is the single lifecycle edge, terminal).
   * The scope chain is server-derived input resolved by the caller from
   * canonical ownership state (routes resolve it BEFORE authorize; the
   * DB scope-chain trigger is the backstop). The §8-style idempotency key is
   * REQUIRED and DB-fenced per workspace: a duplicate of the same logical
   * command (same fingerprint) converges (replayed=true); a key reused for
   * a DIFFERENT command is a ConflictError. Provider/model/credential-shaped
   * input keys are REJECTED (the AI-AC-01 module-side guard).
   */
  createTaskProfile(input: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly profile: TaskProfileInput;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<TaskProfileCreateOutcome>;
  /** Raw record by id (retired tombstones included) — module/route internal reads. */
  getTaskProfile(taskProfileId: string): Promise<TaskProfileRecord | null>;
  /**
   * The TaskProfiles of one Workspace in EVERY lifecycle state (retired
   * history stays visible), oldest first.
   */
  listTaskProfiles(workspaceId: string): Promise<readonly TaskProfileRecord[]>;
  /**
   * The single lifecycle transition: ACTIVE → RETIRED (terminal). CAS on the
   * presented version; the DB terminal/immutability triggers are the
   * backstops. Retiring a profile never rewrites its contract content and
   * never affects already-recorded telemetry (history stays recordable).
   */
  retireTaskProfile(input: {
    readonly taskProfileId: string;
    readonly expectedVersion: number;
  }): Promise<TaskProfileRecord>;

  /**
   * Registers a PLATFORM-level model-registry entry, born ACTIVE with
   * declared signals IMMUTABLE from registration. The (provider_label,
   * model_key) pair is DB-fenced among ACTIVE entries — registering a pair
   * that already has an ACTIVE entry is a ConflictError (deterministic
   * duplicate fence; a retired pair may be re-registered as a NEW identity).
   * SDK/credential-shaped input keys are REJECTED (the AI-AC-02
   * module-side guard: the provider is a LABEL, never an import).
   */
  registerModel(input: {
    readonly model: ModelRegistrationInput;
    readonly actorId: string | null;
  }): Promise<ModelRegistryRecord>;
  /** Raw record by id (retired tombstones included) — module/route internal reads. */
  getModel(modelRegistryId: string): Promise<ModelRegistryRecord | null>;
  /** The ACTIVE registry entries, oldest first (retired history stays readable by id). */
  listModels(): Promise<readonly ModelRegistryRecord[]>;
  /**
   * Appends one availability/telemetry OBSERVATION — append-only history
   * (the row is written once and can never be updated or deleted). The
   * registry entry's current `availabilityState` is derived from this
   * observation (the only sanctioned mutation path for that column;
   * observations on a retired entry record history without mutating the
   * tombstone). The observed latency signals are recorded on the row for
   * routing-time aggregation (MKT-018).
   */
  appendModelObservation(input: {
    readonly modelRegistryId: string;
    readonly availabilityState: ModelAvailabilityState;
    readonly observedLatencyP50Ms: number | null;
    readonly observedLatencyP95Ms: number | null;
    readonly source: string;
    readonly notes: string;
    readonly actorId: string | null;
  }): Promise<ModelObservationOutcome>;
  /** The append-only observation history of one model, oldest first. */
  listModelObservations(modelRegistryId: string): Promise<readonly ModelObservationRecord[]>;
  /**
   * The single model lifecycle transition: ACTIVE → RETIRED (terminal).
   * CAS on the presented version. Retiring never deletes observations or
   * telemetry history.
   */
  retireModel(input: {
    readonly modelRegistryId: string;
    readonly expectedVersion: number;
  }): Promise<ModelRegistryRecord>;

  /**
   * Appends one USAGE TELEMETRY row — the append-oriented record of a
   * routing/invocation outcome. The scope chain is server-derived input
   * resolved by the caller; the DB scope-chain trigger backstops it. The
   * task-profile reference must belong to the SAME Workspace (uniform
   * NotFoundError otherwise — a foreign profile id is not a traversal
   * oracle); the model reference must exist in the registry (any lifecycle
   * state — history records invocations that HAPPENED, and retiring a
   * candidate never rewrites history); an execution reference, when present,
   * is validated through the /executions public API and must belong to the
   * SAME Workspace. The §8-style idempotency key is REQUIRED and DB-fenced
   * per workspace: a duplicate of the same logical command converges
   * (replayed=true); a key reused for a DIFFERENT command is a
   * ConflictError. Rows are immutable once written (the DB rejects UPDATE
   * and DELETE) — a correction appends a NEW record.
   */
  appendUsageTelemetry(input: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly usage: UsageTelemetryInput;
    readonly correlationId: string;
    readonly actorId: string | null;
  }): Promise<UsageTelemetryAppendOutcome>;
  /** Raw record by id — module/route internal reads. */
  getUsageTelemetry(usageId: string): Promise<UsageTelemetryRecord | null>;
  /**
   * The usage-telemetry rows of one Workspace, oldest first (bounded by
   * `limit`, default 500, max 1000 — long-list handling; older history
   * remains queryable through the module API).
   */
  listUsageTelemetry(workspaceId: string, limit?: number): Promise<readonly UsageTelemetryRecord[]>;

  // ----- Routing policy (MKT-018, AI-002 — extends the same module) -------
  //
  // The routing layer extends the REGISTRY layer (MKT-017) with hard
  // eligibility, performance ranking, cost/latency tradeoff and cheap-first
  // cascade execution (spec/ai-runtime-and-routing.md §4/§5). The router is
  // the /ai-runtime module itself (AI-AC-03) — OpenRouter is pluggable as an
  // ADAPTER behind the provider-neutral contract (§6, §9). Domain modules
  // never import adapters; routing depends on the adapter CONTRACT (ports),
  // not implementations (the architecture test guards the boundary).

  /**
   * Registers a WORKSPACE-scoped routing policy — the admin-managed
   * declarative policy interpreted by the routing core (hard-eligibility
   * filters, ranking weights, cost/latency tradeoff weights, cascade
   * order). Born ACTIVE with content IMMUTABLE from creation (corrections
   * register a NEW policy; retiring is the single lifecycle edge, terminal).
   * The (workspace_id, idempotency_key) §8-style fence converges duplicates;
   * a key reused for a DIFFERENT command is a ConflictError. The
   * (workspace_id, policy_name) pair is unique among ACTIVE entries.
   */
  createRoutingPolicy(input: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly policy: RoutingPolicyInput;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<RoutingPolicyCreateOutcome>;
  /** Raw record by id (retired tombstones included) — module/route internal reads. */
  getRoutingPolicy(routingPolicyId: string): Promise<RoutingPolicyRecord | null>;
  /** The routing policies of one Workspace in EVERY lifecycle state, oldest first. */
  listRoutingPolicies(workspaceId: string): Promise<readonly RoutingPolicyRecord[]>;
  /**
   * The single lifecycle transition: ACTIVE → RETIRED (terminal). CAS on
   * the presented version; the DB terminal/immutability triggers are the
   * backstops.
   */
  retireRoutingPolicy(input: {
    readonly routingPolicyId: string;
    readonly expectedVersion: number;
  }): Promise<RoutingPolicyRecord>;

  // ----- Routing decision (selection + cascade) -------------------------
  //
  // The routing decision API: routeTask applies the routing policy to a
  // TaskProfile (eligibility → ranking → tradeoff → selection), runs the
  // cheap-first cascade with the supplied adapter + validator, persists the
  // selection decision and cascade run/steps, and returns the cascade
  // outcome. The caller supplies the adapter (the composition root wires
  // the OpenRouter adapter; tests supply fakes) and the validator (the
  // default validator is the output-schema validator; domain modules may
  // supply custom validators when MKT-019 lands).

  /**
   * Routes a TaskProfile: applies the routing policy (or the default
   * policy when no policy is supplied), runs the cheap-first cascade with
   * the supplied adapter and validator, persists the selection decision
   * (AUTHORITATIVE — the cascade invoked models and observed cost/latency)
   * and the cascade run/steps, and returns the outcome. The §8-style
   * idempotency key is REQUIRED and DB-fenced per workspace.
   */
  routeTask(input: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly taskProfileId: string;
    readonly routingPolicyId: string | null;
    readonly adapter: ProviderAdapter;
    readonly validator: CascadeValidator;
    readonly invocationInput: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly actorId: string | null;
  }): Promise<RoutingOutcome>;

  /**
   * Routes a TaskProfile SPECULATIVELY: applies the routing policy and
   * records the selection decision (eligible set + ranking + tradeoff +
   * chosen model + phase trace) but does NOT invoke the cascade — the
   * decision is recorded as NON-AUTHORITATIVE (no observed cost/latency/
   * evaluation telemetry). Useful for previewing the routing decision
   * before committing to a cascade (AI-AC-04 phase-order proof, used by
   * the routing regression matrix).
   */
  previewRouting(input: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly taskProfileId: string;
    readonly routingPolicyId: string | null;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly actorId: string | null;
  }): Promise<SelectionDecisionRecord>;

  /** Raw selection-decision record by id — module/route internal reads. */
  getSelectionDecision(selectionId: string): Promise<SelectionDecisionRecord | null>;
  /** The selection decisions of one Workspace, newest first (bounded). */
  listSelectionDecisions(
    workspaceId: string,
    limit?: number,
  ): Promise<readonly SelectionDecisionRecord[]>;
  /** Raw cascade-run record by id (steps included) — module/route internal reads. */
  getCascadeRun(cascadeRunId: string): Promise<CascadeRunRecord | null>;
  /** The cascade runs of one Workspace, newest first (bounded). */
  listCascadeRuns(workspaceId: string, limit?: number): Promise<readonly CascadeRunRecord[]>;

  // ----- Evaluation framework (MKT-019, AI-003 — extends the same module) --
  //
  // The evaluation layer extends the merged REGISTRY + ROUTING layers with
  // task-level evaluators, the human-review hook and execution-linked
  // quality telemetry (spec/ai-runtime-and-routing.md §7/§8;
  // implementation-contract §12). Evaluation is INDEPENDENT of business-
  // outcome measurement (AI-AC-08): the evaluation layer reads
  // TaskProfile/execution/usage context only — it never imports /metrics
  // or /experiments surfaces (static architecture proof) and its input
  // guards reject business-outcome-shaped keys.

  /**
   * Registers a PLATFORM-level evaluator registry entry, born ACTIVE with
   * declared content IMMUTABLE from registration (corrections retire +
   * re-register; the single lifecycle edge is terminal). The
   * (evaluator_key) pair is DB-fenced among ACTIVE entries — registering a
   * key that already has an ACTIVE entry is a ConflictError (a retired
   * key may be re-registered as a NEW identity). Provider/model/SDK/
   * credential/business-outcome-shaped input keys are REJECTED.
   */
  registerEvaluator(input: {
    readonly evaluator: EvaluatorRegistrationInput;
    readonly actorId: string | null;
  }): Promise<EvaluatorRecord>;
  /** Raw record by id (retired tombstones included) — module/route internal reads. */
  getEvaluator(evaluatorRegistryId: string): Promise<EvaluatorRecord | null>;
  /** The ACTIVE registry entries, oldest first (retired history stays readable by id). */
  listEvaluators(): Promise<readonly EvaluatorRecord[]>;
  /**
   * The single evaluator lifecycle transition: ACTIVE → RETIRED
   * (terminal). CAS on the presented version; the DB terminal/immutability
   * triggers are the backstops. Retiring never rewrites evaluation
   * history (the key + version are denormalized on the outcome rows).
   */
  retireEvaluator(input: {
    readonly evaluatorRegistryId: string;
    readonly expectedVersion: number;
  }): Promise<EvaluatorRecord>;

  /**
   * Runs one EVALUATION of a TaskProfile's evaluator contract and records
   * the append-only outcome rows. The evaluation request is DERIVED from
   * the profile's evaluatorIds (never caller-selected): each key resolves
   * to its ACTIVE registry entry (unknown/retired-all key → uniform
   * NotFoundError); the evaluator implementation is a caller-supplied
   * ENGINE for that key when provided, otherwise the module's built-in
   * deterministic evaluator for the kind, otherwise a ConflictError (the
   * contract is unsatisfiable — partial evaluation is never silent).
   * Human-review-kind evaluators record `unknown` (the human decides via
   * the review hook, never a machine).
   *
   * Execution linkage is server-proven: the execution reference, when
   * present, is validated through the /executions public API (same
   * Workspace — uniform NotFoundError otherwise); the usage-telemetry
   * reference, when present, must belong to the same Workspace; every
   * evidence citation is resolved through the /evidence public API (same
   * Client). The §8-style idempotency key is REQUIRED and DB-fenced per
   * (Workspace, key, evaluatorKey): a duplicate of the same logical
   * command converges (replayed=true); a key reused for a DIFFERENT
   * command is a ConflictError. Outcome rows are append-only (DB rejects
   * UPDATE and DELETE) — corrections append NEW rows.
   */
  evaluateTask(input: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly taskProfileId: string;
    readonly executionId: string | null;
    readonly usageId: string | null;
    readonly output: Readonly<Record<string, unknown>> | null;
    readonly adapterError: string | null;
    readonly engines?: Readonly<Record<string, EvaluatorEngine>> | undefined;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly actorId: string | null;
  }): Promise<EvaluationRunOutcome>;
  /** Raw record by id — module/route internal reads. */
  getEvaluation(evaluationId: string): Promise<EvaluationRecord | null>;
  /**
   * The evaluation outcome rows of one Workspace, newest first (bounded by
   * `limit`, default 500, max 1000 — long-list handling).
   */
  listEvaluations(workspaceId: string, limit?: number): Promise<readonly EvaluationRecord[]>;

  // ----- Human-review hook (records intent/outcome — never executes) ------

  /**
   * Records one HUMAN-REVIEW REQUEST (the hook): born PENDING with the
   * review intent, linked to the (validated) execution and/or evaluation
   * context. The hook records review intent ONLY — humans ACT through the
   * existing Job/Task/Execution authorities (/jobs, /field-agents); this
   * record never assigns, claims or executes work. The §8-style
   * idempotency key is REQUIRED and DB-fenced per workspace: a duplicate
   * of the same command converges (replayed=true); a key reused for a
   * different command is a ConflictError. Context links, reason and scope
   * are immutable after creation.
   */
  requestReview(input: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly executionId: string | null;
    readonly evaluationId: string | null;
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly actorId: string | null;
  }): Promise<ReviewRequestCreateOutcome>;
  /**
   * Records the single lifecycle transition pending → approved/rejected/
   * dismissed (terminal) — the review OUTCOME, appended to the
   * append-only transition history. The decision is exactly-once (the
   * transitions-table UNIQUE fence + the state-guarded update backstop
   * concurrent decisions: one wins, the rest ConflictError). The deciding
   * human is the server-derived actor. Decided requests are terminal —
   * history is never rewritten.
   */
  decideReview(input: {
    readonly reviewRequestId: string;
    readonly decision: ReviewRequestDecision;
    readonly note: string;
    readonly correlationId: string;
    readonly actorId: string | null;
  }): Promise<ReviewRequestRecord>;
  /** Raw record by id (transition history included) — module/route internal reads. */
  getReviewRequest(reviewRequestId: string): Promise<ReviewRequestRecord | null>;
  /**
   * The review requests of one Workspace (transition histories included),
   * newest first, optionally filtered by state (bounded).
   */
  listReviewRequests(
    workspaceId: string,
    state?: ReviewRequestState,
    limit?: number,
  ): Promise<readonly ReviewRequestRecord[]>;
}

export interface AiRuntimeModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Dependency matrix (/ai-runtime ──→ /executions, /policies, /credentials,
   * /evidence): MKT-017 uses exactly the /executions public API — to
   * validate telemetry execution references (existence + same-Workspace
   * scope) BEFORE the write. Nothing else is imported: profile scope is
   * carried as immutable server-derived data, DB-backstopped.
   *
   * MKT-018 (AI-002) extends the same module in place (same authority,
   * deeper scope): the routing layer adds NO new module-to-module
   * dependency — it operates on the merged REGISTRY layer (TaskProfiles,
   * model registry) and the new ROUTING tables (migration 020). The
   * adapter (OpenRouter or a fake) is supplied by the caller at route
   * time; the routing core depends on the adapter CONTRACT (ports), not
   * implementations (AI-AC-03 — provider independence §9).
   *
   * MKT-019 (AI-003) uses exactly ONE more matrix-sanctioned dependency:
   * the /evidence public API — to VALIDATE evaluation evidence citations
   * (existence + same-Client scope) before recording an evaluation. The
   * evaluation layer reads TaskProfile/execution/usage context ONLY
   * (AI-AC-08): /metrics and /experiments are NEVER imported (the frozen
   * dependency matrix forbids them and the static architecture test
   * proves it).
   */
  readonly executions: ExecutionsModuleApi;
  /** Matrix-sanctioned /evidence public API — evaluation citation validation (MKT-019). */
  readonly evidence: EvidenceModuleApi;
}

// ---------------------------------------------------------------------------
// Routing policy — the admin-managed declarative policy (MKT-018, §4)
// ---------------------------------------------------------------------------

/**
 * The routing-policy lifecycle. Registry content is immutable; the single
 * lifecycle edge is `active → retired` and `retired` is TERMINAL.
 */
export type RoutingPolicyStatus = 'active' | 'retired';

export const ROUTING_POLICY_TRANSITIONS: Readonly<
  Record<RoutingPolicyStatus, readonly RoutingPolicyStatus[]>
> = {
  active: ['retired'],
  retired: [],
};

export function isLegalRoutingPolicyTransition(
  from: RoutingPolicyStatus,
  to: RoutingPolicyStatus,
): boolean {
  return ROUTING_POLICY_TRANSITIONS[from].includes(to);
}

/**
 * Input keys that can NEVER appear in a caller-supplied routing-policy
 * payload: server-derived identity/scope/lifecycle/provenance fields PLUS
 * provider/model/credential-shaped keys. A routing policy is DATA — it
 * carries declarative weights and label allow/deny lists (interpreted by
 * the routing core), never provider SDKs, adapter configurations or
 * credentials.
 */
export const ROUTING_POLICY_FORBIDDEN_INPUT_KEYS = [
  // Server-derived authority fields.
  'routingPolicyId',
  'workspaceId',
  'clientId',
  'agencyId',
  'status',
  'version',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  // SDK/adapter/credential-shaped keys — never routing policy data.
  'sdk',
  'sdkPackage',
  'clientLibrary',
  'adapter',
  'adapterConfig',
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
] as const;

/**
 * The routing-policy input: a name + a bounded JSON `policyContent` object
 * interpreted by the routing core. The content shape is intentionally
 * permissive (a bounded JSON object) so the policy can evolve without
 * schema migrations; the routing core reads known keys and ignores
 * unknown keys (forward-compatible).
 */
export interface RoutingPolicyInput {
  readonly policyName: string;
  readonly policyContent: Readonly<Record<string, unknown>>;
}

/**
 * Immutable storage shape of one persisted routing policy.
 */
export interface RoutingPolicyRecord {
  readonly routingPolicyId: string;
  readonly policyName: string;
  readonly policyContent: Readonly<Record<string, unknown>>;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly status: RoutingPolicyStatus;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoutingPolicyCreateOutcome {
  readonly routingPolicy: RoutingPolicyRecord;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Routing decision — eligibility, ranking, tradeoff, selection (§4)
// ---------------------------------------------------------------------------

/**
 * The hard-eligibility reason vocabulary (§4 + the closed-routing-policy
 * interpretation). An INELIGIBLE model carries one of these reasons; an
 * ELIGIBLE model carries `null`. The vocabulary is CLOSED so the routing
 * regression matrix can enumerate every phase 1 case.
 */
export const ELIGIBILITY_REASONS = [
  'privacy',
  'policy',
  'capability',
  'quota',
  'subscription',
  'availability',
] as const;
export type EligibilityReason = (typeof ELIGIBILITY_REASONS)[number];

/**
 * The routing phase vocabulary (§4 — the AI-AC-04 phase-order proof). The
 * phases execute in this exact order: hard eligibility FIRST, then
 * performance ranking, then cost/latency tradeoff, then selection. The
 * phase trace recorded on a selection decision is an ordered array of
 * these labels.
 */
export const ROUTING_PHASES = ['eligibility', 'ranking', 'tradeoff', 'selection'] as const;
export type RoutingPhase = (typeof ROUTING_PHASES)[number];

/**
 * One hard-eligibility decision: a model + eligible flag + reason (when
 * ineligible). The eligible set is the array of decisions with
 * `eligible === true`.
 */
export interface EligibilityDecision {
  readonly modelRegistryId: string;
  readonly eligible: boolean;
  readonly reason: EligibilityReason | null;
}

/**
 * One performance-ranking score: a model + the normalized score (0..1) +
 * the per-component breakdown (the raw quality signal, the normalized
 * value). Ranking math uses the model's declared qualitySignals — it
 * NEVER mutates the registry's capability record (AI-AC-07: capability
 * clipping happens in ranking math only, never by mutating the registry).
 */
export interface RankingScore {
  readonly modelRegistryId: string;
  readonly score: number;
  readonly components: Readonly<Record<string, number>>;
}

/**
 * One cost/latency tradeoff score: a model + the tradeoff score (a
 * weighted sum of the quality, cost and latency components) + the
 * per-component breakdown.
 */
export interface TradeoffScore {
  readonly modelRegistryId: string;
  readonly score: number;
  readonly costComponent: number;
  readonly latencyComponent: number;
  readonly qualityComponent: number;
}

/**
 * The full routing-decision payload: the eligible set snapshot, the
 * ranking, the tradeoff, the chosen model and the phase trace. The
 * selection decision is the AI-AC-04 phase-order proof (eligibility →
 * ranking → tradeoff → selection) AND the AI-AC-06 telemetry payload
 * (eligible-set snapshot, ranking, tradeoff, chosen model, cascade step).
 */
export interface SelectionDecisionPayload {
  readonly eligibleSet: readonly EligibilityDecision[];
  readonly ranking: readonly RankingScore[];
  readonly tradeoff: readonly TradeoffScore[];
  readonly chosenModelRegistryId: string;
  readonly phaseTrace: readonly RoutingPhase[];
}

/**
 * Immutable storage shape of one persisted selection decision (the
 * authoritative routing-decision record, AI-AC-06). The payload columns
 * mirror SelectionDecisionPayload; the `authoritative` flag records
 * whether the decision was AUTHORITATIVE (the cascade invoked models and
 * observed cost/latency) or SPECULATIVE (a preview without invocation).
 */
export interface SelectionDecisionRecord {
  readonly selectionId: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly taskProfileId: string;
  readonly routingPolicyId: string | null;
  readonly eligibleSet: readonly EligibilityDecision[];
  readonly ranking: readonly RankingScore[];
  readonly tradeoff: readonly TradeoffScore[];
  readonly chosenModelRegistryId: string;
  readonly cascadeRunId: string | null;
  readonly phaseTrace: readonly RoutingPhase[];
  readonly authoritative: boolean;
  readonly observedLatencyMs: number | null;
  readonly observedCostAmount: number | null;
  readonly evaluationRef: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * Input keys that can NEVER appear in a caller-supplied selection-decision
 * payload: every server-derived authority field is rejected (the decision
 * is recorded by the module, never caller-supplied). Exposed for the
 * route DTO forbidden-key contract (AI-AC-06 — the authoritative record is
 * server-derived, never a caller fabrication).
 */
export const SELECTION_DECISION_FORBIDDEN_INPUT_KEYS = [
  'selectionId',
  'workspaceId',
  'clientId',
  'agencyId',
  'eligibleSet',
  'ranking',
  'tradeoff',
  'chosenModelRegistryId',
  'cascadeRunId',
  'phaseTrace',
  'authoritative',
  'observedLatencyMs',
  'observedCostAmount',
  'evaluationRef',
  'correlationId',
  'createFingerprint',
  'createdBy',
  'createdAt',
  // Provider/model authority — the chosen model is server-derived from
  // routing, never caller-supplied.
  'provider',
  'providerLabel',
  'model',
  'modelName',
  'modelKey',
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
] as const;

// ---------------------------------------------------------------------------
// Cascade — the recorded, replayable cheap-first structure (§5)
// ---------------------------------------------------------------------------

/**
 * The cascade-step type vocabulary (§5): cheap/deterministic first, fan-
 * out (several inexpensive candidates evaluated before escalating),
 * escalate (stronger model on validator failure), frontier (frontier model
 * escalation), human (human escalation).
 */
export const CASCADE_STEP_TYPES = [
  'cheap-first',
  'fan-out',
  'escalate',
  'frontier',
  'human',
] as const;
export type CascadeStepType = (typeof CASCADE_STEP_TYPES)[number];

/**
 * The validator result vocabulary. `pending` is the initial state;
 * `passed` means the validator accepted the output; `failed` means the
 * validator rejected the output (and the cascade escalates); `unknown`
 * follows the frozen UNKNOWN semantics (the validator could not prove
 * pass or fail — never auto-resolved to success).
 */
export const VALIDATOR_RESULTS = ['pending', 'passed', 'failed', 'unknown'] as const;
export type ValidatorResult = (typeof VALIDATOR_RESULTS)[number];

/**
 * The cascade-run status vocabulary. `running` is the initial state;
 * `completed` means a step's validator passed (success); `escalated`
 * means the cascade exhausted the escalation budget and escalated to a
 * frontier/human step; `failed` means the cascade exhausted all options
 * without a passing validator; `unknown` follows the frozen UNKNOWN
 * semantics (the cascade outcome could not be proven — never success).
 */
export const CASCADE_RUN_STATUSES = [
  'running',
  'completed',
  'escalated',
  'failed',
  'unknown',
] as const;
export type CascadeRunStatus = (typeof CASCADE_RUN_STATUSES)[number];

/**
 * One cascade step (the per-step record inside one cascade run).
 */
export interface CascadeStepRecord {
  readonly cascadeStepId: string;
  readonly cascadeRunId: string;
  readonly stepIndex: number;
  readonly modelRegistryId: string;
  readonly stepType: CascadeStepType;
  readonly validatorResult: ValidatorResult;
  readonly validatorReason: string | null;
  readonly observedLatencyMs: number | null;
  readonly observedCostAmount: number | null;
  readonly evaluationRef: string | null;
  readonly outcome: UsageTelemetryOutcome;
  readonly createdAt: string;
}

/**
 * One cascade run (the recorded, replayable cascade structure). The run
 * holds the overall state (status, final model, escalation count) and the
 * per-step history (cascadeSteps, ordered by stepIndex).
 */
export interface CascadeRunRecord {
  readonly cascadeRunId: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly taskProfileId: string;
  readonly routingPolicyId: string | null;
  readonly status: CascadeRunStatus;
  readonly finalModelRegistryId: string | null;
  readonly escalationCount: number;
  readonly maxEscalations: number;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cascadeSteps: readonly CascadeStepRecord[];
}

/**
 * The cascade validator contract: a function that decides whether the
 * adapter's output satisfies the TaskProfile's output contract. The
 * default validator (provided by the routing core) checks the output
 * against the TaskProfile's outputSchema; domain modules may supply
 * custom validators (MKT-019 will supply evaluation-framework validators).
 *
 * The validator returns:
 *   - `passed` — the output satisfies the contract (the cascade completes);
 *   - `failed` — the output does not satisfy the contract (the cascade
 *     escalates to the next model);
 *   - `unknown` — the validator could not prove pass or fail (the cascade
 *     records the step as `unknown` and escalates — UNKNOWN is never
 *     auto-resolved to success, per the frozen UNKNOWN semantics).
 */
export interface CascadeValidator {
  (input: {
    readonly taskProfile: TaskProfileRecord;
    readonly output: Readonly<Record<string, unknown>> | null;
    readonly adapterError: string | null;
  }): Promise<{ readonly result: ValidatorResult; readonly reason: string | null }>;
}

// ---------------------------------------------------------------------------
// Provider adapter contract — the provider-neutral port (§6, §9)
// ---------------------------------------------------------------------------

/**
 * The provider-neutral adapter request: the model ref (registry entry id +
 * provider/model labels as DATA — never an SDK call), the TaskProfile
 * (the provider-neutral request contract), the invocation input, the
 * tool requirements and the budget. The adapter translates this into a
 * provider-specific call (HTTP for OpenRouter) and returns the response.
 */
export interface AdapterRequest {
  readonly modelRegistryId: string;
  readonly providerLabel: string;
  readonly modelKey: string;
  readonly taskProfile: TaskProfileRecord;
  readonly input: Readonly<Record<string, unknown>>;
  readonly budget: {
    readonly maxCostPerInvocation: number;
    readonly latencyTargetMs: number;
  };
}

/**
 * The provider-neutral adapter response: ok flag, output (when ok),
 * error (when not ok), and the observed cost/latency/tokens telemetry. The
 * adapter NEVER throws for invocation-level outcomes — transport failures,
 * provider errors and timeouts are RETURNED as data (ok=false with an
 * error string), so the cascade can decide whether to escalate.
 */
export interface AdapterResponse {
  readonly ok: boolean;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
  readonly latencyMs: number;
  readonly costAmount: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

/**
 * The provider-neutral adapter PORT (§9 — provider independence). Every
 * provider (OpenRouter, a direct provider, an in-house adapter) implements
 * this interface. The routing core depends on the PORT, not on any
 * implementation — the composition root wires the implementation, and
 * tests supply fakes. Domain modules never import adapters (AI-AC-03 —
 * the routing authority is the /ai-runtime module itself).
 */
export interface ProviderAdapter {
  /** The provider LABEL this adapter handles (matches the registry's providerLabel). */
  readonly providerLabel: string;
  /** Invokes one model through the provider. NEVER throws for invocation outcomes. */
  invoke(request: AdapterRequest): Promise<AdapterResponse>;
}

// ---------------------------------------------------------------------------
// Routing outcome — the result of routeTask (the cascade result + telemetry)
// ---------------------------------------------------------------------------

/**
 * The outcome of routeTask: the cascade run (with steps), the selection
 * decision record, and the final output (when the cascade completed).
 * UNKNOWN outcomes stay unresolved (the cascade status is `unknown` —
 * never auto-resolved to success).
 */
export interface RoutingOutcome {
  readonly selection: SelectionDecisionRecord;
  readonly cascadeRun: CascadeRunRecord;
  readonly finalOutput: Readonly<Record<string, unknown>> | null;
}

// ---------------------------------------------------------------------------
// Evaluation framework (MKT-019, AI-003) — task-level evaluators, the
// human-review hook and execution-linked quality telemetry
// ---------------------------------------------------------------------------

/**
 * The closed evaluator-kind vocabulary (spec/ai-runtime-and-routing.md §7:
 * "AI quality is measured through task-specific evaluations"). Every
 * registered evaluator declares exactly one kind:
 *
 *   - `schema-validity`               — deterministic (built-in): the output
 *     satisfies the TaskProfile's outputSchema (§11 "An output that fails
 *     schema validation is never accepted");
 *   - `factuality-grounding`          — model-judge/advisory (caller-
 *     supplied engine; §12 "Model-judge evaluations are advisory
 *     evidence");
 *   - `evidence-citation-coverage`    — deterministic (built-in): the
 *     output cites the config-declared expected evidence references;
 *   - `brand-policy-compliance`       — deterministic (built-in): the output
 *     text avoids the config-declared denied terms;
 *   - `domain-rubric`                 — deterministic (built-in): the
 *     output's numeric fields meet the config-declared rubric bounds;
 *   - `human-review`                  — the human-review hook: an evaluator
 *     contract of this kind records an `unknown` outcome and the caller
 *     composes requestReview (humans act through /jobs — the hook never
 *     executes);
 *   - `downstream-task-success`       — recorded via a caller-supplied
 *     engine from downstream task outcomes (TASK-level success — never
 *     business lift, §8).
 */
export const EVALUATOR_KINDS = [
  'schema-validity',
  'factuality-grounding',
  'evidence-citation-coverage',
  'brand-policy-compliance',
  'domain-rubric',
  'human-review',
  'downstream-task-success',
] as const;
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

/**
 * The evaluator-registry lifecycle. Registry content is immutable after
 * registration (corrections retire + re-register); the single lifecycle
 * edge is `active → retired` and `retired` is TERMINAL.
 */
export type EvaluatorStatus = 'active' | 'retired';

export const EVALUATOR_TRANSITIONS: Readonly<
  Record<EvaluatorStatus, readonly EvaluatorStatus[]>
> = {
  active: ['retired'],
  retired: [],
};

export function isLegalEvaluatorTransition(
  from: EvaluatorStatus,
  to: EvaluatorStatus,
): boolean {
  return EVALUATOR_TRANSITIONS[from].includes(to);
}

/**
 * Input keys that can NEVER appear in a caller-supplied evaluator
 * registration payload: server-derived identity/lifecycle/provenance
 * fields PLUS SDK/adapter/provider/credential-shaped keys (the registry is
 * provider-neutral DATA) PLUS business-outcome-shaped keys (AI-AC-08 — an
 * evaluator definition never references KPIs or experiment outcomes).
 */
export const EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS = [
  // Server-derived authority fields.
  'evaluatorRegistryId',
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  // SDK/adapter/provider/credential-shaped keys — never evaluator data.
  'sdk',
  'sdkPackage',
  'clientLibrary',
  'adapter',
  'adapterConfig',
  'provider',
  'providerName',
  'providerLabel',
  'model',
  'modelName',
  'modelKey',
  'modelId',
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
  // Business-outcome-shaped keys — AI-AC-08 (never evaluator inputs).
  'metricId',
  'kpiId',
  'experimentId',
  'experimentOutcomeId',
  'businessOutcomeId',
  'lift',
] as const;

/**
 * The evaluator-registration input: the normalized task-level evaluator
 * definition as DECLARED data. `evaluatorKey` is the label TaskProfiles
 * reference in their evaluatorIds contract; `kind` selects the closed §7
 * vocabulary; `evaluatorVersion` versions the definition (denormalized
 * onto every evaluation record); `config` is the bounded declarative
 * configuration interpreted by the evaluation core (e.g. expected
 * evidence references, rubric bounds, denied terms, thresholds).
 */
export interface EvaluatorRegistrationInput {
  readonly evaluatorKey: string;
  readonly displayName: string;
  readonly kind: EvaluatorKind;
  readonly evaluatorVersion: number;
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Immutable storage shape of one persisted evaluator registry entry — the
 * declared definition is immutable after registration; `status` moves
 * along the single lifecycle edge; `version` is the CAS token.
 */
export interface EvaluatorRecord {
  readonly evaluatorRegistryId: string;
  /** The evaluator KEY label TaskProfiles reference in evaluatorIds. */
  readonly evaluatorKey: string;
  readonly displayName: string;
  readonly kind: EvaluatorKind;
  readonly evaluatorVersion: number;
  /** The declarative config (bounded JSON object). */
  readonly config: Readonly<Record<string, unknown>>;
  readonly status: EvaluatorStatus;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The evaluation verdict vocabulary (implementation-contract §12
 * "pass/fail/score"). `unknown` follows the frozen UNKNOWN semantics: the
 * evaluator could not prove pass or fail — never auto-resolved to pass.
 */
export const EVALUATION_VERDICTS = ['pass', 'fail', 'unknown'] as const;
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

/**
 * Input keys that can NEVER appear in a caller-supplied evaluation request
 * payload: server-derived identity/scope/provenance fields, the
 * EVALUATOR-SELECTION keys (which evaluators run is derived from the
 * TaskProfile's evaluator contract — never caller-chosen), the
 * OUTCOME keys (verdict/score/dimensions/evidence/uncertainty are
 * evaluator-computed and module-recorded — caller-supplied outcomes would
 * be fabrication), provider/model/credential-shaped keys, and
 * BUSINESS-OUTCOME-shaped keys (AI-AC-08 — evaluation inputs never
 * reference /metrics KPIs or /experiments outcomes).
 */
export const EVALUATION_FORBIDDEN_INPUT_KEYS = [
  // Server-derived authority fields.
  'evaluationId',
  'workspaceId',
  'clientId',
  'agencyId',
  'correlationId',
  'causationId',
  'createFingerprint',
  'createdBy',
  'createdAt',
  // Evaluator selection — derived from the TaskProfile contract only.
  'evaluatorIds',
  'evaluatorId',
  'evaluatorKey',
  'evaluatorVersion',
  'evaluatorRegistryId',
  // Outcome fields — evaluator-computed, module-recorded (never caller
  // fabrications).
  'verdict',
  'score',
  'dimensions',
  'evidenceRefs',
  'uncertainty',
  'uncertaintyOrLimitations',
  // Business-outcome-shaped keys — AI-AC-08 (never evaluation inputs).
  'metricId',
  'kpiId',
  'metricObservationId',
  'experimentId',
  'experimentOutcomeId',
  'businessOutcomeId',
  'businessOutcome',
  'lift',
  'conversionRate',
  // Provider/model authority — never evaluation inputs.
  'provider',
  'providerName',
  'providerLabel',
  'model',
  'modelName',
  'modelKey',
  'modelRegistryId',
  // Credential-shaped keys — never in evaluation records.
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
] as const;

/**
 * One rubric dimension outcome (the §12 `dimensions` entry): the dimension
 * label, the per-dimension verdict, the optional per-dimension 0..1 score
 * and bounded notes.
 */
export interface EvaluationDimension {
  readonly dimension: string;
  readonly verdict: EvaluationVerdict;
  readonly score: number | null;
  readonly notes: string;
}

/**
 * The §12 EvaluationResult payload an evaluator engine produces (minus the
 * evaluatorId/evaluatorVersion — those are registry-derived and recorded
 * by the module). `score` is the normalized 0..1 score (null when the
 * evaluator reports a pure verdict); `evidenceRefs` are the citations
 * backing the evaluation (validated module-side against the /evidence
 * authority); `uncertaintyOrLimitations` is the honest disclosure of what
 * the evaluator could not prove.
 */
export interface EvaluationResultPayload {
  readonly verdict: EvaluationVerdict;
  readonly score: number | null;
  readonly dimensions: readonly EvaluationDimension[];
  readonly evidenceRefs: readonly string[];
  readonly uncertaintyOrLimitations: string;
}

/**
 * Immutable storage shape of one persisted evaluation outcome record — one
 * evaluator's §12 result for one evaluation request. APPEND-ONLY: written
 * once, never updated or deleted (DB-enforced); corrections append a NEW
 * record. Linked to the TaskProfile, the (validated) Execution, the
 * (validated) usage-telemetry row and the evaluator registry entry.
 */
export interface EvaluationRecord {
  readonly evaluationId: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly taskProfileId: string;
  /** Execution context link (server-validated same-Workspace; nullable). */
  readonly executionId: string | null;
  /** The usage-telemetry row this evaluation judges (nullable). */
  readonly usageId: string | null;
  readonly evaluatorRegistryId: string;
  /** The §12 evaluatorId (the key label), denormalized at record time. */
  readonly evaluatorKey: string;
  /** The §12 evaluatorVersion, denormalized at record time. */
  readonly evaluatorVersion: number;
  readonly verdict: EvaluationVerdict;
  /** Normalized 0..1 score (null when unmeasured — never fabricated). */
  readonly score: number | null;
  readonly dimensions: readonly EvaluationDimension[];
  /** Validated citations into the /evidence authority. */
  readonly evidenceRefs: readonly string[];
  readonly uncertaintyOrLimitations: string;
  /** Server-derived from the ambient correlation context. */
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/**
 * The outcome of one evaluation run: the per-evaluator outcome records and
 * whether this request was a REPLAY of an already-recorded logical
 * evaluation command (the §8-style per-evaluator fences converged the
 * duplicates — no second rows, no rewrites).
 */
export interface EvaluationRunOutcome {
  readonly evaluations: readonly EvaluationRecord[];
  readonly replayed: boolean;
}

/**
 * The evaluator ENGINE port — the caller-supplied evaluator implementation
 * for kinds WITHOUT a built-in deterministic evaluator (factuality
 * grounding model judges, downstream-task-success recorders, custom
 * overrides). The engine receives the evaluator registry entry (the
 * declared config), the TaskProfile and the output under evaluation; it
 * returns the §12 result payload (guarded module-side: verdict vocabulary,
 * score bounds, dimension shape, evidence-ref bounds). Model-judge engines
 * are ADVISORY EVIDENCE (implementation-contract §12) — the module records
 * their outcome, it never treats it as unquestionable truth.
 */
export interface EvaluatorEngine {
  (input: {
    readonly evaluator: EvaluatorRecord;
    readonly taskProfile: TaskProfileRecord;
    readonly output: Readonly<Record<string, unknown>> | null;
    readonly adapterError: string | null;
  }): Promise<EvaluationResultPayload>;
}

/**
 * Input keys that can NEVER appear in a caller-supplied review-request
 * payload: server-derived identity/scope/lifecycle/decision/provenance
 * fields (the decision fields are set ONLY by decideReview — never
 * caller-supplied on create), business-outcome-shaped keys (AI-AC-08) and
 * credential-shaped keys.
 */
export const REVIEW_REQUEST_FORBIDDEN_INPUT_KEYS = [
  // Server-derived authority fields.
  'reviewRequestId',
  'workspaceId',
  'clientId',
  'agencyId',
  'state',
  'status',
  'decidedBy',
  'decidedAt',
  'decisionNote',
  'correlationId',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
  // Business-outcome-shaped keys — AI-AC-08 (never review-request inputs).
  'metricId',
  'kpiId',
  'experimentId',
  'experimentOutcomeId',
  'businessOutcomeId',
  'lift',
  // Provider/model authority — never review-request inputs.
  'provider',
  'providerLabel',
  'model',
  'modelName',
  'modelKey',
  // Credential-shaped keys — never in review records.
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
] as const;

/**
 * The review-request lifecycle (the human-review hook): a request is born
 * PENDING and moves — exactly once, terminally — to `approved`,
 * `rejected` or `dismissed` through decideReview, which appends the
 * transition to the append-only transition history. Humans act through the
 * existing Job/Task/Execution authorities; the hook records intent and
 * outcome only.
 */
export const REVIEW_REQUEST_STATES = [
  'pending',
  'approved',
  'rejected',
  'dismissed',
] as const;
export type ReviewRequestState = (typeof REVIEW_REQUEST_STATES)[number];

export const REVIEW_REQUEST_TRANSITIONS: Readonly<
  Record<ReviewRequestState, readonly ReviewRequestState[]>
> = {
  pending: ['approved', 'rejected', 'dismissed'],
  approved: [],
  rejected: [],
  dismissed: [],
};

export function isLegalReviewRequestTransition(
  from: ReviewRequestState,
  to: ReviewRequestState,
): boolean {
  return REVIEW_REQUEST_TRANSITIONS[from].includes(to);
}

/** The decideReview decision vocabulary (one decision, one terminal state). */
export const REVIEW_REQUEST_DECISIONS = ['approve', 'reject', 'dismiss'] as const;
export type ReviewRequestDecision = (typeof REVIEW_REQUEST_DECISIONS)[number];

/**
 * Immutable storage shape of one persisted review-request record. The
 * context links (execution, evaluation), reason and scope chain are
 * immutable after creation; the lifecycle fields (state, decidedBy,
 * decidedAt, decisionNote) move ONCE (pending → terminal) via decideReview.
 */
export interface ReviewRequestRecord {
  readonly reviewRequestId: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly executionId: string | null;
  readonly evaluationId: string | null;
  /** The review intent — why human review is requested. */
  readonly reason: string;
  readonly state: ReviewRequestState;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The append-only transition history (loaded on by-id reads). */
  readonly transitions: readonly ReviewRequestTransitionRecord[];
}

/**
 * One APPEND-ONLY review-request transition row: the from/to states, the
 * deciding human, the decision note and the transition time. Written once;
 * UPDATE and DELETE are DB-rejected.
 */
export interface ReviewRequestTransitionRecord {
  readonly transitionId: string;
  readonly reviewRequestId: string;
  readonly fromState: ReviewRequestState;
  readonly toState: ReviewRequestState;
  readonly decidedBy: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

/**
 * The outcome of a review-request create: the record and whether this
 * request was a REPLAY of the already-recorded logical create command
 * (the §8-style fence converged the duplicate).
 */
export interface ReviewRequestCreateOutcome {
  readonly reviewRequest: ReviewRequestRecord;
  readonly replayed: boolean;
}

export { createAiRuntimeModule } from './internal/ai-runtime-module.ts';
/**
 * The input guards (validation + provider-neutrality + authority-field
 * rejection) — exported for unit tests and future server-side callers so
 * the guard semantics are part of the module contract. Pure functions.
 *
 * MKT-018 (AI-002) adds `assertValidRoutingPolicyInput` (the routing-policy
 * input guard, same posture as the registry guards).
 */
export {
  assertValidIdempotencyKey,
  assertValidTaskProfileInput,
  assertValidModelRegistrationInput,
  assertValidModelObservationInput,
  assertValidUsageTelemetryInput,
  assertValidRoutingPolicyInput,
} from './internal/ai-runtime-store.ts';
/**
 * The MKT-019 (AI-003) evaluation-layer input guards: evaluator
 * registration (provider-neutral DATA + business-outcome-key rejection),
 * the evaluation request (reference/bound validation — the evaluator
 * selection and outcomes are never inputs) and the review-request
 * create/decision guards. Same posture as the registry guards; exported
 * so the guard semantics are part of the module contract.
 */
export {
  assertValidEvaluatorRegistrationInput,
  assertValidEvaluationInput,
  assertValidReviewRequestInput,
  assertValidReviewDecisionInput,
} from './internal/ai-evaluation-store.ts';
/**
 * The routing policy pure functions (MKT-018, AI-AC-04 phase-order proof +
 * AI-AC-07 capability non-clipping proof). The routing core depends on
 * these pure functions; the cascade executor (runCascade) orchestrates
 * them in the §4/§5 phase order. Exported for unit tests and the routing
 * regression matrix.
 */
export {
  interpretPolicy,
  computeEligibility,
  computeRanking,
  computeTradeoff,
  selectModel,
  ROUTING_PHASE_ORDER,
  ELIGIBILITY_REASON_PRIORITY,
  type InterpretedPolicy,
} from './internal/routing/policy.ts';
/**
 * The cascade executor (MKT-018, AI-AC-05 cheap-first cascade escalation
 * proof). The executor is a pure async function — it takes the adapter
 * (the provider-neutral port) and the validator and returns the cascade
 * outcome; the caller (the module's routeTask method) persists the
 * outcome. Exported for unit tests and integration tests (which supply
 * fake adapters).
 */
export {
  runCascade,
  defaultValidator,
  type CascadeStepOutcome,
  type CascadeExecutorInput,
  type CascadeExecutorResult,
} from './internal/routing/cascade.ts';
/**
 * The evaluation core (MKT-019, AI-003): the built-in deterministic
 * evaluators (schema-validity, evidence-citation-coverage, brand-policy
 * compliance, domain-rubric — the §7 kinds that need no model), the
 * §12 result-payload guard and the evaluator-engine resolution. Exported
 * for unit tests, the evaluator regression matrix and future server-side
 * callers; the module's evaluateTask method orchestrates them.
 */
export {
  BUILTIN_EVALUATOR_KINDS,
  schemaValidityEvaluator,
  citationCoverageEvaluator,
  brandPolicyEvaluator,
  domainRubricEvaluator,
  humanReviewEvaluator,
  resolveEvaluatorEngine,
  assertValidEvaluationResultPayload,
  runEvaluators,
  type BuiltInEvaluator,
} from './internal/evaluation/evaluate.ts';
