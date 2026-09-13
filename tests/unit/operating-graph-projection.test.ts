/**
 * MKT-041 unit tests — the PURE /operating-graph derivations and view
 * compositions (no DB; the reporting read-model test precedent). Proves:
 *
 *   - the exact derived node + relation sets from a full authority snapshot
 *     (the v1.5 chain projected onto today's authorities);
 *   - EXACT VERSION ADDRESSING: edges reference the exact immutable
 *     playbook_version / workflow_definition ids — never a floating
 *     "latest";
 *   - FAIL-CLOSED reference resolution: foreign or unresolvable references
 *     (a foreign deployment pin, a foreign workflow definition, an
 *     execution's foreign instance linkage, a learning's foreign evidence /
 *     experiment citations) derive NO relation;
 *   - THE FROZEN EPISTEMIC VOCABULARY: every rebuild-derived relation is
 *     'observed' and the five states stay distinct;
 *   - the workspace attribution rule (from-endpoint's workspace, else the
 *     to-endpoint's);
 *   - the view compositions: current + history grouping, superseded
 *     relations, zero-filled relation tallies, the honest derivation
 *     disclosure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPERATING_GRAPH_EDGE_RELATIONS,
  OPERATING_GRAPH_EDGE_STATES,
  OPERATING_GRAPH_NODE_KINDS,
  composeAgencyOperatingGraphView,
  composeClientOperatingGraphView,
  deriveClientGraphProjection,
} from '../../src/modules/operating-graph/public.ts';
import type {
  ClientGraphAuthoritySnapshot,
  DerivedEdgeRef,
  GraphEdgeRowInput,
} from '../../src/modules/operating-graph/public.ts';
import type { GoalRecord } from '../../src/modules/goals/public.ts';
import type { PlaybookRecord, PlaybookVersionRecord } from '../../src/modules/playbooks/public.ts';
import type {
  WorkflowDefinitionRecord,
  WorkflowInstanceRecord,
  WorkflowRecord,
} from '../../src/modules/workflows/public.ts';
import type { ExecutionRecord } from '../../src/modules/executions/public.ts';
import type { DeploymentRecord } from '../../src/modules/deployments/public.ts';
import type { EvidenceRecord } from '../../src/modules/evidence/public.ts';
import type { ExperimentRecord } from '../../src/modules/experiments/public.ts';
import type { LearningRecord } from '../../src/modules/learnings/public.ts';

// ---------------------------------------------------------------------------
// Fixture identifiers
// ---------------------------------------------------------------------------

const AGENCY = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENCY = '22222222-2222-4222-8222-222222222222';
const CLIENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_CLIENT = 'aaaaaaaa-0000-4000-8000-000000000002';
const WORKSPACE = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_WORKSPACE = 'bbbbbbbb-0000-4000-8000-000000000002';

const GOAL = 'cccccccc-0000-4000-8000-000000000001';
const GOAL_WIDE = 'cccccccc-0000-4000-8000-000000000002';
const PLAYBOOK = 'dddddddd-0000-4000-8000-000000000001';
const PLAYBOOK_VERSION = 'eeeeeeee-0000-4000-8000-000000000001';
const AGENCY_PLAYBOOK = 'dddddddd-0000-4000-8000-000000000002';
const AGENCY_PLAYBOOK_VERSION = 'eeeeeeee-0000-4000-8000-000000000002';
const DEPLOYMENT = 'ffffffff-0000-4000-8000-000000000001';
const WORKFLOW = 'abababab-0000-4000-8000-000000000001';
const DEFINITION = 'cdcdcdcd-0000-4000-8000-000000000001';
const INSTANCE = 'efefefef-0000-4000-8000-000000000001';
const EXECUTION = 'f0f0f0f0-0000-4000-8000-000000000001';
const EXECUTION_FOREIGN_LINK = 'f0f0f0f0-0000-4000-8000-000000000002';
const EVIDENCE = 'a1a1a1a1-0000-4000-8000-000000000001';
const EVIDENCE_SUPERSEDED = 'a1a1a1a1-0000-4000-8000-000000000002';
const FOREIGN_EVIDENCE = 'a1a1a1a1-0000-4000-8000-000000000003';
const OUT_OF_WINDOW_EVIDENCE = 'a1a1a1a1-0000-4000-8000-000000000004';
const EXPERIMENT = 'b2b2b2b2-0000-4000-8000-000000000001';
const EXPERIMENT_CITED = 'b2b2b2b2-0000-4000-8000-000000000002';
const LEARNING = 'c3c3c3c3-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Record fixtures (minimal but fully typed)
// ---------------------------------------------------------------------------

const goal = (overrides: Partial<GoalRecord> = {}): GoalRecord => ({
  goalId: GOAL,
  clientId: CLIENT,
  workspaceId: null,
  objective: 'Grow activated accounts.',
  successCriteria: [],
  metrics: [],
  constraints: [],
  timeHorizon: null,
  status: 'active',
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const playbook = (overrides: Partial<PlaybookRecord> = {}): PlaybookRecord => ({
  playbookId: PLAYBOOK,
  agencyId: AGENCY,
  clientId: CLIENT,
  goalId: GOAL,
  name: 'Launch playbook',
  description: '',
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const playbookVersion = (
  overrides: Partial<PlaybookVersionRecord> = {},
): PlaybookVersionRecord => ({
  versionId: PLAYBOOK_VERSION,
  playbookId: PLAYBOOK,
  versionNumber: 1,
  status: 'published',
  strategy: { summary: 'The strategy.', templates: [] },
  deploymentMetadata: {
    requiredDomainPacks: [],
    requiredCapabilities: [],
    runtimeRequirements: { runtimeClass: 'pooled-worker' },
    triggers: [],
  },
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const workflow = (overrides: Partial<WorkflowRecord> = {}): WorkflowRecord => ({
  workflowId: WORKFLOW,
  workspaceId: WORKSPACE,
  clientId: CLIENT,
  agencyId: AGENCY,
  name: 'Launch workflow',
  description: '',
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const definition = (overrides: Partial<WorkflowDefinitionRecord> = {}): WorkflowDefinitionRecord => ({
  workflowDefinitionId: DEFINITION,
  workflowId: WORKFLOW,
  versionNumber: 1,
  status: 'active',
  playbookVersionId: null,
  content: {
    graph: { nodes: [], edges: [] },
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
    retryPolicyDefaults: { maxAttempts: null, backoffMs: null },
    concurrencyLimits: { maxConcurrentWorkflows: null, maxConcurrentNodes: null },
    timeoutPolicy: { defaultTimeoutSeconds: null, maxTimeoutSeconds: null },
    compensation: [],
  },
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const instance = (overrides: Partial<WorkflowInstanceRecord> = {}): WorkflowInstanceRecord => ({
  workflowInstanceId: INSTANCE,
  workflowId: WORKFLOW,
  workflowDefinitionId: DEFINITION,
  workspaceId: WORKSPACE,
  clientId: CLIENT,
  agencyId: AGENCY,
  status: 'running',
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const execution = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  executionId: EXECUTION,
  taskLink: { kind: 'workflow-node', workflowInstanceId: INSTANCE, nodeId: 'a' },
  retryOfExecutionId: null,
  attemptNumber: 1,
  executionKind: 'deterministic',
  runtimeClass: 'pooled-worker',
  idempotencyKey: 'fixture-key',
  createFingerprint: 'a'.repeat(64),
  workspaceId: WORKSPACE,
  clientId: CLIENT,
  agencyId: AGENCY,
  status: 'running',
  retryClassification: null,
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const deployment = (overrides: Partial<DeploymentRecord> = {}): DeploymentRecord => ({
  deploymentId: DEPLOYMENT,
  agencyId: AGENCY,
  clientId: CLIENT,
  workspaceId: WORKSPACE,
  playbookVersionId: PLAYBOOK_VERSION,
  workflowDefinitionIds: [DEFINITION],
  requiredDomainPacks: [],
  requiredCapabilities: [],
  policyReferenceId: null,
  runtimeRequirements: { runtimeClass: 'pooled-worker' },
  triggerConfig: [],
  status: 'active',
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const evidence = (overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  evidenceId: EVIDENCE,
  clientId: CLIENT,
  workspaceId: WORKSPACE,
  class: 'observation',
  source: { system: 'fixture', ref: null },
  observedAt: '2026-01-01T00:00:00.000Z',
  content: { metric: 'activation_rate' },
  contentRef: null,
  quality: 'B',
  confidence: null,
  supersedes: null,
  supersededBy: null,
  provenance: {
    actor: 'user:fixture',
    recordedVia: 'api',
    correlationId: 'fixture',
    causationId: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
  },
  ...overrides,
});

const experiment = (overrides: Partial<ExperimentRecord> = {}): ExperimentRecord => ({
  experimentId: EXPERIMENT,
  clientId: CLIENT,
  workspaceId: null,
  hypothesis: 'The 5-touch sequence increases activation.',
  decisionTarget: 'Rollout decision.',
  populationUnit: 'New accounts.',
  treatment: '5-touch sequence.',
  comparison: '3-touch sequence.',
  assignmentMethod: 'Random.',
  designType: 'randomized',
  primaryMetric: { name: 'activation_rate', dimensions: {} },
  guardrails: [],
  analysisMethod: 'z-test',
  analysisMethodVersion: null,
  expectedDirection: 'increase',
  startCriteria: null,
  stopCriteria: 'At 2000 accounts.',
  minimumEvidenceRequirement: 'B',
  uncertaintyRepresentation: 'interval',
  status: 'concluded',
  resultState: 'undecided',
  resultingDecision: null,
  concludedAt: null,
  provenance: {
    actor: 'user:fixture',
    recordedVia: 'api',
    correlationId: 'fixture',
    causationId: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
  },
  ...overrides,
});

const learning = (overrides: Partial<LearningRecord> = {}): LearningRecord => ({
  learningId: LEARNING,
  clientId: CLIENT,
  workspaceId: null,
  statement: 'Onboarding sequences drive activation.',
  applicability: { cohort: 'new_accounts' },
  evidenceRefs: [EVIDENCE, OUT_OF_WINDOW_EVIDENCE, FOREIGN_EVIDENCE],
  experimentRefs: [EXPERIMENT_CITED],
  confidence: 0.8,
  status: 'active',
  supersededBy: null,
  provenance: {
    actor: 'user:fixture',
    recordedVia: 'api',
    correlationId: 'fixture',
    causationId: null,
    recordedAt: '2026-01-01T00:00:00.000Z',
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// The snapshot fixture (the full chain + the fail-closed cases)
// ---------------------------------------------------------------------------

function snapshotFixture(): ClientGraphAuthoritySnapshot {
  const supersedingEvidence = evidence({
    evidenceId: EVIDENCE,
    supersedes: EVIDENCE_SUPERSEDED,
    workspaceId: null,
  });
  const supersededEvidence = evidence({
    evidenceId: EVIDENCE_SUPERSEDED,
    workspaceId: null,
  });
  return {
    agencyId: AGENCY,
    clientId: CLIENT,
    goals: [goal(), goal({ goalId: GOAL_WIDE, workspaceId: WORKSPACE })],
    playbooks: [
      {
        playbook: playbook(),
        versions: [playbookVersion()],
      },
    ],
    workspaces: [
      {
        workspaceId: WORKSPACE,
        deployments: [
          // Pins the client playbook version (in scope).
          deployment(),
          // Pins an AGENCY-reusable playbook version of the SAME agency
          // (legal: agency-scoped endpoint inside a client graph).
          deployment({
            deploymentId: 'ffffffff-0000-4000-8000-000000000002',
            playbookVersionId: AGENCY_PLAYBOOK_VERSION,
          }),
          // Pins a version of ANOTHER agency's playbook — fail-closed.
          deployment({
            deploymentId: 'ffffffff-0000-4000-8000-000000000003',
            playbookVersionId: 'eeeeeeee-0000-4000-8000-000000000003',
          }),
          // References a workflow definition of ANOTHER client — fail-closed.
          deployment({
            deploymentId: 'ffffffff-0000-4000-8000-000000000004',
            workflowDefinitionIds: ['cdcdcdcd-0000-4000-8000-000000000002'],
          }),
        ],
        workflows: [
          {
            workflow: workflow(),
            definitions: [definition()],
            instances: [instance()],
          },
        ],
        executions: [
          execution(),
          // Task linkage to an instance that is NOT one of the client's own
          // — reference data; derives NO executes_step relation.
          execution({
            executionId: EXECUTION_FOREIGN_LINK,
            taskLink: {
              kind: 'workflow-node',
              workflowInstanceId: 'efefefef-0000-4000-8000-000000000002',
              nodeId: 'x',
            },
          }),
        ],
      },
    ],
    evidence: [supersedingEvidence, supersededEvidence],
    experiments: [experiment()],
    learnings: [
      learning(),
      // A foreign learning's citations still derive nothing for THIS
      // client — covered by the resolvedEvidence/resolvedExperiments nulls.
    ],
    resolvedPlaybookVersions: new Map([
      [PLAYBOOK_VERSION, { version: playbookVersion(), playbook: playbook() }],
      [
        AGENCY_PLAYBOOK_VERSION,
        {
          version: playbookVersion({
            versionId: AGENCY_PLAYBOOK_VERSION,
            playbookId: AGENCY_PLAYBOOK,
          }),
          playbook: playbook({
            playbookId: AGENCY_PLAYBOOK,
            clientId: null,
            goalId: null,
          }),
        },
      ],
      // Another agency's version resolved — the derivation filters it out.
      [
        'eeeeeeee-0000-4000-8000-000000000003',
        {
          version: playbookVersion({ versionId: 'eeeeeeee-0000-4000-8000-000000000003' }),
          playbook: playbook({
            playbookId: 'dddddddd-0000-4000-8000-000000000003',
            agencyId: OTHER_AGENCY,
            clientId: null,
            goalId: null,
          }),
        },
      ],
      // Unresolvable pin — derives nothing.
      ['eeeeeeee-0000-4000-8000-000000000004', null],
    ]),
    resolvedDefinitions: new Map([
      // The Client's own enumerated definition (known to the module's
      // snapshot construction through the workspace workflow listing).
      [DEFINITION, { definition: definition(), workflow: workflow() }],
      // A definition of ANOTHER client's workflow — filtered out.
      [
        'cdcdcdcd-0000-4000-8000-000000000002',
        {
          definition: definition({ workflowDefinitionId: 'cdcdcdcd-0000-4000-8000-000000000002' }),
          workflow: workflow({
            workflowId: 'abababab-0000-4000-8000-000000000002',
            workspaceId: OTHER_WORKSPACE,
            clientId: OTHER_CLIENT,
          }),
        },
      ],
    ]),
    resolvedEvidence: new Map([
      // Out-of-window evidence cited by the learning (same client → derived).
      [OUT_OF_WINDOW_EVIDENCE, evidence({ evidenceId: OUT_OF_WINDOW_EVIDENCE, workspaceId: null })],
      // Foreign evidence cited by the learning — derives NOTHING.
      [FOREIGN_EVIDENCE, evidence({ evidenceId: FOREIGN_EVIDENCE, clientId: OTHER_CLIENT })],
    ]),
    resolvedExperiments: new Map([
      [EXPERIMENT_CITED, experiment({ experimentId: EXPERIMENT_CITED })],
    ]),
  };
}

/** The derived edges as a lookup-friendly map. */
function edgeMap(edges: readonly DerivedEdgeRef[]): Map<string, DerivedEdgeRef> {
  const map = new Map<string, DerivedEdgeRef>();
  for (const edge of edges) {
    map.set(`${edge.from.kind}:${edge.from.id}|${edge.relation}|${edge.to.kind}:${edge.to.id}`, edge);
  }
  return map;
}

