/**
 * /lab-simulator persistence (LAB-005 — the migration-071 tables).
 *
 * Owns EXACTLY the seven own tables (the 065/066/067 discipline):
 *
 *   lab_simulator_world_configs, lab_simulator_seeds,
 *   lab_simulator_runs, lab_simulator_run_steps,
 *   lab_simulator_observable_snapshots, lab_simulator_ensembles,
 *   lab_simulator_ensemble_members.
 *
 * NO AUTHORITY TRANSFER / NO SHADOWING (§3): no experiment, decision,
 * evidence, metric, publication, workflow or execution table is
 * written or joined here; no /lab, /lab-features or /lab-ideas table
 * is written either — the content-universe citations are OPAQUE
 * recorded citation data (the /lab family by-reference discipline;
 * this store never issues any SQL against lab_feature_*, lab_idea_*
 * or lab_* authority tables).
 *
 * Configuration, seed, step, observable-snapshot and ensemble-member
 * rows are APPEND-ONLY OUTRIGHT (UPDATE and DELETE rejected by the
 * migration-071 triggers); the run and ensemble rows are born
 * 'running' and advance to 'completed' exactly once with their
 * summaries SQL-COMPUTED from the tail rows (never asserted
 * separately).
 *
 * Every read is CLIENT-scoped (the uniform tenant fence; the module
 * resolves foreign/unknown scope to the uniform NotFound — no
 * existence oracle).
 */

import type { DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  LabSimulatorEnsembleMemberRecord,
  LabSimulatorEnsembleRecord,
  LabSimulatorObservableSnapshotRecord,
  LabSimulatorOutcomeMetric,
  LabSimulatorRunRecord,
  LabSimulatorScope,
  LabSimulatorSeedRecord,
  LabSimulatorStepRecord,
  LabSimulatorWorldConfigRecord,
  LabSimulatorWorldKnobs,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case as returned by PostgreSQL)
// ---------------------------------------------------------------------------

