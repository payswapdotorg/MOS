/**
 * MKT-028 unit tests — THE ACQUISITION PILOT TEMPLATE PACKAGE (pure, no DB):
 * template assembly, §4 authority-validator conformance of the template
 * graph, §16 experiment-declaration completeness, §18 field-job descriptor
 * shape, bounds sanity, and the pure guardrail/primary-metric evaluation
 * over /metrics observation views.
 *
 * Acceptance mapping (work-item-matrix.md MKT-028 = E2E-001:
 * "pilot end-to-end evidence; E2E-AC-01"): these tests pin the TEMPLATE —
 * the bounded prove-it-first pilot contract that the wiring service
 * (pilot-flow.ts) drives through the authority public contracts and the
 * E2E integration test proves end-to-end on the real stack.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWorkflowDefinitionContent } from '../../src/modules/workflows/public.ts';
import { WORKFLOW_INSTANCE_TERMINAL_STATUSES } from '../../src/modules/workflows/public.ts';
import {
  ACQ_DIGITAL_NODE,
  ACQ_ENTRY_NODE,
  ACQ_FIELD_NODE,
  ACQ_JOIN_NODE,
  ACQ_TERMINAL_NODE,
  ACQ_NODE_IDS,
  type PilotObservationView,
} from '../../src/workers/acquisition-pilot/contract.ts';
import {
  ACQ_EVIDENCE_CAPTURE_POINTS,
  ACQ_GUARDRAIL_COST,
  ACQ_METRIC_IDENTITIES,
  ACQ_PRIMARY_METRIC,
  ACQUISITION_PILOT_BOUNDS,
  acquisitionPilotTemplate,
  buildExperimentDeclaration,
  buildFieldJobDescriptor,
  buildPlaybookStrategy,
  buildWorkflowDefinitionContent,
  evaluatePilotGuardrails,
  metricTotal,
} from '../../src/workers/acquisition-pilot/template.ts';

// ---------------------------------------------------------------------------
// Template assembly (purity + shape)
// ---------------------------------------------------------------------------

test('the template package is PURE: two assemblies are deeply equal', () => {
  const first = acquisitionPilotTemplate();
  const second = acquisitionPilotTemplate();
  assert.deepEqual(first, second);
});

test('the playbook strategy and deployment metadata carry the pilot motion (pooled-worker runtime class)', () => {
  const { strategy, deploymentMetadata } = buildPlaybookStrategy();
  assert.ok(strategy.summary.length > 0);
  assert.ok(strategy.templates.length >= 1);
  assert.equal(strategy.templates[0]!.name, 'acquisition-pilot-flow');
  // The bounded pilot composes core authorities only.
  assert.deepEqual(deploymentMetadata.requiredDomainPacks, []);
  assert.deepEqual(deploymentMetadata.requiredCapabilities, []);
  assert.equal(deploymentMetadata.runtimeRequirements.runtimeClass, 'pooled-worker');
  assert.equal(deploymentMetadata.triggers[0]!.kind, 'manual');
});

// ---------------------------------------------------------------------------
// §4 authority-validator conformance (the graph is legal to the /workflows
// authority's own frozen validator)
// ---------------------------------------------------------------------------

test('the template workflow definition passes the /workflows §4 authority validator with ZERO problems', () => {
  const problems = validateWorkflowDefinitionContent(buildWorkflowDefinitionContent());
  assert.deepEqual(problems, []);
});

test('the template graph nodes pin the frozen node classes: single function entry, ai_task digital leg, human_task field leg, all-join, terminal', () => {
  const content = buildWorkflowDefinitionContent();
  const nodes = new Map(content.graph.nodes.map((node) => [node.nodeId, node]));

  const entry = nodes.get(ACQ_ENTRY_NODE)!;
  assert.equal(entry.nodeType, 'function');
  assert.equal(entry.idempotencyKeyStrategy, 'workflow');
  // The single entry fans out into both legs (§4: parallel starts are
  // fan-out from the single entry).
  const entryOut = content.graph.edges.filter((edge) => edge.fromNode === ACQ_ENTRY_NODE);
  assert.equal(entryOut.length, 2);
  assert.deepEqual(
    entryOut.map((edge) => edge.toNode).sort(),
    [ACQ_DIGITAL_NODE, ACQ_FIELD_NODE].sort(),
  );

  const digital = nodes.get(ACQ_DIGITAL_NODE)!;
  assert.equal(digital.nodeType, 'ai_task');
  assert.equal(digital.idempotencyKeyStrategy, 'workflow');
  assert.deepEqual(digital.retryPolicy, { maxAttempts: 2, backoffMs: null });
  assert.equal(digital.humanApproval, null);

  const field = nodes.get(ACQ_FIELD_NODE)!;
  assert.equal(field.nodeType, 'human_task');
  assert.deepEqual(field.humanApproval, { required: true, approverPolicyRef: null });

  const join = nodes.get(ACQ_JOIN_NODE)!;
  assert.equal(join.nodeType, 'join');
  assert.equal(join.join!.semantics, 'all');
  assert.deepEqual(join.join!.predecessors, [ACQ_DIGITAL_NODE, ACQ_FIELD_NODE]);
  // Structural nodes carry no execution policy of any kind.
  assert.equal(join.executionPolicyRef, null);
  assert.equal(join.retryPolicy, null);
  assert.equal(join.idempotencyKeyStrategy, null);

  const terminal = nodes.get(ACQ_TERMINAL_NODE)!;
  assert.equal(terminal.nodeType, 'terminal');
  // The terminal node has no outgoing edges (§4).
  assert.ok(
    content.graph.edges.every((edge) => edge.fromNode !== ACQ_TERMINAL_NODE),
    'the terminal node has no outgoing edges',
  );

  assert.deepEqual(
    content.graph.nodes.map((node) => node.nodeId),
    [...ACQ_NODE_IDS],
  );
});

test('the template join contract mirrors its join edges exactly (§4 edge contract)', () => {
  const content = buildWorkflowDefinitionContent();
  const joinEdges = content.graph.edges.filter((edge) => edge.toNode === ACQ_JOIN_NODE);
  assert.equal(joinEdges.length, 2);
  for (const edge of joinEdges) {
    assert.equal(edge.edgeType, 'join');
    assert.equal(edge.joinSemantics, 'all');
  }
  const joinNode = content.graph.nodes.find((node) => node.nodeId === ACQ_JOIN_NODE)!;
  const edgeSenders = joinEdges.map((edge) => edge.fromNode).sort();
  assert.deepEqual([...joinNode.join!.predecessors].sort(), edgeSenders);
});

// ---------------------------------------------------------------------------
// §16 experiment declaration completeness (the frozen contract field set)
// ---------------------------------------------------------------------------

test('the experiment declaration carries the COMPLETE §16 frozen contract', () => {
  const declaration = buildExperimentDeclaration();
  assert.ok(declaration.hypothesis.length > 0);
  assert.ok(declaration.decisionTarget.length > 0);
  assert.ok(declaration.populationUnit.length > 0);
  assert.ok(declaration.treatment.length > 0);
  assert.ok(declaration.comparison.length > 0);
  assert.ok(declaration.assignmentMethod.length > 0);
  assert.equal(declaration.designType, 'quasi_experimental');
  assert.equal(declaration.primaryMetric.name, ACQ_PRIMARY_METRIC.name);
  assert.deepEqual(declaration.primaryMetric.dimensions, ACQ_PRIMARY_METRIC.dimensions);
  assert.deepEqual(
    declaration.guardrails.map((guardrail) => guardrail.name),
    [ACQ_GUARDRAIL_COST.name],
  );
  assert.ok(declaration.analysisMethod.length > 0);
  assert.ok(declaration.analysisMethodVersion !== null && declaration.analysisMethodVersion.length > 0);
  assert.equal(declaration.expectedDirection, 'increase');
  assert.ok(declaration.startCriteria !== null && declaration.startCriteria.length > 0);
  assert.ok(declaration.stopCriteria.length > 0);
  assert.ok(declaration.minimumEvidenceRequirement.length > 0);
  assert.equal(declaration.uncertaintyRepresentation, 'interval');
});

test('the metric identities are NAME + DIMENSIONS series identities (never provider ids or observation ids)', () => {
  for (const identity of ACQ_METRIC_IDENTITIES) {
    assert.ok(identity.name.length > 0);
    assert.ok(Object.keys(identity.dimensions).length > 0);
    for (const value of Object.values(identity.dimensions)) {
      assert.ok(
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
        'dimension values are scalars',
      );
    }
  }
  // The primary metric and the guardrail are distinct series.
  assert.notEqual(ACQ_PRIMARY_METRIC.name, ACQ_GUARDRAIL_COST.name);
});

test('the §18 field job descriptor carries profile-data-only eligibility and no Client data', () => {
  const descriptor = buildFieldJobDescriptor();
  assert.ok(descriptor.title.length > 0 && descriptor.title.length <= 200);
  assert.ok(descriptor.description.length > 0 && descriptor.description.length <= 2000);
  assert.equal(descriptor.eligibility.specialization, 'field_agent');
  assert.deepEqual(descriptor.eligibility.requiredCapabilities, ['canvassing']);
  assert.deepEqual(descriptor.eligibility.territory, { kind: 'city', value: 'accra' });
  const availability = descriptor.eligibility.availability;
  assert.ok(availability.dayOfWeek >= 0 && availability.dayOfWeek <= 6);
  assert.ok(availability.startMinute < availability.endMinute);
  // No Client-specific data anywhere in the descriptor (human-agent-v1.3 §3).
  const serialized = JSON.stringify(descriptor);
  for (const forbidden of ['client_id', 'clientId', 'client', 'workspace', 'agency']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `the descriptor must not carry Client data ('${forbidden}')`);
  }
});

test('the evidence capture points declare the E2E-001 evidence chain stages', () => {
  assert.equal(ACQ_EVIDENCE_CAPTURE_POINTS.length, 3);
  const stages = ACQ_EVIDENCE_CAPTURE_POINTS.map((point) => point.stage);
  assert.deepEqual(stages, ['digital_execution', 'field_visit', 'pilot_outcome']);
  for (const point of ACQ_EVIDENCE_CAPTURE_POINTS) {
    assert.ok(point.description.length > 0);
    assert.ok(
      point.evidenceClass === 'observation' || point.evidenceClass === 'source_fact',
      'the frozen evidence classes only',
    );
  }
});

// ---------------------------------------------------------------------------
// Bounds sanity (E2E-001 "bounded")
// ---------------------------------------------------------------------------

test('the pilot bounds are finite, positive and cover every declared guardrail', () => {
  const { bounds, experiment } = acquisitionPilotTemplate();
  assert.ok(Number.isSafeInteger(bounds.maxInstancesPerPilot) && bounds.maxInstancesPerPilot >= 1);
  assert.ok(Number.isSafeInteger(bounds.maxConcurrentInstances) && bounds.maxConcurrentInstances >= 1);
  for (const guardrail of experiment.guardrails) {
    const threshold = bounds.guardrailThresholds[guardrail.name];
    assert.ok(
      threshold !== undefined && Number.isFinite(threshold) && threshold > 0,
      `guardrail '${guardrail.name}' has a finite positive threshold`,
    );
  }
});

// ---------------------------------------------------------------------------
// Pure guardrail + primary-metric evaluation over /metrics observations
// ---------------------------------------------------------------------------

test('guardrail evaluation over no observations: zero totals, nothing breached', () => {
  const evaluation = evaluatePilotGuardrails([], ACQUISITION_PILOT_BOUNDS);
  assert.equal(evaluation.breached, false);
  assert.equal(evaluation.primaryMetricTotal, 0);
  assert.equal(evaluation.guardrails.length, 1);
  const cost = evaluation.guardrails[0]!;
  assert.equal(cost.name, ACQ_GUARDRAIL_COST.name);
  assert.equal(cost.totalValue, 0);
  assert.equal(cost.threshold, ACQUISITION_PILOT_BOUNDS.guardrailThresholds[ACQ_GUARDRAIL_COST.name]!);
  assert.equal(cost.breached, false);
});

test('guardrail evaluation: summed cost over the threshold is BREACHED; the primary metric sums independently', () => {
  const observations: PilotObservationView[] = [
    { metricName: ACQ_GUARDRAIL_COST.name, dimensions: { pilot: 'acquisition' }, value: 300, unit: 'USD' },
    { metricName: ACQ_GUARDRAIL_COST.name, dimensions: { pilot: 'acquisition' }, value: 250, unit: 'USD' },
    { metricName: ACQ_PRIMARY_METRIC.name, dimensions: { pilot: 'acquisition' }, value: 2, unit: 'count' },
    { metricName: ACQ_PRIMARY_METRIC.name, dimensions: { pilot: 'acquisition' }, value: 1, unit: 'count' },
  ];
  const evaluation = evaluatePilotGuardrails(observations, ACQUISITION_PILOT_BOUNDS);
  assert.equal(evaluation.breached, true);
  assert.equal(evaluation.guardrails[0]!.totalValue, 550);
  assert.equal(evaluation.guardrails[0]!.breached, true);
  assert.equal(evaluation.primaryMetricTotal, 3);
});

test('dimension identity is exact: observations of a DIFFERENT series (name or dimensions) never count', () => {
  const observations: PilotObservationView[] = [
    // Same name, different dimension value — a different series.
    { metricName: ACQ_GUARDRAIL_COST.name, dimensions: { pilot: 'expansion' }, value: 10_000, unit: 'USD' },
    // Same dimensions, different name — a different series.
    { metricName: 'other_cost_usd', dimensions: { pilot: 'acquisition' }, value: 10_000, unit: 'USD' },
    // Extra dimension key — a different series.
    {
      metricName: ACQ_GUARDRAIL_COST.name,
      dimensions: { pilot: 'acquisition', channel: 'digital' },
      value: 10_000,
      unit: 'USD',
    },
  ];
  const evaluation = evaluatePilotGuardrails(observations, ACQUISITION_PILOT_BOUNDS);
  assert.equal(evaluation.breached, false);
  assert.equal(evaluation.guardrails[0]!.totalValue, 0);
  assert.equal(evaluation.primaryMetricTotal, 0);
  // The pure metricTotal helper matches only the exact identity.
  assert.equal(
    metricTotal(observations, { name: ACQ_GUARDRAIL_COST.name, dimensions: { pilot: 'expansion' } }).total,
    10_000,
  );
});

test('the evaluation is PURE: identical observations always evaluate identically', () => {
  const observations: PilotObservationView[] = [
    { metricName: ACQ_GUARDRAIL_COST.name, dimensions: { pilot: 'acquisition' }, value: 500, unit: 'USD' },
    { metricName: ACQ_PRIMARY_METRIC.name, dimensions: { pilot: 'acquisition' }, value: 4, unit: 'count' },
  ];
  assert.deepEqual(
    evaluatePilotGuardrails(observations, ACQUISITION_PILOT_BOUNDS),
    evaluatePilotGuardrails(observations, ACQUISITION_PILOT_BOUNDS),
  );
});

test('the template imports the frozen workflow-instance terminal statuses from the /workflows public contract (no local copy)', () => {
  // The wiring's live-instance cap depends on the AUTHORITY's terminal set —
  // pin that the public contract's set is exactly the frozen §5 terminal
  // states the pilot counts against.
  assert.deepEqual([...WORKFLOW_INSTANCE_TERMINAL_STATUSES], ['succeeded', 'failed', 'cancelled']);
});
