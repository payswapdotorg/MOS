/**
 * /evidence persistence (evidence table) — append-only by database
 * backstop (migration 015): UPDATE and DELETE are rejected by triggers, so
 * this store can only INSERT and SELECT. Corrections are NEW rows that
 * reference the prior row (supersedes_evidence_id), fenced to exactly one
 * superseding record per prior record by the partial unique index
 * evidence_supersession_fence.
 *
 * Provenance columns (recorded_actor, recorded_via, correlation_id,
 * causation_id, recorded_at) are written ONLY from the server-built
 * EvidenceProvenance argument — there is no other write path, and the
 * append guard refuses to even run with an incomplete provenance.
 *
 * The §21 secret-leak guard runs BEFORE insert at every nesting level of
 * the content payload: material-shaped keys can never enter an evidence
 * record (implementation-contract §21: "Secrets may never appear in …
 * evidence payloads").
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  EvidenceAppendInput,
  EvidenceClass,
  EvidenceProvenance,
  EvidenceQualityGrade,
  EvidenceRecord,
} from '../public.ts';
import {
  isKnownEvidenceClass,
  isKnownEvidenceQuality,
} from '../public.ts';

interface EvidenceRow extends DbRow {
  evidence_id: string;
  client_id: string;
  workspace_id: string | null;
  class: string;
  source_system: string;
  source_ref: string | null;
  observed_at: Date;
  content: unknown;
  content_ref: string | null;
  quality: string;
  confidence: string | null;
  supersedes_evidence_id: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
  superseded_by: string | null;
}

/**
 * One successor at most per record is guaranteed by the partial unique
 * fence (evidence_supersession_fence), so this scalar subquery is exact.
 */
const EVIDENCE_SELECT = `
  SELECT e.evidence_id, e.client_id, e.workspace_id, e.class, e.source_system, e.source_ref,
         e.observed_at, e.content, e.content_ref, e.quality, e.confidence,
         e.supersedes_evidence_id, e.recorded_actor, e.recorded_via, e.correlation_id,
         e.causation_id, e.recorded_at,
         (SELECT s.evidence_id FROM evidence s WHERE s.supersedes_evidence_id = e.evidence_id) AS superseded_by
  FROM evidence e
`;

/**
 * Content keys that can never appear in an evidence payload at ANY nesting
 * level (implementation-contract §21 backstop — defense in depth beyond
 * the structural rule that content is built from validated request
 * fields). Exact-key match, case-insensitive (the audit_events §21 set).
 */
const FORBIDDEN_MATERIAL_KEYS = new Set([
  'secret',
  'secrets',
  'secretmaterial',
  'material',
  'password',
  'token',
  'apikey',
  'accesskey',
  'secretaccesskey',
  'secretvalue',
  'credentialmaterial',
  'privatekey',
  'sessiontoken',
]);

/** True when any object key at ANY nesting level is material-shaped. */
export function containsMaterialKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((element) => containsMaterialKey(element));
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_MATERIAL_KEYS.has(key.toLowerCase())) return true;
      if (containsMaterialKey(child)) return true;
    }
  }
  return false;
}

/** Classes whose frozen definitions require a declared method in content. */
const METHOD_REQUIRED_CLASSES: ReadonlySet<string> = new Set(['attribution', 'causal_estimate']);

/**
 * Pure append guard at the authority boundary: the module never persists
 * evidence that violates the frozen class/quality/content shapes, whatever
 * the caller did upstream. Mirrors the DB CHECKs and adds the per-class
 * method requirement the jsonb CHECK cannot express.
 */
export function assertValidEvidenceAppend(input: EvidenceAppendInput): void {
  const problems: string[] = [];

  if (!isKnownEvidenceClass(input.class)) {
    problems.push(`class '${input.class}' must be one of the frozen evidence classes`);
  } else if (METHOD_REQUIRED_CLASSES.has(input.class)) {
    // Frozen scientific separation: attribution is "assignment of credit
    // under a declared attribution method"; causal_estimate is "estimated
    // effect under an appropriate experimental/quasi-experimental design".
    const method = input.content['method'];
    if (typeof method !== 'string' || method.trim() === '') {
      problems.push(
        `content.method: a declared method is required for the '${input.class}' evidence class`,
      );
    }
  }

  if (!isKnownEvidenceQuality(input.quality)) {
    problems.push(`quality '${input.quality}' must be one of the frozen A..F grades`);
  }

  if (typeof input.source.system !== 'string' || input.source.system.trim() === '') {
    problems.push('source.system: a non-empty source system is required');
  } else if (input.source.system.length > 100) {
    problems.push('source.system: must be at most 100 characters');
  }
  if (input.source.ref !== null && (input.source.ref.length < 1 || input.source.ref.length > 512)) {
    problems.push('source.ref: must be between 1 and 512 characters when present');
  }

  if (typeof input.observedAt !== 'string' || Number.isNaN(Date.parse(input.observedAt))) {
    problems.push('observedAt: must be a real ISO 8601 timestamp');
  }

  if (
    input.content === null ||
    typeof input.content !== 'object' ||
    Array.isArray(input.content)
  ) {
    problems.push('content: must be a JSON object');
  } else if (Object.keys(input.content).length === 0) {
    problems.push('content: must not be empty — evidence carries traceable content');
  } else if (containsMaterialKey(input.content)) {
    problems.push('content: material-shaped keys can never appear in evidence payloads (implementation-contract §21)');
  }

  if (input.contentRef !== null && (input.contentRef.length < 1 || input.contentRef.length > 512)) {
    problems.push('contentRef: must be between 1 and 512 characters when present');
  }

  if (input.confidence !== null) {
    if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) {
      problems.push('confidence: must be a finite number when present');
    } else if (input.confidence < 0 || input.confidence > 1) {
      problems.push('confidence: must be between 0 and 1');
    }
  }

  if (input.supersedesEvidenceId !== null && input.supersedesEvidenceId.trim() === '') {
    problems.push('supersedesEvidenceId: must be a non-empty identifier when present');
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('evidence append rejected by the append guard', problems);
  }
}