export interface WorldConfigRow extends DbRow {
  config_id: string;
  config_version: number | string;
  world_model_version: string;
  rng_id: string;
  rng_version: string;
  knobs: unknown;
  config_digest: string;
  modeling_basis: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

export interface SeedRow extends DbRow {
  seed_id: string;
  master_seed: string;
  derived: unknown;
  config_id: string;
  config_version: number | string;
  config_digest: string;
  seed_digest: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

export interface RunRow extends DbRow {
  run_id: string;
  status: string;
  seed_id: string;
  config_id: string;
  config_version: number | string;
  config_digest: string;
  engine_version: string;
  factuality: string;
  deterministic_replay: boolean;
  replay_of_run_id: string | null;
  replay_verified: boolean | null;
  step_budget: number | string;
  publishing_plan: unknown;
  content_universe: unknown;
  step_count: number | string;
  total_impressions: number | string;
  total_views: number | string;
  total_engagements: number | string;
  total_shares: number | string;
  total_clicks: number | string;
  total_conversions: number | string;
  total_revenue: string | number;
  total_followers_gained: number | string;
  trajectory_digest: string | null;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

export interface StepRow extends DbRow {
  step_id: string;
  run_id: string;
  seq: number | string;
  candidates: unknown;
  exposure: unknown;
  interactions: unknown;
  competitor_posts: unknown;
  topic_trends: unknown;
  impressions: number | string;
  views: number | string;
  engagements: number | string;
  shares: number | string;
  clicks: number | string;
  conversions: number | string;
  revenue: string | number;
  followers_gained: number | string;
  competitor_post_count: number | string;
  step_digest: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

export interface ObservableSnapshotRow extends DbRow {
  snapshot_id: string;
  run_id: string;
  seq: number | string;
  observable_state: unknown;
  observable_digest: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

export interface EnsembleRow extends DbRow {
  ensemble_id: string;
  status: string;
  member_count: number | string;
  ensemble_seed: string;
  outcome_metric: string;
  config_citations: unknown;
  mean_outcome: string | number;
  min_outcome: string | number;
  max_outcome: string | number;
  agreement_fraction: string | number;
  disagreement_fraction: string | number;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

export interface EnsembleMemberRow extends DbRow {
  member_id: string;
  ensemble_id: string;
  run_id: string;
  seq: number | string;
  member_seed: string;
  config_id: string;
  config_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

export function mapWorldConfigRow(r: WorldConfigRow): LabSimulatorWorldConfigRecord {
  return {
    configId: r.config_id,
    configVersion: Number(r.config_version),
    worldModelVersion: r.world_model_version,
    rngId: r.rng_id,
    rngVersion: r.rng_version,
    knobs: r.knobs as LabSimulatorWorldKnobs,
    configDigest: r.config_digest,
    modelingBasis: 'declared_world_model_assumptions',
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapSeedRow(r: SeedRow): LabSimulatorSeedRecord {
  return {
    seedId: r.seed_id,
    masterSeed: r.master_seed,
    derived: (r.derived as LabSimulatorSeedRecord['derived']) ?? [],
    configId: r.config_id,
    configVersion: Number(r.config_version),
    configDigest: r.config_digest,
    seedDigest: r.seed_digest,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapRunRow(r: RunRow): LabSimulatorRunRecord {
  return {
    runId: r.run_id,
    status: r.status as 'running' | 'completed',
    seedId: r.seed_id,
    configId: r.config_id,
    configVersion: Number(r.config_version),
    configDigest: r.config_digest,
    engineVersion: r.engine_version,
    factuality: 'simulated_model_output',
    deterministicReplay: r.deterministic_replay,
    replayOfRunId: r.replay_of_run_id,
    replayVerified: r.replay_verified,
    stepBudget: Number(r.step_budget),
    publishingPlan: (r.publishing_plan as LabSimulatorRunRecord['publishingPlan']) ?? [],
    contentUniverse: (r.content_universe as LabSimulatorRunRecord['contentUniverse']) ?? [],
    stepCount: Number(r.step_count),
    totalImpressions: Number(r.total_impressions),
    totalViews: Number(r.total_views),
    totalEngagements: Number(r.total_engagements),
    totalShares: Number(r.total_shares),
    totalClicks: Number(r.total_clicks),
    totalConversions: Number(r.total_conversions),
    totalRevenue: Number(r.total_revenue),
    totalFollowersGained: Number(r.total_followers_gained),
    trajectoryDigest: r.trajectory_digest,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapStepRow(r: StepRow): LabSimulatorStepRecord {
  return {
    stepId: r.step_id,
    runId: r.run_id,
    seq: Number(r.seq),
    candidates: (r.candidates as LabSimulatorStepRecord['candidates']) ?? [],
    exposure: (r.exposure as LabSimulatorStepRecord['exposure']) ?? [],
    interactions: (r.interactions as LabSimulatorStepRecord['interactions']) ?? [],
    competitorPosts: (r.competitor_posts as LabSimulatorStepRecord['competitorPosts']) ?? [],
    topicTrends: (r.topic_trends as LabSimulatorStepRecord['topicTrends']) ?? {},
    impressions: Number(r.impressions),
    views: Number(r.views),
    engagements: Number(r.engagements),
    shares: Number(r.shares),
    clicks: Number(r.clicks),
    conversions: Number(r.conversions),
    revenue: Number(r.revenue),
    followersGained: Number(r.followers_gained),
    competitorPostCount: Number(r.competitor_post_count),
    stepDigest: r.step_digest,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapObservableSnapshotRow(r: ObservableSnapshotRow): LabSimulatorObservableSnapshotRecord {
  return {
    snapshotId: r.snapshot_id,
    runId: r.run_id,
    seq: Number(r.seq),
    observableState: (r.observable_state as LabSimulatorObservableSnapshotRecord['observableState']) ?? {},
    observableDigest: r.observable_digest,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapEnsembleRow(
  r: EnsembleRow,
  members: ReadonlyArray<LabSimulatorEnsembleMemberRecord> = [],
): LabSimulatorEnsembleRecord {
  return {
    ensembleId: r.ensemble_id,
    status: r.status as 'running' | 'completed',
    memberCount: Number(r.member_count),
    ensembleSeed: r.ensemble_seed,
    outcomeMetric: r.outcome_metric as LabSimulatorOutcomeMetric,
    configCitations: (r.config_citations as LabSimulatorEnsembleRecord['configCitations']) ?? [],
    meanOutcome: Number(r.mean_outcome),
    minOutcome: Number(r.min_outcome),
    maxOutcome: Number(r.max_outcome),
    agreementFraction: Number(r.agreement_fraction),
    disagreementFraction: Number(r.disagreement_fraction),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    members,
  };
}

export function mapEnsembleMemberRow(r: EnsembleMemberRow): LabSimulatorEnsembleMemberRecord {
  return {
    memberId: r.member_id,
    ensembleId: r.ensemble_id,
    runId: r.run_id,
    seq: Number(r.seq),
    memberSeed: r.member_seed,
    configId: r.config_id,
    configVersion: Number(r.config_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** The closed outcome-metric → run summary column map (the SQL-computed ensemble agreement reads exactly these). */
const OUTCOME_COLUMNS: Readonly<Record<LabSimulatorOutcomeMetric, string>> = {
  impressions: 'total_impressions',
  views: 'total_views',
  engagements: 'total_engagements',
  shares: 'total_shares',
  clicks: 'total_clicks',
  conversions: 'total_conversions',
  followers_gained: 'total_followers_gained',
};

export interface InsertWorldConfigRowInput {
  configId: string;
  configVersion: number;
  scope: LabSimulatorScope;
  knobsJson: string;
  configDigest: string;
}

export interface InsertSeedRowInput {
  seedId: string;
  scope: LabSimulatorScope;
  masterSeed: string;
  derivedJson: string;
  configId: string;
  configVersion: number;
  configDigest: string;
  seedDigest: string;
}

export interface InsertRunRowInput {
  runId: string;
  scope: LabSimulatorScope;
  seedId: string;
  configId: string;
  configVersion: number;
  configDigest: string;
  deterministicReplay: boolean;
  replayOfRunId: string | null;
  stepBudget: number;
  publishingPlanJson: string;
  contentUniverseJson: string;
}

export interface InsertStepRowInput {
  stepId: string;
  runId: string;
  scope: LabSimulatorScope;
  seq: number;
  candidatesJson: string;
  exposureJson: string;
  interactionsJson: string;
  competitorPostsJson: string;
  topicTrendsJson: string;
  impressions: number;
  views: number;
  engagements: number;
  shares: number;
  clicks: number;
  conversions: number;
  revenue: number;
  followersGained: number;
  competitorPostCount: number;
  stepDigest: string;
}

export interface InsertObservableSnapshotRowInput {
  snapshotId: string;
  runId: string;
  scope: LabSimulatorScope;
  seq: number;
  observableStateJson: string;
  observableDigest: string;
}

export interface InsertEnsembleRowInput {
  ensembleId: string;
  scope: LabSimulatorScope;
  memberCount: number;
  ensembleSeed: string;
  outcomeMetric: LabSimulatorOutcomeMetric;
  configCitationsJson: string;
}

export interface InsertEnsembleMemberRowInput {
  memberId: string;
  ensembleId: string;
  runId: string;
  scope: LabSimulatorScope;
  seq: number;
  memberSeed: string;
  configId: string;
  configVersion: number;
}

export class LabSimulatorStore {
  private readonly db: DbTransaction;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: DbTransaction, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  nowIso(): string {
    return this.clock.nowIso();
  }

  newId(): string {
    return this.ids.newId();
  }

  // --- world configurations ---

  async insertWorldConfig(input: InsertWorldConfigRowInput): Promise<WorldConfigRow> {
    const r = await this.db.query<WorldConfigRow>(
      `INSERT INTO lab_simulator_world_configs
         (config_id, config_version, world_model_version, rng_id, rng_version,
          knobs, config_digest, modeling_basis, agency_id, client_id, workspace_id,
          contract_version, created_at)
       VALUES ($1, $2, 'lab-worldmodel-v1', 'lab-simulator-splitmix64', 'lab-sim-rng-v1',
               $3::jsonb, $4, 'declared_world_model_assumptions', $5, $6, $7,
               'lab-simulator-contract-v1', $8::timestamptz)
       RETURNING *`,
      [
        input.configId,
        input.configVersion,
        input.knobsJson,
        input.configDigest,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async findWorldConfigByDigest(clientId: string, configDigest: string): Promise<WorldConfigRow | null> {
    const r = await this.db.query<WorldConfigRow>(
      `SELECT * FROM lab_simulator_world_configs
        WHERE client_id = $1 AND config_digest = $2`,
      [clientId, configDigest],
    );
    return r.rows[0] ?? null;
  }

  async findWorldConfig(clientId: string, configId: string, configVersion: number | null): Promise<WorldConfigRow | null> {
    if (configVersion === null) {
      const r = await this.db.query<WorldConfigRow>(
        `SELECT * FROM lab_simulator_world_configs
          WHERE client_id = $1 AND config_id = $2
          ORDER BY config_version DESC
          LIMIT 1`,
        [clientId, configId],
      );
      return r.rows[0] ?? null;
    }
    const r = await this.db.query<WorldConfigRow>(
      `SELECT * FROM lab_simulator_world_configs
        WHERE client_id = $1 AND config_id = $2 AND config_version = $3`,
      [clientId, configId, configVersion],
    );
    return r.rows[0] ?? null;
  }

  async findLatestWorldConfigVersion(clientId: string, configId: string): Promise<number> {
    const r = await this.db.query<{ max_version: number | string | null }>(
      `SELECT max(config_version) AS max_version FROM lab_simulator_world_configs
        WHERE client_id = $1 AND config_id = $2`,
      [clientId, configId],
    );
    const max = r.rows[0]?.max_version;
    return max === null || max === undefined ? 0 : Number(max);
  }

  async listWorldConfigs(clientId: string): Promise<WorldConfigRow[]> {
    // The latest version of each chain, newest first.
    const r = await this.db.query<WorldConfigRow>(
      `SELECT DISTINCT ON (config_id) * FROM lab_simulator_world_configs
        WHERE client_id = $1
        ORDER BY config_id, config_version DESC`,
      [clientId],
    );
    return [...r.rows].sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.config_id < b.config_id ? -1 : 1),
    );
  }

  // --- seeds ---

  async insertSeed(input: InsertSeedRowInput): Promise<SeedRow> {
    const r = await this.db.query<SeedRow>(
      `INSERT INTO lab_simulator_seeds
         (seed_id, master_seed, derived, config_id, config_version, config_digest,
          seed_digest, agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6,
               $7, $8, $9, $10, 'lab-simulator-contract-v1', $11::timestamptz)
       RETURNING *`,
      [
        input.seedId,
        input.masterSeed,
        input.derivedJson,
        input.configId,
        input.configVersion,
        input.configDigest,
        input.seedDigest,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async findSeedByDigest(clientId: string, seedDigest: string): Promise<SeedRow | null> {
    const r = await this.db.query<SeedRow>(
      `SELECT * FROM lab_simulator_seeds
        WHERE client_id = $1 AND seed_digest = $2`,
      [clientId, seedDigest],
    );
    return r.rows[0] ?? null;
  }

  async findSeed(clientId: string, seedId: string): Promise<SeedRow | null> {
    const r = await this.db.query<SeedRow>(
      `SELECT * FROM lab_simulator_seeds
        WHERE client_id = $1 AND seed_id = $2`,
      [clientId, seedId],
    );
    return r.rows[0] ?? null;
  }

  // --- runs ---

  async insertRun(input: InsertRunRowInput): Promise<RunRow> {
    const r = await this.db.query<RunRow>(
      `INSERT INTO lab_simulator_runs
         (run_id, status, seed_id, config_id, config_version, config_digest,
          engine_version, factuality, deterministic_replay, replay_of_run_id, replay_verified,
          step_budget, publishing_plan, content_universe,
          agency_id, client_id, workspace_id, contract_version, created_at, updated_at)
       VALUES ($1, 'running', $2, $3, $4, $5,
               'lab-sim-engine-v1', 'simulated_model_output', $6, $7, $8,
               $9, $10::jsonb, $11::jsonb,
               $12, $13, $14, 'lab-simulator-contract-v1', $15::timestamptz, $15::timestamptz)
       RETURNING *`,
      [
        input.runId,
        input.seedId,
        input.configId,
        input.configVersion,
        input.configDigest,
        input.deterministicReplay,
        input.replayOfRunId,
        input.deterministicReplay ? true : null,
        input.stepBudget,
        input.publishingPlanJson,
        input.contentUniverseJson,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  /**
   * THE COMPLETION ADVANCE: the single guarded running → completed
   * transition with the summary SQL-COMPUTED from the step rows
   * (never asserted separately) + the trajectory digest (the pure
   * SHA-256 chain over the recorded step digests).
   */
  async completeRun(runId: string, trajectoryDigest: string): Promise<RunRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<RunRow>(
      `UPDATE lab_simulator_runs
          SET status = 'completed',
              step_count = (SELECT count(*) FROM lab_simulator_run_steps WHERE run_id = $1),
              total_impressions = (SELECT coalesce(sum(impressions), 0) FROM lab_simulator_run_steps WHERE run_id = $1),
              total_views = (SELECT coalesce(sum(views), 0) FROM lab_simulator_run_steps WHERE run_id = $1),
              total_engagements = (SELECT coalesce(sum(engagements), 0) FROM lab_simulator_run_steps WHERE run_id = $1),
              total_shares = (SELECT coalesce(sum(shares), 0) FROM lab_simulator_run_steps WHERE run_id = $1),
              total_clicks = (SELECT coalesce(sum(clicks), 0) FROM lab_simulator_run_steps WHERE run_id = $1),
              total_conversions = (SELECT coalesce(sum(conversions), 0) FROM lab_simulator_run_steps WHERE run_id = $1),
              total_revenue = (SELECT coalesce(sum(revenue), 0) FROM lab_simulator_run_steps WHERE run_id = $1),
              total_followers_gained = (SELECT coalesce(sum(followers_gained), 0) FROM lab_simulator_run_steps WHERE run_id = $1),
              trajectory_digest = $2,
              updated_at = $3::timestamptz
        WHERE run_id = $1 AND status = 'running'
        RETURNING *`,
      [runId, trajectoryDigest, now],
    );
    return r.rows[0] ?? null;
  }

  async findRun(clientId: string, runId: string): Promise<RunRow | null> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM lab_simulator_runs
        WHERE client_id = $1 AND run_id = $2`,
      [clientId, runId],
    );
    return r.rows[0] ?? null;
  }

  async listRuns(clientId: string): Promise<RunRow[]> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM lab_simulator_runs
        WHERE client_id = $1
        ORDER BY created_at DESC, run_id`,
      [clientId],
    );
    return [...r.rows];
  }

  // --- steps ---

  async insertStep(input: InsertStepRowInput): Promise<StepRow> {
    const r = await this.db.query<StepRow>(
      `INSERT INTO lab_simulator_run_steps
         (step_id, run_id, seq, candidates, exposure, interactions, competitor_posts, topic_trends,
          impressions, views, engagements, shares, clicks, conversions, revenue, followers_gained,
          competitor_post_count, step_digest, agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
               $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20, $21, 'lab-simulator-contract-v1', $22::timestamptz)
       RETURNING *`,
      [
        input.stepId,
        input.runId,
        input.seq,
        input.candidatesJson,
        input.exposureJson,
        input.interactionsJson,
        input.competitorPostsJson,
        input.topicTrendsJson,
        input.impressions,
        input.views,
        input.engagements,
        input.shares,
        input.clicks,
        input.conversions,
        input.revenue,
        input.followersGained,
        input.competitorPostCount,
        input.stepDigest,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async findStep(runId: string, seq: number): Promise<StepRow | null> {
    const r = await this.db.query<StepRow>(
      `SELECT * FROM lab_simulator_run_steps
        WHERE run_id = $1 AND seq = $2`,
      [runId, seq],
    );
    return r.rows[0] ?? null;
  }

  async listSteps(runId: string): Promise<StepRow[]> {
    const r = await this.db.query<StepRow>(
      `SELECT * FROM lab_simulator_run_steps
        WHERE run_id = $1
        ORDER BY seq ASC`,
      [runId],
    );
    return [...r.rows];
  }

  // --- observable snapshots ---

  async insertObservableSnapshot(input: InsertObservableSnapshotRowInput): Promise<ObservableSnapshotRow> {
    const r = await this.db.query<ObservableSnapshotRow>(
      `INSERT INTO lab_simulator_observable_snapshots
         (snapshot_id, run_id, seq, observable_state, observable_digest,
          agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5,
               $6, $7, $8, 'lab-simulator-contract-v1', $9::timestamptz)
       RETURNING *`,
      [
        input.snapshotId,
        input.runId,
        input.seq,
        input.observableStateJson,
        input.observableDigest,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async findObservableSnapshot(runId: string, seq: number): Promise<ObservableSnapshotRow | null> {
    const r = await this.db.query<ObservableSnapshotRow>(
      `SELECT * FROM lab_simulator_observable_snapshots
        WHERE run_id = $1 AND seq = $2`,
      [runId, seq],
    );
    return r.rows[0] ?? null;
  }

  async listObservableSnapshots(runId: string): Promise<ObservableSnapshotRow[]> {
    const r = await this.db.query<ObservableSnapshotRow>(
      `SELECT * FROM lab_simulator_observable_snapshots
        WHERE run_id = $1
        ORDER BY seq ASC`,
      [runId],
    );
    return [...r.rows];
  }

  // --- ensembles ---

  async insertEnsemble(input: InsertEnsembleRowInput): Promise<EnsembleRow> {
    const r = await this.db.query<EnsembleRow>(
      `INSERT INTO lab_simulator_ensembles
         (ensemble_id, status, member_count, ensemble_seed, outcome_metric, config_citations,
          agency_id, client_id, workspace_id, contract_version, created_at, updated_at)
       VALUES ($1, 'running', $2, $3, $4, $5::jsonb,
               $6, $7, $8, 'lab-simulator-contract-v1', $9::timestamptz, $9::timestamptz)
       RETURNING *`,
      [
        input.ensembleId,
        input.memberCount,
        input.ensembleSeed,
        input.outcomeMetric,
        input.configCitationsJson,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  /**
   * THE ENSEMBLE COMPLETION ADVANCE: the single guarded running →
   * completed transition with the §13 uncertainty summary
   * SQL-COMPUTED from the member runs (the mean/min/max outcome over
   * the declared outcome metric + the agreement fraction — the
   * majority side of the mean — and its complement).
   */
  async completeEnsemble(ensembleId: string, outcomeMetric: LabSimulatorOutcomeMetric): Promise<EnsembleRow | null> {
    const now = this.nowIso();
    const outcomeColumn = OUTCOME_COLUMNS[outcomeMetric]!;
    const r = await this.db.query<EnsembleRow>(
      `WITH member_outcomes AS (
           SELECT r.${outcomeColumn}::numeric AS outcome
             FROM lab_simulator_ensemble_members m
             JOIN lab_simulator_runs r ON r.run_id = m.run_id
            WHERE m.ensemble_id = $1
       ),
       ensemble_stats AS (
           SELECT avg(outcome) AS mean_outcome, min(outcome) AS min_outcome,
                  max(outcome) AS max_outcome, count(*) AS n
             FROM member_outcomes
       ),
       sides AS (
           SELECT mo.outcome, es.mean_outcome
             FROM member_outcomes mo CROSS JOIN ensemble_stats es
       ),
       agreement AS (
           SELECT greatest(
                      count(*) FILTER (WHERE outcome >= mean_outcome),
                      count(*) FILTER (WHERE outcome < mean_outcome)
                  )::numeric / (SELECT n FROM ensemble_stats) AS agreement_fraction
             FROM sides
       )
       UPDATE lab_simulator_ensembles e
          SET status = 'completed',
              mean_outcome = (SELECT mean_outcome FROM ensemble_stats),
              min_outcome = (SELECT min_outcome FROM ensemble_stats),
              max_outcome = (SELECT max_outcome FROM ensemble_stats),
              agreement_fraction = (SELECT agreement_fraction FROM agreement),
              disagreement_fraction = 1 - (SELECT agreement_fraction FROM agreement),
              updated_at = $2::timestamptz
        WHERE e.ensemble_id = $1 AND e.status = 'running'
        RETURNING e.*`,
      [ensembleId, now],
    );
    return r.rows[0] ?? null;
  }

  async findEnsemble(clientId: string, ensembleId: string): Promise<EnsembleRow | null> {
    const r = await this.db.query<EnsembleRow>(
      `SELECT * FROM lab_simulator_ensembles
        WHERE client_id = $1 AND ensemble_id = $2`,
      [clientId, ensembleId],
    );
    return r.rows[0] ?? null;
  }

  async listEnsembleMembers(ensembleId: string): Promise<EnsembleMemberRow[]> {
    const r = await this.db.query<EnsembleMemberRow>(
      `SELECT * FROM lab_simulator_ensemble_members
        WHERE ensemble_id = $1
        ORDER BY seq ASC`,
      [ensembleId],
    );
    return [...r.rows];
  }

  async insertEnsembleMember(input: InsertEnsembleMemberRowInput): Promise<EnsembleMemberRow> {
    const r = await this.db.query<EnsembleMemberRow>(
      `INSERT INTO lab_simulator_ensemble_members
         (member_id, ensemble_id, run_id, seq, member_seed, config_id, config_version,
          agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, 'lab-simulator-contract-v1', $11::timestamptz)
       RETURNING *`,
      [
        input.memberId,
        input.ensembleId,
        input.runId,
        input.seq,
        input.memberSeed,
        input.configId,
        input.configVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }
}
