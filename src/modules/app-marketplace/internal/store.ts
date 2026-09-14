/**
 * /app-marketplace module store (MKT-050 — the trust-events and
 * app-reviews ledgers, the 038 house style).
 *
 * Pure guards + §8-style create fingerprints + the SQL store over the
 * migration-042 tables. The ledgers are APPEND-ONLY: the database
 * triggers reject UPDATE and DELETE outright, and every insert is
 * fenced by the §8 idempotency key (one logical command, globally) and
 * — for trust transitions — the per-lineage gapless transition sequence
 * (the chain-consistency trigger re-fences the from_state against the
 * predecessor's to_state).
 */

import { createHash } from 'node:crypto';
import {
  ConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
} from '../../../platform/errors/errors.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { AppCertificationState } from '../../apps/public.ts';
import type {
  AppReviewRecord,
  AppReviewVerdict,
  TrustEventRecord,
  TrustTransition,
} from '../public.ts';
import {
  APP_REVIEW_RATING_MAX,
  APP_REVIEW_RATING_MIN,
  APP_REVIEW_VERDICTS,
  MARKETPLACE_PUBLISHER_KINDS,
  TRUST_TRANSITIONS,
} from '../public.ts';

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_PROVENANCE_LABEL_LENGTH = 100;
const MAX_TRANSITION_REASON_LENGTH = 512;
const MAX_REVIEW_BODY_LENGTH = 2000;
const MAX_FILTER_LENGTH = 64;
const REVIEW_LISTING_LIMIT = 200;

/**
 * Material-shaped keys that can never appear in any marketplace payload
 * (the §21 secret-leak backstop at the module boundary — the migration
 * CHECK columns enforce the identical posture at the storage layer).
 */
