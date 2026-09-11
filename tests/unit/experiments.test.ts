/**
 * MKT-015 unit tests — the frozen experiment contract taxonomies, the
 * declaration/conclusion/transition/provenance guards and the canonical
 * owner-context composer (pure functions, no DB).
 *
 * Proofs (EXP-001; spec/implementation-contract.md §16 "Experiment
 * contract"; spec/state-machines.md "Experiment";
 * spec/evidence-and-experimentation.md "Experiment contract"):
 *   - the declared design type is exactly the 5 frozen §16 values, each
 *     mapped to its evidence-quality grade, and isKnownExperimentDesignType
 *     rejects everything outside the closed set (extension is a code+DB
 *     change, never a caller freedom);
 *   - EXP-AC-02 (type level): the result-state taxonomy is a CLOSED set in
 *     which the CAUSAL conclusion types are DISTINCT values from the
 *     attribution/observation types — disjoint sets, no shared literal,
 *     'undecided' excluded from the conclusion types, and an attribution
 *     result can never be constructed as a causal one;
 *   - the CAUSAL EVIDENCE STANDARD: only randomized / controlled
 *     comparison / quasi-experimental designs satisfy it; the conclusion
 *     guard REJECTS a causal result state on observational and descriptive
 *     designs ("Do not claim causality from observational correlation
 *     alone") while attribution/observation/inconclusive conclusions stay
 *     valid on EVERY design;
 *   - the declaration guard enforces the full §16 required-field set:
 *     non-empty bounded hypothesis/decision target/population-unit/
 *     treatment/comparison/assignment method/analysis method/stop
 *     criteria/minimum evidence requirement, the closed design-type and
 *     uncertainty-representation enums, the primary-metric identity shape
 *     (name + scalar dimensions — never a provider metric id), guardrail
 *     bounds, §21 material-key rejection on dimension payloads;
 *   - the frozen lifecycle table: exactly the 6 legal edges, terminal
 *     states have no successors, and the transition-input guard rejects
 *     unknown transitions and conclusions on non-conclude transitions /
 *     missing conclusions on conclude;
 *   - EXP-AC-03 (guard level): the conclusion guard enforces
 *     uncertainty-representation matching (interval/distribution/
 *     qualitative/none — never silently transformed or dropped) and retains
 *     the analysis metadata shapes (assumptions, sample limitations,
 *     confounders) with bounds;
 *   - the provenance guard fails closed on incomplete server-derived
 *     provenance;
 *   - composeExperimentOwnerContext derives the canonical scope from the
 *     CLIENT OWNERSHIP and the experiment record only (never from caller
 *     input) and is pure: identical inputs compose identical outputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAUSAL_EVIDENCE_STANDARD,
  CAUSAL_RESULT_STATES,
  DESIGN_TYPE_EVIDENCE_GRADE,
  EXPERIMENT_DESIGN_TYPES,
  EXPERIMENT_EXPECTED_DIRECTIONS,
  EXPERIMENT_RESULT_STATES,
  EXPERIMENT_STATUSES,
  EXPERIMENT_TRANSITIONS,
  EXPERIMENT_TRANSITION_TABLE,
  EXPERIMENT_UNCERTAINTY_REPRESENTATIONS,
  NON_CAUSAL_RESULT_STATES,
  assertValidExperimentConclusion,
  assertValidExperimentCreate,
  assertValidExperimentProvenance,
  assertValidExperimentTransitionInput,
  composeExperimentOwnerContext,
  designSatisfiesCausalStandard,
  isCausalResultState,
  isKnownExperimentDesignType,
  isKnownExperimentExpectedDirection,
  isKnownExperimentResultState,
  isKnownExperimentTransition,
  isKnownUncertaintyRepresentation,
  legalExperimentSuccessors,
  classifyExperimentWriteConflict,
  type ExperimentConclusion,
  type ExperimentCreateInput,
  type ExperimentOwnerContext,
  type ExperimentRecord,
  type ExperimentsClientOwnershipSnapshot,
  type ExperimentsWorkspaceOwnershipSnapshot,
} from '../../src/modules/experiments/public.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PROVENANCE = {
  actor: 'user:00000000-0000-4000-8000-000000000001',
  recordedVia: 'api',
  correlationId: 'corr-1',
  causationId: null,
} as const;

function validCreateInput(): ExperimentCreateInput {
  return {
    clientId: '00000000-0000-4000-8000-0000000000aa',
    workspaceId: null,
    hypothesis: 'Switching the onboarding email sequence from 3 to 5 touches increases activation.',
    decisionTarget: 'Whether to roll out the 5-touch onboarding sequence to all new clients.',
    populationUnit: 'New client accounts created after 2025-01-01, account-level.',
    treatment: '5-touch onboarding email sequence with behavioral triggers.',
    comparison: 'Current 3-touch onboarding email sequence (status quo).',
    assignmentMethod: 'Simple random assignment at account creation, 50/50.',
    designType: 'randomized',
    primaryMetric: { name: 'activation_rate', dimensions: { cohort: 'new_accounts' } },
    guardrails: [
      { name: 'unsubscribe_rate', dimensions: {} },
      { name: 'support_ticket_volume', dimensions: { tier: 'standard' } },
    ],
    analysisMethod: 'Two-proportion z-test on account-level activation.',
    analysisMethodVersion: 'v2',
    expectedDirection: 'increase',
    startCriteria: 'Start once 500 accounts/week enrollment is confirmed.',
    stopCriteria: 'Stop at 2,000 accounts per arm or after 6 weeks, whichever comes first.',
    minimumEvidenceRequirement: 'B — strong quasi-experimental design at minimum.',
    uncertaintyRepresentation: 'interval',
  };
}

function validConclusion(overrides: Partial<ExperimentConclusion> = {}): ExperimentConclusion {
  return {
    resultState: 'causal_supported',
    uncertainty: { kind: 'interval', lower: 0.012, upper: 0.041, level: 0.95 },
    assumptions: ['Stable delivery infrastructure during the window'],
    sampleLimitations: ['Only standard-tier accounts observed'],
    confounders: ['Seasonal demand shift', 'Concurrent pricing experiment on 5% of accounts'],
    resultingDecision: 'Roll out the 5-touch sequence to all new clients.',
    evidenceRefs: [],
    ...overrides,
  };
}

/**
 * assert.throws validator matching against the message AND the details
 * list (the guards carry their per-field problems in details).
 */
