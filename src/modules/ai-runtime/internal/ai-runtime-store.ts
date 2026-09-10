/**
 * /ai-runtime persistence + input guards (MKT-017, AI-001).
 *
 * Tables (migration 016): ai_task_profiles, ai_model_registry,
 * ai_model_observations, ai_usage_telemetry.
 *
 * DB backstops behind this store (implementation-contract §3, §25):
 *   - TaskProfile CONTENT is immutable (trigger): identity, the full §10
 *     neutral contract, the idempotency identity, the server-derived
 *     Workspace/Client/Agency scope and the provenance can never be
 *     reassigned — corrections register a NEW profile; `retired` is terminal;
 *   - model-registry DECLARED signals are immutable (trigger): corrections
 *     retire + re-register; the (provider_label, model_key) pair is unique
 *     among ACTIVE entries (partial unique index — the registration fence);
 *     the only mutable column is the observation-derived availability_state;
 *   - model observations are APPEND-ONLY history (trigger rejects UPDATE and
 *     DELETE) and the apply-state trigger is the ONLY path that mutates
 *     ai_model_registry.availability_state;
 *   - usage telemetry is APPEND-ONLY history (trigger rejects UPDATE and
 *     DELETE); the (workspace_id, idempotency_key) §8-style fence makes the
 *     logical append command converge (same fingerprint → replay; different
 *     fingerprint → conflict);
 *   - the scope-chain triggers reject any row whose Workspace/Client/Agency
 *     chain is inconsistent, whose TaskProfile belongs to another Workspace,
 *     or whose execution reference belongs to another Workspace — tenant
 *     isolation holds even under direct SQL rewrites;
 *   - every mutable row carries a version CAS token (row-locked
 *     transitions).
 *
 * The input guards (exported through the module public entry) are the
 * module-side DTO authority: they validate the §10/§3 contract shapes AND
 * REJECT provider/model/credential-shaped keys — the provider-neutrality
 * enforcement for AI-AC-01 (a TaskProfile can never carry a provider or
 * model selection) and the registry-side label-only enforcement for
 * AI-AC-02 (a model record is DATA, never an SDK import or a credential).
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  ModelAvailabilityState,
  ModelObservationRecord,
  ModelRegistrationInput,
  ModelRegistryRecord,
  TaskProfileInput,
  TaskProfileRecord,
  TaskProfileRiskClass,
  TaskProfilePrivacyClass,
  UsageTelemetryInput,
  UsageTelemetryOutcome,
  UsageTelemetryRecord,
} from '../public.ts';
import {
  MODEL_AVAILABILITY_STATES,
  MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  TASK_PROFILE_FORBIDDEN_INPUT_KEYS,
  TASK_PROFILE_PRIVACY_CLASSES,
  TASK_PROFILE_RISK_CLASSES,
  USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS,
  USAGE_TELEMETRY_OUTCOMES,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface TaskProfileRow extends DbRow {
  task_profile_id: string;
  task_class: string;
  quality_target: string;
  risk_class: string;
  context_requirements: Record<string, unknown>;
  latency_target_ms: number | string;
  max_cost_per_invocation: string;
  privacy_class: string;
  tool_requirements: unknown[];
  output_schema: Record<string, unknown>;
  evaluator_ids: unknown[];
  escalation_policy: Record<string, unknown>;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  status: string;
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface ModelRegistryRow extends DbRow {
  model_registry_id: string;
  provider_label: string;
  model_key: string;
  display_name: string;
  capabilities: unknown[];
  tool_features: unknown[];
  context_limit_tokens: number | string;
  cost_input_per_mtok: string | null;
  cost_output_per_mtok: string | null;
  latency_p50_ms: number | string | null;
  latency_p95_ms: number | string | null;
  reliability: string | null;
  quality_signals: Record<string, unknown>;
  privacy_characteristics: Record<string, unknown>;
  availability_state: string;
  status: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface ModelObservationRow extends DbRow {
  observation_id: string;
  model_registry_id: string;
  availability_state: string;
  observed_latency_p50_ms: number | string | null;
  observed_latency_p95_ms: number | string | null;
  source: string;
  notes: string;
  created_by: string | null;
  created_at: Date;
}

interface UsageTelemetryRow extends DbRow {
  usage_id: string;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  task_profile_id: string;
  model_registry_id: string;
  execution_id: string | null;
  correlation_id: string;
  outcome: string;
  latency_ms: number | string;
  cost_amount: string;
  tokens_in: number | string | null;
  tokens_out: number | string | null;
  evaluation_ref: string | null;
  escalation_count: number;
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  created_at: Date;
}

const TASK_PROFILE_SELECT = `
  SELECT task_profile_id, task_class, quality_target, risk_class, context_requirements,
         latency_target_ms, max_cost_per_invocation, privacy_class, tool_requirements,
         output_schema, evaluator_ids, escalation_policy, workspace_id, client_id, agency_id,
         status, idempotency_key, create_fingerprint, created_by, version, created_at, updated_at
  FROM ai_task_profiles
`;

const MODEL_REGISTRY_SELECT = `
  SELECT model_registry_id, provider_label, model_key, display_name, capabilities,
         tool_features, context_limit_tokens, cost_input_per_mtok, cost_output_per_mtok,
         latency_p50_ms, latency_p95_ms, reliability, quality_signals, privacy_characteristics,
         availability_state, status, created_by, version, created_at, updated_at
  FROM ai_model_registry
`;

const MODEL_OBSERVATION_SELECT = `
  SELECT observation_id, model_registry_id, availability_state, observed_latency_p50_ms,
         observed_latency_p95_ms, source, notes, created_by, created_at
  FROM ai_model_observations
`;

const USAGE_TELEMETRY_SELECT = `
  SELECT usage_id, workspace_id, client_id, agency_id, task_profile_id, model_registry_id,
         execution_id, correlation_id, outcome, latency_ms, cost_amount, tokens_in, tokens_out,
         evaluation_ref, escalation_count, idempotency_key, create_fingerprint, created_by, created_at
  FROM ai_usage_telemetry
`;

// ---------------------------------------------------------------------------
// Input guards (pure; exported through the module public entry)
// ---------------------------------------------------------------------------

/** Normalized task-class label (application/task-definition vocabulary). */
const TASK_CLASS_PATTERN = /^[a-z][a-z0-9_.-]{1,99}$/;
/** Normalized quality-target label. */
const QUALITY_TARGET_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,99}$/;
/** Normalized capability/tool/evaluator labels. */
const CAPABILITY_LABEL_PATTERN = /^[a-z][a-z0-9-]{1,99}$/;
/** Normalized provider label (data, never an SDK import). */
const PROVIDER_LABEL_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
/** Normalized model key label (data). */
const MODEL_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
/** Observation source label. */
const OBSERVATION_SOURCE_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
/** Server-generated opaque identifier (UUID). */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IDEMPOTENCY_KEY_MAX = 200;
const JSON_CONTRACT_MAX_BYTES = 32_768;
const LABEL_ARRAY_MAX_ITEMS = 64;
const LATENCY_MS_MAX = 86_400_000;
const COST_MAX = 1_000_000_000;
const CONTEXT_TOKENS_MAX = 10_000_000;

