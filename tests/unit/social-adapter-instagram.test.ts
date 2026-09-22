/**
 * MKT-058 unit tests — the INSTAGRAM capability-matrix registration
 * discipline on the frozen MKT-056 contract (pure, no DB — the
 * social-adapter-youtube.test.ts precedent): the honest SUBSET
 * declaration (FOUR of the five frozen families — the documented
 * Instagram surface supports account / content-read / analytics-read /
 * publish; the restriction-signals family is honestly UNDECLARED) with
 * the closed per-family operation vocabularies and the REAL Facebook
 * Login scope names PASSES the frozen registration guards, and every
 * ILLEGAL mutation of the Instagram declaration FAILS CLOSED LOUDLY
 * (unknown family / unknown operation / wrong-family operation /
 * duplicate family / declared operation without its implementing
 * method / empty matrix / malformed scope / an ILLEGALLY declared
 * restriction-signals family whose operation has no implementing
 * method — the honest-subset enforcement at construction).
 *
 * The unit battery exercises the instagram-shaped matrices through the
 * PUBLIC contract guards (tests may import module public entries only
 * — the arch-check TEST_MODULE_INTERNAL_IMPORT rule); the REAL
 * adapter's declared matrix, its documented API mapping and its full
 * behavior are pinned END-TO-END by the integration battery
 * (tests/integration/social-adapter-instagram.test.ts) against the
 * disclosed in-memory + loopback HTTP platform doubles.
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
// The Instagram declaration (the honest matrix the real adapter declares)
// ---------------------------------------------------------------------------

/** The REAL Facebook Login permission names (the documented Instagram Graph API scope surface). */
const INSTAGRAM_BASIC = 'instagram_basic';
const INSTAGRAM_CONTENT_PUBLISH = 'instagram_content_publish';
const INSTAGRAM_MANAGE_INSIGHTS = 'instagram_manage_insights';
const PAGES_SHOW_LIST = 'pages_show_list';
const PAGES_READ_ENGAGEMENT = 'pages_read_engagement';

/** The full-scope Instagram grant (the conformance fixture vocabulary of the MKT-058 run). */
const FULL_GRANT = [
  INSTAGRAM_BASIC,
  INSTAGRAM_CONTENT_PUBLISH,
  INSTAGRAM_MANAGE_INSIGHTS,
  PAGES_SHOW_LIST,
  PAGES_READ_ENGAGEMENT,
] as const;
/** The read-only Instagram grant (analytics + publish refuse pre-flight). */
const READ_ONLY_GRANT = [INSTAGRAM_BASIC, PAGES_SHOW_LIST, PAGES_READ_ENGAGEMENT] as const;

/** The honest Instagram capability matrix — 4 of the 5 frozen families (mirrors the real adapter declaration). */
function instagramCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [INSTAGRAM_BASIC, PAGES_SHOW_LIST],
      description: 'Instagram Professional account identity + profile reads over the documented IG User node (unit-declared mirror; the documented surface serves Business/Creator accounts only).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [INSTAGRAM_BASIC, PAGES_READ_ENGAGEMENT],
      description: 'Hashtag-scoped discovery + own-content listing + single reads over the documented Media surfaces (unit-declared mirror; no view/share counts — never fabricated).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [INSTAGRAM_BASIC, INSTAGRAM_MANAGE_INSIGHTS],
      description: 'Observed metric points over the documented Insights edges (unit-declared mirror; provider labels verbatim, lifetime media aggregates).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [INSTAGRAM_BASIC, INSTAGRAM_CONTENT_PUBLISH, PAGES_SHOW_LIST, PAGES_READ_ENGAGEMENT],
      description: 'The documented container-based two-step publish (unit-declared mirror; the 24h publish window; the host fence is the at-most-once identity).',
    },
  ];
}

/** An Instagram-shaped adapter under the registration guards (the declared operations implemented). */
function instagramAdapter(overrides?: {
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
        adapterKey: 'instagram',
        providerLabel: 'Instagram (Instagram Graph API, Professional accounts)',
        description: 'The unit-declared Instagram mirror (the real adapter lives in the internal adapter subtree).',
      },
      capabilities: overrides?.capabilities ?? instagramCapabilities(),
      ...omitted,
    } as unknown as SocialPlatformAdapter;
  }
  return {
    descriptor: {
      adapterKey: 'instagram',
      providerLabel: 'Instagram (Instagram Graph API, Professional accounts)',
      description: 'The unit-declared Instagram mirror (the real adapter lives in the internal adapter subtree).',
    },
    capabilities: overrides?.capabilities ?? instagramCapabilities(),
    ...allMethods,
  } as unknown as SocialPlatformAdapter;
}

// ---------------------------------------------------------------------------
// The honest declaration passes the frozen guards
// ---------------------------------------------------------------------------

