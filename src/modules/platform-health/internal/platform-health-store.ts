/**
 * /platform-health persistence (MKT-066 — the migration-058 tables).
 *
 * Owns EXACTLY the four own tables (the 063/064 table discipline):
 *
 *   platform_health_evaluations                     — the CLIENT-SCOPED
 *     append-only evaluation records (the state verdict + reason codes +
 *     confidence + uncertainty + baseline summaries + recommendations +
 *     evidence basis + signals-considered disclosure + provenance);
 *   platform_health_evaluation_evidence             — the FK-anchored
 *     same-Client /evidence links (the evidence basis behind the verdict);
 *   platform_health_evaluation_metric_observations  — the FK-anchored
 *     same-Client /metrics observation links (the consumed series points);
 *   platform_health_evaluation_publication_refs     — the FK-anchored
 *     same-Client 056 publish-attempt links (the observable publication
 *     outcomes behind the verdict).
 *
 * NO AUTHORITY TRANSFER: no evidence, metric, experiment, account, grant,
 * attempt, integration or tenant table is written here — the anchored
 * authority tables are read CHECK-ONLY by the DB scope triggers (the
 * migration-057 fence pattern). Evaluations are APPEND-ONLY: UPDATE and
 * DELETE are rejected by the migration-058 triggers (a new evaluation is
 * a NEW record; history is never rewritten).
 */

import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  PlatformHealthEvidenceBasisEntry,
  PlatformHealthEvaluationRecord,
  PlatformHealthProvenance,
  PlatformHealthRecommendation,
  PlatformHealthBaselineSeriesSummary,
} from '../public.ts';
import { PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE } from '../public.ts';

