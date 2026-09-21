/**
 * MKT-056 — the /social-accounts publish-ledger persistence (the
 * migration-050 tables: social_publish_attempts +
 * social_publish_status_observations).
 *
 * DB backstops (migration 050):
 *   - the IDEMPOTENCY FENCE: at most ONE attempt row per
 *     (social_account_id, idempotency_key) — the unique index makes the
 *     at-most-once submit semantics race-free (a concurrent loser
 *     converges on the constraint and is answered from the winner's row);
 *   - the attempts are CLAIM-THEN-FILL: the born row is the 'submitted'
 *     claim (the honest UNKNOWN in-flight state — an interrupted submit
 *     stays 'submitted' and is NEVER blindly replayed under the same
 *     key); the single completion fill moves 'submitted' → exactly one of
 *     accepted/published/failed/restricted and is the ONLY sanctioned
 *     UPDATE (the trigger fence rejects every other UPDATE and every
 *     DELETE);
 *   - the status observations are FULLY append-only (UPDATE/DELETE
 *     rejected outright): one immutable row per provider status poll —
 *     the provider-state history; the attempt row keeps the SUBMIT-TIME
 *     fact, the observations carry the later provider answers;
 *   - the outcome vocabularies are CHECK-fenced: publish_state ∈
 *     {submitted, accepted, published, failed, restricted} and
 *     failure_code ∈ the closed taxonomy — adding a value is a schema
 *     change, never a runtime value;
 *   - the tenant/chain columns are server-derived and backstopped by the
 *     account/connection consistency triggers (a crossed chain is
 *     rejected even if every application check were bypassed);
 *   - NO material-shaped key may enter any jsonb column (the §21
 *     migration-029 reusable CHECK functions).
 *
 * The tables have NO column capable of carrying secret material; the
 * publish request/attribution/passthrough objects are bounded and
 * §21-guarded before any write (adapter-contract.ts).
 */

import { NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  SocialAdapterFailureCode,
  SocialOperationFailure,
  SocialPublishRequest,
  SocialPublishState,
  SocialPublishStatus,
  SocialPublishSubmission,
  SocialRateLimitObservation,
  SocialRestrictionSignal,
} from './adapter-contract.ts';
import type { SocialAccountProvenance } from '../public.ts';