function problem(message: string, details: ReadonlyArray<string>): never {
  throw new InvalidRequestError(message, details);
}

function requireString(value: unknown, field: string, minLength: number, maxLength: number): string {
  if (typeof value !== 'string') problem(`${field} must be a string`, [`${field}: must be a string`]);
  if (value.length < minLength || value.length > maxLength) {
    problem(`${field} length is out of bounds`, [`${field}: must be ${minLength}..${maxLength} characters`]);
  }
  return value;
}

function requireLabelArray(
  value: unknown,
  field: string,
  pattern: RegExp,
  maxItems: number,
): readonly string[] {
  if (!Array.isArray(value)) {
    problem(`${field} must be an array of labels`, [`${field}: must be an array`]);
  }
  if (value.length > maxItems) {
    problem(`${field} has too many items`, [`${field}: must contain at most ${maxItems} item(s)`]);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item)) {
      problem(`${field} contains an invalid label`, [
        `${field}: every item must match ${pattern.toString()}`,
      ]);
    }
    out.push(item);
  }
  return out;
}

function requireJsonObject(
  value: unknown,
  field: string,
  maxBytes: number,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problem(`${field} must be an object`, [`${field}: must be a JSON object`]);
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > maxBytes) {
    problem(`${field} is too large`, [`${field}: serialized size must be at most ${maxBytes} bytes`]);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireSafeInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    problem(`${field} must be an integer`, [`${field}: must be an integer`]);
  }
  if (value < min || value > max) {
    problem(`${field} is out of bounds`, [`${field}: must be >= ${min} and <= ${max}`]);
  }
  return value;
}

