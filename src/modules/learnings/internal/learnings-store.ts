/**
 * /learnings persistence (learnings + learning_relationships tables —
 * migration 027, the MKT-016-reserved number).
 *
 * Two durable structures:
 *
 *   - `learnings`: ONE row per Learning, FULLY immutable — a BEFORE
 *     UPDATE OR DELETE trigger rejects every mutation (the migration 015
 *     evidence pattern). There is NO mutable state column: the Learning
 *     state (active/superseded/contradicted/retired,
 *     implementation-contract §17) is DERIVED at read time from the
 *     relationship history (the SELECT below), so contradiction and
 *     supersession NEVER rewrite the original row (LEARN-AC-02) — the
 *     row is byte-stable forever.
 *   - `learning_relationships`: the APPEND-ONLY relationship history —
 *     UPDATE and DELETE are rejected by triggers. Each row is one
 *     contradiction / supersession / retirement (kind + the EARLIER
 *     target learning + the LATER learning when applicable), carrying
 *     its own server-derived provenance.
 *
 * The database is the final backstop for every material invariant:
 *   - the closed kind enumeration is a CHECK; the payload shape
 *     (to_learning_id present exactly for contradicts/supersedes) and
 *     the no-self-reference rule are row CHECKs;
 *   - the SUPERSESSION and RETIREMENT fences are partial unique indexes
 *     (at most one successor; at most one retirement);
 *   - the terminal-target trigger rejects relationships against
 *     already-superseded or already-retired learnings;
 *   - the cross-tenant relationship trigger requires both learnings of
 *     the SAME Client;
 *   - the workspace scope must live inside the owning Client (trigger);
 *   - cited evidence/experiment refs must belong to the SAME Client
 *     (trigger — the migration 019 experiment-conclusion pattern).
 *
 * Provenance columns (recorded_actor, recorded_via, correlation_id,
 * causation_id, recorded_at) are written ONLY from the server-built
 * provenance argument — there is no caller path to them.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  LearningApplicabilityValue,
  LearningCreateInput,
  LearningProvenance,
  LearningRecord,
  LearningRelationshipInput,
  LearningRelationshipKind,
  LearningRelationshipRecord,
  LearningStatus,
} from '../public.ts';
import { isKnownLearningRelationshipKind } from '../public.ts';
// The allowed cross-module import (frozen matrix: /learnings ──→
// /evidence, /experiments, /goals): the shared §21 material-key backstop
// from the /evidence public contract — a single source of truth for the
// forbidden key set.
import { containsMaterialKey } from '../../evidence/public.ts';

// ---------------------------------------------------------------------------
// Shape bounds (module-side; the DB CHECKs mirror the scalar ones)
// ---------------------------------------------------------------------------

const MAX_TEXT_100 = 100;
const MAX_STATEMENT_LENGTH = 2000;
const MAX_APPLICABILITY_KEYS = 20;
const MAX_APPLICABILITY_KEY_LENGTH = 100;
const MAX_APPLICABILITY_VALUE_LENGTH = 256;
const MAX_REFS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface LearningRow extends DbRow {
  learning_id: string;
  client_id: string;
  workspace_id: string | null;
  statement: string;
  applicability: unknown;
  evidence_refs: unknown;
  experiment_refs: unknown;
  confidence: string | null;
  derived_status: string;
  superseded_by: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface LearningRelationshipRow extends DbRow {
  relationship_id: string;
  from_learning_id: string;
  to_learning_id: string | null;
  kind: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

/**
 * The shared learning SELECT: the immutable row plus the DERIVED state
 * and successor pointer, computed from the relationship history (never
 * stored — LEARN-AC-02: contradiction/supersession create NEW rows, the
 * original row stays byte-stable). The precedence is
 * superseded > retired > contradicted > active (implementation-contract
 * §17 states; superseded/retired terminal).
 */