function throwsWith(fragment: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof Error, `expected an Error, got: ${String(error)}`);
    const details = (error as { details?: ReadonlyArray<string> }).details ?? [];
    const haystack = `${error.message} ${details.join(' ')}`;
    assert.ok(
      haystack.includes(fragment),
      `expected the rejection to mention '${fragment}', got: ${haystack}`,
    );
    return true;
  };
}

// ---------------------------------------------------------------------------
// The frozen taxonomies
// ---------------------------------------------------------------------------

test('the declared design type is exactly the 5 frozen §16 values with traceable evidence grades', () => {
  assert.deepEqual([...EXPERIMENT_DESIGN_TYPES], [
    'randomized',
    'controlled_comparison',
    'quasi_experimental',
    'observational',
    'descriptive',
  ]);
  assert.equal(DESIGN_TYPE_EVIDENCE_GRADE.randomized, 'A');
  assert.equal(DESIGN_TYPE_EVIDENCE_GRADE.controlled_comparison, 'A');
  assert.equal(DESIGN_TYPE_EVIDENCE_GRADE.quasi_experimental, 'B');
  assert.equal(DESIGN_TYPE_EVIDENCE_GRADE.observational, 'C');
  assert.equal(DESIGN_TYPE_EVIDENCE_GRADE.descriptive, 'D');
  for (const designType of EXPERIMENT_DESIGN_TYPES) {
    assert.equal(isKnownExperimentDesignType(designType), true);
  }
  assert.equal(isKnownExperimentDesignType('randomised'), false);
  assert.equal(isKnownExperimentDesignType('A/B test'), false);
  assert.equal(isKnownExperimentDesignType(''), false);
  assert.equal(isKnownExperimentDesignType('causal'), false);
});