function requireCost(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problem(`${field} must be a finite number`, [`${field}: must be a finite number`]);
  }
  if (value < 0 || value > COST_MAX) {
    problem(`${field} is out of bounds`, [`${field}: must be >= 0 and <= ${COST_MAX}`]);
  }
  return value;
}

function requireOptionalCost(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return requireCost(value, field);
}

function requireOptionalInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | null {
  if (value === null || value === undefined) return null;
  return requireSafeInt(value, field, min, max);
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    problem(`${field} must be a server-generated identifier`, [`${field}: must be a UUID`]);
  }
  return value;
}

/** Rejects every forbidden authority/neutrality key present on the input object. */
function rejectForbiddenKeys(
  input: object,
  forbidden: ReadonlyArray<string>,
  context: string,
): void {
  for (const key of forbidden) {
    if (key in input) {
      problem(`${context} carries the forbidden key '${key}'`, [
        `${key}: forbidden field; this value is derived server-side and must not be supplied`,
      ]);
    }
  }
}

/** Validates the §8-style logical command key (1..200 chars). */
export function assertValidIdempotencyKey(key: string): void {
  requireString(key, 'idempotencyKey', 1, IDEMPOTENCY_KEY_MAX);
}

/**
 * The TaskProfile input guard (AI-AC-01 module-side authority): validates
 * the eleven §10 contract fields and REJECTS provider/model/credential-
 * shaped keys — a TaskProfile is the provider-neutral request contract;
 * routing (MKT-018) resolves providers/models from the registry, and no
 * task declaration ever carries them.
 */
export function assertValidTaskProfileInput(profile: TaskProfileInput): void {
  rejectForbiddenKeys(profile, TASK_PROFILE_FORBIDDEN_INPUT_KEYS, 'task profile');

  requireString(profile.taskClass, 'taskClass', 2, 100);
  if (!TASK_CLASS_PATTERN.test(profile.taskClass)) {
    problem('taskClass is not a valid normalized label', [
      'taskClass: must be 2..100 chars, lowercase letters/digits/dots/dashes/underscores, starting with a letter',
    ]);
  }
  requireString(profile.qualityTarget, 'qualityTarget', 1, 100);
  if (!QUALITY_TARGET_PATTERN.test(profile.qualityTarget)) {
    problem('qualityTarget is not a valid label', [
      'qualityTarget: must be 1..100 chars of letters, digits, spaces, dots, dashes or underscores',
    ]);
  }
  if (!TASK_PROFILE_RISK_CLASSES.includes(profile.riskClass)) {
    problem('riskClass is not a normalized risk class', [
      `riskClass: must be one of ${TASK_PROFILE_RISK_CLASSES.join(' | ')}`,
    ]);
  }
  requireJsonObject(profile.contextRequirements, 'contextRequirements', JSON_CONTRACT_MAX_BYTES);
  requireSafeInt(profile.latencyTargetMs, 'latencyTargetMs', 1, LATENCY_MS_MAX);
  requireCost(profile.maxCostPerInvocation, 'maxCostPerInvocation');
  if (!TASK_PROFILE_PRIVACY_CLASSES.includes(profile.privacyClass)) {
    problem('privacyClass is not a normalized privacy class', [
      `privacyClass: must be one of ${TASK_PROFILE_PRIVACY_CLASSES.join(' | ')}`,
    ]);
  }
  requireLabelArray(profile.toolRequirements, 'toolRequirements', CAPABILITY_LABEL_PATTERN, LABEL_ARRAY_MAX_ITEMS);
  requireJsonObject(profile.outputSchema, 'outputSchema', JSON_CONTRACT_MAX_BYTES);
  requireLabelArray(profile.evaluatorIds, 'evaluatorIds', CAPABILITY_LABEL_PATTERN, 16);
  requireJsonObject(profile.escalationPolicy, 'escalationPolicy', JSON_CONTRACT_MAX_BYTES);
}