test('MKT-058: the honest Instagram capability matrix passes the frozen registration guards', () => {
  const problems = socialAdapterRegistrationProblems(instagramAdapter());
  assert.deepEqual(problems, [], 'the Instagram 4-of-5 SUBSET declaration is first-class');
  // The registry builder accepts it (and the duplicate key still refuses).
  const registry = buildSocialAdapterRegistry([instagramAdapter()]);
  assert.ok(registry.has('instagram'));
  assert.throws(
    () => buildSocialAdapterRegistry([instagramAdapter(), instagramAdapter()]),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('duplicate')),
    'a duplicate Instagram registration is refused fail-closed',
  );
});

test('MKT-058: the declared families are the honest 4-of-5 SUBSET with the closed per-family operation vocabularies', () => {
  const capabilities = instagramCapabilities();
  assert.deepEqual(
    capabilities.map((capability) => capability.family),
    ['account', 'content-read', 'analytics-read', 'publish'],
    'the documented Instagram surface honestly supports FOUR families — restriction-signals is UNDECLARED (no documented restriction-signal endpoint; account-level limitations surface as invocation failures; hidden moderation state is never invented, §11)',
  );
  const operationsOf = (family: string): readonly string[] =>
    capabilities.find((capability) => capability.family === family)!.operations;
  assert.deepEqual(operationsOf('account'), ['verifyAccountIdentity', 'getAccountProfile']);
  assert.deepEqual(operationsOf('content-read'), ['discoverPublicContent', 'listOwnContent', 'getContent']);
  assert.deepEqual(operationsOf('analytics-read'), ['readAccountAnalytics', 'readContentAnalytics']);
  assert.deepEqual(operationsOf('publish'), ['submitPublish', 'getPublishStatus']);
  // The undeclared family is outside the declaration (the closed frozen
  // vocabulary of five — the subset is honest, not silent).
  assert.equal(SOCIAL_CAPABILITY_FAMILIES.length, 5);
  assert.ok(!capabilities.some((capability) => capability.family === 'restriction-signals'));
});

