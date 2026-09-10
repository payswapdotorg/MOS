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
 *     identity and the observed outcome signals.
 *
 * What this module deliberately does NOT do (MKT-017 scope bounds):
 *   - NO routing/eligibility/cascade/escalation logic (AI-002, MKT-018) —
 *     no candidate resolution, no hard filters, no ranking, no strategies;
 *   - NO evaluation framework (AI-003, MKT-019) — evaluator ids and the
 *     telemetry evaluation link are reference placeholders;
 *   - NO provider adapters and NO model invocation: no provider SDK may be
 *     imported by this module's domain code — SDKs may only ever appear
 *     inside /ai-runtime ADAPTER implementations (AI-AC-02), and none exist
 *     yet. The registry is data + contracts, not a provider client;
 *   - NO credentials: the TaskProfile and telemetry records carry no
 *     credential references (routing-time credential resolution is MKT-018
 *     composing /credentials).
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
   */
  readonly executions: ExecutionsModuleApi;
}

export { createAiRuntimeModule } from './internal/ai-runtime-module.ts';
/**
 * The input guards (validation + provider-neutrality + authority-field
 * rejection) — exported for unit tests and future server-side callers so
 * the guard semantics are part of the module contract. Pure functions.
 */
export {
  assertValidIdempotencyKey,
  assertValidTaskProfileInput,
  assertValidModelRegistrationInput,
  assertValidModelObservationInput,
  assertValidUsageTelemetryInput,
} from './internal/ai-runtime-store.ts';
