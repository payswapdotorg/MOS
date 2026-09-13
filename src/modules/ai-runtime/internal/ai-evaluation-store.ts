/**
 * /ai-runtime EVALUATION persistence + input guards (MKT-019, AI-003).
 *
 * Tables (migration 032): ai_evaluators, ai_evaluations,
 * ai_review_requests, ai_review_request_transitions.
 *
 * DB backstops behind this store (implementation-contract §3, §25,
 * mirroring migrations 016/020):
 *   - evaluator-registry CONTENT is immutable (trigger): identity, the
 *     evaluator key, the kind, the version, the config and the provenance
 *     can never be reassigned — corrections register a NEW evaluator;
 *     `retired` is terminal; the evaluator_key pair is unique among
 *     ACTIVE entries (the registration fence);
 *   - evaluation records are APPEND-ONLY history (trigger rejects UPDATE
 *     and DELETE — evaluation history is never rewritten) and the
 *     (workspace_id, idempotency_key, evaluator_key) §8-style fence makes
 *     the per-evaluator slice of one logical evaluation command converge
 *     (same fingerprint → replay; different fingerprint → conflict);
 *   - review-request context links, reason, scope and idempotency
 *     identity are immutable (trigger); the lifecycle fields move ONCE
 *     (pending → approved/rejected/dismissed, terminal — the transition
 *     trigger enforces the single legal edge and the decided-fields
 *     presence);
 *   - review-request transitions are APPEND-ONLY history (trigger rejects
 *     UPDATE and DELETE) and the UNIQUE (review_request_id) fence makes
 *     the decision EXACTLY-ONE (concurrent decides: one wins);
 *   - the scope-chain triggers reject any row whose Workspace/Client/
 *     Agency chain is inconsistent, whose TaskProfile/usage reference
 *     belongs to another Workspace, or whose execution/evaluation
 *     reference belongs to another Workspace — tenant isolation holds
 *     even under direct SQL rewrites.
 *
 * This store is INTENTIONALLY SEPARATE from the registry store
 * (ai-runtime-store.ts, MKT-017) and the routing store
 * (ai-routing-store.ts, MKT-018): one store per landed slice, composed by
 * the module's createAiRuntimeModule — the same /ai-runtime authority.
 *
 * AI-AC-08: NO query in this store reads a /metrics or /experiments
 * surface — evaluation persistence links task-level context only
 * (TaskProfile, execution, usage, evidence citations).
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  EvaluationDimension,
  EvaluationRecord,
  EvaluationResultPayload,
  EvaluatorKind,
  EvaluatorRecord,
  EvaluatorRegistrationInput,
  EvaluatorStatus,
  ReviewRequestRecord,
  ReviewRequestState,
  ReviewRequestTransitionRecord,
} from '../public.ts';
import {
  EVALUATION_VERDICTS,
  EVALUATOR_KINDS,
  EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  REVIEW_REQUEST_DECISIONS,
} from '../public.ts';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVALUATOR_KEY_PATTERN = /^[a-z][a-z0-9.-]{1,99}$/;
const IDEMPOTENCY_KEY_MAX = 200;
const JSON_CONTRACT_MAX_BYTES = 32_768;
const REASON_MAX = 2000;
const NOTE_MAX = 2000;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface EvaluatorRow extends DbRow {
  evaluator_registry_id: string;
  evaluator_key: string;
  display_name: string;
  kind: string;
  evaluator_version: number | string;
  config: Record<string, unknown>;
  status: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface EvaluationRow extends DbRow {
  evaluation_id: string;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  task_profile_id: string;
  execution_id: string | null;
  usage_id: string | null;
  evaluator_registry_id: string;
  evaluator_key: string;
  evaluator_version: number | string;
  verdict: string;
  score: string | null;
  dimensions: unknown[];
  evidence_refs: unknown[];
  uncertainty_or_limitations: string;
  correlation_id: string;
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  created_at: Date;
}

interface ReviewRequestRow extends DbRow {
  review_request_id: string;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  execution_id: string | null;
  evaluation_id: string | null;
  reason: string;
  state: string;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  correlation_id: string;
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface ReviewRequestTransitionRow extends DbRow {
  transition_id: string;
  review_request_id: string;
  from_state: string;
  to_state: string;
  decided_by: string | null;
  note: string | null;
  created_at: Date;
}

const EVALUATOR_SELECT = `
  SELECT evaluator_registry_id, evaluator_key, display_name, kind, evaluator_version, config,
         status, created_by, version, created_at, updated_at
  FROM ai_evaluators
`;

const EVALUATION_SELECT = `
  SELECT evaluation_id, workspace_id, client_id, agency_id, task_profile_id, execution_id, usage_id,
         evaluator_registry_id, evaluator_key, evaluator_version, verdict, score, dimensions,
         evidence_refs, uncertainty_or_limitations, correlation_id, idempotency_key,
         create_fingerprint, created_by, created_at
  FROM ai_evaluations
`;

const REVIEW_REQUEST_SELECT = `
  SELECT review_request_id, workspace_id, client_id, agency_id, execution_id, evaluation_id, reason,
         state, decided_by, decided_at, decision_note, correlation_id, idempotency_key,
         create_fingerprint, created_by, version, created_at, updated_at
  FROM ai_review_requests
`;

const REVIEW_REQUEST_TRANSITION_SELECT = `
  SELECT transition_id, review_request_id, from_state, to_state, decided_by, note, created_at
  FROM ai_review_request_transitions
`;

// ---------------------------------------------------------------------------
// Input guards (the module-side DTO authority, MKT-019 slice)
// ---------------------------------------------------------------------------

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

function requireJsonObject(value: unknown, field: string, maxBytes: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problem(`${field} must be a JSON object`, [`${field}: must be an object`]);
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > maxBytes) {
    problem(`${field} exceeds the bounded JSON size`, [`${field}: must be at most ${maxBytes} bytes serialized`]);
  }
  return value as Record<string, unknown>;
}

function requireOptionalId(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    problem(`${field} must be a server-generated identifier`, [`${field}: must be a UUID`]);
  }
  return value as string;
}

function requireSafeInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    problem(`${field} must be an integer`, [`${field}: must be an integer`]);
  }
  if (value < min || value > max) {
    problem(`${field} is out of bounds`, [`${field}: must be within ${min}..${max}`]);
  }
  return value;
}

/** Rejects every forbidden key present on the input object. */
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

