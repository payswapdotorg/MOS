/**
 * MKT-050 unit tests — the App Marketplace, Trust and Certification
 * contract as PURE functions (spec/mos-app-ecosystem-v1.5.md "Trust
 * levels" + "Economics"; spec/effective-backlog-v1.5.md MKT-050;
 * spec/architecture-lock-v1.5.md #7/#10/#11).
 *
 * Acceptance mapping (the MKT-050 unit-test scope: the trust vocabulary,
 * the transition state machine, the review structuring, the eligibility
 * derivation and the input guards):
 *   - THE TRUST VOCABULARY: the one frozen enum (the /apps registry
 *     certification set — there is NO second trust vocabulary) with an
 *     interpretable meaning per level;
 *   - THE TRANSITION STATE MACHINE: the frozen one-way ladder
 *     (UNVERIFIED → COMMUNITY_VERIFIED → MOS_CERTIFIED, NO skipping) +
 *     the DISCLOSED down moves (decertify, revoke); every legal triple
 *     evaluated; every illegal move (skip, same-state, illegal down
 *     direction, wrong departure state) rejected with the honest
 *     reason;
 *   - THE DERIVED STATE: the current trust state is the NEWEST event's
 *     toState (the append-only tail), the UNVERIFIED registry birth
 *     state when no event exists;
 *   - THE REVIEW MODEL: the derived summary (count, one-decimal
 *     average, verdict tallies, newest stamp) from any-ordered tails;
 *     the honest empty summary; the publisher classification
 *     (svc: first-party vs dev: community);
 *   - THE ELIGIBILITY DERIVATION (AC-5): the policy-consumable
 *     attribute vocabulary (certificationState/transitionCount/
 *     reviewCount/averageRating) — the exact /policies rule-matching
 *     shape;
 *   - THE INPUT GUARDS: transition input (closed label vocabulary,
 *     bounded reason), review input (closed rating band + verdict
 *     vocabulary, bounded body, uuid-or-null version target),
 *     provenance and the listing filters (closed trust-level and
 *     publisher-kind vocabularies) — 422s with zero state touched;
 *   - the §8-style create fingerprints (deterministic, divergent on
 *     content change) and the replay-or-conflict convergence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_REVIEW_RATING_MAX,
  APP_REVIEW_RATING_MIN,
  APP_REVIEW_VERDICTS,
  MARKETPLACE_PUBLISHER_KINDS,
  TRUST_TRANSITIONS,
  TRUST_TRANSITION_TARGETS,
  buildPolicyAttributes,
  derivePublisherKind,
  deriveReviewSummary,
  deriveTrustState,
  evaluateTrustTransition,
  type AppCertificationState,
} from '../../src/modules/app-marketplace/public.ts';
import {
  MARKETPLACE_MATERIAL_SHAPED_KEYS,
  appReviewCreateFingerprint,
  assertValidMarketplaceFilters,
  assertValidMarketplaceProvenance,
  assertValidReviewInput,
  assertValidTransitionInput,
  classifyMarketplaceWriteConflict,
  replayOrConflict,
  trustEventCreateFingerprint,
} from '../../src/modules/app-marketplace/public.ts';
import { APP_CERTIFICATION_STATES } from '../../src/modules/apps/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// The trust vocabulary (the ONE frozen enum — no second vocabulary)
// ---------------------------------------------------------------------------

test('MKT-050 unit: the trust vocabulary is exactly the /apps registry certification enum', () => {
  // The marketplace re-exports the registry enum — there is no second
  // trust vocabulary anywhere in the codebase (boundary tested too).
  assert.deepEqual(
    ['UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED'] satisfies AppCertificationState[],
    APP_CERTIFICATION_STATES,
  );
});

test('MKT-050 unit: the transition label vocabulary is closed (two up arrows + the disclosed down family)', () => {
  assert.deepEqual([...TRUST_TRANSITIONS].sort(), ['certify', 'decertify', 'revoke', 'verify']);
  // Every declared transition has at least one legal target triple.
  for (const transition of TRUST_TRANSITIONS) {
    assert.ok(
      TRUST_TRANSITION_TARGETS[transition].length >= 1,
      `${transition} has at least one legal (from, to) triple`,
    );
  }
});

test('MKT-050 unit: the transition targets are the frozen one-way ladder with NO skipping and NO same-state moves', () => {
  const pairs = Object.values(TRUST_TRANSITION_TARGETS).flat();
  // The frozen UP arrows exist exactly once each.
  assert.ok(
    pairs.some((pair) => pair.from === 'UNVERIFIED' && pair.to === 'COMMUNITY_VERIFIED'),
    'verify: UNVERIFIED → COMMUNITY_VERIFIED exists',
  );
  assert.ok(
    pairs.some((pair) => pair.from === 'COMMUNITY_VERIFIED' && pair.to === 'MOS_CERTIFIED'),
    'certify: COMMUNITY_VERIFIED → MOS_CERTIFIED exists',
  );
  // NO skipping: UNVERIFIED → MOS_CERTIFIED is structurally absent.
  assert.ok(
    !pairs.some((pair) => pair.from === 'UNVERIFIED' && pair.to === 'MOS_CERTIFIED'),
    'the skip UNVERIFIED → MOS_CERTIFIED does not exist (certification follows community verification)',
  );
  // NO same-state move anywhere.
  for (const pair of pairs) {
    assert.notEqual(pair.from, pair.to, 'a transition is never a same-state no-op');
  }
});

// ---------------------------------------------------------------------------
// The transition state machine (the pure evaluator)
// ---------------------------------------------------------------------------

test('MKT-050 unit: every legal ladder move evaluates ok with the correct target state', () => {
  assert.deepEqual(evaluateTrustTransition('UNVERIFIED', 'verify'), {
    ok: true,
    toState: 'COMMUNITY_VERIFIED',
  });
  assert.deepEqual(evaluateTrustTransition('COMMUNITY_VERIFIED', 'certify'), {
    ok: true,
    toState: 'MOS_CERTIFIED',
  });
  assert.deepEqual(evaluateTrustTransition('MOS_CERTIFIED', 'decertify'), {
    ok: true,
    toState: 'COMMUNITY_VERIFIED',
  });
  assert.deepEqual(evaluateTrustTransition('COMMUNITY_VERIFIED', 'revoke'), {
    ok: true,
    toState: 'UNVERIFIED',
  });
  assert.deepEqual(evaluateTrustTransition('MOS_CERTIFIED', 'revoke'), {
    ok: true,
    toState: 'UNVERIFIED',
  });
});

test('MKT-050 unit: illegal moves are rejected with honest reasons (skip, wrong departure, same-state-equivalent)', () => {
  // The skip: certifying straight from UNVERIFIED.
  const skip = evaluateTrustTransition('UNVERIFIED', 'certify');
  assert.equal(skip.ok, false);
  if (!skip.ok) {
    assert.match(skip.reason, /no skipping from UNVERIFIED/);
  }
  // Wrong departure: verifying an already-verified app.
  const wrongDeparture = evaluateTrustTransition('COMMUNITY_VERIFIED', 'verify');
  assert.equal(wrongDeparture.ok, false);
  // Revoking from the birth state.
  const revokeBirth = evaluateTrustTransition('UNVERIFIED', 'revoke');
  assert.equal(revokeBirth.ok, false);
  if (!revokeBirth.ok) {
    assert.match(revokeBirth.reason, /COMMUNITY_VERIFIED or MOS_CERTIFIED/);
  }
  // Decertifying a non-certified app.
  const decertifyUnverified = evaluateTrustTransition('UNVERIFIED', 'decertify');
  assert.equal(decertifyUnverified.ok, false);
});

test('MKT-050 unit: the full (state × transition) matrix never produces a silent same-state result', () => {
  for (const state of APP_CERTIFICATION_STATES) {
    for (const transition of TRUST_TRANSITIONS) {
      const verdict = evaluateTrustTransition(state, transition);
      if (verdict.ok) {
        assert.notEqual(verdict.toState, state);
      } else {
        assert.ok(verdict.reason.length > 0, 'the rejection carries an honest reason');
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The derived state (the append-only tail)
// ---------------------------------------------------------------------------

test('MKT-050 unit: the derived trust state is the newest event toState, UNVERIFIED at birth', () => {
  assert.equal(deriveTrustState([]), 'UNVERIFIED');
  assert.equal(deriveTrustState([{ toState: 'COMMUNITY_VERIFIED' }]), 'COMMUNITY_VERIFIED');
  assert.equal(
    deriveTrustState([
      { toState: 'COMMUNITY_VERIFIED' },
      { toState: 'MOS_CERTIFIED' },
    ]),
    'MOS_CERTIFIED',
  );
  // A down move re-derives honestly (revocation is visible, never a rewrite).
  assert.equal(
    deriveTrustState([
      { toState: 'COMMUNITY_VERIFIED' },
      { toState: 'MOS_CERTIFIED' },
      { toState: 'UNVERIFIED' },
    ]),
    'UNVERIFIED',
  );
});

// ---------------------------------------------------------------------------
// The review model (display metadata)
// ---------------------------------------------------------------------------

test('MKT-050 unit: the review summary derives from any-ordered tails with an honest empty state', () => {
  const empty = deriveReviewSummary([]);
  assert.deepEqual(empty, {
    reviewCount: 0,
    averageRating: null,
    verdictCounts: { positive: 0, mixed: 0, negative: 0 },
    lastReviewAt: null,
  });

  const summary = deriveReviewSummary([
    { rating: 4, verdict: 'positive', recordedAt: '2026-01-02T00:00:00.000Z' },
    { rating: 5, verdict: 'positive', recordedAt: '2026-01-01T00:00:00.000Z' },
    { rating: 1, verdict: 'negative', recordedAt: '2026-01-03T00:00:00.000Z' },
  ]);
  assert.equal(summary.reviewCount, 3);
  assert.equal(summary.averageRating, 3.3); // (4+5+1)/3 = 3.333… → one decimal
  assert.deepEqual(summary.verdictCounts, { positive: 2, mixed: 0, negative: 1 });
  assert.equal(summary.lastReviewAt, '2026-01-03T00:00:00.000Z');
});

test('MKT-050 unit: the review vocabulary is closed and the rating band is 1..5', () => {
  assert.deepEqual([...APP_REVIEW_VERDICTS], ['positive', 'mixed', 'negative']);
  assert.equal(APP_REVIEW_RATING_MIN, 1);
  assert.equal(APP_REVIEW_RATING_MAX, 5);
});

test('MKT-050 unit: the publisher classification derives svc: first-party vs dev: community', () => {
  assert.deepEqual([...MARKETPLACE_PUBLISHER_KINDS].sort(), ['community', 'first-party']);
  assert.equal(derivePublisherKind('svc:mos-core'), 'first-party');
  assert.equal(derivePublisherKind('dev:0b6f19a9-0000-4000-8000-000000000001'), 'community');
});

// ---------------------------------------------------------------------------
// The policy-eligibility derivation (AC-5 — the policy-consumable vocabulary)
// ---------------------------------------------------------------------------

test('MKT-050 unit: the policy attribute vocabulary is the /policies rule-matching shape', () => {
  const attributes = buildPolicyAttributes({
    trustLevel: 'MOS_CERTIFIED',
    transitionCount: 2,
    reviewCount: 3,
    averageRating: 4.7,
  });
  assert.deepEqual(attributes, {
    certificationState: 'MOS_CERTIFIED',
    transitionCount: '2',
    reviewCount: '3',
    averageRating: '4.7',
  });
  // The no-reviews case is the honest 'none' string (never a fabricated value).
  assert.equal(
    buildPolicyAttributes({
      trustLevel: 'UNVERIFIED',
      transitionCount: 0,
      reviewCount: 0,
      averageRating: null,
    }).averageRating,
    'none',
  );
});

// ---------------------------------------------------------------------------
// The input guards (fail-closed, zero state touched)
// ---------------------------------------------------------------------------

function expectInvalid(block: () => void, fragment: string): void {
  let caught: unknown = null;
  try {
    block();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InvalidRequestError, `expected InvalidRequestError, got ${String(caught)}`);
  const details = (caught as InvalidRequestError).details ?? [];
  assert.ok(
    [...(details as readonly string[]), (caught as InvalidRequestError).message].some((line) =>
      line.includes(fragment),
    ),
    `expected a problem naming '${fragment}', got: ${JSON.stringify(details)} / ${(caught as InvalidRequestError).message}`,
  );
}

test('MKT-050 unit: the transition input guard validates the closed label vocabulary and bounded fields', () => {
  const valid = {
    appKey: 'crm-connector',
    transition: 'verify',
    reason: 'community review completed',
    idempotencyKey: 'trust-1',
  };
  assert.doesNotThrow(() => assertValidTransitionInput(valid));
  expectInvalid(
    () => assertValidTransitionInput({ ...valid, transition: 'self-certify' }),
    'closed vocabulary',
  );
  expectInvalid(() => assertValidTransitionInput({ ...valid, appKey: 'Bad_Key' }), 'appKey');
  expectInvalid(() => assertValidTransitionInput({ ...valid, reason: '' }), 'reason');
  expectInvalid(() => assertValidTransitionInput({ ...valid, reason: 'x'.repeat(513) }), 'reason');
  expectInvalid(() => assertValidTransitionInput({ ...valid, idempotencyKey: '' }), 'idempotencyKey');
});

test('MKT-050 unit: the review input guard validates the closed rating band, verdict vocabulary and bounded body', () => {
  const valid = {
    appKey: 'crm-connector',
    appVersionId: null,
    rating: 4,
    verdict: 'positive',
    body: 'works well for our pipeline',
    idempotencyKey: 'review-1',
  };
  assert.doesNotThrow(() => assertValidReviewInput(valid));
  // Version-level target must be a uuid (or null).
  assert.doesNotThrow(() =>
    assertValidReviewInput({
      ...valid,
      appVersionId: '0b6f19a9-1234-4abc-8def-0123456789ab',
    }),
  );
  expectInvalid(
    () => assertValidReviewInput({ ...valid, appVersionId: 'not-a-uuid' }),
    'appVersionId',
  );
  // The closed rating band.
  expectInvalid(() => assertValidReviewInput({ ...valid, rating: 0 }), 'rating');
  expectInvalid(() => assertValidReviewInput({ ...valid, rating: 6 }), 'rating');
  expectInvalid(() => assertValidReviewInput({ ...valid, rating: 3.5 }), 'rating');
  // The closed verdict vocabulary.
  expectInvalid(() => assertValidReviewInput({ ...valid, verdict: 'great' }), 'verdict');
  // The bounded body.
  expectInvalid(() => assertValidReviewInput({ ...valid, body: '' }), 'body');
  expectInvalid(() => assertValidReviewInput({ ...valid, body: 'x'.repeat(2001) }), 'body');
});

test('MKT-050 unit: the provenance guard rejects malformed server-derived blocks', () => {
  assert.doesNotThrow(() =>
    assertValidMarketplaceProvenance({
      actor: 'user:0b6f19a9-1234-4abc-8def-0123456789ab',
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
    }),
  );
  expectInvalid(() => assertValidMarketplaceProvenance({ actor: '', recordedVia: 'api', correlationId: 'c' }), 'actor');
  expectInvalid(
    () => assertValidMarketplaceProvenance({ actor: 'user:x', recordedVia: 'api', correlationId: '' }),
    'correlationId',
  );
});

test('MKT-050 unit: the listing filter guard enforces the closed trust-level and publisher-kind vocabularies', () => {
  assert.doesNotThrow(() =>
    assertValidMarketplaceFilters({
      category: 'run',
      trustLevel: 'MOS_CERTIFIED',
      publisherKind: 'first-party',
      search: 'crm',
    }),
  );
  assert.doesNotThrow(() =>
    assertValidMarketplaceFilters({ category: null, trustLevel: null, publisherKind: null, search: null }),
  );
  expectInvalid(
    () => assertValidMarketplaceFilters({ category: null, trustLevel: 'TRUSTED', publisherKind: null, search: null }),
    'frozen trust vocabulary',
  );
  expectInvalid(
    () => assertValidMarketplaceFilters({ category: null, trustLevel: null, publisherKind: 'third-party', search: null }),
    'closed vocabulary',
  );
  expectInvalid(
    () => assertValidMarketplaceFilters({ category: null, trustLevel: null, publisherKind: null, search: 'x'.repeat(65) }),
    'search',
  );
});

// ---------------------------------------------------------------------------
// The §8-style create fingerprints + the replay convergence
// ---------------------------------------------------------------------------

test('MKT-050 unit: the create fingerprints are deterministic and content-divergent', () => {
  const content = {
    appKey: 'crm-connector',
    transition: 'verify',
    reason: 'community review completed',
  };
  const a = trustEventCreateFingerprint(content);
  const b = trustEventCreateFingerprint({ ...content });
  assert.equal(a, b, 'identical content produces the identical digest');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, trustEventCreateFingerprint({ ...content, reason: 'second review' }));

  const reviewContent = {
    appKey: 'crm-connector',
    appVersionId: null,
    rating: 5,
    verdict: 'positive',
    body: 'great',
  };
  const r1 = appReviewCreateFingerprint(reviewContent);
  assert.equal(r1, appReviewCreateFingerprint({ ...reviewContent }));
  assert.notEqual(r1, appReviewCreateFingerprint({ ...reviewContent, rating: 4 }));
  assert.notEqual(
    r1,
    appReviewCreateFingerprint({ ...reviewContent, appVersionId: '0b6f19a9-1234-4abc-8def-0123456789ab' }),
  );
});

test('MKT-050 unit: replayOrConflict converges identical keys and conflicts divergent reuse', () => {
  const recorded = { createFingerprint: 'fp-1', eventId: 'e-1' };
  assert.deepEqual(replayOrConflict('k-1', null, 'fp-1'), { replayed: false });
  assert.deepEqual(replayOrConflict('k-1', recorded, 'fp-1'), {
    replayed: true,
    record: recorded,
  });
  assert.throws(
    () => replayOrConflict('k-1', recorded, 'fp-2'),
    /k-1/,
    'a divergent reuse of a §8 key is a conflict',
  );
});

test('MKT-050 unit: the write-conflict classification maps the DB fences to the domain conflicts', () => {
  assert.equal(
    classifyMarketplaceWriteConflict({
      code: '23505',
      constraint: 'trust_events_idempotency_key_unique',
    }),
    'idempotency-fence',
  );
  assert.equal(
    classifyMarketplaceWriteConflict({
      code: '23505',
      constraint: 'app_reviews_idempotency_key_unique',
    }),
    'idempotency-fence',
  );
  assert.equal(
    classifyMarketplaceWriteConflict({ code: '23505', constraint: 'trust_events_seq_unique' }),
    'seq-fence',
  );
  assert.equal(classifyMarketplaceWriteConflict({ code: '23514' }), 'validation-backstop');
  assert.equal(classifyMarketplaceWriteConflict({ code: 'P0001' }), 'validation-backstop');
  assert.equal(classifyMarketplaceWriteConflict({ code: '42P01' }), null);
});

test('MKT-050 unit: the material-shaped key backstop is the shared §21 set', () => {
  assert.ok(MARKETPLACE_MATERIAL_SHAPED_KEYS.includes('secret'));
  assert.ok(MARKETPLACE_MATERIAL_SHAPED_KEYS.includes('apiKey'));
  assert.ok(MARKETPLACE_MATERIAL_SHAPED_KEYS.includes('credentialValue'));
});