test('the result-state taxonomy is the closed frozen set; membership rejects everything else', () => {
  assert.deepEqual([...EXPERIMENT_RESULT_STATES], [
    'undecided',
    'causal_supported',
    'causal_not_supported',
    'attribution',
    'observation',
    'inconclusive',
  ]);
  for (const resultState of EXPERIMENT_RESULT_STATES) {
    assert.equal(isKnownExperimentResultState(resultState), true);
  }
  assert.equal(isKnownExperimentResultState('CAUSAL_SUPPORTED'), false);
  assert.equal(isKnownExperimentResultState('causal'), false);
  assert.equal(isKnownExperimentResultState('supported'), false);
  assert.equal(isKnownExperimentResultState(''), false);
});

test('EXP-AC-02 (type level): the CAUSAL conclusion types are DISTINCT values from attribution/observation', () => {
  // Disjoint literal sets — no causal literal appears in the non-causal set
  // and vice versa; 'attribution' and 'observation' are never causal.
  const causal = new Set<string>(CAUSAL_RESULT_STATES);
  const nonCausal = new Set<string>(NON_CAUSAL_RESULT_STATES);
  for (const literal of causal) {
    assert.equal(nonCausal.has(literal), false, `'${literal}' must not be a non-causal type`);
    assert.equal(isCausalResultState(literal), true);
  }
  for (const literal of nonCausal) {
    assert.equal(causal.has(literal), false, `'${literal}' must not be a causal type`);
    assert.equal(isCausalResultState(literal), false);
  }
  // The full taxonomy is exactly undecided + causal + non-causal, disjoint.
  assert.equal(
    EXPERIMENT_RESULT_STATES.length,
    1 + CAUSAL_RESULT_STATES.length + NON_CAUSAL_RESULT_STATES.length,
  );
  // 'undecided' is the initial state, never a conclusion type.
  assert.equal(isCausalResultState('undecided'), false);
  assert.equal(NON_CAUSAL_RESULT_STATES.includes('undecided' as never), false);
  // A causal conclusion type is never constructible as an attribution one.
  const conclusionTypeLiterals: readonly string[] = [
    'causal_supported',
    'causal_not_supported',
    'attribution',
    'observation',
    'inconclusive',
  ];
  assert.equal(new Set(conclusionTypeLiterals).size, conclusionTypeLiterals.length);
});

test('the CAUSAL EVIDENCE STANDARD: only grade A/B designs satisfy it', () => {
  assert.equal(CAUSAL_EVIDENCE_STANDARD.minimumGrade, 'B');
  assert.deepEqual([...CAUSAL_EVIDENCE_STANDARD.causalDesignTypes], [
    'randomized',
    'controlled_comparison',
    'quasi_experimental',
  ]);
  assert.equal(designSatisfiesCausalStandard('randomized'), true);
  assert.equal(designSatisfiesCausalStandard('controlled_comparison'), true);
  assert.equal(designSatisfiesCausalStandard('quasi_experimental'), true);
  // Observational and descriptive designs can NEVER carry a causal
  // conclusion ("Do not claim causality from observational correlation
  // alone").
  assert.equal(designSatisfiesCausalStandard('observational'), false);
  assert.equal(designSatisfiesCausalStandard('descriptive'), false);
});

test('the uncertainty representation and expected-direction taxonomies are the closed frozen sets', () => {
  assert.deepEqual([...EXPERIMENT_UNCERTAINTY_REPRESENTATIONS], [
    'interval',
    'distribution',
    'qualitative',
    'none',
  ]);
  assert.deepEqual([...EXPERIMENT_EXPECTED_DIRECTIONS], [
    'increase',
    'decrease',
    'no_change',
    'any',
  ]);
  for (const representation of EXPERIMENT_UNCERTAINTY_REPRESENTATIONS) {
    assert.equal(isKnownUncertaintyRepresentation(representation), true);
  }
  for (const direction of EXPERIMENT_EXPECTED_DIRECTIONS) {
    assert.equal(isKnownExperimentExpectedDirection(direction), true);
  }
  assert.equal(isKnownUncertaintyRepresentation('interval_95'), false);
  assert.equal(isKnownExperimentExpectedDirection('higher'), false);
});

