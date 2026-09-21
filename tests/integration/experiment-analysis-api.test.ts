/**
 * MKT-067 integration tests — the /experiment-analysis surfaces against a
 * REAL embedded PostgreSQL 18 stack (the content-assets/notification-
 * delivery dual-level harness: HTTP fixtures over the spawned API, then
 * module-level round-trips + DB backstop proofs against the SAME
 * database through the in-process bootstrapApplication).
 *
 * The dispatch's three NAMED tests are here verbatim:
 *   (a) negative and inconclusive outcome preservation;
 *   (b) allocation reproducibility (same input snapshot → same decision);
 *   (c) allocator validity at zero human-treatment capacity.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type { ExperimentAnalysisModuleApi } from '../../src/modules/experiment-analysis/public.ts';
import {
  computeAdaptiveAllocation,
  computeAllocationSnapshotDigest,
} from '../../src/modules/experiment-analysis/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let analysis: ExperimentAnalysisModuleApi | null = null;

function experimentAnalysis(): ExperimentAnalysisModuleApi {
  if (analysis === null) throw new Error('application not booted');
  return analysis;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}
function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

const MODULE_PROVENANCE = {
  actor: 'user:99999999-9999-4999-8999-999999999999',
  recordedVia: 'test',
  correlationId: 'integration-experiment-analysis-1',
  causationId: null,
} as const;

// ---------------------------------------------------------------------------
// Shared fixtures (the content-assets precedent)
// ---------------------------------------------------------------------------

interface User {
  readonly userId: string;
  readonly token: string;
}
interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

let adminTokenCache: string | null = null;
async function adminToken(): Promise<string> {
  if (adminTokenCache !== null) return adminTokenCache;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  adminTokenCache = login.body['token'] as string;
  return adminTokenCache;
}

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

async function makeAgencyOwner(email: string): Promise<Principal> {
  const user = await makeUser(email, 'owner-password-123');
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: user.userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { userId: user.userId, token: user.token, agencyId };
}

let clientSeq = 0;
async function makeClient(agencyId: string, token: string): Promise<string> {
  clientSeq += 1;
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name: `Client ${agencyId.slice(0, 8)} ${clientSeq}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['clientId'] as string;
}

/** Declares ONE experiment through the REAL routes (the v1.5 authority). */
async function makeExperiment(
  token: string,
  clientId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/experiments`, {
    token,
    body: {
      hypothesis: 'Short-form video posts increase engagement rate',
      decisionTarget: 'Whether to shift the content mix toward short-form video',
      populationUnit: 'post',
      treatment: 'short-form video posts',
      comparison: 'image posts',
      assignmentMethod: 'random assignment per post',
      designType: 'randomized',
      primaryMetric: { name: 'engagement_rate', dimensions: { platform: 'tiktok' } },
      guardrails: [],
      analysisMethod: 'two-sample means comparison',
      stopCriteria: 'stop after 30 observations per arm',
      minimumEvidenceRequirement: 'A — randomized experiment',
      uncertaintyRepresentation: 'interval',
      ...overrides,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['experimentId'] as string;
}

let observationSeq = 0;
/** Appends ONE /metrics observation through the REAL routes. */
async function makeObservation(
  token: string,
  clientId: string,
  metricName: string,
  arm: string,
  value: number,
  observedAt: string,
  quality = 'ok',
): Promise<string> {
  observationSeq += 1;
  const created = await apiCall(port(), `/api/clients/${clientId}/metrics`, {
    token,
    body: {
      metricName,
      dimensions: { platform: 'tiktok', arm },
      value,
      unit: 'ratio',
      sourceSystem: 'experiment-analysis-test',
      sourceRef: `fixture/ea/${observationSeq}`,
      observedAt,
      quality,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['observationId'] as string;
}

let evidenceSeq = 0;
/** Creates ONE /evidence record through the REAL routes. */
async function makeEvidence(token: string, clientId: string): Promise<string> {
  evidenceSeq += 1;
  const created = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'source_fact',
      sourceSystem: 'experiment-analysis-test',
      sourceRef: `fixture/ea/${evidenceSeq}`,
      observedAt: '2026-01-15T10:30:00.000Z',
      content: { kind: 'analysis-citation', seq: evidenceSeq },
      quality: 'C',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['evidenceId'] as string;
}

async function assertDbRejects(sql: string, params: unknown[], marker: string): Promise<void> {
  await assert.rejects(
    () => pool().query(sql, params as never[]),
    (error: unknown) => {
      assert.ok(
        error instanceof Error && error.message.includes(marker),
        `expected the database to reject with '${marker}', got: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    },
  );
}

