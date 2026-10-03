/**
 * /lab-simulator module implementation (LAB-005 — the Social
 * Simulator Kernel).
 *
 * THE ORCHESTRATION ONLY: this module composes the LabSimulatorStore
 * (the migration-071 tables) with the PURE contract guards of
 * validation.ts and the PURE deterministic engine of world-core.ts
 * (the LAB-003/LAB-004 orchestration precedent). The module consumes
 * platform ports only (db, clock, ids) — the frozen v1.7
 * no-cross-module-dependency discipline of the /lab family (zero
 * cross-module imports; the content-universe citations are OPAQUE
 * recorded data).
 *
 * THE RUN PIPELINE (the atomic-flow discipline — the LAB-004
 * judgment call #4 precedent):
 *
 *   1. shape gate      — the scope + input fences (a malformed input
 *                        is the honest whole-call rejection — nothing
 *                        is recorded, never a partial row);
 *   2. citation gates  — the seed record + the configuration resolve
 *                        under the tenant scope (the uniform NotFound;
 *                        the recorded-client tenant fence on every
 *                        universe citation);
 *   3. plan gates      — the publishing plan + the universe validate
 *                        against the configuration's DECLARED topics +
 *                        the DECLARED API/publishing constraints (a
 *                        plan that violates the declared platform
 *                        constraints fails closed BEFORE anything is
 *                        simulated);
 *   4. the pure engine — simulateLabTrajectory computes the whole
 *                        trajectory in memory (no clock, no I/O: the
 *                        step digests are computed from the recorded
 *                        content alone);
 *   5. THE ATOMIC WRITE — ONE transaction: the run born 'running' →
 *                        the step rows + the observable-snapshot rows
 *                        → the single completion advance with the
 *                        summary SQL-COMPUTED from the step rows (a
 *                        crash rolls the whole artifact back — no
 *                        partial state ever commits).
 *
 * THE DETERMINISTIC REPLAY (the core acceptance): the replay cites
 * the original run's seed + configuration (+ its recorded plan +
 * universe), re-runs the pure engine and VERIFIES the trajectory
 * step-for-step (every step digest + every observable digest) BEFORE
 * any row exists — a mismatch is the honest ConflictError with
 * nothing recorded; a match lands the replay with replayVerified.
 *
 * THE STOCHASTIC ENSEMBLE (§13): the member seeds derive
 * deterministically from the ensemble seed (NEW seeds — never the
 * original run's), the member configurations draw from the declared
 * configuration space, and the whole family lands atomically with the
 * agreement/disagreement SQL-computed at the single completion
 * advance (a single run is never ground truth).
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import {
  LAB_SIMULATOR_DEFAULT_OUTCOME_METRIC,
  LAB_SIMULATOR_MAX_CONFIG_VERSIONS,
  LAB_SIMULATOR_RNG_LABELS,
  type CreateLabSimulatorEnsembleInput,
  type CreateLabSimulatorReplayRunInput,
  type CreateLabSimulatorSeedInput,
  type CreateLabSimulatorWorldConfigInput,
  type LabSimulatorEngineStep,
  type LabSimulatorModuleApi,
  type LabSimulatorModuleDeps,
  type LabSimulatorRunRecord,
  type LabSimulatorScope,
  type LabSimulatorSeedRecord,
  type LabSimulatorWorldConfigRecord,
  type LabSimulatorWorldKnobs,
  type RunLabSimulationInput,
} from '../public.ts';
import {
  assertValidLabSimulatorCreateConfigInput,
  assertValidLabSimulatorCreateSeedInput,
  assertValidLabSimulatorEnsembleInput,
  assertValidLabSimulatorKnobs,
  assertValidLabSimulatorMasterSeed,
  assertValidLabSimulatorPublishingPlan,
  assertValidLabSimulatorRunInput,
  assertValidLabSimulatorScope,
  assertValidLabSimulatorUniverse,
  computeLabSimulatorConfigDigest,
  computeLabSimulatorSeedDigest,
} from './validation.ts';
import { deriveLabSimulatorSeed } from './rng.ts';
import { simulateLabTrajectory } from './world-core.ts';
import {
  LabSimulatorStore,
  mapEnsembleMemberRow,
  mapEnsembleRow,
  mapObservableSnapshotRow,
  mapRunRow,
  mapSeedRow,
  mapStepRow,
  mapWorldConfigRow,
  type RunRow,
  type WorldConfigRow,
} from './simulator-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createLabSimulatorModule(deps: LabSimulatorModuleDeps): LabSimulatorModuleApi {
  const store = new LabSimulatorStore(deps.db, deps.clock, deps.ids);

  /** Runs the body against a transaction-bound store. */
  const withTx = <T>(body: (txStore: LabSimulatorStore) => Promise<T>): Promise<T> =>
    deps.db.transaction((tx) => body(new LabSimulatorStore(tx, deps.clock, deps.ids)));

  // -------------------------------------------------------------------
  // The shared resolution + simulation helpers.
  // -------------------------------------------------------------------

  const requireConfig = async (
    scope: LabSimulatorScope,
    configId: string,
    configVersion: number | null,
  ): Promise<WorldConfigRow> => {
    if (!UUID_PATTERN.test(String(configId))) {
      throw new NotFoundError('lab simulator world configuration', String(configId));
    }
    if (configVersion !== null && (!Number.isInteger(configVersion) || configVersion < 1 || configVersion > LAB_SIMULATOR_MAX_CONFIG_VERSIONS)) {
      throw new NotFoundError('lab simulator world configuration', `${configId} v${configVersion}`);
    }
    const row = await store.findWorldConfig(scope.clientId, configId, configVersion);
    if (row === null) {
      throw new NotFoundError('lab simulator world configuration', configId);
    }
    return row;
  };

  const requireSeed = async (scope: LabSimulatorScope, seedId: string): Promise<LabSimulatorSeedRecord> => {
    if (!UUID_PATTERN.test(String(seedId))) {
      throw new NotFoundError('lab simulator seed', String(seedId));
    }
    const row = await store.findSeed(scope.clientId, seedId);
    if (row === null) {
      throw new NotFoundError('lab simulator seed', seedId);
    }
    return mapSeedRow(row);
  };

  /**
   * The gates + the pure engine run: resolves the seed + configuration,
   * validates the universe + the plan against the DECLARED knobs, and
   * computes the whole trajectory in memory (nothing recorded).
   */
  const computeTrajectory = async (
    scope: LabSimulatorScope,
    seed: LabSimulatorSeedRecord,
    stepBudget: number,
    publishingPlan: RunLabSimulationInput['publishingPlan'],
    contentUniverse: RunLabSimulationInput['contentUniverse'],
  ) => {
    const config = await requireConfig(scope, seed.configId, seed.configVersion);
    const knobs = config.knobs as LabSimulatorWorldKnobs;
    // The knob echo is re-validated on read (the recorded data must
    // still satisfy the closed vocabulary — the shape fence).
    assertValidLabSimulatorKnobs(knobs);
    const topicNames = new Set<string>(knobs.topics.map((topic) => topic.name));
    assertValidLabSimulatorUniverse(scope, contentUniverse, topicNames);
    assertValidLabSimulatorPublishingPlan(publishingPlan, contentUniverse.length, stepBudget, knobs.constraints);
    const trajectory = simulateLabTrajectory({
      knobs,
      masterSeed: seed.masterSeed,
      stepBudget,
      publishingPlan,
      contentUniverse,
    });
    return { config, knobs, trajectory };
  };

  /**
   * THE ATOMIC WRITE: the run born 'running' → the step rows + the
   * observable-snapshot rows → the single completion advance (the
   * summary SQL-computed from the step rows).
   */
  const landRun = async (
    txStore: LabSimulatorStore,
    input: {
      scope: LabSimulatorScope;
      seed: LabSimulatorSeedRecord;
      config: WorldConfigRow;
      stepBudget: number;
      publishingPlan: RunLabSimulationInput['publishingPlan'];
      contentUniverse: RunLabSimulationInput['contentUniverse'];
      trajectory: ReturnType<typeof simulateLabTrajectory>;
      deterministicReplay: boolean;
      replayOfRunId: string | null;
    },
  ): Promise<RunRow> => {
    const runId = txStore.newId();
    await txStore.insertRun({
        runId,
        scope: input.scope,
        seedId: input.seed.seedId,
        configId: input.config.config_id,
        configVersion: Number(input.config.config_version),
        configDigest: input.config.config_digest,
        deterministicReplay: input.deterministicReplay,
        replayOfRunId: input.replayOfRunId,
        stepBudget: input.stepBudget,
        publishingPlanJson: JSON.stringify(input.publishingPlan),
        contentUniverseJson: JSON.stringify(input.contentUniverse),
      });
      for (const step of input.trajectory.steps) {
        await txStore.insertStep({
          stepId: txStore.newId(),
          runId,
          scope: input.scope,
          seq: step.seq,
          candidatesJson: JSON.stringify(step.candidates),
          exposureJson: JSON.stringify(step.exposure),
          interactionsJson: JSON.stringify(step.interactions),
          competitorPostsJson: JSON.stringify(step.competitorPosts),
          topicTrendsJson: JSON.stringify(step.topicTrends),
          impressions: step.metrics.impressions,
          views: step.metrics.views,
          engagements: step.metrics.engagements,
          shares: step.metrics.shares,
          clicks: step.metrics.clicks,
          conversions: step.metrics.conversions,
          revenue: step.metrics.revenue,
          followersGained: step.metrics.followersGained,
          competitorPostCount: step.metrics.competitorPostCount,
          stepDigest: step.stepDigest,
        });
        await txStore.insertObservableSnapshot({
          snapshotId: txStore.newId(),
          runId,
          scope: input.scope,
          seq: step.seq,
          observableStateJson: JSON.stringify(step.observableState),
          observableDigest: step.observableDigest,
        });
      }
      const completed = await txStore.completeRun(runId, input.trajectory.trajectoryDigest);
      if (completed === null) {
        throw new InvalidRequestError('the simulator run completion advance failed');
      }
      return completed;
  };

  /** The step-for-step reproduction check: every step digest + observable digest must match. */
  const verifyReproduction = (
    originalSteps: ReadonlyArray<{ seq: number; stepDigest: string; observableDigest: string }>,
    replaySteps: ReadonlyArray<LabSimulatorEngineStep>,
    original: RunRow,
  ): void => {
    if (originalSteps.length !== replaySteps.length) {
      throw new ConflictError(
        `the engine failed to reproduce run ${original.run_id}: the original trajectory holds ${originalSteps.length} steps, the re-run holds ${replaySteps.length} — nothing recorded (the honest conflict)`,
      );
    }
    for (let i = 0; i < originalSteps.length; i += 1) {
      const originalStep = originalSteps[i]!;
      const replayStep = replaySteps[i]!;
      if (originalStep.seq !== replayStep.seq || originalStep.stepDigest !== replayStep.stepDigest) {
        throw new ConflictError(
          `the engine failed to reproduce run ${original.run_id} step-for-step (step ${originalStep.seq}: the recorded step digest ${originalStep.stepDigest} ≠ the re-run ${replayStep.stepDigest}) — nothing recorded (the honest conflict)`,
        );
      }
      if (originalStep.observableDigest !== replayStep.observableDigest) {
        throw new ConflictError(
          `the engine failed to reproduce run ${original.run_id} step-for-step (step ${originalStep.seq}: the recorded observable digest differs) — nothing recorded (the honest conflict)`,
        );
      }
    }
  };

  // -------------------------------------------------------------------
  // The public API.
  // -------------------------------------------------------------------

  return {
    async createWorldConfig(input: CreateLabSimulatorWorldConfigInput): Promise<LabSimulatorWorldConfigRecord> {
      assertValidLabSimulatorCreateConfigInput(input);
      const scope = input.scope;
      const configDigest = computeLabSimulatorConfigDigest(input.knobs);

      // The deterministic identity idempotence probe: the same knobs
      // + pinned versions are the same configuration, ever.
      const existing = await store.findWorldConfigByDigest(scope.clientId, configDigest);
      if (existing !== null) {
        return mapWorldConfigRow(existing);
      }

      // The chain resolution: extending an existing chain vs a fresh one.
      let configId = input.configId ?? null;
      let nextVersion = 1;
      if (configId !== null) {
        if (!UUID_PATTERN.test(configId)) {
          throw new NotFoundError('lab simulator world configuration', configId);
        }
        const latest = await store.findLatestWorldConfigVersion(scope.clientId, configId);
        if (latest === 0) {
          throw new NotFoundError('lab simulator world configuration', configId);
        }
        nextVersion = latest + 1;
        if (nextVersion > LAB_SIMULATOR_MAX_CONFIG_VERSIONS) {
          throw new InvalidRequestError(
            `the configuration chain ${configId} reached the ${LAB_SIMULATOR_MAX_CONFIG_VERSIONS}-version bound`,
          );
        }
      } else {
        configId = store.newId();
      }

      const inserted = await store.insertWorldConfig({
        configId,
        configVersion: nextVersion,
        scope,
        knobsJson: JSON.stringify(input.knobs),
        configDigest,
      });
      return mapWorldConfigRow(inserted);
    },

    async getWorldConfig(scope, configId, configVersion) {
      assertValidLabSimulatorScope(scope);
      const version = configVersion === undefined || configVersion === null ? null : configVersion;
      return mapWorldConfigRow(await requireConfig(scope, configId, version));
    },

    async listWorldConfigs(scope) {
      assertValidLabSimulatorScope(scope);
      const rows = await store.listWorldConfigs(scope.clientId);
      return rows.map(mapWorldConfigRow);
    },

    async createSeed(input: CreateLabSimulatorSeedInput): Promise<LabSimulatorSeedRecord> {
      assertValidLabSimulatorCreateSeedInput(input);
      const scope = input.scope;

      // The cited configuration must resolve under the tenant scope.
      const configRow = await requireConfig(scope, input.configId, input.configVersion);
      const seedDigest = computeLabSimulatorSeedDigest(input.masterSeed, configRow.config_digest);

      // The deterministic identity idempotence probe: the same master
      // seed + configuration pair is the same seed record, ever.
      const existing = await store.findSeedByDigest(scope.clientId, seedDigest);
      if (existing !== null) {
        return mapSeedRow(existing);
      }

      // The derived-seed lineage (the declared RNG derivation — the
      // complete reproducibility input).
      const derived = LAB_SIMULATOR_RNG_LABELS.map((label) => ({
        label,
        seed: deriveLabSimulatorSeed(input.masterSeed, label),
      }));

      const inserted = await store.insertSeed({
        seedId: store.newId(),
        scope,
        masterSeed: input.masterSeed,
        derivedJson: JSON.stringify(derived),
        configId: input.configId,
        configVersion: input.configVersion,
        configDigest: configRow.config_digest,
        seedDigest,
      });
      return mapSeedRow(inserted);
    },

    async getSeed(scope, seedId) {
      assertValidLabSimulatorScope(scope);
      return requireSeed(scope, seedId);
    },

    async runSimulation(input: RunLabSimulationInput): Promise<LabSimulatorRunRecord> {
      assertValidLabSimulatorRunInput(input);
      const scope = input.scope;
      const seed = await requireSeed(scope, input.seedId);
      const { config, trajectory } = await computeTrajectory(
        scope,
        seed,
        input.stepBudget,
        input.publishingPlan,
        input.contentUniverse,
      );
      const completed = await withTx((txStore) =>
        landRun(txStore, {
          scope,
          seed,
          config,
          stepBudget: input.stepBudget,
          publishingPlan: input.publishingPlan,
          contentUniverse: input.contentUniverse,
          trajectory,
          deterministicReplay: false,
          replayOfRunId: null,
        }),
      );
      return mapRunRow(completed);
    },

    async createReplayRun(input: CreateLabSimulatorReplayRunInput): Promise<LabSimulatorRunRecord> {
      assertValidLabSimulatorScope(input.scope);
      if (!UUID_PATTERN.test(String(input.runId))) {
        throw new NotFoundError('lab simulator run', String(input.runId));
      }
      const originalRow = await store.findRun(input.scope.clientId, input.runId);
      if (originalRow === null) {
        throw new NotFoundError('lab simulator run', input.runId);
      }
      if (originalRow.status !== 'completed') {
        throw new ConflictError(
          `run ${originalRow.run_id} is not completed — only a completed run's trajectory can be reproduced (the honest conflict)`,
        );
      }
      const original = mapRunRow(originalRow);

      // THE REPLAY INPUT: the original run's recorded seed +
      // configuration + plan + universe (the complete reproducibility
      // input set, copied from the recorded row).
      const seed = await requireSeed(input.scope, original.seedId);
      const { config, trajectory } = await computeTrajectory(
        input.scope,
        seed,
        original.stepBudget,
        original.publishingPlan,
        original.contentUniverse,
      );

      // THE STEP-FOR-STEP VERIFICATION: the recorded steps of the
      // original vs the re-run (every step digest + observable digest)
      // — BEFORE any row exists. A mismatch is the honest conflict
      // with nothing recorded.
      const originalSteps = (await store.listSteps(original.runId)).map((row) => ({
        seq: Number(row.seq),
        stepDigest: row.step_digest,
        observableDigest: '',
      }));
      // The observable digests ride the snapshot tail.
      const snapshots = await store.listObservableSnapshots(original.runId);
      const observableBySeq = new Map(snapshots.map((row) => [Number(row.seq), row.observable_digest]));
      for (const step of originalSteps) {
        step.observableDigest = observableBySeq.get(step.seq) ?? '';
      }
      verifyReproduction(originalSteps, trajectory.steps, originalRow);

      const completed = await withTx((txStore) =>
        landRun(txStore, {
          scope: input.scope,
          seed,
          config,
          stepBudget: original.stepBudget,
          publishingPlan: original.publishingPlan,
          contentUniverse: original.contentUniverse,
          trajectory,
          deterministicReplay: true,
          replayOfRunId: original.runId,
        }),
      );
      return mapRunRow(completed);
    },

    async getRun(scope, runId) {
      assertValidLabSimulatorScope(scope);
      if (!UUID_PATTERN.test(String(runId))) {
        throw new NotFoundError('lab simulator run', String(runId));
      }
      const row = await store.findRun(scope.clientId, runId);
      if (row === null) {
        throw new NotFoundError('lab simulator run', runId);
      }
      return mapRunRow(row);
    },

    async listRuns(scope) {
      assertValidLabSimulatorScope(scope);
      const rows = await store.listRuns(scope.clientId);
      return rows.map(mapRunRow);
    },

    async getStep(scope, runId, seq) {
      assertValidLabSimulatorScope(scope);
      if (!UUID_PATTERN.test(String(runId))) {
        throw new NotFoundError('lab simulator run', String(runId));
      }
      const runRow = await store.findRun(scope.clientId, runId);
      if (runRow === null) {
        throw new NotFoundError('lab simulator run', runId);
      }
      if (!Number.isInteger(seq) || seq < 1 || seq > Number(runRow.step_budget)) {
        throw new NotFoundError('lab simulator run step', `${runId} #${seq}`);
      }
      const row = await store.findStep(runId, seq);
      if (row === null) {
        throw new NotFoundError('lab simulator run step', `${runId} #${seq}`);
      }
      return mapStepRow(row);
    },

    async listSteps(scope, runId) {
      assertValidLabSimulatorScope(scope);
      if (!UUID_PATTERN.test(String(runId))) {
        throw new NotFoundError('lab simulator run', String(runId));
      }
      const runRow = await store.findRun(scope.clientId, runId);
      if (runRow === null) {
        throw new NotFoundError('lab simulator run', runId);
      }
      const rows = await store.listSteps(runId);
      return rows.map(mapStepRow);
    },

    async getObservableSnapshot(scope, runId, seq) {
      assertValidLabSimulatorScope(scope);
      if (!UUID_PATTERN.test(String(runId))) {
        throw new NotFoundError('lab simulator run', String(runId));
      }
      const runRow = await store.findRun(scope.clientId, runId);
      if (runRow === null) {
        throw new NotFoundError('lab simulator run', runId);
      }
      if (!Number.isInteger(seq) || seq < 1 || seq > Number(runRow.step_budget)) {
        throw new NotFoundError('lab simulator observable snapshot', `${runId} #${seq}`);
      }
      const row = await store.findObservableSnapshot(runId, seq);
      if (row === null) {
        throw new NotFoundError('lab simulator observable snapshot', `${runId} #${seq}`);
      }
      return mapObservableSnapshotRow(row);
    },

    async listObservableSnapshots(scope, runId) {
      assertValidLabSimulatorScope(scope);
      if (!UUID_PATTERN.test(String(runId))) {
        throw new NotFoundError('lab simulator run', String(runId));
      }
      const runRow = await store.findRun(scope.clientId, runId);
      if (runRow === null) {
        throw new NotFoundError('lab simulator run', runId);
      }
      const rows = await store.listObservableSnapshots(runId);
      return rows.map(mapObservableSnapshotRow);
    },

    async createEnsemble(input: CreateLabSimulatorEnsembleInput) {
      assertValidLabSimulatorEnsembleInput(input);
      const scope = input.scope;
      const outcomeMetric = input.outcomeMetric ?? LAB_SIMULATOR_DEFAULT_OUTCOME_METRIC;

      // The declared configuration space resolves under the tenant scope.
      const configRows: WorldConfigRow[] = [];
      for (const citation of input.configCitations) {
        configRows.push(await requireConfig(scope, citation.configId, citation.configVersion));
      }

      // The ensemble's own seed: the caller-declared sampling basis or
      // a fresh module-generated u64 (recorded on the row — the
      // sampling is reproducible from the record).
      let ensembleSeed = input.ensembleSeed ?? null;
      if (ensembleSeed === null) {
        const fresh = store.newId().replaceAll('-', '');
        ensembleSeed = BigInt(`0x${fresh.slice(0, 16)}`).toString(10);
      }
      assertValidLabSimulatorMasterSeed(ensembleSeed);

      const members = await withTx(async (txStore) => {
        const ensembleId = txStore.newId();
        await txStore.insertEnsemble({
          ensembleId,
          scope,
          memberCount: input.memberCount,
          ensembleSeed,
          outcomeMetric,
          configCitationsJson: JSON.stringify(
            input.configCitations.map((citation) => ({
              configId: citation.configId,
              configVersion: citation.configVersion,
            })),
          ),
        });
        for (let i = 1; i <= input.memberCount; i += 1) {
          // The member's sampled NEW seed (derived deterministically
          // from the ensemble seed — never an original run's seed).
          const memberSeed = deriveLabSimulatorSeed(ensembleSeed, `ensemble-member-${i}`);
          const memberConfig = configRows[(i - 1) % configRows.length]!;
          const seedDigest = computeLabSimulatorSeedDigest(memberSeed, memberConfig.config_digest);
          const existingSeed = await txStore.findSeedByDigest(scope.clientId, seedDigest);
          const seed: LabSimulatorSeedRecord =
            existingSeed !== null
              ? mapSeedRow(existingSeed)
              : mapSeedRow(
                  await txStore.insertSeed({
                    seedId: txStore.newId(),
                    scope,
                    masterSeed: memberSeed,
                    derivedJson: JSON.stringify(
                      LAB_SIMULATOR_RNG_LABELS.map((label) => ({
                        label,
                        seed: deriveLabSimulatorSeed(memberSeed, label),
                      })),
                    ),
                    configId: memberConfig.config_id,
                    configVersion: Number(memberConfig.config_version),
                    configDigest: memberConfig.config_digest,
                    seedDigest,
                  }),
                );
          const { trajectory } = await computeTrajectory(
            scope,
            seed,
            input.stepBudget,
            input.publishingPlan,
            input.contentUniverse,
          );
          const memberRun = await landRun(txStore, {
            scope,
            seed,
            config: memberConfig,
            stepBudget: input.stepBudget,
            publishingPlan: input.publishingPlan,
            contentUniverse: input.contentUniverse,
            trajectory,
            deterministicReplay: false,
            replayOfRunId: null,
          });
          await txStore.insertEnsembleMember({
            memberId: txStore.newId(),
            ensembleId,
            runId: memberRun.run_id,
            scope,
            seq: i,
            memberSeed,
            configId: memberConfig.config_id,
            configVersion: Number(memberConfig.config_version),
          });
        }
        const completed = await txStore.completeEnsemble(ensembleId, outcomeMetric);
        if (completed === null) {
          throw new InvalidRequestError('the ensemble completion advance failed');
        }
        return { ensembleId, completed };
      });

      const memberRows = await store.listEnsembleMembers(members.ensembleId);
      return mapEnsembleRow(members.completed, memberRows.map(mapEnsembleMemberRow));
    },

    async getEnsemble(scope, ensembleId) {
      assertValidLabSimulatorScope(scope);
      if (!UUID_PATTERN.test(String(ensembleId))) {
        throw new NotFoundError('lab simulator ensemble', String(ensembleId));
      }
      const row = await store.findEnsemble(scope.clientId, ensembleId);
      if (row === null) {
        throw new NotFoundError('lab simulator ensemble', ensembleId);
      }
      const memberRows = await store.listEnsembleMembers(ensembleId);
      return mapEnsembleRow(row, memberRows.map(mapEnsembleMemberRow));
    },
  };
}