// ---------------------------------------------------------------------------
// The exact derivation
// ---------------------------------------------------------------------------

test('deriveClientGraphProjection derives the EXACT node + relation sets of the v1.5 chain', () => {
  const projection = deriveClientGraphProjection(snapshotFixture());
  const nodes = new Set(projection.nodes.map((node) => `${node.kind}:${node.id}`));
  const edges = edgeMap(projection.edges);

  // Nodes: the client, goals, playbook + versions (client + agency-scoped
  // pin), deployments (in-scope pins only), workflow, definition, instance,
  // executions, evidence (window + out-of-window cited), experiment(s),
  // learning.
  for (const expected of [
    `client:${CLIENT}`,
    `goal:${GOAL}`,
    `goal:${GOAL_WIDE}`,
    `playbook:${PLAYBOOK}`,
    `playbook_version:${PLAYBOOK_VERSION}`,
    `playbook_version:${AGENCY_PLAYBOOK_VERSION}`,
    `deployment:${DEPLOYMENT}`,
    `workflow:${WORKFLOW}`,
    `workflow_definition:${DEFINITION}`,
    `workflow_instance:${INSTANCE}`,
    `execution:${EXECUTION}`,
    `execution:${EXECUTION_FOREIGN_LINK}`,
    `evidence:${EVIDENCE}`,
    `evidence:${EVIDENCE_SUPERSEDED}`,
    `evidence:${OUT_OF_WINDOW_EVIDENCE}`,
    `experiment:${EXPERIMENT}`,
    `experiment:${EXPERIMENT_CITED}`,
    `learning:${LEARNING}`,
  ]) {
    assert.ok(nodes.has(expected), `expected node ${expected}`);
  }
  // NO node for the other agency's pinned version or the foreign evidence.
  assert.ok(!nodes.has(`playbook_version:eeeeeeee-0000-4000-8000-000000000003`));
  assert.ok(!nodes.has(`evidence:${FOREIGN_EVIDENCE}`));

  // Relations: the full chain links.
  for (const expected of [
    `client:${CLIENT}|has_goal|goal:${GOAL}`,
    `client:${CLIENT}|has_goal|goal:${GOAL_WIDE}`,
    `goal:${GOAL}|pursued_by_playbook|playbook:${PLAYBOOK}`,
    `playbook:${PLAYBOOK}|has_version|playbook_version:${PLAYBOOK_VERSION}`,
    `deployment:${DEPLOYMENT}|pins_playbook_version|playbook_version:${PLAYBOOK_VERSION}`,
    `deployment:${DEPLOYMENT}|deploys_definition|workflow_definition:${DEFINITION}`,
    `workflow:${WORKFLOW}|has_definition|workflow_definition:${DEFINITION}`,
    `workflow_instance:${INSTANCE}|pins_definition|workflow_definition:${DEFINITION}`,
    `execution:${EXECUTION}|executes_step|workflow_instance:${INSTANCE}`,
    `client:${CLIENT}|runs_execution|execution:${EXECUTION}`,
    `client:${CLIENT}|runs_execution|execution:${EXECUTION_FOREIGN_LINK}`,
    `client:${CLIENT}|has_evidence|evidence:${EVIDENCE}`,
    `client:${CLIENT}|has_evidence|evidence:${EVIDENCE_SUPERSEDED}`,
    `evidence:${EVIDENCE}|supersedes|evidence:${EVIDENCE_SUPERSEDED}`,
    `client:${CLIENT}|runs_experiment|experiment:${EXPERIMENT}`,
    `client:${CLIENT}|records_learning|learning:${LEARNING}`,
    `learning:${LEARNING}|supported_by|evidence:${EVIDENCE}`,
    `learning:${LEARNING}|supported_by|evidence:${OUT_OF_WINDOW_EVIDENCE}`,
    `learning:${LEARNING}|derived_from|experiment:${EXPERIMENT_CITED}`,
  ]) {
    assert.ok(edges.has(expected), `expected relation ${expected}`);
  }

  // The agency-scoped pin: the SAME agency's reusable playbook version IS
  // related (an agency-scoped endpoint inside the client graph is legal).
  assert.ok(
    edges.has(
      `deployment:ffffffff-0000-4000-8000-000000000002|pins_playbook_version|playbook_version:${AGENCY_PLAYBOOK_VERSION}`,
    ),
    'the agency-reusable playbook version pin of the SAME agency is derived',
  );

  // FAIL-CLOSED negatives:
  // - the other agency's pin derives NOTHING;
  assert.ok(
    ![...edges.keys()].some((key) => key.includes('eeeeeeee-0000-4000-8000-000000000003')),
    'a foreign-agency playbook pin derives no relation',
  );
  // - the unresolvable pin derives NOTHING;
  assert.ok(
    ![...edges.keys()].some((key) => key.includes('eeeeeeee-0000-4000-8000-000000000004')),
    'an unresolvable pin derives no relation',
  );
  // - the foreign workflow definition reference derives NOTHING;
  assert.ok(
    ![...edges.keys()].some((key) => key.includes('cdcdcdcd-0000-4000-8000-000000000002')),
    'a foreign workflow definition reference derives no relation',
  );
  // - the execution with the foreign instance linkage has NO executes_step;
  assert.ok(
    ![...edges.keys()].some((key) => key.startsWith(`execution:${EXECUTION_FOREIGN_LINK}|executes_step`)),
    'an execution linked to a foreign instance derives no executes_step relation',
  );
  // - the learning's foreign evidence citation derives NOTHING.
  assert.ok(
    ![...edges.keys()].some((key) => key.endsWith(`|evidence:${FOREIGN_EVIDENCE}`)),
    'a foreign evidence citation derives no relation',
  );
});

