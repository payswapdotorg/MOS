/**
 * MKT-034 unit tests — THE ACQUISITION LOOP TEMPLATE PACKAGE (pure, no DB):
 * template assembly, §4 authority-validator conformance of the three-leg
 * template graph, §16 experiment-declaration completeness, §18 field-job
 * descriptor shape, §2 extension-manifest shape, bounds sanity, and the
 * pure guardrail/primary-metric evaluation over /metrics observation views.
 *
 * Acceptance mapping (work-item-matrix.md MKT-034 = E2E-001, acceptance
 * E2E-AC-01: "a complete pilot can execute using at least one AI path, one
 * human field-agent path, and one extension path with a shared
 * Goal/Workflow/Evidence lifecycle — end-to-end integration test"): these
 * tests pin the TEMPLATE — the bounded three-path loop contract that the
 * wiring service (loop-flow.ts) drives through the authority public
 * contracts and the E2E integration test proves end-to-end on the real
 * stack.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWorkflowDefinitionContent } from '../../src/modules/workflows/public.ts';
import { WORKFLOW_INSTANCE_TERMINAL_STATUSES } from '../../src/modules/workflows/public.ts';
import { EXTENSION_PERMISSION_ACTIONS } from '../../src/modules/extensions/public.ts';
import {
  LOOP_AI_NODE,
  LOOP_ENTRY_NODE,
  LOOP_EXTENSION_NODE,
  LOOP_FIELD_NODE,
  LOOP_JOIN_NODE,
  LOOP_TERMINAL_NODE,
  LOOP_NODE_IDS,
  type LoopObservationView,
} from '../../src/workers/acquisition-loop/contract.ts';
import {
  ACQUISITION_LOOP_BOUNDS,
  LOOP_EVIDENCE_CAPTURE_POINTS,
  LOOP_GUARDRAIL_COST,
  LOOP_METRIC_IDENTITIES,
  LOOP_PRIMARY_METRIC,
  acquisitionLoopTemplate,
  buildExperimentDeclaration,
  buildExtensionManifest,
  buildFieldJobDescriptor,
  buildPlaybookStrategy,
  buildWorkflowDefinitionContent,
  evaluateLoopGuardrails,
  metricTotal,
} from '../../src/workers/acquisition-loop/template.ts';

// ---------------------------------------------------------------------------
// Template assembly (purity + shape)
// ---------------------------------------------------------------------------

test('the loop template package is PURE: two assemblies are deeply equal', () => {
  const first = acquisitionLoopTemplate();
  const second = acquisitionLoopTemplate();
  assert.deepEqual(first, second);
});

test('the playbook strategy and deployment metadata declare the extension capability + pooled-worker runtime', () => {
  const { strategy, deploymentMetadata } = buildPlaybookStrategy();
  assert.ok(strategy.summary.length > 0);
  assert.ok(strategy.templates.length >= 1);
  assert.equal(strategy.templates[0]!.name, 'acquisition-loop-flow');
  // The loop requires exactly ONE extension capability (the §19 leg) and
  // no Domain Pack.
  assert.deepEqual(deploymentMetadata.requiredDomainPacks, []);
  assert.deepEqual(deploymentMetadata.requiredCapabilities, [
    { kind: 'extension', name: 'acq-audience-sync', versionConstraint: '1.x' },
  ]);
  assert.equal(deploymentMetadata.runtimeRequirements.runtimeClass, 'pooled-worker');
  assert.equal(deploymentMetadata.triggers[0]!.kind, 'manual');
});

// ---------------------------------------------------------------------------
// §4 authority-validator conformance (the graph is legal to the /workflows
// authority's own frozen validator)
// ---------------------------------------------------------------------------

test('the loop workflow definition passes the /workflows §4 authority validator with ZERO problems', () => {
  const problems = validateWorkflowDefinitionContent(buildWorkflowDefinitionContent());
  assert.deepEqual(problems, []);
});

test('the loop graph nodes pin the frozen node classes: single function entry, ai_task + human_task + extension_capability legs, all-join, terminal', () => {
  const content = buildWorkflowDefinitionContent();
  const nodes = new Map(content.graph.nodes.map((node) => [node.nodeId, node]));

  const entry = nodes.get(LOOP_ENTRY_NODE)!;
  assert.equal(entry.nodeType, 'function');
  assert.equal(entry.idempotencyKeyStrategy, 'workflow');
  // The single entry fans out into all three legs (§4: parallel starts are
  // fan-out from the single entry).
  const entryOut = content.graph.edges.filter((edge) => edge.fromNode === LOOP_ENTRY_NODE);
  assert.equal(entryOut.length, 3);
  assert.deepEqual(
    entryOut.map((edge) => edge.toNode).sort(),
    [LOOP_AI_NODE, LOOP_FIELD_NODE, LOOP_EXTENSION_NODE].sort(),
  );

  const ai = nodes.get(LOOP_AI_NODE)!;
  assert.equal(ai.nodeType, 'ai_task');
  assert.equal(ai.idempotencyKeyStrategy, 'workflow');
  assert.deepEqual(ai.retryPolicy, { maxAttempts: 2, backoffMs: null });
  assert.equal(ai.humanApproval, null);

  const field = nodes.get(LOOP_FIELD_NODE)!;
  assert.equal(field.nodeType, 'human_task');
  assert.deepEqual(field.humanApproval, { required: true, approverPolicyRef: null });

  const extension = nodes.get(LOOP_EXTENSION_NODE)!;
  assert.equal(extension.nodeType, 'extension_capability');
  assert.equal(extension.idempotencyKeyStrategy, 'workflow');
  assert.equal(extension.humanApproval, null);

  const join = nodes.get(LOOP_JOIN_NODE)!;
  assert.equal(join.nodeType, 'join');
  assert.equal(join.join!.semantics, 'all');
  assert.deepEqual(join.join!.predecessors, [LOOP_AI_NODE, LOOP_FIELD_NODE, LOOP_EXTENSION_NODE]);
  // Structural nodes carry no execution policy of any kind.
  assert.equal(join.executionPolicyRef, null);
  assert.equal(join.retryPolicy, null);
  assert.equal(join.idempotencyKeyStrategy, null);

  const terminal = nodes.get(LOOP_TERMINAL_NODE)!;
  assert.equal(terminal.nodeType, 'terminal');
  // The terminal node has no outgoing edges (§4).
  assert.ok(
    content.graph.edges.every((edge) => edge.fromNode !== LOOP_TERMINAL_NODE),
    'the terminal node has no outgoing edges',
  );

  assert.deepEqual(
    content.graph.nodes.map((node) => node.nodeId),
    [...LOOP_NODE_IDS],
  );
});

test('the loop join contract mirrors its join edges exactly (§4 edge contract, three predecessors)', () => {
  const content = buildWorkflowDefinitionContent();
  const joinEdges = content.graph.edges.filter((edge) => edge.toNode === LOOP_JOIN_NODE);
  assert.equal(joinEdges.length, 3);
  for (const edge of joinEdges) {
    assert.equal(edge.edgeType, 'join');
    assert.equal(edge.joinSemantics, 'all');
  }
  const joinNode = content.graph.nodes.find((node) => node.nodeId === LOOP_JOIN_NODE)!;
  const edgeSenders = joinEdges.map((edge) => edge.fromNode).sort();
  assert.deepEqual([...joinNode.join!.predecessors].sort(), edgeSenders);
});

// ---------------------------------------------------------------------------
// §16 experiment declaration completeness (the frozen contract field set)
// ---------------------------------------------------------------------------

test('the loop experiment declaration carries the COMPLETE §16 frozen contract', () => {
  const declaration = buildExperimentDeclaration();
  assert.ok(declaration.hypothesis.length > 0);
  assert.ok(declaration.hypothesis.includes('AI-scored outreach task'));
  assert.ok(declaration.hypothesis.includes('field visit'));
  assert.ok(declaration.hypothesis.includes('extension audience-sync action'));
  assert.ok(declaration.decisionTarget.length > 0);
  assert.ok(declaration.populationUnit.length > 0);
  assert.ok(declaration.treatment.length > 0);
  assert.ok(declaration.comparison.length > 0);
  assert.ok(declaration.assignmentMethod.length > 0);
  assert.equal(declaration.designType, 'quasi_experimental');
  assert.equal(declaration.primaryMetric.name, LOOP_PRIMARY_METRIC.name);
  assert.deepEqual(declaration.primaryMetric.dimensions, LOOP_PRIMARY_METRIC.dimensions);
  assert.deepEqual(
    declaration.guardrails.map((guardrail) => guardrail.name),
    [LOOP_GUARDRAIL_COST.name],
  );
  assert.ok(declaration.analysisMethod.length > 0);
  assert.ok(declaration.analysisMethodVersion !== null && declaration.analysisMethodVersion.length > 0);
  assert.equal(declaration.expectedDirection, 'increase');
  assert.ok(declaration.startCriteria !== null && declaration.startCriteria.length > 0);
  assert.ok(declaration.stopCriteria.length > 0);
  assert.ok(declaration.minimumEvidenceRequirement.length > 0);
  assert.equal(declaration.uncertaintyRepresentation, 'interval');
});

test('the loop metric identities are NAME + DIMENSIONS series identities (never provider ids or observation ids)', () => {
  for (const identity of LOOP_METRIC_IDENTITIES) {
    assert.ok(identity.name.length > 0);
    assert.ok(Object.keys(identity.dimensions).length > 0);
    for (const value of Object.values(identity.dimensions)) {
      assert.ok(
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
        'dimension values are scalars',
      );
    }
  }
  // The primary metric and the guardrail are distinct series, and the loop
  // series are distinct from the MKT-028 pilot series (no accidental
  // cross-template interference in shared clients).
  assert.notEqual(LOOP_PRIMARY_METRIC.name, LOOP_GUARDRAIL_COST.name);
  assert.notEqual(LOOP_PRIMARY_METRIC.name, 'pilot_qualified_leads');
  assert.notEqual(LOOP_GUARDRAIL_COST.name, 'pilot_cost_usd');
});

// ---------------------------------------------------------------------------
// §18 field job descriptor (profile-data-only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// §2 extension manifest (the §19 leg's frozen capability declaration)
// ---------------------------------------------------------------------------

test('the extension manifest declares the least-privilege §2 contract with the closed permission vocabulary', () => {
  const manifest = buildExtensionManifest();
  assert.equal(manifest.extensionKey, 'acq-audience-sync');
  assert.ok(manifest.publisher.length > 0);
  assert.match(manifest.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.ok(manifest.capabilities.length >= 1);
  assert.ok(
    manifest.capabilities.some(
      (capability) => capability.category === 'execution-action' && capability.name === 'sync-audience-segment',
    ),
    'the invocable unit the workflow extension_capability node names is declared',
  );
  // Permissions stay inside the CLOSED §5 vocabulary — a manifest that
  // cannot declare workflow-state mutation, credential creation, evidence
  // provenance fabrication or audit disabling.
  for (const permission of manifest.permissions) {
    assert.ok(
      (EXTENSION_PERMISSION_ACTIONS as readonly string[]).includes(permission.action),
      `permission action '${permission.action}' is inside the closed vocabulary`,
    );
  }
  // Secret names are LOGICAL NAMES ONLY (CRED-001) — uppercase identifiers,
  // never values.
  for (const name of manifest.requiredSecretNames) {
    assert.match(name, /^[A-Z][A-Z0-9_]{2,47}$/);
  }
  assert.ok(!JSON.stringify(manifest).includes('MATERIAL'));
  // Data scopes stay inside the closed scope vocabulary and grant nothing
  // beyond the owning client/workspace boundary.
  for (const scope of manifest.dataScopes) {
    assert.ok(['client:read', 'client:write', 'workspace:read', 'workspace:write'].includes(scope));
  }
  assert.equal(manifest.runtimeClass, 'pooled-worker');
  assert.deepEqual(manifest.inputContract, { required: ['segmentId'] });
  assert.deepEqual(manifest.outputContract, { required: ['syncedCount'] });
  assert.ok(typeof manifest.configContract['region'] === 'object' && manifest.configContract['region'] !== null);
});

test('the extension manifest is PURE: two builds are deeply equal', () => {
  assert.deepEqual(buildExtensionManifest(), buildExtensionManifest());
});

// ---------------------------------------------------------------------------
// Evidence capture points (the E2E-AC-01 evidence chain stages)
// ---------------------------------------------------------------------------

test('the evidence capture points declare the E2E-AC-01 three-path + outcome evidence chain', () => {
  assert.equal(LOOP_EVIDENCE_CAPTURE_POINTS.length, 4);
  const stages = LOOP_EVIDENCE_CAPTURE_POINTS.map((point) => point.stage);
  assert.deepEqual(stages, ['ai_execution', 'field_visit', 'extension_action', 'loop_outcome']);
  for (const point of LOOP_EVIDENCE_CAPTURE_POINTS) {
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

test('the loop bounds are finite, positive and cover every declared guardrail', () => {
  const { bounds, experiment } = acquisitionLoopTemplate();
  assert.ok(Number.isSafeInteger(bounds.maxInstancesPerLoop) && bounds.maxInstancesPerLoop >= 1);
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
  const evaluation = evaluateLoopGuardrails([], ACQUISITION_LOOP_BOUNDS);
  assert.equal(evaluation.breached, false);
  assert.equal(evaluation.primaryMetricTotal, 0);
  assert.equal(evaluation.guardrails.length, 1);
  const cost = evaluation.guardrails[0]!;
  assert.equal(cost.name, LOOP_GUARDRAIL_COST.name);
  assert.equal(cost.totalValue, 0);
  assert.equal(cost.threshold, ACQUISITION_LOOP_BOUNDS.guardrailThresholds[LOOP_GUARDRAIL_COST.name]!);
  assert.equal(cost.breached, false);
});

test('guardrail evaluation: summed cost over the threshold is BREACHED; the primary metric sums independently', () => {
  const observations: LoopObservationView[] = [
    { metricName: LOOP_GUARDRAIL_COST.name, dimensions: { loop: 'acquisition' }, value: 300, unit: 'USD' },
    { metricName: LOOP_GUARDRAIL_COST.name, dimensions: { loop: 'acquisition' }, value: 250, unit: 'USD' },
    { metricName: LOOP_PRIMARY_METRIC.name, dimensions: { loop: 'acquisition' }, value: 2, unit: 'count' },
    { metricName: LOOP_PRIMARY_METRIC.name, dimensions: { loop: 'acquisition' }, value: 1, unit: 'count' },
  ];
  const evaluation = evaluateLoopGuardrails(observations, ACQUISITION_LOOP_BOUNDS);
  assert.equal(evaluation.breached, true);
  assert.equal(evaluation.guardrails[0]!.totalValue, 550);
  assert.equal(evaluation.guardrails[0]!.breached, true);
  assert.equal(evaluation.primaryMetricTotal, 3);
});

test('dimension identity is exact: observations of a DIFFERENT series (name or dimensions) never count', () => {
  const observations: LoopObservationView[] = [
    // Same name, different dimension value — a different series.
    { metricName: LOOP_GUARDRAIL_COST.name, dimensions: { loop: 'expansion' }, value: 10_000, unit: 'USD' },
    // Same dimensions, different name — a different series (the MKT-028
    // pilot's guardrail series never counts against the loop).
    { metricName: 'pilot_cost_usd', dimensions: { loop: 'acquisition' }, value: 10_000, unit: 'USD' },
    // Extra dimension key — a different series.
    {
      metricName: LOOP_GUARDRAIL_COST.name,
      dimensions: { loop: 'acquisition', channel: 'digital' },
      value: 10_000,
      unit: 'USD',
    },
  ];
  const evaluation = evaluateLoopGuardrails(observations, ACQUISITION_LOOP_BOUNDS);
  assert.equal(evaluation.breached, false);
  assert.equal(evaluation.guardrails[0]!.totalValue, 0);
  assert.equal(evaluation.primaryMetricTotal, 0);
  // The pure metricTotal helper matches only the exact identity.
  assert.equal(
    metricTotal(observations, { name: LOOP_GUARDRAIL_COST.name, dimensions: { loop: 'expansion' } }).total,
    10_000,
  );
});

test('the evaluation is PURE: identical observations always evaluate identically', () => {
  const observations: LoopObservationView[] = [
    { metricName: LOOP_GUARDRAIL_COST.name, dimensions: { loop: 'acquisition' }, value: 500, unit: 'USD' },
    { metricName: LOOP_PRIMARY_METRIC.name, dimensions: { loop: 'acquisition' }, value: 4, unit: 'count' },
  ];
  assert.deepEqual(
    evaluateLoopGuardrails(observations, ACQUISITION_LOOP_BOUNDS),
    evaluateLoopGuardrails(observations, ACQUISITION_LOOP_BOUNDS),
  );
});

test('the template imports the frozen workflow-instance terminal statuses from the /workflows public contract (no local copy)', () => {
  // The wiring's live-instance cap depends on the AUTHORITY's terminal set —
  // pin that the public contract's set is exactly the frozen §5 terminal
  // states the loop counts against.
  assert.deepEqual([...WORKFLOW_INSTANCE_TERMINAL_STATUSES], ['succeeded', 'failed', 'cancelled']);
});
