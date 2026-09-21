/**
 * /experiment-analysis persistence (migration 054 tables) — append-only by
 * database backstop: UPDATE and DELETE are rejected by triggers on BOTH
 * tables, so this store can only INSERT and SELECT. Analyses and
 * allocation recommendations are recorded once and stay exactly as
 * recorded — a negative or inconclusive analysis is preserved forever; a
 * revised allocation is a NEW recommendation.
 *
 * Provenance columns (recorded_actor, recorded_via, correlation_id,
 * causation_id, recorded_at) are written ONLY from the server-built
 * provenance argument — there is no other write path, and the guards
 * refuse to even run with an incomplete provenance.
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  AllocationRecommendationRecord,
  ExperimentAnalysisRecord,
  ExperimentAnalysisProvenance,
  ExperimentAnalysisRecordedProvenance,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Row types (pg returns numerics as strings; timestamps as Date)
// ---------------------------------------------------------------------------

interface ExperimentAnalysisRow extends DbRow {
  analysis_id: string;
  client_id: string;
  workspace_id: string | null;
  experiment_id: string;
  analysis_method: string;
  analysis_method_version: string;
  vocabulary_version: string;
  observation_window_start: Date;
  observation_window_end: Date;
  n_treatment: number;
  n_comparison: number;
  treatment_mean: string | null;
  comparison_mean: string | null;
  effect_estimate: string | null;
  standard_error: string | null;
  uncertainty: unknown;
  sequential_state: unknown;
  confounders: unknown;
  limitations: unknown;
  practical_threshold: unknown;
  outcome: string;
  recommended_next_allocation: string;
  input_snapshot: unknown;
  input_digest: string;
  evidence_refs: unknown;
  metric_observation_refs: unknown;
  learning_refs: unknown;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface AllocationRecommendationRow extends DbRow {
  recommendation_id: string;
  client_id: string;
  workspace_id: string | null;
  experiment_id: string;
  analysis_id: string | null;
  vocabulary_version: string;
  arms: unknown;
  allocation: unknown;
  exploration_floor: string;
  exploration_floor_source: string;
  input_snapshot: unknown;
  input_digest: string;
  rationale: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const ANALYSIS_SELECT = `
  SELECT a.analysis_id, a.client_id, a.workspace_id, a.experiment_id,
         a.analysis_method, a.analysis_method_version, a.vocabulary_version,
         a.observation_window_start, a.observation_window_end,
         a.n_treatment, a.n_comparison, a.treatment_mean, a.comparison_mean,
         a.effect_estimate, a.standard_error, a.uncertainty, a.sequential_state,
         a.confounders, a.limitations, a.practical_threshold, a.outcome,
         a.recommended_next_allocation, a.input_snapshot, a.input_digest,
         a.evidence_refs, a.metric_observation_refs, a.learning_refs,
         a.recorded_actor, a.recorded_via, a.correlation_id, a.causation_id, a.recorded_at
  FROM experiment_analysis_records a
`;

const ALLOCATION_SELECT = `
  SELECT r.recommendation_id, r.client_id, r.workspace_id, r.experiment_id,
         r.analysis_id, r.vocabulary_version, r.arms, r.allocation,
         r.exploration_floor, r.exploration_floor_source, r.input_snapshot,
         r.input_digest, r.rationale,
         r.recorded_actor, r.recorded_via, r.correlation_id, r.causation_id, r.recorded_at
  FROM experiment_allocation_recommendations r
`;

function toRecordedProvenance(row: {
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}): ExperimentAnalysisRecordedProvenance {
  return {
    actor: row.recorded_actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: row.recorded_at.toISOString(),
  };
}

function toAnalysisRecord(row: ExperimentAnalysisRow): ExperimentAnalysisRecord {
  return {
    analysisId: row.analysis_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    experimentId: row.experiment_id,
    analysisMethod: row.analysis_method,
    analysisMethodVersion: row.analysis_method_version,
    vocabularyVersion: row.vocabulary_version,
    observationWindowStart: row.observation_window_start.toISOString(),
    observationWindowEnd: row.observation_window_end.toISOString(),
    sampleSizes: {
      treatment: Number(row.n_treatment),
      comparison: Number(row.n_comparison),
    },
    treatmentMean: row.treatment_mean === null ? null : Number(row.treatment_mean),
    comparisonMean: row.comparison_mean === null ? null : Number(row.comparison_mean),
    effectEstimate: row.effect_estimate === null ? null : Number(row.effect_estimate),
    standardError: row.standard_error === null ? null : Number(row.standard_error),
    uncertainty: (row.uncertainty ?? {}) as ExperimentAnalysisRecord['uncertainty'],
    sequentialState: (row.sequential_state ?? {}) as ExperimentAnalysisRecord['sequentialState'],
    confounders: (row.confounders ?? []) as string[],
    limitations: (row.limitations ?? []) as string[],
    practicalThreshold: (row.practical_threshold ?? {}) as ExperimentAnalysisRecord['practicalThreshold'],
    outcome: row.outcome as ExperimentAnalysisRecord['outcome'],
    recommendedNextAllocation: row.recommended_next_allocation as ExperimentAnalysisRecord['recommendedNextAllocation'],
    inputSnapshot: (row.input_snapshot ?? {}) as ExperimentAnalysisRecord['inputSnapshot'],
    inputDigest: row.input_digest,
    evidenceRefs: (row.evidence_refs ?? []) as string[],
    metricObservationRefs: (row.metric_observation_refs ?? []) as string[],
    learningRefs: (row.learning_refs ?? []) as string[],
    provenance: toRecordedProvenance(row),
  };
}

function toAllocationRecord(row: AllocationRecommendationRow): AllocationRecommendationRecord {
  return {
    recommendationId: row.recommendation_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    experimentId: row.experiment_id,
    analysisId: row.analysis_id,
    vocabularyVersion: row.vocabulary_version,
    arms: (row.arms ?? []) as AllocationRecommendationRecord['arms'],
    allocation: (row.allocation ?? {}) as AllocationRecommendationRecord['allocation'],
    explorationFloor: Number(row.exploration_floor),
    explorationFloorSource: row.exploration_floor_source as AllocationRecommendationRecord['explorationFloorSource'],
    inputSnapshot: (row.input_snapshot ?? {}) as AllocationRecommendationRecord['inputSnapshot'],
    inputDigest: row.input_digest,
    rationale: row.rationale,
    provenance: toRecordedProvenance(row),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** The analysis row as assembled by the module (fully computed + validated). */
