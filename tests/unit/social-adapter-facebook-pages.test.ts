/**
 * MKT-059 unit tests — the FACEBOOK PAGES capability-matrix registration
 * discipline on the frozen MKT-056 contract (pure, no DB — the
 * social-adapter-instagram.test.ts precedent): the honest SUBSET
 * declaration (FOUR of the five frozen families — the documented
 * Facebook Pages surface supports account / content-read /
 * analytics-read / publish; the restriction-signals family is honestly
 * UNDECLARED) with the closed per-family operation vocabularies and the
 * REAL Facebook Login scope names (the verified documented permission
 * set: pages_show_list, pages_read_engagement, pages_read_user_content,
 * pages_manage_posts, read_insights) PASSES the frozen registration
 * guards, and every ILLEGAL mutation of the Facebook Pages declaration
 * FAILS CLOSED LOUDLY (unknown family / unknown operation /
 * wrong-family operation / duplicate family / declared operation without
 * its implementing method / empty matrix / malformed scope / an
 * ILLEGALLY declared restriction-signals family whose operation has no
 * implementing method — the honest-subset enforcement at construction).
 *
 * The unit battery exercises the facebook-pages-shaped matrices through
 * the PUBLIC contract guards (tests may import module public entries
 * only — the arch-check TEST_MODULE_INTERNAL_IMPORT rule); the REAL
 * adapter's declared matrix, its documented API mapping and its full
 * behavior are pinned END-TO-END by the integration battery
 * (tests/integration/social-adapter-facebook-pages.test.ts) against the
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
// The Facebook Pages declaration (the honest matrix the real adapter declares)
// ---------------------------------------------------------------------------

/** The REAL Facebook Login permission names (the verified documented Pages scope surface). */
const PAGES_SHOW_LIST = 'pages_show_list';
const PAGES_READ_ENGAGEMENT = 'pages_read_engagement';
const PAGES_READ_USER_CONTENT = 'pages_read_user_content';
const PAGES_MANAGE_POSTS = 'pages_manage_posts';
const READ_INSIGHTS = 'read_insights';

/** The full-scope Facebook Pages grant (the conformance fixture vocabulary of the MKT-059 run). */
const FULL_GRANT = [
  PAGES_SHOW_LIST,
  PAGES_READ_ENGAGEMENT,
  PAGES_READ_USER_CONTENT,
  PAGES_MANAGE_POSTS,
  READ_INSIGHTS,
] as const;
/** The read-only Facebook Pages grant (the publish family refuses pre-flight). */
const READ_ONLY_GRANT = [
  PAGES_SHOW_LIST,
  PAGES_READ_ENGAGEMENT,
  PAGES_READ_USER_CONTENT,
  READ_INSIGHTS,
] as const;

/** The honest Facebook Pages capability matrix — 4 of the 5 frozen families (mirrors the real adapter declaration). */
function facebookPagesCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [PAGES_SHOW_LIST],
      description: 'Facebook Page identity + profile reads over the documented /me/accounts page-resolution surface + the Page node (unit-declared mirror; the documented surface serves Pages only).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [PAGES_READ_ENGAGEMENT, PAGES_READ_USER_CONTENT, PAGES_SHOW_LIST],
      description: 'Page-feed discovery + own-content listing + single reads over the documented feed/posts edges and the Post node (unit-declared mirror; no view counts — never fabricated).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [PAGES_READ_ENGAGEMENT, READ_INSIGHTS, PAGES_SHOW_LIST],
      description: 'Observed metric points over the documented Page insights edges (unit-declared mirror; provider labels verbatim, day-period slices with end_time, lifetime post aggregates).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [PAGES_MANAGE_POSTS, PAGES_READ_ENGAGEMENT, PAGES_SHOW_LIST],
      description: 'The documented Page publishing surfaces incl. the scheduled/unpublished posts (unit-declared mirror; the Pages BUC rate surface; the host fence is the at-most-once identity).',
    },
  ];
}