/**
 * The evaluator-registration input guard: validates the normalized
 * evaluator definition and REJECTS SDK/provider/credential-shaped keys
 * (the registry is provider-neutral DATA — AI-AC-02 posture) and
 * business-outcome-shaped keys (AI-AC-08 — an evaluator definition never
 * references KPIs or experiment outcomes).
 */
export function assertValidEvaluatorRegistrationInput(
  evaluator: EvaluatorRegistrationInput,
): void {
  rejectForbiddenKeys(evaluator, EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS, 'evaluator registration');

  requireString(evaluator.evaluatorKey, 'evaluatorKey', 2, 100);
  if (!EVALUATOR_KEY_PATTERN.test(evaluator.evaluatorKey)) {
    problem('evaluatorKey is not a valid normalized label', [
      'evaluatorKey: must be 2..100 chars, lowercase letters/digits/dots/dashes, starting with a letter',
    ]);
  }
  requireString(evaluator.displayName, 'displayName', 1, 200);
  if (!EVALUATOR_KINDS.includes(evaluator.kind)) {
    problem('kind is not a normalized evaluator kind', [
      `kind: must be one of ${EVALUATOR_KINDS.join(' | ')}`,
    ]);
  }
  requireSafeInt(evaluator.evaluatorVersion, 'evaluatorVersion', 1, Number.MAX_SAFE_INTEGER);
  requireJsonObject(evaluator.config, 'config', JSON_CONTRACT_MAX_BYTES);
}

/**
 * The evaluation-request input guard: validates the reference ids (UUIDs),
 * the bounded output object and the adapter error bound. The evaluator
 * selection and the outcome fields are NOT inputs (derived from the
 * TaskProfile contract and computed by the evaluators) — they are
 * rejected by the route-level forbidden-key contract.
 */
