/**
 * MKT-060 unit tests — the TIKTOK capability-matrix registration
 * discipline on the frozen MKT-056 contract (pure, no DB — the
 * social-adapter-facebook-pages.test.ts precedent): the honest
 * declaration (ALL FIVE frozen families with the closed per-family
 * operation vocabularies and the REAL documented Login Kit scope names
 * — the verified live set: user.info.basic, user.info.profile,
 * user.info.stats, video.list, video.publish) PASSES the frozen
 * registration guards, and every ILLEGAL mutation of the TikTok
 * declaration FAILS CLOSED LOUDLY (unknown family / unknown operation /
 * wrong-family operation / duplicate family / declared operation without
 * its implementing method / empty matrix / malformed scope / an
 * ILLEGALLY narrowed operation set — the honest-subset enforcement at
 * construction).
 *
 * The unit battery exercises the tiktok-shaped matrices through the
 * PUBLIC contract guards (tests may import module public entries only —
 * the arch-check TEST_MODULE_INTERNAL_IMPORT rule); the REAL adapter's
 * declared matrix, its documented API mapping and its full behavior are
 * pinned END-TO-END by the integration battery
 * (tests/integration/social-adapter-tiktok.test.ts) against the
 * disclosed in-memory + loopback HTTP platform doubles.
 *
 * DISCLOSED scope verification (the live scopes reference,
 * https://developers.tiktok.com/docs/en/tiktok-api-scopes, verified at
 * delivery time): the dispatch's candidate list named creator.info and
 * creator.data — those scopes are NOT part of the current documented
 * Login Kit scope reference (the Creator API product and its scopes are
 * retired; the Query Creator Info endpoint is authorized by
 * video.publish), and the live reference adds user.info.stats (the
 * documented scope of follower_count/following_count/likes_count/
 * video_count) which the candidate list did not name.
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
// The TikTok declaration (the honest matrix the real adapter declares)
// ---------------------------------------------------------------------------

/** The REAL documented Login Kit scope names (the verified live scope set). */
const USER_INFO_BASIC = 'user.info.basic';
const USER_INFO_PROFILE = 'user.info.profile';
const USER_INFO_STATS = 'user.info.stats';
const VIDEO_LIST = 'video.list';
const VIDEO_PUBLISH = 'video.publish';

/** The full-scope TikTok grant (the conformance fixture vocabulary of the MKT-060 run). */
const FULL_GRANT = [USER_INFO_BASIC, USER_INFO_PROFILE, USER_INFO_STATS, VIDEO_LIST, VIDEO_PUBLISH] as const;
/** The read-only TikTok grant (publish + restriction-signals refuse pre-flight — both require video.publish). */
const READ_ONLY_GRANT = [USER_INFO_BASIC, USER_INFO_PROFILE, USER_INFO_STATS, VIDEO_LIST] as const;

/** The honest TikTok capability matrix — ALL FIVE frozen families (mirrors the real adapter declaration). */
function tikTokCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [USER_INFO_BASIC, USER_INFO_PROFILE, USER_INFO_STATS],
      description: 'TikTok account identity binding + profile reads over the documented Get User Info endpoint (unit-declared mirror; verified badge, not a timestamp; no account-type label on the surface).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [VIDEO_LIST],
      description: 'Content reads over the documented Display API video surfaces (unit-declared mirror; the discovery query is honestly unused — no documented public search; all four engagement counts ride).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [USER_INFO_STATS, VIDEO_LIST],
      description: 'Observed metric points over the documented statistical surfaces (unit-declared mirror; user.info.stats labels + the Video Object count fields, verbatim, null windows).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [VIDEO_PUBLISH],
      description: 'The documented direct-post lifecycle (unit-declared mirror; the audit/private-mode restrictions surface through the documented 403 semantics; the host fence is the at-most-once identity).',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: [VIDEO_PUBLISH],
      description: 'The documented creator capability query (unit-declared mirror; the eligibility facts ride as signals; the client audit status is never invented).',
    },
  ];
}