/** A Facebook-Pages-shaped adapter under the registration guards (the declared operations implemented). */
function facebookPagesAdapter(overrides?: {
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
        adapterKey: 'facebook-pages',
        providerLabel: 'Facebook Pages (Graph API Pages surface)',
        description: 'The unit-declared Facebook Pages mirror (the real adapter lives in the internal adapter subtree).',
      },
      capabilities: overrides?.capabilities ?? facebookPagesCapabilities(),
      ...omitted,
    } as unknown as SocialPlatformAdapter;
  }
  return {
    descriptor: {
      adapterKey: 'facebook-pages',
      providerLabel: 'Facebook Pages (Graph API Pages surface)',
      description: 'The unit-declared Facebook Pages mirror (the real adapter lives in the internal adapter subtree).',
    },
    capabilities: overrides?.capabilities ?? facebookPagesCapabilities(),
    ...allMethods,
  } as unknown as SocialPlatformAdapter;
}

// ---------------------------------------------------------------------------
// The honest declaration passes the frozen guards
// ---------------------------------------------------------------------------

test('MKT-059: the honest Facebook Pages capability matrix passes the frozen registration guards', () => {
  const problems = socialAdapterRegistrationProblems(facebookPagesAdapter());
  assert.deepEqual(problems, [], 'the Facebook Pages 4-of-5 SUBSET declaration is first-class');
  // The registry builder accepts it (and the duplicate key still refuses).
  const registry = buildSocialAdapterRegistry([facebookPagesAdapter()]);
  assert.ok(registry.has('facebook-pages'));
  assert.throws(
    () => buildSocialAdapterRegistry([facebookPagesAdapter(), facebookPagesAdapter()]),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('duplicate')),
    'a duplicate Facebook Pages registration is refused fail-closed',
  );
});