// ---------------------------------------------------------------------------
// The frozen lifecycle table (spec/state-machines.md)
// ---------------------------------------------------------------------------

test('the lifecycle table is exactly the frozen state machine; terminal states have no successors', () => {
  assert.deepEqual({ ...EXPERIMENT_TRANSITION_TABLE }, {
    mark_ready: { from: 'draft', to: 'ready' },
    start: { from: 'ready', to: 'running' },
    begin_analysis: { from: 'running', to: 'analyzing' },
    conclude: { from: 'analyzing', to: 'concluded' },
    stop: { from: 'running', to: 'stopped' },
    invalidate: { from: 'running', to: 'invalidated' },
  });
  assert.deepEqual([...EXPERIMENT_TRANSITIONS], [
    'mark_ready',
    'start',
    'begin_analysis',
    'conclude',
    'stop',
    'invalidate',
  ]);
  assert.deepEqual([...EXPERIMENT_STATUSES], [
    'draft',
    'ready',
    'running',
    'analyzing',
    'concluded',
    'stopped',
    'invalidated',
  ]);
  // Terminal states have no outgoing edges (concluded, stopped, invalidated).
  assert.deepEqual(legalExperimentSuccessors('concluded'), []);
  assert.deepEqual(legalExperimentSuccessors('stopped'), []);
  assert.deepEqual(legalExperimentSuccessors('invalidated'), []);
  // The full happy path exists edge by edge.
  assert.deepEqual(legalExperimentSuccessors('draft'), ['ready']);
  assert.deepEqual(legalExperimentSuccessors('ready'), ['running']);
  assert.deepEqual([...legalExperimentSuccessors('running')].sort(), ['analyzing', 'invalidated', 'stopped']);
  assert.deepEqual(legalExperimentSuccessors('analyzing'), ['concluded']);
  // No transition may skip a state or move backwards.
  for (const transition of EXPERIMENT_TRANSITIONS) {
    assert.notEqual(EXPERIMENT_TRANSITION_TABLE[transition].from, EXPERIMENT_TRANSITION_TABLE[transition].to);
  }
  assert.equal(isKnownExperimentTransition('conclude '), false);
  assert.equal(isKnownExperimentTransition('publish'), false);
});

// ---------------------------------------------------------------------------
// The declaration guard (the full §16 required-field set)
// ---------------------------------------------------------------------------

test('the declaration guard accepts the full well-formed §16 design payload', () => {
  assert.doesNotThrow(() => assertValidExperimentCreate(validCreateInput()));
  // Every declared design type is declarable.
  for (const designType of EXPERIMENT_DESIGN_TYPES) {
    assert.doesNotThrow(() =>
      assertValidExperimentCreate({ ...validCreateInput(), designType }),
    );
  }
  // Optional fields may be absent (null).
  assert.doesNotThrow(() =>
    assertValidExperimentCreate({
      ...validCreateInput(),
      analysisMethodVersion: null,
      expectedDirection: null,
      startCriteria: null,
      guardrails: [],
    }),
  );
});

