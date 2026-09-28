/**
 * MKT-061 unit tests — the X capability-matrix registration discipline
 * on the frozen MKT-056 contract (pure, no DB — the
 * social-adapter-tiktok.test.ts precedent): the honest declaration
 * (ALL FIVE frozen families with the closed per-family operation
 * vocabularies and the REAL documented X OAuth 2.0 scope names — the
 * verified live set: users.read, tweet.read, tweet.write, media.write)
 * PASSES the frozen registration guards, and every ILLEGAL mutation of
 * the X declaration FAILS CLOSED LOUDLY (unknown family / unknown
 * operation / wrong-family operation / duplicate family / declared
 * operation without its implementing method / empty matrix / malformed
 * scope / an ILLEGALLY narrowed operation set — the honest-subset
 * enforcement at construction).
 *
 * The unit battery exercises the x-shaped matrices through the PUBLIC
 * contract guards (tests may import module public entries only — the
 * arch-check TEST_MODULE_INTERNAL_IMPORT rule); the REAL adapter's
 * declared matrix, its documented API mapping and its full behavior are
 * pinned END-TO-END by the integration battery
 * (tests/integration/social-adapter-x.test.ts) against the disclosed
 * in-memory + loopback HTTP platform doubles.
 *
 * DISCLOSED scope verification (the live scope list of the OpenAPI
 * securitySchemes + the OAuth 2.0 Authorization Code Flow with PKCE
 * reference, https://docs.x.com/x-api/fundamentals/authentication/oauth-2-0/authorization-code,
 * verified at delivery time): the REAL documented scope names of the
 * mapped endpoints are users.read + tweet.read (the users/me reads),
 * tweet.read + users.read (the post reads/timelines/search/analytics)
 * and tweet.read + tweet.write + users.read (POST /2/tweets) +
 * media.write (the media upload endpoints); offline.access ("Request a
 * refresh token for the app") provisions the MKT-055 refresh round's
 * refresh token and is deliberately NOT a capability requiredScope (no
 * adapter operation requires it — it rides the authorized grant).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import type {
  SocialCapability,
  SocialPlatformAdapter,
} from '../../src/modules/social-accounts/public.ts';
import {
  SOCIAL_CAPABILITY_FAMILIES,
  assertValidSocialPublishRequest,
  buildSocialAdapterRegistry,
  socialAdapterRegistrationProblems,
  socialCapabilityScopeSatisfaction,
  socialScopeProblem,
} from '../../src/modules/social-accounts/public.ts';

// ---------------------------------------------------------------------------
// The X declaration (the honest matrix the real adapter declares)
// ---------------------------------------------------------------------------

/** The REAL documented X OAuth 2.0 scope names (the verified live scope set). */
const USERS_READ = 'users.read';
const TWEET_READ = 'tweet.read';
const TWEET_WRITE = 'tweet.write';
const MEDIA_WRITE = 'media.write';

/** The full-scope X grant (the conformance fixture vocabulary of the MKT-061 run; offline.access rides the grant, no operation requires it). */
const FULL_GRANT = [USERS_READ, TWEET_READ, TWEET_WRITE, MEDIA_WRITE] as const;
/** The read-only X grant (publish refuses pre-flight — tweet.write + media.write are missing). */
const READ_ONLY_GRANT = [USERS_READ, TWEET_READ] as const;

/** The honest X capability matrix — ALL FIVE frozen families (mirrors the real adapter declaration). */
function xCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [USERS_READ, TWEET_READ],
      description: 'X account identity binding + profile reads over the documented Get Users Me endpoint (unit-declared mirror; verified/verified_type badges, not a timestamp; the subscription_type account-tier label rides accountKind).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [TWEET_READ, USERS_READ],
      description: 'Content reads over the documented Posts surfaces (unit-declared mirror; search/recent + the user timeline + the single-Post lookup; the public_metrics engagement facts ride as observed facts).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [TWEET_READ, USERS_READ],
      description: 'Observed metric points over the documented analytics surfaces (unit-declared mirror; users/me public_metrics labels + the tweets/analytics engagement labels, verbatim).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [TWEET_READ, TWEET_WRITE, USERS_READ, MEDIA_WRITE],
      description: 'The documented synchronous post-creation lifecycle (unit-declared mirror; the chunked media upload + POST /2/tweets; the host fence is the at-most-once identity; deletion is not supported at the frozen contract level).',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: [USERS_READ, TWEET_READ],
      description: 'The observable users/me entitlement facts as DATA (unit-declared mirror; protected/verified_type/subscription_type — never invented moderation state).',
    },
  ];
}