export interface AnalysisInsertRow {
  readonly analysisId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly experimentId: string;
  readonly analysisMethod: string;
  readonly analysisMethodVersion: string;
  readonly vocabularyVersion: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly nTreatment: number;
  readonly nComparison: number;
  readonly treatmentMean: number | null;
  readonly comparisonMean: number | null;
  readonly effectEstimate: number | null;
  readonly standardError: number | null;
  readonly uncertainty: ExperimentAnalysisRecord['uncertainty'];
  readonly sequentialState: ExperimentAnalysisRecord['sequentialState'];
  readonly confounders: readonly string[];
  readonly limitations: readonly string[];
  readonly practicalThreshold: ExperimentAnalysisRecord['practicalThreshold'];
  readonly outcome: ExperimentAnalysisRecord['outcome'];
  readonly recommendedNextAllocation: ExperimentAnalysisRecord['recommendedNextAllocation'];
  readonly inputSnapshot: ExperimentAnalysisRecord['inputSnapshot'];
  readonly inputDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly metricObservationRefs: readonly string[];
  readonly learningRefs: readonly string[];
}

/** The allocation row as assembled by the module (fully computed + validated). */
export interface AllocationInsertRow {
  readonly recommendationId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly experimentId: string;
  readonly analysisId: string | null;
  readonly vocabularyVersion: string;
  readonly arms: AllocationRecommendationRecord['arms'];
  readonly allocation: AllocationRecommendationRecord['allocation'];
  readonly explorationFloor: number;
  readonly explorationFloorSource: string;
  readonly inputSnapshot: AllocationRecommendationRecord['inputSnapshot'];
  readonly inputDigest: string;
  readonly rationale: string;
}