/**
 * Provenance is server-derived and must be COMPLETE before any insert:
 * an incomplete provenance fails closed (the row's authority columns are
 * never defaulted from caller input).
 */
export function assertValidEvidenceProvenance(provenance: EvidenceProvenance): void {
  const problems: string[] = [];
  if (provenance.actor.trim() === '') {
    problems.push('provenance.actor: a non-empty server-derived principal label is required');
  }
  if (provenance.recordedVia.trim() === '' || provenance.recordedVia.length > 100) {
    problems.push('provenance.recordedVia: a non-empty server-derived system label is required');
  }
  if (provenance.correlationId.trim() === '') {
    problems.push('provenance.correlationId: evidence records are correlation-linked');
  }
  if (provenance.causationId !== null && provenance.causationId.trim() === '') {
    problems.push('provenance.causationId: must be a non-empty identifier when present');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      'evidence append rejected: provenance is server-derived and must be complete',
      problems,
    );
  }
}

/** The unique-constraint name this store classifies into a domain conflict. */
export const EVIDENCE_SUPERSESSION_FENCE = 'evidence_supersession_fence';

/**
 * Classifies a postgres unique-violation on the evidence INSERT into the
 * supersession race (a concurrent correction won the fence). Anything else
 * propagates untouched.
 */
export function classifyEvidenceInsertConflict(error: unknown): 'supersession-fence' | null {
  const candidate = error as { code?: string; constraint?: string };
  if (candidate?.code !== '23505') return null;
  if (candidate.constraint === EVIDENCE_SUPERSESSION_FENCE) return 'supersession-fence';
  return null;
}

export interface EvidenceInsertRow {
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly class: EvidenceClass;
  readonly sourceSystem: string;
  readonly sourceRef: string | null;
  readonly observedAt: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentRef: string | null;
  readonly quality: EvidenceQualityGrade;
  readonly confidence: number | null;
  readonly supersedesEvidenceId: string | null;
}

export class EvidenceStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Appends one immutable record. The DB triggers are the final backstops
   * (append-only, supersession legality, workspace-within-client); the
   * partial unique fence turns a supersession race into a 23505 the caller
   * classifies into a ConflictError.
   */
  async insertEvidence(
    row: EvidenceInsertRow,
    provenance: EvidenceProvenance,
  ): Promise<EvidenceRecord> {
    const evidenceId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO evidence (evidence_id, client_id, workspace_id, class, source_system,
                             source_ref, observed_at, content, content_ref, quality, confidence,
                             supersedes_evidence_id, recorded_actor, recorded_via, correlation_id,
                             causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        evidenceId,
        row.clientId,
        row.workspaceId,
        row.class,
        row.sourceSystem,
        row.sourceRef,
        row.observedAt,
        JSON.stringify(row.content),
        row.contentRef,
        row.quality,
        row.confidence,
        row.supersedesEvidenceId,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        recordedAt,
      ],
    );
    const created = await this.getEvidence(evidenceId);
    if (created === null) {
      throw new Error(`appended evidence ${evidenceId} could not be read back`);
    }
    return created;
  }

  async getEvidence(evidenceId: string): Promise<EvidenceRecord | null> {
    const result = await this.db.query<EvidenceRow>(`${EVIDENCE_SELECT} WHERE e.evidence_id = $1`, [
      evidenceId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toEvidenceRecord(row);
  }

  /**
   * The Client's records, newest first by server-recorded time (bounded —
   * the append-only ledger grows without end; superseded records are
   * included: immutable history stays readable).
   */
  async listEvidenceForClient(
    clientId: string,
    limit = 500,
  ): Promise<readonly EvidenceRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<EvidenceRow>(
      `${EVIDENCE_SELECT} WHERE e.client_id = $1
       ORDER BY e.recorded_at DESC, e.evidence_id LIMIT $2`,
      [clientId, bounded],
    );
    return result.rows.map(toEvidenceRecord);
  }
}

function toEvidenceRecord(row: EvidenceRow): EvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    class: row.class as EvidenceClass,
    source: {
      system: row.source_system,
      ref: row.source_ref,
    },
    observedAt: row.observed_at.toISOString(),
    content: (row.content ?? {}) as Record<string, unknown>,
    contentRef: row.content_ref,
    quality: row.quality as EvidenceQualityGrade,
    confidence: row.confidence === null ? null : Number(row.confidence),
    supersedes: row.supersedes_evidence_id,
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