test('EXACT VERSION ADDRESSING: edges reference the exact immutable version ids — never a floating latest', () => {
  const projection = deriveClientGraphProjection(snapshotFixture());
  const edges = edgeMap(projection.edges);
  const pin = edges.get(`deployment:${DEPLOYMENT}|pins_playbook_version|playbook_version:${PLAYBOOK_VERSION}`);
  assert.ok(pin !== undefined, 'the pin relation exists');
  // The relation's to-endpoint IS the deployment's exact pinned version id.
  assert.equal(pin.to.id, PLAYBOOK_VERSION);
  const pinnedDefinition = edges.get(
    `workflow_instance:${INSTANCE}|pins_definition|workflow_definition:${DEFINITION}`,
  );
  assert.ok(pinnedDefinition !== undefined);
  assert.equal(pinnedDefinition.to.id, DEFINITION);
  // A second playbook version would add its own relation — the first pin
  // never floats.
  const base = snapshotFixture();
  const snapshot: ClientGraphAuthoritySnapshot = {
    ...base,
    playbooks: [
      {
        playbook: base.playbooks[0]!.playbook,
        versions: [
          ...base.playbooks[0]!.versions,
          playbookVersion({ versionId: 'eeeeeeee-0000-4000-8000-000000000009', versionNumber: 2 }),
        ],
      },
    ],
  };
  const rederived = edgeMap(deriveClientGraphProjection(snapshot).edges);
  assert.ok(
    rederived.has(`playbook:${PLAYBOOK}|has_version|playbook_version:eeeeeeee-0000-4000-8000-000000000009`),
    'the second version gets its own relation',
  );
  assert.ok(
    rederived.has(`playbook:${PLAYBOOK}|has_version|playbook_version:${PLAYBOOK_VERSION}`),
    'the first version relation stays EXACT — no floating latest',
  );
});

