/**
 * /lab persistence (LAB-001 — the migration-059 tables).
 *
 * Owns EXACTLY the nine own tables (the 063/064/058 table discipline):
 *
 *   lab_scenarios, lab_runs, lab_run_events,
 *   lab_strategy_candidates, lab_strategy_candidate_evaluations,
 *   lab_organization_candidates, lab_organization_candidate_evaluations,
 *   lab_capability_candidates, lab_calibration_records.
 *
 * NO AUTHORITY TRANSFER / NO SHADOWING (§3): no experiment, decision,
 * evidence, metric, publication, workflow or execution table is written
 * or joined here — the calibration record's real-outcome anchor is an
 * OPAQUE uuid carried as data (never FK-joined into a v1.6 authority);
 * /experiments, /decisions and their siblings stay sole. Artifact rows
 * are append-only/immutable per the migration-059 guard triggers; run
 * status transitions ride the append-only lab_run_events tail and are
 * paired with the CAS-versioned run-row update inside ONE transaction
 * (the migration-052 pattern).
 *
 * Every read is CLIENT-scoped (the uniform tenant fence; the module
 * resolves foreign/unknown scope to the uniform NotFound — no existence
 * oracle).
 */

import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  LabCalibrationRecordRecord,
  LabCalibrationStatus,
  LabCapabilityCandidateRecord,
  LabCapabilityStatus,
  LabCandidateEvaluationSummary,
  LabCandidateStatus,
  LabFactualityLabel,
  LabOrganizationCandidateRecord,
  LabRunConfiguration,
  LabRunFailureReason,
  LabRunRecord,
  LabRunStatus,
  LabRunTimeMachine,
  LabScenarioRecord,
  LabScenarioStatus,
  LabScope,
  LabSeedSet,
  LabStrategyCandidateRecord,
} from '../public.ts';
import { LAB_CONTRACT_VERSION } from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case as returned by PostgreSQL)
// ---------------------------------------------------------------------------

