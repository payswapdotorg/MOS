/**
 * MKT-057 unit tests — the YOUTUBE capability-matrix registration
 * discipline on the frozen MKT-056 contract (pure, no DB — the
 * social-adapter-contract.test.ts precedent): the honest SUBSET
 * declaration (all five families, the closed per-family operation
 * vocabularies, the REAL Google OAuth scope URIs) PASSES the frozen
 * registration guards, and every ILLEGAL mutation of the YouTube
 * declaration FAILS CLOSED LOUDLY (unknown family / unknown operation
 * / wrong-family operation / duplicate family / declared operation
 * without its implementing method / empty matrix / malformed scope).
 *
 * The unit battery exercises the youtube-shaped matrices through the
 * PUBLIC contract guards (tests may import module public entries only
 * — the arch-check TEST_MODULE_INTERNAL_IMPORT rule); the REAL
 * adapter's declared matrix, its documented API mapping and its full
 * behavior are pinned END-TO-END by the integration battery
 * (tests/integration/social-adapter-youtube.test.ts) against the
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
// The YouTube declaration (the honest matrix the real adapter declares)
// ---------------------------------------------------------------------------

/** The REAL Google OAuth scope URIs (https://developers.google.com/identity/protocols/oauth2/scopes). */
const YOUTUBE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
const YOUTUBE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const YOUTUBE_ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';

/** The full-scope YouTube grant (the conformance fixture vocabulary of the MKT-057 run). */
const FULL_GRANT = [YOUTUBE_READONLY, YOUTUBE_ANALYTICS, YOUTUBE_UPLOAD] as const;
/** The read-only YouTube grant (analytics + publish refuse pre-flight). */
const READ_ONLY_GRANT = [YOUTUBE_READONLY] as const;

/** The honest YouTube capability matrix (mirrors the real adapter declaration). */
function youTubeCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [YOUTUBE_READONLY],
      description: 'YouTube channel identity + profile reads (unit-declared mirror; limitations disclosed per lock rule 37).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [YOUTUBE_READONLY],
      description: 'YouTube search/list/read (unit-declared mirror; search pages carry no statistics — no share count).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [YOUTUBE_ANALYTICS],
      description: 'YouTube Analytics API v2 observed metric points (unit-declared mirror; provider labels verbatim).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [YOUTUBE_UPLOAD],
      description: 'The documented resumable-upload lifecycle (unit-declared mirror; media-byte transfer awaits the content-asset wiring).',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: [YOUTUBE_READONLY],
      description: 'Only the provider-exposed restriction facts (unit-declared mirror; hidden moderation state never invented).',
    },
  ];
}

/** A YouTube-shaped adapter under the registration guards (every declared operation implemented). */
function youTubeAdapter(overrides?: {
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
        adapterKey: 'youtube',
        providerLabel: 'YouTube (Data API v3 + Analytics API v2)',
        description: 'The unit-declared YouTube mirror (the real adapter lives in the internal adapter subtree).',
      },
      capabilities: overrides?.capabilities ?? youTubeCapabilities(),
      ...omitted,
    } as unknown as SocialPlatformAdapter;
  }
  return {
    descriptor: {
      adapterKey: 'youtube',
      providerLabel: 'YouTube (Data API v3 + Analytics API v2)',
      description: 'The unit-declared YouTube mirror (the real adapter lives in the internal adapter subtree).',
    },
    capabilities: overrides?.capabilities ?? youTubeCapabilities(),
    ...allMethods,
  } as unknown as SocialPlatformAdapter;
}

// ---------------------------------------------------------------------------
// The honest declaration passes the frozen guards
// ---------------------------------------------------------------------------

test('MKT-057: the honest YouTube capability matrix passes the frozen registration guards', () => {
  const problems = socialAdapterRegistrationProblems(youTubeAdapter());
  assert.deepEqual(problems, [], 'the YouTube SUBSET declaration is first-class');
  // The registry builder accepts it (and the duplicate key still refuses).
  const registry = buildSocialAdapterRegistry([youTubeAdapter()]);
  assert.ok(registry.has('youtube'));
  assert.throws(
    () => buildSocialAdapterRegistry([youTubeAdapter(), youTubeAdapter()]),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('duplicate')),
    'a duplicate YouTube registration is refused fail-closed',
  );
});

test('MKT-057: the declared families are exactly the frozen five with the closed per-family operation vocabularies', () => {
  const capabilities = youTubeCapabilities();
  assert.deepEqual(
    capabilities.map((capability) => capability.family),
    [...SOCIAL_CAPABILITY_FAMILIES],
    'the documented YouTube surface honestly supports all five families — the SUBSET discipline shows in the operations, scopes and disclosed limitations',
  );
  const operationsOf = (family: string): readonly string[] =>
    capabilities.find((capability) => capability.family === family)!.operations;
  assert.deepEqual(operationsOf('account'), ['verifyAccountIdentity', 'getAccountProfile']);
  assert.deepEqual(operationsOf('content-read'), ['discoverPublicContent', 'listOwnContent', 'getContent']);
  assert.deepEqual(operationsOf('analytics-read'), ['readAccountAnalytics', 'readContentAnalytics']);
  assert.deepEqual(operationsOf('publish'), ['submitPublish', 'getPublishStatus']);
  assert.deepEqual(operationsOf('restriction-signals'), ['readRestrictionSignals']);
});

// ---------------------------------------------------------------------------
// The fail-closed registration discipline (the 056 discipline on the YouTube shape)
// ---------------------------------------------------------------------------