export function assertValidEvaluationInput(input: {
  readonly taskProfileId: string;
  readonly executionId: string | null;
  readonly usageId: string | null;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly adapterError: string | null;
  readonly idempotencyKey: string;
}): void {
  if (typeof input.taskProfileId !== 'string' || !ID_PATTERN.test(input.taskProfileId)) {
    problem('taskProfileId must be a server-generated identifier', ['taskProfileId: must be a UUID']);
  }
  requireOptionalId(input.executionId, 'executionId');
  requireOptionalId(input.usageId, 'usageId');
  if (input.output !== null && input.output !== undefined) {
    requireJsonObject(input.output, 'output', JSON_CONTRACT_MAX_BYTES);
  }
  if (input.adapterError !== null && input.adapterError !== undefined) {
    requireString(input.adapterError, 'adapterError', 0, 2000);
  }
  requireString(input.idempotencyKey, 'idempotencyKey', 1, IDEMPOTENCY_KEY_MAX);
}

/**
 * The review-request input guard: validates the reference ids and the
 * bounded reason. The decision fields are NOT create inputs (they are
 * set only by decideReview).
 */
export function assertValidReviewRequestInput(input: {
  readonly executionId: string | null;
  readonly evaluationId: string | null;
  readonly reason: string;
  readonly idempotencyKey: string;
}): void {
  requireOptionalId(input.executionId, 'executionId');
  requireOptionalId(input.evaluationId, 'evaluationId');
  requireString(input.reason, 'reason', 1, REASON_MAX);
  requireString(input.idempotencyKey, 'idempotencyKey', 1, IDEMPOTENCY_KEY_MAX);
}

/** The decideReview input guard: the decision vocabulary + bounded note. */
export function assertValidReviewDecisionInput(input: {
  readonly decision: string;
  readonly note: string;
}): void {
  if (!REVIEW_REQUEST_DECISIONS.includes(input.decision as (typeof REVIEW_REQUEST_DECISIONS)[number])) {
    problem('decision is not a normalized review decision', [
      `decision: must be one of ${REVIEW_REQUEST_DECISIONS.join(' | ')}`,
    ]);
  }
  requireString(input.note, 'note', 0, NOTE_MAX);
}

// ---------------------------------------------------------------------------
// Fingerprints (§8-style logical-command digests)
// ---------------------------------------------------------------------------

/**
 * The §8-style fingerprint of one per-evaluator evaluation append: a
 * deterministic digest of WHAT the command records (the profile, the
 * execution/usage links and the evaluator's outcome). The correlation
 * identity and the actor are deliberately EXCLUDED — they are
 * ambient/server-derived per request.
 */
export function fingerprintEvaluationAppend(input: {
  readonly workspaceId: string;
  readonly taskProfileId: string;
  readonly executionId: string | null;
  readonly usageId: string | null;
  readonly evaluatorKey: string;
  readonly evaluatorVersion: number;
  readonly result: EvaluationResultPayload;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shape: 'ai.evaluation.append',
        workspaceId: input.workspaceId,
        taskProfileId: input.taskProfileId,
        executionId: input.executionId,
        usageId: input.usageId,
        evaluatorKey: input.evaluatorKey,
        evaluatorVersion: input.evaluatorVersion,
        verdict: input.result.verdict,
        score: input.result.score,
        dimensions: input.result.dimensions,
        evidenceRefs: input.result.evidenceRefs,
        uncertaintyOrLimitations: input.result.uncertaintyOrLimitations,
      }),
    )
    .digest('hex');
}