interface SocialPublishAttemptRow extends DbRow {
  attempt_id: string;
  social_account_id: string;
  integration_connection_id: string;
  agency_id: string;
  client_id: string;
  platform_id: string;
  idempotency_key: string;
  content_type: string;
  publish_request: unknown;
  publish_state: string;
  failure_code: string | null;
  provider_publish_id: string | null;
  provider_content_id: string | null;
  published_at: Date | null;
  provider_failure_reason: string | null;
  restriction_signals: unknown;
  provider_data: unknown;
  rate_limit_remaining: number | null;
  rate_limit_reset_at: Date | null;
  backoff_until: Date | null;
  retry_after_seconds: number | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface SocialPublishObservationRow extends DbRow {
  observation_id: string;
  attempt_id: string;
  social_account_id: string;
  client_id: string;
  publish_state: string;
  failure_code: string | null;
  provider_publish_id: string | null;
  provider_content_id: string | null;
  published_at: Date | null;
  provider_failure_reason: string | null;
  restriction_signals: unknown;
  provider_data: unknown;
  rate_limit_remaining: number | null;
  rate_limit_reset_at: Date | null;
  backoff_until: Date | null;
  retry_after_seconds: number | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  observed_at: Date;
}

/** The durable publish-attempt record (the migration-050 shape). */
export interface SocialPublishAttemptRecord {
  readonly attemptId: string;
  readonly socialAccountId: string;
  readonly integrationConnectionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly platformId: string;
  readonly idempotencyKey: string;
  readonly contentType: string;
  readonly publishRequest: Readonly<Record<string, unknown>>;
  readonly publishState: SocialPublishState;
  readonly failureCode: SocialAdapterFailureCode | null;
  readonly providerPublishId: string | null;
  readonly providerContentId: string | null;
  readonly publishedAt: string | null;
  readonly providerFailureReason: string | null;
  readonly restrictionSignals: readonly SocialRestrictionSignal[];
  readonly providerData: Readonly<Record<string, unknown>> | null;
  readonly rateLimit: SocialRateLimitObservation | null;
  readonly provenance: SocialAccountProvenance & { readonly recordedAt: string };
}

/** One immutable provider status-poll observation of an attempt. */
export interface SocialPublishStatusObservationRecord {
  readonly observationId: string;
  readonly attemptId: string;
  readonly socialAccountId: string;
  readonly clientId: string;
  readonly publishState: Exclude<SocialPublishState, 'submitted'>;
  readonly failureCode: SocialAdapterFailureCode | null;
  readonly providerPublishId: string | null;
  readonly providerContentId: string | null;
  readonly publishedAt: string | null;
  readonly providerFailureReason: string | null;
  readonly restrictionSignals: readonly SocialRestrictionSignal[];
  readonly providerData: Readonly<Record<string, unknown>> | null;
  readonly rateLimit: SocialRateLimitObservation | null;
  readonly provenance: SocialAccountProvenance & { readonly recordedAt: string };
}

const ATTEMPT_SELECT = `
  SELECT attempt_id, social_account_id, integration_connection_id, agency_id, client_id,
         platform_id, idempotency_key, content_type, publish_request, publish_state,
         failure_code, provider_publish_id, provider_content_id, published_at,
         provider_failure_reason, restriction_signals, provider_data,
         rate_limit_remaining, rate_limit_reset_at, backoff_until, retry_after_seconds,
         recorded_actor, recorded_via, correlation_id, causation_id, created_at
  FROM social_publish_attempts
`;

const OBSERVATION_SELECT = `
  SELECT observation_id, attempt_id, social_account_id, client_id, publish_state,
         failure_code, provider_publish_id, provider_content_id, published_at,
         provider_failure_reason, restriction_signals, provider_data,
         rate_limit_remaining, rate_limit_reset_at, backoff_until, retry_after_seconds,
         recorded_actor, recorded_via, correlation_id, causation_id, observed_at
  FROM social_publish_status_observations
`;

function isoOf(value: Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function restrictionSignalsOf(raw: unknown): readonly SocialRestrictionSignal[] {
  return Array.isArray(raw) ? (raw as SocialRestrictionSignal[]) : [];
}

function rateLimitOf(row: {
  rate_limit_remaining: number | null;
  rate_limit_reset_at: Date | null;
  backoff_until: Date | null;
  retry_after_seconds: number | null;
}): SocialRateLimitObservation | null {
  if (
    row.rate_limit_remaining === null &&
    row.rate_limit_reset_at === null &&
    row.backoff_until === null &&
    row.retry_after_seconds === null
  ) {
    return null;
  }
  return {
    limitRemaining: row.rate_limit_remaining,
    limitResetAt: isoOf(row.rate_limit_reset_at),
    backoffUntil: isoOf(row.backoff_until),
    retryAfterSeconds: row.retry_after_seconds,
  };
}

function attemptOf(row: SocialPublishAttemptRow): SocialPublishAttemptRecord {
  return {
    attemptId: row.attempt_id,
    socialAccountId: row.social_account_id,
    integrationConnectionId: row.integration_connection_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    platformId: row.platform_id,
    idempotencyKey: row.idempotency_key,
    contentType: row.content_type,
    publishRequest: (row.publish_request ?? {}) as Record<string, unknown>,
    publishState: row.publish_state as SocialPublishState,
    failureCode: row.failure_code as SocialAdapterFailureCode | null,
    providerPublishId: row.provider_publish_id,
    providerContentId: row.provider_content_id,
    publishedAt: isoOf(row.published_at),
    providerFailureReason: row.provider_failure_reason,
    restrictionSignals: restrictionSignalsOf(row.restriction_signals),
    providerData:
      row.provider_data === null || row.provider_data === undefined
        ? null
        : (row.provider_data as Record<string, unknown>),
    rateLimit: rateLimitOf(row),
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: isoOf(row.created_at)!,
    },
  };
}

function observationOf(row: SocialPublishObservationRow): SocialPublishStatusObservationRecord {
  return {
    observationId: row.observation_id,
    attemptId: row.attempt_id,
    socialAccountId: row.social_account_id,
    clientId: row.client_id,
    publishState: row.publish_state as Exclude<SocialPublishState, 'submitted'>,
    failureCode: row.failure_code as SocialAdapterFailureCode | null,
    providerPublishId: row.provider_publish_id,
    providerContentId: row.provider_content_id,
    publishedAt: isoOf(row.published_at),
    providerFailureReason: row.provider_failure_reason,
    restrictionSignals: restrictionSignalsOf(row.restriction_signals),
    providerData:
      row.provider_data === null || row.provider_data === undefined
        ? null
        : (row.provider_data as Record<string, unknown>),
    rateLimit: rateLimitOf(row),
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: isoOf(row.observed_at)!,
    },
  };
}

