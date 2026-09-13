/**
 * MKT-029 unit tests — the Agency Command Center PURE read-model
 * composition (spec/work-items.md MKT-029; requirements UI-001 + UI-AC-01:
 * the command center displays authoritative backend state, derived — never
 * re-decided — from the composed authorities' records).
 *
 * Proofs:
 *   - composeCommandCenterPortfolioGoals presents every Goal of every
 *     client scope field for field with the owning-client attribution, and
 *     tallies agency-wide + per-client lifecycle counts with EVERY frozen
 *     status key present (zeros included — a stable response shape);
 *   - composeCommandCenterWorkflowState presents every Workflow container
 *     with its instances in every §5 state, client-attributed from the
 *     record's OWN server-derived clientId, with per-workflow, agency-wide
 *     and per-client tallies (a client with no workflows tallies zeros —
 *     it stays visible in the drill-down);
 *   - composeCommandCenterEvidenceQuality is the frozen grade-distribution
 *     tally at AGENCY scope: counts per (class, grade) combined across the
 *     portfolio, every grade key present (zeros included), zero-record
 *     classes omitted, per-client totals + LOW-GRADE (D/E/F) counts honest;
 *   - deriveCommandCenterRisks surfaces ONLY the risk-relevant signals
 *     durable state already exposes: goal constraints of kind 'risk'
 *     (resource/time/other constraints are NOT risk items), FAILED
 *     executions, and UNRESOLVED executions ('unknown'/'reconciling'); the
 *     summary tallies the blocked/paused instance counts and the low-grade
 *     evidence count — and the vocabulary carries NO score/severity/priority
 *     field anywhere (a tally of authoritative rows, never a risk engine);
 *   - deriveCommandCenterApprovals surfaces only the pending states
 *     durable state already exposes (the MKT-030 semantics,
 *     client-attributed): experiments in NON-TERMINAL lifecycle states with
 *     an UNDECIDED result (draft/ready/running/analyzing) and workflow
 *     instances BLOCKED or PAUSED — concluded/stopped/invalidated
 *     experiments and every other §5 instance state are excluded;
 *   - every composition is PURE — identical inputs compose identical
 *     outputs and deep-frozen inputs compose without mutation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeCommandCenterEvidenceQuality,
  composeCommandCenterPortfolioGoals,
  composeCommandCenterWorkflowState,
  deriveCommandCenterApprovals,
  deriveCommandCenterRisks,
} from '../../src/modules/reporting/public.ts';
import type {
  EvidenceRecord,
  EvidenceClass,
  EvidenceQualityGrade,
} from '../../src/modules/evidence/public.ts';
import type { ExperimentRecord } from '../../src/modules/experiments/public.ts';
import type { ExecutionRecord, ExecutionStatus } from '../../src/modules/executions/public.ts';
import type { GoalRecord } from '../../src/modules/goals/public.ts';
import type {
  WorkflowInstanceRecord,
  WorkflowRecord,
} from '../../src/modules/workflows/public.ts';

// ---------------------------------------------------------------------------
// Fixtures (minimal-but-complete authoritative records — a two-client
// agency portfolio + the shapes the derivations must exclude)
// ---------------------------------------------------------------------------

const AGENCY = '22222222-2222-4222-8222-222222222222';
const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '12121212-1212-4121-8121-121212121212';
const WORKSPACE_A = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_B = '34343434-3434-4343-8343-343434343434';

function evidenceRecord(
  clientId: string,
  overrides: {
    class: EvidenceClass;
    quality: EvidenceQualityGrade;
    evidenceId?: string;
  },
): EvidenceRecord {
  return {
    evidenceId: overrides.evidenceId ?? '44444444-4444-4444-8444-444444444444',
    clientId,
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

function experimentRecord(
  clientId: string,
  overrides: {
    status: ExperimentRecord['status'];
    resultState: ExperimentRecord['resultState'];
    experimentId?: string;
  },
): ExperimentRecord {
  return {
    experimentId: overrides.experimentId ?? '55555555-5555-4555-8555-555555555555',
    clientId,
    workspaceId: null,
    hypothesis: 'A 5-touch onboarding email sequence increases new-account activation.',
    decisionTarget: 'Whether to roll the 5-touch onboarding sequence out to all new clients.',
    populationUnit: 'New client accounts, account level.',
    treatment: '5-touch onboarding email sequence.',
    comparison: 'Current 3-touch onboarding sequence.',
    assignmentMethod: 'Simple random assignment, 50/50.',
    designType: 'randomized',
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
    resultingDecision: null,
    concludedAt: null,
    provenance: {
      actor: 'user:99999999-9999-4999-8999-999999999999',
      recordedVia: 'api',
      correlationId: 'correlation-2',
      causationId: null,
      recordedAt: '2026-02-20T09:00:00.000Z',
    },
  };
}

function executionRecord(
  clientId: string,
  workspaceId: string,
  status: ExecutionStatus,
  executionId: string,
): ExecutionRecord {
  return {
    executionId,
    taskLink: { kind: 'external-request', externalRequestRef: 'provider-call-1' },
    retryOfExecutionId: null,
    attemptNumber: 1,
    executionKind: 'deterministic',
    runtimeClass: 'pooled-worker',
    idempotencyKey: `exec-key-${executionId}`,
    createFingerprint: 'fingerprint-1',
    workspaceId,
    clientId,
    agencyId: AGENCY,
    status,
    retryClassification: status === 'failed' ? 'safe' : null,
    createdBy: null,
    version: 1,
    createdAt: '2026-01-14T09:00:00.000Z',
    updatedAt: '2026-01-14T09:05:00.000Z',
  };
}

function goalRecord(
  clientId: string,
  overrides: {
    status: GoalRecord['status'];
    goalId?: string;
    constraints?: GoalRecord['constraints'];
  },
): GoalRecord {
  return {
    goalId: overrides.goalId ?? '77777777-7777-4777-8777-777777777777',
    clientId,
    workspaceId: WORKSPACE_A,
    objective: 'Increase new-account activation to 40%.',
    successCriteria: [
      { metric: 'activation_rate', comparator: '>=', targetValue: 0.4, unit: '%', description: null },
    ],
    metrics: [{ name: 'activation_rate', unit: '%', description: null }],
    constraints: overrides.constraints ?? [{ kind: 'time', description: 'Within Q2 2026.' }],
    timeHorizon: { startsOn: '2026-04-01', endsOn: '2026-06-30' },
    status: overrides.status,
    createdBy: null,
    version: 1,
    createdAt: '2026-01-10T09:00:00.000Z',
    updatedAt: '2026-01-10T09:00:00.000Z',
  };
}

function workflowRecord(
  clientId: string,
  workspaceId: string,
  workflowId: string,
): WorkflowRecord {
  return {
    workflowId,
    workspaceId,
    clientId,
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
  clientId: string,
  workspaceId: string,
  status: WorkflowInstanceRecord['status'],
  instanceId: string,
): WorkflowInstanceRecord {
  return {
    workflowInstanceId: instanceId,
    workflowId,
    workflowDefinitionId: '88888888-8888-4888-8888-888888888888',
    workspaceId,
    clientId,
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
// PORTFOLIO GOALS — every Goal of the agency's clients, client-attributed
// ---------------------------------------------------------------------------

test('portfolio goals present every goal client-attributed with agency-wide and per-client full-key tallies', () => {
  const view = composeCommandCenterPortfolioGoals({
    clients: [
      {
        clientId: CLIENT_A,
        goals: [
          goalRecord(CLIENT_A, {
            status: 'active',
            goalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            constraints: [
              { kind: 'risk', description: 'Email fatigue above 4 touches per fortnight.' },
              { kind: 'resource', description: 'One lifecycle designer.' },
            ],
          }),
          goalRecord(CLIENT_A, {
            status: 'achieved',
            goalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          }),
        ],
      },
      {
        clientId: CLIENT_B,
        goals: [
          goalRecord(CLIENT_B, {
            status: 'draft',
            goalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          }),
        ],
      },
    ],
  });

  assert.equal(view.goals.length, 3);
  assert.deepEqual(
    view.goals.map((goal) => goal.goalId).sort(),
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'].sort(),
  );
  // Every recap carries the OWNING client attribution.
  for (const goal of view.goals) {
    assert.equal(goal.clientId, goal.goalId.startsWith('cccccccc') ? CLIENT_B : CLIENT_A);
  }
  // The risk + resource constraints ride verbatim (the risks derivation
  // consumes them; the recap never filters them).
  const first = view.goals.find(
    (goal) => goal.goalId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  )!;
  assert.deepEqual(first.constraints, [
    { kind: 'risk', description: 'Email fatigue above 4 touches per fortnight.' },
    { kind: 'resource', description: 'One lifecycle designer.' },
  ]);

  assert.deepEqual(view.goalStatusCounts, { draft: 1, active: 1, achieved: 1, abandoned: 0 });
  assert.equal(view.perClient.length, 2);
  const tallyA = view.perClient.find((tally) => tally.clientId === CLIENT_A)!;
  assert.equal(tallyA.total, 2);
  assert.deepEqual(tallyA.goalStatusCounts, { draft: 0, active: 1, achieved: 1, abandoned: 0 });
  const tallyB = view.perClient.find((tally) => tally.clientId === CLIENT_B)!;
  assert.equal(tallyB.total, 1);
  assert.deepEqual(tallyB.goalStatusCounts, { draft: 1, active: 0, achieved: 0, abandoned: 0 });
});

test('an empty portfolio tallies zeros with every frozen status key present (stable shape)', () => {
  const view = composeCommandCenterPortfolioGoals({ clients: [] });
  assert.deepEqual(view.goals, []);
  assert.deepEqual(view.goalStatusCounts, { draft: 0, active: 0, achieved: 0, abandoned: 0 });
  assert.deepEqual(view.perClient, []);
  // A client with NO goals stays visible in the drill-down with zeros.
  const withEmptyClient = composeCommandCenterPortfolioGoals({
    clients: [{ clientId: CLIENT_A, goals: [] }],
  });
  assert.deepEqual(withEmptyClient.perClient, [
    { clientId: CLIENT_A, total: 0, goalStatusCounts: { draft: 0, active: 0, achieved: 0, abandoned: 0 } },
  ]);
});

// ---------------------------------------------------------------------------
// WORKFLOW STATE — every Workflow container, client-attributed
// ---------------------------------------------------------------------------

test('workflow state presents every container client-attributed with per-workflow, agency-wide and per-client tallies', () => {
  const workflowA = workflowRecord(CLIENT_A, WORKSPACE_A, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  const workflowB = workflowRecord(CLIENT_B, WORKSPACE_B, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  const view = composeCommandCenterWorkflowState({
    clients: [
      { clientId: CLIENT_A, workspaceIds: [WORKSPACE_A] },
      { clientId: CLIENT_B, workspaceIds: [WORKSPACE_B] },
    ],
    workflows: [
      {
        workflow: workflowA,
        instances: [
          instanceRecord(workflowA.workflowId, CLIENT_A, WORKSPACE_A, 'running', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
          instanceRecord(workflowA.workflowId, CLIENT_A, WORKSPACE_A, 'blocked', '90909090-9090-4090-8090-909090909090'),
          instanceRecord(workflowA.workflowId, CLIENT_A, WORKSPACE_A, 'succeeded', '91919191-9191-4191-8191-919191919191'),
        ],
      },
      {
        workflow: workflowB,
        instances: [
          instanceRecord(workflowB.workflowId, CLIENT_B, WORKSPACE_B, 'paused', '92929292-9292-4292-8292-929292929292'),
        ],
      },
    ],
  });

  assert.equal(view.workflows.length, 2);
  const recapA = view.workflows.find(
    (workflow) => workflow.workflowId === workflowA.workflowId,
  )!;
  assert.equal(recapA.clientId, CLIENT_A);
  assert.equal(recapA.workspaceId, WORKSPACE_A);
  assert.equal(recapA.name, 'Onboarding Sequence');
  assert.equal((recapA.instances as readonly unknown[]).length, 3);
  assert.equal(recapA.instanceCounts['running'], 1);
  assert.equal(recapA.instanceCounts['blocked'], 1);
  assert.equal(recapA.instanceCounts['succeeded'], 1);
  assert.equal(recapA.instanceCounts['draft'], 0);

  assert.deepEqual(view.instanceStatusCounts, {
    draft: 0,
    ready: 0,
    running: 1,
    paused: 1,
    blocked: 1,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
  });

  const tallyA = view.perClient.find((tally) => tally.clientId === CLIENT_A)!;
  assert.equal(tallyA.total, 3);
  assert.equal(tallyA.instanceStatusCounts['blocked'], 1);
  assert.equal(tallyA.instanceStatusCounts['paused'], 0);
  const tallyB = view.perClient.find((tally) => tally.clientId === CLIENT_B)!;
  assert.equal(tallyB.total, 1);
  assert.equal(tallyB.instanceStatusCounts['paused'], 1);
});

test('duplicate workflow listings across workspaces converge (dedup by workflow id) and empty clients tally zeros', () => {
  const workflow = workflowRecord(CLIENT_A, WORKSPACE_A, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  const view = composeCommandCenterWorkflowState({
    clients: [
      { clientId: CLIENT_A, workspaceIds: [WORKSPACE_A] },
      { clientId: CLIENT_B, workspaceIds: [WORKSPACE_B] },
    ],
    // The same workflow container listed twice (the module guards this
    // itself; the derivation stays correct regardless).
    workflows: [
      { workflow, instances: [instanceRecord(workflow.workflowId, CLIENT_A, WORKSPACE_A, 'running', '93939393-9393-4393-8393-939393939393')] },
      { workflow, instances: [instanceRecord(workflow.workflowId, CLIENT_A, WORKSPACE_A, 'running', '93939393-9393-4393-8393-939393939393')] },
    ],
  });
  assert.equal(view.workflows.length, 1);
  assert.equal(view.instanceStatusCounts['running'], 1, 'the duplicate listing never double-counts');
  // A client with no workflow containers stays in the drill-down.
  const tallyB = view.perClient.find((tally) => tally.clientId === CLIENT_B)!;
  assert.equal(tallyB.total, 0);
  assert.equal(tallyB.instanceStatusCounts['running'], 0);
});

// ---------------------------------------------------------------------------
// EVIDENCE QUALITY — the agency posture (grade distribution + low-grade signal)
// ---------------------------------------------------------------------------

test('evidence quality tallies the agency-wide grade distribution by class across clients with the low-grade signal', () => {
  const view = composeCommandCenterEvidenceQuality({
    clients: [
      {
        clientId: CLIENT_A,
        records: [
          evidenceRecord(CLIENT_A, { class: 'source_fact', quality: 'A' }),
          evidenceRecord(CLIENT_A, { class: 'source_fact', quality: 'C' }),
          evidenceRecord(CLIENT_A, { class: 'inference', quality: 'E' }),
        ],
      },
      {
        clientId: CLIENT_B,
        records: [
          evidenceRecord(CLIENT_B, { class: 'source_fact', quality: 'D' }),
          evidenceRecord(CLIENT_B, { class: 'observation', quality: 'B' }),
        ],
      },
    ],
  });

  assert.equal(view.totalRecords, 5);
  assert.equal(view.lowGradeRecords, 2, 'D + E are the low-grade records');
  assert.deepEqual(
    view.byClass.map((entry) => entry.class),
    ['source_fact', 'observation', 'inference'],
    'classes appear in the frozen EVIDENCE_CLASSES order',
  );
  const sourceFact = view.byClass[0]!;
  assert.equal(sourceFact.total, 3);
  assert.deepEqual(
    sourceFact.gradeCounts,
    { A: 1, B: 0, C: 1, D: 1, E: 0, F: 0 },
    'the distribution COMBINES both clients (every grade key present)',
  );

  const postureA = view.perClient.find((posture) => posture.clientId === CLIENT_A)!;
  assert.equal(postureA.totalRecords, 3);
  assert.equal(postureA.lowGradeRecords, 1);
  const postureB = view.perClient.find((posture) => posture.clientId === CLIENT_B)!;
  assert.equal(postureB.totalRecords, 2);
  assert.equal(postureB.lowGradeRecords, 1);
});

test('evidence quality omits zero-record classes, tallies zero for an empty portfolio, and never invents grades', () => {
  const view = composeCommandCenterEvidenceQuality({
    clients: [
      { clientId: CLIENT_A, records: [evidenceRecord(CLIENT_A, { class: 'attribution', quality: 'F' })] },
      { clientId: CLIENT_B, records: [] },
    ],
  });
  assert.deepEqual(
    view.byClass.map((entry) => entry.class),
    ['attribution'],
    'only the occupied class appears (an empty class carries no posture)',
  );
  assert.equal(view.lowGradeRecords, 1);
  const emptyClient = view.perClient.find((posture) => posture.clientId === CLIENT_B)!;
  assert.equal(emptyClient.totalRecords, 0);
  assert.equal(emptyClient.lowGradeRecords, 0);

  const empty = composeCommandCenterEvidenceQuality({ clients: [] });
  assert.deepEqual(empty.byClass, []);
  assert.equal(empty.totalRecords, 0);
  assert.equal(empty.lowGradeRecords, 0);
});

// ---------------------------------------------------------------------------
// RISKS — the risk-relevant signals durable state already exposes
// ---------------------------------------------------------------------------

test('risks present ONLY declared goal risk constraints + failed + unresolved executions (never a score)', () => {
  const goalWithRisks = goalRecord(CLIENT_A, {
    status: 'active',
    goalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    constraints: [
      { kind: 'risk', description: 'Email fatigue above 4 touches per fortnight.' },
      { kind: 'risk', description: 'Provider deliverability degradation mid-quarter.' },
      { kind: 'resource', description: 'One lifecycle designer.' },
      { kind: 'time', description: 'Within Q2 2026.' },
    ],
  });
  const risks = deriveCommandCenterRisks({
    goals: [{ clientId: CLIENT_A, goal: goalWithRisks }],
    instances: [
      instanceRecord('dddddddd-dddd-4ddd-8ddd-dddddddddddd', CLIENT_A, WORKSPACE_A, 'blocked', '90909090-9090-4090-8090-909090909090'),
      instanceRecord('dddddddd-dddd-4ddd-8ddd-dddddddddddd', CLIENT_A, WORKSPACE_A, 'paused', '92929292-9292-4292-8292-929292929292'),
      instanceRecord('dddddddd-dddd-4ddd-8ddd-dddddddddddd', CLIENT_A, WORKSPACE_A, 'running', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
    ],
    executions: [
      executionRecord(CLIENT_A, WORKSPACE_A, 'failed', 'a1a1a1a1-a1a1-4a11-8a11-a1a1a1a1a1a1'),
      executionRecord(CLIENT_A, WORKSPACE_A, 'unknown', 'a2a2a2a2-a2a2-4a22-8a22-a2a2a2a2a2a2'),
      executionRecord(CLIENT_B, WORKSPACE_B, 'reconciling', 'a3a3a3a3-a3a3-4a33-8a33-a3a3a3a3a3a3'),
      executionRecord(CLIENT_B, WORKSPACE_B, 'succeeded', 'a4a4a4a4-a4a4-4a44-8a44-a4a4a4a4a4a4'),
      executionRecord(CLIENT_B, WORKSPACE_B, 'running', 'a5a5a5a5-a5a5-4a55-8a55-a5a5a5a5a5a5'),
    ],
    lowGradeEvidenceRecords: 2,
  });

  assert.equal(
    risks.basis,
    'declared_goal_risk_constraints_and_operational_and_evidence_quality_signals',
  );

  const constraintItems = risks.items.filter((item) => item.kind === 'goal_risk_constraint');
  assert.equal(constraintItems.length, 2, 'ONLY the kind:risk constraints appear (resource/time excluded)');
  assert.deepEqual(
    constraintItems.map((item) => item.description),
    ['Email fatigue above 4 touches per fortnight.', 'Provider deliverability degradation mid-quarter.'],
    'the declared descriptions ride verbatim',
  );
  assert.ok(constraintItems.every((item) => item.clientId === CLIENT_A));

  const failed = risks.items.filter((item) => item.kind === 'execution_failed');
  assert.equal(failed.length, 1, 'exactly the FAILED execution');
  assert.equal(failed[0]!.executionId, 'a1a1a1a1-a1a1-4a11-8a11-a1a1a1a1a1a1');
  assert.equal(failed[0]!.clientId, CLIENT_A);

  const unresolved = risks.items.filter((item) => item.kind === 'execution_unresolved');
  assert.equal(unresolved.length, 2, 'the unknown + reconciling executions (never succeeded/running)');
  const unknown = unresolved.find(
    (item) => item.executionId === 'a2a2a2a2-a2a2-4a22-8a22-a2a2a2a2a2a2',
  )!;
  assert.equal(unknown.status, 'unknown');
  const reconciling = unresolved.find(
    (item) => item.executionId === 'a3a3a3a3-a3a3-4a33-8a33-a3a3a3a3a3a3',
  )!;
  assert.equal(reconciling.status, 'reconciling');
  assert.equal(reconciling.clientId, CLIENT_B);

  assert.deepEqual(risks.summary, {
    goalRiskConstraintCount: 2,
    blockedInstanceCount: 1,
    pausedInstanceCount: 1,
    failedExecutionCount: 1,
    unknownExecutionCount: 1,
    reconcilingExecutionCount: 1,
    lowGradeEvidenceRecords: 2,
  });

  // The frozen vocabulary: a tally of authoritative rows — NO score,
  // severity or priority field exists anywhere (never a risk engine).
  const serialized = JSON.stringify(risks);
  for (const forbidden of ['"score"', '"severity"', '"priority"', '"riskLevel"']) {
    assert.ok(!serialized.includes(forbidden), `the risk vocabulary has no ${forbidden} field`);
  }
});

test('risks with no signals tallies zero everywhere and the vocabulary stays stable', () => {
  const risks = deriveCommandCenterRisks({
    goals: [{ clientId: CLIENT_A, goal: goalRecord(CLIENT_A, { status: 'active' }) }],
    instances: [],
    executions: [],
    lowGradeEvidenceRecords: 0,
  });
  assert.deepEqual(risks.items, []);
  assert.deepEqual(risks.summary, {
    goalRiskConstraintCount: 0,
    blockedInstanceCount: 0,
    pausedInstanceCount: 0,
    failedExecutionCount: 0,
    unknownExecutionCount: 0,
    reconcilingExecutionCount: 0,
    lowGradeEvidenceRecords: 0,
  });
});

// ---------------------------------------------------------------------------
// PENDING APPROVALS — the MKT-030 semantics at agency scope
// ---------------------------------------------------------------------------

test('approvals surface the undecided non-terminal experiments + blocked/paused instances, client-attributed', () => {
  const approvals = deriveCommandCenterApprovals({
    experiments: [
      { clientId: CLIENT_A, experiment: experimentRecord(CLIENT_A, { status: 'running', resultState: 'undecided', experimentId: 'b1b1b1b1-b1b1-4b11-8b11-b1b1b1b1b1b1' }) },
      { clientId: CLIENT_A, experiment: experimentRecord(CLIENT_A, { status: 'concluded', resultState: 'causal_supported', experimentId: 'b2b2b2b2-b2b2-4b22-8b22-b2b2b2b2b2b2' }) },
      { clientId: CLIENT_B, experiment: experimentRecord(CLIENT_B, { status: 'draft', resultState: 'undecided', experimentId: 'b3b3b3b3-b3b3-4b33-8b33-b3b3b3b3b3b3' }) },
      { clientId: CLIENT_B, experiment: experimentRecord(CLIENT_B, { status: 'stopped', resultState: 'undecided', experimentId: 'b4b4b4b4-b4b4-4b44-8b44-b4b4b4b4b4b4' }) },
    ],
    instances: [
      {
        clientId: CLIENT_A,
        instance: instanceRecord('dddddddd-dddd-4ddd-8ddd-dddddddddddd', CLIENT_A, WORKSPACE_A, 'blocked', '90909090-9090-4090-8090-909090909090'),
      },
      {
        clientId: CLIENT_B,
        instance: instanceRecord('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', CLIENT_B, WORKSPACE_B, 'paused', '92929292-9292-4292-8292-929292929292'),
      },
      {
        clientId: CLIENT_B,
        instance: instanceRecord('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', CLIENT_B, WORKSPACE_B, 'ready', '93939393-9393-4393-8393-939393939393'),
      },
    ],
  });

  assert.equal(approvals.items.length, 4);
  const experimentApprovals = approvals.items.filter(
    (item) => item.kind === 'experiment_awaiting_decision',
  );
  assert.equal(experimentApprovals.length, 2, 'running-undecided + draft-undecided (concluded/stopped excluded)');
  const runningExperiment = experimentApprovals.find(
    (item) => item.experimentId === 'b1b1b1b1-b1b1-4b11-8b11-b1b1b1b1b1b1',
  )!;
  assert.equal(runningExperiment.clientId, CLIENT_A);
  assert.equal(runningExperiment.status, 'running');
  assert.equal(runningExperiment.decisionTarget, 'Whether to roll the 5-touch onboarding sequence out to all new clients.');
  const draftExperiment = experimentApprovals.find(
    (item) => item.experimentId === 'b3b3b3b3-b3b3-4b33-8b33-b3b3b3b3b3b3',
  )!;
  assert.equal(draftExperiment.clientId, CLIENT_B);
  assert.equal(draftExperiment.status, 'draft');

  const instanceApprovals = approvals.items.filter(
    (item) => item.kind === 'workflow_instance_awaiting_continuation',
  );
  assert.equal(instanceApprovals.length, 2, 'blocked + paused instances (ready excluded)');
  const blocked = instanceApprovals.find(
    (item) => item.workflowInstanceId === '90909090-9090-4090-8090-909090909090',
  )!;
  assert.equal(blocked.clientId, CLIENT_A);
  assert.equal(blocked.instanceStatus, 'blocked');
  const paused = instanceApprovals.find(
    (item) => item.workflowInstanceId === '92929292-9292-4292-8292-929292929292',
  )!;
  assert.equal(paused.clientId, CLIENT_B);
  assert.equal(paused.instanceStatus, 'paused');
});

// ---------------------------------------------------------------------------
// PURITY — identical inputs, identical outputs, inputs untouched
// ---------------------------------------------------------------------------

test('every command-center composition is PURE — deep-frozen inputs compose identically twice', () => {
  const clients = deepFreeze([
    { clientId: CLIENT_A, workspaceIds: [WORKSPACE_A] },
    { clientId: CLIENT_B, workspaceIds: [] },
  ]);
  const goals = deepFreeze([
    {
      clientId: CLIENT_A,
      goal: goalRecord(CLIENT_A, {
        status: 'active',
        constraints: [{ kind: 'risk', description: 'Email fatigue above 4 touches per fortnight.' }],
      }),
    },
  ]);
  const workflow = workflowRecord(CLIENT_A, WORKSPACE_A, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  const instances = deepFreeze([
    instanceRecord(workflow.workflowId, CLIENT_A, WORKSPACE_A, 'blocked', '90909090-9090-4090-8090-909090909090'),
  ]);
  const records = deepFreeze([
    evidenceRecord(CLIENT_A, { class: 'source_fact', quality: 'D' }),
  ]);
  const experiments = deepFreeze([
    { clientId: CLIENT_A, experiment: experimentRecord(CLIENT_A, { status: 'running', resultState: 'undecided' }) },
  ]);
  const executions = deepFreeze([
    executionRecord(CLIENT_A, WORKSPACE_A, 'unknown', 'a2a2a2a2-a2a2-4a22-8a22-a2a2a2a2a2a2'),
  ]);

  const portfolioFirst = composeCommandCenterPortfolioGoals({
    clients: goals.map(({ clientId, goal }) => ({ clientId, goals: [goal] })),
  });
  const portfolioSecond = composeCommandCenterPortfolioGoals({
    clients: goals.map(({ clientId, goal }) => ({ clientId, goals: [goal] })),
  });
  assert.deepEqual(portfolioFirst, portfolioSecond);

  const workflowFirst = composeCommandCenterWorkflowState({
    clients,
    workflows: [{ workflow, instances }],
  });
  const workflowSecond = composeCommandCenterWorkflowState({
    clients,
    workflows: [{ workflow, instances }],
  });
  assert.deepEqual(workflowFirst, workflowSecond);

  const evidenceFirst = composeCommandCenterEvidenceQuality({
    clients: [{ clientId: CLIENT_A, records }],
  });
  const evidenceSecond = composeCommandCenterEvidenceQuality({
    clients: [{ clientId: CLIENT_A, records }],
  });
  assert.deepEqual(evidenceFirst, evidenceSecond);

  const risksFirst = deriveCommandCenterRisks({
    goals,
    instances,
    executions,
    lowGradeEvidenceRecords: 1,
  });
  const risksSecond = deriveCommandCenterRisks({
    goals,
    instances,
    executions,
    lowGradeEvidenceRecords: 1,
  });
  assert.deepEqual(risksFirst, risksSecond);

  const approvalsFirst = deriveCommandCenterApprovals({
    experiments,
    instances: [{ clientId: CLIENT_A, instance: instances[0]! }],
  });
  const approvalsSecond = deriveCommandCenterApprovals({
    experiments,
    instances: [{ clientId: CLIENT_A, instance: instances[0]! }],
  });
  assert.deepEqual(approvalsFirst, approvalsSecond);
});
