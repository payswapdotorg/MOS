/**
 * MKT-065 unit tests — the frozen Cross-Platform Distribution
 * vocabularies, the pure derivation helpers (the deterministic
 * idempotency key, the canonical plan input digest, the destination
 * outcome derivation) and the input/provenance guards (pure functions,
 * no DB).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-065; spec/
 * architecture-v1.6.md §5 "Cross-platform distribution"; spec/
 * architecture-lock-v1.6.md rules 20/29):
 *   - the vocabularies are frozen and versioned (cpd-vocab-v1): the plan
 *     lifecycle, the destination outcome vocabulary (the 063 gate
 *     verdicts, the capability/policy rejections, the 056 terminal
 *     states + the honest UNKNOWN 'publishing'), the event kinds and the
 *     capability-rejection codes;
 *   - THE PLAN TRANSITION TABLE: planned → dispatching → dispatched;
 *     dispatched → dispatching on re-dispatch; nothing else;
 *   - THE IDEMPOTENCY KEY DERIVATION: cpd:<plan>:<destination> — same
 *     inputs → same key (the at-most-once identity toward the 056
 *     ledger), the 056 grammar always satisfied, different destinations
 *     never collide;
 *   - THE OUTCOME DERIVATION: the 056 'submitted' state maps to the
 *     honest UNKNOWN 'publishing' (never blindly replayed); the terminal
 *     states map verbatim;
 *   - THE INPUT DIGEST: canonical and deterministic (same declaration →
 *     same digest; key order in payload objects does not matter; any
 *     declared difference changes the digest);
 *   - the input guards reject every malformed shape (unknown vocabulary
 *     value, malformed 'ca:' ref, floating asset pointer syntax, missing
 *     destination, planning duplicate, oversized fields, material-shaped
 *     payload keys (§21), duplicate transformation outputs) fail-closed
 *     BEFORE any write, and the provenance guard enforces the
 *     server-derived discipline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import {
  CROSS_PLATFORM_DISTRIBUTION_VOCABULARY_VERSION,
  derivePublishIdempotencyKey,
  DISTRIBUTION_ASSET_REF_PATTERN,
  DISTRIBUTION_CAPABILITY_REJECTION_CODES,
  DISTRIBUTION_DESTINATION_STATUSES,
  DISTRIBUTION_EVENT_KINDS,
  DISTRIBUTION_IDEMPOTENCY_KEY_PATTERN,
  DISTRIBUTION_MAX_DESTINATIONS,
  DISTRIBUTION_PLAN_STATES,
  isLegalDistributionPlanTransition,
} from '../../src/modules/cross-platform-distribution/public.ts';
import {
  assertValidCreateDistributionPlanInput,
  assertValidCrossPlatformDistributionProvenance,
  assertValidDispatchInput,
  assertValidMeasurementReferenceInput,
  computeDistributionPlanInputDigest,
  destinationStatusOfPublishState,
} from '../../src/modules/cross-platform-distribution/public.ts';

const AGENCY_ID = '0a1b2c3d-4e5f-6a7b-8c9d-0a1b2c3d4e5f';
const CLIENT_ID = '1b2c3d4e-5f6a-7b8c-9d0a-1b2c3d4e5f6a';
const WORKSPACE_ID = '2c3d4e5f-6a7b-8c9d-0a1b-2c3d4e5f6a7b';
const MISSION_ID = '3d4e5f6a-7b8c-9d0a-1b2c-3d4e5f6a7b8c';
const ACCOUNT_ID = '4e5f6a7b-8c9d-0a1b-2c3d-4e5f6a7b8c9d';
const ASSET_REF = 'ca:5f6a7b8c-9d0a-1b2c-3d4e-5f6a7b8c9d0a';
const OUTPUT_REF = 'ca:6a7b8c9d-0a1b-2c3d-4e5f-6a7b8c9d0a1b';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-000000000065',
  recordedVia: 'test',
  correlationId: 'unit-cross-platform-distribution-1',
  causationId: null,
} as const;

function validPlanInput(overrides: Record<string, unknown> = {}) {
  return {
    agencyId: AGENCY_ID,
    clientId: CLIENT_ID,
    workspaceId: null,
    missionId: null,
    sourceAssetRef: ASSET_REF,
    transformationPlan: {
      description: 'One vertical reframe for short-form platforms',
      outputs: [{ assetRef: OUTPUT_REF, variantLabel: 'vertical-cut' }],
    },
    destinations: [
      {
        socialAccountId: ACCOUNT_ID,
        targetFormat: 'short_video_vertical',
        assetRef: ASSET_REF,
        publishRequest: {
          contentType: 'reference-post',
          payload: { title: 'Launch' },
          attribution: { missionId: MISSION_ID },
          scheduledFor: null,
        },
      },
      {
        socialAccountId: ACCOUNT_ID,
        targetFormat: 'square_image',
        assetRef: OUTPUT_REF,
        publishRequest: {
          contentType: 'reference-post',
          payload: { title: 'Launch (square)' },
          attribution: {},
          scheduledFor: '2026-09-01T10:00:00.000Z',
        },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The frozen vocabularies (cpd-vocab-v1)
// ---------------------------------------------------------------------------

test('the cpd-vocab-v1 vocabularies are frozen and complete', () => {
  assert.equal(CROSS_PLATFORM_DISTRIBUTION_VOCABULARY_VERSION, 'cpd-vocab-v1');
  assert.deepEqual(DISTRIBUTION_PLAN_STATES, ['planned', 'dispatching', 'dispatched']);
  // The destination outcome vocabulary carries the three gate/capability/
  // policy rejections, the honest UNKNOWN and the four 056 terminal states.
  assert.deepEqual(DISTRIBUTION_DESTINATION_STATUSES, [
    'planned',
    'rights_review_required',
    'rights_blocked',
    'capability_rejected',
    'policy_blocked',
    'publishing',
    'published',
    'accepted',
    'failed',
    'restricted',
  ]);
  assert.equal(DISTRIBUTION_DESTINATION_STATUSES.length, 10);
  assert.deepEqual(DISTRIBUTION_EVENT_KINDS, [
    'plan_created',
    'dispatch_started',
    'gate_evaluation',
    'capability_resolution',
    'policy_evaluation',
    'publication_attempt',
    'dispatch_completed',
    'measurement_reference',
  ]);
  assert.deepEqual(DISTRIBUTION_CAPABILITY_REJECTION_CODES, [
    'platform_adapter_unregistered',
    'authorization_unusable',
    'publish_capability_undeclared',
    'publish_operation_undeclared',
    'publish_scope_unsatisfied',
    'integration_adapter_unregistered',
  ]);
  assert.equal(DISTRIBUTION_MAX_DESTINATIONS, 32);
});

test('the plan transition table: planned → dispatching → dispatched; dispatched → dispatching on re-dispatch; nothing else', () => {
  assert.ok(isLegalDistributionPlanTransition('planned', 'dispatching'));
  assert.ok(isLegalDistributionPlanTransition('dispatching', 'dispatched'));
  assert.ok(isLegalDistributionPlanTransition('dispatched', 'dispatching'));
  // Every other pair is illegal (no skips, no backwards, no self-loops).
  for (const from of DISTRIBUTION_PLAN_STATES) {
    for (const to of DISTRIBUTION_PLAN_STATES) {
      const legal =
        (from === 'planned' && to === 'dispatching') ||
        (from === 'dispatching' && to === 'dispatched') ||
        (from === 'dispatched' && to === 'dispatching');
      assert.equal(
        isLegalDistributionPlanTransition(from, to),
        legal,
        `${from} → ${to} must be ${legal ? 'legal' : 'illegal'}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The deterministic idempotency key + the outcome derivation
// ---------------------------------------------------------------------------

test('the derived idempotency key is deterministic, grammar-safe and collision-free per destination', () => {
  const planId = '7b8c9d0a-1b2c-3d4e-5f6a-7b8c9d0a1b2c';
  const destinationOne = '8c9d0a1b-2c3d-4e5f-6a7b-8c9d0a1b2c3d';
  const destinationTwo = '9d0a1b2c-3d4e-5f6a-7b8c-9d0a1b2c3d4e';
  const one = derivePublishIdempotencyKey(planId, destinationOne);
  const oneAgain = derivePublishIdempotencyKey(planId, destinationOne);
  const two = derivePublishIdempotencyKey(planId, destinationTwo);
  assert.equal(one, oneAgain, 'same plan + destination → same key (the at-most-once identity)');
  assert.notEqual(one, two, 'different destinations never collide');
  assert.ok(one.startsWith('cpd:'));
  assert.ok(DISTRIBUTION_IDEMPOTENCY_KEY_PATTERN.test(one));
  assert.ok(DISTRIBUTION_IDEMPOTENCY_KEY_PATTERN.test(two));
  // The 064 interop grammar.
  assert.ok(DISTRIBUTION_ASSET_REF_PATTERN.test(ASSET_REF));
  assert.ok(!DISTRIBUTION_ASSET_REF_PATTERN.test('ca:not-a-uuid'));
  assert.ok(!DISTRIBUTION_ASSET_REF_PATTERN.test('asset:latest'));
});

test('the destination outcome derivation: the 056 submitted state is the honest UNKNOWN publishing; the terminal states map verbatim', () => {
  assert.equal(destinationStatusOfPublishState('submitted'), 'publishing');
  assert.equal(destinationStatusOfPublishState('accepted'), 'accepted');
  assert.equal(destinationStatusOfPublishState('published'), 'published');
  assert.equal(destinationStatusOfPublishState('failed'), 'failed');
  assert.equal(destinationStatusOfPublishState('restricted'), 'restricted');
});

// ---------------------------------------------------------------------------
// The canonical plan input digest
// ---------------------------------------------------------------------------

test('the plan input digest is canonical and deterministic (key order does not matter; any difference changes it)', () => {
  const base = {
    sourceAssetRef: ASSET_REF,
    transformationPlan: {
      description: 'd',
      outputs: [{ assetRef: OUTPUT_REF, variantLabel: 'v' }],
    },
    destinations: [
      {
        socialAccountId: ACCOUNT_ID,
        targetFormat: 'short_video_vertical',
        assetRef: ASSET_REF,
        publishRequest: {
          contentType: 'reference-post',
          payload: { a: 1, b: { x: 'y' } },
          attribution: { missionId: MISSION_ID },
          scheduledFor: null,
        },
      },
    ],
  };
  const first = computeDistributionPlanInputDigest(base);
  // Same declaration → same digest.
  assert.equal(computeDistributionPlanInputDigest(base), first);
  // Payload key ORDER does not matter (canonical JSON).
  assert.equal(
    computeDistributionPlanInputDigest({
      ...base,
      destinations: [
        {
          ...base.destinations[0]!,
          publishRequest: {
            contentType: 'reference-post',
            payload: { b: { x: 'y' }, a: 1 },
            attribution: { missionId: MISSION_ID },
            scheduledFor: null,
          },
        },
      ],
    }),
    first,
  );
  // ANY declared difference changes the digest (the format, the payload,
  // the attribution, the source ref).
  assert.notEqual(
    computeDistributionPlanInputDigest({
      ...base,
      destinations: [
        { ...base.destinations[0]!, targetFormat: 'square_image' },
      ],
    }),
    first,
  );
  assert.notEqual(
    computeDistributionPlanInputDigest({
      ...base,
      destinations: [
        {
          ...base.destinations[0]!,
          publishRequest: { ...base.destinations[0]!.publishRequest, payload: { a: 2, b: { x: 'y' } } },
        },
      ],
    }),
    first,
  );
  assert.notEqual(computeDistributionPlanInputDigest({ ...base, sourceAssetRef: OUTPUT_REF }), first);
  // The digest is bounded (>= 16 chars, the migration-055 fence).
  assert.ok(first.length >= 16);
});

// ---------------------------------------------------------------------------
// The input guards (fail-closed by rejection)
// ---------------------------------------------------------------------------

test('the plan input guard accepts the canonical §5 declaration and rejects every malformed shape', () => {
  // The canonical declaration passes.
  assert.doesNotThrow(() => assertValidCreateDistributionPlanInput(validPlanInput()));
  assert.doesNotThrow(() =>
    assertValidCreateDistributionPlanInput(
      validPlanInput({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID }),
    ),
  );

  const rejects = (input: unknown, marker: string) => {
    assert.throws(
      () => assertValidCreateDistributionPlanInput(input as never),
      (error: unknown) =>
        error instanceof InvalidRequestError &&
        (error.details ?? []).some((detail) => detail.includes(marker)),
      `expected rejection mentioning '${marker}'`,
    );
  };

  // Malformed tenant scope.
  rejects(validPlanInput({ agencyId: 'not-a-uuid' }), 'agencyId');
  rejects(validPlanInput({ clientId: '' }), 'clientId');
  rejects(validPlanInput({ workspaceId: 'ws' }), 'workspaceId');
  rejects(validPlanInput({ missionId: 'mission-1' }), 'missionId');
  // A floating/malformed source ref (never a floating pointer).
  rejects(validPlanInput({ sourceAssetRef: 'asset:latest' }), 'sourceAssetRef');
  rejects(validPlanInput({ sourceAssetRef: '' }), 'sourceAssetRef');
  // Malformed transformation plan.
  rejects(validPlanInput({ transformationPlan: null }), 'transformationPlan');
  rejects(
    validPlanInput({ transformationPlan: { description: '', outputs: [] } }),
    'transformationPlan.description',
  );
  rejects(
    validPlanInput({
      transformationPlan: { description: 'd', outputs: [{ assetRef: 'nope', variantLabel: 'v' }] },
    }),
    'transformationPlan.outputs[0].assetRef',
  );
  rejects(
    validPlanInput({
      transformationPlan: { description: 'd', outputs: [{ assetRef: OUTPUT_REF, variantLabel: '' }] },
    }),
    'variantLabel',
  );
  // Duplicate transformation outputs.
  rejects(
    validPlanInput({
      transformationPlan: {
        description: 'd',
        outputs: [
          { assetRef: OUTPUT_REF, variantLabel: 'a' },
          { assetRef: OUTPUT_REF, variantLabel: 'b' },
        ],
      },
    }),
    'duplicate output asset refs',
  );
  // Destinations: empty, over-bound, malformed.
  rejects(validPlanInput({ destinations: [] }), 'destinations');
  rejects(
    validPlanInput({
      destinations: Array.from({ length: DISTRIBUTION_MAX_DESTINATIONS + 1 }, (_, index) => ({
        socialAccountId: ACCOUNT_ID,
        targetFormat: `format_${index}`,
        assetRef: ASSET_REF,
        publishRequest: {
          contentType: 'reference-post',
          payload: {},
          attribution: {},
          scheduledFor: null,
        },
      })),
    }),
    'at most 32 destinations',
  );
  rejects(
    validPlanInput({
      destinations: [
        { targetFormat: 'short_video_vertical', assetRef: ASSET_REF, publishRequest: validPlanInput().destinations[0]!.publishRequest },
      ],
    }),
    'socialAccountId',
  );
  rejects(
    validPlanInput({
      destinations: [
        {
          socialAccountId: ACCOUNT_ID,
          targetFormat: 'Bad Format!',
          assetRef: ASSET_REF,
          publishRequest: validPlanInput().destinations[0]!.publishRequest,
        },
      ],
    }),
    'targetFormat',
  );
  rejects(
    validPlanInput({
      destinations: [
        {
          socialAccountId: ACCOUNT_ID,
          targetFormat: 'short_video_vertical',
          assetRef: 'floating-latest',
          publishRequest: validPlanInput().destinations[0]!.publishRequest,
        },
      ],
    }),
    'destinations[0].assetRef',
  );
  // The planning-duplicate fence: the same (account, format) twice.
  rejects(
    validPlanInput({
      destinations: [
        validPlanInput().destinations[0]!,
        validPlanInput().destinations[0]!,
      ],
    }),
    'one variant per (account, target format)',
  );
  // Malformed publish request shapes.
  const badRequestCases: unknown[] = [
    { contentType: 'BAD TYPE', payload: {}, attribution: {}, scheduledFor: null },
    { contentType: 'reference-post', payload: null, attribution: {}, scheduledFor: null },
    { contentType: 'reference-post', payload: {}, attribution: {}, scheduledFor: 'tomorrow' },
  ];
  for (const [index, publishRequest] of badRequestCases.entries()) {
    rejects(
      validPlanInput({
        destinations: [
          { socialAccountId: ACCOUNT_ID, targetFormat: 'short_video_vertical', assetRef: ASSET_REF, publishRequest },
        ],
      }),
      index === 2 ? 'scheduledFor' : index === 1 ? 'payload' : 'contentType',
    );
  }
  // §21: material-shaped keys are refused inside the payload.
  rejects(
    validPlanInput({
      destinations: [
        {
          socialAccountId: ACCOUNT_ID,
          targetFormat: 'short_video_vertical',
          assetRef: ASSET_REF,
          publishRequest: {
            contentType: 'reference-post',
            payload: { apiToken: 'secret-value' },
            attribution: {},
            scheduledFor: null,
          },
        },
      ],
    }),
    'material-shaped',
  );
});

test('the dispatch + measurement guards and the provenance guard enforce the server-derived discipline', () => {
  assert.doesNotThrow(() => assertValidDispatchInput({ planId: '7b8c9d0a-1b2c-3d4e-5f6a-7b8c9d0a1b2c' }));
  assert.throws(() => assertValidDispatchInput({ planId: 'plan-1' }), InvalidRequestError);

  assert.doesNotThrow(() =>
    assertValidMeasurementReferenceInput({
      planId: '7b8c9d0a-1b2c-3d4e-5f6a-7b8c9d0a1b2c',
      destinationId: null,
      measurementRef: 'evidence:0a1b2c3d-0000-0000-0000-000000000001',
      note: null,
    }),
  );
  assert.throws(
    () => assertValidMeasurementReferenceInput({ planId: 'p', destinationId: null, measurementRef: 'r', note: null }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidMeasurementReferenceInput({
        planId: '7b8c9d0a-1b2c-3d4e-5f6a-7b8c9d0a1b2c',
        destinationId: null,
        measurementRef: '',
        note: null,
      }),
    InvalidRequestError,
  );

  // The provenance guard: complete server-derived shape passes; every
  // incomplete shape fails closed.
  assert.doesNotThrow(() => assertValidCrossPlatformDistributionProvenance(PROVENANCE));
  for (const broken of [
    { ...PROVENANCE, actor: '' },
    { ...PROVENANCE, recordedVia: '' },
    { ...PROVENANCE, correlationId: '' },
    { ...PROVENANCE, causationId: 'a'.repeat(101) },
    null,
  ]) {
    assert.throws(
      () => assertValidCrossPlatformDistributionProvenance(broken as never),
      InvalidRequestError,
    );
  }
});