/**
 * The model-registration input guard (AI-AC-02 module-side authority):
 * validates the normalized registry record and REJECTS SDK/credential-shaped
 * keys — the provider/model identities are LABELS (data), never package
 * imports, adapter configurations or credentials.
 */
export function assertValidModelRegistrationInput(model: ModelRegistrationInput): void {
  rejectForbiddenKeys(model, MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS, 'model registration');

  requireString(model.providerLabel, 'providerLabel', 2, 64);
  if (!PROVIDER_LABEL_PATTERN.test(model.providerLabel)) {
    problem('providerLabel is not a valid normalized label', [
      'providerLabel: must be 2..64 chars, lowercase letters/digits/dashes, starting with a letter',
    ]);
  }
  requireString(model.modelKey, 'modelKey', 1, 128);
  if (!MODEL_KEY_PATTERN.test(model.modelKey)) {
    problem('modelKey is not a valid normalized label', [
      'modelKey: must be 1..128 chars, lowercase letters/digits/dots/dashes/underscores/colons',
    ]);
  }
  requireString(model.displayName, 'displayName', 1, 200);
  requireLabelArray(model.capabilities, 'capabilities', CAPABILITY_LABEL_PATTERN, LABEL_ARRAY_MAX_ITEMS);
  requireLabelArray(model.toolFeatures, 'toolFeatures', CAPABILITY_LABEL_PATTERN, LABEL_ARRAY_MAX_ITEMS);
  requireSafeInt(model.contextLimitTokens, 'contextLimitTokens', 1, CONTEXT_TOKENS_MAX);
  requireOptionalCost(model.costInputPerMtok, 'costInputPerMtok');
  requireOptionalCost(model.costOutputPerMtok, 'costOutputPerMtok');
  requireOptionalInt(model.latencyP50Ms, 'latencyP50Ms', 0, LATENCY_MS_MAX);
  requireOptionalInt(model.latencyP95Ms, 'latencyP95Ms', 0, LATENCY_MS_MAX);
  if (model.reliability !== null && model.reliability !== undefined) {
    if (typeof model.reliability !== 'number' || !Number.isFinite(model.reliability)) {
      problem('reliability must be a finite number or null', ['reliability: must be a number in 0..1 or null']);
    }
    if (model.reliability < 0 || model.reliability > 1) {
      problem('reliability is out of bounds', ['reliability: must be within 0..1']);
    }
  }
  requireJsonObject(model.qualitySignals, 'qualitySignals', JSON_CONTRACT_MAX_BYTES);
  requireJsonObject(model.privacyCharacteristics, 'privacyCharacteristics', JSON_CONTRACT_MAX_BYTES);
}

/**
 * The model-observation input guard: validates the observed state, the
 * optional observed latency signals, the source label and the notes bound.
 */
export function assertValidModelObservationInput(observation: {
  readonly availabilityState: ModelAvailabilityState;
  readonly observedLatencyP50Ms: number | null;
  readonly observedLatencyP95Ms: number | null;
  readonly source: string;
  readonly notes: string;
}): void {
  if (!MODEL_AVAILABILITY_STATES.includes(observation.availabilityState)) {
    problem('availabilityState is not a normalized availability state', [
      `availabilityState: must be one of ${MODEL_AVAILABILITY_STATES.join(' | ')}`,
    ]);
  }
  requireOptionalInt(observation.observedLatencyP50Ms, 'observedLatencyP50Ms', 0, LATENCY_MS_MAX);
  requireOptionalInt(observation.observedLatencyP95Ms, 'observedLatencyP95Ms', 0, LATENCY_MS_MAX);
  requireString(observation.source, 'source', 1, 64);
  if (!OBSERVATION_SOURCE_PATTERN.test(observation.source)) {
    problem('source is not a valid normalized label', [
      'source: must be 1..64 chars, lowercase letters/digits/dots/dashes',
    ]);
  }
  requireString(observation.notes, 'notes', 0, 512);
}

/**
 * The usage-telemetry input guard: validates the reference ids (UUIDs), the
 * outcome vocabulary, the observed signals and the §8-style command key —
 * and REJECTS provider/model/credential-shaped keys (the model ref is the
 * registry entry id; provider/model labels and credentials are never
 * telemetry inputs).
 */