/** A TikTok-shaped adapter under the registration guards (the declared operations implemented). */
function tikTokAdapter(overrides?: {
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
        adapterKey: 'tiktok',
        providerLabel: 'TikTok (Login Kit + Content Posting API)',
        description: 'The unit-declared TikTok mirror (the real adapter lives in the internal adapter subtree).',
      },
      capabilities: overrides?.capabilities ?? tikTokCapabilities(),
      ...omitted,
    } as unknown as SocialPlatformAdapter;
  }
  return {
    descriptor: {
      adapterKey: 'tiktok',
      providerLabel: 'TikTok (Login Kit + Content Posting API)',
      description: 'The unit-declared TikTok mirror (the real adapter lives in the internal adapter subtree).',
    },
    capabilities: overrides?.capabilities ?? tikTokCapabilities(),
    ...allMethods,
  } as unknown as SocialPlatformAdapter;
}

// ---------------------------------------------------------------------------
// The honest declaration passes the frozen guards
// ---------------------------------------------------------------------------

test('MKT-060: the honest TikTok capability matrix passes the frozen registration guards', () => {
  const problems = socialAdapterRegistrationProblems(tikTokAdapter());
  assert.deepEqual(problems, [], 'the TikTok 5-of-5 declaration is first-class');
  // The registry builder accepts it (and the duplicate key still refuses).
  const registry = buildSocialAdapterRegistry([tikTokAdapter()]);
  assert.ok(registry.has('tiktok'));
  assert.throws(
    () => buildSocialAdapterRegistry([tikTokAdapter(), tikTokAdapter()]),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('duplicate')),
    'a duplicate TikTok registration is refused fail-closed',
  );
});