const LEARNING_SELECT = `
  SELECT l.learning_id, l.client_id, l.workspace_id, l.statement, l.applicability,
         l.evidence_refs, l.experiment_refs, l.confidence,
         l.recorded_actor, l.recorded_via, l.correlation_id, l.causation_id, l.recorded_at,
         CASE
           WHEN EXISTS (SELECT 1 FROM learning_relationships r
                        WHERE r.from_learning_id = l.learning_id AND r.kind = 'supersedes')
             THEN 'superseded'
           WHEN EXISTS (SELECT 1 FROM learning_relationships r
                        WHERE r.from_learning_id = l.learning_id AND r.kind = 'retires')
             THEN 'retired'
           WHEN EXISTS (SELECT 1 FROM learning_relationships r
                        WHERE r.from_learning_id = l.learning_id AND r.kind = 'contradicts')
             THEN 'contradicted'
           ELSE 'active'
         END AS derived_status,
         (SELECT r.to_learning_id FROM learning_relationships r
          WHERE r.from_learning_id = l.learning_id AND r.kind = 'supersedes'
          LIMIT 1) AS superseded_by
  FROM learnings l
`;

// ---------------------------------------------------------------------------
// Pure guards (exported through the public contract)
// ---------------------------------------------------------------------------

/** Applicability condition values are scalars by construction (JSON-safe). */
function isScalarApplicabilityValue(value: unknown): value is LearningApplicabilityValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

function boundedTextProblems(
  label: string,
  value: string | null | undefined,
  options: { readonly required: true; readonly max: number }
    | { readonly required: false; readonly max: number },
): string[] {
  if (typeof value !== 'string' || value.trim() === '') {
    if (options.required) return [`${label}: a non-empty value is required`];
    return value === null || value === undefined
      ? []
      : [`${label}: must be a non-empty string when present`];
  }
  if (value.length > options.max) {
    return [`${label}: must be at most ${options.max} characters`];
  }
  return [];
}

/**
 * Applicability problems: a non-empty object of dimension-like scalar
 * conditions ("durable conclusion with explicit applicability
 * conditions"), bounded and material-key clean (§21 defense in depth).
 */
function applicabilityProblems(
  applicability: Readonly<Record<string, LearningApplicabilityValue>> | null | undefined,
): string[] {
  const problems: string[] = [];
  if (applicability === null || typeof applicability !== 'object' || Array.isArray(applicability)) {
    return ['applicability: a non-empty object of applicability conditions is required'];
  }
  const entries = Object.entries(applicability);
  if (entries.length === 0) {
    return ['applicability: a non-empty object of applicability conditions is required'];
  }
  if (entries.length > MAX_APPLICABILITY_KEYS) {
    problems.push(
      `applicability: must carry at most ${MAX_APPLICABILITY_KEYS} condition keys`,
    );
  }
  for (const [key, value] of entries) {
    if (key.trim() === '' || key.length > MAX_APPLICABILITY_KEY_LENGTH) {
      problems.push(
        `applicability: condition keys must be between 1 and ${MAX_APPLICABILITY_KEY_LENGTH} characters (found '${key}')`,
      );
    }
    if (!isScalarApplicabilityValue(value)) {
      problems.push(
        `applicability.${key}: condition values must be scalars (string, number or boolean)`,
      );
    } else if (typeof value === 'string' && value.length > MAX_APPLICABILITY_VALUE_LENGTH) {
      problems.push(
        `applicability.${key}: string condition values must be at most ${MAX_APPLICABILITY_VALUE_LENGTH} characters`,
      );
    }
  }
  // §21 defense in depth: material-shaped keys can never appear in the
  // applicability payload.
  if (containsMaterialKey(applicability)) {
    problems.push(
      'applicability: material-shaped keys can never appear in learning payloads (implementation-contract §21)',
    );
  }
  return problems;
}

/**
 * Reference-array problems: uuid-shaped, bounded, duplicate-free (the
 * evidence/experiment citation shape — semantic same-Client validation
 * happens in the module through the owning authorities' public
 * contracts; the DB trigger is the tenant fence).
 */