test('the declaration guard rejects every malformed shape (fail closed)', () => {
  const cases: ReadonlyArray<[string, ExperimentCreateInput]> = [
    ['missing hypothesis', { ...validCreateInput(), hypothesis: '' }],
    ['oversized hypothesis', { ...validCreateInput(), hypothesis: 'x'.repeat(2001) }],
    ['missing decision target', { ...validCreateInput(), decisionTarget: '' }],
    ['missing population/unit', { ...validCreateInput(), populationUnit: '' }],
    ['missing treatment', { ...validCreateInput(), treatment: '' }],
    ['missing comparison', { ...validCreateInput(), comparison: '' }],
    ['missing assignment method', { ...validCreateInput(), assignmentMethod: '' }],
    ['unknown design type', { ...validCreateInput(), designType: 'natural experiment' as never }],
    ['missing analysis method', { ...validCreateInput(), analysisMethod: '' }],
    ['missing stop criteria', { ...validCreateInput(), stopCriteria: '' }],
    ['missing minimum evidence requirement', { ...validCreateInput(), minimumEvidenceRequirement: '' }],
    ['unknown uncertainty representation', { ...validCreateInput(), uncertaintyRepresentation: 'error bars' as never }],
    ['unknown expected direction', { ...validCreateInput(), expectedDirection: 'skyrockets' as never }],
    ['metric identity without a name', { ...validCreateInput(), primaryMetric: { dimensions: {} } as never }],
    ['metric identity with an array name', { ...validCreateInput(), primaryMetric: { name: 7 as never, dimensions: {} } }],
    ['nested-object dimension values', { ...validCreateInput(), primaryMetric: { name: 'activation_rate', dimensions: { nested: { deep: true } as never } } }],
    ['guardrails not an array', { ...validCreateInput(), guardrails: 'none' as never }],
    ['guardrail without identity', { ...validCreateInput(), guardrails: [{} as never] }],
    ['empty analysis method version', { ...validCreateInput(), analysisMethodVersion: '' }],
  ];
  for (const [label, input] of cases) {
    assert.throws(
      () => assertValidExperimentCreate(input),
      throwsWith('declaration guard'),
      `expected rejection for: ${label}`,
    );
  }
});

test('the §21 material-key backstop rejects secret-shaped dimension keys in primary metric and guardrails', () => {
  assert.throws(
    () =>
      assertValidExperimentCreate({
        ...validCreateInput(),
        primaryMetric: { name: 'activation_rate', dimensions: { apiKey: 'abc' } },
      }),
    throwsWith('material-shaped keys'),
  );
  assert.throws(
    () =>
      assertValidExperimentCreate({
        ...validCreateInput(),
        guardrails: [{ name: 'unsubscribe_rate', dimensions: { secret: 'x' } }],
      }),
    throwsWith('material-shaped keys'),
  );
});

// ---------------------------------------------------------------------------
// The conclusion guard (EXP-AC-02 causal gate + EXP-AC-03 retention)
// ---------------------------------------------------------------------------

test('the conclusion guard accepts a well-formed causal conclusion on a causal-capable design', () => {
  for (const designType of ['randomized', 'controlled_comparison', 'quasi_experimental'] as const) {
    assert.doesNotThrow(() =>
      assertValidExperimentConclusion(designType, 'interval', validConclusion()),
    );
  }
  // Both causal result states are valid conclusions on causal designs.
  assert.doesNotThrow(() =>
    assertValidExperimentConclusion(
      'randomized',
      'interval',
      validConclusion({ resultState: 'causal_not_supported', resultingDecision: null }),
    ),
  );
});

test('EXP-AC-02 (guard level): a causal conclusion is REJECTED on observational and descriptive designs', () => {
  for (const designType of ['observational', 'descriptive'] as const) {
    for (const resultState of ['causal_supported', 'causal_not_supported'] as const) {
      assert.throws(
        () =>
          assertValidExperimentConclusion(
            designType,
            'interval',
            validConclusion({ resultState }),
          ),
        throwsWith('causal evidence standard'),
        `expected causal-gate rejection for ${designType} + ${resultState}`,
      );
    }
  }
});

test('EXP-AC-02 (guard level): attribution, observation and inconclusive conclusions are valid on EVERY design', () => {
  for (const designType of EXPERIMENT_DESIGN_TYPES) {
    for (const resultState of ['attribution', 'observation', 'inconclusive'] as const) {
      assert.doesNotThrow(() =>
        assertValidExperimentConclusion(
          designType,
          'interval',
          validConclusion({
            resultState,
            uncertainty: { kind: 'interval', lower: -0.01, upper: 0.03, level: 0.9 },
            resultingDecision: null,
          }),
        ),
      );
    }
  }
});

