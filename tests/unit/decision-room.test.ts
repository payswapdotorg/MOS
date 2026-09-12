/**
 * MKT-030 unit tests — the Client Decision Room PURE read-model composition
 * (spec/work-items.md MKT-030; requirements UI-001 + UI-AC-01: the decision
 * room displays authoritative backend state, derived — never re-decided —
 * from the composed authorities' records).
 *
 * Proofs:
 *   - composeDecisionRoomEvidenceQuality is the frozen grade-distribution
 *     tally: counts per (class, grade), every grade key present (zeros
 *     included), zero-record classes omitted, totals honest — and PURE
 *     (identical inputs → identical outputs; inputs never mutated);
 *   - deriveDecisionRoomRecommendations presents EXACTLY the applicable
 *     (derived-status 'active') learnings and the CONCLUDED experiments'
 *     declared resulting decisions — a CONTRADICTED learning is excluded,
 *     SUPERSEDED/RETIRED learnings are excluded, a concluded experiment
 *     WITHOUT a decision is excluded, and the frozen evidence-and-
 *     experimentation contract rides verbatim (design type + analysis
 *     method + result state; attribution is never serialized as causal
 *     lift — no lift field exists at all);
 *   - deriveDecisionRoomApprovals surfaces only the pending states durable
 *     state already exposes: experiments in NON-TERMINAL lifecycle states
 *     with an UNDECIDED result (draft/ready/running/analyzing) and workflow
 *     instances BLOCKED or PAUSED — concluded/stopped/invalidated
 *     experiments and every other §5 instance state are excluded;
 *   - the WHAT HAPPENED / WHY / EXPERIMENTS compositions present the
 *     authoritative rows field for field (statuses, applicability, the
 *     DERIVED supersession pointer, the resulting decision surfaced
 *     verbatim) with full-key status tallies;
 *   - every tally includes EVERY frozen status key with zeros included
 *     (stable response shape for the frontend).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeDecisionRoomEvidenceQuality,
  composeDecisionRoomExperiments,
  composeDecisionRoomWhatHappened,
  composeDecisionRoomWhy,
  deriveDecisionRoomApprovals,
  deriveDecisionRoomRecommendations,
  tallyExperimentStatuses,
  tallyGoalStatuses,
  tallyInstanceStatuses,
  tallyLearningStatuses,
} from '../../src/modules/reporting/public.ts';
import type {
  EvidenceRecord,
  EvidenceClass,
  EvidenceQualityGrade,
} from '../../src/modules/evidence/public.ts';
import type { ExperimentRecord } from '../../src/modules/experiments/public.ts';
import type { GoalRecord } from '../../src/modules/goals/public.ts';
import type { LearningRecord, LearningStatus } from '../../src/modules/learnings/public.ts';
import type {
  WorkflowInstanceRecord,
  WorkflowRecord,
} from '../../src/modules/workflows/public.ts';

// ---------------------------------------------------------------------------
// Fixtures (minimal-but-complete authoritative records)
// ---------------------------------------------------------------------------

const CLIENT = '11111111-1111-4111-8111-111111111111';
const AGENCY = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';

function evidenceRecord(overrides: {
  class: EvidenceClass;
  quality: EvidenceQualityGrade;
  evidenceId?: string;
}): EvidenceRecord {
  return {
    evidenceId: overrides.evidenceId ?? '44444444-4444-4444-8444-444444444444',
    clientId: CLIENT,
    workspaceId: null,
    class: overrides.class,
    source: { system: 'internal', ref: null },
    observedAt: '2026-02-15T10:00:00.000Z',
    content: { metric: 'activation_rate', value: 0.31 },
    contentRef: null,
    quality: overrides.quality,
    confidence: null,
    supersedes: null,
    supersededBy: null,
    provenance: {
      actor: 'user:99999999-9999-4999-8999-999999999999',
      recordedVia: 'api',
      correlationId: 'correlation-1',
      causationId: null,
      recordedAt: '2026-02-15T10:05:00.000Z',
    },
  };
}

function experimentRecord(overrides: {
  status: ExperimentRecord['status'];
  resultState: ExperimentRecord['resultState'];
  resultingDecision: string | null;
  designType?: ExperimentRecord['designType'];
  experimentId?: string;
}): ExperimentRecord {
  return {
    experimentId: overrides.experimentId ?? '55555555-5555-4555-8555-555555555555',
    clientId: CLIENT,
    workspaceId: null,
    hypothesis: 'A 5-touch onboarding email sequence increases new-account activation.',
    decisionTarget: 'Whether to roll the 5-touch onboarding sequence out to all new clients.',
    populationUnit: 'New client accounts, account level.',
    treatment: '5-touch onboarding email sequence.',
    comparison: 'Current 3-touch onboarding sequence.',
    assignmentMethod: 'Simple random assignment, 50/50.',
    designType: overrides.designType ?? 'randomized',
    primaryMetric: { name: 'activation_rate', dimensions: { cohort: 'new_accounts' } },
    guardrails: [{ name: 'unsubscribe_rate', dimensions: {} }],
    analysisMethod: 'Two-proportion z-test on account-level activation.',
    analysisMethodVersion: 'v2',
    expectedDirection: 'increase',
    startCriteria: null,
    stopCriteria: 'Stop at 2000 accounts per arm.',
    minimumEvidenceRequirement: 'B — strong quasi-experimental design at minimum.',
    uncertaintyRepresentation: 'interval',
    status: overrides.status,
    resultState: overrides.resultState,
    resultingDecision: overrides.resultingDecision,
    concludedAt: overrides.status === 'concluded' ? '2026-03-01T12:00:00.000Z' : null,
    provenance: {
      actor: 'user:99999999-9999-4999-8999-999999999999',
      recordedVia: 'api',
      correlationId: 'correlation-2',
      causationId: null,
      recordedAt: '2026-02-20T09:00:00.000Z',
    },
  };
}

function learningRecord(overrides: {
  status: LearningStatus;
  supersededBy?: string | null;
  learningId?: string;
}): LearningRecord {
  return {
    learningId: overrides.learningId ?? '66666666-6666-4666-8666-666666666666',
    clientId: CLIENT,
    workspaceId: null,
    statement: 'A 5-touch onboarding sequence increases new-account activation.',
    applicability: { channel: 'email', cohort: 'new_accounts' },
    evidenceRefs: [],
    experimentRefs: [],
    confidence: 0.82,
    status: overrides.status,
    supersededBy: overrides.supersededBy ?? null,
    provenance: {
      actor: 'user:99999999-9999-4999-8999-999999999999',
      recordedVia: 'api',
      correlationId: 'correlation-3',
      causationId: null,
      recordedAt: '2026-03-02T08:00:00.000Z',
    },
  };
}

function goalRecord(overrides: { status: GoalRecord['status']; goalId?: string }): GoalRecord {
  return {
    goalId: overrides.goalId ?? '77777777-7777-4777-8777-777777777777',
    clientId: CLIENT,
    workspaceId: WORKSPACE,
    objective: 'Increase new-account activation to 40%.',
    successCriteria: [
      { metric: 'activation_rate', comparator: '>=', targetValue: 0.4, unit: '%', description: null },
    ],
    metrics: [{ name: 'activation_rate', unit: '%', description: null }],
    constraints: [{ kind: 'time', description: 'Within Q2 2026.' }],
    timeHorizon: { startsOn: '2026-04-01', endsOn: '2026-06-30' },
    status: overrides.status,
    createdBy: null,
    version: 1,
    createdAt: '2026-01-10T09:00:00.000Z',
    updatedAt: '2026-01-10T09:00:00.000Z',
  };
}

function workflowRecord(workflowId: string): WorkflowRecord {
  return {
    workflowId,
    workspaceId: WORKSPACE,
    clientId: CLIENT,
    agencyId: AGENCY,
    name: 'Onboarding Sequence',
    description: 'The new-account onboarding email sequence workflow.',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-12T09:00:00.000Z',
    updatedAt: '2026-01-12T09:00:00.000Z',
  };
}

function instanceRecord(
  workflowId: string,
  status: WorkflowInstanceRecord['status'],
  instanceId: string,
): WorkflowInstanceRecord {
  return {
    workflowInstanceId: instanceId,
    workflowId,
    workflowDefinitionId: '88888888-8888-4888-8888-888888888888',
    workspaceId: WORKSPACE,
    clientId: CLIENT,
    agencyId: AGENCY,
    status,
    createdBy: null,
    version: 1,
    createdAt: '2026-01-13T09:00:00.000Z',
    updatedAt: '2026-01-13T09:00:00.000Z',
  };
}

/** Deep freeze: any mutation attempt inside a pure derivation throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// EVIDENCE QUALITY — the frozen grade-distribution tally
// ---------------------------------------------------------------------------

test('evidence quality posture tallies grades per class with every grade key present', () => {
  const records = [
    evidenceRecord({ class: 'source_fact', quality: 'A' }),
    evidenceRecord({ class: 'source_fact', quality: 'A' }),
    evidenceRecord({ class: 'source_fact', quality: 'C' }),
    evidenceRecord({ class: 'observation', quality: 'B' }),
    evidenceRecord({ class: 'inference', quality: 'E' }),
  ];
  const posture = composeDecisionRoomEvidenceQuality(records);
  assert.equal(posture.totalRecords, 5);
  assert.deepEqual(
    posture.byClass.map((entry) => entry.class),
    ['source_fact', 'observation', 'inference'],
    'classes appear in the frozen EVIDENCE_CLASSES order',
  );
  const sourceFact = posture.byClass[0]!;
  assert.equal(sourceFact.total, 3);
  assert.equal(sourceFact.gradeCounts['A'], 2);
  assert.equal(sourceFact.gradeCounts['C'], 1);
  assert.equal(sourceFact.gradeCounts['B'], 0, 'zero grades stay present (stable shape)');
  assert.equal(sourceFact.gradeCounts['F'], 0);
  assert.deepEqual(
    Object.keys(sourceFact.gradeCounts).sort(),
    ['A', 'B', 'C', 'D', 'E', 'F'],
    'every frozen grade key is present, zeros included',
  );
});

test('evidence quality omits classes with zero records and totals zero for an empty ledger', () => {
  const posture = composeDecisionRoomEvidenceQuality([
    evidenceRecord({ class: 'attribution', quality: 'D' }),
  ]);
  assert.deepEqual(
    posture.byClass.map((entry) => entry.class),
    ['attribution'],
    'only the occupied class appears',
  );
  const empty = composeDecisionRoomEvidenceQuality([]);
  assert.deepEqual(empty.byClass, []);
  assert.equal(empty.totalRecords, 0);
});

test('evidence quality composition is PURE — identical inputs, identical outputs, inputs untouched', () => {
  const records = deepFreeze([
    evidenceRecord({ class: 'source_fact', quality: 'A' }),
    evidenceRecord({ class: 'prediction', quality: 'F' }),
  ]);
  const first = composeDecisionRoomEvidenceQuality(records);
  const second = composeDecisionRoomEvidenceQuality(records);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// RECOMMENDATIONS — applicable learnings + declared experiment decisions ONLY
// ---------------------------------------------------------------------------

test('recommendations present exactly the ACTIVE learnings and the concluded experiments with a declared decision', () => {
  const learnings = [
    learningRecord({ status: 'active' }),
    learningRecord({ status: 'contradicted', learningId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    learningRecord({ status: 'superseded', supersededBy: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    learningRecord({ status: 'retired', learningId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
  ];
  const experiments = [
    experimentRecord({
      status: 'concluded',
      resultState: 'causal_supported',
      resultingDecision: 'Roll out the 5-touch sequence to all new clients.',
    }),
    experimentRecord({
      status: 'concluded',
      resultState: 'inconclusive',
      resultingDecision: null,
      experimentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }),
    experimentRecord({
      status: 'running',
      resultState: 'undecided',
      resultingDecision: null,
      experimentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    }),
  ];
  const recommendations = deriveDecisionRoomRecommendations({ learnings, experiments });
  assert.equal(
    recommendations.basis,
    'applicable_learnings_and_declared_experiment_decisions',
  );
  assert.deepEqual(
    recommendations.items.map((item) => item.kind),
    ['applicable_learning', 'experiment_decision'],
    'only the applicable learning + the decided experiment appear',
  );
  const [learning, decision] = recommendations.items;
  assert.equal(learning!.kind, 'applicable_learning');
  assert.equal(learning!.learningId, learnings[0]!.learningId);
  assert.equal(learning!.confidence, 0.82);
  assert.deepEqual(learning!.applicability, { channel: 'email', cohort: 'new_accounts' });
  assert.equal(decision!.kind, 'experiment_decision');
  assert.equal(decision!.resultingDecision, 'Roll out the 5-touch sequence to all new clients.');
  assert.equal(decision!.resultState, 'causal_supported');
});

test('recommendations never invent lift: an attribution conclusion rides with its declared design and analysis method verbatim', () => {
  const experiments = [
    experimentRecord({
      status: 'concluded',
      resultState: 'attribution',
      resultingDecision: 'Credit 60% of the lift to paid search under the declared attribution model.',
      designType: 'observational',
    }),
  ];
  const { items } = deriveDecisionRoomRecommendations({ learnings: [], experiments });
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.kind, 'experiment_decision');
  assert.equal(item.resultState, 'attribution', 'the attribution result state rides verbatim');
  assert.equal(item.designType, 'observational', 'the declared design type rides verbatim');
  assert.equal(item.analysisMethod, 'Two-proportion z-test on account-level activation.');
  assert.equal(item.analysisMethodVersion, 'v2');
  // No lift field exists anywhere in the recommendation vocabulary.
  assert.ok(!('lift' in item));
  assert.ok(!('causalLift' in item));
  assert.ok(!('incrementalEffect' in item));
});

test('recommendation derivation is PURE — frozen inputs compose without mutation', () => {
  const learnings = deepFreeze([learningRecord({ status: 'active' })]);
  const experiments = deepFreeze([
    experimentRecord({
      status: 'concluded',
      resultState: 'observation',
      resultingDecision: 'Keep the current sequence.',
    }),
  ]);
  const first = deriveDecisionRoomRecommendations({ learnings, experiments });
  const second = deriveDecisionRoomRecommendations({ learnings, experiments });
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// APPROVALS — the pending states durable state already exposes
// ---------------------------------------------------------------------------

test('approvals surface non-terminal undecided experiments and blocked/paused workflow instances only', () => {
  const experiments = [
    experimentRecord({ status: 'draft', resultState: 'undecided', resultingDecision: null }),
    experimentRecord({
      status: 'ready',
      resultState: 'undecided',
      resultingDecision: null,
      experimentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
    experimentRecord({
      status: 'analyzing',
      resultState: 'undecided',
      resultingDecision: null,
      experimentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
    experimentRecord({
      status: 'concluded',
      resultState: 'causal_supported',
      resultingDecision: 'Ship it.',
      experimentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    }),
    experimentRecord({
      status: 'stopped',
      resultState: 'undecided',
      resultingDecision: null,
      experimentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }),
    experimentRecord({
      status: 'invalidated',
      resultState: 'undecided',
      resultingDecision: null,
      experimentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    }),
  ];
  const instances = [
    instanceRecord(WORKSPACE, 'blocked', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
    instanceRecord(WORKSPACE, 'paused', 'abababab-abab-4aba-8aba-abababababab'),
    instanceRecord(WORKSPACE, 'running', 'cdcdcdcd-cdcd-4cdc-8cdcd-cdcdcdcdcdcd'.slice(0, 36)),
    instanceRecord(WORKSPACE, 'succeeded', 'efefefef-efef-4efe-8efe-efefefefefef'),
    instanceRecord(WORKSPACE, 'draft', '12121212-1212-4121-8121-121212121212'),
  ];
  const approvals = deriveDecisionRoomApprovals({ experiments, instances });
  const summary = approvals.items.map((item) =>
    item.kind === 'experiment_awaiting_decision'
      ? { kind: item.kind, state: item.status }
      : { kind: item.kind, state: item.instanceStatus },
  );
  assert.deepEqual(summary, [
    { kind: 'experiment_awaiting_decision', state: 'draft' },
    { kind: 'experiment_awaiting_decision', state: 'ready' },
    { kind: 'experiment_awaiting_decision', state: 'analyzing' },
    { kind: 'workflow_instance_awaiting_continuation', state: 'blocked' },
    { kind: 'workflow_instance_awaiting_continuation', state: 'paused' },
  ]);
  const decisionTarget = approvals.items.find(
    (item) => item.kind === 'experiment_awaiting_decision',
  );
  assert.ok(decisionTarget !== undefined);
  assert.ok('decisionTarget' in decisionTarget);
  assert.ok('hypothesis' in decisionTarget);
  const blockedInstance = approvals.items.find(
    (item) => item.kind === 'workflow_instance_awaiting_continuation',
  );
  assert.ok(blockedInstance !== undefined);
  assert.ok('workflowId' in blockedInstance);
  assert.ok('updatedAt' in blockedInstance);
});

test('the approvals derivation is PURE — frozen inputs compose without mutation', () => {
  const experiments = deepFreeze([
    experimentRecord({ status: 'running', resultState: 'undecided', resultingDecision: null }),
  ]);
  const instances = deepFreeze([
    instanceRecord(WORKSPACE, 'blocked', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
  ]);
  const first = deriveDecisionRoomApprovals({ experiments, instances });
  const second = deriveDecisionRoomApprovals({ experiments, instances });
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// WHAT HAPPENED / WHY / EXPERIMENTS — the authoritative rows, presented
// ---------------------------------------------------------------------------

test('what-happened presents goal and workflow recaps with full-key status tallies', () => {
  const goals = [
    goalRecord({ status: 'active' }),
    goalRecord({ status: 'achieved', goalId: '99999999-9999-4999-8999-999999999999' }),
  ];
  const workflowId = '88888888-8888-4888-8888-888888888888';
  const instances = [
    instanceRecord(workflowId, 'running', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    instanceRecord(workflowId, 'blocked', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    instanceRecord(workflowId, 'succeeded', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ];
  const whatHappened = composeDecisionRoomWhatHappened({
    goals,
    workflows: [{ workflow: workflowRecord(workflowId), instances }],
  });
  assert.equal(whatHappened.goals.length, 2);
  assert.equal(whatHappened.goals[0]!.objective, 'Increase new-account activation to 40%.');
  assert.equal(whatHappened.goals[0]!.successCriteria[0]!.metric, 'activation_rate');
  assert.deepEqual(whatHappened.goalStatusCounts, {
    draft: 0,
    active: 1,
    achieved: 1,
    abandoned: 0,
  });
  assert.equal(whatHappened.workflows.length, 1);
  assert.equal(whatHappened.workflows[0]!.name, 'Onboarding Sequence');
  assert.equal(whatHappened.workflows[0]!.instanceCounts['running'], 1);
  assert.equal(whatHappened.workflows[0]!.instanceCounts['blocked'], 1);
  assert.equal(whatHappened.workflows[0]!.instances.length, 3);
  assert.equal(whatHappened.instanceStatusCounts['succeeded'], 1);
  assert.equal(whatHappened.instanceStatusCounts['draft'], 0, 'zero statuses stay present');
  assert.deepEqual(Object.keys(whatHappened.instanceStatusCounts).sort(), [
    'blocked',
    'cancelled',
    'draft',
    'failed',
    'paused',
    'ready',
    'running',
    'succeeded',
  ]);
});

test('why presents every learning with its DERIVED state and supersession pointer', () => {
  const learnings = [
    learningRecord({ status: 'active' }),
    learningRecord({
      status: 'superseded',
      supersededBy: '66666666-6666-4666-8666-666666666666',
      learningId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }),
  ];
  const why = composeDecisionRoomWhy(learnings);
  assert.equal(why.learnings.length, 2);
  assert.equal(why.learnings[0]!.status, 'active');
  assert.equal(why.learnings[0]!.supersededBy, null);
  assert.equal(why.learnings[1]!.status, 'superseded');
  assert.equal(why.learnings[1]!.supersededBy, '66666666-6666-4666-8666-666666666666');
  assert.deepEqual(why.learningStatusCounts, {
    active: 1,
    superseded: 1,
    contradicted: 0,
    retired: 0,
  });
});

test('experiments recap surfaces the declared design, analysis method and RESULTING DECISION verbatim', () => {
  const experiments = [
    experimentRecord({
      status: 'concluded',
      resultState: 'causal_not_supported',
      resultingDecision: 'Keep the 3-touch sequence; revisit with a larger sample.',
    }),
  ];
  const view = composeDecisionRoomExperiments(experiments);
  const recap = view.experiments[0]!;
  assert.equal(recap.hypothesis, experiments[0]!.hypothesis);
  assert.equal(recap.decisionTarget, experiments[0]!.decisionTarget);
  assert.equal(recap.designType, 'randomized');
  assert.equal(recap.analysisMethod, experiments[0]!.analysisMethod);
  assert.equal(recap.analysisMethodVersion, 'v2');
  assert.equal(recap.primaryMetricName, 'activation_rate');
  assert.equal(recap.resultState, 'causal_not_supported');
  assert.equal(
    recap.resultingDecision,
    'Keep the 3-touch sequence; revisit with a larger sample.',
    'the decision is SURFACED from the /experiments contract, never re-derived',
  );
  assert.equal(recap.concludedAt, '2026-03-01T12:00:00.000Z');
  assert.deepEqual(view.experimentStatusCounts, {
    draft: 0,
    ready: 0,
    running: 0,
    analyzing: 0,
    concluded: 1,
    stopped: 0,
    invalidated: 0,
  });
});

// ---------------------------------------------------------------------------
// Tallies — every frozen key present, zeros included
// ---------------------------------------------------------------------------

test('every tally includes every frozen status key with zeros included', () => {
  assert.deepEqual(tallyGoalStatuses([]), { draft: 0, active: 0, achieved: 0, abandoned: 0 });
  assert.deepEqual(Object.keys(tallyInstanceStatuses([])).sort(), [
    'blocked',
    'cancelled',
    'draft',
    'failed',
    'paused',
    'ready',
    'running',
    'succeeded',
  ]);
  assert.deepEqual(tallyLearningStatuses([]), {
    active: 0,
    superseded: 0,
    contradicted: 0,
    retired: 0,
  });
  assert.deepEqual(Object.keys(tallyExperimentStatuses([])).sort(), [
    'analyzing',
    'concluded',
    'draft',
    'invalidated',
    'ready',
    'running',
    'stopped',
  ]);
  assert.deepEqual(tallyGoalStatuses([goalRecord({ status: 'draft' })]), {
    draft: 1,
    active: 0,
    achieved: 0,
    abandoned: 0,
  });
});
