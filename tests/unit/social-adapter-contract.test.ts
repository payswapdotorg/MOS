/**
 * MKT-056 unit tests — the pure contract surface of the normalized
 * social platform adapter contract: the frozen vocabularies (families,
 * per-family operations, failure taxonomy, publish states), the
 * registration/scope/operation guards and the registry builder (no DB;
 * the pinning proof — the vocabularies agree with the migration-050
 * CHECKs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import type {
  SocialAccountProvenance,
  SocialCapability,
  SocialPlatformAdapter,
} from '../../src/modules/social-accounts/public.ts';
import {
  SOCIAL_ACCOUNT_OPERATIONS,
  SOCIAL_ADAPTER_FAILURE_CODES,
  SOCIAL_ANALYTICS_READ_OPERATIONS,
  SOCIAL_CAPABILITY_FAMILIES,
  SOCIAL_CONTENT_READ_OPERATIONS,
  SOCIAL_FAMILY_OPERATIONS,
  SOCIAL_OPERATION_KEYS,
  SOCIAL_PUBLISH_FILL_TRANSITIONS,
  SOCIAL_PUBLISH_OPERATIONS,
  SOCIAL_PUBLISH_STATES,
  SOCIAL_RESTRICTION_SIGNAL_OPERATIONS,
  adapterCapabilityForOperation,
  assertValidSocialAnalyticsWindow,
  assertValidSocialContentAnalyticsInput,
  assertValidSocialContentDiscoveryQuery,
  assertValidSocialContentListQuery,
  assertValidSocialContentReadInput,
  assertValidSocialIdempotencyKey,
  assertValidSocialPublishRequest,
  assertValidSocialPublishStatusInput,
  assertValidSocialRateLimitObservation,
  buildSocialAdapterRegistry,
  isKnownSocialFailureCode,
  isLegalSocialPublishFill,
  isRetryableSocialFailure,
  socialAdapterRegistrationProblems,
  socialCapabilityOf,
  socialCapabilityScopeSatisfaction,
  socialOperationFamilyOf,
  socialScopeProblem,
} from '../../src/modules/social-accounts/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (the migration-050 CHECK mirror)
// ---------------------------------------------------------------------------

test('MKT-056 vocabulary pinning: the frozen five capability families', () => {
  assert.deepEqual(SOCIAL_CAPABILITY_FAMILIES, [
    'account',
    'content-read',
    'analytics-read',
    'publish',
    'restriction-signals',
  ]);
});

test('MKT-056 vocabulary pinning: the closed per-family operation vocabularies (no overlap, total union)', () => {
  assert.deepEqual(SOCIAL_ACCOUNT_OPERATIONS, ['verifyAccountIdentity', 'getAccountProfile']);
  assert.deepEqual(SOCIAL_CONTENT_READ_OPERATIONS, ['discoverPublicContent', 'listOwnContent', 'getContent']);
  assert.deepEqual(SOCIAL_ANALYTICS_READ_OPERATIONS, ['readAccountAnalytics', 'readContentAnalytics']);
  assert.deepEqual(SOCIAL_PUBLISH_OPERATIONS, ['submitPublish', 'getPublishStatus']);
  assert.deepEqual(SOCIAL_RESTRICTION_SIGNAL_OPERATIONS, ['readRestrictionSignals']);
  // The family table is exhaustive over the families and the union has
  // no duplicates (an operation belongs to exactly one family).
  const union = SOCIAL_CAPABILITY_FAMILIES.flatMap((family) => [...SOCIAL_FAMILY_OPERATIONS[family]]);
  assert.deepEqual([...union].sort(), [...SOCIAL_OPERATION_KEYS].sort());
  assert.equal(new Set(union).size, union.length, 'no operation appears under two families');
  // The family lookup agrees with the table.
  for (const family of SOCIAL_CAPABILITY_FAMILIES) {
    for (const operation of SOCIAL_FAMILY_OPERATIONS[family]) {
      assert.equal(socialOperationFamilyOf(operation), family);
    }
  }
  assert.equal(socialOperationFamilyOf('notAnOperation'), null);
});

test('MKT-056 vocabulary pinning: the seven-code error taxonomy + the retryability derivation', () => {
  assert.deepEqual(SOCIAL_ADAPTER_FAILURE_CODES, [
    'auth-expired',
    'rate-limited',
    'restricted',
    'policy-denied',
    'provider-unavailable',
    'unsupported-capability',
    'insufficient-scope',
  ]);
  for (const code of SOCIAL_ADAPTER_FAILURE_CODES) {
    assert.ok(isKnownSocialFailureCode(code));
  }
  assert.ok(!isKnownSocialFailureCode('not-a-code'));
  // Only quota/backoff observations and transport failures retry as-is.
  assert.equal(isRetryableSocialFailure('rate-limited'), true);
  assert.equal(isRetryableSocialFailure('provider-unavailable'), true);
  assert.equal(isRetryableSocialFailure('auth-expired'), false);
  assert.equal(isRetryableSocialFailure('restricted'), false);
  assert.equal(isRetryableSocialFailure('policy-denied'), false);
  assert.equal(isRetryableSocialFailure('unsupported-capability'), false);
  assert.equal(isRetryableSocialFailure('insufficient-scope'), false);
});

test('MKT-056 vocabulary pinning: the publish lifecycle (born submitted; the single fill; terminal states)', () => {
  assert.deepEqual(SOCIAL_PUBLISH_STATES, ['submitted', 'accepted', 'published', 'failed', 'restricted']);
  assert.deepEqual(SOCIAL_PUBLISH_FILL_TRANSITIONS, {
    submitted: ['accepted', 'published', 'failed', 'restricted'],
    accepted: [],
    published: [],
    failed: [],
    restricted: [],
  });
  for (const to of ['accepted', 'published', 'failed', 'restricted'] as const) {
    assert.ok(isLegalSocialPublishFill('submitted', to));
  }
  for (const from of ['accepted', 'published', 'failed', 'restricted'] as const) {
    for (const to of SOCIAL_PUBLISH_STATES) {
      assert.ok(!isLegalSocialPublishFill(from, to), `a filled attempt (${from}) never transitions again`);
    }
  }
  assert.ok(!isLegalSocialPublishFill('submitted', 'submitted'));
});

// ---------------------------------------------------------------------------
// The registration guards + the registry builder
// ---------------------------------------------------------------------------

const ACCOUNT_CAPABILITY: SocialCapability = {
  family: 'account',
  operations: ['verifyAccountIdentity', 'getAccountProfile'],
  requiredScopes: ['account:read'],
  description: 'The account family (unit fixture).',
};
const CONTENT_CAPABILITY: SocialCapability = {
  family: 'content-read',
  operations: ['listOwnContent', 'getContent'],
  requiredScopes: ['content:read'],
  description: 'The content family without public discovery (unit fixture — a subset of the family operations).',
};

function wellFormedAdapter(capabilities: readonly SocialCapability[]): SocialPlatformAdapter {
  const adapter: Record<string, unknown> = {
    descriptor: {
      adapterKey: 'unit-platform',
      providerLabel: 'Unit Platform',
      description: 'A well-formed unit-test adapter.',
    },
    capabilities,
    verifyAccountIdentity: async () => ({ ok: true, identity: { externalAccountId: 'x', displayIdentity: 'x', verifiedAt: null }, rateLimit: null }),
    getAccountProfile: async () => ({ ok: false, failure: { code: 'provider-unavailable' as const, message: 'x', rateLimit: null } }),
    listOwnContent: async () => ({ ok: true, page: { records: [], pageCursor: null }, rateLimit: null }),
    getContent: async () => ({ ok: true, record: null, rateLimit: null }),
  };
  return adapter as unknown as SocialPlatformAdapter;
}

test('MKT-056 registration: a well-formed capability-subset adapter registers cleanly', () => {
  const adapter = wellFormedAdapter([ACCOUNT_CAPABILITY, CONTENT_CAPABILITY]);
  assert.deepEqual(socialAdapterRegistrationProblems(adapter), []);
  const registry = buildSocialAdapterRegistry([adapter]);
  assert.equal(registry.size, 1);
  assert.ok(registry.has('unit-platform'));
});

test('MKT-056 registration: unknown families/operations and wrong-family operations fail LOUDLY (fail-closed)', () => {
  // An operation of the WRONG family.
  const wrongFamily: SocialCapability = { ...CONTENT_CAPABILITY, operations: ['readAccountAnalytics'] };
  const problemsA = socialAdapterRegistrationProblems(wellFormedAdapter([ACCOUNT_CAPABILITY, wrongFamily]));
  assert.ok(problemsA.some((p) => p.includes("belongs to family 'analytics-read'")), problemsA.join('; '));
  // An operation key outside the closed vocabulary entirely.
  const unknownOperation = { ...CONTENT_CAPABILITY, operations: ['teleportContent'] } as unknown as SocialCapability;
  const problemsB = socialAdapterRegistrationProblems(wellFormedAdapter([ACCOUNT_CAPABILITY, unknownOperation]));
  assert.ok(problemsB.some((p) => p.includes('is not a social operation key')), problemsB.join('; '));
  // An unknown family.
  const unknownFamily = { family: 'teleport', operations: ['getContent'], requiredScopes: [], description: 'x' } as unknown as SocialCapability;
  const problemsC = socialAdapterRegistrationProblems(wellFormedAdapter([ACCOUNT_CAPABILITY, unknownFamily]));
  assert.ok(problemsC.some((p) => p.includes('is not a social capability family')), problemsC.join('; '));
  // A duplicate family declaration.
  const problemsD = socialAdapterRegistrationProblems(
    wellFormedAdapter([ACCOUNT_CAPABILITY, { ...ACCOUNT_CAPABILITY, operations: ['getAccountProfile'] }]),
  );
  assert.ok(problemsD.some((p) => p.includes('duplicate family declaration')), problemsD.join('; '));
  // An EMPTY capability list is refused (a platform declares at least one family).
  const problemsE = socialAdapterRegistrationProblems(wellFormedAdapter([]));
  assert.ok(problemsE.some((p) => p.includes('non-empty capability list is required')), problemsE.join('; '));
});

test('MKT-056 registration: a declared operation WITHOUT its implementing method is refused (fail-closed)', () => {
  const adapter = wellFormedAdapter([ACCOUNT_CAPABILITY, { ...CONTENT_CAPABILITY, operations: ['discoverPublicContent'] }]);
  const problems = socialAdapterRegistrationProblems(adapter);
  assert.ok(
    problems.some((p) => p.includes("declares operation 'discoverPublicContent' but the adapter does not implement")),
    problems.join('; '),
  );
});

test('MKT-056 registration: duplicate adapter keys fail the registry construction LOUDLY', () => {
  const a = wellFormedAdapter([ACCOUNT_CAPABILITY]);
  const b = wellFormedAdapter([ACCOUNT_CAPABILITY]);
  assert.throws(
    () => buildSocialAdapterRegistry([a, b]),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('duplicate social platform adapter registration')),
    'one adapter per platform key, fail-closed',
  );
});

test('MKT-056 registration: malformed descriptors and shapes fail loudly', () => {
  const badKey = wellFormedAdapter([ACCOUNT_CAPABILITY]) as unknown as Record<string, unknown>;
  badKey.descriptor = { adapterKey: 'BAD KEY', providerLabel: 'x', description: 'x' };
  const problemsA = socialAdapterRegistrationProblems(badKey as unknown as SocialPlatformAdapter);
  assert.ok(problemsA.some((p) => p.includes('descriptor.adapterKey')), problemsA.join('; '));

  const badScopes = wellFormedAdapter([{ ...ACCOUNT_CAPABILITY, requiredScopes: ['ok', '   '] }]);
  const problemsB = socialAdapterRegistrationProblems(badScopes);
  assert.ok(problemsB.some((p) => p.includes('requiredScopes[1]')), problemsB.join('; '));

  const badDescription = wellFormedAdapter([{ ...ACCOUNT_CAPABILITY, description: '' }]);
  const problemsC = socialAdapterRegistrationProblems(badDescription);
  assert.ok(problemsC.some((p) => p.includes('description')), problemsC.join('; '));
});

// ---------------------------------------------------------------------------
// The capability lookups + the strict scope pre-check
// ---------------------------------------------------------------------------

test('MKT-056 capability lookups: the declared-subset resolution (parity never assumed)', () => {
  const adapter = wellFormedAdapter([ACCOUNT_CAPABILITY, CONTENT_CAPABILITY]);
  assert.equal(socialCapabilityOf(adapter, 'account'), ACCOUNT_CAPABILITY);
  assert.equal(socialCapabilityOf(adapter, 'publish'), null, 'the undeclared family resolves null');
  // The content family declares listOwnContent/getContent ONLY.
  assert.ok(adapterCapabilityForOperation(adapter, 'listOwnContent') !== null);
  assert.equal(
    adapterCapabilityForOperation(adapter, 'discoverPublicContent'),
    null,
    'an operation of a declared family but OUTSIDE the declared subset resolves null (unsupported)',
  );
  assert.equal(adapterCapabilityForOperation(adapter, 'submitPublish'), null);
});

test('MKT-056 scope pre-check: the STRICT verbatim subset semantics', () => {
  // Satisfied.
  assert.equal(socialScopeProblem(ACCOUNT_CAPABILITY, ['account:read', 'extra:scope']), null);
  // A required scope missing → fail-closed problem (the exact missing set).
  const problem = socialScopeProblem(ACCOUNT_CAPABILITY, ['content:read']);
  assert.ok(problem !== null && problem.includes('account:read') && problem.includes('missing'), problem ?? '');
  // The EMPTY granted list with required scopes → always refused.
  assert.ok(socialScopeProblem(ACCOUNT_CAPABILITY, []) !== null);
  // No requiredScopes → no adapter-side claim (the provider decides).
  assert.equal(socialScopeProblem({ ...ACCOUNT_CAPABILITY, requiredScopes: [] }, []), null);
});

test('MKT-056 scope satisfaction view: the per-capability composition', () => {
  const satisfaction = socialCapabilityScopeSatisfaction(
    [ACCOUNT_CAPABILITY, CONTENT_CAPABILITY],
    ['account:read'],
  );
  assert.deepEqual(
    satisfaction.map((s) => ({ family: s.family, satisfied: s.satisfied, missing: [...s.missingScopes] })),
    [
      { family: 'account', satisfied: true, missing: [] },
      { family: 'content-read', satisfied: false, missing: ['content:read'] },
    ],
  );
});

// ---------------------------------------------------------------------------
// The operation input guards (§21-backstopped)
// ---------------------------------------------------------------------------

const REQUEST = {
  contentType: 'reference-post',
  payload: { title: 'x' },
  mediaAssets: [{ assetReference: 'asset:1', mediaKind: 'video', descriptor: { filename: 'a.mp4' } }],
  attribution: { missionId: 'm1' },
  scheduledFor: null,
} as const;

test('MKT-056 input guards: the publish request shape + the §21 material-key backstop', () => {
  assertValidSocialPublishRequest(REQUEST);
  assertValidSocialPublishRequest({ ...REQUEST, scheduledFor: '2026-09-01T10:00:00.000Z' });
  // Material-shaped keys/values at ANY nesting level are refused.
  for (const bad of [
    { ...REQUEST, payload: { accessToken: 'x' } },
    { ...REQUEST, payload: { deep: { nested: { clientSecret: 'x' } } } },
    { ...REQUEST, payload: { tokenish: 'ey1234567890abcdefghij' } },
    { ...REQUEST, attribution: { password: 'x' } },
    { ...REQUEST, mediaAssets: [{ assetReference: 'a', mediaKind: 'v', descriptor: { apiKey: 'x' } }] },
  ]) {
    assert.throws(
      () => assertValidSocialPublishRequest(bad),
      (error: unknown) =>
        error instanceof InvalidRequestError &&
        (error.details ?? []).some((detail) => detail.includes('material-shaped')),
      'the §21 backstop refuses the material-shaped shape',
    );
  }
  // Shape guards: bad content type, too many assets, bad schedule.
  assert.throws(() => assertValidSocialPublishRequest({ ...REQUEST, contentType: 'BAD TYPE' }));
  assert.throws(() =>
    assertValidSocialPublishRequest({
      ...REQUEST,
      mediaAssets: Array.from({ length: 21 }, () => REQUEST.mediaAssets[0]!),
    }),
  );
  assert.throws(() => assertValidSocialPublishRequest({ ...REQUEST, scheduledFor: 'tomorrow' }));
});

test('MKT-056 input guards: the idempotency key, queries, windows and status inputs', () => {
  assertValidSocialIdempotencyKey('publish-1.0:a-b');
  for (const bad of ['', ' lead', 'trailing ', 'a'.repeat(129), 'key with spaces']) {
    assert.throws(() => assertValidSocialIdempotencyKey(bad), InvalidRequestError);
  }
  assertValidSocialContentDiscoveryQuery({ query: 'growth', pageCursor: null, limit: 10 });
  assertValidSocialContentDiscoveryQuery({ query: 'growth', pageCursor: 'page-2', limit: null });
  for (const bad of [
    { query: '', pageCursor: null, limit: null },
    { query: 'x'.repeat(201), pageCursor: null, limit: null },
    { query: 'q', pageCursor: 'bad cursor!', limit: null },
    { query: 'q', pageCursor: null, limit: 0 },
    { query: 'q', pageCursor: null, limit: 101 },
  ]) {
    assert.throws(() => assertValidSocialContentDiscoveryQuery(bad), InvalidRequestError);
  }
  assertValidSocialContentListQuery({ pageCursor: null, limit: 5 });
  assert.throws(() => assertValidSocialContentListQuery({ pageCursor: 'x'.repeat(257), limit: null }), InvalidRequestError);
  assertValidSocialContentReadInput({ providerContentId: 'abc' });
  assert.throws(() => assertValidSocialContentReadInput({ providerContentId: '' }), InvalidRequestError);
  assertValidSocialAnalyticsWindow({ windowStart: null, windowEnd: null });
  assertValidSocialAnalyticsWindow({ windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-31T00:00:00.000Z' });
  assert.throws(
    () => assertValidSocialAnalyticsWindow({ windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-08-01T00:00:00.000Z' }),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('must not precede')),
  );
  assertValidSocialContentAnalyticsInput({ providerContentIds: ['a', 'b'], windowStart: null, windowEnd: null });
  assert.throws(() => assertValidSocialContentAnalyticsInput({ providerContentIds: [], windowStart: null, windowEnd: null }), InvalidRequestError);
  assert.throws(
    () =>
      assertValidSocialContentAnalyticsInput({
        providerContentIds: Array.from({ length: 21 }, (_, i) => `id-${i}`),
        windowStart: null,
        windowEnd: null,
      }),
    InvalidRequestError,
  );
  assertValidSocialPublishStatusInput({ providerPublishId: 'job-1' });
  assert.throws(() => assertValidSocialPublishStatusInput({ providerPublishId: '' }), InvalidRequestError);
});

test('MKT-056 input guards: the rate-limit observation backstop', () => {
  assertValidSocialRateLimitObservation(null);
  assertValidSocialRateLimitObservation({ limitRemaining: 42, limitResetAt: '2026-08-01T00:00:00.000Z', backoffUntil: null, retryAfterSeconds: 5 });
  for (const bad of [
    { limitRemaining: Number.NaN, limitResetAt: null, backoffUntil: null, retryAfterSeconds: null },
    { limitRemaining: null, limitResetAt: 'nope', backoffUntil: null, retryAfterSeconds: null },
    { limitRemaining: null, limitResetAt: null, backoffUntil: null, retryAfterSeconds: -1 },
    { limitRemaining: null, limitResetAt: null, backoffUntil: null, retryAfterSeconds: 1.5 },
  ]) {
    assert.throws(() => assertValidSocialRateLimitObservation(bad), InvalidRequestError);
  }
});

// ---------------------------------------------------------------------------
// The provenance guard reuse (the module contract continuity)
// ---------------------------------------------------------------------------

test('MKT-056 provenance continuity: the SocialAccountProvenance guard shape stays the module contract', () => {
  const provenance: SocialAccountProvenance = {
    actor: 'user:018f6a2e-1000-7000-8000-000000000009',
    recordedVia: 'test',
    correlationId: 'corr-mkt-056',
    causationId: null,
  };
  assert.equal(provenance.recordedVia, 'test');
  assert.equal(typeof provenance.actor, 'string');
});