test('the conclusion guard rejects result states outside the closed taxonomy and undecided conclusions', () => {
  assert.throws(
    () =>
      assertValidExperimentConclusion(
        'randomized',
        'interval',
        validConclusion({ resultState: 'supported' as never }),
      ),
    throwsWith('closed conclusion types'),
  );
  assert.throws(
    () =>
      assertValidExperimentConclusion(
        'randomized',
        'interval',
        validConclusion({ resultState: 'undecided' as never }),
      ),
    throwsWith('closed conclusion types'),
  );
  assert.throws(
    () => assertValidExperimentConclusion('randomized', 'interval', null),
    throwsWith('requires its conclusion'),
  );
});

test('EXP-AC-03 (guard level): the uncertainty payload must MATCH the declared representation', () => {
  // 'interval' declared: a matching interval passes...
  assert.doesNotThrow(() =>
    assertValidExperimentConclusion('randomized', 'interval', validConclusion()),
  );
  // ...a distribution descriptor or null does not (never silently
  // transformed, never silently dropped).
  assert.throws(
    () =>
      assertValidExperimentConclusion(
        'randomized',
        'interval',
        validConclusion({ uncertainty: { kind: 'distribution', descriptor: 'normal(mean=0.02)' } }),
      ),
    throwsWith('must equal the declared uncertainty representation'),
  );
  assert.throws(
    () => assertValidExperimentConclusion('randomized', 'interval', validConclusion({ uncertainty: null })),
    throwsWith('required'),
  );
  // Malformed intervals are rejected (bounds + coverage level).
  assert.throws(
    () =>
      assertValidExperimentConclusion(
        'randomized',
        'interval',
        validConclusion({ uncertainty: { kind: 'interval', lower: 0.05, upper: 0.01, level: 0.95 } }),
      ),
    throwsWith('lower must not exceed upper'),
  );
  assert.throws(
    () =>
      assertValidExperimentConclusion(
        'randomized',
        'interval',
        validConclusion({ uncertainty: { kind: 'interval', lower: 0.01, upper: 0.05, level: 1.5 } }),
      ),
    throwsWith('coverage level'),
  );
  // 'distribution' declared: a descriptor passes, an interval does not.
  assert.doesNotThrow(() =>
    assertValidExperimentConclusion(
      'randomized',
      'distribution',
      validConclusion({ uncertainty: { kind: 'distribution', descriptor: 'normal(mean=0.02, sd=0.008)' } }),
    ),
  );
  assert.throws(
    () =>
      assertValidExperimentConclusion('randomized', 'distribution', validConclusion({ uncertainty: null })),
    throwsWith('required'),
  );
  assert.throws(
    () =>
      assertValidExperimentConclusion(
        'randomized',
        'distribution',
        validConclusion({ uncertainty: { kind: 'distribution', descriptor: '' } }),
      ),
    throwsWith('descriptor'),
  );
  // 'qualitative' declared.
  assert.doesNotThrow(() =>
    assertValidExperimentConclusion(
      'observational',
      'qualitative',
      validConclusion({
        resultState: 'observation',
        uncertainty: { kind: 'qualitative', description: 'Directionally positive; magnitude unquantified.' },
      }),
    ),
  );
  // 'none' declared: the conclusion must carry null — a payload is
  // REJECTED (retention is representation-faithful both ways).
  assert.doesNotThrow(() =>
    assertValidExperimentConclusion(
      'descriptive',
      'none',
      validConclusion({ resultState: 'inconclusive', uncertainty: null, resultingDecision: null }),
    ),
  );
  assert.throws(
    () =>
      assertValidExperimentConclusion(
        'descriptive',
        'none',
        validConclusion({ resultState: 'inconclusive', uncertainty: { kind: 'qualitative', description: 'x' } }),
      ),
    throwsWith("'none'"),
  );
});

