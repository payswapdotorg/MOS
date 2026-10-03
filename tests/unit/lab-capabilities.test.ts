/**
 * LAB-013 unit tests — the PURE contract guards of /lab-capabilities:
 * the frozen vocabularies (the §17 actor split, the stage lifecycles,
 * the closed verdict/origin/kind vocabularies), the one-level schema
 * subset (the LAB-011 message-contract discipline), the §16 declared
 * field fences (the quality-evaluator declaration, cost, latency,
 * implementation, requirements, constraints), the §17 stage payload
 * fences (the strategy citation, the required action, the requested/
 * granted rights, the human-plane citation, the real-test citation),
 * the run-time value enforcement, the opaque version reference helpers
 * and the first-party quality evaluator's honest verdict discipline.
 *
 * The dispatch's named acceptance (spec/effective-backlog-v1.7.md
 * LAB-013 "missing capability can be discovered, requested, fulfilled,
 * verified and inserted without creating a second marketplace
 * authority") is proven end-to-end in the integration battery; this
 * file pins the CONTRACT semantics as pure functions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_CAPABILITIES_CONTRACT_VERSION,
  LAB_CAPABILITY_ACTORS,
  LAB_CAPABILITY_ADAPTER_KEY_PATTERN,
  LAB_CAPABILITY_ACTION_KINDS,
  LAB_CAPABILITY_CONTRACT_STATUSES,
  LAB_CAPABILITY_DEADLINE_MAX_MS,
  LAB_CAPABILITY_DEADLINE_MIN_MS,
  LAB_CAPABILITY_ESTIMATE_STATUSES,
  LAB_CAPABILITY_FULFILLMENT_KINDS,
  LAB_CAPABILITY_GAP_STATUSES,
  LAB_CAPABILITY_HUMAN_PLANE_AUTHORITIES,
  LAB_CAPABILITY_IMPLEMENTATION_KINDS,
  LAB_CAPABILITY_LINK_OUTCOMES,
  LAB_CAPABILITY_MAX_CONSTRAINTS,
  LAB_CAPABILITY_MAX_REQUIREMENTS,
  LAB_CAPABILITY_MAX_VERSIONS,
  LAB_CAPABILITY_ORIGINS,
  LAB_CAPABILITY_REAL_TEST_AUTHORITIES,
  LAB_CAPABILITY_REFERENCE_PATTERN,
  LAB_CAPABILITY_REQUEST_STATUSES,
  LAB_CAPABILITY_REQUIREMENT_KINDS,
  LAB_CAPABILITY_SCHEMA_MAX_FIELDS,
  LAB_CAPABILITY_STRATEGY_KINDS,
  LAB_CAPABILITY_VERDICTS,
  LAB_CAPABILITY_VERSION_STATUSES,
  FIRST_PARTY_EVALUATOR_ID,
  FIRST_PARTY_EVALUATOR_VERSION,
  assertValidLabCapabilityConstraints,
  assertValidLabCapabilityCost,
  assertValidLabCapabilityGrantedRights,
  assertValidLabCapabilityHumanPlaneCitation,
  assertValidLabCapabilityImplementation,
  assertValidLabCapabilityLatency,
  assertValidLabCapabilityQualityEvaluator,
  assertValidLabCapabilityRealTestCitation,
  assertValidLabCapabilityRequestedRights,
  assertValidLabCapabilityRequirements,
  assertValidLabCapabilityRequiredAction,
  assertValidLabCapabilitySchema,
  assertValidLabCapabilityStrategyCitation,
  createFirstPartyLabCapabilityEvaluator,
  labCapabilityVersionReference,
  parseLabCapabilityVersionReference,
  validateValueAgainstLabCapabilitySchema,
} from '../../src/modules/lab-capabilities/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

function assertInvalid(fn: () => void, fragment: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InvalidRequestError, `expected InvalidRequestError containing '${fragment}'`);
  assert.ok(
    String((caught as InvalidRequestError).message).includes(fragment),
    `message "${String((caught as InvalidRequestError).message)}" should contain '${fragment}'`,
  );
}

// ---------------------------------------------------------------------------
// (1) The frozen vocabularies (§16/§17)
// ---------------------------------------------------------------------------

test('LAB-013: the module vocabularies are CLOSED and versioned (lab-capabilities-contract-v1)', () => {
  assert.equal(LAB_CAPABILITIES_CONTRACT_VERSION, 'lab-capabilities-contract-v1');
  // The §17 actor split — every stage record carries its actor.
  assert.deepEqual(LAB_CAPABILITY_ACTORS, ['autonomous', 'human']);
  // The stage lifecycles.
  assert.deepEqual(LAB_CAPABILITY_GAP_STATUSES, ['open', 'contracted', 'resolved', 'abandoned']);
  assert.deepEqual(LAB_CAPABILITY_CONTRACT_STATUSES, ['derived', 'withdrawn']);
  assert.deepEqual(LAB_CAPABILITY_ESTIMATE_STATUSES, ['recorded', 'superseded']);
  assert.deepEqual(LAB_CAPABILITY_REQUEST_STATUSES, ['pending', 'completed', 'failed', 'cancelled']);
  assert.deepEqual(LAB_CAPABILITY_VERSION_STATUSES, ['draft', 'active', 'retired']);
  // The closed fulfillment/verdict/outcome vocabularies.
  assert.deepEqual(LAB_CAPABILITY_FULFILLMENT_KINDS, ['provider', 'human_plane']);
  assert.deepEqual(LAB_CAPABILITY_VERDICTS, ['pass', 'fail', 'inconclusive']);
  assert.deepEqual(LAB_CAPABILITY_LINK_OUTCOMES, ['passed', 'failed', 'inconclusive']);
  // The closed §16 provenance origins + implementation kinds.
  assert.deepEqual(LAB_CAPABILITY_ORIGINS, ['first_party_declared', 'arena_provider', 'human_contribution']);
  assert.deepEqual(LAB_CAPABILITY_IMPLEMENTATION_KINDS, ['simulator', 'real', 'hybrid', 'declared_only']);
  // The closed §16 gap action kinds (the §16 examples).
  assert.deepEqual(LAB_CAPABILITY_ACTION_KINDS, [
    'physical_performance',
    'platform_action_gap',
    'authentic_demonstration',
    'specialized_media_treatment',
  ]);
  // The opaque citation vocabularies.
  assert.deepEqual(LAB_CAPABILITY_STRATEGY_KINDS, [
    'lab_strategy_candidate',
    'lab_organization_candidate',
    'lab_capability_candidate',
    'external',
  ]);
  // The canonical human-plane authorities (the Human Agent/Job/Task/Execution plane — one entry per authority).
  assert.deepEqual(LAB_CAPABILITY_HUMAN_PLANE_AUTHORITIES, ['field-agents', 'jobs', 'executions']);
  // The real-test authorities (this module only LINKS them).
  assert.deepEqual(LAB_CAPABILITY_REAL_TEST_AUTHORITIES, ['experiments', 'executions', 'evidence', 'workflows']);
  // The requirement kinds.
  assert.deepEqual(LAB_CAPABILITY_REQUIREMENT_KINDS, [
    'human_performance',
    'platform_action',
    'provider_api',
    'specialized_treatment',
    'authentic_demonstration',
  ]);
  // The bounds.
  assert.equal(LAB_CAPABILITY_MAX_VERSIONS, 1000);
  assert.equal(LAB_CAPABILITY_DEADLINE_MIN_MS, 1);
  assert.equal(LAB_CAPABILITY_DEADLINE_MAX_MS, 600_000);
  assert.equal(LAB_CAPABILITY_SCHEMA_MAX_FIELDS, 32);
  assert.equal(LAB_CAPABILITY_MAX_CONSTRAINTS, 32);
  assert.equal(LAB_CAPABILITY_MAX_REQUIREMENTS, 16);
});

test('LAB-013: NO MARKETPLACE VOCABULARY exists in the frozen public surface (the no-second-marketplace rule, structural)', async () => {
  const publicSource = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../src/modules/lab-capabilities/public.ts', import.meta.url), 'utf8'),
  );
  // The marketplace concepts are structurally absent from the module
  // surface (case-insensitive): price, bid, listing, ranking, escrow,
  // negotiation, vendor selection.
  for (const forbidden of ['price', 'bid ', 'bidding', 'listing', 'rank', 'escrow', 'negotiat', 'marketplace']) {
    const occurrences = publicSource
      .split('\n')
      .filter((line) => line.toLowerCase().includes(forbidden))
      // The only permitted occurrences are the NO-marketplace rule
      // statements themselves (comments naming the forbidden concept to
      // forbid it).
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/*'));
    assert.deepEqual(occurrences, [], `no non-comment line in public.ts may contain '${forbidden}'`);
  }
});

// ---------------------------------------------------------------------------
// (2) The one-level schema subset (the LAB-011 discipline)
// ---------------------------------------------------------------------------

const VALID_SCHEMA = {
  type: 'object',
  required: ['videoUrl'],
  properties: {
    videoUrl: { type: 'string' },
    durationSeconds: { type: 'integer' },
    metadata: { type: 'object' },
  },
  maxKeys: 8,
} as const;

test('LAB-013: the one-level schema subset accepts the deterministic shape and rejects ambiguity', () => {
  assertValidLabCapabilitySchema(VALID_SCHEMA, 'schema');
  assertInvalid(() => assertValidLabCapabilitySchema({ ...VALID_SCHEMA, type: 'array' } as never, 'schema'), "type must be 'object'");
  assertInvalid(() => assertValidLabCapabilitySchema({ ...VALID_SCHEMA, properties: {} }, 'schema'), 'must hold 1-32 fields');
  assertInvalid(
    () => assertValidLabCapabilitySchema({ ...VALID_SCHEMA, required: ['x'], properties: { x: { type: 'any' } } } as never, 'schema'),
    'must be one of',
  );
  assertInvalid(
    () => assertValidLabCapabilitySchema({ ...VALID_SCHEMA, required: ['missing'] }, 'schema'),
    'has no matching property',
  );
  assertInvalid(
    () => assertValidLabCapabilitySchema({ ...VALID_SCHEMA, required: ['videoUrl', 'videoUrl'] }, 'schema'),
    'duplicated',
  );
  assertInvalid(() => assertValidLabCapabilitySchema({ ...VALID_SCHEMA, maxKeys: 0 }, 'schema'), 'maxKeys must be an integer 1-32');
});

test('LAB-013: the run-time value enforcement (pure) — every required key present with the declared type', () => {
  const ok = validateValueAgainstLabCapabilitySchema(
    { videoUrl: 'https://example.com/a.mp4', durationSeconds: 61, metadata: { a: 1 } },
    VALID_SCHEMA,
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);

  const missing = validateValueAgainstLabCapabilitySchema({ durationSeconds: 61 }, VALID_SCHEMA);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.join(' ').includes('videoUrl'));

  const wrongType = validateValueAgainstLabCapabilitySchema({ videoUrl: 42 }, VALID_SCHEMA);
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.errors.join(' ').includes('videoUrl'));

  const tooMany = validateValueAgainstLabCapabilitySchema(
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i])),
    VALID_SCHEMA,
  );
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.errors.join(' ').includes('maxKeys'));
});

// ---------------------------------------------------------------------------
// (3) The §16 declared-field fences
// ---------------------------------------------------------------------------

test('LAB-013: the quality-evaluator declaration fence (identity + version + the evaluation contract shape)', () => {
  assertValidLabCapabilityQualityEvaluator(
    { evaluatorId: 'quality-shape-evaluator', evaluatorVersion: '1', evaluationContract: VALID_SCHEMA },
    'evaluator',
  );
  assertInvalid(
    () => assertValidLabCapabilityQualityEvaluator({ evaluatorId: 'BAD ID', evaluatorVersion: '1', evaluationContract: VALID_SCHEMA }, 'evaluator'),
    'evaluatorId',
  );
  assertInvalid(
    () => assertValidLabCapabilityQualityEvaluator({ evaluatorId: 'e', evaluatorVersion: '1', evaluationContract: null } as never, 'evaluator'),
    'evaluationContract',
  );
  assertInvalid(
    () =>
      assertValidLabCapabilityQualityEvaluator(
        { evaluatorId: 'e', evaluatorVersion: '1', evaluationContract: { ...VALID_SCHEMA, type: 'x' } } as never,
        'evaluator',
      ),
    'type must be',
  );
});

test('LAB-013: the cost / latency / implementation / requirements / constraints fences', () => {
  assertValidLabCapabilityCost({ costModel: 'abstract-units', costUnits: 12.5 }, 'cost');
  assertInvalid(() => assertValidLabCapabilityCost({ costModel: 'abstract-units', costUnits: -1 }, 'cost'), '>= 0');
  assertInvalid(() => assertValidLabCapabilityCost({ costModel: '', costUnits: 1 }, 'cost'), 'costModel');

  assertValidLabCapabilityLatency({ expectedP50Ms: 100, expectedP95Ms: 900, deadlineMs: 10_000 }, 'latency');
  assertInvalid(
    () => assertValidLabCapabilityLatency({ expectedP50Ms: 900, expectedP95Ms: 100, deadlineMs: 10_000 }, 'latency'),
    'below expectedP50Ms',
  );
  assertInvalid(
    () => assertValidLabCapabilityLatency({ expectedP50Ms: 1, expectedP95Ms: 2, deadlineMs: 601_000 }, 'latency'),
    'deadlineMs must be an integer 1-600000',
  );

  assertValidLabCapabilityImplementation(
    { implementationId: 'impl-1', implementationVersion: '0.3', implementationKind: 'hybrid' },
    'implementation',
  );
  assertInvalid(
    () => assertValidLabCapabilityImplementation({ implementationId: 'i', implementationVersion: '1', implementationKind: 'magic' } as never, 'implementation'),
    'implementationKind must be one of',
  );

  assertValidLabCapabilityRequirements(
    [{ requirementKind: 'human_performance', description: 'A specific physical performance' }],
    'requirements',
  );
  assertInvalid(
    () => assertValidLabCapabilityRequirements([{ requirementKind: 'divine_intervention', description: 'x' }] as never, 'requirements'),
    'requirementKind must be one of',
  );
  assertInvalid(
    () => assertValidLabCapabilityRequirements(Array.from({ length: 17 }, () => ({ requirementKind: 'provider_api', description: 'x' })), 'requirements'),
    'at most 16',
  );

  assertValidLabCapabilityConstraints(['no_fake_engagement', 'no_impersonation'], 'constraints');
  assertInvalid(
    () => assertValidLabCapabilityConstraints(Array.from({ length: 33 }, () => 'c'), 'constraints'),
    'at most 32',
  );
});

// ---------------------------------------------------------------------------
// (4) The §17 stage payload fences
// ---------------------------------------------------------------------------

test('LAB-013: the strategy-citation / required-action / rights fences', () => {
  assertValidLabCapabilityStrategyCitation({ strategyKind: 'lab_strategy_candidate', strategyReference: '00000000-0000-0000-0000-0000000000aa' }, 'citation');
  assertInvalid(
    () => assertValidLabCapabilityStrategyCitation({ strategyKind: 'lab_idea', strategyReference: 'x' } as never, 'citation'),
    'strategyKind must be one of',
  );

  assertValidLabCapabilityRequiredAction(
    { actionKind: 'physical_performance', description: 'A specific physical performance', qualityBar: 'indistinguishable from a skilled human' },
    'action',
  );
  assertInvalid(
    () => assertValidLabCapabilityRequiredAction({ actionKind: 'magic', description: 'x', qualityBar: 'y' } as never, 'action'),
    'actionKind must be one of',
  );

  const rights = { usageScope: 'lab-simulation-and-production', redistribution: false, attributionRequired: true, licenseTerms: null };
  assertValidLabCapabilityRequestedRights(rights, 'rights');
  assertValidLabCapabilityGrantedRights(rights, 'granted');
  assert.equal(assertValidLabCapabilityGrantedRights(null, 'granted'), null);
  assertInvalid(
    () => assertValidLabCapabilityRequestedRights({ ...rights, redistribution: 'no' } as never, 'rights'),
    'redistribution must be a boolean',
  );
});

test('LAB-013: the human-plane citation fence (the canonical plane authorities only, cited OPAQUELY)', () => {
  for (const authority of LAB_CAPABILITY_HUMAN_PLANE_AUTHORITIES) {
    assertValidLabCapabilityHumanPlaneCitation({ planeAuthority: authority, recordReference: 'job-42#t7' }, 'citation');
  }
  assertInvalid(
    () => assertValidLabCapabilityHumanPlaneCitation({ planeAuthority: 'tasks', recordReference: 'x' } as never, 'citation'),
    'planeAuthority must be one of',
  );
  // The plane citation vocabulary structurally CANNOT name a re-modeling
  // surface (no 'task', 'assignment', 'workforce' authority exists).
  assert.ok(!LAB_CAPABILITY_HUMAN_PLANE_AUTHORITIES.includes('tasks' as never));
});

test('LAB-013: the real-test citation fence (the real authorities only, linked never owned)', () => {
  for (const authority of LAB_CAPABILITY_REAL_TEST_AUTHORITIES) {
    assertValidLabCapabilityRealTestCitation({ authority, recordReference: 'exp-1' }, 'citation');
  }
  assertInvalid(
    () => assertValidLabCapabilityRealTestCitation({ authority: 'missions', recordReference: 'x' } as never, 'citation'),
    'authority must be one of',
  );
});

// ---------------------------------------------------------------------------
// (5) The opaque version reference helpers
// ---------------------------------------------------------------------------

test('LAB-013: the opaque capability-version reference (format + parse + the malformed rejections)', () => {
  const capabilityId = '00000000-0000-0000-0000-0000000000c1';
  const reference = labCapabilityVersionReference(capabilityId, 3);
  assert.equal(reference, `${capabilityId}#v3`);
  assert.ok(LAB_CAPABILITY_REFERENCE_PATTERN.test(reference));
  const parsed = parseLabCapabilityVersionReference(reference);
  assert.equal(parsed.capabilityId, capabilityId);
  assert.equal(parsed.capabilityVersion, 3);

  for (const malformed of ['', 'not-a-ref', `${capabilityId}#v0`, `${capabilityId}#v10000`, `${capabilityId}`, `#v1`]) {
    assert.ok(!LAB_CAPABILITY_REFERENCE_PATTERN.test(malformed), `'${malformed}' must not match the reference pattern`);
    assert.throws(() => parseLabCapabilityVersionReference(malformed), InvalidRequestError);
  }
  // The adapter-key shape.
  assert.ok(LAB_CAPABILITY_ADAPTER_KEY_PATTERN.test('arena'));
  assert.ok(!LAB_CAPABILITY_ADAPTER_KEY_PATTERN.test('Arena!'));
});

// ---------------------------------------------------------------------------
// (6) The first-party quality evaluator (the honest verdict discipline)
// ---------------------------------------------------------------------------

test('LAB-013: the first-party evaluator — pass iff the artifact satisfies the declared output schema + evaluation contract, fail honestly otherwise', async () => {
  const evaluator = createFirstPartyLabCapabilityEvaluator();
  assert.equal(FIRST_PARTY_EVALUATOR_ID, 'first-party-shape-evaluator');
  assert.equal(FIRST_PARTY_EVALUATOR_VERSION, '1');

  const declaredEvaluator = {
    evaluatorId: 'quality-shape-evaluator',
    evaluatorVersion: '2',
    evaluationContract: {
      type: 'object' as const,
      required: ['videoUrl'],
      properties: { videoUrl: { type: 'string' as const } },
    },
  };
  const outputSchema = {
    type: 'object' as const,
    required: ['videoUrl'],
    properties: { videoUrl: { type: 'string' as const }, durationSeconds: { type: 'integer' as const } },
  };

  const pass = await evaluator.evaluate({
    declaredEvaluator,
    outputSchema,
    deliveredArtifact: { videoUrl: 'https://example.com/a.mp4', durationSeconds: 61 },
  });
  assert.equal(pass.verdict, 'pass');
  assert.equal((pass.evidence as Record<string, unknown>)['evaluatorId'], 'quality-shape-evaluator');
  assert.equal((pass.evidence as Record<string, unknown>)['shapeCheckOk'], true);

  const fail = await evaluator.evaluate({
    declaredEvaluator,
    outputSchema,
    deliveredArtifact: { videoUrl: 42 },
  });
  assert.equal(fail.verdict, 'fail');
  assert.equal((fail.evidence as Record<string, unknown>)['shapeCheckOk'], false);
  assert.ok(Array.isArray((fail.evidence as Record<string, unknown>)['errors']));
  // A verdict without evidence is inexpressible: the evidence object is
  // always present.
  assert.ok(typeof fail.evidence === 'object' && fail.evidence !== null);
});