/** An X-shaped adapter under the registration guards (the declared operations implemented). */
function xAdapter(overrides?: {
  readonly capabilities?: readonly SocialCapability[];
  readonly omitMethod?: string;
}): SocialPlatformAdapter {
  const allMethods = {
    verifyAccountIdentity: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
    getAccountProfile: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
    discoverPublicContent: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
    listOwnContent: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
    getContent: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
    readAccountAnalytics: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
    readContentAnalytics: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
    submitPublish: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
    getPublishStatus: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
    readRestrictionSignals: async () => ({ ok: false as const, failure: { code: 'provider-unavailable' as const, message: 'unit', rateLimit: null } }),
  } as Record<string, unknown>;
  if (overrides?.omitMethod !== undefined) {
    const omitted = Object.fromEntries(
      Object.entries(allMethods).filter(([key]) => key !== overrides.omitMethod),
    );
    return {
      descriptor: {
        adapterKey: 'x',
        providerLabel: 'X (API v2 — OAuth 2.0 user context)',
        description: 'The unit-declared X mirror (the real adapter lives in the internal adapter subtree).',
      },
      capabilities: overrides?.capabilities ?? xCapabilities(),
      ...omitted,
    } as unknown as SocialPlatformAdapter;
  }
  return {
    descriptor: {
      adapterKey: 'x',
      providerLabel: 'X (API v2 — OAuth 2.0 user context)',
      description: 'The unit-declared X mirror (the real adapter lives in the internal adapter subtree).',
    },
    capabilities: overrides?.capabilities ?? xCapabilities(),
    ...allMethods,
  } as unknown as SocialPlatformAdapter;
}

// ---------------------------------------------------------------------------
// The honest declaration passes the frozen guards
// ---------------------------------------------------------------------------

test('MKT-061: the honest X capability matrix passes the frozen registration guards', () => {
  const problems = socialAdapterRegistrationProblems(xAdapter());
  assert.deepEqual(problems, [], 'the X 5-of-5 declaration is first-class');
  // The registry builder accepts it (and the duplicate key still refuses).
  const registry = buildSocialAdapterRegistry([xAdapter()]);
  assert.ok(registry.has('x'));
  assert.throws(
    () => buildSocialAdapterRegistry([xAdapter(), xAdapter()]),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('duplicate')),
    'a duplicate X registration is refused fail-closed',
  );
});

test('MKT-061: the declared families are the honest ALL-FIVE set with the closed per-family operation vocabularies', () => {
  const capabilities = xCapabilities();
  assert.deepEqual(
    capabilities.map((capability) => capability.family),
    ['account', 'content-read', 'analytics-read', 'publish', 'restriction-signals'],
    'the documented X surface honestly supports ALL FIVE families — the restriction-signals family is served by the observable users/me entitlement facts (the provider exposes no dedicated eligibility-query endpoint; hidden moderation state is never invented, §11)',
  );
  const operationsOf = (family: string): readonly string[] =>
    capabilities.find((capability) => capability.family === family)!.operations;
  assert.deepEqual(operationsOf('account'), ['verifyAccountIdentity', 'getAccountProfile']);
  assert.deepEqual(operationsOf('content-read'), ['discoverPublicContent', 'listOwnContent', 'getContent']);
  assert.deepEqual(operationsOf('analytics-read'), ['readAccountAnalytics', 'readContentAnalytics']);
  assert.deepEqual(operationsOf('publish'), ['submitPublish', 'getPublishStatus']);
  assert.deepEqual(operationsOf('restriction-signals'), ['readRestrictionSignals']);
  assert.equal(SOCIAL_CAPABILITY_FAMILIES.length, 5);
});