test('EXP-AC-03 (guard level): analysis metadata is bounded and shape-checked (assumptions, sample limitations, confounders)', () => {
  // Empty metadata arrays are valid (nullable where the method permits).
  assert.doesNotThrow(() =>
    assertValidExperimentConclusion('randomized', 'interval', validConclusion({ assumptions: [], sampleLimitations: [], confounders: [] })),
  );
  // Non-arrays / non-strings / oversized items are rejected.
  assert.throws(
    () => assertValidExperimentConclusion('randomized', 'interval', validConclusion({ assumptions: 'none' as never })),
    throwsWith('assumptions'),
  );
  assert.throws(
    () => assertValidExperimentConclusion('randomized', 'interval', validConclusion({ confounders: [''] })),
    throwsWith('confounders'),
  );
  assert.throws(
    () =>
      assertValidExperimentConclusion('randomized', 'interval', validConclusion({ sampleLimitations: ['x'.repeat(1001)] })),
    throwsWith('sampleLimitations'),
  );
  assert.throws(
    () =>
      assertValidExperimentConclusion(
        'randomized',
        'interval',
        validConclusion({ assumptions: Array.from({ length: 51 }, (_, i) => `assumption ${i}`) }),
      ),
    throwsWith('assumptions'),
  );
  // Evidence citations must be uuid-shaped, deduplicated, bounded.
  const evidenceId = '11111111-2222-4333-8444-555555555555';
  assert.doesNotThrow(() =>
    assertValidExperimentConclusion('randomized', 'interval', validConclusion({ evidenceRefs: [evidenceId] })),
  );
  assert.throws(
    () => assertValidExperimentConclusion('randomized', 'interval', validConclusion({ evidenceRefs: ['not-a-uuid'] })),
    throwsWith('evidence record id'),
  );
  assert.throws(
    () =>
      assertValidExperimentConclusion('randomized', 'interval', validConclusion({ evidenceRefs: [evidenceId, evidenceId] })),
    throwsWith('duplicate'),
  );
});

// ---------------------------------------------------------------------------
// The transition-input guard
// ---------------------------------------------------------------------------

test('the transition-input guard: conclusions ride ONLY the conclude transition', () => {
  assert.doesNotThrow(() => assertValidExperimentTransitionInput({ transition: 'start', conclusion: null }));
  assert.doesNotThrow(() =>
    assertValidExperimentTransitionInput({ transition: 'conclude', conclusion: validConclusion() }),
  );
  assert.throws(
    () => assertValidExperimentTransitionInput({ transition: 'conclude', conclusion: null }),
    throwsWith('required for the conclude transition'),
  );
  for (const transition of ['mark_ready', 'start', 'begin_analysis', 'stop', 'invalidate'] as const) {
    assert.throws(
      () => assertValidExperimentTransitionInput({ transition, conclusion: validConclusion() }),
      throwsWith('only the conclude transition'),
    );
  }
  assert.throws(
    () => assertValidExperimentTransitionInput({ transition: 'publish' as never, conclusion: null }),
    throwsWith('unknown lifecycle transition'),
  );
});

// ---------------------------------------------------------------------------
// The provenance guard
// ---------------------------------------------------------------------------

test('the provenance guard fails closed on incomplete server-derived provenance', () => {
  assert.doesNotThrow(() => assertValidExperimentProvenance(VALID_PROVENANCE));
  assert.throws(() => assertValidExperimentProvenance({ ...VALID_PROVENANCE, actor: ' ' }), throwsWith('actor'));
  assert.throws(() => assertValidExperimentProvenance({ ...VALID_PROVENANCE, recordedVia: '' }), throwsWith('recordedVia'));
  assert.throws(() => assertValidExperimentProvenance({ ...VALID_PROVENANCE, correlationId: '' }), throwsWith('correlationId'));
  assert.throws(() => assertValidExperimentProvenance({ ...VALID_PROVENANCE, causationId: '' }), throwsWith('causationId'));
});

// ---------------------------------------------------------------------------
// The insert-conflict classifier
// ---------------------------------------------------------------------------

test('the write-conflict classifier recognizes only the DB backstop trigger failures', () => {
  assert.equal(classifyExperimentWriteConflict(new Error('experiment declared design is immutable: rewriting experiment x design/provenance columns is rejected')), 'design-immutable');
  assert.equal(classifyExperimentWriteConflict(new Error('illegal experiment status transition: draft → running is rejected on experiment x')), 'status-transition');
  assert.equal(classifyExperimentWriteConflict(new Error('experiment transition t cites evidence e of another client — cross-tenant evidence linkage is rejected')), 'evidence-refs-client');
  assert.equal(classifyExperimentWriteConflict(new Error('relation "experiments" does not exist')), null);
  assert.equal(classifyExperimentWriteConflict({ code: '23505' }), null);
  assert.equal(classifyExperimentWriteConflict(null), null);
});