function referenceArrayProblems(label: string, refs: readonly string[] | null | undefined): string[] {
  const problems: string[] = [];
  if (refs === null || refs === undefined) {
    return [`${label}: required (an array; empty when nothing is cited)`];
  }
  if (!Array.isArray(refs)) {
    return [`${label}: must be an array of record ids`];
  }
  if (refs.length > MAX_REFS) {
    problems.push(`${label}: at most ${MAX_REFS} records may be cited`);
  }
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    if (typeof ref !== 'string' || !UUID_PATTERN.test(ref)) {
      problems.push(`${label}[${index}]: must be a record id (uuid)`);
    } else if (seen.has(ref)) {
      problems.push(`${label}[${index}]: duplicate reference`);
    } else {
      seen.add(ref);
    }
  });
  return problems;
}

/**
 * Pure append guard at the authority boundary: the module never persists
 * a Learning that violates the frozen §17 Learning contract, whatever
 * the caller did upstream. Mirrors the DB CHECKs and adds the per-field
 * semantics the jsonb CHECKs cannot express (applicability shapes,
 * reference bounds, §21 material-key rejection, the confidence range as
 * a SEPARATE descriptive field).
 */
export function assertValidLearningCreate(input: LearningCreateInput): void {
  const problems: string[] = [];

  problems.push(
    ...boundedTextProblems('statement', input.statement, { required: true, max: MAX_STATEMENT_LENGTH }),
  );

  problems.push(...applicabilityProblems(input.applicability));

  problems.push(...referenceArrayProblems('evidenceRefs', input.evidenceRefs));
  problems.push(...referenceArrayProblems('experimentRefs', input.experimentRefs));

  if (input.confidence !== null && input.confidence !== undefined) {
    if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) {
      problems.push('confidence: a finite number between 0 and 1 when present');
    } else if (input.confidence < 0 || input.confidence > 1) {
      problems.push('confidence: must be between 0 and 1 (a separate descriptive field, never provenance)');
    }
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('learning rejected by the append guard', problems);
  }
}

/**
 * Pure relationship-input guard: the CLOSED kind taxonomy
 * (contradicts/supersedes/retires), the to-learning presence rules (a
 * contradiction/supersession carries its later learning; a retirement
 * carries none) and the uuid shape. `fromLearningId` is the TARGET
 * learning the relationship is recorded against (the path identity).
 */
export function assertValidLearningRelationshipInput(
  fromLearningId: string,
  input: LearningRelationshipInput,
): void {
  const problems: string[] = [];
  if (
    typeof input.kind !== 'string' ||
    !isKnownLearningRelationshipKind(input.kind)
  ) {
    throw new InvalidRequestError(
      'learning relationship rejected: unknown relationship kind',
      ['kind: must be one of the frozen relationship kinds (contradicts, supersedes, retires)'],
    );
  }
  if (input.kind === 'retires') {
    if (input.toLearningId !== null && input.toLearningId !== undefined) {
      problems.push('toLearningId: must be absent for a retirement (retirement has no successor)');
    }
  } else {
    if (input.toLearningId === null || input.toLearningId === undefined) {
      problems.push('toLearningId: required for a contradiction or supersession (the later learning)');
    } else if (typeof input.toLearningId !== 'string' || !UUID_PATTERN.test(input.toLearningId)) {
      problems.push('toLearningId: must be a learning id (uuid)');
    } else if (input.toLearningId === fromLearningId) {
      problems.push('toLearningId: a learning cannot contradict, supersede or retire itself');
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('learning relationship rejected', problems);
  }
}

/**
 * Provenance is server-derived and must be COMPLETE before any write: an
 * incomplete provenance fails closed (the rows' authority columns are
 * never defaulted from caller input). Mirrors the /evidence and
 * /experiments guards.
 */
export function assertValidLearningProvenance(provenance: LearningProvenance): void {
  const problems: string[] = [];
  if (provenance.actor.trim() === '') {
    problems.push('provenance.actor: a non-empty server-derived principal label is required');
  }
  if (provenance.recordedVia.trim() === '' || provenance.recordedVia.length > MAX_TEXT_100) {
    problems.push('provenance.recordedVia: a non-empty server-derived system label is required');
  }
  if (provenance.correlationId.trim() === '') {
    problems.push('provenance.correlationId: learning mutations are correlation-linked');
  }
  if (provenance.causationId !== null && provenance.causationId.trim() === '') {
    problems.push('provenance.causationId: must be a non-empty identifier when present');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      'learning mutation rejected: provenance is server-derived and must be complete',
      problems,
    );
  }
}

