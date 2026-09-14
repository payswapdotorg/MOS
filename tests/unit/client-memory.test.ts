/**
 * MKT-044 unit tests — the PURE /client-memory projections (Client
 * Operating Memory). All derivation functions are pure over plain record
 * snapshots: the same inputs + the same projection version always derive
 * the same memory items (the pinning proof).
 *
 * Covers (spec/architecture-v1.5.md §6; the cm-proj-v1 vocabulary):
 *   - the frozen projection vocabulary (version, record kinds, authority
 *     map, selection rules — pinned verbatim);
 *   - the per-kind item builders (canonical citations, verbatim statuses,
 *     authority timestamps, composed-kind links);
 *   - the frozen selection rules (supersession-aware evidence, own
 *     playbooks only, observed outcomes on accepted decisions);
 *   - the deterministic ordering and the summary bound;
 *   - the workspace covering rule + the kind slice;
 *   - the projection disclosure composition.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientRecord } from '../../src/modules/clients/public.ts';
import type { WorkspaceRecord } from '../../src/modules/workspaces/public.ts';
import type { GoalRecord } from '../../src/modules/goals/public.ts';
import type {
  PlaybookRecord,
  PlaybookVersionRecord,
} from '../../src/modules/playbooks/public.ts';
import type { DeploymentRecord } from '../../src/modules/deployments/public.ts';
import type { EvidenceRecord } from '../../src/modules/evidence/public.ts';
import type { ExperimentRecord } from '../../src/modules/experiments/public.ts';
import type { DecisionRecord } from '../../src/modules/decisions/public.ts';
import type { LearningRecord } from '../../src/modules/learnings/public.ts';
import {
  CLIENT_MEMORY_PROJECTION_VERSION,
  CLIENT_MEMORY_RECORD_KINDS,
  CLIENT_MEMORY_SELECTION_RULES,
  CLIENT_MEMORY_SOURCE_AUTHORITIES,
  type ClientMemoryAuthoritySnapshot,
  clientMemoryKindIndexOf,
  clientMemorySummaryOf,
  composeClientMemoryView,
  composeKindMemorySlice,
  composeProjectionDisclosure,
  composeWorkspaceMemoryView,
  coversWorkspace,
  deploymentMemoryItem,
  decisionMemoryItem,
  deriveClientMemoryItems,
  evidenceMemoryItem,
  experimentMemoryItem,
  goalMemoryItem,
  learningMemoryItem,
  orderMemoryItems,
  outcomeMemoryItem,
  playbookMemoryItem,
  playbookVersionMemoryItem,
} from '../../src/modules/client-memory/public.ts';

// ---------------------------------------------------------------------------
// Fixtures (plain record snapshots — the exact canonical shapes)
// ---------------------------------------------------------------------------

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_1 = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_2 = '44444444-4444-4444-8444-444444444444';

function clientFixture(): ClientRecord {
  return {
    clientId: CLIENT,
    agencyId: AGENCY,
    name: 'Memory Client',
    slug: 'memory-client',
    status: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function workspaceFixture(workspaceId: string, name: string): WorkspaceRecord {
  return {
    workspaceId,
    clientId: CLIENT,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    status: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function goalFixture(
  goalId: string,
  objective: string,
  workspaceId: string | null,
  status: GoalRecord['status'],
  createdAt: string,
): GoalRecord {
  return {
    goalId,
    clientId: CLIENT,
    workspaceId,
    objective,
    successCriteria: [
      { metric: 'revenue', comparator: '>=', targetValue: 5000, unit: 'USD', description: null },
    ],
    metrics: [{ name: 'revenue', unit: 'USD', description: null }],
    constraints: [{ kind: 'risk', description: 'Fatigue above 4 touches.' }],
    timeHorizon: { startsOn: '2026-04-01', endsOn: '2026-06-30' },
    status,
    createdBy: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function playbookFixture(
  playbookId: string,
  clientId: string | null,
  goalId: string | null,
  name: string,
): PlaybookRecord {
  return {
    playbookId,
    agencyId: AGENCY,
    clientId,
    goalId,
    name,
    description: 'The fixture playbook.',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  };
}

function playbookVersionFixture(
  versionId: string,
  playbookId: string,
  versionNumber: number,
  status: PlaybookVersionRecord['status'],
): PlaybookVersionRecord {
  return {
    versionId,
    playbookId,
    versionNumber,
    status,
    strategy: { summary: 'v1 strategy', templates: [{ name: 'SEO', description: null }] },
    deploymentMetadata: {
      requiredDomainPacks: [],
      requiredCapabilities: [],
      runtimeRequirements: { runtimeClass: 'pooled-worker' },
      triggers: [{ kind: 'manual', config: null }],
    },
    createdBy: null,
    version: 1,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  };
}

function deploymentFixture(
  deploymentId: string,
  workspaceId: string,
  playbookVersionId: string,
  status: DeploymentRecord['status'],
  createdAt: string,
): DeploymentRecord {
  return {
    deploymentId,
    agencyId: AGENCY,
    clientId: CLIENT,
    workspaceId,
    playbookVersionId,
    workflowDefinitionIds: [],
    requiredDomainPacks: [],
    requiredCapabilities: [],
    policyReferenceId: null,
    runtimeRequirements: { runtimeClass: 'pooled-worker' },
    triggerConfig: [{ kind: 'manual', config: null }],
    status,
    createdBy: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function evidenceFixture(
  evidenceId: string,
  workspaceId: string | null,
  supersededBy: string | null,
  supersedes: string | null,
  recordedAt: string,
): EvidenceRecord {
  return {
    evidenceId,
    clientId: CLIENT,
    workspaceId,
    class: 'observation',
    source: { system: 'meta-ads', ref: `report/${evidenceId}` },
    observedAt: '2026-09-15T10:30:00.000Z',
    content: { metric: 'revenue', value: 5000 },
    contentRef: null,
    quality: 'B',
    confidence: null,
    supersedes,
    supersededBy,
    provenance: {
      actor: 'user:owner',
      recordedVia: 'api',
      correlationId: 'corr-2',
      causationId: null,
      recordedAt,
    },
  };
}

function experimentFixture(
  experimentId: string,
  workspaceId: string | null,
  status: ExperimentRecord['status'],
  recordedAt: string,
): ExperimentRecord {
  return {
    experimentId,
    clientId: CLIENT,
    workspaceId,
    hypothesis: 'Shorter subject lines lift open rate.',
    decisionTarget: 'Choose the Q3 newsletter format.',
    populationUnit: 'newsletter recipient',
    treatment: 'short-subject',
    comparison: 'status-quo',
    assignmentMethod: 'random',
    designType: 'randomized',
    primaryMetric: { name: 'open_rate', dimensions: {} },
    guardrails: [],
    analysisMethod: 'difference-in-means',
    analysisMethodVersion: null,
    expectedDirection: 'increase',
    startCriteria: null,
    stopCriteria: '14 days or 2000 recipients.',
    minimumEvidenceRequirement: 'B — strong quasi-experimental at minimum',
    uncertaintyRepresentation: 'interval',
    status,
    resultState: 'undecided',
    resultingDecision: null,
    concludedAt: null,
    provenance: {
      actor: 'user:owner',
      recordedVia: 'api',
      correlationId: 'corr-3',
      causationId: null,
      recordedAt,
    },
  };
}

function decisionFixture(input: {
  readonly decisionId: string;
  readonly workspaceId: string | null;
  readonly disposition: DecisionRecord['disposition'];
  readonly objective: string;
  readonly evidenceRefs?: readonly string[];
  readonly experimentRef?: string | null;
  readonly predecessorDecisionId?: string | null;
  readonly successorDecisionId?: string | null;
  readonly observedOutcome?: {
    readonly summary: string;
    readonly asExpected: boolean | null;
    readonly notes: string | null;
  } | null;
  readonly deploymentRef?: string | null;
  readonly learningRef?: string | null;
  readonly outcomeAt?: string | null;
  readonly recordedAt?: string;
}): DecisionRecord {
  return {
    decisionId: input.decisionId,
    clientId: CLIENT,
    workspaceId: input.workspaceId,
    agencyId: AGENCY,
    objective: input.objective,
    context: null,
    hypothesisSummary: 'The hypothesis informing the decision.',
    experimentRef: input.experimentRef ?? null,
    evidenceRefs: input.evidenceRefs ?? [],
    expectedImpact: {
      summary: 'Lift open rate by 2 points.',
      direction: 'increase',
      magnitude: '+2pt',
    },
    uncertainty: null,
    expectedCost: 'USD 1200',
    alternatives: ['keep the status quo'],
    predecessorDecisionId: input.predecessorDecisionId ?? null,
    proposer: { actor: 'user:owner', role: 'agency_owner' },
    disposition: input.disposition,
    successorDecisionId: input.successorDecisionId ?? null,
    dispositionAt: '2026-01-10T00:00:00.000Z',
    observedOutcome: input.observedOutcome ?? null,
    executionRef: null,
    deploymentRef: input.deploymentRef ?? null,
    learningRef: input.learningRef ?? null,
    outcomeAt: input.outcomeAt ?? null,
    idempotencyKey: `idem-${input.decisionId}`,
    createFingerprint: `fp-${input.decisionId}`,
    provenance: {
      actor: 'user:owner',
      recordedVia: 'api',
      correlationId: 'corr-4',
      causationId: null,
      recordedAt: input.recordedAt ?? '2026-01-09T00:00:00.000Z',
    },
  };
}

function learningFixture(
  learningId: string,
  workspaceId: string | null,
  statement: string,
  status: LearningRecord['status'],
  evidenceRefs: readonly string[],
  experimentRefs: readonly string[],
  recordedAt: string,
): LearningRecord {
  return {
    learningId,
    clientId: CLIENT,
    workspaceId,
    statement,
    applicability: { channel: 'email' },
    evidenceRefs,
    experimentRefs,
    confidence: 0.7,
    status,
    supersededBy: null,
    provenance: {
      actor: 'user:owner',
      recordedVia: 'api',
      correlationId: 'corr-5',
      causationId: null,
      recordedAt,
    },
  };
}

/** The full snapshot fixture: every kind populated deterministically. */
function fullSnapshot(): ClientMemoryAuthoritySnapshot {
  return {
    agencyId: AGENCY,
    clientId: CLIENT,
    client: clientFixture(),
    workspaces: [workspaceFixture(WORKSPACE_1, 'Workspace One'), workspaceFixture(WORKSPACE_2, 'Workspace Two')],
    goals: [
      goalFixture('goal-1', 'Grow recurring revenue.', WORKSPACE_1, 'active', '2026-01-04T00:00:00.000Z'),
      goalFixture('goal-2', 'Activate the second workspace.', null, 'achieved', '2026-01-05T00:00:00.000Z'),
    ],
    playbookEntries: [
      {
        playbook: playbookFixture('pb-own', CLIENT, 'goal-1', 'Client Own Playbook'),
        versions: [
          playbookVersionFixture('pbv-1', 'pb-own', 1, 'published'),
          playbookVersionFixture('pbv-2', 'pb-own', 2, 'draft'),
        ],
      },
      {
        // The AGENCY-scoped reusable playbook — excluded by the frozen
        // selection rule (disclosed, never silently dropped).
        playbook: playbookFixture('pb-agency', null, null, 'Agency Reusable IP'),
        versions: [playbookVersionFixture('pbv-agency-1', 'pb-agency', 1, 'published')],
      },
    ],
    deployments: [
      deploymentFixture('dep-1', WORKSPACE_1, 'pbv-1', 'active', '2026-01-06T00:00:00.000Z'),
      deploymentFixture('dep-2', WORKSPACE_2, 'pbv-1', 'paused', '2026-01-07T00:00:00.000Z'),
    ],
    evidence: [
      evidenceFixture('ev-1', WORKSPACE_1, 'ev-2', null, '2026-01-08T00:00:00.000Z'),
      // The CURRENT row of the supersession chain.
      evidenceFixture('ev-2', WORKSPACE_1, null, 'ev-1', '2026-01-09T00:00:00.000Z'),
      // A client-wide current row.
      evidenceFixture('ev-3', null, null, null, '2026-01-10T00:00:00.000Z'),
    ],
    experiments: [
      experimentFixture('exp-1', WORKSPACE_1, 'running', '2026-01-11T00:00:00.000Z'),
    ],
    decisions: [
      // An ACCEPTED decision WITH the observed outcome + refs.
      decisionFixture({
        decisionId: 'dec-1',
        workspaceId: WORKSPACE_1,
        disposition: 'accepted',
        objective: 'Adopt the short-subject newsletter format.',
        evidenceRefs: ['ev-3'],
        experimentRef: 'exp-1',
        observedOutcome: { summary: 'Open rate lifted 2.4 points.', asExpected: true, notes: null },
        deploymentRef: 'dep-1',
        learningRef: 'learn-1',
        outcomeAt: '2026-01-13T00:00:00.000Z',
        recordedAt: '2026-01-12T00:00:00.000Z',
      }),
      // A REJECTED decision with no outcome.
      decisionFixture({
        decisionId: 'dec-2',
        workspaceId: null,
        disposition: 'rejected',
        objective: 'Spin up a paid podcast channel.',
        predecessorDecisionId: 'dec-1',
        recordedAt: '2026-01-14T00:00:00.000Z',
      }),
    ],
    learnings: [
      learningFixture('learn-1', null, 'Short subjects lift opens.', 'active', ['ev-3'], ['exp-1'], '2026-01-15T00:00:00.000Z'),
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. The frozen projection vocabulary (pinned verbatim)
// ---------------------------------------------------------------------------

test('the projection vocabulary is frozen and exported (version, kinds, authority map, selection rules)', () => {
  assert.equal(CLIENT_MEMORY_PROJECTION_VERSION, 'cm-proj-v1');
  assert.deepEqual(CLIENT_MEMORY_RECORD_KINDS, [
    'client', 'goal', 'playbook', 'playbook-version', 'deployment',
    'evidence', 'experiment', 'outcome', 'decision', 'learning',
  ]);
  // The authority map — the policy-visible data lineage.
  assert.equal(CLIENT_MEMORY_SOURCE_AUTHORITIES['client'], '/clients');
  assert.equal(CLIENT_MEMORY_SOURCE_AUTHORITIES['goal'], '/goals');
  assert.equal(CLIENT_MEMORY_SOURCE_AUTHORITIES['playbook'], '/playbooks');
  assert.equal(CLIENT_MEMORY_SOURCE_AUTHORITIES['playbook-version'], '/playbooks');
  assert.equal(CLIENT_MEMORY_SOURCE_AUTHORITIES['deployment'], '/deployments');
  assert.equal(CLIENT_MEMORY_SOURCE_AUTHORITIES['evidence'], '/evidence');
  assert.equal(CLIENT_MEMORY_SOURCE_AUTHORITIES['experiment'], '/experiments');
  assert.ok(CLIENT_MEMORY_SOURCE_AUTHORITIES['outcome'].startsWith('/decisions'));
  assert.equal(CLIENT_MEMORY_SOURCE_AUTHORITIES['decision'], '/decisions');
  assert.equal(CLIENT_MEMORY_SOURCE_AUTHORITIES['learning'], '/learnings');
  // The frozen selection rules — pinned verbatim (any change is a
  // projection-version bump).
  assert.deepEqual(CLIENT_MEMORY_SELECTION_RULES, {
    clientProfile: 'live-canonical-ownership-resolution-tombstones-never-resolve',
    goals: 'all-lifecycle-states-retained',
    playbooks: 'client-scoped-own-playbooks-only-agency-reusable-ip-excluded',
    playbookVersions: 'every-immutable-version-of-the-own-playbooks',
    deployments: 'every-deployment-across-live-workspaces-all-states',
    evidence: 'current-rows-only-superseded-predecessors-counted-never-presented',
    experiments: 'all-records-any-lifecycle-or-result-state',
    outcomes: 'observed-outcomes-on-accepted-decisions-recorded-exactly-once',
    decisions: 'all-records-any-disposition-corrections-are-new-records',
    learnings: 'all-records-derived-states-history-retained',
    ordering: 'kind-vocabulary-order-then-recordedAt-desc-then-id-asc',
    summaryBound: 280,
    freshness: 'live-derivation-next-read',
    workspaceSliceCovering: 'client-wide-plus-own-workspace',
    linkCitations: 'composed-kinds-only',
  });
});

// ---------------------------------------------------------------------------
// 2. The per-kind item builders (canonical citations, verbatim statuses)
// ---------------------------------------------------------------------------

test('goal items cite the goal, surface the lifecycle status verbatim and carry no record links', () => {
  const goal = goalFixture('goal-1', 'Grow recurring revenue.', WORKSPACE_1, 'active', '2026-01-04T00:00:00.000Z');
  const item = goalMemoryItem(goal);
  assert.equal(item.kind, 'goal');
  assert.equal(item.id, 'goal-1');
  assert.equal(item.summary, 'Grow recurring revenue.');
  assert.equal(item.status, 'active');
  assert.equal(item.workspaceId, WORKSPACE_1);
  assert.equal(item.recordedAt, '2026-01-04T00:00:00.000Z');
  assert.deepEqual(item.links, []);
});

test('playbook items are client-level, link their optional goal and carry no lifecycle status', () => {
  const own = playbookMemoryItem(playbookFixture('pb-own', CLIENT, 'goal-1', 'Client Own Playbook'));
  assert.equal(own.kind, 'playbook');
  assert.equal(own.id, 'pb-own');
  assert.equal(own.summary, 'Client Own Playbook');
  assert.equal(own.status, null);
  assert.equal(own.workspaceId, null);
  assert.deepEqual(own.links, [{ kind: 'goal', id: 'goal-1' }]);
  // A playbook without a goal link cites none.
  const unlinked = playbookMemoryItem(playbookFixture('pb-x', CLIENT, null, 'Unlinked'));
  assert.deepEqual(unlinked.links, []);
});

test('playbook-version items cite the owning playbook and surface the version status', () => {
  const version = playbookVersionFixture('pbv-1', 'pb-own', 2, 'published');
  const item = playbookVersionMemoryItem(version);
  assert.equal(item.kind, 'playbook-version');
  assert.equal(item.id, 'pbv-1');
  assert.equal(item.summary, 'v2');
  assert.equal(item.status, 'published');
  assert.equal(item.workspaceId, null);
  assert.deepEqual(item.links, [{ kind: 'playbook', id: 'pb-own' }]);
});

test('deployment items carry the workspace scope, the lifecycle status and the pinned playbook-version link', () => {
  const deployment = deploymentFixture('dep-1', WORKSPACE_1, 'pbv-1', 'active', '2026-01-06T00:00:00.000Z');
  const item = deploymentMemoryItem(deployment);
  assert.equal(item.kind, 'deployment');
  assert.equal(item.id, 'dep-1');
  assert.equal(item.status, 'active');
  assert.equal(item.workspaceId, WORKSPACE_1);
  assert.deepEqual(item.links, [{ kind: 'playbook-version', id: 'pbv-1' }]);
});

test('evidence items surface the quality grade as the status, the provenance timestamp and the supersession link', () => {
  const current = evidenceFixture('ev-2', WORKSPACE_1, null, 'ev-1', '2026-01-09T00:00:00.000Z');
  const item = evidenceMemoryItem(current);
  assert.equal(item.kind, 'evidence');
  assert.equal(item.id, 'ev-2');
  assert.equal(item.status, 'B');
  assert.equal(item.workspaceId, WORKSPACE_1);
  assert.equal(item.recordedAt, '2026-01-09T00:00:00.000Z');
  assert.deepEqual(item.links, [{ kind: 'evidence', id: 'ev-1' }]);
  assert.ok(item.summary.includes('meta-ads'));
  assert.ok(item.summary.includes('report/ev-2'));
});

test('experiment items surface the hypothesis excerpt and the lifecycle status', () => {
  const experiment = experimentFixture('exp-1', WORKSPACE_1, 'running', '2026-01-11T00:00:00.000Z');
  const item = experimentMemoryItem(experiment);
  assert.equal(item.kind, 'experiment');
  assert.equal(item.id, 'exp-1');
  assert.equal(item.summary, 'Shorter subject lines lift open rate.');
  assert.equal(item.status, 'running');
  assert.equal(item.workspaceId, WORKSPACE_1);
  assert.deepEqual(item.links, []);
});

test('decision items cite the ledger references of the composed kinds only', () => {
  const decision = decisionFixture({
    decisionId: 'dec-1',
    workspaceId: WORKSPACE_1,
    disposition: 'accepted',
    objective: 'Adopt the short-subject newsletter format.',
    evidenceRefs: ['ev-3'],
    experimentRef: 'exp-1',
    predecessorDecisionId: 'dec-0',
    successorDecisionId: 'dec-9',
    deploymentRef: 'dep-1',
    learningRef: 'learn-1',
  });
  const item = decisionMemoryItem(decision);
  assert.equal(item.kind, 'decision');
  assert.equal(item.id, 'dec-1');
  assert.equal(item.summary, 'Adopt the short-subject newsletter format.');
  assert.equal(item.status, 'accepted');
  assert.equal(item.workspaceId, WORKSPACE_1);
  assert.deepEqual(item.links, [
    { kind: 'evidence', id: 'ev-3' },
    { kind: 'experiment', id: 'exp-1' },
    { kind: 'decision', id: 'dec-0' },
    { kind: 'decision', id: 'dec-9' },
    { kind: 'deployment', id: 'dep-1' },
    { kind: 'learning', id: 'learn-1' },
  ]);
});

test('outcome items cite the decision, map the as-expected flag and link the outcome refs (composed kinds only)', () => {
  const accepted = decisionFixture({
    decisionId: 'dec-1',
    workspaceId: WORKSPACE_1,
    disposition: 'accepted',
    objective: 'Adopt the short-subject newsletter format.',
    observedOutcome: { summary: 'Open rate lifted 2.4 points.', asExpected: true, notes: null },
    deploymentRef: 'dep-1',
    learningRef: 'learn-1',
    outcomeAt: '2026-01-13T00:00:00.000Z',
  });
  const item = outcomeMemoryItem(accepted);
  assert.equal(item.kind, 'outcome');
  // The outcome is cited BY the decision id — the canonical record.
  assert.equal(item.id, 'dec-1');
  assert.equal(item.summary, 'Open rate lifted 2.4 points.');
  assert.equal(item.status, 'as-expected');
  assert.equal(item.workspaceId, WORKSPACE_1);
  assert.equal(item.recordedAt, '2026-01-13T00:00.00.000Z'.replace('2026-01-13T00:00.00.000Z', '2026-01-13T00:00:00.000Z'));
  assert.deepEqual(item.links, [
    { kind: 'deployment', id: 'dep-1' },
    { kind: 'learning', id: 'learn-1' },
  ]);
  // The not-assessed posture is null; not-as-expected maps honestly.
  const unassessed = outcomeMemoryItem(
    decisionFixture({
      decisionId: 'dec-2',
      workspaceId: null,
      disposition: 'accepted',
      objective: 'x',
      observedOutcome: { summary: 'y', asExpected: null, notes: null },
    }),
  );
  assert.equal(unassessed.status, null);
  const missed = outcomeMemoryItem(
    decisionFixture({
      decisionId: 'dec-3',
      workspaceId: null,
      disposition: 'accepted',
      objective: 'x',
      observedOutcome: { summary: 'y', asExpected: false, notes: null },
    }),
  );
  assert.equal(missed.status, 'not-as-expected');
  // A decision with NO observed outcome is a contract violation of the
  // builder's precondition (the selection rule feeds only outcome
  // carriers).
  assert.throws(() =>
    outcomeMemoryItem(
      decisionFixture({ decisionId: 'dec-4', workspaceId: null, disposition: 'rejected', objective: 'x' }),
    ),
  );
});

test('learning items cite the supporting evidence and experiment references', () => {
  const learning = learningFixture('learn-1', null, 'Short subjects lift opens.', 'active', ['ev-3'], ['exp-1'], '2026-01-15T00:00:00.000Z');
  const item = learningMemoryItem(learning);
  assert.equal(item.kind, 'learning');
  assert.equal(item.id, 'learn-1');
  assert.equal(item.summary, 'Short subjects lift opens.');
  assert.equal(item.status, 'active');
  assert.equal(item.workspaceId, null);
  assert.deepEqual(item.links, [
    { kind: 'evidence', id: 'ev-3' },
    { kind: 'experiment', id: 'exp-1' },
  ]);
});

// ---------------------------------------------------------------------------
// 3. The frozen selection rules over the full snapshot
// ---------------------------------------------------------------------------

test('the full projection applies every selection rule: superseded evidence counted, own playbooks only, outcomes on accepted decisions', () => {
  const snapshot = fullSnapshot();
  const projection = deriveClientMemoryItems(snapshot);

  // Goals: BOTH lifecycle states retained (active + achieved).
  assert.equal(projection.perKind['goal'], 2);
  // Own playbooks only: pb-own (+ its 2 versions); the agency-scoped
  // pb-agency is the DISCLOSED exclusion (never silently dropped).
  assert.equal(projection.perKind['playbook'], 1);
  assert.equal(projection.perKind['playbook-version'], 2);
  assert.ok(!projection.items.some((item) => item.id === 'pb-agency'));
  assert.ok(!projection.items.some((item) => item.id === 'pbv-agency-1'));
  // Deployments: both workspaces, any status.
  assert.equal(projection.perKind['deployment'], 2);
  // Evidence: current rows only — ev-2 (the chain winner) + ev-3; the
  // superseded ev-1 is counted, never presented.
  assert.equal(projection.perKind['evidence'], 2);
  assert.equal(projection.supersededEvidenceCount, 1);
  assert.ok(!projection.items.some((item) => item.id === 'ev-1'));
  // Experiments: every record.
  assert.equal(projection.perKind['experiment'], 1);
  // Outcomes: exactly the accepted decision with the observed outcome.
  assert.equal(projection.perKind['outcome'], 1);
  assert.equal(projection.items.find((item) => item.kind === 'outcome')!.id, 'dec-1');
  // Decisions: every record, any disposition.
  assert.equal(projection.perKind['decision'], 2);
  // Learnings: every derived state.
  assert.equal(projection.perKind['learning'], 1);
  // The client kind contributes the profile (not an item) — zero items.
  assert.equal(projection.perKind['client'], 0);
});

// ---------------------------------------------------------------------------
// 4. Ordering + the summary bound + pinning
// ---------------------------------------------------------------------------

test('ordering is deterministic: kind vocabulary order, then recordedAt DESC, then id ASC', () => {
  const snapshot = fullSnapshot();
  const { items } = deriveClientMemoryItems(snapshot);
  // Kind vocabulary blocks appear in order.
  const kindBlocks = items.map((item) => item.kind);
  const expectedBlocks = [
    ...Array(2).fill('goal'),
    ...Array(1).fill('playbook'),
    ...Array(2).fill('playbook-version'),
    ...Array(2).fill('deployment'),
    ...Array(2).fill('evidence'),
    ...Array(1).fill('experiment'),
    ...Array(1).fill('outcome'),
    ...Array(2).fill('decision'),
    ...Array(1).fill('learning'),
  ];
  assert.deepEqual(kindBlocks, expectedBlocks);
  // Within the decision block: dec-2 (2026-01-14) before dec-1 (2026-01-12).
  const decisionIds = items.filter((item) => item.kind === 'decision').map((item) => item.id);
  assert.deepEqual(decisionIds, ['dec-2', 'dec-1']);
  // Within the evidence block: ev-3 (2026-01-10) before ev-2 (2026-01-09).
  const evidenceIds = items.filter((item) => item.kind === 'evidence').map((item) => item.id);
  assert.deepEqual(evidenceIds, ['ev-3', 'ev-2']);
  // The tiebreak: same recordedAt ⇒ id ASC.
  const tied = [
    goalMemoryItem(goalFixture('goal-b', 'B', null, 'draft', '2026-01-01T00:00:00.000Z')),
    goalMemoryItem(goalFixture('goal-a', 'A', null, 'draft', '2026-01-01T00:00:00.000Z')),
  ];
  assert.deepEqual(orderMemoryItems(tied).map((item) => item.id), ['goal-a', 'goal-b']);
});

test('the summary bound truncates excerpts at the frozen bound (never the full authoritative payload)', () => {
  assert.equal(CLIENT_MEMORY_SELECTION_RULES.summaryBound, 280);
  const short = 'a short objective';
  assert.equal(clientMemorySummaryOf(short), short);
  const long = 'x'.repeat(400);
  const truncated = clientMemorySummaryOf(long);
  assert.equal(truncated.length, 281);
  assert.equal(truncated, `x'.repeat(280)…`.replace(`x'.repeat(280)…`, `${'x'.repeat(280)}…`));
  // The builder applies the bound.
  const item = goalMemoryItem(goalFixture('g', long, null, 'draft', '2026-01-01T00:00:00.000Z'));
  assert.equal(item.summary.length, 281);
});

test('pinning: the same snapshot derives byte-identical items and views (generatedAt excluded)', () => {
  const snapshot = fullSnapshot();
  const first = deriveClientMemoryItems(snapshot);
  const second = deriveClientMemoryItems(snapshot);
  assert.equal(JSON.stringify(second.items), JSON.stringify(first.items));
  assert.deepEqual(second.perKind, first.perKind);
  const viewA = JSON.stringify({ ...composeClientMemoryView(snapshot, 'T1'), generatedAt: undefined });
  const viewB = JSON.stringify({ ...composeClientMemoryView(snapshot, 'T2'), generatedAt: undefined });
  assert.equal(viewB, viewA);
});

// ---------------------------------------------------------------------------
// 5. The workspace covering rule + the kind slice
// ---------------------------------------------------------------------------

test('coversWorkspace: client-wide items cover every workspace; scoped items cover exactly their own', () => {
  const clientWide = { workspaceId: null } as { workspaceId: string | null };
  const scoped = { workspaceId: WORKSPACE_1 } as { workspaceId: string | null };
  assert.equal(coversWorkspace(clientWide as never, WORKSPACE_1), true);
  assert.equal(coversWorkspace(clientWide as never, WORKSPACE_2), true);
  assert.equal(coversWorkspace(scoped as never, WORKSPACE_1), true);
  assert.equal(coversWorkspace(scoped as never, WORKSPACE_2), false);
});

test('the workspace slice carries the covering-rule projection (client-wide + own items only)', () => {
  const snapshot = fullSnapshot();
  const view = composeWorkspaceMemoryView(snapshot, WORKSPACE_1, '2026-02-01T00:00:00.000Z');
  assert.equal(view.scope.kind, 'workspace-memory');
  assert.equal(view.scope.workspaceId, WORKSPACE_1);
  assert.equal(view.workspace.name, 'Workspace One');
  // goal-1 (workspace 1) + goal-2 (client-wide) cover workspace 1.
  assert.equal(view.perKind['goal'], 2);
  // dep-1 (workspace 1) only — dep-2 is workspace 2's.
  assert.equal(view.perKind['deployment'], 1);
  assert.ok(view.items.some((item) => item.id === 'dep-1'));
  assert.ok(!view.items.some((item) => item.id === 'dep-2'));
  // ev-2 (workspace 1 current) + ev-3 (client-wide); the superseded
  // ev-1 is never presented, still counted.
  assert.equal(view.perKind['evidence'], 2);
  assert.equal(view.supersededEvidenceCount, 1);
  // The client-level playbooks cover every workspace slice.
  assert.equal(view.perKind['playbook'], 1);
  // dec-2 (client-wide) + dec-1 (workspace 1) + the outcome on dec-1.
  assert.equal(view.perKind['decision'], 2);
  assert.equal(view.perKind['outcome'], 1);
  // Workspace 2's slice: goal-2 only (client-wide), dep-2, no dec-1.
  const view2 = composeWorkspaceMemoryView(snapshot, WORKSPACE_2, '2026-02-01T00:00:00.000Z');
  assert.equal(view2.perKind['goal'], 1);
  assert.equal(view2.perKind['deployment'], 1);
  assert.equal(view2.perKind['decision'], 1);
  assert.equal(view2.perKind['outcome'], 0);
  // A workspace outside the LIVE enumeration is a contract violation.
  assert.throws(() => composeWorkspaceMemoryView(snapshot, 'not-a-live-workspace', 'T'));
});

test('the kind slice is a pure filter over the DERIVED items with the unfiltered denominator', () => {
  const snapshot = fullSnapshot();
  const slice = composeKindMemorySlice(snapshot, 'decision', '2026-02-01T00:00:00.000Z');
  assert.equal(slice.scope.kind, 'client-memory-kind-slice');
  assert.equal(slice.scope.recordKind, 'decision');
  assert.equal(slice.items.length, 2);
  assert.equal(slice.perKindTotal, 2);
  assert.ok(slice.items.every((item) => item.kind === 'decision'));
  // An empty kind (client contributes the profile, not items).
  const clientSlice = composeKindMemorySlice(snapshot, 'client', '2026-02-01T00:00:00.000Z');
  assert.equal(clientSlice.items.length, 0);
  assert.equal(clientSlice.perKindTotal, 0);
});

// ---------------------------------------------------------------------------
// 6. The projection disclosure + the view composition
// ---------------------------------------------------------------------------

test('the projection disclosure ships the full frozen vocabulary on every view', () => {
  const disclosure = composeProjectionDisclosure();
  assert.equal(disclosure.projectionVersion, CLIENT_MEMORY_PROJECTION_VERSION);
  assert.deepEqual(disclosure.recordKinds, [...CLIENT_MEMORY_RECORD_KINDS]);
  assert.deepEqual(disclosure.selectionRules, CLIENT_MEMORY_SELECTION_RULES);
  assert.equal(disclosure.basis, 'live-derivation-over-canonical-authorities');
  assert.equal(disclosure.persistence, 'none-derived-read-model');
  assert.equal(disclosure.retrievalTechnology, 'none-live-composition-only');
});

test('the client view composes the profile, the workspace recaps, the items and the disclosure', () => {
  const snapshot = fullSnapshot();
  const view = composeClientMemoryView(snapshot, '2026-02-01T00:00:00.000Z');
  assert.equal(view.scope.kind, 'client-memory');
  assert.equal(view.scope.agencyId, AGENCY);
  assert.equal(view.scope.clientId, CLIENT);
  assert.equal(view.scope.workspaceCount, 2);
  assert.deepEqual(view.profile.sourceRef, { kind: 'client', id: CLIENT });
  assert.equal(view.profile.name, 'Memory Client');
  assert.equal(view.profile.status, 'active');
  assert.deepEqual(
    view.workspaces.map((workspace) => workspace.workspaceId),
    [WORKSPACE_1, WORKSPACE_2],
  );
  assert.equal(view.generatedAt, '2026-02-01T00:00:00.000Z');
  // perKind covers EVERY vocabulary kind with zeros included.
  for (const kind of CLIENT_MEMORY_RECORD_KINDS) {
    assert.ok(kind in view.perKind, `perKind carries the '${kind}' key`);
  }
});

test('kindIndexOf orders by the frozen vocabulary (unknown kinds sort last)', () => {
  const indexes = CLIENT_MEMORY_RECORD_KINDS.map((kind) => clientMemoryKindIndexOf(kind));
  assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  assert.equal(clientMemoryKindIndexOf('client'), 0);
  assert.ok(clientMemoryKindIndexOf('goal') < clientMemoryKindIndexOf('learning'));
});