test('MKT-058: an ILLEGALLY declared restriction-signals family without its implementing method fails construction loudly (the honest-subset enforcement)', () => {
  // The real Instagram adapter declares NO restriction-signals
  // capability and implements NO readRestrictionSignals method — a
  // matrix that declares the family anyway is refused fail-closed.
  const capabilities = instagramCapabilities();
  const mutated = instagramAdapter({
    capabilities: [
      ...capabilities,
      {
        family: 'restriction-signals',
        operations: ['readRestrictionSignals'],
        requiredScopes: [INSTAGRAM_BASIC],
        description: 'An illegal declaration: the documented surface exposes no restriction-signal endpoint.',
      },
    ],
    omitMethod: 'readRestrictionSignals',
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(
    problems.some((problem) => problem.includes("declares operation 'readRestrictionSignals' but the adapter does not implement")),
    'the declared-but-unimplemented restriction-signals operation is refused loudly',
  );
});

// ---------------------------------------------------------------------------
// The fail-closed registration discipline (the 056 discipline on the Instagram shape)
// ---------------------------------------------------------------------------

test('MKT-058: an UNKNOWN family in the Instagram declaration fails construction loudly', () => {
  const mutated = instagramAdapter({
    capabilities: [
      ...instagramCapabilities().slice(0, 3),
      { family: 'engagement-write', operations: ['likeMedia'], requiredScopes: [], description: 'Not a frozen family.' },
    ] as unknown as readonly SocialCapability[],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'engagement-write' is not a social capability family")));
});

test('MKT-058: an UNKNOWN operation in the Instagram declaration fails construction loudly', () => {
  const capabilities = instagramCapabilities();
  const mutated = instagramAdapter({
    capabilities: [
      ...capabilities.slice(0, 1),
      { ...capabilities[1]!, operations: ['discoverPublicContent', 'listOwnContent', 'getContent', 'postComment'] } as unknown as SocialCapability,
      ...capabilities.slice(2),
    ],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'postComment' is not a social operation key")));
});

test('MKT-058: a WRONG-FAMILY operation in the Instagram declaration fails construction loudly', () => {
  const capabilities = instagramCapabilities();
  const mutated = instagramAdapter({
    capabilities: [
      ...capabilities.slice(0, 3),
      {
        ...capabilities[3]!,
        // readAccountAnalytics belongs to the analytics-read family —
        // declaring it under publish is refused.
        operations: ['submitPublish', 'getPublishStatus', 'readAccountAnalytics'],
      } as unknown as SocialCapability,
    ],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(
    problems.some((problem) => problem.includes("'readAccountAnalytics' belongs to family 'analytics-read', not 'publish'")),
  );
});

test('MKT-058: a DUPLICATE family declaration fails construction loudly', () => {
  const capabilities = instagramCapabilities();
  const mutated = instagramAdapter({
    capabilities: [...capabilities, { ...capabilities[0]!, operations: ['verifyAccountIdentity'], requiredScopes: [], description: 'Duplicate account family.' } as unknown as SocialCapability],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('duplicate family declaration')));
});

test('MKT-058: a declared operation WITHOUT its implementing method fails construction loudly', () => {
  const mutated = instagramAdapter({ omitMethod: 'readContentAnalytics' });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(
    problems.some((problem) => problem.includes("declares operation 'readContentAnalytics' but the adapter does not implement")),
  );
});

test('MKT-058: an EMPTY capability matrix is not a subset — it fails construction loudly', () => {
  const mutated = instagramAdapter({ capabilities: [] });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('a non-empty capability list is required')));
});

test('MKT-058: a malformed required scope fails construction loudly', () => {
  const capabilities = instagramCapabilities();
  const mutated = instagramAdapter({
    capabilities: [
      ...capabilities.slice(0, 2),
      { ...capabilities[2]!, requiredScopes: [''] },
      ...capabilities.slice(3),
    ],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('must be a non-empty provider scope string')));
});

// ---------------------------------------------------------------------------
// The REAL scope names against the strict social scope convention
// ---------------------------------------------------------------------------

test('MKT-058: the REAL Facebook Login scope names compose against the strict scope convention', () => {
  // The full grant satisfies every declared capability.
  const full = socialCapabilityScopeSatisfaction(instagramCapabilities(), [...FULL_GRANT]);
  assert.deepEqual(
    full.map((entry) => [entry.family, entry.satisfied]),
    [
      ['account', true],
      ['content-read', true],
      ['analytics-read', true],
      ['publish', true],
    ],
  );
  for (const capability of instagramCapabilities()) {
    assert.equal(socialScopeProblem(capability, [...FULL_GRANT]), null);
  }
  // The read-only grant: the readonly families stay satisfied, the
  // analytics + publish families refuse with the missing REAL scopes.
  const readOnly = socialCapabilityScopeSatisfaction(instagramCapabilities(), [...READ_ONLY_GRANT]);
  const byFamily = new Map(readOnly.map((entry) => [entry.family, entry]));
  assert.equal(byFamily.get('account')!.satisfied, true);
  assert.equal(byFamily.get('content-read')!.satisfied, true);
  assert.equal(byFamily.get('analytics-read')!.satisfied, false);
  assert.deepEqual(byFamily.get('analytics-read')!.missingScopes, [INSTAGRAM_MANAGE_INSIGHTS]);
  assert.equal(byFamily.get('publish')!.satisfied, false);
  assert.deepEqual(byFamily.get('publish')!.missingScopes, [INSTAGRAM_CONTENT_PUBLISH]);
  // The strict pre-flight problem names the missing REAL scope verbatim.
  const publish = instagramCapabilities().find((capability) => capability.family === 'publish')!;
  const problem = socialScopeProblem(publish, [...READ_ONLY_GRANT]);
  assert.ok(problem !== null && problem.includes(INSTAGRAM_CONTENT_PUBLISH));
});

// ---------------------------------------------------------------------------
// The Instagram-shaped publish request against the frozen request guard
// ---------------------------------------------------------------------------

test('MKT-058: the Instagram container publish request passes the frozen request guard (and §21 refuses material)', () => {
  // The documented container creation mapping: caption + image_url (the
  // media-asset URL descriptor) + media_type/share_to_feed passthrough.
  assertValidSocialPublishRequest({
    contentType: 'instagram.feed-image',
    payload: {
      caption: 'The documented container caption.',
      media_type: 'IMAGE',
      share_to_feed: 'true',
      accessibility_caption: 'A fixture image',
    },
    mediaAssets: [
      {
        assetReference: 'content-asset:ca:fixture-ig-1',
        mediaKind: 'image',
        descriptor: { filename: 'post.jpg', mime: 'image/jpeg', url: 'https://cdn.example/post.jpg' },
      },
    ],
    attribution: { missionId: 'mission-ig-1', experimentId: 'exp-ig-1' },
    scheduledFor: null,
  });
  // A reel-shaped request rides the documented video_url param.
  assertValidSocialPublishRequest({
    contentType: 'instagram.reel',
    payload: { caption: 'A reel', media_type: 'REELS', video_url: 'https://cdn.example/reel.mp4', share_to_feed: 'true' },
    mediaAssets: [
      {
        assetReference: 'content-asset:ca:fixture-ig-2',
        mediaKind: 'reel',
        descriptor: { filename: 'reel.mp4', mime: 'video/mp4', url: 'https://cdn.example/reel.mp4' },
      },
    ],
    attribution: {},
    scheduledFor: null,
  });
  // The §21 backstop refuses material-shaped payloads (the frozen guard).
  assert.throws(
    () =>
      assertValidSocialPublishRequest({
        contentType: 'instagram.feed-image',
        payload: { caption: 'Bad', accessToken: 'ey1234567890abcdefghij' },
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