/** The publish-ledger store (the SocialAccountsStore pattern). */
export class SocialAdapterPublishStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Appends the born 'submitted' CLAIM of one publish attempt. The
   * migration-050 idempotency fence backs the at-most-once semantics: a
   * concurrent duplicate converges on the unique index and is returned
   * as {claimed: false, existing} — the caller answers the replay from
   * the winner's row (NEVER a second provider call).
   */
  async insertAttemptClaim(
    runner: DbTransaction,
    input: {
      readonly socialAccountId: string;
      readonly integrationConnectionId: string;
      readonly agencyId: string;
      readonly clientId: string;
      readonly platformId: string;
      readonly idempotencyKey: string;
      readonly contentType: string;
      readonly publishRequest: SocialPublishRequest;
    },
    provenance: SocialAccountProvenance,
  ): Promise<
    | { readonly claimed: true; readonly attempt: SocialPublishAttemptRecord }
    | { readonly claimed: false; readonly existing: SocialPublishAttemptRecord }
  > {
    const attemptId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    try {
      await runner.query(
        `INSERT INTO social_publish_attempts
           (attempt_id, social_account_id, integration_connection_id, agency_id, client_id,
            platform_id, idempotency_key, content_type, publish_request, publish_state,
            failure_code, provider_publish_id, provider_content_id, published_at,
            provider_failure_reason, restriction_signals, provider_data,
            rate_limit_remaining, rate_limit_reset_at, backoff_until, retry_after_seconds,
            recorded_actor, recorded_via, correlation_id, causation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'submitted',
                NULL, NULL, NULL, NULL, NULL, '[]'::jsonb, NULL,
                NULL, NULL, NULL, NULL,
                $10, $11, $12, $13, $14)`,
        [
          attemptId,
          input.socialAccountId,
          input.integrationConnectionId,
          input.agencyId,
          input.clientId,
          input.platformId,
          input.idempotencyKey,
          input.contentType,
          JSON.stringify({
            contentType: input.publishRequest.contentType,
            payload: input.publishRequest.payload,
            mediaAssets: input.publishRequest.mediaAssets,
            attribution: input.publishRequest.attribution,
            scheduledFor: input.publishRequest.scheduledFor,
          }),
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          now,
        ],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('social_publish_attempts_idempotency_fence')) {
        const existing = await this.getAttemptByIdempotencyKey(
          input.socialAccountId,
          input.idempotencyKey,
        );
        if (existing !== null) return { claimed: false, existing };
      }
      throw error;
    }
    const created = await this.attemptVia(runner, attemptId);
    if (created === null) {
      throw new Error(`inserted publish attempt ${attemptId} could not be read back`);
    }
    return { claimed: true, attempt: created };
  }

  /**
   * Appends a PRE-FLIGHT-REFUSED attempt directly in its terminal state
   * (failed + the taxonomy failure code): the request never reached the
   * provider (unsupported capability / insufficient scope / policy
   * denial / no usable authorization) and the fence still records the
   * key's outcome honestly. Same fence semantics as the claim.
   */
  async insertPreflightRefusal(
    input: {
      readonly socialAccountId: string;
      readonly integrationConnectionId: string;
      readonly agencyId: string;
      readonly clientId: string;
      readonly platformId: string;
      readonly idempotencyKey: string;
      readonly contentType: string;
      readonly publishRequest: SocialPublishRequest;
      readonly failureCode: SocialAdapterFailureCode;
      readonly failureMessage: string;
    },
    provenance: SocialAccountProvenance,
  ): Promise<SocialPublishAttemptRecord> {
    return this.db.transaction(async (tx) => {
      const claim = await this.insertAttemptClaim(
        tx,
        {
          socialAccountId: input.socialAccountId,
          integrationConnectionId: input.integrationConnectionId,
          agencyId: input.agencyId,
          clientId: input.clientId,
          platformId: input.platformId,
          idempotencyKey: input.idempotencyKey,
          contentType: input.contentType,
          publishRequest: input.publishRequest,
        },
        provenance,
      );
      if (!claim.claimed) return claim.existing;
      return this.fillAttempt(tx, claim.attempt.attemptId, {
        publishState: 'failed',
        failure: { code: input.failureCode, message: input.failureMessage, rateLimit: null },
        submission: null,
        rateLimit: null,
      });
    });
  }

  /**
   * THE SINGLE COMPLETION FILL: 'submitted' → exactly one of
   * accepted/published/failed/restricted (the migration-050 trigger
   * fence rejects every other transition and every later UPDATE). Only
   * the claim owner fills; a 0-row update means someone else already
   * filled — the current row is returned (fail-closed convergence).
   */
  async fillAttempt(
    runner: DbTransaction,
    attemptId: string,
    outcome: {
      readonly publishState: Exclude<SocialPublishState, 'submitted'>;
      readonly failure: SocialOperationFailure | null;
      readonly submission: SocialPublishSubmission | null;
      readonly rateLimit: SocialRateLimitObservation | null;
    },
  ): Promise<SocialPublishAttemptRecord> {
    const providerPublishId =
      outcome.publishState === 'failed' && outcome.submission === null
        ? null
        : outcome.submission?.providerPublishId ?? null;
    const providerContentId = outcome.submission?.providerContentId ?? null;
    const publishedAt =
      outcome.submission?.publishedAt === null || outcome.submission?.publishedAt === undefined
        ? null
        : new Date(outcome.submission.publishedAt);
    const providerFailureReason = outcome.submission?.providerFailureReason ?? null;
    const restrictionSignals =
      outcome.publishState === 'restricted'
        ? JSON.stringify(outcome.submission?.restrictionSignals ?? [])
        : '[]';
    const providerData =
      outcome.submission?.providerData === null || outcome.submission?.providerData === undefined
        ? null
        : JSON.stringify(outcome.submission.providerData);
    const failureCode = outcome.publishState === 'failed' ? outcome.failure?.code ?? null : null;

    const updated = await runner.query<SocialPublishAttemptRow>(
      `UPDATE social_publish_attempts SET
         publish_state = $2,
         failure_code = $3,
         provider_publish_id = $4,
         provider_content_id = $5,
         published_at = $6,
         provider_failure_reason = $7,
         restriction_signals = $8::jsonb,
         provider_data = $9::jsonb,
         rate_limit_remaining = $10,
         rate_limit_reset_at = $11,
         backoff_until = $12,
         retry_after_seconds = $13
       WHERE attempt_id = $1 AND publish_state = 'submitted'
       RETURNING *`,
      [
        attemptId,
        outcome.publishState,
        failureCode,
        providerPublishId,
        providerContentId,
        publishedAt,
        providerFailureReason,
        restrictionSignals,
        providerData,
        outcome.rateLimit?.limitRemaining ?? null,
        outcome.rateLimit?.limitResetAt === null || outcome.rateLimit?.limitResetAt === undefined
          ? null
          : new Date(outcome.rateLimit.limitResetAt),
        outcome.rateLimit?.backoffUntil === null || outcome.rateLimit?.backoffUntil === undefined
          ? null
          : new Date(outcome.rateLimit.backoffUntil),
        outcome.rateLimit?.retryAfterSeconds ?? null,
      ],
    );
    if (updated.rowCount === 0) {
      const current = await this.getAttempt(attemptId);
      if (current === null) throw new NotFoundError('social publish attempt', attemptId);
      return current;
    }
    return attemptOf(updated.rows[0]!);
  }

  /** Appends one immutable provider status-poll observation. */
  async insertStatusObservation(
    input: {
      readonly attempt: SocialPublishAttemptRecord;
      readonly status: SocialPublishStatus | null;
      readonly failure: SocialOperationFailure | null;
      readonly rateLimit: SocialRateLimitObservation | null;
    },
    provenance: SocialAccountProvenance,
  ): Promise<SocialPublishStatusObservationRecord> {
    const observationId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    // An ok:false poll records the LAST-KNOWN attempt state + the failure;
    // an ok:true poll records the provider's reported state.
    const state = input.status?.publishState ?? input.attempt.publishState;
    const failureCode = input.failure?.code ?? null;
    await this.db.query(
      `INSERT INTO social_publish_status_observations
         (observation_id, attempt_id, social_account_id, client_id, publish_state,
          failure_code, provider_publish_id, provider_content_id, published_at,
          provider_failure_reason, restriction_signals, provider_data,
          rate_limit_remaining, rate_limit_reset_at, backoff_until, retry_after_seconds,
          recorded_actor, recorded_via, correlation_id, causation_id, observed_at)
       VALUES ($1, $2, $3, $4, $5,
               $6, $7, $8, $9,
               $10, $11::jsonb, $12::jsonb,
               $13, $14, $15, $16,
               $17, $18, $19, $20, $21)`,
      [
        observationId,
        input.attempt.attemptId,
        input.attempt.socialAccountId,
        input.attempt.clientId,
        state,
        failureCode,
        input.status?.providerPublishId ?? input.attempt.providerPublishId,
        input.status?.providerContentId ?? null,
        input.status?.publishedAt === null || input.status?.publishedAt === undefined
          ? null
          : new Date(input.status.publishedAt),
        input.status?.providerFailureReason ?? null,
        JSON.stringify(input.status?.restrictionSignals ?? []),
        input.status?.providerData === null || input.status?.providerData === undefined
          ? null
          : JSON.stringify(input.status.providerData),
        input.rateLimit?.limitRemaining ?? null,
        input.rateLimit?.limitResetAt === null || input.rateLimit?.limitResetAt === undefined
          ? null
          : new Date(input.rateLimit.limitResetAt),
        input.rateLimit?.backoffUntil === null || input.rateLimit?.backoffUntil === undefined
          ? null
          : new Date(input.rateLimit.backoffUntil),
        input.rateLimit?.retryAfterSeconds ?? null,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        now,
      ],
    );
    const observation = await this.observationVia(this.db, observationId);
    if (observation === null) {
      throw new Error(`inserted publish status observation ${observationId} could not be read back`);
    }
    return observation;
  }

  async getAttempt(attemptId: string): Promise<SocialPublishAttemptRecord | null> {
    return this.attemptVia(this.db, attemptId);
  }

  async getAttemptByIdempotencyKey(
    socialAccountId: string,
    idempotencyKey: string,
  ): Promise<SocialPublishAttemptRecord | null> {
    const result = await this.db.query<SocialPublishAttemptRow>(
      `${ATTEMPT_SELECT} WHERE social_account_id = $1 AND idempotency_key = $2`,
      [socialAccountId, idempotencyKey],
    );
    return result.rows.length === 0 ? null : attemptOf(result.rows[0]!);
  }

  async listAttemptsForAccount(
    socialAccountId: string,
  ): Promise<readonly SocialPublishAttemptRecord[]> {
    const result = await this.db.query<SocialPublishAttemptRow>(
      `${ATTEMPT_SELECT} WHERE social_account_id = $1 ORDER BY created_at DESC, attempt_id DESC LIMIT 200`,
      [socialAccountId],
    );
    return result.rows.map(attemptOf);
  }

  async listAttemptsForClient(clientId: string): Promise<readonly SocialPublishAttemptRecord[]> {
    const result = await this.db.query<SocialPublishAttemptRow>(
      `${ATTEMPT_SELECT} WHERE client_id = $1 ORDER BY created_at DESC, attempt_id DESC LIMIT 500`,
      [clientId],
    );
    return result.rows.map(attemptOf);
  }

  async listObservationsForAttempt(
    attemptId: string,
  ): Promise<readonly SocialPublishStatusObservationRecord[]> {
    const result = await this.db.query<SocialPublishObservationRow>(
      `${OBSERVATION_SELECT} WHERE attempt_id = $1 ORDER BY observed_at ASC, observation_id ASC LIMIT 500`,
      [attemptId],
    );
    return result.rows.map(observationOf);
  }

  private async attemptVia(
    runner: DbTransaction,
    attemptId: string,
  ): Promise<SocialPublishAttemptRecord | null> {
    const result = await runner.query<SocialPublishAttemptRow>(
      `${ATTEMPT_SELECT} WHERE attempt_id = $1`,
      [attemptId],
    );
    return result.rows.length === 0 ? null : attemptOf(result.rows[0]!);
  }

  private async observationVia(
    runner: DbTransaction,
    observationId: string,
  ): Promise<SocialPublishStatusObservationRecord | null> {
    const result = await runner.query<SocialPublishObservationRow>(
      `${OBSERVATION_SELECT} WHERE observation_id = $1`,
      [observationId],
    );
    return result.rows.length === 0 ? null : observationOf(result.rows[0]!);
  }
}