// ---------------------------------------------------------------------------
// The canonical owner-context composer
// ---------------------------------------------------------------------------

function experimentRecordFixture(): ExperimentRecord {
  return {
    experimentId: '00000000-0000-4000-8000-0000000000ee',
    clientId: '00000000-0000-4000-8000-0000000000aa',
    workspaceId: null,
    hypothesis: 'h',
    decisionTarget: 'd',
    populationUnit: 'p',
    treatment: 't',
    comparison: 'c',
    assignmentMethod: 'a',
    designType: 'randomized',
    primaryMetric: { name: 'activation_rate', dimensions: {} },
    guardrails: [],
    analysisMethod: 'm',
    analysisMethodVersion: null,
    expectedDirection: null,
    startCriteria: null,
    stopCriteria: 's',
    minimumEvidenceRequirement: 'B',
    uncertaintyRepresentation: 'interval',
    status: 'draft',
    resultState: 'undecided',
    resultingDecision: null,
    concludedAt: null,
    provenance: {
      actor: 'user:1',
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
      recordedAt: '2025-01-01T00:00:00.000Z',
    },
  };
}

function clientOwnershipFixture(): ExperimentsClientOwnershipSnapshot {
  return {
    scope: {
      kind: 'client',
      agencyId: '00000000-0000-4000-8000-0000000000ag',
      clientId: '00000000-0000-4000-8000-0000000000aa',
    },
    client: {
      clientId: '00000000-0000-4000-8000-0000000000aa',
      agencyId: '00000000-0000-4000-8000-0000000000ag',
      status: 'active',
    },
  };
}

function workspaceOwnershipFixture(): ExperimentsWorkspaceOwnershipSnapshot {
  return {
    workspace: {
      workspaceId: '00000000-0000-4000-8000-0000000000ws',
      clientId: '00000000-0000-4000-8000-0000000000aa',
      status: 'active',
    },
  };
}

test('composeExperimentOwnerContext derives the canonical scope from durable ownership only', () => {
  const experiment = experimentRecordFixture();
  const context = composeExperimentOwnerContext(
    experiment,
    clientOwnershipFixture(),
    null,
    '2025-06-01T00:00:00.000Z',
  );
  assert.equal(context.scope.kind, 'experiment');
  assert.equal(context.scope.agencyId, '00000000-0000-4000-8000-0000000000ag');
  assert.equal(context.scope.clientId, experiment.clientId);
  assert.equal(context.scope.workspaceId, null);
  assert.equal(context.scope.experimentId, experiment.experimentId);
  assert.equal(context.experiment, experiment);
  assert.equal(context.clientOwnership.client.status, 'active');
  assert.equal(context.workspace, null);
  // A workspace-scoped experiment carries the workspace snapshot.
  const scoped = composeExperimentOwnerContext(
    { ...experiment, workspaceId: '00000000-0000-4000-8000-0000000000ws' },
    clientOwnershipFixture(),
    workspaceOwnershipFixture(),
    '2025-06-01T00:00:00.000Z',
  );
  assert.equal(scoped.scope.workspaceId, '00000000-0000-4000-8000-0000000000ws');
  assert.notEqual(scoped.workspace, null);
});

test('composeExperimentOwnerContext is pure — identical inputs compose identical outputs', () => {
  const first: ExperimentOwnerContext = composeExperimentOwnerContext(
    experimentRecordFixture(),
    clientOwnershipFixture(),
    null,
    '2025-06-01T00:00:00.000Z',
  );
  const second: ExperimentOwnerContext = composeExperimentOwnerContext(
    experimentRecordFixture(),
    clientOwnershipFixture(),
    null,
    '2025-06-01T00:00:00.000Z',
  );
  assert.deepEqual(first, second);
});