export function assertValidUsageTelemetryInput(usage: UsageTelemetryInput): void {
  rejectForbiddenKeys(usage, USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS, 'usage telemetry');

  requireId(usage.taskProfileId, 'taskProfileId');
  requireId(usage.modelRegistryId, 'modelRegistryId');
  if (usage.executionId !== null && usage.executionId !== undefined) {
    requireId(usage.executionId, 'executionId');
  }
  if (!USAGE_TELEMETRY_OUTCOMES.includes(usage.outcome)) {
    problem('outcome is not a normalized usage-telemetry outcome', [
      `outcome: must be one of ${USAGE_TELEMETRY_OUTCOMES.join(' | ')}`,
    ]);
  }
  requireSafeInt(usage.latencyMs, 'latencyMs', 0, LATENCY_MS_MAX);
  requireCost(usage.costAmount, 'costAmount');
  requireOptionalInt(usage.tokensIn, 'tokensIn', 0, Number.MAX_SAFE_INTEGER);
  requireOptionalInt(usage.tokensOut, 'tokensOut', 0, Number.MAX_SAFE_INTEGER);
  if (usage.evaluationRef !== null && usage.evaluationRef !== undefined) {
    requireString(usage.evaluationRef, 'evaluationRef', 1, 512);
  }
  requireSafeInt(usage.escalationCount, 'escalationCount', 0, 1000);
  assertValidIdempotencyKey(usage.idempotencyKey);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AiRuntimeStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // ----- TaskProfiles -----------------------------------------------------

  /**
   * Insert fenced by the (workspace_id, idempotency_key) §8-style unique
   * constraint. 'fence' means the logical create key already exists in this
   * Workspace — the CALLER resolves convergence (same fingerprint → replay,
   * different fingerprint → conflict).
   */
  async insertTaskProfile(
    tx: DbTransaction,
    input: {
      readonly profile: TaskProfileInput;
      readonly workspaceId: string;
      readonly clientId: string;
      readonly agencyId: string;
      readonly idempotencyKey: string;
      readonly createFingerprint: string;
      readonly actorId: string | null;
    },
  ): Promise<TaskProfileRecord | 'fence'> {
    const taskProfileId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO ai_task_profiles
         (task_profile_id, task_class, quality_target, risk_class, context_requirements,
          latency_target_ms, max_cost_per_invocation, privacy_class, tool_requirements,
          output_schema, evaluator_ids, escalation_policy, workspace_id, client_id, agency_id,
          status, idempotency_key, create_fingerprint, created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
               $13, $14, $15, 'active', $16, $17, $18, 1, $19, $19)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [
        taskProfileId,
        input.profile.taskClass,
        input.profile.qualityTarget,
        input.profile.riskClass,
        JSON.stringify(input.profile.contextRequirements),
        input.profile.latencyTargetMs,
        input.profile.maxCostPerInvocation,
        input.profile.privacyClass,
        JSON.stringify(input.profile.toolRequirements),
        JSON.stringify(input.profile.outputSchema),
        JSON.stringify(input.profile.evaluatorIds),
        JSON.stringify(input.profile.escalationPolicy),
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.idempotencyKey,
        input.createFingerprint,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fence';
    // Read back THROUGH the caller's transaction — the insert is not yet
    // committed, so the read-back must share the transaction connection.
    const created = await tx.query<TaskProfileRow>(
      `${TASK_PROFILE_SELECT} WHERE task_profile_id = $1`,
      [taskProfileId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted task profile ${taskProfileId} could not be read back`);
    }
    return toTaskProfileRecord(row);
  }

  async getTaskProfile(taskProfileId: string): Promise<TaskProfileRecord | null> {
    const result = await this.db.query<TaskProfileRow>(
      `${TASK_PROFILE_SELECT} WHERE task_profile_id = $1`,
      [taskProfileId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTaskProfileRecord(row);
  }

  /** The profile recorded for one logical create key in this Workspace, or null. */
  async findTaskProfileByIdempotencyKey(
    tx: DbTransaction,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<TaskProfileRecord | null> {
    const result = await tx.query<TaskProfileRow>(
      `${TASK_PROFILE_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTaskProfileRecord(row);
  }

  async listTaskProfiles(workspaceId: string): Promise<readonly TaskProfileRecord[]> {
    const result = await this.db.query<TaskProfileRow>(
      `${TASK_PROFILE_SELECT} WHERE workspace_id = $1 ORDER BY created_at, task_profile_id`,
      [workspaceId],
    );
    return result.rows.map(toTaskProfileRecord);
  }

  /** Locks the profile row (FOR UPDATE) and returns it — CAS serialized. */
  async lockTaskProfile(
    tx: DbTransaction,
    taskProfileId: string,
  ): Promise<TaskProfileRecord | null> {
    const result = await tx.query<TaskProfileRow>(
      `${TASK_PROFILE_SELECT} WHERE task_profile_id = $1 FOR UPDATE`,
      [taskProfileId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTaskProfileRecord(row);
  }

  /**
   * CAS lifecycle transition on the CALLER'S transaction (row locked there).
   * The content-immutability and retired-terminal triggers are the final
   * backstops.
   */
  async updateTaskProfileStatus(
    tx: DbTransaction,
    input: {
      readonly taskProfileId: string;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE ai_task_profiles
       SET status = 'retired', version = version + 1, updated_at = $1
       WHERE task_profile_id = $2 AND version = $3`,
      [now, input.taskProfileId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM ai_task_profiles WHERE task_profile_id = $1',
      [input.taskProfileId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  // ----- Model registry ----------------------------------------------------

  /**
   * Insert fenced by the (provider_label, model_key) partial unique index
   * among ACTIVE entries. 'pair-taken' means an ACTIVE entry already
   * registered this pair (ConflictError upstream — the deterministic
   * duplicate fence).
   */
  async insertModel(
    input: {
      readonly model: ModelRegistrationInput;
      readonly actorId: string | null;
    },
  ): Promise<ModelRegistryRecord | 'pair-taken'> {
    const modelRegistryId = this.ids.newId();
    const now = this.clock.nowIso();
    let result;
    try {
      result = await this.db.query(
        `INSERT INTO ai_model_registry
           (model_registry_id, provider_label, model_key, display_name, capabilities, tool_features,
            context_limit_tokens, cost_input_per_mtok, cost_output_per_mtok, latency_p50_ms, latency_p95_ms,
            reliability, quality_signals, privacy_characteristics, availability_state, status,
            created_by, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb,
                 'available', 'active', $15, 1, $16, $16)
         ON CONFLICT (provider_label, model_key) WHERE status = 'active' DO NOTHING`,
        [
          modelRegistryId,
          input.model.providerLabel,
          input.model.modelKey,
          input.model.displayName,
          JSON.stringify(input.model.capabilities),
          JSON.stringify(input.model.toolFeatures),
          input.model.contextLimitTokens,
          input.model.costInputPerMtok,
          input.model.costOutputPerMtok,
          input.model.latencyP50Ms,
          input.model.latencyP95Ms,
          input.model.reliability,
          JSON.stringify(input.model.qualitySignals),
          JSON.stringify(input.model.privacyCharacteristics),
          input.actorId,
          now,
        ],
      );
    } catch (error) {
      // The partial-index fence classifies as 'pair-taken'; anything else is
      // a genuine storage failure.
      const candidate = error as { code?: string; constraint?: string };
      if (candidate?.code === '23505') return 'pair-taken';
      throw error;
    }
    if (result.rowCount !== 1) return 'pair-taken';
    const created = await this.getModel(modelRegistryId);
    if (created === null) {
      throw new Error(`inserted model registry entry ${modelRegistryId} could not be read back`);
    }
    return created;
  }

  async getModel(modelRegistryId: string): Promise<ModelRegistryRecord | null> {
    const result = await this.db.query<ModelRegistryRow>(
      `${MODEL_REGISTRY_SELECT} WHERE model_registry_id = $1`,
      [modelRegistryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toModelRegistryRecord(row);
  }

  async listModels(): Promise<readonly ModelRegistryRecord[]> {
    const result = await this.db.query<ModelRegistryRow>(
      `${MODEL_REGISTRY_SELECT} WHERE status = 'active' ORDER BY created_at, model_registry_id`,
    );
    return result.rows.map(toModelRegistryRecord);
  }

  /** Locks the model row (FOR UPDATE) and returns it — CAS serialized. */
  async lockModel(
    tx: DbTransaction,
    modelRegistryId: string,
  ): Promise<ModelRegistryRecord | null> {
    const result = await tx.query<ModelRegistryRow>(
      `${MODEL_REGISTRY_SELECT} WHERE model_registry_id = $1 FOR UPDATE`,
      [modelRegistryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toModelRegistryRecord(row);
  }

  /** CAS retire transition on the CALLER'S transaction (row locked there). */
  async updateModelStatus(
    tx: DbTransaction,
    input: {
      readonly modelRegistryId: string;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE ai_model_registry
       SET status = 'retired', version = version + 1, updated_at = $1
       WHERE model_registry_id = $2 AND version = $3`,
      [now, input.modelRegistryId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM ai_model_registry WHERE model_registry_id = $1',
      [input.modelRegistryId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  // ----- Model observations (append-only) ---------------------------------

  /**
   * Appends one observation row. The AFTER INSERT apply-state trigger on the
   * table derives the registry row's current availability_state (the only
   * sanctioned mutation path for that column) — this store method performs
   * no registry update itself.
   */
  async insertModelObservation(
    input: {
      readonly modelRegistryId: string;
      readonly availabilityState: ModelAvailabilityState;
      readonly observedLatencyP50Ms: number | null;
      readonly observedLatencyP95Ms: number | null;
      readonly source: string;
      readonly notes: string;
      readonly actorId: string | null;
    },
  ): Promise<ModelObservationRecord> {
    const observationId = this.ids.newId();
    const now = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO ai_model_observations
         (observation_id, model_registry_id, availability_state, observed_latency_p50_ms,
          observed_latency_p95_ms, source, notes, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        observationId,
        input.modelRegistryId,
        input.availabilityState,
        input.observedLatencyP50Ms,
        input.observedLatencyP95Ms,
        input.source,
        input.notes,
        input.actorId,
        now,
      ],
    );
    const created = await this.getObservation(observationId);
    if (created === null) {
      throw new Error(`inserted model observation ${observationId} could not be read back`);
    }
    return created;
  }

  private async getObservation(observationId: string): Promise<ModelObservationRecord | null> {
    const result = await this.db.query<ModelObservationRow>(
      `${MODEL_OBSERVATION_SELECT} WHERE observation_id = $1`,
      [observationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toModelObservationRecord(row);
  }

  async listModelObservations(
    modelRegistryId: string,
  ): Promise<readonly ModelObservationRecord[]> {
    const result = await this.db.query<ModelObservationRow>(
      `${MODEL_OBSERVATION_SELECT} WHERE model_registry_id = $1 ORDER BY created_at, observation_id`,
      [modelRegistryId],
    );
    return result.rows.map(toModelObservationRecord);
  }

  // ----- Usage telemetry (append-only) ------------------------------------

  /**
   * Insert fenced by the (workspace_id, idempotency_key) §8-style unique
   * constraint. 'fence' means the logical append key already exists in this
   * Workspace — the CALLER resolves convergence (same fingerprint → replay,
   * different fingerprint → conflict).
   */
  async insertUsageTelemetry(
    tx: DbTransaction,
    input: {
      readonly usage: UsageTelemetryInput;
      readonly workspaceId: string;
      readonly clientId: string;
      readonly agencyId: string;
      readonly correlationId: string;
      readonly createFingerprint: string;
      readonly actorId: string | null;
    },
  ): Promise<UsageTelemetryRecord | 'fence'> {
    const usageId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO ai_usage_telemetry
         (usage_id, workspace_id, client_id, agency_id, task_profile_id, model_registry_id,
          execution_id, correlation_id, outcome, latency_ms, cost_amount, tokens_in, tokens_out,
          evaluation_ref, escalation_count, idempotency_key, create_fingerprint, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [
        usageId,
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.usage.taskProfileId,
        input.usage.modelRegistryId,
        input.usage.executionId,
        input.correlationId,
        input.usage.outcome,
        input.usage.latencyMs,
        input.usage.costAmount,
        input.usage.tokensIn,
        input.usage.tokensOut,
        input.usage.evaluationRef,
        input.usage.escalationCount,
        input.usage.idempotencyKey,
        input.createFingerprint,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fence';
    // Read back THROUGH the caller's transaction — the insert is not yet
    // committed, so the read-back must share the transaction connection.
    const created = await tx.query<UsageTelemetryRow>(
      `${USAGE_TELEMETRY_SELECT} WHERE usage_id = $1`,
      [usageId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted usage telemetry ${usageId} could not be read back`);
    }
    return toUsageTelemetryRecord(row);
  }

  async getUsageTelemetry(usageId: string): Promise<UsageTelemetryRecord | null> {
    const result = await this.db.query<UsageTelemetryRow>(
      `${USAGE_TELEMETRY_SELECT} WHERE usage_id = $1`,
      [usageId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toUsageTelemetryRecord(row);
  }

  /** The telemetry row recorded for one logical append key in this Workspace, or null. */
  async findUsageTelemetryByIdempotencyKey(
    tx: DbTransaction,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<UsageTelemetryRecord | null> {
    const result = await tx.query<UsageTelemetryRow>(
      `${USAGE_TELEMETRY_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toUsageTelemetryRecord(row);
  }

  async listUsageTelemetry(
    workspaceId: string,
    limit: number,
  ): Promise<readonly UsageTelemetryRecord[]> {
    const result = await this.db.query<UsageTelemetryRow>(
      `${USAGE_TELEMETRY_SELECT} WHERE workspace_id = $1 ORDER BY created_at DESC, usage_id DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return result.rows.map(toUsageTelemetryRecord);
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toTaskProfileRecord(row: TaskProfileRow): TaskProfileRecord {
  return {
    taskProfileId: row.task_profile_id,
    taskClass: row.task_class,
    qualityTarget: row.quality_target,
    riskClass: row.risk_class as TaskProfileRiskClass,
    contextRequirements: row.context_requirements,
    latencyTargetMs: Number(row.latency_target_ms),
    maxCostPerInvocation: Number(row.max_cost_per_invocation),
    privacyClass: row.privacy_class as TaskProfilePrivacyClass,
    toolRequirements: (row.tool_requirements ?? []) as readonly string[],
    outputSchema: row.output_schema,
    evaluatorIds: (row.evaluator_ids ?? []) as readonly string[],
    escalationPolicy: row.escalation_policy,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    status: row.status as TaskProfileRecord['status'],
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toModelRegistryRecord(row: ModelRegistryRow): ModelRegistryRecord {
  return {
    modelRegistryId: row.model_registry_id,
    providerLabel: row.provider_label,
    modelKey: row.model_key,
    displayName: row.display_name,
    capabilities: (row.capabilities ?? []) as readonly string[],
    toolFeatures: (row.tool_features ?? []) as readonly string[],
    contextLimitTokens: Number(row.context_limit_tokens),
    costInputPerMtok: row.cost_input_per_mtok === null ? null : Number(row.cost_input_per_mtok),
    costOutputPerMtok: row.cost_output_per_mtok === null ? null : Number(row.cost_output_per_mtok),
    latencyP50Ms: row.latency_p50_ms === null ? null : Number(row.latency_p50_ms),
    latencyP95Ms: row.latency_p95_ms === null ? null : Number(row.latency_p95_ms),
    reliability: row.reliability === null ? null : Number(row.reliability),
    qualitySignals: row.quality_signals,
    privacyCharacteristics: row.privacy_characteristics,
    availabilityState: row.availability_state as ModelAvailabilityState,
    status: row.status as ModelRegistryRecord['status'],
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toModelObservationRecord(row: ModelObservationRow): ModelObservationRecord {
  return {
    observationId: row.observation_id,
    modelRegistryId: row.model_registry_id,
    availabilityState: row.availability_state as ModelAvailabilityState,
    observedLatencyP50Ms: row.observed_latency_p50_ms === null ? null : Number(row.observed_latency_p50_ms),
    observedLatencyP95Ms: row.observed_latency_p95_ms === null ? null : Number(row.observed_latency_p95_ms),
    source: row.source,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function toUsageTelemetryRecord(row: UsageTelemetryRow): UsageTelemetryRecord {
  return {
    usageId: row.usage_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    taskProfileId: row.task_profile_id,
    modelRegistryId: row.model_registry_id,
    executionId: row.execution_id,
    correlationId: row.correlation_id,
    outcome: row.outcome as UsageTelemetryOutcome,
    latencyMs: Number(row.latency_ms),
    costAmount: Number(row.cost_amount),
    tokensIn: row.tokens_in === null ? null : Number(row.tokens_in),
    tokensOut: row.tokens_out === null ? null : Number(row.tokens_out),
    evaluationRef: row.evaluation_ref,
    escalationCount: Number(row.escalation_count),
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}