test('MKT-059: the declared families are the honest 4-of-5 SUBSET with the closed per-family operation vocabularies', () => {
  const capabilities = facebookPagesCapabilities();
  assert.deepEqual(
    capabilities.map((capability) => capability.family),
    ['account', 'content-read', 'analytics-read', 'publish'],
    'the documented Facebook Pages surface honestly supports FOUR families — restriction-signals is UNDECLARED (no documented Page restriction-signal endpoint; account-level limitations surface as invocation failures; hidden moderation state is never invented, §11)',
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

test('MKT-059: an ILLEGALLY declared restriction-signals family without its implementing method fails construction loudly (the honest-subset enforcement)', () => {
  // The real Facebook Pages adapter declares NO restriction-signals
  // capability and implements NO readRestrictionSignals method — a
  // matrix that declares the family anyway is refused fail-closed.
  const capabilities = facebookPagesCapabilities();
  const mutated = facebookPagesAdapter({
    capabilities: [
      ...capabilities,
      {
        family: 'restriction-signals',
        operations: ['readRestrictionSignals'],
        requiredScopes: [PAGES_READ_ENGAGEMENT],
        description: 'An illegal declaration: the documented Pages surface exposes no restriction-signal endpoint.',
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
// The fail-closed registration discipline (the 056 discipline on the Facebook Pages shape)
// ---------------------------------------------------------------------------

test('MKT-059: an UNKNOWN family in the Facebook Pages declaration fails construction loudly', () => {
  const mutated = facebookPagesAdapter({
    capabilities: [
      ...facebookPagesCapabilities().slice(0, 3),
      { family: 'engagement-write', operations: ['likePost'], requiredScopes: [], description: 'Not a frozen family.' },
    ] as unknown as readonly SocialCapability[],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'engagement-write' is not a social capability family")));
});

test('MKT-059: an UNKNOWN operation in the Facebook Pages declaration fails construction loudly', () => {
  const capabilities = facebookPagesCapabilities();
  const mutated = facebookPagesAdapter({
    capabilities: [
      ...capabilities.slice(0, 1),
      { ...capabilities[1]!, operations: ['discoverPublicContent', 'listOwnContent', 'getContent', 'boostPost'] } as unknown as SocialCapability,
      ...capabilities.slice(2),
    ],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'boostPost' is not a social operation key")));
});

test('MKT-059: a WRONG-FAMILY operation in the Facebook Pages declaration fails construction loudly', () => {
  const capabilities = facebookPagesCapabilities();
  const mutated = facebookPagesAdapter({
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

test('MKT-059: a DUPLICATE family declaration fails construction loudly', () => {
  const capabilities = facebookPagesCapabilities();
  const mutated = facebookPagesAdapter({
    capabilities: [...capabilities, { ...capabilities[0]!, operations: ['verifyAccountIdentity'], requiredScopes: [], description: 'Duplicate account family.' } as unknown as SocialCapability],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('duplicate family declaration')));
});

test('MKT-059: a declared operation WITHOUT its implementing method fails construction loudly', () => {
  const mutated = facebookPagesAdapter({ omitMethod: 'readContentAnalytics' });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(
    problems.some((problem) => problem.includes("declares operation 'readContentAnalytics' but the adapter does not implement")),
  );
});

test('MKT-059: an EMPTY capability matrix is not a subset — it fails construction loudly', () => {
  const mutated = facebookPagesAdapter({ capabilities: [] });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('a non-empty capability list is required')));
});

test('MKT-059: a malformed required scope fails construction loudly', () => {
  const capabilities = facebookPagesCapabilities();
  const mutated = facebookPagesAdapter({
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

test('MKT-059: the REAL Facebook Login scope names compose against the strict scope convention', () => {
  // The full grant satisfies every declared capability.
  const full = socialCapabilityScopeSatisfaction(facebookPagesCapabilities(), [...FULL_GRANT]);
  assert.deepEqual(
    full.map((entry) => [entry.family, entry.satisfied]),
    [
      ['account', true],
      ['content-read', true],
      ['analytics-read', true],
      ['publish', true],
    ],
  );
  for (const capability of facebookPagesCapabilities()) {
    assert.equal(socialScopeProblem(capability, [...FULL_GRANT]), null);
  }
  // The read-only grant: the readonly families stay satisfied, the
  // publish family refuses with the missing REAL scope.
  const readOnly = socialCapabilityScopeSatisfaction(facebookPagesCapabilities(), [...READ_ONLY_GRANT]);
  const byFamily = new Map(readOnly.map((entry) => [entry.family, entry]));
  assert.equal(byFamily.get('account')!.satisfied, true);
  assert.equal(byFamily.get('content-read')!.satisfied, true);
  assert.equal(byFamily.get('analytics-read')!.satisfied, true);
  assert.equal(byFamily.get('publish')!.satisfied, false);
  assert.deepEqual(byFamily.get('publish')!.missingScopes, [PAGES_MANAGE_POSTS]);
  // The strict pre-flight problem names the missing REAL scope verbatim.
  const publish = facebookPagesCapabilities().find((capability) => capability.family === 'publish')!;
  const problem = socialScopeProblem(publish, [...READ_ONLY_GRANT]);
  assert.ok(problem !== null && problem.includes(PAGES_MANAGE_POSTS));
});

// ---------------------------------------------------------------------------
// The Facebook-Pages-shaped publish request against the frozen request guard
// ---------------------------------------------------------------------------

test('MKT-059: the Facebook Pages publish requests pass the frozen request guard (and §21 refuses material)', () => {
  // The documented feed-post mapping: message + link (the scheduled
  // window rides scheduledFor).
  assertValidSocialPublishRequest({
    contentType: 'facebook-pages.feed-post',
    payload: {
      message: 'The documented Page feed post message.',
      link: 'https://example.com/page-post',
    },
    mediaAssets: [],
    attribution: { missionId: 'mission-fb-1', experimentId: 'exp-fb-1' },
    scheduledFor: '2026-08-02T12:00:00.000Z',
  });
  // A photo-shaped request rides the documented url param.
  assertValidSocialPublishRequest({
    contentType: 'facebook-pages.photo',
    payload: { caption: 'A fixture photo', url: 'https://cdn.example/photo.jpg' },
    mediaAssets: [
      {
        assetReference: 'content-asset:ca:fixture-fb-1',
        mediaKind: 'image',
        descriptor: { filename: 'photo.jpg', mime: 'image/jpeg', url: 'https://cdn.example/photo.jpg' },
      },
    ],
    attribution: {},
    scheduledFor: null,
  });
  // A video-shaped request rides the documented file_url param.
  assertValidSocialPublishRequest({
    contentType: 'facebook-pages.video',
    payload: { description: 'A fixture video', file_url: 'https://cdn.example/video.mp4' },
    mediaAssets: [
      {
        assetReference: 'content-asset:ca:fixture-fb-2',
        mediaKind: 'video',
        descriptor: { filename: 'video.mp4', mime: 'video/mp4', url: 'https://cdn.example/video.mp4' },
      },
    ],
    attribution: {},
    scheduledFor: null,
  });
  // The §21 backstop refuses material-shaped payloads (the frozen guard).
  assert.throws(
    () =>
      assertValidSocialPublishRequest({
        contentType: 'facebook-pages.feed-post',
        payload: { message: 'Bad', accessToken: 'ey1234567890abcdefghij' },
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