// ---------------------------------------------------------------------------
// The fail-closed registration discipline (the 056 discipline on the X shape)
// ---------------------------------------------------------------------------

test('MKT-061: an UNKNOWN family in the X declaration fails construction loudly', () => {
  const mutated = xAdapter({
    capabilities: [
      ...xCapabilities().slice(0, 4),
      { family: 'bookmarks-read', operations: ['listBookmarks'], requiredScopes: [], description: 'Not a frozen family.' },
    ] as unknown as readonly SocialCapability[],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'bookmarks-read' is not a social capability family")));
});

test('MKT-061: an UNKNOWN operation in the X declaration fails construction loudly', () => {
  const capabilities = xCapabilities();
  const mutated = xAdapter({
    capabilities: [
      ...capabilities.slice(0, 1),
      { ...capabilities[1]!, operations: ['discoverPublicContent', 'listOwnContent', 'getContent', 'boostPost'] } as unknown as SocialCapability,
      ...capabilities.slice(2),
    ],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'boostPost' is not a social operation key")));
});

test('MKT-061: a WRONG-FAMILY operation in the X declaration fails construction loudly', () => {
  const capabilities = xCapabilities();
  const mutated = xAdapter({
    capabilities: [
      ...capabilities.slice(0, 4),
      {
        ...capabilities[4]!,
        // submitPublish belongs to the publish family — declaring it
        // under restriction-signals is refused.
        operations: ['readRestrictionSignals', 'submitPublish'],
      } as unknown as SocialCapability,
    ],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(
    problems.some((problem) => problem.includes("'submitPublish' belongs to family 'publish', not 'restriction-signals'")),
  );
});

test('MKT-061: a DUPLICATE family declaration fails construction loudly', () => {
  const capabilities = xCapabilities();
  const mutated = xAdapter({
    capabilities: [...capabilities, { ...capabilities[0]!, operations: ['verifyAccountIdentity'], requiredScopes: [], description: 'Duplicate account family.' } as unknown as SocialCapability],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('duplicate family declaration')));
});

test('MKT-061: a declared operation WITHOUT its implementing method fails construction loudly', () => {
  const mutated = xAdapter({ omitMethod: 'getPublishStatus' });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(
    problems.some((problem) => problem.includes("declares operation 'getPublishStatus' but the adapter does not implement")),
  );
});

test('MKT-061: an EMPTY capability matrix is not a subset — it fails construction loudly', () => {
  const mutated = xAdapter({ capabilities: [] });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('a non-empty capability list is required')));
});

test('MKT-061: a malformed required scope fails construction loudly', () => {
  const capabilities = xCapabilities();
  const mutated = xAdapter({
    capabilities: [
      ...capabilities.slice(0, 3),
      { ...capabilities[3]!, requiredScopes: [''] },
      ...capabilities.slice(4),
    ],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('must be a non-empty provider scope string')));
});

// ---------------------------------------------------------------------------
// The operation-level capability subset (the 056 discipline: an
// operation-level subset is first-class, a declared family with a
// narrowed operation set is legal — the undeclared operation refuses at
// runtime through the host, and an ILLEGAL declaration still fails
// construction)
// ---------------------------------------------------------------------------

test('MKT-061: an operation-level SUBSET of a declared family passes construction (the narrowed content-read set is first-class)', () => {
  const capabilities = xCapabilities();
  const narrowed = xAdapter({
    capabilities: [
      ...capabilities.slice(0, 1),
      { ...capabilities[1]!, operations: ['listOwnContent', 'getContent'] },
      ...capabilities.slice(2),
    ],
  });
  const problems = socialAdapterRegistrationProblems(narrowed);
  assert.deepEqual(problems, [], 'a narrowed operation subset of a declared family is a first-class legal declaration');
});

// ---------------------------------------------------------------------------
// The REAL scope names against the strict social scope convention
// ---------------------------------------------------------------------------

test('MKT-061: the REAL documented X OAuth 2.0 scope names compose against the strict scope convention', () => {
  // The full grant satisfies every declared capability.
  const full = socialCapabilityScopeSatisfaction(xCapabilities(), [...FULL_GRANT]);
  assert.deepEqual(
    full.map((entry) => [entry.family, entry.satisfied]),
    [
      ['account', true],
      ['content-read', true],
      ['analytics-read', true],
      ['publish', true],
      ['restriction-signals', true],
    ],
  );
  for (const capability of xCapabilities()) {
    assert.equal(socialScopeProblem(capability, [...FULL_GRANT]), null);
  }
  // The read-only grant: the read families stay satisfied, the publish
  // family (tweet.write + media.write gated) refuses with the missing
  // REAL scopes.
  const readOnly = socialCapabilityScopeSatisfaction(xCapabilities(), [...READ_ONLY_GRANT]);
  const byFamily = new Map(readOnly.map((entry) => [entry.family, entry]));
  assert.equal(byFamily.get('account')!.satisfied, true);
  assert.equal(byFamily.get('content-read')!.satisfied, true);
  assert.equal(byFamily.get('analytics-read')!.satisfied, true);
  assert.equal(byFamily.get('restriction-signals')!.satisfied, true);
  assert.equal(byFamily.get('publish')!.satisfied, false);
  assert.deepEqual(
    byFamily.get('publish')!.missingScopes,
    [TWEET_WRITE, MEDIA_WRITE],
    'the publish family refuses with BOTH missing REAL scopes (tweet.write + media.write)',
  );
  // The strict pre-flight problem names the missing REAL scopes verbatim.
  const publish = xCapabilities().find((capability) => capability.family === 'publish')!;
  const problem = socialScopeProblem(publish, [...READ_ONLY_GRANT]);
  assert.ok(problem !== null && problem.includes(TWEET_WRITE) && problem.includes(MEDIA_WRITE));
});

// ---------------------------------------------------------------------------
// The X-shaped publish request against the frozen request guard
// ---------------------------------------------------------------------------

test('MKT-061: the X post-creation publish requests pass the frozen request guard (and §21 refuses material)', () => {
  // The documented post-creation mapping: the provider-shaped payload
  // params + the media-asset URL descriptor of the documented chunked
  // upload (scheduledFor is honestly unused — the documented creation
  // surface exposes no scheduling parameter).
  assertValidSocialPublishRequest({
    contentType: 'x.post',
    payload: {
      text: 'Shipping the fifth adapter of the frozen contract — honest capability matrices all the way down.',
      replySettings: 'everyone',
      madeWithAi: false,
      paidPartnership: false,
    },
    mediaAssets: [
      {
        assetReference: 'content-asset:ca:fixture-x-1',
        mediaKind: 'image',
        descriptor: { filename: 'card.png', mime: 'image/png', url: 'https://cdn.example.com/card.png' },
      },
    ],
    attribution: { missionId: 'mission-x-1', experimentId: 'exp-x-1' },
    scheduledFor: null,
  });
  // A minimal text-only request (the documented creation needs no
  // media).
  assertValidSocialPublishRequest({
    contentType: 'x.post',
    payload: { text: 'A fixture text post' },
    mediaAssets: [],
    attribution: {},
    scheduledFor: null,
  });
  // The §21 backstop refuses material-shaped payloads (the frozen guard).
  assert.throws(
    () =>
      assertValidSocialPublishRequest({
        contentType: 'x.post',
        payload: { text: 'Bad', accessToken: 'ey1234567890abcdefghij' },
        mediaAssets: [],
        attribution: {},
        scheduledFor: null,
      }),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('material-shaped')),
    'the §21 backstop refuses the material-shaped payload',
  );
});