interface ScenarioRow extends DbRow {
  scenario_id: string;
  scenario_version: number;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  binding: unknown;
  reward_definition: unknown;
  run_configuration: unknown;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface RunRow extends DbRow {
  run_id: string;
  scenario_id: string;
  scenario_version: number;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  failure_reason: string | null;
  time_machine: unknown;
  master_seed: string | number;
  derived_seeds: unknown;
  run_configuration: unknown;
  configuration_overrides: unknown;
  factuality: string;
  output_artifacts: unknown;
  version: number;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface StrategyCandidateRow extends DbRow {
  candidate_id: string;
  scenario_id: string;
  scenario_version: number;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  declaration: unknown;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface OrganizationCandidateRow extends StrategyCandidateRow {
  organization_candidate_id: string;
}

interface CapabilityCandidateRow extends DbRow {
  capability_candidate_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  capability_contract: unknown;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface CalibrationRecordRow extends DbRow {
  calibration_record_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  world_model_version: string;
  strategy_candidate_id: string;
  run_id: string;
  simulated_prediction: unknown;
  outcome_reference_kind: string;
  outcome_authority: string;
  outcome_reference_id: string;
  outcome_summary: unknown;
  outcome_observed_at: Date;
  prediction_error: unknown;
  environment_state: unknown;
  observed_regime: string;
  calibration_update_version: string;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface EvaluationRow extends DbRow {
  evaluation_id: string;
  candidate_id?: string;
  organization_candidate_id?: string;
  run_id: string;
  reward: string | number;
  uncertainty_interval: unknown;
  ensemble_agreement: string | number;
  ood_score: string | number;
  seed_robustness: string | number;
  factuality: string;
  metrics: unknown;
  evaluated_at: Date;
  contract_version: string;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const UUID_PATTERN_STORE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres array literal for uuid[] params (the field-agents-store pattern — QueryParam carries no arrays). */
function toArrayLiteral(values: readonly string[]): string {
  for (const value of values) {
    if (!UUID_PATTERN_STORE.test(value)) {
      throw new Error(`invalid uuid in array literal: ${value}`);
    }
  }
  return `{${values.map((value) => `"${value}"`).join(',')}}`;
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

function mapScenarioRow(r: ScenarioRow): LabScenarioRecord {
  return {
    scenarioId: r.scenario_id,
    scenarioVersion: Number(r.scenario_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabScenarioStatus,
    binding: r.binding as LabScenarioRecord['binding'],
    reward: r.reward_definition as LabScenarioRecord['reward'],
    runConfiguration: r.run_configuration as LabRunConfiguration,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

function mapRunRow(r: RunRow): LabRunRecord {
  return {
    runId: r.run_id,
    scenarioId: r.scenario_id,
    scenarioVersion: Number(r.scenario_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabRunStatus,
    failureReason: (r.failure_reason ?? null) as LabRunFailureReason | null,
    timeMachine: r.time_machine as LabRunTimeMachine,
    seeds: {
      masterSeed: String(r.master_seed),
      derived: (r.derived_seeds ?? []) as LabSeedSet['derived'],
    },
    configuration: r.run_configuration as LabRunConfiguration,
    factuality: r.factuality as LabFactualityLabel,
    configurationOverrides: (r.configuration_overrides ?? null) as LabRunRecord['configurationOverrides'],
    outputArtifacts: (r.output_artifacts ?? null) as LabRunRecord['outputArtifacts'],
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function mapStrategyCandidateRow(r: StrategyCandidateRow, evaluations: ReadonlyArray<LabCandidateEvaluationSummary>): LabStrategyCandidateRecord {
  return {
    candidateId: r.candidate_id,
    scenarioId: r.scenario_id,
    scenarioVersion: Number(r.scenario_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabCandidateStatus,
    declaration: r.declaration as LabStrategyCandidateRecord['declaration'],
    evaluations,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function mapOrganizationCandidateRow(r: OrganizationCandidateRow, evaluations: ReadonlyArray<LabCandidateEvaluationSummary>): LabOrganizationCandidateRecord {
  return {
    organizationCandidateId: r.organization_candidate_id,
    scenarioId: r.scenario_id,
    scenarioVersion: Number(r.scenario_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabCandidateStatus,
    declaration: r.declaration as LabOrganizationCandidateRecord['declaration'],
    evaluations,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function mapCapabilityCandidateRow(r: CapabilityCandidateRow): LabCapabilityCandidateRecord {
  return {
    capabilityCandidateId: r.capability_candidate_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabCapabilityStatus,
    contract: r.capability_contract as LabCapabilityCandidateRecord['contract'],
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function mapCalibrationRecordRow(r: CalibrationRecordRow): LabCalibrationRecordRecord {
  return {
    calibrationRecordId: r.calibration_record_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabCalibrationStatus,
    worldModelVersion: r.world_model_version,
    strategyCandidateId: r.strategy_candidate_id,
    runId: r.run_id,
    simulatedPrediction: r.simulated_prediction as LabCalibrationRecordRecord['simulatedPrediction'],
    realOutcome: {
      referenceKind: r.outcome_reference_kind as LabCalibrationRecordRecord['realOutcome']['referenceKind'],
      authority: r.outcome_authority as LabCalibrationRecordRecord['realOutcome']['authority'],
      referenceId: r.outcome_reference_id,
      outcomeSummary: r.outcome_summary as LabCalibrationRecordRecord['realOutcome']['outcomeSummary'],
      observedAt: toIso(r.outcome_observed_at),
    },
    predictionError: r.prediction_error as LabCalibrationRecordRecord['predictionError'],
    environmentState: r.environment_state as LabCalibrationRecordRecord['environmentState'],
    observedRegime: r.observed_regime as LabCalibrationRecordRecord['observedRegime'],
    calibrationUpdateVersion: r.calibration_update_version,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function mapEvaluationRow(r: EvaluationRow): LabCandidateEvaluationSummary {
  return {
    runId: r.run_id,
    reward: Number(r.reward),
    uncertaintyInterval: (r.uncertainty_interval ?? [0, 0]) as [number, number],
    ensembleAgreement: Number(r.ensemble_agreement),
    oodScore: Number(r.ood_score),
    seedRobustness: Number(r.seed_robustness),
    factuality: r.factuality as LabFactualityLabel,
    metrics: (r.metrics ?? {}) as LabCandidateEvaluationSummary['metrics'],
    evaluatedAt: toIso(r.evaluated_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class LabStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  private nowIso(): string {
    return this.clock.nowIso();
  }

  // --- Scenarios -----------------------------------------------------------

  async insertScenario(row: {
    scenarioId: string;
    scenarioVersion: number;
    scope: LabScope;
    status: LabScenarioStatus;
    binding: unknown;
    rewardDefinition: unknown;
    runConfiguration: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO lab_scenarios
         (scenario_id, scenario_version, agency_id, client_id, workspace_id,
          status, binding, reward_definition, run_configuration,
          contract_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [
        row.scenarioId,
        row.scenarioVersion,
        row.scope.agencyId,
        row.scope.clientId,
        row.scope.workspaceId ?? null,
        row.status,
        JSON.stringify(row.binding),
        JSON.stringify(row.rewardDefinition),
        JSON.stringify(row.runConfiguration),
        LAB_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
  }

  async findLatestScenario(clientId: string, scenarioId: string): Promise<ScenarioRow | null> {
    const r = await this.db.query<ScenarioRow>(
      `SELECT * FROM lab_scenarios
        WHERE client_id = $1 AND scenario_id = $2
        ORDER BY scenario_version DESC LIMIT 1`,
      [clientId, scenarioId],
    );
    return r.rows[0] ?? null;
  }

  async findScenarioVersion(clientId: string, scenarioId: string, version: number): Promise<ScenarioRow | null> {
    const r = await this.db.query<ScenarioRow>(
      `SELECT * FROM lab_scenarios
        WHERE client_id = $1 AND scenario_id = $2 AND scenario_version = $3`,
      [clientId, scenarioId, version],
    );
    return r.rows[0] ?? null;
  }

  async listScenarios(clientId: string): Promise<ScenarioRow[]> {
    const r = await this.db.query<ScenarioRow>(
      `SELECT * FROM lab_scenarios WHERE client_id = $1
        ORDER BY scenario_id, scenario_version`,
      [clientId],
    );
    return r.rows as ScenarioRow[];
  }

  /** Guarded status transition (the migration-059 lab_scenario_guard fence backstops this). */
  async updateScenarioStatus(
    clientId: string,
    scenarioId: string,
    fromVersion: number,
    toStatus: LabScenarioStatus,
  ): Promise<ScenarioRow | null> {
    const r = await this.db.query<ScenarioRow>(
      `UPDATE lab_scenarios SET status = $4, updated_at = $5
        WHERE client_id = $1 AND scenario_id = $2 AND scenario_version = $3
        RETURNING *`,
      [clientId, scenarioId, fromVersion, toStatus, this.nowIso()],
    );
    return r.rows[0] ?? null;
  }

  // --- Runs ------------------------------------------------------------------

  async insertRun(row: {
    runId: string;
    scenarioId: string;
    scenarioVersion: number;
    scope: LabScope;
    timeMachine: unknown;
    seeds: LabSeedSet;
    configuration: unknown;
    configurationOverrides: unknown;
    factuality: LabFactualityLabel;
  }): Promise<void> {
    await this.db.transaction(async (tx: DbTransaction) => {
      await tx.query(
        `INSERT INTO lab_runs
           (run_id, scenario_id, scenario_version, agency_id, client_id, workspace_id,
            status, failure_reason, time_machine, master_seed, derived_seeds,
            run_configuration, configuration_overrides, factuality, output_artifacts,
            version, contract_version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'queued',NULL,$7,$8,$9,$10,$11,$12,NULL,1,$13,$14,$14)`,
        [
          row.runId,
          row.scenarioId,
          row.scenarioVersion,
          row.scope.agencyId,
          row.scope.clientId,
          row.scope.workspaceId ?? null,
          JSON.stringify(row.timeMachine),
          row.seeds.masterSeed,
          JSON.stringify(row.seeds.derived ?? []),
          JSON.stringify(row.configuration),
          row.configurationOverrides === null || row.configurationOverrides === undefined
            ? null
            : JSON.stringify(row.configurationOverrides),
          row.factuality,
          LAB_CONTRACT_VERSION,
          this.nowIso(),
        ],
      );
      // The initialization event (born queued) — the append-only tail.
      await tx.query(
        `INSERT INTO lab_run_events (event_id, run_id, event_seq, from_status, to_status, failure_reason, reason, recorded_at)
         VALUES ($1,$2,1,NULL,'queued',NULL,$3,$4)`,
        [this.ids.newId(), row.runId, 'run created (queued)', this.nowIso()],
      );
    });
  }

  async findRun(clientId: string, runId: string): Promise<RunRow | null> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM lab_runs WHERE client_id = $1 AND run_id = $2`,
      [clientId, runId],
    );
    return r.rows[0] ?? null;
  }

  async listRuns(clientId: string, scenarioId?: string): Promise<RunRow[]> {
    const r = scenarioId
      ? await this.db.query<RunRow>(
          `SELECT * FROM lab_runs WHERE client_id = $1 AND scenario_id = $2 ORDER BY created_at, run_id`,
          [clientId, scenarioId],
        )
      : await this.db.query<RunRow>(
          `SELECT * FROM lab_runs WHERE client_id = $1 ORDER BY created_at, run_id`,
          [clientId],
        );
    return r.rows as RunRow[];
  }

  /** The §23 active-run concurrency probe. */
  async countActiveRuns(clientId: string): Promise<number> {
    const r = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM lab_runs
        WHERE client_id = $1 AND status IN ('queued','running','paused')`,
      [clientId],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /**
   * The paired CAS transition (the migration-052 pattern): lock the run
   * row, insert the append-only transition event (the frozen
   * transition-pair fence validates the edge), then advance the run row
   * — all inside ONE transaction.
   */
  async transitionRun(
    clientId: string,
    runId: string,
    from: LabRunStatus,
    to: LabRunStatus,
    reason: string,
    failureReason: LabRunFailureReason | null,
    outputArtifacts: ReadonlyArray<{ kind: string; version: string }> | null,
  ): Promise<RunRow | null> {
    return this.db.transaction(async (tx: DbTransaction) => {
      const locked = await tx.query<RunRow>(
        `SELECT * FROM lab_runs WHERE client_id = $1 AND run_id = $2 FOR UPDATE`,
        [clientId, runId],
      );
      const row = locked.rows[0];
      if (!row) return null;
      if (row.status !== from) return null;
      const seq = await tx.query<{ n: string }>(
        `SELECT coalesce(max(event_seq),0)::text AS n FROM lab_run_events WHERE run_id = $1`,
        [runId],
      );
      const nextSeq = Number(seq.rows[0]?.n ?? 0) + 1;
      await tx.query(
        `INSERT INTO lab_run_events (event_id, run_id, event_seq, from_status, to_status, failure_reason, reason, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [this.ids.newId(), runId, nextSeq, from, to, failureReason, reason, this.nowIso()],
      );
      const updated = await tx.query<RunRow>(
        `UPDATE lab_runs
           SET status = $3, failure_reason = $4, output_artifacts = $5,
               version = version + 1, updated_at = $6
         WHERE client_id = $1 AND run_id = $2 AND version = $7
         RETURNING *`,
        [
          clientId,
          runId,
          to,
          failureReason,
          outputArtifacts === null || outputArtifacts === undefined ? null : JSON.stringify(outputArtifacts),
          this.nowIso(),
          Number(row.version),
        ],
      );
      return updated.rows[0] ?? null;
    });
  }

  // --- Strategy candidates ---------------------------------------------------

  async insertStrategyCandidate(row: {
    candidateId: string;
    scenarioId: string;
    scenarioVersion: number;
    scope: LabScope;
    declaration: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO lab_strategy_candidates
         (candidate_id, scenario_id, scenario_version, agency_id, client_id, workspace_id,
          status, declaration, contract_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$9)`,
      [
        row.candidateId,
        row.scenarioId,
        row.scenarioVersion,
        row.scope.agencyId,
        row.scope.clientId,
        row.scope.workspaceId ?? null,
        JSON.stringify(row.declaration),
        LAB_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
  }

  async findStrategyCandidate(clientId: string, candidateId: string): Promise<StrategyCandidateRow | null> {
    const r = await this.db.query<StrategyCandidateRow>(
      `SELECT * FROM lab_strategy_candidates WHERE client_id = $1 AND candidate_id = $2`,
      [clientId, candidateId],
    );
    return r.rows[0] ?? null;
  }

  async listStrategyCandidates(clientId: string, scenarioId?: string): Promise<StrategyCandidateRow[]> {
    const r = scenarioId
      ? await this.db.query<StrategyCandidateRow>(
          `SELECT * FROM lab_strategy_candidates WHERE client_id = $1 AND scenario_id = $2 ORDER BY created_at, candidate_id`,
          [clientId, scenarioId],
        )
      : await this.db.query<StrategyCandidateRow>(
          `SELECT * FROM lab_strategy_candidates WHERE client_id = $1 ORDER BY created_at, candidate_id`,
          [clientId],
        );
    return r.rows as StrategyCandidateRow[];
  }

  async updateStrategyCandidateStatus(clientId: string, candidateId: string, toStatus: LabCandidateStatus): Promise<StrategyCandidateRow | null> {
    const r = await this.db.query<StrategyCandidateRow>(
      `UPDATE lab_strategy_candidates SET status = $3, updated_at = $4
        WHERE client_id = $1 AND candidate_id = $2 RETURNING *`,
      [clientId, candidateId, toStatus, this.nowIso()],
    );
    return r.rows[0] ?? null;
  }

  async insertStrategyCandidateEvaluation(
    clientId: string,
    candidateId: string,
    summary: LabCandidateEvaluationSummary,
  ): Promise<void> {
    const runOk = await this.db.query(
      `SELECT 1 FROM lab_runs WHERE client_id = $1 AND run_id = $2`,
      [clientId, summary.runId],
    );
    if (runOk.rowCount === 0) {
      throw new Error(`evaluation run ${summary.runId} does not belong to client ${clientId}`);
    }
    await this.db.query(
      `INSERT INTO lab_strategy_candidate_evaluations
         (evaluation_id, candidate_id, run_id, reward, uncertainty_interval,
          ensemble_agreement, ood_score, seed_robustness, factuality, metrics,
          evaluated_at, contract_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        this.ids.newId(),
        candidateId,
        summary.runId,
        summary.reward,
        JSON.stringify(summary.uncertaintyInterval),
        summary.ensembleAgreement,
        summary.oodScore,
        summary.seedRobustness,
        summary.factuality,
        JSON.stringify(summary.metrics ?? {}),
        summary.evaluatedAt,
        LAB_CONTRACT_VERSION,
      ],
    );
  }

  async listStrategyCandidateEvaluations(candidateIds: ReadonlyArray<string>): Promise<Map<string, LabCandidateEvaluationSummary[]>> {
    const out = new Map<string, LabCandidateEvaluationSummary[]>();
    if (candidateIds.length === 0) return out;
    const r = await this.db.query<EvaluationRow>(
      `SELECT * FROM lab_strategy_candidate_evaluations
        WHERE candidate_id = ANY($1::uuid[]) ORDER BY evaluated_at, evaluation_id`,
      [toArrayLiteral(candidateIds)],
    );
    for (const row of r.rows as EvaluationRow[]) {
      const key = String(row.candidate_id);
      const list = out.get(key) ?? [];
      list.push(mapEvaluationRow(row));
      out.set(key, list);
    }
    return out;
  }

  // --- Organization candidates -------------------------------------------------

  async insertOrganizationCandidate(row: {
    organizationCandidateId: string;
    scenarioId: string;
    scenarioVersion: number;
    scope: LabScope;
    declaration: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO lab_organization_candidates
         (organization_candidate_id, scenario_id, scenario_version, agency_id, client_id, workspace_id,
          status, declaration, contract_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$9)`,
      [
        row.organizationCandidateId,
        row.scenarioId,
        row.scenarioVersion,
        row.scope.agencyId,
        row.scope.clientId,
        row.scope.workspaceId ?? null,
        JSON.stringify(row.declaration),
        LAB_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
  }

  async findOrganizationCandidate(clientId: string, organizationCandidateId: string): Promise<OrganizationCandidateRow | null> {
    const r = await this.db.query<OrganizationCandidateRow>(
      `SELECT * FROM lab_organization_candidates WHERE client_id = $1 AND organization_candidate_id = $2`,
      [clientId, organizationCandidateId],
    );
    return r.rows[0] ?? null;
  }

  async listOrganizationCandidates(clientId: string, scenarioId?: string): Promise<OrganizationCandidateRow[]> {
    const r = scenarioId
      ? await this.db.query<OrganizationCandidateRow>(
          `SELECT * FROM lab_organization_candidates WHERE client_id = $1 AND scenario_id = $2 ORDER BY created_at, organization_candidate_id`,
          [clientId, scenarioId],
        )
      : await this.db.query<OrganizationCandidateRow>(
          `SELECT * FROM lab_organization_candidates WHERE client_id = $1 ORDER BY created_at, organization_candidate_id`,
          [clientId],
        );
    return r.rows as OrganizationCandidateRow[];
  }

  async updateOrganizationCandidateStatus(clientId: string, organizationCandidateId: string, toStatus: LabCandidateStatus): Promise<OrganizationCandidateRow | null> {
    const r = await this.db.query<OrganizationCandidateRow>(
      `UPDATE lab_organization_candidates SET status = $3, updated_at = $4
        WHERE client_id = $1 AND organization_candidate_id = $2 RETURNING *`,
      [clientId, organizationCandidateId, toStatus, this.nowIso()],
    );
    return r.rows[0] ?? null;
  }

  async insertOrganizationCandidateEvaluation(
    clientId: string,
    organizationCandidateId: string,
    summary: LabCandidateEvaluationSummary,
  ): Promise<void> {
    const runOk = await this.db.query(
      `SELECT 1 FROM lab_runs WHERE client_id = $1 AND run_id = $2`,
      [clientId, summary.runId],
    );
    if (runOk.rowCount === 0) {
      throw new Error(`evaluation run ${summary.runId} does not belong to client ${clientId}`);
    }
    await this.db.query(
      `INSERT INTO lab_organization_candidate_evaluations
         (evaluation_id, organization_candidate_id, run_id, reward, uncertainty_interval,
          ensemble_agreement, ood_score, seed_robustness, factuality, metrics,
          evaluated_at, contract_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        this.ids.newId(),
        organizationCandidateId,
        summary.runId,
        summary.reward,
        JSON.stringify(summary.uncertaintyInterval),
        summary.ensembleAgreement,
        summary.oodScore,
        summary.seedRobustness,
        summary.factuality,
        JSON.stringify(summary.metrics ?? {}),
        summary.evaluatedAt,
        LAB_CONTRACT_VERSION,
      ],
    );
  }

  async listOrganizationCandidateEvaluations(organizationCandidateIds: ReadonlyArray<string>): Promise<Map<string, LabCandidateEvaluationSummary[]>> {
    const out = new Map<string, LabCandidateEvaluationSummary[]>();
    if (organizationCandidateIds.length === 0) return out;
    const r = await this.db.query<EvaluationRow>(
      `SELECT * FROM lab_organization_candidate_evaluations
        WHERE organization_candidate_id = ANY($1::uuid[]) ORDER BY evaluated_at, evaluation_id`,
      [toArrayLiteral(organizationCandidateIds)],
    );
    for (const row of r.rows as EvaluationRow[]) {
      const key = String(row.organization_candidate_id);
      const list = out.get(key) ?? [];
      list.push(mapEvaluationRow(row));
      out.set(key, list);
    }
    return out;
  }

  // --- Capability candidates ----------------------------------------------------

  async insertCapabilityCandidate(row: {
    capabilityCandidateId: string;
    scope: LabScope;
    contract: unknown;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO lab_capability_candidates
         (capability_candidate_id, agency_id, client_id, workspace_id,
          status, capability_contract, contract_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'declared',$5,$6,$7,$7)`,
      [
        row.capabilityCandidateId,
        row.scope.agencyId,
        row.scope.clientId,
        row.scope.workspaceId ?? null,
        JSON.stringify(row.contract),
        LAB_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
  }

  async findCapabilityCandidate(clientId: string, capabilityCandidateId: string): Promise<CapabilityCandidateRow | null> {
    const r = await this.db.query<CapabilityCandidateRow>(
      `SELECT * FROM lab_capability_candidates WHERE client_id = $1 AND capability_candidate_id = $2`,
      [clientId, capabilityCandidateId],
    );
    return r.rows[0] ?? null;
  }

  async listCapabilityCandidates(clientId: string): Promise<CapabilityCandidateRow[]> {
    const r = await this.db.query<CapabilityCandidateRow>(
      `SELECT * FROM lab_capability_candidates WHERE client_id = $1 ORDER BY created_at, capability_candidate_id`,
      [clientId],
    );
    return r.rows as CapabilityCandidateRow[];
  }

  async updateCapabilityCandidateStatus(clientId: string, capabilityCandidateId: string, toStatus: LabCapabilityStatus): Promise<CapabilityCandidateRow | null> {
    const r = await this.db.query<CapabilityCandidateRow>(
      `UPDATE lab_capability_candidates SET status = $3, updated_at = $4
        WHERE client_id = $1 AND capability_candidate_id = $2 RETURNING *`,
      [clientId, capabilityCandidateId, toStatus, this.nowIso()],
    );
    return r.rows[0] ?? null;
  }

  // --- Calibration records --------------------------------------------------------

  async insertCalibrationRecord(row: {
    calibrationRecordId: string;
    scope: LabScope;
    worldModelVersion: string;
    strategyCandidateId: string;
    runId: string;
    simulatedPrediction: unknown;
    realOutcome: unknown;
    predictionError: unknown;
    environmentState: unknown;
    observedRegime: string;
  }): Promise<void> {
    const outcome = row.realOutcome as { referenceKind: string; authority: string; referenceId: string; outcomeSummary: unknown; observedAt: string };
    await this.db.query(
      `INSERT INTO lab_calibration_records
         (calibration_record_id, agency_id, client_id, workspace_id, status,
          world_model_version, strategy_candidate_id, run_id,
          simulated_prediction, outcome_reference_kind, outcome_authority,
          outcome_reference_id, outcome_summary, outcome_observed_at,
          prediction_error, environment_state, observed_regime,
          calibration_update_version, contract_version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'recorded',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17,$18,$18)`,
      [
        row.calibrationRecordId,
        row.scope.agencyId,
        row.scope.clientId,
        row.scope.workspaceId ?? null,
        row.worldModelVersion,
        row.strategyCandidateId,
        row.runId,
        JSON.stringify(row.simulatedPrediction),
        outcome.referenceKind,
        outcome.authority,
        outcome.referenceId,
        JSON.stringify(outcome.outcomeSummary),
        outcome.observedAt,
        JSON.stringify(row.predictionError),
        JSON.stringify(row.environmentState),
        row.observedRegime,
        LAB_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
  }

  async findCalibrationRecord(clientId: string, calibrationRecordId: string): Promise<CalibrationRecordRow | null> {
    const r = await this.db.query<CalibrationRecordRow>(
      `SELECT * FROM lab_calibration_records WHERE client_id = $1 AND calibration_record_id = $2`,
      [clientId, calibrationRecordId],
    );
    return r.rows[0] ?? null;
  }

  async listCalibrationRecords(clientId: string, worldModelVersion?: string): Promise<CalibrationRecordRow[]> {
    const r = worldModelVersion
      ? await this.db.query<CalibrationRecordRow>(
          `SELECT * FROM lab_calibration_records WHERE client_id = $1 AND world_model_version = $2
           ORDER BY created_at, calibration_record_id`,
          [clientId, worldModelVersion],
        )
      : await this.db.query<CalibrationRecordRow>(
          `SELECT * FROM lab_calibration_records WHERE client_id = $1
           ORDER BY created_at, calibration_record_id`,
          [clientId],
        );
    return r.rows as CalibrationRecordRow[];
  }

  async applyCalibrationRecord(clientId: string, calibrationRecordId: string, calibrationUpdateVersion: string): Promise<CalibrationRecordRow | null> {
    const r = await this.db.query<CalibrationRecordRow>(
      `UPDATE lab_calibration_records
         SET status = 'applied', calibration_update_version = $3, updated_at = $4
        WHERE client_id = $1 AND calibration_record_id = $2 RETURNING *`,
      [clientId, calibrationRecordId, calibrationUpdateVersion, this.nowIso()],
    );
    return r.rows[0] ?? null;
  }
}

export {
  mapScenarioRow,
  mapRunRow,
  mapStrategyCandidateRow,
  mapOrganizationCandidateRow,
  mapCapabilityCandidateRow,
  mapCalibrationRecordRow,
  mapEvaluationRow,
};