export class ExperimentAnalysisStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /** Mints the next server identifier (UUIDv7 — time-ordered + random). */
  newAnalysisId(): string {
    return this.ids.newId();
  }

  newRecommendationId(): string {
    return this.ids.newId();
  }

  /** The module clock (stamped on every row's provenance). */
  nowIso(): string {
    return this.clock.nowIso();
  }

  /** Appends one immutable analysis record (the DB triggers are the append-only backstop). */
  async insertAnalysis(
    row: AnalysisInsertRow,
    provenance: ExperimentAnalysisProvenance,
  ): Promise<ExperimentAnalysisRecord> {
    const recordedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO experiment_analysis_records (analysis_id, client_id, workspace_id, experiment_id,
                              analysis_method, analysis_method_version, vocabulary_version,
                              observation_window_start, observation_window_end,
                              n_treatment, n_comparison, treatment_mean, comparison_mean,
                              effect_estimate, standard_error, uncertainty, sequential_state,
                              confounders, limitations, practical_threshold, outcome,
                              recommended_next_allocation, input_snapshot, input_digest,
                              evidence_refs, metric_observation_refs, learning_refs,
                              recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, $21, $22,
               $23::jsonb, $24, $25::jsonb, $26::jsonb, $27::jsonb, $28, $29, $30, $31, $32)`,
      [
        row.analysisId,
        row.clientId,
        row.workspaceId,
        row.experimentId,
        row.analysisMethod,
        row.analysisMethodVersion,
        row.vocabularyVersion,
        row.windowStart,
        row.windowEnd,
        row.nTreatment,
        row.nComparison,
        row.treatmentMean,
        row.comparisonMean,
        row.effectEstimate,
        row.standardError,
        JSON.stringify(row.uncertainty),
        JSON.stringify(row.sequentialState),
        JSON.stringify(row.confounders),
        JSON.stringify(row.limitations),
        JSON.stringify(row.practicalThreshold),
        row.outcome,
        row.recommendedNextAllocation,
        JSON.stringify(row.inputSnapshot),
        row.inputDigest,
        JSON.stringify(row.evidenceRefs),
        JSON.stringify(row.metricObservationRefs),
        JSON.stringify(row.learningRefs),
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        recordedAt,
      ],
    );
    const created = await this.getAnalysis(row.analysisId);
    if (created === null) {
      throw new Error(`appended experiment analysis ${row.analysisId} could not be read back`);
    }
    return created;
  }

  async getAnalysis(analysisId: string): Promise<ExperimentAnalysisRecord | null> {
    const result = await this.db.query<ExperimentAnalysisRow>(
      `${ANALYSIS_SELECT} WHERE a.analysis_id = $1`,
      [analysisId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAnalysisRecord(row);
  }

  /** The experiment's analyses, oldest first (the sequential tail). */
  async listAnalysesForExperiment(experimentId: string): Promise<readonly ExperimentAnalysisRecord[]> {
    const result = await this.db.query<ExperimentAnalysisRow>(
      `${ANALYSIS_SELECT} WHERE a.experiment_id = $1
       ORDER BY a.recorded_at, a.analysis_id`,
      [experimentId],
    );
    return result.rows.map(toAnalysisRecord);
  }

  /** The Client's analyses, newest first (bounded — the tail grows without end). */
  async listAnalysesForClient(
    clientId: string,
    limit = 500,
  ): Promise<readonly ExperimentAnalysisRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<ExperimentAnalysisRow>(
      `${ANALYSIS_SELECT} WHERE a.client_id = $1
       ORDER BY a.recorded_at DESC, a.analysis_id LIMIT $2`,
      [clientId, bounded],
    );
    return result.rows.map(toAnalysisRecord);
  }

  /** The prior-analysis count of one experiment (the sequential-state input). */
  async countAnalysesForExperiment(experimentId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT count(*) AS count FROM experiment_analysis_records WHERE experiment_id = $1`,
      [experimentId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Appends one immutable allocation recommendation. */
  async insertAllocation(
    row: AllocationInsertRow,
    provenance: ExperimentAnalysisProvenance,
  ): Promise<AllocationRecommendationRecord> {
    const recordedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO experiment_allocation_recommendations (recommendation_id, client_id, workspace_id,
                              experiment_id, analysis_id, vocabulary_version, arms, allocation,
                              exploration_floor, exploration_floor_source, input_snapshot,
                              input_digest, rationale,
                              recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12, $13,
               $14, $15, $16, $17, $18)`,
      [
        row.recommendationId,
        row.clientId,
        row.workspaceId,
        row.experimentId,
        row.analysisId,
        row.vocabularyVersion,
        JSON.stringify(row.arms),
        JSON.stringify(row.allocation),
        row.explorationFloor,
        row.explorationFloorSource,
        JSON.stringify(row.inputSnapshot),
        row.inputDigest,
        row.rationale,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        recordedAt,
      ],
    );
    const created = await this.getAllocation(row.recommendationId);
    if (created === null) {
      throw new Error(
        `appended experiment allocation recommendation ${row.recommendationId} could not be read back`,
      );
    }
    return created;
  }

  async getAllocation(recommendationId: string): Promise<AllocationRecommendationRecord | null> {
    const result = await this.db.query<AllocationRecommendationRow>(
      `${ALLOCATION_SELECT} WHERE r.recommendation_id = $1`,
      [recommendationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAllocationRecord(row);
  }

  /** The experiment's recommendations, oldest first. */
  async listAllocationsForExperiment(
    experimentId: string,
  ): Promise<readonly AllocationRecommendationRecord[]> {
    const result = await this.db.query<AllocationRecommendationRow>(
      `${ALLOCATION_SELECT} WHERE r.experiment_id = $1
       ORDER BY r.recorded_at, r.recommendation_id`,
      [experimentId],
    );
    return result.rows.map(toAllocationRecord);
  }
}