/** The §8-style fingerprint of one review-request create command. */
export function fingerprintReviewRequestCreate(input: {
  readonly workspaceId: string;
  readonly executionId: string | null;
  readonly evaluationId: string | null;
  readonly reason: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shape: 'ai.review-request.create',
        workspaceId: input.workspaceId,
        executionId: input.executionId,
        evaluationId: input.evaluationId,
        reason: input.reason,
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toDimensionArray(value: unknown): readonly EvaluationDimension[] {
  if (!Array.isArray(value)) return [];
  const out: EvaluationDimension[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Record<string, unknown>;
    out.push({
      dimension: typeof candidate['dimension'] === 'string' ? candidate['dimension'] : '',
      verdict: EVALUATION_VERDICTS.includes(candidate['verdict'] as never)
        ? (candidate['verdict'] as EvaluationDimension['verdict'])
        : 'unknown',
      score: typeof candidate['score'] === 'number' ? candidate['score'] : null,
      notes: typeof candidate['notes'] === 'string' ? candidate['notes'] : '',
    });
  }
  return out;
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

function toEvaluatorRecord(row: EvaluatorRow): EvaluatorRecord {
  return {
    evaluatorRegistryId: row.evaluator_registry_id,
    evaluatorKey: row.evaluator_key,
    displayName: row.display_name,
    kind: row.kind as EvaluatorKind,
    evaluatorVersion: Number(row.evaluator_version),
    config: row.config,
    status: row.status as EvaluatorStatus,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEvaluationRecord(row: EvaluationRow): EvaluationRecord {
  return {
    evaluationId: row.evaluation_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    taskProfileId: row.task_profile_id,
    executionId: row.execution_id,
    usageId: row.usage_id,
    evaluatorRegistryId: row.evaluator_registry_id,
    evaluatorKey: row.evaluator_key,
    evaluatorVersion: Number(row.evaluator_version),
    verdict: row.verdict as EvaluationRecord['verdict'],
    score: row.score === null ? null : Number(row.score),
    dimensions: toDimensionArray(row.dimensions),
    evidenceRefs: toStringArray(row.evidence_refs),
    uncertaintyOrLimitations: row.uncertainty_or_limitations,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function toReviewRequestRecord(
  row: ReviewRequestRow,
  transitions: readonly ReviewRequestTransitionRecord[],
): ReviewRequestRecord {
  return {
    reviewRequestId: row.review_request_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    executionId: row.execution_id,
    evaluationId: row.evaluation_id,
    reason: row.reason,
    state: row.state as ReviewRequestState,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
    decisionNote: row.decision_note,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    transitions,
  };
}

function toReviewRequestTransitionRecord(row: ReviewRequestTransitionRow): ReviewRequestTransitionRecord {
  return {
    transitionId: row.transition_id,
    reviewRequestId: row.review_request_id,
    fromState: row.from_state as ReviewRequestState,
    toState: row.to_state as ReviewRequestState,
    decidedBy: row.decided_by,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AiEvaluationStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // ----- Evaluator registry --------------------------------------------------

  /**
   * Insert fenced by the (evaluator_key) partial unique index among ACTIVE
   * entries. 'key-taken' means an ACTIVE evaluator with the same key
   * already exists — a deterministic ConflictError (a retired key may be
   * re-registered as a NEW identity).
   */
  async insertEvaluator(input: {
    readonly evaluator: EvaluatorRegistrationInput;
    readonly actorId: string | null;
  }): Promise<EvaluatorRecord | 'key-taken'> {
    const evaluatorRegistryId = this.ids.newId();
    const now = this.clock.nowIso();
    let result;
    try {
      result = await this.db.query(
        `INSERT INTO ai_evaluators
           (evaluator_registry_id, evaluator_key, display_name, kind, evaluator_version, config,
            status, created_by, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', $7, 1, $8, $8)`,
        [
          evaluatorRegistryId,
          input.evaluator.evaluatorKey,
          input.evaluator.displayName,
          input.evaluator.kind,
          input.evaluator.evaluatorVersion,
          JSON.stringify(input.evaluator.config),
          input.actorId,
          now,
        ],
      );
    } catch (error) {
      const candidate = error as { code?: string; constraint?: string };
      if (candidate?.code === '23505') return 'key-taken';
      throw error;
    }
    if (result.rowCount !== 1) {
      throw new Error(`inserted evaluator ${evaluatorRegistryId} reported no row`);
    }
    const created = await this.db.query<EvaluatorRow>(
      `${EVALUATOR_SELECT} WHERE evaluator_registry_id = $1`,
      [evaluatorRegistryId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted evaluator ${evaluatorRegistryId} could not be read back`);
    }
    return toEvaluatorRecord(row);
  }

  async getEvaluator(evaluatorRegistryId: string): Promise<EvaluatorRecord | null> {
    // Non-UUID ids are indistinguishable from unknown ones (uniform null).
    if (!ID_PATTERN.test(evaluatorRegistryId)) return null;
    const result = await this.db.query<EvaluatorRow>(
      `${EVALUATOR_SELECT} WHERE evaluator_registry_id = $1`,
      [evaluatorRegistryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvaluatorRecord(row);
  }

  /** The ACTIVE entry for one evaluator KEY (null when none is active). */
  async findActiveEvaluatorByKey(evaluatorKey: string): Promise<EvaluatorRecord | null> {
    const result = await this.db.query<EvaluatorRow>(
      `${EVALUATOR_SELECT} WHERE evaluator_key = $1 AND status = 'active' ORDER BY created_at DESC, evaluator_registry_id DESC LIMIT 1`,
      [evaluatorKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvaluatorRecord(row);
  }

  /** The ACTIVE registry entries, oldest first (retired history stays readable by id). */
  async listEvaluators(): Promise<readonly EvaluatorRecord[]> {
    const result = await this.db.query<EvaluatorRow>(
      `${EVALUATOR_SELECT} WHERE status = 'active' ORDER BY created_at, evaluator_registry_id`,
    );
    return result.rows.map(toEvaluatorRecord);
  }

  async lockEvaluator(
    tx: DbTransaction,
    evaluatorRegistryId: string,
  ): Promise<EvaluatorRecord | null> {
    const result = await tx.query<EvaluatorRow>(
      `${EVALUATOR_SELECT} WHERE evaluator_registry_id = $1 FOR UPDATE`,
      [evaluatorRegistryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvaluatorRecord(row);
  }

  async updateEvaluatorStatus(
    tx: DbTransaction,
    input: {
      readonly evaluatorRegistryId: string;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE ai_evaluators
       SET status = 'retired', version = version + 1, updated_at = $1
       WHERE evaluator_registry_id = $2 AND version = $3`,
      [now, input.evaluatorRegistryId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM ai_evaluators WHERE evaluator_registry_id = $1',
      [input.evaluatorRegistryId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  // ----- Evaluation outcome records (append-only) ---------------------------

  /**
   * Insert one per-evaluator outcome row, fenced by the (workspace_id,
   * idempotency_key, evaluator_key) §8-style unique constraint. 'fence'
   * means the per-evaluator slice of this logical evaluation command was
   * already recorded — the CALLER resolves convergence.
   */
  async insertEvaluation(
    tx: DbTransaction,
    input: {
      readonly workspaceId: string;
      readonly clientId: string;
      readonly agencyId: string;
      readonly taskProfileId: string;
      readonly executionId: string | null;
      readonly usageId: string | null;
      readonly evaluatorRegistryId: string;
      readonly evaluatorKey: string;
      readonly evaluatorVersion: number;
      readonly result: EvaluationResultPayload;
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly createFingerprint: string;
      readonly actorId: string | null;
    },
  ): Promise<EvaluationRecord | 'fence'> {
    const evaluationId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO ai_evaluations
         (evaluation_id, workspace_id, client_id, agency_id, task_profile_id, execution_id, usage_id,
          evaluator_registry_id, evaluator_key, evaluator_version, verdict, score, dimensions,
          evidence_refs, uncertainty_or_limitations, correlation_id, idempotency_key,
          create_fingerprint, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (workspace_id, idempotency_key, evaluator_key) DO NOTHING`,
      [
        evaluationId,
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.taskProfileId,
        input.executionId,
        input.usageId,
        input.evaluatorRegistryId,
        input.evaluatorKey,
        input.evaluatorVersion,
        input.result.verdict,
        input.result.score,
        JSON.stringify(input.result.dimensions),
        JSON.stringify(input.result.evidenceRefs),
        input.result.uncertaintyOrLimitations,
        input.correlationId,
        input.idempotencyKey,
        input.createFingerprint,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fence';
    const created = await tx.query<EvaluationRow>(
      `${EVALUATION_SELECT} WHERE evaluation_id = $1`,
      [evaluationId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted evaluation ${evaluationId} could not be read back`);
    }
    return toEvaluationRecord(row);
  }

  async getEvaluation(evaluationId: string): Promise<EvaluationRecord | null> {
    // Non-UUID ids are indistinguishable from unknown ones (uniform null —
    // the uuid column would otherwise reject the syntax).
    if (!ID_PATTERN.test(evaluationId)) return null;
    const result = await this.db.query<EvaluationRow>(
      `${EVALUATION_SELECT} WHERE evaluation_id = $1`,
      [evaluationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvaluationRecord(row);
  }

  async findEvaluationByIdempotencyKey(
    tx: DbTransaction,
    workspaceId: string,
    idempotencyKey: string,
    evaluatorKey: string,
  ): Promise<EvaluationRecord | null> {
    const result = await tx.query<EvaluationRow>(
      `${EVALUATION_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2 AND evaluator_key = $3`,
      [workspaceId, idempotencyKey, evaluatorKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvaluationRecord(row);
  }

  async listEvaluations(workspaceId: string, limit: number): Promise<readonly EvaluationRecord[]> {
    const result = await this.db.query<EvaluationRow>(
      `${EVALUATION_SELECT} WHERE workspace_id = $1 ORDER BY created_at DESC, evaluation_id DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return result.rows.map(toEvaluationRecord);
  }

  // ----- Review requests (the human-review hook) -----------------------------

  /**
   * Insert fenced by the (workspace_id, idempotency_key) §8-style unique
   * constraint. 'fence' means the logical create command was already
   * recorded — the CALLER resolves convergence.
   */
  async insertReviewRequest(
    tx: DbTransaction,
    input: {
      readonly workspaceId: string;
      readonly clientId: string;
      readonly agencyId: string;
      readonly executionId: string | null;
      readonly evaluationId: string | null;
      readonly reason: string;
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly createFingerprint: string;
      readonly actorId: string | null;
    },
  ): Promise<ReviewRequestRecord | 'fence'> {
    const reviewRequestId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO ai_review_requests
         (review_request_id, workspace_id, client_id, agency_id, execution_id, evaluation_id, reason,
          state, correlation_id, idempotency_key, create_fingerprint, created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, 1, $12, $12)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [
        reviewRequestId,
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.executionId,
        input.evaluationId,
        input.reason,
        input.correlationId,
        input.idempotencyKey,
        input.createFingerprint,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fence';
    const created = await tx.query<ReviewRequestRow>(
      `${REVIEW_REQUEST_SELECT} WHERE review_request_id = $1`,
      [reviewRequestId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted review request ${reviewRequestId} could not be read back`);
    }
    return toReviewRequestRecord(row, []);
  }

  async findReviewRequestByIdempotencyKey(
    tx: DbTransaction,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<ReviewRequestRecord | null> {
    const result = await tx.query<ReviewRequestRow>(
      `${REVIEW_REQUEST_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toReviewRequestRecord(row, []);
  }

  async listReviewRequestTransitions(
    reviewRequestId: string,
  ): Promise<readonly ReviewRequestTransitionRecord[]> {
    const result = await this.db.query<ReviewRequestTransitionRow>(
      `${REVIEW_REQUEST_TRANSITION_SELECT} WHERE review_request_id = $1 ORDER BY created_at, transition_id`,
      [reviewRequestId],
    );
    return result.rows.map(toReviewRequestTransitionRecord);
  }

  async getReviewRequest(reviewRequestId: string): Promise<ReviewRequestRecord | null> {
    // Non-UUID ids are indistinguishable from unknown ones (uniform null).
    if (!ID_PATTERN.test(reviewRequestId)) return null;
    const result = await this.db.query<ReviewRequestRow>(
      `${REVIEW_REQUEST_SELECT} WHERE review_request_id = $1`,
      [reviewRequestId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const transitions = await this.listReviewRequestTransitions(reviewRequestId);
    return toReviewRequestRecord(row, transitions);
  }

  async listReviewRequests(
    workspaceId: string,
    state: ReviewRequestState | undefined,
    limit: number,
  ): Promise<readonly ReviewRequestRecord[]> {
    const result =
      state === undefined
        ? await this.db.query<ReviewRequestRow>(
            `${REVIEW_REQUEST_SELECT} WHERE workspace_id = $1 ORDER BY created_at DESC, review_request_id DESC LIMIT $2`,
            [workspaceId, limit],
          )
        : await this.db.query<ReviewRequestRow>(
            `${REVIEW_REQUEST_SELECT} WHERE workspace_id = $1 AND state = $2 ORDER BY created_at DESC, review_request_id DESC LIMIT $3`,
            [workspaceId, state, limit],
          );
    const out: ReviewRequestRecord[] = [];
    for (const row of result.rows) {
      const transitions = await this.listReviewRequestTransitions(row.review_request_id);
      out.push(toReviewRequestRecord(row, transitions));
    }
    return out;
  }

  async lockReviewRequest(
    tx: DbTransaction,
    reviewRequestId: string,
  ): Promise<ReviewRequestRecord | null> {
    const result = await tx.query<ReviewRequestRow>(
      `${REVIEW_REQUEST_SELECT} WHERE review_request_id = $1 FOR UPDATE`,
      [reviewRequestId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toReviewRequestRecord(row, []);
  }

  /**
   * Appends the single lifecycle transition row (pending → terminal) and
   * applies the state-guarded decision update. The transitions-table
   * UNIQUE (review_request_id) fence is the concurrency backstop: exactly
   * one decision wins.
   */
  async applyReviewDecision(
    tx: DbTransaction,
    input: {
      readonly reviewRequestId: string;
      readonly fromState: ReviewRequestState;
      readonly toState: ReviewRequestState;
      readonly decidedBy: string | null;
      readonly note: string;
    },
  ): Promise<ReviewRequestRecord | null> {
    const transitionId = this.ids.newId();
    const now = this.clock.nowIso();
    // The transition row FIRST: the UNIQUE (review_request_id) fence makes
    // a concurrent second decision fail HERE (23505) instead of silently
    // double-deciding.
    await tx.query(
      `INSERT INTO ai_review_request_transitions
         (transition_id, review_request_id, from_state, to_state, decided_by, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        transitionId,
        input.reviewRequestId,
        input.fromState,
        input.toState,
        input.decidedBy,
        input.note === '' ? null : input.note,
        now,
      ],
    );
    const updated = await tx.query(
      `UPDATE ai_review_requests
       SET state = $1, decided_by = $2, decided_at = $3, decision_note = $4,
           version = version + 1, updated_at = $5
       WHERE review_request_id = $6 AND state = 'pending'`,
      [
        input.toState,
        input.decidedBy,
        now,
        input.note === '' ? null : input.note,
        now,
        input.reviewRequestId,
      ],
    );
    if (updated.rowCount !== 1) {
      // The state-guarded update lost: a concurrent decision moved the
      // state between the lock and this write. The transitions fence will
      // have fired first in practice; surface a deterministic conflict.
      return null;
    }
    const readBack = await tx.query<ReviewRequestRow>(
      `${REVIEW_REQUEST_SELECT} WHERE review_request_id = $1`,
      [input.reviewRequestId],
    );
    const row = readBack.rows[0];
    if (row === undefined) return null;
    // Read the transitions THROUGH THE TRANSACTION — the just-inserted
    // transition row is invisible to other connections until commit.
    const transitionRows = await tx.query<ReviewRequestTransitionRow>(
      `${REVIEW_REQUEST_TRANSITION_SELECT} WHERE review_request_id = $1 ORDER BY created_at, transition_id`,
      [input.reviewRequestId],
    );
    return toReviewRequestRecord(row, transitionRows.rows.map(toReviewRequestTransitionRecord));
  }
}