export const MARKETPLACE_MATERIAL_SHAPED_KEYS = [
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

// ---------------------------------------------------------------------------
// Input guards (pure — the single semantic enforcement points)
// ---------------------------------------------------------------------------

/**
 * Validates the transition command input (the frozen shapes behind the
 * route DTO): app key, closed transition label, bounded reason and the
 * §8 idempotency key. Pure.
 */
export function assertValidTransitionInput(input: {
  readonly appKey?: unknown;
  readonly transition?: unknown;
  readonly reason?: unknown;
  readonly idempotencyKey?: unknown;
}): void {
  if (typeof input.appKey !== 'string' || !KEY_PATTERN.test(input.appKey)) {
    throw new InvalidRequestError(
      'appKey: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter',
    );
  }
  if (
    typeof input.transition !== 'string' ||
    !(TRUST_TRANSITIONS as readonly string[]).includes(input.transition)
  ) {
    throw new InvalidRequestError(
      `transition: must be one of the closed vocabulary (${TRUST_TRANSITIONS.join(', ')})`,
    );
  }
  if (
    typeof input.reason !== 'string' ||
    input.reason.length < 1 ||
    input.reason.length > MAX_TRANSITION_REASON_LENGTH
  ) {
    throw new InvalidRequestError(
      `reason: must be 1-${MAX_TRANSITION_REASON_LENGTH} characters (the permanent governance record)`,
    );
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new InvalidRequestError(
      `idempotencyKey: must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
}

/**
 * Validates the review command input: app key, optional exact-version
 * target (uuid), the closed rating band + verdict vocabulary, the
 * bounded body and the §8 idempotency key. Pure.
 */
export function assertValidReviewInput(input: {
  readonly appKey?: unknown;
  readonly appVersionId?: unknown;
  readonly rating?: unknown;
  readonly verdict?: unknown;
  readonly body?: unknown;
  readonly idempotencyKey?: unknown;
}): void {
  if (typeof input.appKey !== 'string' || !KEY_PATTERN.test(input.appKey)) {
    throw new InvalidRequestError(
      'appKey: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter',
    );
  }
  if (
    input.appVersionId !== null &&
    input.appVersionId !== undefined &&
    (typeof input.appVersionId !== 'string' || !UUID_PATTERN.test(input.appVersionId))
  ) {
    throw new InvalidRequestError(
      'appVersionId: must be a registry app version id or null (an app-level review)',
    );
  }
  if (
    typeof input.rating !== 'number' ||
    !Number.isInteger(input.rating) ||
    input.rating < APP_REVIEW_RATING_MIN ||
    input.rating > APP_REVIEW_RATING_MAX
  ) {
    throw new InvalidRequestError(
      `rating: must be an integer in [${APP_REVIEW_RATING_MIN}..${APP_REVIEW_RATING_MAX}]`,
    );
  }
  if (
    typeof input.verdict !== 'string' ||
    !(APP_REVIEW_VERDICTS as readonly string[]).includes(input.verdict)
  ) {
    throw new InvalidRequestError(
      `verdict: must be one of the closed vocabulary (${APP_REVIEW_VERDICTS.join(', ')})`,
    );
  }
  if (
    typeof input.body !== 'string' ||
    input.body.length < 1 ||
    input.body.length > MAX_REVIEW_BODY_LENGTH
  ) {
    throw new InvalidRequestError(
      `body: must be 1-${MAX_REVIEW_BODY_LENGTH} characters (display metadata, never a policy input)`,
    );
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new InvalidRequestError(
      `idempotencyKey: must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
}

/**
 * Validates the SERVER-DERIVED provenance block (the /deployments
 * assertValidProvenance precedent — the block arrives as a separate
 * module-API argument so no DTO can feed it structurally). Pure.
 */
export function assertValidMarketplaceProvenance(provenance: {
  readonly actor?: unknown;
  readonly recordedVia?: unknown;
  readonly correlationId?: unknown;
  readonly causationId?: unknown;
}): void {
  const label = (field: string, value: unknown): void => {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > MAX_PROVENANCE_LABEL_LENGTH
    ) {
      throw new InvalidRequestError(
        `${field}: must be 1-${MAX_PROVENANCE_LABEL_LENGTH} characters`,
      );
    }
  };
  label('provenance.actor', provenance.actor);
  label('provenance.recordedVia', provenance.recordedVia);
  label('provenance.correlationId', provenance.correlationId);
  if (
    provenance.causationId !== null &&
    provenance.causationId !== undefined &&
    (typeof provenance.causationId !== 'string' ||
      provenance.causationId.length < 1 ||
      provenance.causationId.length > MAX_PROVENANCE_LABEL_LENGTH)
  ) {
    throw new InvalidRequestError(
      `provenance.causationId: must be null or 1-${MAX_PROVENANCE_LABEL_LENGTH} characters`,
    );
  }
}

/**
 * Validates the listing filters (the module-side re-fence behind the
 * route query-parameter hygiene): bounded category/search and the
 * closed trust-level/publisher-kind vocabularies. Pure.
 */
export function assertValidMarketplaceFilters(filters: {
  readonly category?: unknown;
  readonly trustLevel?: unknown;
  readonly publisherKind?: unknown;
  readonly search?: unknown;
}): void {
  const bounded = (field: string, value: unknown): void => {
    if (
      value !== null &&
      value !== undefined &&
      (typeof value !== 'string' || value.length < 1 || value.length > MAX_FILTER_LENGTH)
    ) {
      throw new InvalidRequestError(
        `${field}: must be null or 1-${MAX_FILTER_LENGTH} characters`,
      );
    }
  };
  bounded('category', filters.category);
  bounded('search', filters.search);
  if (
    filters.trustLevel !== null &&
    filters.trustLevel !== undefined &&
    (typeof filters.trustLevel !== 'string' ||
      !['UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED'].includes(filters.trustLevel))
  ) {
    throw new InvalidRequestError(
      'trustLevel: must be null or one of the frozen trust vocabulary (UNVERIFIED, COMMUNITY_VERIFIED, MOS_CERTIFIED)',
    );
  }
  if (
    filters.publisherKind !== null &&
    filters.publisherKind !== undefined &&
    (typeof filters.publisherKind !== 'string' ||
      !(MARKETPLACE_PUBLISHER_KINDS as readonly string[]).includes(filters.publisherKind))
  ) {
    throw new InvalidRequestError(
      `publisherKind: must be null or one of the closed vocabulary (${MARKETPLACE_PUBLISHER_KINDS.join(', ')})`,
    );
  }
}

// ---------------------------------------------------------------------------
// The §8-style create fingerprints (deterministic canonical digests)
// ---------------------------------------------------------------------------

/**
 * The §8-style fingerprint of one logical trust-transition command: a
 * deterministic digest of the CANONICAL command content (app key,
 * transition, reason) — one idempotency key identifies one transition
 * intent; a key reused for different content is a conflict. Pure.
 */
export function trustEventCreateFingerprint(content: {
  readonly appKey: string;
  readonly transition: string;
  readonly reason: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        appKey: content.appKey,
        transition: content.transition,
        reason: content.reason,
      }),
    )
    .update('|mkt-050-trust-transition')
    .digest('hex');
}