// ---------------------------------------------------------------------------
// Insert classification (DB-triggered invariants converged to domain errors)
// ---------------------------------------------------------------------------

/** Distinctive markers of the migration 027 fence/trigger rejections. */
const LEARNING_FENCE_MARKER = 'learning_supersession_fence';
const LEARNING_RETIREMENT_FENCE_MARKER = 'learning_retirement_fence';
const RELATIONSHIP_TERMINAL_MARKER = 'history is terminal';
const RELATIONSHIP_CROSS_TENANT_MARKER = 'cross-tenant learning relationships are rejected';
const REFS_CROSS_TENANT_MARKER = 'cross-tenant evidence linkage is rejected';
const REFS_CROSS_TENANT_EXPERIMENT_MARKER = 'cross-tenant experiment linkage is rejected';
const WORKSPACE_SCOPE_MARKER = 'cannot cross the Client boundary';

export type LearningWriteConflict =
  | 'supersession-fence'
  | 'retirement-fence'
  | 'relationship-terminal'
  | 'relationship-cross-tenant'
  | 'refs-cross-tenant'
  | 'workspace-scope';

/**
 * Classifies a postgres error on a /learnings write into the module-level
 * domain error (the module pre-checks lost to a concurrent change — the
 * DB trigger or fence won). Anything else propagates untouched.
 */