test('MKT-060: the declared families are the honest ALL-FIVE set with the closed per-family operation vocabularies', () => {
  const capabilities = tikTokCapabilities();
  assert.deepEqual(
    capabilities.map((capability) => capability.family),
    ['account', 'content-read', 'analytics-read', 'publish', 'restriction-signals'],
    'the documented TikTok surface honestly supports ALL FIVE families — the creator capability query (the documented eligibility surface) serves the restriction-signals family; account-level eligibility restrictions surface as invocation failures through the documented 403 error semantics; hidden moderation state is never invented, §11',
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
// The fail-closed registration discipline (the 056 discipline on the TikTok shape)
// ---------------------------------------------------------------------------

test('MKT-060: an UNKNOWN family in the TikTok declaration fails construction loudly', () => {
  const mutated = tikTokAdapter({
    capabilities: [
      ...tikTokCapabilities().slice(0, 4),
      { family: 'sound-read', operations: ['listSounds'], requiredScopes: [], description: 'Not a frozen family.' },
    ] as unknown as readonly SocialCapability[],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'sound-read' is not a social capability family")));
});

test('MKT-060: an UNKNOWN operation in the TikTok declaration fails construction loudly', () => {
  const capabilities = tikTokCapabilities();
  const mutated = tikTokAdapter({
    capabilities: [
      ...capabilities.slice(0, 1),
      { ...capabilities[1]!, operations: ['discoverPublicContent', 'listOwnContent', 'getContent', 'boostVideo'] } as unknown as SocialCapability,
      ...capabilities.slice(2),
    ],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'boostVideo' is not a social operation key")));
});

test('MKT-060: a WRONG-FAMILY operation in the TikTok declaration fails construction loudly', () => {
  const capabilities = tikTokCapabilities();
  const mutated = tikTokAdapter({
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

test('MKT-060: a DUPLICATE family declaration fails construction loudly', () => {
  const capabilities = tikTokCapabilities();
  const mutated = tikTokAdapter({
    capabilities: [...capabilities, { ...capabilities[0]!, operations: ['verifyAccountIdentity'], requiredScopes: [], description: 'Duplicate account family.' } as unknown as SocialCapability],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('duplicate family declaration')));
});

test('MKT-060: a declared operation WITHOUT its implementing method fails construction loudly', () => {
  const mutated = tikTokAdapter({ omitMethod: 'getPublishStatus' });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(
    problems.some((problem) => problem.includes("declares operation 'getPublishStatus' but the adapter does not implement")),
  );
});

test('MKT-060: an EMPTY capability matrix is not a subset — it fails construction loudly', () => {
  const mutated = tikTokAdapter({ capabilities: [] });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('a non-empty capability list is required')));
});

test('MKT-060: a malformed required scope fails construction loudly', () => {
  const capabilities = tikTokCapabilities();
  const mutated = tikTokAdapter({
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

test('MKT-060: an operation-level SUBSET of a declared family passes construction (the narrowed content-read set is first-class)', () => {
  const capabilities = tikTokCapabilities();
  const narrowed = tikTokAdapter({
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

test('MKT-060: the REAL documented Login Kit scope names compose against the strict scope convention', () => {
  // The full grant satisfies every declared capability.
  const full = socialCapabilityScopeSatisfaction(tikTokCapabilities(), [...FULL_GRANT]);
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
  for (const capability of tikTokCapabilities()) {
    assert.equal(socialScopeProblem(capability, [...FULL_GRANT]), null);
  }
  // The read-only grant: the read families stay satisfied, the
  // video.publish-gated families (publish + restriction-signals) refuse
  // with the missing REAL scope.
  const readOnly = socialCapabilityScopeSatisfaction(tikTokCapabilities(), [...READ_ONLY_GRANT]);
  const byFamily = new Map(readOnly.map((entry) => [entry.family, entry]));
  assert.equal(byFamily.get('account')!.satisfied, true);
  assert.equal(byFamily.get('content-read')!.satisfied, true);
  assert.equal(byFamily.get('analytics-read')!.satisfied, true);
  assert.equal(byFamily.get('publish')!.satisfied, false);
  assert.deepEqual(byFamily.get('publish')!.missingScopes, [VIDEO_PUBLISH]);
  assert.equal(byFamily.get('restriction-signals')!.satisfied, false);
  assert.deepEqual(byFamily.get('restriction-signals')!.missingScopes, [VIDEO_PUBLISH]);
  // The strict pre-flight problem names the missing REAL scope verbatim.
  const publish = tikTokCapabilities().find((capability) => capability.family === 'publish')!;
  const problem = socialScopeProblem(publish, [...READ_ONLY_GRANT]);
  assert.ok(problem !== null && problem.includes(VIDEO_PUBLISH));
});

// ---------------------------------------------------------------------------
// The TikTok-shaped publish request against the frozen request guard
// ---------------------------------------------------------------------------

test('MKT-060: the TikTok direct-post publish requests pass the frozen request guard (and §21 refuses material)', () => {
  // The documented direct-post mapping: the post_info params + the
  // PULL_FROM_URL video URL (the media-asset URL descriptor supplies
  // video_url; the scheduledFor field is honestly unused — the
  // documented surface exposes no scheduling parameter).
  assertValidSocialPublishRequest({
    contentType: 'tiktok.video',
    payload: {
      title: 'this will be a funny #cat video on your @tiktok #fyp',
      privacyLevel: 'MUTUAL_FOLLOW_FRIENDS',
      disableDuet: false,
      disableComment: true,
      disableStitch: false,
      videoCoverTimestampMs: 1000,
      brandContentToggle: false,
      brandOrganicToggle: false,
      isAigc: false,
    },
    mediaAssets: [
      {
        assetReference: 'content-asset:ca:fixture-tt-1',
        mediaKind: 'video',
        descriptor: { filename: 'clip.mp4', mime: 'video/mp4', url: 'https://cdn.example.com/clip.mp4' },
      },
    ],
    attribution: { missionId: 'mission-tt-1', experimentId: 'exp-tt-1' },
    scheduledFor: null,
  });
  // A minimal request (the payload's videoUrl supplies the source).
  assertValidSocialPublishRequest({
    contentType: 'tiktok.video',
    payload: { title: 'A fixture direct post', privacyLevel: 'SELF_ONLY', videoUrl: 'https://cdn.example.com/clip.mp4' },
    mediaAssets: [],
    attribution: {},
    scheduledFor: null,
  });
  // The §21 backstop refuses material-shaped payloads (the frozen guard).
  assert.throws(
    () =>
      assertValidSocialPublishRequest({
        contentType: 'tiktok.video',
        payload: { title: 'Bad', accessToken: 'ey1234567890abcdefghij' },
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