/**
 * The §8-style fingerprint of one logical review command: a
 * deterministic digest of the CANONICAL command content (app key,
 * optional version target, rating, verdict, body). Pure.
 */
export function appReviewCreateFingerprint(content: {
  readonly appKey: string;
  readonly appVersionId: string | null;
  readonly rating: number;
  readonly verdict: string;
  readonly body: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        appKey: content.appKey,
        appVersionId: content.appVersionId,
        rating: content.rating,
        verdict: content.verdict,
        body: content.body,
      }),
    )
    .update('|mkt-050-app-review')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Write-conflict classification (the /apps classifyAppsWriteConflict
// precedent — deterministic upstream errors from the DB's own fences)
// ---------------------------------------------------------------------------

/**
 * Classifies a postgres error on marketplace writes into the domain
 * conflict it represents (§8 idempotency fence vs transition-sequence
 * fence vs chain/validation backstop). Anything else propagates
 * untouched.
 */
export function classifyMarketplaceWriteConflict(
  error: unknown,
): 'idempotency-fence' | 'seq-fence' | 'validation-backstop' | null {
  const candidate = error as { code?: string; constraint?: string; message?: string };
  if (candidate?.code === '23505') {
    if (
      candidate.constraint === 'trust_events_idempotency_key_unique' ||
      candidate.constraint === 'app_reviews_idempotency_key_unique'
    ) {
      return 'idempotency-fence';
    }
    // The per-lineage gapless transition sequence fence (a concurrent
    // transition of the same lineage converged first).
    if (candidate.constraint === 'trust_events_seq_unique') return 'seq-fence';
    return 'idempotency-fence';
  }
  if (candidate?.code === '23514' || candidate?.code === 'P0001') return 'validation-backstop';
  return null;
}

// ---------------------------------------------------------------------------
// Row shapes + serialization
// ---------------------------------------------------------------------------

interface TrustEventRow extends DbRow {
  readonly event_id: string;
  readonly app_key: string;
  readonly transition_seq: number;
  readonly transition: string;
  readonly from_state: string;
  readonly to_state: string;
  readonly reason: string;
  readonly recorded_actor: string;
  readonly recorded_via: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly recorded_at: Date;
  readonly idempotency_key: string;
  readonly create_fingerprint: string;
}

interface AppReviewRow extends DbRow {
  readonly review_id: string;
  readonly app_key: string;
  readonly app_version_id: string | null;
  readonly rating: number;
  readonly verdict: string;
  readonly body: string;
  readonly recorded_actor: string;
  readonly recorded_via: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly recorded_at: Date;
  readonly idempotency_key: string;
  readonly create_fingerprint: string;
}

const TRUST_EVENT_SELECT = `
  SELECT event_id, app_key, transition_seq, transition, from_state, to_state,
         reason, recorded_actor, recorded_via, correlation_id, causation_id,
         recorded_at, idempotency_key, create_fingerprint
  FROM trust_events
`;

const APP_REVIEW_SELECT = `
  SELECT review_id, app_key, app_version_id, rating, verdict, body,
         recorded_actor, recorded_via, correlation_id, causation_id,
         recorded_at, idempotency_key, create_fingerprint
  FROM app_reviews
`;

function toTrustEventRecord(row: TrustEventRow): TrustEventRecord {
  return {
    eventId: row.event_id,
    appKey: row.app_key,
    transitionSeq: Number(row.transition_seq),
    transition: row.transition as TrustTransition,
    fromState: row.from_state as AppCertificationState,
    toState: row.to_state as AppCertificationState,
    reason: row.reason,
    recordedActor: row.recorded_actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: row.recorded_at.toISOString(),
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
  };
}

function toAppReviewRecord(row: AppReviewRow): AppReviewRecord {
  return {
    reviewId: row.review_id,
    appKey: row.app_key,
    appVersionId: row.app_version_id,
    rating: Number(row.rating),
    verdict: row.verdict as AppReviewVerdict,
    body: row.body,
    recordedActor: row.recorded_actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: row.recorded_at.toISOString(),
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class AppMarketplaceStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /** The recorded event for a §8 idempotency key (null when absent). */
  async findTrustEventByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<TrustEventRecord | null> {
    const result = await this.db.query<TrustEventRow>(
      `${TRUST_EVENT_SELECT} WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTrustEventRecord(row);
  }

  /** The recorded review for a §8 idempotency key (null when absent). */
  async findReviewByIdempotencyKey(idempotencyKey: string): Promise<AppReviewRecord | null> {
    const result = await this.db.query<AppReviewRow>(
      `${APP_REVIEW_SELECT} WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAppReviewRecord(row);
  }

  /** The append-only trust transition tail of one lineage (oldest first). */
  async listTrustEvents(appKey: string): Promise<readonly TrustEventRecord[]> {
    const result = await this.db.query<TrustEventRow>(
      `${TRUST_EVENT_SELECT} WHERE app_key = $1 ORDER BY transition_seq ASC`,
      [appKey],
    );
    return result.rows.map(toTrustEventRecord);
  }

  /** The append-only review tail of one lineage (newest first, bounded). */
  async listAppReviews(appKey: string): Promise<readonly AppReviewRecord[]> {
    const result = await this.db.query<AppReviewRow>(
      `${APP_REVIEW_SELECT} WHERE app_key = $1
       ORDER BY recorded_at DESC, review_id LIMIT ${REVIEW_LISTING_LIMIT}`,
      [appKey],
    );
    return result.rows.map(toAppReviewRecord);
  }

  /**
   * Appends ONE trust transition event — ONE ATOMIC TRANSACTION:
   *   1. the next per-lineage transition sequence is claimed
   *      (MAX(transition_seq) + 1 — concurrent writers of the same next
   *      seq converge to exactly one winner through the UNIQUE fence);
   *   2. the event row is inserted (ON CONFLICT (idempotency_key) DO
   *      NOTHING — 'taken' means the logical command already converged);
   *   3. the migration-042 chain-consistency trigger re-fences the
   *      from_state against the predecessor's to_state (and the first
   *      event against the UNVERIFIED birth state).
   */
  async insertTrustEvent(row: {
    readonly appKey: string;
    readonly fromState: AppCertificationState;
    readonly toState: AppCertificationState;
    readonly transition: TrustTransition;
    readonly reason: string;
    readonly recordedActor: string;
    readonly recordedVia: string;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly idempotencyKey: string;
    readonly createFingerprint: string;
  }): Promise<TrustEventRecord | 'taken'> {
    const eventId = this.ids.newId();
    const now = this.clock.nowIso();
    try {
      const outcome = await this.db.transaction(async (tx) => {
        const next = await tx.query<{ next_seq: number }>(
          'SELECT COALESCE(MAX(transition_seq), 0) + 1 AS next_seq FROM trust_events WHERE app_key = $1',
          [row.appKey],
        );
        const transitionSeq = Number(next.rows[0]?.next_seq ?? 1);
        const inserted = await tx.query(
          `INSERT INTO trust_events
             (event_id, app_key, transition_seq, transition, from_state, to_state,
              reason, recorded_actor, recorded_via, correlation_id, causation_id,
              recorded_at, idempotency_key, create_fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            eventId,
            row.appKey,
            transitionSeq,
            row.transition,
            row.fromState,
            row.toState,
            row.reason,
            row.recordedActor,
            row.recordedVia,
            row.correlationId,
            row.causationId,
            now,
            row.idempotencyKey,
            row.createFingerprint,
          ],
        );
        if (inserted.rowCount !== 1) {
          return 'taken' as const;
        }
        return 'inserted' as const;
      });
      if (outcome !== 'inserted') return 'taken';
    } catch (error) {
      // The migration-042 fences re-fence every write: classify the
      // database's own rejection into the typed errors (the §8
      // idempotency race, the transition-sequence race and the
      // chain-consistency/validation backstops).
      const conflict = classifyMarketplaceWriteConflict(error);
      if (conflict === 'idempotency-fence') {
        return 'taken';
      }
      if (conflict === 'seq-fence') {
        throw new ConflictError(
          `a concurrent trust transition of app '${row.appKey}' was recorded first (the append-only tail moved — retry against the new current state)`,
        );
      }
      if (conflict === 'validation-backstop') {
        throw new InvalidRequestError(
          `trust transition of app '${row.appKey}' was rejected by the marketplace validation backstop: ${(error as { message?: string }).message ?? 'constraint violation'}`,
        );
      }
      throw error;
    }
    const created = await this.findTrustEventByIdempotencyKey(row.idempotencyKey);
    if (created === null) {
      throw new Error(
        `recorded trust event under key '${row.idempotencyKey}' could not be read back`,
      );
    }
    return created;
  }

  /**
   * Appends ONE review record (ON CONFLICT (idempotency_key) DO NOTHING —
   * 'taken' means the logical command already converged; the
   * migration-042 version-consistency trigger re-fences a version-level
   * target against the SAME app key).
   */
  async insertAppReview(row: {
    readonly appKey: string;
    readonly appVersionId: string | null;
    readonly rating: number;
    readonly verdict: AppReviewVerdict;
    readonly body: string;
    readonly recordedActor: string;
    readonly recordedVia: string;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly idempotencyKey: string;
    readonly createFingerprint: string;
  }): Promise<AppReviewRecord | 'taken'> {
    const reviewId = this.ids.newId();
    const now = this.clock.nowIso();
    try {
      const inserted = await this.db.query(
        `INSERT INTO app_reviews
           (review_id, app_key, app_version_id, rating, verdict, body,
            recorded_actor, recorded_via, correlation_id, causation_id,
            recorded_at, idempotency_key, create_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          reviewId,
          row.appKey,
          row.appVersionId,
          row.rating,
          row.verdict,
          row.body,
          row.recordedActor,
          row.recordedVia,
          row.correlationId,
          row.causationId,
          now,
          row.idempotencyKey,
          row.createFingerprint,
        ],
      );
      if (inserted.rowCount !== 1) {
        return 'taken';
      }
    } catch (error) {
      const conflict = classifyMarketplaceWriteConflict(error);
      if (conflict === 'idempotency-fence') {
        return 'taken';
      }
      if (conflict === 'validation-backstop') {
        throw new InvalidRequestError(
          `review of app '${row.appKey}' was rejected by the marketplace validation backstop: ${(error as { message?: string }).message ?? 'constraint violation'}`,
        );
      }
      throw error;
    }
    const created = await this.findReviewByIdempotencyKey(row.idempotencyKey);
    if (created === null) {
      throw new Error(
        `recorded app review under key '${row.idempotencyKey}' could not be read back`,
      );
    }
    return created;
  }
}

// ---------------------------------------------------------------------------
// The §8 replay convergence (the module-side helper — the /app-installs
// replayOrConflict precedent)
// ---------------------------------------------------------------------------

/**
 * The §8 replay convergence for a recorded idempotency key: an identical
 * fingerprint converges to the recorded record (replayed: true, zero
 * state change); a divergent reuse of the key is an
 * IdempotencyConflictError.
 */
export function replayOrConflict<T extends { readonly createFingerprint: string }>(
  idempotencyKey: string,
  recorded: T | null,
  fingerprint: string,
): { readonly replayed: true; readonly record: T } | { readonly replayed: false } {
  if (recorded === null) return { replayed: false };
  if (recorded.createFingerprint !== fingerprint) {
    throw new IdempotencyConflictError(idempotencyKey);
  }
  return { replayed: true, record: recorded };
}
