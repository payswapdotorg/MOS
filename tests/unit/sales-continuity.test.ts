/**
 * MKT-046 unit tests — the frozen Sales-to-Delivery Continuity taxonomies,
 * the carry payload derivation (the no-manual-re-entry proof), the
 * playbook-input derivation, the §8 carry fingerprint, the input/
 * provenance guards and the DB conflict classification (pure functions,
 * no DB).
 *
 * Proofs (spec/architecture-v1.5.md §8; the primary contract
 * spec/operating-graph-v1.5.md "Sales-to-delivery continuity"):
 *   - the CARRY STATE taxonomy is exactly the 3 frozen values (carrying,
 *     carried, deployed) — the forward-only completion ladder;
 *   - the EVENT KIND taxonomy is exactly the 3 frozen legs (carry-claimed,
 *     playbook-carried, deployment-carried);
 *   - the CARRIED DIMENSION taxonomy is exactly the 5 §8 dimensions
 *     (scope, goals, outcomes, assumptions, economics);
 *   - deriveCarriedProposalStructure: the structured carry snapshot is a
 *     DETERMINISTIC programmatic projection of the decision record —
 *     identical inputs derive byte-identical snapshots (purity), every
 *     one of the five dimensions is populated from the proposal's own
 *     fields, and the source block carries the canonical decision id +
 *     the exact-content fingerprint (the version identity);
 *   - derivePlaybookInputs: the /playbooks creation inputs are derived,
 *     bounded (name ≤ 200 — the playbook DTO bound; description ≤ 2000)
 *     and deterministic; the strategy carries exactly one template whose
 *     description IS the proposal's expected-impact summary; the derived
 *     deployment metadata declares NO infrastructure requirements (the
 *     proposal vocabulary carries none — nothing invented);
 *   - the §8 carry fingerprint is deterministic, sensitive to every
 *     caller-visible dimension (decisionId, goalId) and INDEPENDENT of
 *     the idempotency key;
 *   - the carry-input / deployment-carry-input guards fail closed on
 *     non-canonical ids, empty/oversized keys, empty or oversized
 *     workflow-definition lists;
 *   - the provenance guard fails closed on incomplete server-derived
 *     values;
 *   - classifySalesContinuityWriteConflict converges the migration 040
 *     trigger/fence rejections into their domain conflict classes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SALES_CONTINUITY_CARRY_STATES,
  SALES_CONTINUITY_CARRIED_DIMENSIONS,
  SALES_CONTINUITY_DERIVATION_VERSION,
  SALES_CONTINUITY_EVENT_KINDS,
  assertValidSalesContinuityCarryInput,
  assertValidSalesContinuityDeploymentCarryInput,
  assertValidSalesContinuityProvenance,
  classifySalesContinuityWriteConflict,
  deriveCarriedProposalStructure,
  derivePlaybookInputs,
  fingerprintSalesContinuityCreate,
  isKnownSalesContinuityCarryState,
  type SalesContinuityCarryInput,
  type SalesContinuityDeploymentCarryInput,
  type SalesContinuityProvenance,
} from '../../src/modules/sales-continuity/public.ts';
import type { DecisionRecord } from '../../src/modules/decisions/public.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PROVENANCE: SalesContinuityProvenance = {
  actor: 'user:00000000-0000-4000-8000-000000000001',
  recordedVia: 'api',
  correlationId: 'corr-1',
  causationId: null,
};

const DECISION_ID = '00000000-0000-4000-8000-0000000000aa';
const GOAL_ID = '00000000-0000-4000-8000-000000000090';
const CARRY_ID = '00000000-0000-4000-8000-0000000000cc';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000091';
const DEFINITION_ID = '00000000-0000-4000-8000-000000000092';
const DEFINITION_ID_2 = '00000000-0000-4000-8000-000000000093';

function acceptedDecision(): DecisionRecord {
  return {
    decisionId: DECISION_ID,
    clientId: '00000000-0000-4000-8000-0000000000c1',
    workspaceId: null,
    agencyId: '00000000-0000-4000-8000-0000000000a1',
    objective: 'Whether to roll the 5-touch onboarding sequence out to all new clients.',
    context: 'Q1 activation numbers are below target; the experiment concluded with a causal lift.',
    hypothesisSummary:
      'A 5-touch onboarding email sequence increases new-account activation versus the 3-touch sequence.',
    experimentRef: '00000000-0000-4000-8000-0000000000e2',
    evidenceRefs: ['00000000-0000-4000-8000-0000000000e1'],
    expectedImpact: {
      summary: 'New-account activation rate is expected to rise by roughly two points.',
      direction: 'increase',
      magnitude: '+18% relative CVR lift',
    },
    uncertainty: { kind: 'interval', lower: 0.012, upper: 0.041, level: 0.95 },
    expectedCost: 'One additional email send per new account (~$0.003/account).',
    alternatives: [
      'Keep the 3-touch sequence (status quo).',
      'Roll out only to standard-tier accounts first.',
    ],
    predecessorDecisionId: null,
    proposer: { actor: 'user:00000000-0000-4000-8000-000000000001', role: 'agency_owner' },
    disposition: 'accepted',
    successorDecisionId: null,
    dispositionAt: '2026-03-01T10:00:00.000Z',
    observedOutcome: null,
    executionRef: null,
    deploymentRef: null,
    learningRef: null,
    outcomeAt: null,
    idempotencyKey: 'decision-create-1',
    createFingerprint: 'dc1:abcdef12:997',
    provenance: {
      actor: 'user:00000000-0000-4000-8000-000000000001',
      recordedVia: 'api',
      correlationId: 'corr-0',
      causationId: null,
      recordedAt: '2026-02-28T10:00:00.000Z',
    },
  };
}

function validCarryInput(): SalesContinuityCarryInput {
  return { decisionId: DECISION_ID, goalId: null, idempotencyKey: 'carry-1' };
}

function validDeploymentCarryInput(): SalesContinuityDeploymentCarryInput {
  return {
    carryId: CARRY_ID,
    workspaceId: WORKSPACE_ID,
    workflowDefinitionIds: [DEFINITION_ID, DEFINITION_ID_2],
    idempotencyKey: 'carry-deploy-1',
  };
}

// ---------------------------------------------------------------------------
// The frozen taxonomies
// ---------------------------------------------------------------------------

test('the carry-state taxonomy is exactly the 3 frozen forward-only ladder values', () => {
  assert.deepEqual(SALES_CONTINUITY_CARRY_STATES, ['carrying', 'carried', 'deployed']);
  assert.ok(isKnownSalesContinuityCarryState('carrying'));
  assert.ok(isKnownSalesContinuityCarryState('carried'));
  assert.ok(isKnownSalesContinuityCarryState('deployed'));
  assert.ok(!isKnownSalesContinuityCarryState('failed'));
  assert.ok(!isKnownSalesContinuityCarryState(''));
});

test('the event-kind taxonomy is exactly the 3 frozen legs', () => {
  assert.deepEqual(SALES_CONTINUITY_EVENT_KINDS, [
    'carry-claimed',
    'playbook-carried',
    'deployment-carried',
  ]);
});

test('the carried-dimension taxonomy is exactly the 5 frozen §8 dimensions', () => {
  assert.deepEqual(SALES_CONTINUITY_CARRIED_DIMENSIONS, [
    'scope',
    'goals',
    'outcomes',
    'assumptions',
    'economics',
  ]);
});

test('the derivation version is the exported frozen constant', () => {
  assert.equal(SALES_CONTINUITY_DERIVATION_VERSION, 'sc-carry-v1');
});

// ---------------------------------------------------------------------------
// The carry payload derivation (the no-manual-re-entry + purity proofs)
// ---------------------------------------------------------------------------

test('deriveCarriedProposalStructure populates ALL FIVE §8 dimensions from the proposal record', () => {
  const decision = acceptedDecision();
  const snapshot = deriveCarriedProposalStructure(decision);

  assert.equal(snapshot.derivationVersion, SALES_CONTINUITY_DERIVATION_VERSION);
  // SOURCE: the canonical proposal id + the exact-content fingerprint
  // (the version identity — never a caller-supplied value).
  assert.deepEqual(snapshot.source, {
    kind: 'decision',
    decisionId: DECISION_ID,
    fingerprint: 'dc1:abcdef12:997',
    disposition: 'accepted',
  });
  // SCOPE: objective + context.
  assert.equal(snapshot.scope.objective, decision.objective);
  assert.equal(snapshot.scope.context, decision.context);
  // GOALS: objective + hypothesis + evidence + experiment link.
  assert.equal(snapshot.goals.objective, decision.objective);
  assert.equal(snapshot.goals.hypothesisSummary, decision.hypothesisSummary);
  assert.deepEqual(snapshot.goals.evidenceRefs, [...decision.evidenceRefs]);
  assert.equal(snapshot.goals.experimentRef, decision.experimentRef);
  // OUTCOMES: the structured expected impact + the declared uncertainty.
  assert.deepEqual(snapshot.outcomes.expectedImpact, decision.expectedImpact);
  assert.deepEqual(snapshot.outcomes.uncertainty, decision.uncertainty);
  // ASSUMPTIONS: hypothesis + alternatives + experiment link.
  assert.equal(snapshot.assumptions.hypothesisSummary, decision.hypothesisSummary);
  assert.deepEqual(snapshot.assumptions.alternatives, [...decision.alternatives]);
  assert.equal(snapshot.assumptions.experimentRef, decision.experimentRef);
  // ECONOMICS: expected cost + the impact summary.
  assert.equal(snapshot.economics.expectedCost, decision.expectedCost);
  assert.equal(snapshot.economics.expectedImpactSummary, decision.expectedImpact.summary);
});

test('deriveCarriedProposalStructure is PURE: identical inputs derive byte-identical snapshots', () => {
  const first = deriveCarriedProposalStructure(acceptedDecision());
  const second = deriveCarriedProposalStructure(acceptedDecision());
  assert.deepEqual(first, second);
});

test('deriveCarriedProposalStructure is snapshot-isolated: mutating the source arrays never leaks into the snapshot', () => {
  const decision = acceptedDecision();
  const snapshot = deriveCarriedProposalStructure(decision);
  const beforeEvidence = [...decision.evidenceRefs];
  const beforeAlternatives = [...decision.alternatives];
  (snapshot.goals.evidenceRefs as string[]).push('00000000-0000-4000-8000-0000000000e9');
  (snapshot.assumptions.alternatives as string[]).push('a smuggled alternative');
  assert.deepEqual([...decision.evidenceRefs], beforeEvidence);
  assert.deepEqual([...decision.alternatives], beforeAlternatives);
});

test('deriveCarriedProposalStructure nulls stay nulls (the fail-honest projection)', () => {
  const decision: DecisionRecord = {
    ...acceptedDecision(),
    context: null,
    experimentRef: null,
    uncertainty: null,
    expectedCost: null,
    alternatives: [],
  };
  const snapshot = deriveCarriedProposalStructure(decision);
  assert.equal(snapshot.scope.context, null);
  assert.equal(snapshot.goals.experimentRef, null);
  assert.equal(snapshot.outcomes.uncertainty, null);
  assert.equal(snapshot.assumptions.experimentRef, null);
  assert.equal(snapshot.economics.expectedCost, null);
  assert.deepEqual(snapshot.assumptions.alternatives, []);
});

// ---------------------------------------------------------------------------
// The playbook-input derivation (deterministic + bounded)
// ---------------------------------------------------------------------------

test('derivePlaybookInputs is deterministic and bounded to the playbook DTO bounds', () => {
  const first = derivePlaybookInputs(acceptedDecision());
  const second = derivePlaybookInputs(acceptedDecision());
  assert.deepEqual(first, second);
  assert.ok(first.name.length > 0 && first.name.length <= 200, 'name ≤ 200 (the playbook DTO bound)');
  assert.ok(first.description.length <= 2000, 'description ≤ 2000');
  assert.ok(first.name.startsWith('Proposal — '));
  // The strategy: exactly one template whose description IS the
  // proposal's expected-impact summary (the outcome expectation carried
  // as the first strategy/workflow template).
  assert.equal(first.strategy.templates.length, 1);
  assert.equal(first.strategy.templates[0]!.description, acceptedDecision().expectedImpact.summary.trim());
  assert.ok(first.strategy.summary.length > 0);
});

test('derivePlaybookInputs truncates deterministically on oversized proposal content', () => {
  const longObjective = 'x'.repeat(5000);
  const derived = derivePlaybookInputs({ ...acceptedDecision(), objective: longObjective });
  assert.equal(derived.name.length, 200);
  assert.ok(derived.description.length <= 2000);
  assert.ok(derived.strategy.summary.length <= 2000);
  assert.ok(derived.strategy.templates[0]!.name.length <= 200);
});

test('derivePlaybookInputs declares the minimal clean metadata: no packs/capabilities, the disclosed default runtime class + manual trigger', () => {
  const derived = derivePlaybookInputs(acceptedDecision());
  assert.deepEqual(derived.deploymentMetadata.requiredDomainPacks, []);
  assert.deepEqual(derived.deploymentMetadata.requiredCapabilities, []);
  // The DISCLOSED default compute allocation + the disclosed manual
  // trigger (part of the frozen sc-carry-v1 derivation rules — explicit
  // assumptions, never silent constants; the /deployments authority
  // pins a concrete class and at least one trigger).
  assert.equal(derived.deploymentMetadata.runtimeRequirements.runtimeClass, 'pooled-worker');
  // `config` is a required member of the /playbooks authority's closed
  // PlaybookTrigger shape (kind + config, null = none) — the derivation
  // must emit the full shape, not an abbreviated one.
  assert.deepEqual(derived.deploymentMetadata.triggers, [{ kind: 'manual', config: null }]);
});

// ---------------------------------------------------------------------------
// The §8 carry fingerprint
// ---------------------------------------------------------------------------

test('the carry fingerprint is deterministic and payload-sensitive on every caller-visible dimension', () => {
  const base = fingerprintSalesContinuityCreate(validCarryInput());
  assert.equal(base, fingerprintSalesContinuityCreate(validCarryInput()));
  // Sensitive to the decision anchor.
  assert.notEqual(
    base,
    fingerprintSalesContinuityCreate({ ...validCarryInput(), decisionId: DEFINITION_ID }),
  );
  // Sensitive to the goal link.
  assert.notEqual(
    base,
    fingerprintSalesContinuityCreate({ ...validCarryInput(), goalId: GOAL_ID }),
  );
  // INDEPENDENT of the idempotency key (one key + one payload
  // identifies one logical command).
  assert.equal(
    base,
    fingerprintSalesContinuityCreate({ ...validCarryInput(), idempotencyKey: 'another-key' }),
  );
});

// ---------------------------------------------------------------------------
// The input + provenance guards
// ---------------------------------------------------------------------------

test('the carry-input guard fails closed on non-canonical ids and bad keys', () => {
  assertValidSalesContinuityCarryInput(validCarryInput());
  assertValidSalesContinuityCarryInput({ ...validCarryInput(), goalId: GOAL_ID });
  assert.throws(() =>
    assertValidSalesContinuityCarryInput({ ...validCarryInput(), decisionId: 'not-a-uuid' }),
  );
  assert.throws(() =>
    assertValidSalesContinuityCarryInput({ ...validCarryInput(), goalId: 'not-a-uuid' }),
  );
  assert.throws(() =>
    assertValidSalesContinuityCarryInput({ ...validCarryInput(), idempotencyKey: '' }),
  );
  assert.throws(() =>
    assertValidSalesContinuityCarryInput({
      ...validCarryInput(),
      idempotencyKey: 'x'.repeat(201),
    }),
  );
});

test('the deployment-carry-input guard fails closed on bad shapes', () => {
  assertValidSalesContinuityDeploymentCarryInput(validDeploymentCarryInput());
  // Non-canonical ids.
  assert.throws(() =>
    assertValidSalesContinuityDeploymentCarryInput({
      ...validDeploymentCarryInput(),
      carryId: 'nope',
    }),
  );
  assert.throws(() =>
    assertValidSalesContinuityDeploymentCarryInput({
      ...validDeploymentCarryInput(),
      workspaceId: 'nope',
    }),
  );
  // Empty or non-array workflow definition lists.
  assert.throws(() =>
    assertValidSalesContinuityDeploymentCarryInput({
      ...validDeploymentCarryInput(),
      workflowDefinitionIds: [],
    }),
  );
  assert.throws(() =>
    assertValidSalesContinuityDeploymentCarryInput({
      ...validDeploymentCarryInput(),
      workflowDefinitionIds: ['nope'] as unknown as readonly string[],
    }),
  );
  // Oversized lists.
  assert.throws(() =>
    assertValidSalesContinuityDeploymentCarryInput({
      ...validDeploymentCarryInput(),
      workflowDefinitionIds: Array.from({ length: 51 }, () => DEFINITION_ID),
    }),
  );
  // Bad keys.
  assert.throws(() =>
    assertValidSalesContinuityDeploymentCarryInput({
      ...validDeploymentCarryInput(),
      idempotencyKey: '',
    }),
  );
});

test('the provenance guard fails closed on incomplete server-derived values', () => {
  assertValidSalesContinuityProvenance(VALID_PROVENANCE);
  assert.throws(() =>
    assertValidSalesContinuityProvenance({ ...VALID_PROVENANCE, actor: '' }),
  );
  assert.throws(() =>
    assertValidSalesContinuityProvenance({ ...VALID_PROVENANCE, recordedVia: '' }),
  );
  assert.throws(() =>
    assertValidSalesContinuityProvenance({ ...VALID_PROVENANCE, correlationId: '' }),
  );
  assert.throws(() =>
    assertValidSalesContinuityProvenance({ ...VALID_PROVENANCE, causationId: '' }),
  );
});

// ---------------------------------------------------------------------------
// The DB conflict classification
// ---------------------------------------------------------------------------

test('classifySalesContinuityWriteConflict converges the migration 040 fences into their domain classes', () => {
  assert.equal(
    classifySalesContinuityWriteConflict(
      new Error('duplicate key value violates unique constraint "sales_continuity_carries_source_decision_id_key"'),
    ),
    'source-fence',
  );
  assert.equal(
    classifySalesContinuityWriteConflict(
      new Error('duplicate key value violates unique constraint "sales_continuity_carries_idempotency_key_unique"'),
    ),
    'idempotency-fence',
  );
  assert.equal(
    classifySalesContinuityWriteConflict(
      new Error('carry completion is forward-only: carrying → carried requires the playbook references together (carry X)'),
    ),
    'forward-completion',
  );
  assert.equal(
    classifySalesContinuityWriteConflict(
      new Error('carry X source decision Y does not belong to client Z — the proposal reference cannot cross the Client boundary'),
    ),
    'reference-fence',
  );
  assert.equal(classifySalesContinuityWriteConflict(new Error('unrelated')), null);
  assert.equal(classifySalesContinuityWriteConflict('not an error'), null);
});