test('MKT-057: an UNKNOWN family in the YouTube declaration fails construction loudly', () => {
  const mutated = youTubeAdapter({
    capabilities: [
      ...youTubeCapabilities().slice(0, 4),
      { family: 'engagement-write', operations: ['likeVideo'], requiredScopes: [], description: 'Not a frozen family.' },
    ] as unknown as readonly SocialCapability[],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'engagement-write' is not a social capability family")));
});

test('MKT-057: an UNKNOWN operation in the YouTube declaration fails construction loudly', () => {
  const capabilities = youTubeCapabilities();
  const mutated = youTubeAdapter({
    capabilities: [
      ...capabilities.slice(0, 1),
      { ...capabilities[1]!, operations: ['discoverPublicContent', 'listOwnContent', 'getContent', 'postComment'] } as unknown as SocialCapability,
      ...capabilities.slice(2),
    ],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes("'postComment' is not a social operation key")));
});

test('MKT-057: a WRONG-FAMILY operation in the YouTube declaration fails construction loudly', () => {
  const capabilities = youTubeCapabilities();
  const mutated = youTubeAdapter({
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

test('MKT-057: a DUPLICATE family declaration fails construction loudly', () => {
  const capabilities = youTubeCapabilities();
  const mutated = youTubeAdapter({
    capabilities: [...capabilities, { ...capabilities[0]!, operations: ['verifyAccountIdentity'], requiredScopes: [], description: 'Duplicate account family.' } as unknown as SocialCapability],
  });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('duplicate family declaration')));
});

test('MKT-057: a declared operation WITHOUT its implementing method fails construction loudly', () => {
  const mutated = youTubeAdapter({ omitMethod: 'submitPublish' });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(
    problems.some((problem) => problem.includes("declares operation 'submitPublish' but the adapter does not implement")),
  );
});

test('MKT-057: an EMPTY capability matrix is not a subset — it fails construction loudly', () => {
  const mutated = youTubeAdapter({ capabilities: [] });
  const problems = socialAdapterRegistrationProblems(mutated);
  assert.ok(problems.some((problem) => problem.includes('a non-empty capability list is required')));
});

test('MKT-057: a malformed required scope fails construction loudly', () => {
  const capabilities = youTubeCapabilities();
  const mutated = youTubeAdapter({
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
// The REAL scope URIs against the strict social scope convention
// ---------------------------------------------------------------------------

test('MKT-057: the REAL Google OAuth scope URIs compose against the strict scope convention', () => {
  // The full grant satisfies every declared capability.
  const full = socialCapabilityScopeSatisfaction(youTubeCapabilities(), [...FULL_GRANT]);
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
  for (const capability of youTubeCapabilities()) {
    assert.equal(socialScopeProblem(capability, [...FULL_GRANT]), null);
  }
  // The read-only grant: the readonly families stay satisfied, the
  // analytics + publish families refuse with the missing REAL scope.
  const readOnly = socialCapabilityScopeSatisfaction(youTubeCapabilities(), [...READ_ONLY_GRANT]);
  const byFamily = new Map(readOnly.map((entry) => [entry.family, entry]));
  assert.equal(byFamily.get('account')!.satisfied, true);
  assert.equal(byFamily.get('content-read')!.satisfied, true);
  assert.equal(byFamily.get('restriction-signals')!.satisfied, true);
  assert.equal(byFamily.get('analytics-read')!.satisfied, false);
  assert.deepEqual(byFamily.get('analytics-read')!.missingScopes, [YOUTUBE_ANALYTICS]);
  assert.equal(byFamily.get('publish')!.satisfied, false);
  assert.deepEqual(byFamily.get('publish')!.missingScopes, [YOUTUBE_UPLOAD]);
  // The strict pre-flight problem names the missing REAL scope verbatim.
  const publish = youTubeCapabilities().find((capability) => capability.family === 'publish')!;
  const problem = socialScopeProblem(publish, [...READ_ONLY_GRANT]);
  assert.ok(problem !== null && problem.includes(YOUTUBE_UPLOAD));
});

// ---------------------------------------------------------------------------
// The YouTube-shaped publish request against the frozen request guard
// ---------------------------------------------------------------------------

test('MKT-057: the YouTube video-metadata publish request passes the frozen request guard (and §21 refuses material)', () => {
  // The documented videos.insert metadata mapping: title/description/
  // tags/categoryId + privacyStatus/selfDeclaredMadeForKids/publishAt.
  assertValidSocialPublishRequest({
    contentType: 'youtube.video',
    payload: {
      title: 'The documented snippet title',
      description: 'The documented snippet description.',
      tags: ['marketing', 'growth'],
      categoryId: '22',
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false,
    },
    mediaAssets: [
      {
        assetReference: 'content-asset:ca:fixture-1',
        mediaKind: 'video',
        descriptor: { filename: 'clip.mp4', mime: 'video/mp4' },
      },
    ],
    attribution: { missionId: 'mission-yt-1', experimentId: 'exp-yt-1' },
    scheduledFor: null,
  });
  // A scheduled publish rides the documented status.publishAt.
  assertValidSocialPublishRequest({
    contentType: 'youtube.video',
    payload: { title: 'Scheduled' },
    mediaAssets: [],
    attribution: {},
    scheduledFor: '2026-09-01T12:00:00.000Z',
  });
  // The §21 backstop refuses material-shaped payloads (the frozen guard).
  assert.throws(
    () =>
      assertValidSocialPublishRequest({
        contentType: 'youtube.video',
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