export function classifyLearningWriteConflict(error: unknown): LearningWriteConflict | null {
  const candidate = error as { message?: string; constraint?: string; code?: string };
  if (candidate?.message === undefined && candidate?.constraint === undefined) return null;
  const haystack = `${candidate.message ?? ''} ${candidate.constraint ?? ''}`;
  if (candidate.code === '23505') {
    if (haystack.includes(LEARNING_FENCE_MARKER)) return 'supersession-fence';
    if (haystack.includes(LEARNING_RETIREMENT_FENCE_MARKER)) return 'retirement-fence';
  }
  if (haystack.includes(RELATIONSHIP_TERMINAL_MARKER)) return 'relationship-terminal';
  if (haystack.includes(RELATIONSHIP_CROSS_TENANT_MARKER)) return 'relationship-cross-tenant';
  if (haystack.includes(REFS_CROSS_TENANT_MARKER)) return 'refs-cross-tenant';
  if (haystack.includes(REFS_CROSS_TENANT_EXPERIMENT_MARKER)) return 'refs-cross-tenant';
  if (haystack.includes(WORKSPACE_SCOPE_MARKER)) return 'workspace-scope';
  return null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface LearningInsertRow {
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly statement: string;
  readonly applicability: Readonly<Record<string, LearningApplicabilityValue>>;
  readonly evidenceRefs: readonly string[];
  readonly experimentRefs: readonly string[];
  readonly confidence: number | null;
}

export class LearningStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Inserts the immutable Learning row (derived status is 'active' until
   * a relationship says otherwise — nothing is stored for state). The DB
   * triggers are the final backstops (workspace-within-client;
   * same-client reference fences).
   */
  async insertLearning(
    row: LearningInsertRow,
    provenance: LearningProvenance,
  ): Promise<LearningRecord> {
    const learningId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO learnings (learning_id, client_id, workspace_id, statement, applicability,
                             evidence_refs, experiment_refs, confidence,
                             recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8,
               $9, $10, $11, $12, $13)`,
      [
        learningId,
        row.clientId,
        row.workspaceId,
        row.statement,
        JSON.stringify(row.applicability),
        JSON.stringify(row.evidenceRefs),
        JSON.stringify(row.experimentRefs),
        row.confidence,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        recordedAt,
      ],
    );
    const created = await this.getLearning(learningId);
    if (created === null) {
      throw new Error(`appended learning ${learningId} could not be read back`);
    }
    return created;
  }

  /**
   * The learning record with its DERIVED status and successor pointer —
   * the state is computed from the relationship history, never stored
   * (LEARN-AC-02: the row itself is immutable and byte-stable).
   */
  async getLearning(learningId: string): Promise<LearningRecord | null> {
    const result = await this.db.query<LearningRow>(
      `${LEARNING_SELECT} WHERE l.learning_id = $1`,
      [learningId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLearningRecord(row);
  }

  /**
   * The Client's learnings, newest first by server-recorded time (bounded
   * — the append-only ledger accumulates without end). Derived statuses
   * included: superseded and retired learnings stay readable history.
   */
  async listLearningsForClient(
    clientId: string,
    limit = 500,
  ): Promise<readonly LearningRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<LearningRow>(
      `${LEARNING_SELECT} WHERE l.client_id = $1
       ORDER BY l.recorded_at DESC, l.learning_id LIMIT $2`,
      [clientId, bounded],
    );
    return result.rows.map(toLearningRecord);
  }

  /**
   * Appends ONE relationship row (LEARN-AC-02 — the history-preserving
   * contradiction/supersession/retirement). The caller has already
   * validated the shapes and the target's derived status; the DB fences
   * (single supersession, single retirement, terminal-target backstop,
   * same-client trigger) are the race backstops.
   */
  async insertRelationship(
    fromLearningId: string,
    kind: LearningRelationshipKind,
    toLearningId: string | null,
    provenance: LearningProvenance,
  ): Promise<LearningRelationshipRecord> {
    const relationshipId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                                  recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        relationshipId,
        fromLearningId,
        toLearningId,
        kind,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        recordedAt,
      ],
    );
    const inserted = await this.getRelationship(relationshipId);
    if (inserted === null) {
      throw new Error(`recorded learning relationship ${relationshipId} could not be read back`);
    }
    return inserted;
  }

  async getRelationship(relationshipId: string): Promise<LearningRelationshipRecord | null> {
    const result = await this.db.query<LearningRelationshipRow>(
      `SELECT r.relationship_id, r.from_learning_id, r.to_learning_id, r.kind,
              r.recorded_actor, r.recorded_via, r.correlation_id, r.causation_id, r.recorded_at
       FROM learning_relationships r
       WHERE r.relationship_id = $1`,
      [relationshipId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLearningRelationshipRecord(row);
  }

  /**
   * The FULL relationship chain around one learning, oldest first: rows
   * recorded AGAINST it (from_learning_id = the learning) and rows it
   * recorded against earlier learnings (to_learning_id = the learning) —
   * the complete history trail (LEARN-AC-02).
   */
  async listRelationshipsForLearning(
    learningId: string,
    limit = 500,
  ): Promise<readonly LearningRelationshipRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<LearningRelationshipRow>(
      `SELECT r.relationship_id, r.from_learning_id, r.to_learning_id, r.kind,
              r.recorded_actor, r.recorded_via, r.correlation_id, r.causation_id, r.recorded_at
       FROM learning_relationships r
       WHERE r.from_learning_id = $1 OR r.to_learning_id = $1
       ORDER BY r.recorded_at ASC, r.relationship_id LIMIT $2`,
      [learningId, bounded],
    );
    return result.rows.map(toLearningRelationshipRecord);
  }
}

// ---------------------------------------------------------------------------
// Row → record mapping (faithful round-trip; nothing is dropped)
// ---------------------------------------------------------------------------

function toLearningRecord(row: LearningRow): LearningRecord {
  return {
    learningId: row.learning_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    statement: row.statement,
    applicability: (row.applicability ?? {}) as Readonly<Record<string, LearningApplicabilityValue>>,
    evidenceRefs: (row.evidence_refs ?? []) as readonly string[],
    experimentRefs: (row.experiment_refs ?? []) as readonly string[],
    // pg returns numeric as string — the descriptive confidence is
    // round-tripped as a finite number.
    confidence:
      row.confidence === null ? null : Number.parseFloat(row.confidence),
    status: row.derived_status as LearningStatus,
    supersededBy: row.superseded_by,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
  };
}

function toLearningRelationshipRecord(row: LearningRelationshipRow): LearningRelationshipRecord {
  return {
    relationshipId: row.relationship_id,
    fromLearningId: row.from_learning_id,
    toLearningId: row.to_learning_id,
    kind: row.kind as LearningRelationshipKind,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
  };
}