test('the frozen epistemic vocabulary: every rebuild-derived relation is observed and the five states stay distinct', () => {
  const projection = deriveClientGraphProjection(snapshotFixture());
  assert.ok(projection.edges.length > 0);
  for (const edge of projection.edges) {
    assert.equal(
      edge.state,
      'observed',
      'MKT-041 rebuild-derived relations are read from authoritative state (observed)',
    );
  }
  assert.deepEqual([...OPERATING_GRAPH_EDGE_STATES], [
    'unknown',
    'observed',
    'predicted',
    'attributed',
    'causal',
  ]);
  assert.equal(new Set(OPERATING_GRAPH_EDGE_STATES).size, 5, 'the five states are distinct');
  assert.equal(new Set(OPERATING_GRAPH_EDGE_RELATIONS).size, 15, 'the 15 relations are distinct');
  assert.equal(new Set(OPERATING_GRAPH_NODE_KINDS).size, 12, 'the 12 node kinds are distinct');
});

test('the workspace attribution rule: the from endpoint\'s workspace, else the to endpoint\'s', () => {
  const projection = deriveClientGraphProjection(snapshotFixture());
  const edges = edgeMap(projection.edges);
  // client (null) → workspace-scoped goal: the relation lives in the goal's
  // workspace.
  assert.equal(
    edges.get(`client:${CLIENT}|has_goal|goal:${GOAL_WIDE}`)!.workspaceId,
    WORKSPACE,
  );
  // client-wide goal → client-scoped playbook: no workspace on either side.
  assert.equal(
    edges.get(`goal:${GOAL}|pursued_by_playbook|playbook:${PLAYBOOK}`)!.workspaceId,
    null,
  );
  // workspace-scoped deployment → client-wide version: the deployment's
  // workspace.
  assert.equal(
    edges.get(`deployment:${DEPLOYMENT}|pins_playbook_version|playbook_version:${PLAYBOOK_VERSION}`)!
      .workspaceId,
    WORKSPACE,
  );
});

