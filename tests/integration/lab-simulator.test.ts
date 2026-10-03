/**
 * LAB-005 integration tests — the /lab-simulator Social Simulator
 * Kernel against a REAL embedded PostgreSQL stack (the LAB-003/LAB-004
 * module-level harness: real PgDb + real users/agencies/clients public
 * contracts, the simulator module under test composed exactly as the
 * composition root wires it — platform ports only).
 *
 * The acceptance battery (spec/effective-backlog-v1.7.md LAB-005
 * "deterministic seeded replay plus stochastic runs; no invented hidden
 * provider state"):
 *   (a) the world-model configuration — the versioned, immutable knob
 *       records with the deterministic digest idempotence + the
 *       append-only version chains + the modeling-basis label;
 *   (b) the seed records — the recorded seed + configuration pair with
 *       the derived-seed lineage + the digest idempotence;
 *   (c) the simulation run — the bounded interaction loop landing
 *       atomically (born running → the steps + the observable
 *       snapshots → the single completion advance with the summary
 *       SQL-computed), the §22 workspace anchor, the factuality label;
 *   (d) THE DETERMINISTIC SEEDED REPLAY (the core acceptance proof) —
 *       the replay run cites the original's seed + configuration and
 *       reproduces its trajectory step-for-step (every step digest +
 *       observable digest + the trajectory digest + the SQL-computed
 *       totals equal);
 *   (e) THE STOCHASTIC ENSEMBLE (§13) — the member family over NEW
 *       sampled seeds on the declared configuration space with the
 *       agreement/disagreement SQL-computed; a single run is never
 *       ground truth;
 *   (f) the observable/hidden split — the agent-facing snapshot
 *       surface carries ONLY observable state;
 *   (g) tenant isolation (§22) — the uniform NotFound for foreign
 *       scope (no existence oracle), the recorded-client citation
 *       gate, and the DB-level cross-tenant injection triggers;
 *   (h) the DB backstops — the append-only triggers (configurations,
 *       seeds, steps, snapshots, members reject UPDATE and DELETE),
 *       the run/ensemble guards (the single completion advance,
 *       identity immutability), the replay fences.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootStack,
  shutdownStack,
  type IntegrationStack,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { createUsersModule } from '../../src/modules/users/public.ts';
import { createAgenciesModule } from '../../src/modules/agencies/public.ts';
import { createClientsModule } from '../../src/modules/clients/public.ts';
import { createWorkspacesModule } from '../../src/modules/workspaces/public.ts';
import {
  createLabSimulatorModule,
  LAB_SIMULATOR_CONTRACT_VERSION,
  LAB_SIMULATOR_WORLD_MODEL_VERSION,
  LAB_SIMULATOR_ENGINE_VERSION,
  LAB_SIMULATOR_RNG_ID,
  LAB_SIMULATOR_RNG_VERSION,
  LAB_SIMULATOR_MODELING_BASIS,
  LAB_SIMULATOR_FACTUALITY,
  LAB_SIMULATOR_RANKING_DISCLOSURE,
} from '../../src/modules/lab-simulator/public.ts';
import type {
  LabSimulatorModuleApi,
  LabSimulatorScope,
  LabSimulatorWorldKnobs,
  LabSimulatorUniverseItemCitation,
} from '../../src/modules/lab-simulator/public.ts';
import { InvalidRequestError, NotFoundError } from '../../src/platform/errors/errors.ts';

let stack: IntegrationStack | null = null;
let db: PgDb | null = null;
let clock: SystemClock | null = null;
let ids: CryptoIdGenerator | null = null;

let simulator: LabSimulatorModuleApi = null as unknown as LabSimulatorModuleApi;
let users: ReturnType<typeof createUsersModule> = null as unknown as ReturnType<typeof createUsersModule>;
let agencies: ReturnType<typeof createAgenciesModule> = null as unknown as ReturnType<typeof createAgenciesModule>;
let clients: ReturnType<typeof createClientsModule> = null as unknown as ReturnType<typeof createClientsModule>;
let workspaces: ReturnType<typeof createWorkspacesModule> = null as unknown as ReturnType<typeof createWorkspacesModule>;

const aliceScope: LabSimulatorScope = { agencyId: '', clientId: '' };
const bobScope: LabSimulatorScope = { agencyId: '', clientId: '' };
let aliceWorkspaceId: string | null = null;

function knobs(overrides: Partial<LabSimulatorWorldKnobs> = {}): LabSimulatorWorldKnobs {
  return {
    population: {
      totalUsers: 5_000,
      segments: [
        { name: 'core', share: 0.6, sessionRatePerStep: 0.8, affinity: { fitness: 0.8, gear: 0.5, cooking: -0.2 } },
        { name: 'casual', share: 0.4, sessionRatePerStep: 0.3, affinity: { fitness: 0.1, gear: 0, cooking: 0.7 } },
      ],
    },
    topics: [
      { name: 'fitness', baselineInterest: 0.6 },
      { name: 'gear', baselineInterest: 0.4 },
      { name: 'cooking', baselineInterest: 0.5 },
    ],
    fatigue: { incrementPerExposure: 0.2, decayPerStep: 0.1, responsePenalty: 0.3 },
    ranking: { exposureTopWeight: 1, exposureDecayPower: 1.2, explorationRate: 0.1, candidatePoolSize: 12 },
    trends: { volatility: 0.1, persistence: 0.8, seasonalityAmplitude: 0.2, seasonalityPeriodSteps: 30 },
    freshness: { halfLifeSteps: 6 },
    novelty: { noveltyBias: 0.2 },
    competition: { competitorCount: 8, competitorQualityMean: 0.45, competitorQualitySigma: 0.2, competitorPostsPerStep: 3 },
    account: { initialFollowers: 1200, followerGainPerEngagement: 0.4 },
    conversion: { viewToClickProbability: 0.06, clickToConversionProbability: 0.03, conversionValue: 24.5 },
    constraints: { maxAccountPostsPerStep: 2, minStepsBetweenPosts: 1 },
    interaction: { baseViewProbability: 0.3, engagePerViewProbability: 0.12, sharePerEngageProbability: 0.05, qualitySensitivity: 0.6 },
    ...overrides,
  };
}

function universe(): LabSimulatorUniverseItemCitation[] {
  return [
    { citationKind: 'lab-features-bundle', reference: '00000000-0000-0000-0000-0000000000bb#v1', recordedClientId: aliceScope.clientId, topic: 'fitness', quality: 0.8 },
    { citationKind: 'lab-ideas-node', reference: '00000000-0000-0000-0000-0000000000cd', recordedClientId: aliceScope.clientId, topic: 'gear', quality: 0.6 },
    { citationKind: 'lab-features-bundle', reference: '00000000-0000-0000-0000-0000000000be#v1', recordedClientId: aliceScope.clientId, topic: 'cooking', quality: 0.7 },
  ];
}

const PLAN = [
  { itemIndex: 0, atStep: 1 },
  { itemIndex: 1, atStep: 3 },
  { itemIndex: 2, atStep: 5 },
  { itemIndex: 0, atStep: 9 },
];

before(async () => {
  stack = await bootStack('lab_simulator');
  db = new PgDb(stack.env.databaseUrl, 4);
  clock = new SystemClock();
  ids = new CryptoIdGenerator();
  users = createUsersModule({ db, clock, ids });
  agencies = createAgenciesModule({ db, clock, ids, users });
  clients = createClientsModule({ db, clock, ids, agencies });
  workspaces = createWorkspacesModule({ db, clock, ids, clients });
  simulator = createLabSimulatorModule({ db, clock, ids });

  const aliceUser = await users.createUser({ email: 'alice@labsim.test', displayName: 'Alice' });
  const aliceAgency = await agencies.createAgency({ name: 'Alice Agency', slug: 'alice-labsim', ownerUserId: aliceUser.userId, actorId: null });
  const aliceClient = await clients.createClient({ agencyId: aliceAgency.agency.agencyId, name: 'Alice Client', slug: 'alice-client', actorId: null });
  aliceScope.agencyId = aliceAgency.agency.agencyId;
  aliceScope.clientId = aliceClient.clientId;
  const workspace = await workspaces.createWorkspace({ clientId: aliceClient.clientId, name: 'Alice WS', slug: undefined, actorId: null });
  aliceWorkspaceId = workspace.workspaceId;

  const bobUser = await users.createUser({ email: 'bob@labsim.test', displayName: 'Bob' });
  const bobAgency = await agencies.createAgency({ name: 'Bob Agency', slug: 'bob-labsim', ownerUserId: bobUser.userId, actorId: null });
  const bobClient = await clients.createClient({ agencyId: bobAgency.agency.agencyId, name: 'Bob Client', slug: 'bob-client', actorId: null });
  bobScope.agencyId = bobAgency.agency.agencyId;
  bobScope.clientId = bobClient.clientId;
});

after(async () => {
  if (db !== null) await db.close();
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// (a) The world-model configuration.
// ---------------------------------------------------------------------------

test('LAB-005: the world-model configuration — the versioned immutable knobs, the deterministic digest idempotence, the append-only chain, the declared-assumption labeling', async () => {
  const first = await simulator.createWorldConfig({ scope: aliceScope, knobs: knobs() });
  assert.equal(first.configVersion, 1);
  assert.equal(first.contractVersion, LAB_SIMULATOR_CONTRACT_VERSION);
  assert.equal(first.worldModelVersion, LAB_SIMULATOR_WORLD_MODEL_VERSION);
  assert.equal(first.rngId, LAB_SIMULATOR_RNG_ID);
  assert.equal(first.rngVersion, LAB_SIMULATOR_RNG_VERSION);
  assert.equal(first.modelingBasis, LAB_SIMULATOR_MODELING_BASIS);
  assert.match(first.configDigest, /^[0-9a-f]{64}$/);
  // THE DECLARED-ASSUMPTION DISCLOSURE ships on the public surface.
  assert.ok(LAB_SIMULATOR_RANKING_DISCLOSURE.includes('NOT claims about any provider'));

  // The deterministic digest idempotence: the same knobs are the same configuration.
  const again = await simulator.createWorldConfig({ scope: aliceScope, knobs: knobs() });
  assert.equal(again.configId, first.configId);
  assert.equal(again.configVersion, first.configVersion);

  // A changed knob set is a NEW version on the same chain (append-only).
  const changedKnobs = knobs({ fatigue: { incrementPerExposure: 0.25, decayPerStep: 0.1, responsePenalty: 0.3 } });
  const second = await simulator.createWorldConfig({ scope: aliceScope, knobs: changedKnobs, configId: first.configId });
  assert.equal(second.configId, first.configId);
  assert.equal(second.configVersion, 2);
  assert.notEqual(second.configDigest, first.configDigest);
  // The latest-version read resolves v2.
  const latest = await simulator.getWorldConfig(aliceScope, first.configId);
  assert.equal(latest.configVersion, 2);
  // The explicit-version read resolves v1.
  const pinned = await simulator.getWorldConfig(aliceScope, first.configId, 1);
  assert.equal(pinned.configVersion, 1);
  assert.deepEqual(pinned.knobs, knobs());

  // A malformed knob set is the honest whole-call rejection.
  await assert.rejects(
    () => simulator.createWorldConfig({ scope: aliceScope, knobs: knobs({ topics: [] }) }),
    InvalidRequestError,
  );
  // An unknown chain is the uniform NotFound (a DISTINCT knob set, so
  // the digest idempotence probe does not short-circuit to an existing
  // configuration).
  await assert.rejects(
    () =>
      simulator.createWorldConfig({
        scope: aliceScope,
        knobs: knobs({ novelty: { noveltyBias: 0.35 } }),
        configId: '00000000-0000-0000-0000-00000000dead',
      }),
    NotFoundError,
  );
});

// ---------------------------------------------------------------------------
// (b) The seed records.
// ---------------------------------------------------------------------------

test('LAB-005: the seed records — the recorded seed + configuration pair with the derived-seed lineage + the digest idempotence', async () => {
  const config = await simulator.getWorldConfig(aliceScope, (await simulator.listWorldConfigs(aliceScope))[0]!.configId);
  const seed = await simulator.createSeed({ scope: aliceScope, masterSeed: '12345678901234567', configId: config.configId, configVersion: config.configVersion });
  assert.equal(seed.masterSeed, '12345678901234567');
  assert.equal(seed.configId, config.configId);
  assert.equal(seed.configDigest, config.configDigest);
  assert.match(seed.seedDigest, /^[0-9a-f]{64}$/);
  // The derived-seed lineage: one entry per RNG label (the complete reproducibility input).
  assert.equal(seed.derived.length, 5);
  assert.deepEqual(
    seed.derived.map((entry) => entry.label),
    ['user-sessions', 'competition', 'trends', 'ranking', 'interactions'],
  );
  for (const entry of seed.derived) {
    assert.match(entry.seed, /^(0|[1-9][0-9]{0,19})$/);
  }
  // The deterministic seed digest idempotence: the same pair is the same seed record.
  const again = await simulator.createSeed({ scope: aliceScope, masterSeed: '12345678901234567', configId: config.configId, configVersion: config.configVersion });
  assert.equal(again.seedId, seed.seedId);
  // A different master seed is a different record.
  const other = await simulator.createSeed({ scope: aliceScope, masterSeed: '9876543210987654321', configId: config.configId, configVersion: config.configVersion });
  assert.notEqual(other.seedId, seed.seedId);
  // The u64 shape + the unknown-config rejections.
  await assert.rejects(() => simulator.createSeed({ scope: aliceScope, masterSeed: '18446744073709551616', configId: config.configId, configVersion: config.configVersion }), InvalidRequestError);
  await assert.rejects(() => simulator.createSeed({ scope: aliceScope, masterSeed: '5', configId: '00000000-0000-0000-0000-00000000dead', configVersion: 1 }), NotFoundError);
  await assert.rejects(() => simulator.createSeed({ scope: aliceScope, masterSeed: '5', configId: config.configId, configVersion: 77 }), NotFoundError);
});

// ---------------------------------------------------------------------------
// (c) The simulation run + (d) THE DETERMINISTIC SEEDED REPLAY.
// ---------------------------------------------------------------------------

test('LAB-005: the simulation run — the bounded interaction loop lands atomically with the summary SQL-computed; the observable snapshots ride the trajectory; the factuality label ships', async () => {
  const configs = await simulator.listWorldConfigs(aliceScope);
  const config = await simulator.getWorldConfig(aliceScope, configs[0]!.configId, 1);
  const seed = await simulator.createSeed({ scope: aliceScope, masterSeed: '12345678901234567', configId: config.configId, configVersion: 1 });

  const run = await simulator.runSimulation({
    scope: aliceScope,
    seedId: seed.seedId,
    stepBudget: 12,
    publishingPlan: PLAN,
    contentUniverse: universe(),
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.contractVersion, LAB_SIMULATOR_CONTRACT_VERSION);
  assert.equal(run.engineVersion, LAB_SIMULATOR_ENGINE_VERSION);
  assert.equal(run.factuality, LAB_SIMULATOR_FACTUALITY);
  assert.equal(run.deterministicReplay, false);
  assert.equal(run.replayOfRunId, null);
  assert.equal(run.replayVerified, null);
  assert.equal(run.stepBudget, 12);
  assert.equal(run.stepCount, 12, 'the step count is SQL-computed from the tail rows');
  assert.ok(run.trajectoryDigest !== null);
  assert.match(run.trajectoryDigest, /^[0-9a-f]{64}$/);
  // The summary totals are SQL-computed from the step rows (re-derived
  // from the recorded steps — the cross-check).
  const steps = await simulator.listSteps(aliceScope, run.runId);
  assert.equal(steps.length, 12);
  assert.equal(run.totalViews, steps.reduce((sum, step) => sum + step.views, 0));
  assert.equal(run.totalConversions, steps.reduce((sum, step) => sum + step.conversions, 0));
  assert.equal(run.totalFollowersGained, steps.reduce((sum, step) => sum + step.followersGained, 0));
  assert.ok(run.totalImpressions > 0);
  assert.ok(run.totalViews > 0);
  // The steps: the recorded interaction loop (candidates → exposure →
  // interactions) with the deterministic digests.
  for (const step of steps) {
    assert.ok(step.candidates.length >= 1);
    assert.ok(step.exposure.length >= 1);
    assert.ok(step.exposure.every((decision) => decision.rankingModel === 'declared_world_model_assumptions'));
    assert.ok(step.interactions.length === 2);
    assert.match(step.stepDigest, /^[0-9a-f]{64}$/);
  }
  // The observable snapshots: one per step, the agent-facing surface.
  const snapshots = await simulator.listObservableSnapshots(aliceScope, run.runId);
  assert.equal(snapshots.length, 12);
  for (const snapshot of snapshots) {
    assert.equal((snapshot.observableState as Record<string, unknown>).factuality, 'simulated_model_output');
    const serialized = JSON.stringify(snapshot.observableState);
    for (const forbidden of ['fatigue', 'trendValue', 'exposureShare', 'candidateScore', 'pView']) {
      assert.ok(!serialized.includes(`"${forbidden}"`), `the observable snapshot must not carry model internals ('${forbidden}')`);
    }
  }
  // The per-step reads resolve.
  const step3 = await simulator.getStep(aliceScope, run.runId, 3);
  assert.equal(step3.seq, 3);
  const snapshot3 = await simulator.getObservableSnapshot(aliceScope, run.runId, 3);
  assert.equal(snapshot3.seq, 3);
  await assert.rejects(() => simulator.getStep(aliceScope, run.runId, 99), NotFoundError);
});

test('LAB-005: THE DETERMINISTIC SEEDED REPLAY (the core acceptance proof) — the replay cites the original seed + configuration and reproduces the trajectory step-for-step', async () => {
  const configs = await simulator.listWorldConfigs(aliceScope);
  const config = await simulator.getWorldConfig(aliceScope, configs[0]!.configId, 1);
  const seed = await simulator.createSeed({ scope: aliceScope, masterSeed: '12345678901234567', configId: config.configId, configVersion: 1 });
  const original = await simulator.runSimulation({
    scope: aliceScope,
    seedId: seed.seedId,
    stepBudget: 12,
    publishingPlan: PLAN,
    contentUniverse: universe(),
  });

  // THE REPLAY: cites the original; the module copies the seed +
  // configuration + plan + universe and re-runs the pure engine.
  const replay = await simulator.createReplayRun({ scope: aliceScope, runId: original.runId });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.deterministicReplay, true);
  assert.equal(replay.replayOfRunId, original.runId);
  assert.equal(replay.replayVerified, true, 'the recorded reproduction proof');
  assert.equal(replay.seedId, original.seedId, 'the SAME seed record');
  assert.equal(replay.configId, original.configId);
  assert.equal(replay.stepBudget, original.stepBudget);
  assert.deepEqual(replay.publishingPlan, original.publishingPlan);
  assert.deepEqual(replay.contentUniverse, original.contentUniverse);
  // THE STEP-FOR-STEP REPRODUCTION: every step digest + observable
  // digest equal, the trajectory digest equal, and the SQL-computed
  // totals equal.
  assert.equal(replay.trajectoryDigest, original.trajectoryDigest);
  const originalSteps = await simulator.listSteps(aliceScope, original.runId);
  const replaySteps = await simulator.listSteps(aliceScope, replay.runId);
  assert.equal(replaySteps.length, originalSteps.length);
  for (let i = 0; i < originalSteps.length; i += 1) {
    assert.equal(replaySteps[i]!.seq, originalSteps[i]!.seq);
    assert.equal(replaySteps[i]!.stepDigest, originalSteps[i]!.stepDigest, `step ${i + 1} digests match`);
    assert.deepEqual(replaySteps[i]!.exposure, originalSteps[i]!.exposure);
    assert.deepEqual(replaySteps[i]!.interactions, originalSteps[i]!.interactions);
    assert.equal(replaySteps[i]!.views, originalSteps[i]!.views);
  }
  const originalSnapshots = await simulator.listObservableSnapshots(aliceScope, original.runId);
  const replaySnapshots = await simulator.listObservableSnapshots(aliceScope, replay.runId);
  for (let i = 0; i < originalSnapshots.length; i += 1) {
    assert.equal(replaySnapshots[i]!.observableDigest, originalSnapshots[i]!.observableDigest, `step ${i + 1} observable digests match`);
    assert.deepEqual(replaySnapshots[i]!.observableState, originalSnapshots[i]!.observableState);
  }
  assert.equal(replay.totalViews, original.totalViews);
  assert.equal(replay.totalImpressions, original.totalImpressions);
  assert.equal(replay.totalConversions, original.totalConversions);
  assert.equal(replay.totalRevenue, original.totalRevenue);
  assert.equal(replay.totalFollowersGained, original.totalFollowersGained);

  // A stochastic NEW run over a DIFFERENT seed is a different trajectory.
  const otherSeed = await simulator.createSeed({ scope: aliceScope, masterSeed: '9876543210987654321', configId: config.configId, configVersion: 1 });
  const stochastic = await simulator.runSimulation({
    scope: aliceScope,
    seedId: otherSeed.seedId,
    stepBudget: 12,
    publishingPlan: PLAN,
    contentUniverse: universe(),
  });
  assert.notEqual(stochastic.trajectoryDigest, original.trajectoryDigest);

  // A replay of a non-completed run is impossible through the module
  // (runs complete atomically) — an unknown run is the uniform NotFound.
  await assert.rejects(() => simulator.createReplayRun({ scope: aliceScope, runId: '00000000-0000-0000-0000-00000000dead' }), NotFoundError);
});

// ---------------------------------------------------------------------------
// (e) THE STOCHASTIC ENSEMBLE (§13).
// ---------------------------------------------------------------------------

test('LAB-005: THE STOCHASTIC ENSEMBLE — the member family over NEW sampled seeds on the declared configuration space with the SQL-computed agreement/disagreement', async () => {
  const configs = await simulator.listWorldConfigs(aliceScope);
  const v1 = await simulator.getWorldConfig(aliceScope, configs[0]!.configId, 1);
  const v2 = await simulator.getWorldConfig(aliceScope, configs[0]!.configId, 2);
  assert.ok(v1 !== null && v2 !== null, 'the two-chain fixture from test (a)');

  const ensemble = await simulator.createEnsemble({
    scope: aliceScope,
    ensembleSeed: '424242424242424242',
    memberCount: 6,
    configCitations: [
      { configId: v1.configId, configVersion: 1 },
      { configId: v2.configId, configVersion: 2 },
    ],
    outcomeMetric: 'conversions',
    stepBudget: 10,
    publishingPlan: PLAN,
    contentUniverse: universe(),
  });
  assert.equal(ensemble.status, 'completed');
  assert.equal(ensemble.memberCount, 6);
  assert.equal(ensemble.outcomeMetric, 'conversions');
  assert.equal(ensemble.members.length, 6);
  // The members sample NEW seeds (never a duplicate among them) over
  // the declared configuration space (round-robin over the citations).
  const memberSeeds = ensemble.members.map((member) => member.memberSeed);
  assert.equal(new Set(memberSeeds).size, 6, 'each member carries its own sampled NEW seed');
  for (let i = 0; i < ensemble.members.length; i += 1) {
    const member = ensemble.members[i]!;
    assert.equal(member.seq, i + 1);
    const expectedConfig = i % 2 === 0 ? v1 : v2;
    assert.equal(member.configId, expectedConfig.configId);
    assert.equal(member.configVersion, expectedConfig.configVersion);
    const run = await simulator.getRun(aliceScope, member.runId);
    assert.equal(run.status, 'completed');
    assert.equal(run.deterministicReplay, false);
  }
  // THE §13 SUMMARY: the uncertainty interval + the agreement fraction
  // (the majority side of the mean, ≥ 0.5 by construction) — a single
  // run is never ground truth; the ensemble record IS the estimate.
  assert.ok(ensemble.minOutcome <= ensemble.meanOutcome);
  assert.ok(ensemble.meanOutcome <= ensemble.maxOutcome);
  assert.ok(ensemble.agreementFraction >= 0.5 && ensemble.agreementFraction <= 1);
  assert.ok(Math.abs(ensemble.agreementFraction + ensemble.disagreementFraction - 1) < 0.001);
  const outcomes = ensemble.members.map((member) => member.runId);
  const memberRuns = [];
  for (const runId of outcomes) {
    memberRuns.push(await simulator.getRun(aliceScope, runId));
  }
  const expectedMean = memberRuns.reduce((sum, run) => sum + run.totalConversions, 0) / memberRuns.length;
  assert.ok(Math.abs(ensemble.meanOutcome - expectedMean) < 0.0001, 'the mean outcome is SQL-computed from the member runs');

  // The deterministic sampling basis: the same ensemble seed + the same
  // space re-derives the same member seeds (the reproducible sampling).
  const replayed = await simulator.createEnsemble({
    scope: aliceScope,
    ensembleSeed: '424242424242424242',
    memberCount: 6,
    configCitations: [
      { configId: v1.configId, configVersion: 1 },
      { configId: v2.configId, configVersion: 2 },
    ],
    outcomeMetric: 'conversions',
    stepBudget: 10,
    publishingPlan: PLAN,
    contentUniverse: universe(),
  });
  assert.deepEqual(
    replayed.members.map((member) => member.memberSeed),
    memberSeeds,
    'the ensemble sampling is deterministic from the recorded ensemble seed',
  );
  assert.equal(replayed.meanOutcome, ensemble.meanOutcome);
  assert.equal(replayed.agreementFraction, ensemble.agreementFraction);

  // THE §13 FLOOR: an ensemble of ONE is refused.
  await assert.rejects(
    () =>
      simulator.createEnsemble({
        scope: aliceScope,
        memberCount: 1,
        configCitations: [{ configId: v1.configId, configVersion: 1 }],
        stepBudget: 4,
        publishingPlan: [],
        contentUniverse: universe(),
      }),
    InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// (f) The §22 workspace anchor + the declared-constraint enforcement.
// ---------------------------------------------------------------------------

test('LAB-005: the §22 optional workspace anchor + THE DECLARED API/PUBLISHING CONSTRAINTS enforced on every plan', async () => {
  const config = (await simulator.listWorldConfigs({ ...aliceScope, workspaceId: aliceWorkspaceId }))[0]!;
  // The workspace-anchored seed + run record the anchor on every row.
  const seed = await simulator.createSeed({ scope: { ...aliceScope, workspaceId: aliceWorkspaceId }, masterSeed: '777', configId: config.configId, configVersion: config.configVersion });
  assert.equal(seed.workspaceId, aliceWorkspaceId);
  const run = await simulator.runSimulation({
    scope: { ...aliceScope, workspaceId: aliceWorkspaceId },
    seedId: seed.seedId,
    stepBudget: 4,
    publishingPlan: [],
    contentUniverse: universe(),
  });
  assert.equal(run.workspaceId, aliceWorkspaceId);
  for (const step of await simulator.listSteps({ ...aliceScope, workspaceId: aliceWorkspaceId }, run.runId)) {
    assert.equal(step.workspaceId, aliceWorkspaceId);
  }
  // The client fence stays the retrieval boundary: the plain client
  // scope still reads the workspace-anchored run.
  const plainRead = await simulator.getRun(aliceScope, run.runId);
  assert.equal(plainRead.workspaceId, aliceWorkspaceId);

  // THE DECLARED CONSTRAINTS: a plan that violates the world model's
  // declared platform constraints fails closed BEFORE anything is
  // simulated (nothing recorded).
  const runsBefore = (await simulator.listRuns(aliceScope)).length;
  const constrained = knobs({ constraints: { maxAccountPostsPerStep: 1, minStepsBetweenPosts: 2 } });
  const strictConfig = await simulator.createWorldConfig({ scope: aliceScope, knobs: constrained });
  const strictSeed = await simulator.createSeed({ scope: aliceScope, masterSeed: '888', configId: strictConfig.configId, configVersion: strictConfig.configVersion });
  await assert.rejects(
    () =>
      simulator.runSimulation({
        scope: aliceScope,
        seedId: strictSeed.seedId,
        stepBudget: 10,
        publishingPlan: [
          { itemIndex: 0, atStep: 1 },
          { itemIndex: 1, atStep: 1 },
        ],
        contentUniverse: universe(),
      }),
    InvalidRequestError,
    'two posts at one step violate the declared cap of 1',
  );
  await assert.rejects(
    () =>
      simulator.runSimulation({
        scope: aliceScope,
        seedId: strictSeed.seedId,
        stepBudget: 10,
        publishingPlan: [
          { itemIndex: 0, atStep: 2 },
          { itemIndex: 1, atStep: 4 },
        ],
        contentUniverse: universe(),
      }),
    InvalidRequestError,
    'one step between posts violates the declared minimum of 2',
  );
  assert.equal((await simulator.listRuns(aliceScope)).length, runsBefore, 'the rejected plans recorded NOTHING (fail closed)');
});

// ---------------------------------------------------------------------------
// (g) Tenant isolation (§22) — the uniform NotFound + the DB triggers.
// ---------------------------------------------------------------------------

test('LAB-005: tenant isolation — the uniform NotFound for foreign scope (no existence oracle) + the DB-level cross-tenant injection triggers', async () => {
  const config = (await simulator.listWorldConfigs(aliceScope))[0]!;
  const seed = await simulator.createSeed({ scope: aliceScope, masterSeed: '12345678901234567', configId: config.configId, configVersion: config.configVersion });
  const run = await simulator.runSimulation({
    scope: aliceScope,
    seedId: seed.seedId,
    stepBudget: 6,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });

  // The uniform NotFound on every foreign read (no existence oracle).
  await assert.rejects(() => simulator.getWorldConfig(bobScope, config.configId), NotFoundError);
  await assert.rejects(() => simulator.getSeed(bobScope, seed.seedId), NotFoundError);
  await assert.rejects(() => simulator.getRun(bobScope, run.runId), NotFoundError);
  await assert.rejects(() => simulator.listSteps(bobScope, run.runId), NotFoundError);
  await assert.rejects(() => simulator.listObservableSnapshots(bobScope, run.runId), NotFoundError);
  await assert.rejects(() => simulator.getStep(bobScope, run.runId, 1), NotFoundError);
  await assert.rejects(() => simulator.getObservableSnapshot(bobScope, run.runId, 1), NotFoundError);
  await assert.rejects(() => simulator.createReplayRun({ scope: bobScope, runId: run.runId }), NotFoundError);
  await assert.rejects(() => simulator.getEnsemble(bobScope, '00000000-0000-0000-0000-0000000000ee'), NotFoundError);
  // The foreign tenant sees nothing in the list reads.
  assert.equal((await simulator.listWorldConfigs(bobScope)).length, 0);
  assert.equal((await simulator.listRuns(bobScope)).length, 0);

  // THE RECORDED-DATA TENANT FENCE on the universe citations: a
  // citation recorded under another client is rejected.
  await assert.rejects(
    () =>
      simulator.runSimulation({
        scope: aliceScope,
        seedId: seed.seedId,
        stepBudget: 4,
        publishingPlan: [],
        contentUniverse: [{ ...universe()[0]!, recordedClientId: bobScope.clientId }],
      }),
    InvalidRequestError,
  );

  // THE DB-LEVEL INJECTION TRIGGERS: a cross-tenant step/snapshot/
  // member/seed row is rejected at the DB (the §22 backstop).
  const foreignScopeRow = { agencyId: bobScope.agencyId, clientId: bobScope.clientId, workspaceId: null };
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO lab_simulator_run_steps
           (step_id, run_id, seq, candidates, exposure, interactions, competitor_posts, topic_trends,
            impressions, views, engagements, shares, clicks, conversions, revenue, followers_gained,
            competitor_post_count, step_digest, agency_id, client_id, workspace_id, contract_version, created_at)
         VALUES ($1, $2, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
                 0, 0, 0, 0, 0, 0, 0, 0, 0, $3, $4, $5, NULL, 'lab-simulator-contract-v1', now())`,
        ['00000000-0000-0000-0000-0000000000f1', run.runId, 'a'.repeat(64), foreignScopeRow.agencyId, foreignScopeRow.clientId],
      ),
    /cross-tenant step injection/,
  );
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO lab_simulator_observable_snapshots
           (snapshot_id, run_id, seq, observable_state, observable_digest,
            agency_id, client_id, workspace_id, contract_version, created_at)
         VALUES ($1, $2, 1, '{}'::jsonb, $3, $4, $5, NULL, 'lab-simulator-contract-v1', now())`,
        ['00000000-0000-0000-0000-0000000000f2', run.runId, 'b'.repeat(64), foreignScopeRow.agencyId, foreignScopeRow.clientId],
      ),
    /cross-tenant snapshot injection/,
  );
  // A cross-tenant run citing Alice's seed is rejected.
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO lab_simulator_runs
           (run_id, status, seed_id, config_id, config_version, config_digest,
            engine_version, factuality, deterministic_replay, replay_of_run_id, replay_verified,
            step_budget, publishing_plan, content_universe,
            agency_id, client_id, workspace_id, contract_version, created_at, updated_at)
         VALUES ($1, 'running', $2, $3, $4, $5,
                 'lab-sim-engine-v1', 'simulated_model_output', false, NULL, NULL,
                 4, '[]'::jsonb, '[]'::jsonb,
                 $6, $7, NULL, 'lab-simulator-contract-v1', now(), now())`,
        ['00000000-0000-0000-0000-0000000000f3', seed.seedId, config.configId, config.configVersion, config.configDigest, foreignScopeRow.agencyId, foreignScopeRow.clientId],
      ),
    /cross-tenant run injection/,
  );
  // The seed→config client-consistency trigger.
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO lab_simulator_seeds
           (seed_id, master_seed, derived, config_id, config_version, config_digest, seed_digest,
            agency_id, client_id, workspace_id, contract_version, created_at)
         VALUES ($1, '42', '[]'::jsonb, $2, $3, $4, $5,
                 $6, $7, NULL, 'lab-simulator-contract-v1', now())`,
        ['00000000-0000-0000-0000-0000000000f4', config.configId, config.configVersion, config.configDigest, 'c'.repeat(64), foreignScopeRow.agencyId, foreignScopeRow.clientId],
      ),
    /cross-tenant seed injection/,
  );
});

// ---------------------------------------------------------------------------
// (h) The DB backstops — the append-only triggers + the guards.
// ---------------------------------------------------------------------------

test('LAB-005: the DB backstops — the append-only triggers reject UPDATE and DELETE; the run/ensemble guards enforce the single completion advance + identity immutability', async () => {
  const config = (await simulator.listWorldConfigs(aliceScope))[0]!;
  const seed = await simulator.createSeed({ scope: aliceScope, masterSeed: '555', configId: config.configId, configVersion: config.configVersion });
  const run = await simulator.runSimulation({
    scope: aliceScope,
    seedId: seed.seedId,
    stepBudget: 3,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });

  // Configurations and seeds are append-only outright.
  await assert.rejects(
    () => db!.query(`UPDATE lab_simulator_world_configs SET knobs = '{}'::jsonb WHERE config_id = $1`, [config.configId]),
    /append-only/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM lab_simulator_world_configs WHERE config_id = $1`, [config.configId]),
    /append-only/,
  );
  await assert.rejects(
    () => db!.query(`UPDATE lab_simulator_seeds SET master_seed = '1' WHERE seed_id = $1`, [seed.seedId]),
    /append-only/,
  );
  // Steps and snapshots are append-only outright.
  const stepRow = (await db!.query<{ step_id: string }>(`SELECT step_id FROM lab_simulator_run_steps WHERE run_id = $1 AND seq = 1`, [run.runId])).rows[0]!;
  await assert.rejects(() => db!.query(`UPDATE lab_simulator_run_steps SET views = 999999 WHERE step_id = $1`, [stepRow.step_id]), /append-only/);
  await assert.rejects(() => db!.query(`DELETE FROM lab_simulator_run_steps WHERE step_id = $1`, [stepRow.step_id]), /append-only/);
  const snapshotRow = (await db!.query<{ snapshot_id: string }>(`SELECT snapshot_id FROM lab_simulator_observable_snapshots WHERE run_id = $1 AND seq = 1`, [run.runId])).rows[0]!;
  await assert.rejects(() => db!.query(`UPDATE lab_simulator_observable_snapshots SET observable_state = '{}'::jsonb WHERE snapshot_id = $1`, [snapshotRow.snapshot_id]), /append-only/);
  await assert.rejects(() => db!.query(`DELETE FROM lab_simulator_observable_snapshots WHERE snapshot_id = $1`, [snapshotRow.snapshot_id]), /append-only/);

  // The run guard: identity immutability + the single completion advance.
  await assert.rejects(
    () => db!.query(`UPDATE lab_simulator_runs SET step_budget = 50 WHERE run_id = $1`, [run.runId]),
    /immutable/,
  );
  await assert.rejects(
    () => db!.query(`UPDATE lab_simulator_runs SET publishing_plan = '[]'::jsonb WHERE run_id = $1`, [run.runId]),
    /immutable/,
  );
  await assert.rejects(
    () => db!.query(`UPDATE lab_simulator_runs SET status = 'running' WHERE run_id = $1`, [run.runId]),
    /not legal/,
    'no resurrection: completed → running is refused',
  );
  await assert.rejects(
    () => db!.query(`UPDATE lab_simulator_runs SET total_views = 999999 WHERE run_id = $1`, [run.runId]),
    /single completion advance/,
    'the summary may only change at the single advance',
  );
  await assert.rejects(() => db!.query(`DELETE FROM lab_simulator_runs WHERE run_id = $1`, [run.runId]), /append-only/);

  // The replay fences at the DB: a replay row without the recorded
  // proof is structurally inexpressible; a replay citing a running
  // original is rejected.
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO lab_simulator_runs
           (run_id, status, seed_id, config_id, config_version, config_digest,
            engine_version, factuality, deterministic_replay, replay_of_run_id, replay_verified,
            step_budget, publishing_plan, content_universe,
            agency_id, client_id, workspace_id, contract_version, created_at, updated_at)
         VALUES ($1, 'running', $2, $3, $4, $5,
                 'lab-sim-engine-v1', 'simulated_model_output', true, $6, NULL,
                 3, '[]'::jsonb, '[]'::jsonb,
                 $7, $8, NULL, 'lab-simulator-contract-v1', now(), now())`,
        ['00000000-0000-0000-0000-0000000000f5', seed.seedId, config.configId, config.configVersion, config.configDigest, run.runId, aliceScope.agencyId, aliceScope.clientId],
      ),
    /replay_fence/,
    'an unverified replay row is inexpressible',
  );

  // The ensemble guard: the summary may only change at the single advance.
  const ensemble = (await simulator.createEnsemble({
    scope: aliceScope,
    ensembleSeed: '31337',
    memberCount: 2,
    configCitations: [{ configId: config.configId, configVersion: config.configVersion }],
    stepBudget: 2,
    publishingPlan: [],
    contentUniverse: universe(),
  }));
  await assert.rejects(
    () => db!.query(`UPDATE lab_simulator_ensembles SET member_count = 10 WHERE ensemble_id = $1`, [ensemble.ensembleId]),
    /immutable/,
  );
  // Pick an agreement value that certainly DIFFERS from the recorded
  // one (a no-op rewrite of the same value passes the guard honestly).
  const currentAgreement = Number(
    (await db!.query<{ agreement_fraction: string }>(`SELECT agreement_fraction FROM lab_simulator_ensembles WHERE ensemble_id = $1`, [ensemble.ensembleId])).rows[0]!.agreement_fraction,
  );
  const flippedAgreement = currentAgreement >= 0.75 ? 0.5 : 1;
  await assert.rejects(
    () => db!.query(`UPDATE lab_simulator_ensembles SET agreement_fraction = $2 WHERE ensemble_id = $1`, [ensemble.ensembleId, flippedAgreement]),
    /single completion advance/,
  );
  await assert.rejects(() => db!.query(`DELETE FROM lab_simulator_ensembles WHERE ensemble_id = $1`, [ensemble.ensembleId]), /append-only/);
  const memberRow = (await db!.query<{ member_id: string }>(`SELECT member_id FROM lab_simulator_ensemble_members WHERE ensemble_id = $1 AND seq = 1`, [ensemble.ensembleId])).rows[0]!;
  await assert.rejects(() => db!.query(`UPDATE lab_simulator_ensemble_members SET member_seed = '1' WHERE member_id = $1`, [memberRow.member_id]), /append-only/);
});

test('LAB-005: the run-cited configuration must pair the seed\'s configuration (the reproducibility unit) — the DB-level fence', async () => {
  const configs = await simulator.listWorldConfigs(aliceScope);
  const twoVersionChain = configs.find((entry) => entry.configVersion >= 2);
  assert.ok(twoVersionChain !== undefined, 'the two-version chain from test (a)');
  const v1 = await simulator.getWorldConfig(aliceScope, twoVersionChain.configId, 1);
  const v2 = await simulator.getWorldConfig(aliceScope, twoVersionChain.configId, 2);
  const seed = await simulator.createSeed({ scope: aliceScope, masterSeed: '999', configId: v1.configId, configVersion: 1 });
  // A run citing v2 while its seed cites v1 is rejected at the DB (the
  // seed + configuration pair is the reproducibility unit).
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO lab_simulator_runs
           (run_id, status, seed_id, config_id, config_version, config_digest,
            engine_version, factuality, deterministic_replay, replay_of_run_id, replay_verified,
            step_budget, publishing_plan, content_universe,
            agency_id, client_id, workspace_id, contract_version, created_at, updated_at)
         VALUES ($1, 'running', $2, $3, $4, $5,
                 'lab-sim-engine-v1', 'simulated_model_output', false, NULL, NULL,
                 3, '[]'::jsonb, '[]'::jsonb,
                 $6, $7, NULL, 'lab-simulator-contract-v1', now(), now())`,
        ['00000000-0000-0000-0000-0000000000f6', seed.seedId, v2.configId, v2.configVersion, v2.configDigest, aliceScope.agencyId, aliceScope.clientId],
      ),
    /SAME configuration/,
  );
});