interface EvaluationRow extends DbRow {
  platform_health_evaluation_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  social_account_id: string;
  platform_id: string;
  evaluated_state: string;
  confidence: string;
  uncertainty: string;
  reason_codes: unknown;
  baseline: unknown;
  recommendations: unknown;
  evidence_basis: unknown;
  signals_considered: unknown;
  vocabulary_version: string;
  baseline_version: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface LinkRow extends DbRow {
  position: number;
}

const EVALUATION_SELECT = `
  SELECT platform_health_evaluation_id, agency_id, client_id, workspace_id,
         social_account_id, platform_id, evaluated_state, confidence, uncertainty,
         reason_codes, baseline, recommendations, evidence_basis, signals_considered,
         vocabulary_version, baseline_version, recorded_actor, recorded_via,
         correlation_id, causation_id, created_at
  FROM platform_health_evaluations
`;

/** The bounded citation windows of the three link tables (position-fenced in the migration). */
export const MAX_EVIDENCE_LINKS = 16;
export const MAX_METRIC_LINKS = 32;
export const MAX_PUBLICATION_LINKS = 32;

function toRecord(row: EvaluationRow): PlatformHealthEvaluationRecord {
  return {
    evaluationId: row.platform_health_evaluation_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    socialAccountId: row.social_account_id,
    platformId: row.platform_id,
    evaluatedState: row.evaluated_state as PlatformHealthEvaluationRecord['evaluatedState'],
    confidence: row.confidence as PlatformHealthEvaluationRecord['confidence'],
    uncertainty: row.uncertainty,
    reasonCodes: (row.reason_codes ?? []) as PlatformHealthEvaluationRecord['reasonCodes'],
    baseline: (row.baseline ?? []) as readonly PlatformHealthBaselineSeriesSummary[],
    recommendations: (row.recommendations ?? []) as readonly PlatformHealthRecommendation[],
    evidenceBasis: (row.evidence_basis ?? []) as readonly PlatformHealthEvidenceBasisEntry[],
    signalsConsidered: (row.signals_considered ?? {}) as Readonly<Record<string, unknown>>,
    vocabularyVersion: row.vocabulary_version as PlatformHealthEvaluationRecord['vocabularyVersion'],
    baselineVersion: row.baseline_version as PlatformHealthEvaluationRecord['baselineVersion'],
    observabilityDisclosure: PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export interface PlatformHealthInsertInput {
  readonly evaluationId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly socialAccountId: string;
  readonly platformId: string;
  readonly record: {
    readonly evaluatedState: string;
    readonly confidence: string;
    readonly uncertainty: string;
    readonly reasonCodes: readonly string[];
    readonly baseline: readonly PlatformHealthBaselineSeriesSummary[];
    readonly recommendations: readonly PlatformHealthRecommendation[];
    readonly evidenceBasis: readonly PlatformHealthEvidenceBasisEntry[];
    readonly signalsConsidered: Readonly<Record<string, unknown>>;
    readonly vocabularyVersion: string;
    readonly baselineVersion: string;
  };
  readonly evidenceIds: readonly string[];
  readonly metricObservationIds: readonly string[];
  readonly publishAttemptIds: readonly string[];
  readonly provenance: PlatformHealthProvenance;
}

export class PlatformHealthStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /** Inserts ONE evaluation + its citation links in a single transaction (append-only). */
  async insertEvaluation(input: PlatformHealthInsertInput): Promise<void> {
    const now = this.clock.nowIso();
    await this.db.transaction(async (tx: DbTransaction) => {
      await tx.query(
        `INSERT INTO platform_health_evaluations
           (platform_health_evaluation_id, agency_id, client_id, workspace_id,
            social_account_id, platform_id, evaluated_state, confidence, uncertainty,
            reason_codes, baseline, recommendations, evidence_basis, signals_considered,
            vocabulary_version, baseline_version, recorded_actor, recorded_via,
            correlation_id, causation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb,
                 $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21)`,
        [
          input.evaluationId,
          input.agencyId,
          input.clientId,
          input.workspaceId,
          input.socialAccountId,
          input.platformId,
          input.record.evaluatedState,
          input.record.confidence,
          input.record.uncertainty,
          JSON.stringify(input.record.reasonCodes),
          JSON.stringify(input.record.baseline),
          JSON.stringify(input.record.recommendations),
          JSON.stringify(input.record.evidenceBasis),
          JSON.stringify(input.record.signalsConsidered),
          input.record.vocabularyVersion,
          input.record.baselineVersion,
          input.provenance.actor,
          input.provenance.recordedVia,
          input.provenance.correlationId,
          input.provenance.causationId,
          now,
        ],
      );

      for (const [position, evidenceId] of input.evidenceIds.entries()) {
        await tx.query(
          `INSERT INTO platform_health_evaluation_evidence
             (platform_health_evaluation_id, evidence_id, position)
           VALUES ($1, $2, $3)`,
          [input.evaluationId, evidenceId, position + 1],
        );
      }
      for (const [position, observationId] of input.metricObservationIds.entries()) {
        await tx.query(
          `INSERT INTO platform_health_evaluation_metric_observations
             (platform_health_evaluation_id, metric_observation_id, position)
           VALUES ($1, $2, $3)`,
          [input.evaluationId, observationId, position + 1],
        );
      }
      for (const [position, attemptId] of input.publishAttemptIds.entries()) {
        await tx.query(
          `INSERT INTO platform_health_evaluation_publication_refs
             (platform_health_evaluation_id, publish_attempt_id, position)
           VALUES ($1, $2, $3)`,
          [input.evaluationId, attemptId, position + 1],
        );
      }
    });
  }

  async getEvaluation(evaluationId: string): Promise<PlatformHealthEvaluationRecord | null> {
    const result = await this.db.query<EvaluationRow>(
      `${EVALUATION_SELECT} WHERE platform_health_evaluation_id = $1`,
      [evaluationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async listEvaluationsForAccount(
    clientId: string,
    socialAccountId: string,
  ): Promise<readonly PlatformHealthEvaluationRecord[]> {
    const result = await this.db.query<EvaluationRow>(
      `${EVALUATION_SELECT} WHERE client_id = $1 AND social_account_id = $2
       ORDER BY created_at, platform_health_evaluation_id`,
      [clientId, socialAccountId],
    );
    return result.rows.map(toRecord);
  }

  async listEvaluationsForClient(clientId: string): Promise<readonly PlatformHealthEvaluationRecord[]> {
    const result = await this.db.query<EvaluationRow>(
      `${EVALUATION_SELECT} WHERE client_id = $1
       ORDER BY created_at, platform_health_evaluation_id LIMIT 500`,
      [clientId],
    );
    return result.rows.map(toRecord);
  }

  /** The FK-anchored /evidence citation ids of one evaluation (citation order). */
  async listEvidenceIds(evaluationId: string): Promise<readonly string[]> {
    const result = await this.db.query<LinkRow>(
      `SELECT evidence_id, position FROM platform_health_evaluation_evidence
       WHERE platform_health_evaluation_id = $1 ORDER BY position`,
      [evaluationId],
    );
    return result.rows.map((row) => row.evidence_id as string);
  }

  /** The FK-anchored /metrics observation ids of one evaluation (citation order). */
  async listMetricObservationIds(evaluationId: string): Promise<readonly string[]> {
    const result = await this.db.query<LinkRow>(
      `SELECT metric_observation_id, position FROM platform_health_evaluation_metric_observations
       WHERE platform_health_evaluation_id = $1 ORDER BY position`,
      [evaluationId],
    );
    return result.rows.map((row) => row.metric_observation_id as string);
  }

  /** The FK-anchored 056 publish-attempt ids of one evaluation (citation order). */
  async listPublishAttemptIds(evaluationId: string): Promise<readonly string[]> {
    const result = await this.db.query<LinkRow>(
      `SELECT publish_attempt_id, position FROM platform_health_evaluation_publication_refs
       WHERE platform_health_evaluation_id = $1 ORDER BY position`,
      [evaluationId],
    );
    return result.rows.map((row) => row.publish_attempt_id as string);
  }

  /** Fresh id (the platform IdGenerator — server-derived, never caller input). */
  newId(): string {
    return this.ids.newId();
  }
}