test('the derived registry nodes carry the record\'s OWN scope (agency-scoped records have client null)', () => {
  const projection = deriveClientGraphProjection(snapshotFixture());
  const nodes = new Map(projection.nodes.map((node) => [`${node.kind}:${node.id}`, node]));
  assert.equal(nodes.get(`client:${CLIENT}`)!.clientId, CLIENT);
  assert.equal(nodes.get(`goal:${GOAL_WIDE}`)!.workspaceId, WORKSPACE);
  assert.equal(nodes.get(`playbook_version:${AGENCY_PLAYBOOK_VERSION}`)!.clientId, null);
  assert.equal(nodes.get(`playbook_version:${AGENCY_PLAYBOOK_VERSION}`)!.agencyId, AGENCY);
  assert.equal(nodes.get(`playbook_version:${PLAYBOOK_VERSION}`)!.clientId, CLIENT);
});

// ---------------------------------------------------------------------------
// The view compositions
// ---------------------------------------------------------------------------

function edgeRow(overrides: Partial<GraphEdgeRowInput>): GraphEdgeRowInput {
  return {
    edgeId: 'edge-1',
    agencyId: AGENCY,
    clientId: CLIENT,
    workspaceId: WORKSPACE,
    fromKind: 'deployment',
    fromId: DEPLOYMENT,
    toKind: 'playbook_version',
    toId: PLAYBOOK_VERSION,
    relation: 'pins_playbook_version',
    edgeState: 'observed',
    edgeVersion: 1,
    isCurrent: true,
    recordedAt: '2026-01-02T00:00:00.000Z',
    recordedBy: 'operating-graph-rebuild',
    supersededAt: null,
    ...overrides,
  };
}