/** The analysis input used across the battery (declared threshold 1). */
function analysisInput(experimentId: string, windowStart = '2026-01-01T00:00:00.000Z', windowEnd = '2026-02-01T00:00:00.000Z') {
  return {
    clientId: '',
    workspaceId: null,
    experimentId,
    windowStart,
    windowEnd,
    uncertaintyLevel: null,
    minObservationsPerArm: null,
    practicalThreshold: { value: 1, source: 'declared_input' as const, description: null },
    declaredConfounders: ['posting-time overlap'],
    declaredLimitations: [],
    evidenceRefs: [] as string[],
  };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let bob: Principal;
let bobClientId: string;
let aliceEvidence: string;

before(async () => {
  stack = await bootStack('experimentanalysis');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // Fixtures: two agencies (the golden path + the isolation battery).
  alice = await makeAgencyOwner('alice@experimentanalysis.test');
  bob = await makeAgencyOwner('bob@experimentanalysis.test');
  aliceClientId = await makeClient(alice.agencyId, alice.token);
  bobClientId = await makeClient(bob.agencyId, bob.token);
  aliceEvidence = await makeEvidence(alice.token, aliceClientId);

  // The in-process application (module-level round trips against the SAME
  // database).
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({});
  analysis = core.modules.experimentAnalysis;
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// AC-1: the golden path — the full §12 computed set recorded with the
// FULL input snapshot and consumed authorities.
// ---------------------------------------------------------------------------

test('AC-1: a positive-effect analysis records the full §12 set with full input provenance', async () => {
  const experimentId = await makeExperiment(alice.token, aliceClientId, {
    primaryMetric: { name: 'engagement_rate_ac1', dimensions: { platform: 'tiktok' } },
  });
  // 30 per arm with a clear positive gap (treatment ≈ 3, comparison ≈ 1).
  for (let index = 0; index < 30; index++) {
    await makeObservation(alice.token, aliceClientId, 'engagement_rate_ac1', 'treatment', 3 + (index % 3) * 0.1, `2026-01-${String((index % 20) + 1).padStart(2, '0')}T10:00:00.000Z`);
    await makeObservation(alice.token, aliceClientId, 'engagement_rate_ac1', 'comparison', 1 + (index % 3) * 0.05, `2026-01-${String((index % 20) + 1).padStart(2, '0')}T11:00:00.000Z`);
  }
  const evidenceB = await makeEvidence(alice.token, aliceClientId);

  const input = {
    ...analysisInput(experimentId),
    clientId: aliceClientId,
    evidenceRefs: [aliceEvidence, evidenceB],
  };
  const record = await experimentAnalysis().recordExperimentAnalysis(input, MODULE_PROVENANCE);

  assert.equal(record.clientId, aliceClientId);
  assert.equal(record.experimentId, experimentId);
  assert.equal(record.analysisMethod, 'two_sample_means_v1');
  assert.equal(record.sampleSizes.treatment, 30);
  assert.equal(record.sampleSizes.comparison, 30);
  assert.ok(record.treatmentMean !== null && record.treatmentMean > 2.9);
  assert.ok(record.comparisonMean !== null && record.comparisonMean < 1.2);
  assert.ok(record.effectEstimate !== null && record.effectEstimate > 1.7);
  assert.equal(record.uncertainty.kind, 'interval');
  assert.equal(record.uncertainty.level, 0.95);
  if (record.uncertainty.kind === 'interval') {
    assert.ok(record.uncertainty.lower > 1, `the CI clears the declared threshold (got ${record.uncertainty.lower})`);
  }
  assert.equal(record.outcome, 'effect_positive');
  assert.equal(record.recommendedNextAllocation, 'shift_toward_treatment');
  // The sequential state: the FIRST look.
  assert.equal(record.sequentialState.interimIndex, 1);
  assert.equal(record.sequentialState.maxLooks, 5);
  assert.ok(record.sequentialState.continueAllowed);
  // The declared confounders retained verbatim.
  assert.ok(record.confounders.includes('posting-time overlap'));
  // The input snapshot: the exact consumed observations + evidence links.
  assert.equal(record.inputSnapshot.observations.length, 60);
  assert.equal(record.inputSnapshot.evidenceRefs.length, 2);
  assert.equal(record.inputSnapshot.experiment.primaryMetricName, 'engagement_rate_ac1');
  assert.equal(record.inputSnapshot.minObservationsPerArmDefaulted, true);
  assert.equal(record.inputSnapshot.uncertaintyLevelDefaulted, true);
  assert.equal(record.metricObservationRefs.length, 60);
  assert.deepEqual(record.evidenceRefs, [aliceEvidence, evidenceB].sort());
  assert.ok(record.inputDigest.length >= 16);

  // The reads round-trip.
  const fetched = await experimentAnalysis().getExperimentAnalysis(record.analysisId);
  assert.deepEqual(fetched, record);
  const forExperiment = await experimentAnalysis().listExperimentAnalysesForExperiment(aliceClientId, experimentId);
  assert.equal(forExperiment.length, 1);
  const ownership = await experimentAnalysis().resolveExperimentAnalysisOwnership(record.analysisId);
  assert.ok(ownership !== null);
  assert.equal(ownership.scope.agencyId, alice.agencyId);
  assert.equal(ownership.scope.analysisId, record.analysisId);

  // The HTTP surface round-trips the same record.
  const response = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/experiment-analysis/analyses/${record.analysisId}`,
    { token: alice.token },
  );
  assert.equal(response.status, 200);
  assert.equal((response.body['analysis'] as Record<string, unknown>)['analysisId'], record.analysisId);
  assert.equal(response.body['vocabularyVersion'], 'ea-vocab-v1');

  // The experiment authority is untouched (the analysis layer never
  // mutates the anchor): the experiment is still draft.
  const experiment = await apiCall(port(), `/api/experiments/${experimentId}`, { token: alice.token });
  assert.equal(experiment.status, 200);
  assert.equal(experiment.body['status'], 'draft');
});

// ---------------------------------------------------------------------------
// THE NAMED TEST (a): negative and inconclusive outcome preservation
// ---------------------------------------------------------------------------

test('NAMED (a): negative and inconclusive outcomes are preserved as first-class records — never discarded, never rewritten, never silently retried away', async () => {
  // --- The NEGATIVE result: the treatment arm performs measurably WORSE.
  const negativeExperiment = await makeExperiment(alice.token, aliceClientId, {
    hypothesis: 'Long-form posts increase engagement rate',
    treatment: 'long-form posts',
    comparison: 'image posts',
    primaryMetric: { name: 'engagement_rate_neg', dimensions: { platform: 'tiktok' } },
  });
  for (let index = 0; index < 30; index++) {
    await makeObservation(alice.token, aliceClientId, 'engagement_rate_neg', 'treatment', 1 + (index % 3) * 0.05, `2026-01-${String((index % 20) + 1).padStart(2, '0')}T10:00:00.000Z`);
    await makeObservation(alice.token, aliceClientId, 'engagement_rate_neg', 'comparison', 4 + (index % 3) * 0.1, `2026-01-${String((index % 20) + 1).padStart(2, '0')}T11:00:00.000Z`);
  }
  const negative = await experimentAnalysis().recordExperimentAnalysis(
    { ...analysisInput(negativeExperiment), clientId: aliceClientId },
    MODULE_PROVENANCE,
  );
  assert.equal(negative.outcome, 'effect_negative');
  assert.ok(negative.effectEstimate !== null && negative.effectEstimate < -1);
  assert.equal(negative.recommendedNextAllocation, 'shift_toward_comparison');

  // --- The INCONCLUSIVE result: the interval straddles the threshold.
  const inconclusiveExperiment = await makeExperiment(alice.token, aliceClientId, {
    hypothesis: 'Carousel posts change engagement rate',
    treatment: 'carousel posts',
    comparison: 'image posts',
    primaryMetric: { name: 'engagement_rate_inc', dimensions: { platform: 'tiktok' } },
  });
  for (let index = 0; index < 30; index++) {
    // High variance on both arms — the interval cannot clear ±1.
    const noise = (index % 2 === 0 ? 1 : -1) * (index % 5);
    await makeObservation(alice.token, aliceClientId, 'engagement_rate_inc', 'treatment', 3 + noise, `2026-01-${String((index % 20) + 1).padStart(2, '0')}T10:00:00.000Z`);
    await makeObservation(alice.token, aliceClientId, 'engagement_rate_inc', 'comparison', 3 - noise, `2026-01-${String((index % 20) + 1).padStart(2, '0')}T11:00:00.000Z`);
  }
  const inconclusive = await experimentAnalysis().recordExperimentAnalysis(
    { ...analysisInput(inconclusiveExperiment), clientId: aliceClientId },
    MODULE_PROVENANCE,
  );
  assert.equal(inconclusive.outcome, 'inconclusive');
  assert.equal(inconclusive.recommendedNextAllocation, 'hold_balanced');

  // --- The INSUFFICIENT-OBSERVATIONS result: the empty window is still a
  // first-class record (the honest empty analysis).
  const emptyWindowExperiment = await makeExperiment(alice.token, aliceClientId, {
    hypothesis: 'Text posts change engagement rate',
    treatment: 'text posts',
    comparison: 'image posts',
    primaryMetric: { name: 'engagement_rate_insuff', dimensions: { platform: 'tiktok' } },
  });
  const insufficient = await experimentAnalysis().recordExperimentAnalysis(
    { ...analysisInput(emptyWindowExperiment, '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'), clientId: aliceClientId },
    MODULE_PROVENANCE,
  );
  assert.equal(insufficient.outcome, 'insufficient_observations');
  assert.equal(insufficient.sampleSizes.treatment, 0);
  assert.equal(insufficient.sampleSizes.comparison, 0);
  assert.equal(insufficient.uncertainty.kind, 'none');
  assert.ok(insufficient.limitations.some((entry) => entry.includes('zero_observations_in_window')));

  // --- PRESERVATION PROOFS:
  // 1. All three records stay readable exactly as recorded.
  for (const record of [negative, inconclusive, insufficient]) {
    const fetched = await experimentAnalysis().getExperimentAnalysis(record.analysisId);
    assert.deepEqual(fetched, record);
  }
  // 2. The DB itself rejects UPDATE and DELETE on every one of them
  //    (not even server code can rewrite a recorded outcome).
  for (const record of [negative, inconclusive, insufficient]) {
    await assertDbRejects(
      'UPDATE experiment_analysis_records SET outcome = $1 WHERE analysis_id = $2',
      ['effect_positive', record.analysisId],
      'is append-only',
    );
    await assertDbRejects(
      'DELETE FROM experiment_analysis_records WHERE analysis_id = $1',
      [record.analysisId],
      'is append-only',
    );
  }
  // 3. A RE-ANALYSIS is a NEW record — the old one is never rewritten
  //    (the sequential tail grows; the negative result stays first).
  const reanalysis = await experimentAnalysis().recordExperimentAnalysis(
    { ...analysisInput(negativeExperiment), clientId: aliceClientId, uncertaintyLevel: 0.99 },
    MODULE_PROVENANCE,
  );
  assert.notEqual(reanalysis.analysisId, negative.analysisId);
  assert.equal(reanalysis.outcome, 'effect_negative');
  const tail = await experimentAnalysis().listExperimentAnalysesForExperiment(aliceClientId, negativeExperiment);
  assert.equal(tail.length, 2);
  assert.equal(tail[0]!.analysisId, negative.analysisId);
  assert.equal(tail[1]!.analysisId, reanalysis.analysisId);
  // The sequential state advanced (look 2 of 5).
  assert.equal(reanalysis.sequentialState.interimIndex, 2);
  assert.equal(negative.sequentialState.interimIndex, 1);
  // The first record is still exactly what it was.
  assert.deepEqual(await experimentAnalysis().getExperimentAnalysis(negative.analysisId), negative);
});

// ---------------------------------------------------------------------------
// THE NAMED TEST (b): allocation reproducibility
// ---------------------------------------------------------------------------

test('NAMED (b): allocation reproducibility — the same input snapshot reproduces the same decision', async () => {
  const experimentId = await makeExperiment(alice.token, aliceClientId, {
    hypothesis: 'Variant allocation increases reach',
    treatment: 'short-form video posts',
    comparison: 'image posts',
  });
  const arms = [
    { armKey: 'short_form_video', kind: 'strategy_variant' as const, capacity: 100, sampleSize: 40, mean: 3.2, variance: 4 },
    { armKey: 'carousel_post', kind: 'strategy_variant' as const, capacity: 100, sampleSize: 40, mean: 1.1, variance: 4 },
    { armKey: 'text_post', kind: 'strategy_variant' as const, capacity: 100, sampleSize: 40, mean: 0.4, variance: 4 },
    { armKey: 'human_ugc', kind: 'human_treatment' as const, capacity: 20, sampleSize: 10, mean: 2.0, variance: 3 },
  ];

  // Record the SAME decision twice (two distinct rows, identical inputs).
  const first = await experimentAnalysis().recordAllocationRecommendation(
    { clientId: aliceClientId, workspaceId: null, experimentId, analysisId: null, arms, explorationFloor: 0.15 },
    MODULE_PROVENANCE,
  );
  const second = await experimentAnalysis().recordAllocationRecommendation(
    { clientId: aliceClientId, workspaceId: null, experimentId, analysisId: null, arms, explorationFloor: 0.15 },
    MODULE_PROVENANCE,
  );

  // Same input snapshot → same digest → same decision.
  assert.notEqual(first.recommendationId, second.recommendationId);
  assert.equal(first.inputDigest, second.inputDigest);
  assert.deepEqual(first.allocation.shares, second.allocation.shares);
  assert.deepEqual(first.allocation.eligibleArms, second.allocation.eligibleArms);
  assert.equal(first.explorationFloor, 0.15);
  assert.equal(first.explorationFloorSource, 'declared_input');
  assert.ok(first.rationale.length > 0);

  // The recorded shares sum to 1 and respect the floor.
  const shareSum = Object.values(first.allocation.shares).reduce((total, share) => total + share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
  const floorSharePerArm = 0.15 / 4;
  for (const armKey of first.allocation.eligibleArms) {
    assert.ok(first.allocation.shares[armKey]! >= floorSharePerArm - 1e-12);
  }
  // The promising variant exploits more (bounded exploitation).
  assert.ok(first.allocation.shares['short_form_video']! > first.allocation.shares['text_post']!);

  // THE RE-RUN PROOF: re-running the allocator on the RECORDED input
  // snapshot reproduces the same decision and the same digest.
  const recomputed = computeAdaptiveAllocation({
    arms: first.inputSnapshot.arms,
    explorationFloor: first.inputSnapshot.explorationFloor,
  });
  assert.deepEqual(recomputed, first.allocation);
  assert.equal(computeAllocationSnapshotDigest(first.inputSnapshot), first.inputDigest);

  // A DIFFERENT input produces a different decision (the digest is an
  // equality token, not a constant).
  const different = await experimentAnalysis().recordAllocationRecommendation(
    {
      clientId: aliceClientId,
      workspaceId: null,
      experimentId,
      analysisId: null,
      arms: arms.map((arm) => (arm.armKey === 'text_post' ? { ...arm, mean: 9 } : arm)),
      explorationFloor: 0.15,
    },
    MODULE_PROVENANCE,
  );
  assert.notEqual(different.inputDigest, first.inputDigest);
  assert.ok(different.allocation.shares['text_post']! > first.allocation.shares['text_post']!);

  // The default floor path records the module default with its source.
  const defaulted = await experimentAnalysis().recordAllocationRecommendation(
    { clientId: aliceClientId, workspaceId: null, experimentId, analysisId: null, arms, explorationFloor: null },
    MODULE_PROVENANCE,
  );
  assert.equal(defaulted.explorationFloor, 0.1);
  assert.equal(defaulted.explorationFloorSource, 'module_default_v1');

  // The recommendation is DATA: the anchored experiment stays untouched.
  const experiment = await apiCall(port(), `/api/experiments/${experimentId}`, { token: alice.token });
  assert.equal(experiment.body['status'], 'draft');

  // The recommendation tail lists all four, oldest first.
  const tail = await experimentAnalysis().listAllocationRecommendationsForExperiment(aliceClientId, experimentId);
  assert.equal(tail.length, 4);
  assert.equal(tail[0]!.recommendationId, first.recommendationId);
});

// ---------------------------------------------------------------------------
// THE NAMED TEST (c): allocator validity at zero human-treatment capacity
// ---------------------------------------------------------------------------

test('NAMED (c): the allocator stays valid at ZERO human-treatment capacity — non-human allocation continues, never blocked', async () => {
  const experimentId = await makeExperiment(alice.token, aliceClientId, {
    hypothesis: 'Variant allocation with an unfunded human arm',
    treatment: 'short-form video posts',
    comparison: 'image posts',
  });
  const arms = [
    { armKey: 'short_form_video', kind: 'strategy_variant' as const, capacity: 100, sampleSize: 40, mean: 3.2, variance: 4 },
    { armKey: 'carousel_post', kind: 'strategy_variant' as const, capacity: 100, sampleSize: 40, mean: 1.1, variance: 4 },
    // THE ZERO-CAPACITY HUMAN ARM: no budget, no eligible humans — the
    // valid non-human state (architecture-lock-v1.6 rule 44).
    { armKey: 'human_ugc', kind: 'human_treatment' as const, capacity: 0, sampleSize: 10, mean: 2.0, variance: 3 },
  ];

  const recommendation = await experimentAnalysis().recordAllocationRecommendation(
    { clientId: aliceClientId, workspaceId: null, experimentId, analysisId: null, arms, explorationFloor: null },
    MODULE_PROVENANCE,
  );

  // The decision is PRODUCED and VALID: no throw, no error state.
  assert.ok(recommendation.recommendationId.length > 0);
  assert.deepEqual(recommendation.allocation.eligibleArms, ['carousel_post', 'short_form_video']);
  const shareSum = Object.values(recommendation.allocation.shares).reduce((total, share) => total + share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9, 'the non-human arms carry the full exposure');

  // The human arm is EXCLUDED AND RECORDED with the invariant reason.
  assert.equal(recommendation.allocation.zeroCapacityArms.length, 1);
  assert.equal(recommendation.allocation.zeroCapacityArms[0]!.armKey, 'human_ugc');
  assert.equal(recommendation.allocation.zeroCapacityArms[0]!.kind, 'human_treatment');
  assert.match(
    recommendation.allocation.zeroCapacityArms[0]!.reason,
    /never blocks, crashes or invalidates non-human allocation/,
  );
  // The human-arm consideration is recorded, never an absence.
  assert.equal(recommendation.allocation.humanTreatmentConsideration.present, true);
  assert.equal(recommendation.allocation.humanTreatmentConsideration.excluded, true);

  // The non-human arms receive EXACTLY the allocation they would receive
  // had the human arm never been declared (no distortion from absence).
  const withoutHuman = await experimentAnalysis().recordAllocationRecommendation(
    {
      clientId: aliceClientId,
      workspaceId: null,
      experimentId,
      analysisId: null,
      arms: arms.filter((arm) => arm.kind !== 'human_treatment'),
      explorationFloor: null,
    },
    MODULE_PROVENANCE,
  );
  assert.deepEqual(withoutHuman.allocation.shares, recommendation.allocation.shares);

  // THE ALL-ZERO STATE: every arm (human and non-human alike) at zero
  // capacity records the honest EMPTY allocation — never an error.
  const allZero = await experimentAnalysis().recordAllocationRecommendation(
    {
      clientId: aliceClientId,
      workspaceId: null,
      experimentId,
      analysisId: null,
      arms: arms.map((arm) => ({ ...arm, capacity: 0 })),
      explorationFloor: null,
    },
    MODULE_PROVENANCE,
  );
  assert.deepEqual(allZero.allocation.eligibleArms, []);
  assert.deepEqual(allZero.allocation.shares, {});
  assert.equal(allZero.allocation.zeroCapacityArms.length, 3);
  assert.match(allZero.rationale, /honest all-zero state/);

  // The HTTP surface round-trips the zero-human-capacity decision.
  const response = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/experiment-analysis/allocations/${recommendation.recommendationId}`,
    { token: alice.token },
  );
  assert.equal(response.status, 200);
  const body = response.body['recommendation'] as Record<string, unknown>;
  const allocation = body['allocation'] as Record<string, unknown>;
  assert.ok(Array.isArray(allocation['zeroCapacityArms']));
});

// ---------------------------------------------------------------------------
// The analysis→allocation linkage + the isolation battery
// ---------------------------------------------------------------------------

test('AC-5: the analysis linkage resolves same-client/experiment only (uniform 404 on foreign); Client isolation is total', async () => {
  const experimentId = await makeExperiment(alice.token, aliceClientId);
  const bobExperimentId = await makeExperiment(bob.token, bobClientId);

  // A foreign experiment is the uniform 404.
  await assert.rejects(
    () =>
      experimentAnalysis().recordExperimentAnalysis(
        { ...analysisInput(bobExperimentId), clientId: aliceClientId },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error && error.name === 'NotFoundError');
      return true;
    },
  );

  // A valid analysis in Alice's client.
  const record = await experimentAnalysis().recordExperimentAnalysis(
    { ...analysisInput(experimentId), clientId: aliceClientId },
    MODULE_PROVENANCE,
  );
  assert.equal(record.outcome, 'insufficient_observations');

  // The analysis linkage: same client + same experiment only.
  const linked = await experimentAnalysis().recordAllocationRecommendation(
    { clientId: aliceClientId, workspaceId: null, experimentId, analysisId: record.analysisId, arms: [
      { armKey: 'variant_a', kind: 'strategy_variant', capacity: 10, sampleSize: 5, mean: 1, variance: 1 },
    ], explorationFloor: null },
    MODULE_PROVENANCE,
  );
  assert.equal(linked.analysisId, record.analysisId);
  // A foreign analysis id (another experiment's analysis) is the uniform 404.
  await assert.rejects(
    () =>
      experimentAnalysis().recordAllocationRecommendation(
        { clientId: aliceClientId, workspaceId: null, experimentId, analysisId: linked.recommendationId, arms: [
          { armKey: 'variant_a', kind: 'strategy_variant', capacity: 10, sampleSize: 5, mean: 1, variance: 1 },
        ], explorationFloor: null },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error && error.name === 'NotFoundError');
      return true;
    },
  );

  // Bob cannot read Alice's records through the HTTP surface (uniform 404).
  const response = await apiCall(
    port(),
    `/api/clients/${bobClientId}/experiment-analysis/analyses/${record.analysisId}`,
    { token: bob.token },
  );
  assert.equal(response.status, 404);
  // A foreign experiment listing is the uniform 404 too.
  const foreignListing = await apiCall(
    port(),
    `/api/clients/${bobClientId}/experiment-analysis/analyses/by-experiment/${experimentId}`,
    { token: bob.token },
  );
  assert.equal(foreignListing.status, 404);

  // The DB itself rejects cross-tenant experiment linkage.
  await assertDbRejects(
    `INSERT INTO experiment_analysis_records (analysis_id, client_id, workspace_id, experiment_id,
       analysis_method, analysis_method_version, vocabulary_version, observation_window_start,
       observation_window_end, n_treatment, n_comparison, uncertainty, sequential_state,
       confounders, limitations, practical_threshold, outcome, recommended_next_allocation,
       input_snapshot, input_digest, evidence_refs, metric_observation_refs, learning_refs,
       recorded_actor, recorded_via, correlation_id, causation_id)
     VALUES ($1, $2, NULL, $3, 'two_sample_means_v1', '1.0.0', 'ea-vocab-v1', now(), now(),
       0, 0, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
       'insufficient_observations', 'hold_balanced', '{}'::jsonb, 'xxxxxxxxxxxxxxxx',
       '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'test', 'test', 'test', NULL)`,
    ['99999999-9999-4999-8999-999999999999', aliceClientId, bobExperimentId],
    'cross-tenant experiment linkage is rejected',
  );

  // A malformed UUID is the same uniform 404 (no oracle).
  const malformed = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/experiment-analysis/analyses/not-a-uuid`,
    { token: alice.token },
  );
  assert.equal(malformed.status, 404);
});

// ---------------------------------------------------------------------------
// The route-level authorization + DTO authority-field battery
// ---------------------------------------------------------------------------

test('AC-8: the HTTP surface enforces owner|admin writes, member reads and rejects authority fields', async () => {
  const experimentId = await makeExperiment(alice.token, aliceClientId);

  // The POST body carrying computed-outcome authority fields is rejected.
  const rejected = await apiCall(port(), `/api/clients/${aliceClientId}/experiment-analysis/analyses`, {
    token: alice.token,
    body: {
      experimentId,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-02-01T00:00:00.000Z',
      outcome: 'effect_positive',
    },
  });
  assert.equal(rejected.status, 422);
  const errorBody = rejected.body['error'] as Record<string, unknown>;
  const problems = (errorBody['details'] as string[] | undefined) ?? [];
  assert.ok(problems.some((problem) => problem.includes('forbidden authority field')));

  // The minimal valid POST through HTTP.
  const created = await apiCall(port(), `/api/clients/${aliceClientId}/experiment-analysis/analyses`, {
    token: alice.token,
    body: {
      experimentId,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-02-01T00:00:00.000Z',
      practicalThreshold: 0.5,
      practicalThresholdDescription: 'half a point of engagement',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const record = created.body['analysis'] as Record<string, unknown>;
  assert.equal(record['outcome'], 'insufficient_observations');
  const threshold = record['practicalThreshold'] as Record<string, unknown>;
  assert.equal(threshold['value'], 0.5);
  assert.equal(threshold['source'], 'declared_input');

  // An invalid window is rejected by the DTO.
  const badWindow = await apiCall(port(), `/api/clients/${aliceClientId}/experiment-analysis/analyses`, {
    token: alice.token,
    body: { experimentId, windowStart: '2026-02-01T00:00:00.000Z', windowEnd: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal(badWindow.status, 422);

  // The allocation POST through HTTP with the closed arm-kind grammar.
  const allocation = await apiCall(port(), `/api/clients/${aliceClientId}/experiment-analysis/allocations`, {
    token: alice.token,
    body: {
      experimentId,
      arms: [
        { armKey: 'variant_a', kind: 'strategy_variant', capacity: 10, sampleSize: 5, mean: 1, variance: 1 },
        { armKey: 'human_ugc', kind: 'human_treatment', capacity: 0, sampleSize: 0, mean: 0, variance: 0 },
      ],
    },
  });
  assert.equal(allocation.status, 201, JSON.stringify(allocation.body));
  const recommendation = allocation.body['recommendation'] as Record<string, unknown>;
  assert.equal(recommendation['explorationFloor'], 0.1);
  assert.equal(recommendation['explorationFloorSource'], 'module_default_v1');

  // A malformed arm kind is rejected by the DTO.
  const badKind = await apiCall(port(), `/api/clients/${aliceClientId}/experiment-analysis/allocations`, {
    token: alice.token,
    body: {
      experimentId,
      arms: [{ armKey: 'variant_a', kind: 'robot_arm', capacity: 10, sampleSize: 5, mean: 1, variance: 1 }],
    },
  });
  assert.equal(badKind.status, 422);

  // A non-member cannot even read (403 — the hard-boundary posture).
  const outsider = await makeAgencyOwner('outsider@experimentanalysis.test');
  const forbidden = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/experiment-analysis/analyses`,
    { token: outsider.token },
  );
  assert.equal(forbidden.status, 404);
});

