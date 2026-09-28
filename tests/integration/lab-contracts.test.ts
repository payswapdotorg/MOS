/**
 * LAB-001 integration tests — the /lab Contracts and Run Model against a
 * REAL embedded PostgreSQL stack (the policies-security module-level
 * harness: real PgDb + real users/agencies/clients public contracts, the
 * lab module under test composed exactly as the composition root wires
 * it — platform ports only).
 *
 * The acceptance battery (spec/effective-backlog-v1.7.md LAB-001):
 *   (a) versioned contracts — every created artifact carries the frozen
 *       'lab-contract-v1' version;
 *   (b) deterministic seeds — the u64 seed set rides the run record and
 *       the reproducibility inputs are immutable after create (DB
 *       backstop: the guarded UPDATE trigger rejects any seed change);
 *   (c) lifecycle states — the scenario draft → active → retired chain
 *       with append-only version corrections; the run queued → running
 *       → paused → running → succeeded chain over the append-only event
 *       tail (the frozen transition-pair fence); the candidate/capability/
 *       calibration chains;
 *   (d) tenant isolation — Bob's client can never read or transition
 *       Alice's artifacts (uniform NotFound, no existence oracle);
 *   (e) no shadowing — the run record is a lab_runs row, never an
 *       experiments row; the calibration real-outcome anchor is an
 *       opaque uuid (no FK into a v1.6 authority table exists — the
 *       schema itself is the proof, asserted directly);
 * plus the §23 concurrency cap and the §3 factuality labeling.
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
import { createLabModule, LAB_CONTRACT_VERSION, LAB_MAX_ACTIVE_RUNS_PER_CLIENT, LAB_SINGLE_AGENT_BASELINE_TOPOLOGY } from '../../src/modules/lab/public.ts';
import type { LabModuleApi, LabScope, LabSeedSet, LabRunTimeMachine } from '../../src/modules/lab/public.ts';
import { NotFoundError, InvalidRequestError } from '../../src/platform/errors/errors.ts';

let stack: IntegrationStack | null = null;
let db: PgDb | null = null;
let lab: LabModuleApi = null as unknown as LabModuleApi;
let makeFreshScope: (label: string) => Promise<LabScope>;

const aliceScope: LabScope = { agencyId: '', clientId: '' };
const bobScope: LabScope = { agencyId: '', clientId: '' };

const SEEDS: LabSeedSet = {
  masterSeed: '18446744073709551615',
  derived: [
    { label: 'user_population', seed: '7' },
    { label: 'ranking', seed: '42' },
  ],
};

function tm(overrides: Partial<LabRunTimeMachine> = {}): LabRunTimeMachine {
  return {
    mode: 'historical_replay',
    referenceStart: '2026-01-01T00:00:00.000Z',
    referenceEnd: '2026-02-01T00:00:00.000Z',
    simulatedClockStart: '2026-01-01T00:00:00.000Z',
    simulatedClockEnd: '2026-02-01T00:00:00.000Z',
    observationCutoff: '2026-02-01T00:00:00.000Z',
    informationLagMinutes: 0,
    worldModelVersion: 'wm-test-v1',
    ...overrides,
  };
}

const REWARD = {
  version: 'lab-reward-v1',
  declaredTargetOutcome: 'qualified signups',
  weights: { qualified_reach: 1, conversions: 2 },
  hardRejectionGates: ['fake_engagement', 'anti_abuse_evasion'],
};

const CONFIG = { maxSimulatedSteps: 1000, maxComputeCostUnits: 100, maxWallClockMs: 60_000 };

const DECLARATION = {
  actionSpaceVersion: 'as-v1',
  declaredActions: ['original_generation', 'clip'],
  parentCandidateIds: [],
  ideaReferences: [],
};

before(async () => {
  stack = await bootStack('lab_contracts');
  db = new PgDb(stack.env.databaseUrl, 4);
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const users = createUsersModule({ db, clock, ids });
  const agencies = createAgenciesModule({ db, clock, ids, users });
  const clients = createClientsModule({ db, clock, ids, agencies });
  lab = createLabModule({ db, clock, ids });

  // The tenant fixtures: Alice's agency + client, Bob's agency + client.
  const aliceUser = await users.createUser({ email: 'alice@labcontracts.test', displayName: 'Alice' });
  const aliceAgency = await agencies.createAgency({ name: 'Alice Agency', slug: 'alice-lab', ownerUserId: aliceUser.userId, actorId: null });
  const aliceClient = await clients.createClient({ agencyId: aliceAgency.agency.agencyId, name: 'Alice Client', slug: 'alice-client', actorId: null });
  aliceScope.agencyId = aliceAgency.agency.agencyId;
  aliceScope.clientId = aliceClient.clientId;

  const bobUser = await users.createUser({ email: 'bob@labcontracts.test', displayName: 'Bob' });
  const bobAgency = await agencies.createAgency({ name: 'Bob Agency', slug: 'bob-lab', ownerUserId: bobUser.userId, actorId: null });
  const bobClient = await clients.createClient({ agencyId: bobAgency.agency.agencyId, name: 'Bob Client', slug: 'bob-client', actorId: null });
  bobScope.agencyId = bobAgency.agency.agencyId;
  bobScope.clientId = bobClient.clientId;

  // The per-test fresh-scope factory: a NEW client under Alice's agency per
  // label, so the §23 per-client concurrency accounting never bleeds across
  // tests (the cap is per-CLIENT; a fresh client is a clean slate).
  let scopeCounter = 0;
  makeFreshScope = async (label: string): Promise<LabScope> => {
    scopeCounter += 1;
    const client = await clients.createClient({
      agencyId: aliceScope.agencyId,
      name: `Lab Client ${label} ${scopeCounter}`,
      slug: `lab-${label.toLowerCase()}-${scopeCounter}`,
      actorId: null,
    });
    return { agencyId: aliceScope.agencyId, clientId: client.clientId };
  };
});

after(async () => {
  if (db !== null) {
    await db.close();
    db = null;
  }
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// (a)/(c) The scenario lifecycle with versioned corrections
// ---------------------------------------------------------------------------

test('LAB-001 (a/c): the scenario lifecycle — draft → active → retired with append-only version corrections', async () => {
  const scenario = await lab.createScenario({
    scope: aliceScope,
    binding: { niche: 'dev-tools', platform: 'youtube', corpusVersion: 'pending', worldModelVersion: 'pending' },
    reward: REWARD,
    runConfiguration: CONFIG,
  });
  assert.equal(scenario.status, 'draft');
  assert.equal(scenario.scenarioVersion, 1);
  assert.equal(scenario.contractVersion, LAB_CONTRACT_VERSION);

  // Runs refuse a DRAFT scenario (the frozen-at-run gate).
  await assert.rejects(
    () => lab.createRun({ scope: aliceScope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: SEEDS }),
    (error: unknown) => error instanceof InvalidRequestError && /ACTIVE/.test(error.message),
  );

  const active = await lab.activateScenario(aliceScope, scenario.scenarioId);
  assert.equal(active.status, 'active');

  // The append-only correction: a NEW draft version (v2); the corrected
  // version must be re-activated before new runs bind it.
  const corrected = await lab.correctScenario(aliceScope, scenario.scenarioId, {
    binding: { niche: 'dev-tools', platform: 'youtube', corpusVersion: 'corpus-v9', worldModelVersion: 'pending' },
  });
  assert.equal(corrected.scenarioVersion, 2);
  assert.equal(corrected.status, 'draft');
  assert.equal(corrected.binding.corpusVersion, 'corpus-v9');

  const v2active = await lab.activateScenario(aliceScope, scenario.scenarioId);
  assert.equal(v2active.scenarioVersion, 2);
  assert.equal(v2active.status, 'active');

  const retired = await lab.retireScenario(aliceScope, scenario.scenarioId);
  assert.equal(retired.status, 'retired');
  // Retired: new runs refused, uniform InvalidRequest.
  await assert.rejects(
    () => lab.createRun({ scope: aliceScope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: SEEDS }),
    (error: unknown) => error instanceof InvalidRequestError && /retired/.test(error.message),
  );

  // The v1 row is still readable through the version chain (history intact).
  const v1 = await lab.listScenarios(aliceScope);
  assert.equal(v1.filter((s) => s.scenarioId === scenario.scenarioId).length, 1); // newest per scenario
});

// ---------------------------------------------------------------------------
// (b)/(c) The run lifecycle + the deterministic seed discipline
// ---------------------------------------------------------------------------

test('LAB-001 (b/c): the run lifecycle over the append-only event tail — queued → running → paused → running → succeeded, seeds immutable', async () => {
  const scenario = await lab.createScenario({
    scope: aliceScope,
    binding: { niche: 'dev-tools', platform: 'youtube', corpusVersion: 'pending', worldModelVersion: 'pending' },
    reward: REWARD,
    runConfiguration: CONFIG,
  });
  await lab.activateScenario(aliceScope, scenario.scenarioId);

  const run = await lab.createRun({ scope: aliceScope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: SEEDS });
  assert.equal(run.status, 'queued');
  assert.equal(run.seeds.masterSeed, '18446744073709551615');
  assert.equal(run.seeds.derived.length, 2);
  assert.equal(run.factuality, 'simulated_model_output');
  assert.equal(run.scenarioVersion, scenario.scenarioVersion);
  assert.equal(run.contractVersion, LAB_CONTRACT_VERSION);

  const started = await lab.startRun(aliceScope, run.runId);
  assert.equal(started.status, 'running');

  const paused = await lab.pauseRun(aliceScope, run.runId);
  assert.equal(paused.status, 'paused');
  // Reproducibility survives the pause/resume pair: same seeds, same configuration.
  assert.equal(paused.seeds.masterSeed, run.seeds.masterSeed);
  assert.deepEqual(paused.seeds.derived, run.seeds.derived);

  const resumed = await lab.resumeRun(aliceScope, run.runId);
  assert.equal(resumed.status, 'running');

  const artifacts = [{ kind: 'trajectory', version: 'traj-v1' }, { kind: 'metrics', version: 'met-v1' }];
  const done = await lab.completeRun(aliceScope, run.runId, artifacts);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.outputArtifacts, artifacts);

  // Terminal: no further transitions (the frozen machine).
  await assert.rejects(
    () => lab.cancelRun(aliceScope, run.runId),
    (error: unknown) => error instanceof InvalidRequestError && /non-terminal/.test(error.message),
  );

  // The event tail: initialization (born queued) + the four transitions.
  const events = await db!.query(
    'SELECT from_status, to_status FROM lab_run_events WHERE run_id = $1 ORDER BY event_seq',
    [run.runId],
  );
  assert.deepEqual(
    events.rows.map((r) => [r.from_status, r.to_status]),
    [
      [null, 'queued'],
      ['queued', 'running'],
      ['running', 'paused'],
      ['paused', 'running'],
      ['running', 'succeeded'],
    ],
  );
});

test('LAB-001 (b): the DB backstops — a run seed/configuration change and a run DELETE are rejected by the migration-059 fences', async () => {
  const scope = await makeFreshScope('backstop');
  const scenario = await lab.createScenario({
    scope,
    binding: { niche: 'n', platform: 'youtube', corpusVersion: 'pending', worldModelVersion: 'pending' },
    reward: REWARD,
    runConfiguration: CONFIG,
  });
  await lab.activateScenario(scope, scenario.scenarioId);
  const run = await lab.createRun({ scope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: SEEDS });

  await assert.rejects(
    () => db!.query('UPDATE lab_runs SET master_seed = 1 WHERE run_id = $1', [run.runId]),
    (error: unknown) => /immutable/i.test(String((error as Error).message)),
  );
  await assert.rejects(
    () => db!.query('DELETE FROM lab_runs WHERE run_id = $1', [run.runId]),
    (error: unknown) => /append-only/i.test(String((error as Error).message)),
  );
  await assert.rejects(
    () => db!.query("UPDATE lab_runs SET status = 'succeeded', version = version + 1 WHERE run_id = $1", [run.runId]),
    (error: unknown) => /output artifacts|queued → succeeded|immutable/i.test(String((error as Error).message)),
  );
});

// ---------------------------------------------------------------------------
// (c) The §23 concurrency cap
// ---------------------------------------------------------------------------

test('LAB-001 (c): the per-client active-run concurrency cap (§23) is enforced at run create', async () => {
  const scope = await makeFreshScope('cap');
  const scenario = await lab.createScenario({
    scope,
    binding: { niche: 'n', platform: 'youtube', corpusVersion: 'pending', worldModelVersion: 'pending' },
    reward: REWARD,
    runConfiguration: CONFIG,
  });
  await lab.activateScenario(scope, scenario.scenarioId);
  const runs = [];
  for (let i = 0; i < LAB_MAX_ACTIVE_RUNS_PER_CLIENT; i++) {
    runs.push(await lab.createRun({ scope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: { masterSeed: String(i), derived: [] } }));
  }
  assert.equal(runs.length, LAB_MAX_ACTIVE_RUNS_PER_CLIENT);
  await assert.rejects(
    () => lab.createRun({ scope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: { masterSeed: '99', derived: [] } }),
    (error: unknown) => error instanceof InvalidRequestError && /concurrency cap/.test(error.message),
  );
  // Completing one run frees a slot.
  await lab.startRun(scope, runs[0]!.runId);
  await lab.completeRun(scope, runs[0]!.runId, []);
  const freed = await lab.createRun({ scope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: { masterSeed: '99', derived: [] } });
  assert.equal(freed.status, 'queued');
});

// ---------------------------------------------------------------------------
// (d) Tenant isolation — the uniform NotFound, no existence oracle
// ---------------------------------------------------------------------------

test('LAB-001 (d): tenant isolation — Bob can never read or transition Alice artifacts (uniform NotFound)', async () => {
  const scenario = await lab.createScenario({
    scope: aliceScope,
    binding: { niche: 'n', platform: 'youtube', corpusVersion: 'pending', worldModelVersion: 'pending' },
    reward: REWARD,
    runConfiguration: CONFIG,
  });
  await lab.activateScenario(aliceScope, scenario.scenarioId);
  const run = await lab.createRun({ scope: aliceScope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: SEEDS });

  await assert.rejects(
    () => lab.getScenario(bobScope, scenario.scenarioId),
    (error: unknown) => error instanceof NotFoundError,
  );
  await assert.rejects(
    () => lab.getRun(bobScope, run.runId),
    (error: unknown) => error instanceof NotFoundError,
  );
  await assert.rejects(
    () => lab.startRun(bobScope, run.runId),
    (error: unknown) => error instanceof NotFoundError,
  );
  await assert.rejects(
    () => lab.activateScenario(bobScope, scenario.scenarioId),
    (error: unknown) => error instanceof NotFoundError,
  );
  // Bob's own list is empty (no cross-tenant leakage through the list surface).
  assert.equal((await lab.listRuns(bobScope)).length, 0);
  assert.equal((await lab.listScenarios(bobScope)).length, 0);
});

// ---------------------------------------------------------------------------
// (e) No shadowing + factuality
// ---------------------------------------------------------------------------

test('LAB-001 (e): no shadowing — the lab tables exist, no FK into v1.6 authority tables exists, and counterfactual runs carry the model-estimate label', async () => {
  // The schema-level no-shadowing proof: the calibration/run tables reference ONLY
  // agencies/clients/workspaces (tenant anchors) + same-module tables.
  const runFks = await db!.query(
    `SELECT tc.constraint_name, ccu.table_name AS referenced
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'lab_runs'`,
  );
  const referenced = new Set(runFks.rows.map((r) => String(r.referenced)));
  for (const forbidden of ['experiments', 'decisions', 'evidence', 'metric_observations', 'social_publish_attempts', 'workflows', 'executions']) {
    assert.equal(referenced.has(forbidden), false, `lab_runs must not FK-reference ${forbidden} (§3 no shadowing)`);
  }
  const calFks = await db!.query(
    `SELECT ccu.table_name AS referenced
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'lab_calibration_records'`,
  );
  const calReferenced = new Set(calFks.rows.map((r) => String(r.referenced)));
  assert.equal(calReferenced.has('experiments'), false);
  assert.equal(calReferenced.has('evidence'), false);

  // The factuality labeling (§3/§10): a counterfactual run is born with the
  // model-estimate label — never the factual one.
  const scope = await makeFreshScope('fact');
  const scenario = await lab.createScenario({
    scope,
    binding: { niche: 'n', platform: 'youtube', corpusVersion: 'pending', worldModelVersion: 'pending' },
    reward: REWARD,
    runConfiguration: CONFIG,
  });
  await lab.activateScenario(scope, scenario.scenarioId);
  const cfRun = await lab.createRun({
    scope,
    scenarioId: scenario.scenarioId,
    timeMachine: tm({ mode: 'counterfactual' }),
    seeds: { masterSeed: '5', derived: [] },
  });
  assert.equal(cfRun.factuality, 'counterfactual_model_estimate');
  const diRun = await lab.createRun({
    scope,
    scenarioId: scenario.scenarioId,
    timeMachine: tm({ mode: 'delayed_information', informationLagMinutes: 30 }),
    seeds: { masterSeed: '6', derived: [] },
  });
  assert.equal(diRun.factuality, 'simulated_model_output');
});

// ---------------------------------------------------------------------------
// Candidates + the single-agent baseline + calibration
// ---------------------------------------------------------------------------

test('LAB-001 (c/e): the strategy candidate lifecycle with append-only uncertainty-carried evaluations', async () => {
  const scope = await makeFreshScope('strat');
  const scenario = await lab.createScenario({
    scope,
    binding: { niche: 'n', platform: 'youtube', corpusVersion: 'pending', worldModelVersion: 'pending' },
    reward: REWARD,
    runConfiguration: CONFIG,
  });
  await lab.activateScenario(scope, scenario.scenarioId);
  const run = await lab.createRun({ scope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: SEEDS });
  const candidate = await lab.createStrategyCandidate({ scope, scenarioId: scenario.scenarioId, declaration: DECLARATION });
  assert.equal(candidate.status, 'draft');

  // Selection requires an evaluation first (the honest gate).
  await assert.rejects(
    () => lab.setStrategyCandidateStatus(scope, candidate.candidateId, 'selected'),
    (error: unknown) => error instanceof InvalidRequestError && /evaluated/.test(error.message),
  );

  const summary = {
    runId: run.runId,
    reward: 12.5,
    uncertaintyInterval: [10.0, 15.0] as [number, number],
    ensembleAgreement: 0.8,
    oodScore: 0.2,
    seedRobustness: 0.9,
    factuality: 'simulated_model_output' as const,
    metrics: { qualified_reach: 4000 },
    evaluatedAt: '2026-03-01T00:00:00.000Z',
  };
  const evaluated = await lab.appendStrategyCandidateEvaluation(scope, candidate.candidateId, summary);
  assert.equal(evaluated.status, 'evaluated');
  assert.equal(evaluated.evaluations.length, 1);
  assert.equal(evaluated.evaluations[0]!.reward, 12.5);

  // A second evaluation APPENDS (never rewrites).
  const evaluated2 = await lab.appendStrategyCandidateEvaluation(scope, candidate.candidateId, { ...summary, reward: 13.5 });
  assert.equal(evaluated2.evaluations.length, 2);
  assert.equal(evaluated2.evaluations[1]!.reward, 13.5);
  assert.equal(evaluated2.evaluations[0]!.reward, 12.5);

  const selected = await lab.setStrategyCandidateStatus(scope, candidate.candidateId, 'selected');
  assert.equal(selected.status, 'selected');
  // Terminal: no further evaluations.
  await assert.rejects(
    () => lab.appendStrategyCandidateEvaluation(scope, candidate.candidateId, summary),
    (error: unknown) => error instanceof InvalidRequestError && /terminal/.test(error.message),
  );
  // The evaluation tail is append-only at the DB level.
  await assert.rejects(
    () => db!.query('DELETE FROM lab_strategy_candidate_evaluations WHERE candidate_id = $1', [candidate.candidateId]),
    (error: unknown) => /append-only/i.test(String((error as Error).message)),
  );
});

test('LAB-001 (§15): the organization candidate carries the single-agent baseline topology and evaluates the same way', async () => {
  const scope = await makeFreshScope('org');
  const scenario = await lab.createScenario({
    scope,
    binding: { niche: 'n', platform: 'youtube', corpusVersion: 'pending', worldModelVersion: 'pending' },
    reward: REWARD,
    runConfiguration: CONFIG,
  });
  await lab.activateScenario(scope, scenario.scenarioId);
  const run = await lab.createRun({ scope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: SEEDS });

  const baseline = await lab.createOrganizationCandidate({
    scope,
    scenarioId: scenario.scenarioId,
    declaration: {
      topology: LAB_SINGLE_AGENT_BASELINE_TOPOLOGY,
      agentBodyVersions: ['agent-body-generalist-v1'],
      edges: [],
      memoryScopes: { agent: 'private' },
      modelAssignments: { agent: 'glm-5.3' },
      budgetAllocation: { agent: 1 },
    },
  });
  assert.equal(baseline.status, 'draft');
  assert.equal(baseline.declaration.topology, 'single_agent_baseline');

  const evaluated = await lab.appendOrganizationCandidateEvaluation(scope, baseline.organizationCandidateId, {
    runId: run.runId,
    reward: 9.0,
    uncertaintyInterval: [8.0, 10.0],
    ensembleAgreement: 0.75,
    oodScore: 0.3,
    seedRobustness: 0.85,
    factuality: 'simulated_model_output',
    metrics: {},
    evaluatedAt: '2026-03-01T00:00:00.000Z',
  });
  assert.equal(evaluated.status, 'evaluated');
  assert.equal(evaluated.evaluations.length, 1);

  // An organization without an agent-body reference is refused (§14).
  await assert.rejects(
    () => lab.createOrganizationCandidate({
      scope,
      scenarioId: scenario.scenarioId,
      declaration: { topology: 'custom_graph', agentBodyVersions: [], edges: [], memoryScopes: {}, modelAssignments: {}, budgetAllocation: {} },
    }),
    (error: unknown) => error instanceof InvalidRequestError && /agent-body/.test(error.message),
  );
});

test('LAB-001 (c): the capability candidate lifecycle — declared → simulation_verified → real_verified', async () => {
  const capability = await lab.createCapabilityCandidate({
    scope: aliceScope,
    contract: {
      inputSchemaRef: 'schema://clip-input/v1',
      outputSchemaRef: 'schema://clip-output/v1',
      constraints: ['max-duration-60s'],
      qualityEvaluatorRef: 'eval://clip-quality/v1',
      costUnits: 5,
      latencyBoundMs: 30_000,
      provenance: 'declared by the mission planner',
      simulatorImplementationRef: 'pending',
      realImplementationRef: 'pending',
      humanProviderRequirements: [],
    },
  });
  assert.equal(capability.status, 'declared');

  // The illegal skip: declared → real_verified is refused.
  await assert.rejects(
    () => lab.setCapabilityCandidateStatus(aliceScope, capability.capabilityCandidateId, 'real_verified'),
    (error: unknown) => error instanceof InvalidRequestError && /not legal/.test(error.message),
  );

  const simVerified = await lab.setCapabilityCandidateStatus(aliceScope, capability.capabilityCandidateId, 'simulation_verified');
  assert.equal(simVerified.status, 'simulation_verified');
  const realVerified = await lab.setCapabilityCandidateStatus(aliceScope, capability.capabilityCandidateId, 'real_verified');
  assert.equal(realVerified.status, 'real_verified');
});

test('LAB-001 (c/e): the calibration record — the opaque external outcome anchor, the applied transition and cross-scope refusal', async () => {
  const scope = await makeFreshScope('calib');
  const scenario = await lab.createScenario({
    scope,
    binding: { niche: 'n', platform: 'youtube', corpusVersion: 'pending', worldModelVersion: 'pending' },
    reward: REWARD,
    runConfiguration: CONFIG,
  });
  await lab.activateScenario(scope, scenario.scenarioId);
  const run = await lab.createRun({ scope, scenarioId: scenario.scenarioId, timeMachine: tm(), seeds: SEEDS });
  const candidate = await lab.createStrategyCandidate({ scope, scenarioId: scenario.scenarioId, declaration: DECLARATION });

  // The opaque anchor: a well-formed uuid that intentionally does NOT exist in
  // any authority table — the Lab stores it as data and never resolves it.
  const outcomeId = '99999999-9999-4999-8999-999999999999';
  const record = await lab.createCalibrationRecord({
    scope,
    worldModelVersion: 'wm-test-v1',
    strategyCandidateId: candidate.candidateId,
    runId: run.runId,
    simulatedPrediction: {
      reward: 12.0,
      uncertaintyInterval: [10.0, 14.0],
      factuality: 'simulated_model_output',
      metrics: { qualified_reach: 4000 },
    },
    realOutcome: {
      referenceKind: 'experiment',
      authority: 'experiments',
      referenceId: outcomeId,
      outcomeSummary: { qualified_reach: 3500 },
      observedAt: '2026-03-05T00:00:00.000Z',
    },
    predictionError: { qualified_reach: -500 },
    environmentState: { regime: 'stable' },
    observedRegime: 'regime-stable',
  });
  assert.equal(record.status, 'recorded');
  assert.equal(record.calibrationUpdateVersion, 'pending');
  assert.equal(record.realOutcome.referenceId, outcomeId);

  // Bob cannot read it (the uniform NotFound).
  await assert.rejects(
    () => lab.getCalibrationRecord(bobScope, record.calibrationRecordId),
    (error: unknown) => error instanceof NotFoundError,
  );

  const applied = await lab.applyCalibrationRecord(scope, record.calibrationRecordId, 'calib-update-v1');
  assert.equal(applied.status, 'applied');
  assert.equal(applied.calibrationUpdateVersion, 'calib-update-v1');
  // Applied is terminal.
  await assert.rejects(
    () => lab.applyCalibrationRecord(scope, record.calibrationRecordId, 'calib-update-v2'),
    (error: unknown) => error instanceof InvalidRequestError && /recorded/.test(error.message),
  );
});