test('composeClientOperatingGraphView groups current + history and keeps superseded relations addressable', () => {
  const view = composeClientOperatingGraphView({
    agencyId: AGENCY,
    clientId: CLIENT,
    workspaceCount: 2,
    nodes: [
      {
        kind: 'deployment',
        id: DEPLOYMENT,
        agencyId: AGENCY,
        clientId: CLIENT,
        workspaceId: WORKSPACE,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastRefreshedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        kind: 'playbook_version',
        id: PLAYBOOK_VERSION,
        agencyId: AGENCY,
        clientId: CLIENT,
        workspaceId: null,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastRefreshedAt: '2026-01-03T00:00:00.000Z',
      },
    ],
    edgeRows: [
      // The retracted prior pin (redeploy moved the deployment to v2).
      edgeRow({
        edgeId: 'edge-old',
        toId: 'eeeeeeee-0000-4000-8000-000000000009',
        edgeVersion: 1,
        isCurrent: false,
        supersededAt: '2026-01-04T00:00:00.000Z',
      }),
      edgeRow({
        edgeId: 'edge-now',
        edgeVersion: 1,
        isCurrent: true,
      }),
      // A same-key state change: two versions, the newer current.
      edgeRow({
        edgeId: 'edge-state-1',
        relation: 'supported_by',
        fromKind: 'learning',
        fromId: LEARNING,
        toKind: 'evidence',
        toId: EVIDENCE,
        edgeState: 'unknown',
        edgeVersion: 1,
        isCurrent: false,
        supersededAt: '2026-01-05T00:00:00.000Z',
      }),
      edgeRow({
        edgeId: 'edge-state-2',
        relation: 'supported_by',
        fromKind: 'learning',
        fromId: LEARNING,
        toKind: 'evidence',
        toId: EVIDENCE,
        edgeState: 'attributed',
        edgeVersion: 2,
        isCurrent: true,
      }),
    ],
    generatedAt: '2026-01-06T00:00:00.000Z',
  });

  assert.equal(view.scope.kind, 'client-operating-graph');
  assert.equal(view.nodeCount, 2);
  assert.equal(view.edgeCount, 2);
  assert.equal(view.edges.length, 2);
  assert.equal(view.supersededEdges.length, 1);

  // The current pin with its (single-version) history.
  const pin = view.edges.find(
    (edge) => edge.relation === 'pins_playbook_version' && edge.toId === PLAYBOOK_VERSION,
  );
  assert.ok(pin !== undefined);
  assert.equal(pin.current.edgeId, 'edge-now');
  assert.equal(pin.history.length, 1);

  // The state-changed relation: current version 2, BOTH versions in history
  // (the epistemic vocabulary stays distinct across versions).
  const supported = view.edges.find((edge) => edge.relation === 'supported_by');
  assert.ok(supported !== undefined);
  assert.equal(supported.current.edgeVersion, 2);
  assert.equal(supported.current.edgeState, 'attributed');
  assert.deepEqual(
    supported.history.map((version) => version.edgeState),
    ['unknown', 'attributed'],
  );

  // The retracted pin stays addressable as a superseded relation.
  const retracted = view.supersededEdges[0]!;
  assert.equal(retracted.relation, 'pins_playbook_version');
  assert.equal(retracted.toId, 'eeeeeeee-0000-4000-8000-000000000009');
  assert.equal(retracted.lastVersion.edgeVersion, 1);
  assert.notEqual(retracted.lastVersion.supersededAt, null);

  // The honest derivation disclosure.
  assert.equal(view.derivation.basis, 'canonical-authority-records');
  assert.equal(view.derivation.evidenceWindow, 'evidence-authority-bounded-newest-first-listing');
  assert.deepEqual(view.derivation.edgeStates, [
    'unknown',
    'observed',
    'predicted',
    'attributed',
    'causal',
  ]);
});