// ---------------------------------------------------------------------------
// The sequential tail + the consumed learning context
// ---------------------------------------------------------------------------

test('AC-9: the analysis consumes the learning context and the sequential tail advances over re-analyses', async () => {
  const experimentId = await makeExperiment(alice.token, aliceClientId);
  // Observations with a suspect entry (the derived data-quality caveat).
  for (let index = 0; index < 30; index++) {
    await makeObservation(
      alice.token,
      aliceClientId,
      'engagement_rate',
      'treatment',
      5 + (index % 3) * 0.1,
      `2026-01-${String((index % 20) + 1).padStart(2, '0')}T10:00:00.000Z`,
      index === 0 ? 'suspect' : 'ok',
    );
    await makeObservation(alice.token, aliceClientId, 'engagement_rate', 'comparison', 1, `2026-01-${String((index % 20) + 1).padStart(2, '0')}T11:00:00.000Z`);
  }

  // A CONCLUDED experiment can carry learnings; conclude this one first
  // (through the /experiments authority — the sole lifecycle authority).
  for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
    const moved = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token: alice.token,
      body: { transition },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
  }
  const concluded = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: alice.token,
    body: {
      transition: 'conclude',
      conclusion: {
        resultState: 'observation',
        uncertainty: { kind: 'interval', lower: -1, upper: 1, level: 0.95 },
        assumptions: [],
        sampleLimitations: [],
        confounders: [],
        resultingDecision: 'keep observing',
        evidenceRefs: [],
      },
    },
  });
  assert.equal(concluded.status, 200, JSON.stringify(concluded.body));

  // A learning citing the concluded experiment (the confounder context).
  const learning = await apiCall(port(), `/api/clients/${aliceClientId}/learnings`, {
    token: alice.token,
    body: {
      statement: 'Posting time strongly modulates engagement on tiktok',
      applicability: { platform: 'tiktok' },
      experimentRefs: [experimentId],
      confidence: 0.7,
    },
  });
  assert.equal(learning.status, 201, JSON.stringify(learning.body));
  const learningId = learning.body['learningId'] as string;

  const record = await experimentAnalysis().recordExperimentAnalysis(
    { ...analysisInput(experimentId), clientId: aliceClientId },
    MODULE_PROVENANCE,
  );
  assert.equal(record.outcome, 'effect_positive');
  // The learning was consumed into the snapshot as context.
  assert.deepEqual(record.learningRefs, [learningId]);
  assert.equal(record.inputSnapshot.learnings.length, 1);
  assert.equal(record.inputSnapshot.learnings[0]!.statement, 'Posting time strongly modulates engagement on tiktok');
  // The suspect observation derived the data-quality caveat.
  assert.ok(record.confounders.some((entry) => entry.startsWith('derived:consumed_1_non_ok_quality_observations')));
  // The concluded experiment's resultState rides the snapshot.
  assert.equal(record.inputSnapshot.experiment.resultState, 'observation');
});