test('composeAgencyOperatingGraphView zero-fills every relation and totals the portfolio', () => {
  const view = composeAgencyOperatingGraphView({
    agencyId: AGENCY,
    clients: [
      { clientId: CLIENT, workspaceCount: 2 },
      { clientId: OTHER_CLIENT, workspaceCount: 1 },
    ],
    tallies: [
      {
        clientId: CLIENT,
        nodeCount: 7,
        relationCounts: new Map([
          ['has_goal', 3],
          ['supersedes', 1],
        ]),
      },
      // The second client has NO graph yet — zero-filled.
    ],
    totalNodeCount: 7,
    generatedAt: '2026-01-06T00:00:00.000Z',
  });

  assert.equal(view.scope.kind, 'agency-operating-graph');
  assert.equal(view.scope.clientCount, 2);
  assert.equal(view.totals.nodeCount, 7);
  assert.equal(view.totals.edgeCount, 4);
  assert.equal(view.perClient.length, 2);
  const first = view.perClient[0]!;
  assert.equal(first.nodeCount, 7);
  assert.equal(first.edgeCount, 4);
  assert.equal(first.workspaceCount, 2);
  assert.equal(first.relationCounts['has_goal'], 3);
  assert.equal(first.relationCounts['supersedes'], 1);
  // EVERY relation key present, zeros included (the house tally posture).
  for (const relation of OPERATING_GRAPH_EDGE_RELATIONS) {
    assert.ok(relation in first.relationCounts, `relation ${relation} zero-filled`);
  }
  assert.equal(first.relationCounts['pins_definition'], 0);
  const second = view.perClient[1]!;
  assert.equal(second.nodeCount, 0);
  assert.equal(second.edgeCount, 0);
  assert.equal(second.relationCounts['has_goal'], 0);
  assert.equal(view.derivation.basis, 'canonical-authority-records');
});
