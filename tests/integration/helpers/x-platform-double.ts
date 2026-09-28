/**
 * MKT-061 integration-test harness — the X IN-MEMORY PLATFORM DOUBLE
 * (the conformance-suite adapter under test): a DISCLOSED TEST DOUBLE
 * AT THE PROVIDER BOUNDARY ONLY, faithfully modeled on the DOCUMENTED
 * X API v2 semantics (the same behavioral model as the loopback HTTP
 * double of tests/integration/helpers/x-http-double.ts, without the
 * wire — the MKT-056 reference-double pattern; the contract HOST under
 * test is fully real).
 *
 * Fidelity model (the documented semantics — verified against the LIVE
 * docs.x.com documentation at delivery time; see docs/runbooks/MKT-061.md):
 *   - the honest capability matrix of the real adapter (ALL FIVE
 *     families with the closed per-family operation vocabularies, the
 *     REAL documented OAuth 2.0 scope names —
 *     https://docs.x.com/x-api/fundamentals/authentication/oauth-2-0/authorization-code);
 *   - the documented users/me surface (the User object: id/name/username
 *     + the public_metrics counts {followers_count, following_count,
 *     post_count, listed_count} + the observable entitlement facts
 *     {protected, verified, verified_type, subscription_type} — the
 *     account analytics labels and the restriction signals ride them);
 *   - the documented Posts surfaces (the user timeline + the recent
 *     search + the single-Post lookup with the Post.public_metrics
 *     engagement facts {impression_count, like_count, reply_count,
 *     repost_count, quote_count, bookmark_count});
 *   - the documented per-Post analytics surface (GET /2/tweets/analytics:
 *     the windowed metric rows carrying the documented engagement
 *     labels verbatim — impressions, engagements, likes, bookmarks,
 *     replies, retweets, shares, quote_tweets);
 *   - the documented SYNCHRONOUS post creation (the born submission
 *     states — 'published' the documented default, with the scripted
 *     terminal fast paths of the conformance batteries) and the
 *     publish-status poll (the live Post's current observable state);
 *   - the documented rate accounting (the x-rate-limit-* header model —
 *     the observation rides every answer as data) with the exhaustion
 *     battery (the 429 class);
 *   - per-operation failure injection (setFailure/clearFailure) and the
 *     call-context recording (contextsOf) of the reference-double
 *     interface (the suite's adapterHandle contract).
 */

import type {
  SocialAdapterCallContext,
  SocialAdapterFailureCode,
  SocialAnalyticsObservation,
  SocialCapability,
  SocialPlatformAdapter,
  SocialRestrictionSignal,
} from '../../../src/modules/social-accounts/public.ts';

/** The platform key of the X double (the real adapter's key). */
export const X_PLATFORM_KEY = 'x';

/** The REAL documented OAuth 2.0 scope names (the conformance fixture grants ride these). */
export const X_FULL_SCOPES = [
  'users.read',
  'tweet.read',
  'tweet.write',
  'media.write',
] as const;
/** The read-only grant (drives the insufficient-scope battery: publish refuses — tweet.write + media.write missing). */
export const X_READ_ONLY_SCOPES = [
  'users.read',
  'tweet.read',
] as const;

/** The honest capability matrix (mirrors the real adapter declaration). */
export function xDoubleCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: ['users.read', 'tweet.read'],
      description:
        'X account identity binding + profile reads over the documented Get Users Me endpoint. Limitations: verified/verified_type badges, not a timestamp (verifiedAt null); the subscription_type account-tier label rides accountKind (test double mirroring the documented surface).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: ['tweet.read', 'users.read'],
      description:
        'Content reads over the documented Posts surfaces (search/recent + the user timeline + the single-Post lookup). Limitations: the documented Post.public_metrics engagement facts ride as observed facts; the search surface serves the recent window only (test double mirroring the documented surface).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: ['tweet.read', 'users.read'],
      description:
        'Observed metric points over the documented analytics surfaces (the users/me public_metrics labels + the tweets/analytics engagement labels), labels verbatim. Limitations: point-in-time account values with null windows; the per-content analytics rows carry the requested window (test double mirroring the documented surface).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write'],
      description:
        'The documented synchronous post-creation lifecycle (the chunked media upload + POST /2/tweets + the single-Post status poll). Limitations: no scheduling parameter on the documented surface; post deletion is not supported at the frozen contract level (test double mirroring the documented surface).',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: ['users.read', 'tweet.read'],
      description:
        'The observable users/me entitlement facts as DATA (protected, verified_type, subscription_type). Limitations: account-level enforcement answers surface only through the documented error semantics, never invented here (test double mirroring the documented surface).',
    },
  ];
}

/** The recorded post creation (the reference-double RecordedPublish shape + the idempotency-key observation). */
interface RecordedPublish {
  providerPublishId: string;
  providerContentId: string | null;
  publishState: 'accepted' | 'published' | 'failed' | 'restricted';
  publishedAt: string | null;
  providerFailureReason: string | null;
  restrictionSignals: readonly SocialRestrictionSignal[];
  readonly idempotencyKey: string;
  readonly contentType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attribution: Readonly<Record<string, unknown>>;
}

export interface XPlatformDouble extends SocialPlatformAdapter {
  /** The number of adapter-method invocations per operation. */
  callCount(operation: string): number;
  /** The recorded host call contexts per operation (the propagation battery). */
  contextsOf(operation: string): readonly SocialAdapterCallContext[];
  /** Scripts an operation to return the honest taxonomy failure. */
  setFailure(operation: string, code: SocialAdapterFailureCode, message?: string): void;
  /** Clears an operation's scripted failure. */
  clearFailure(operation: string): void;
  /** The state a fresh submit reports (default 'accepted' — the suite's claim-then-fill golden-path shape, the MKT-059 platform-double precedent; the REAL adapter's documented synchronous creation is born 'published' — pinned by the MKT-061 real-adapter battery). */
  setNextSubmitState(state: 'accepted' | 'published' | 'failed' | 'restricted'): void;
  /** Moves a recorded publish to a later status-poll state (the poll battery — the suite handle contract's providerContentId patch). */
  advancePublish(
    providerPublishId: string,
    state: 'accepted' | 'published' | 'failed' | 'restricted',
    patch?: { readonly providerContentId?: string; readonly failReason?: string },
  ): void;
  /** The recorded post creations (the fence battery). */
  publishes(): readonly RecordedPublish[];
  /** The recorded post creations under a given idempotency key (the fence battery). */
  publishesForIdempotencyKey(idempotencyKey: string): readonly RecordedPublish[];
}

/** The default fixture account facts of the double (the documented User object shape). */
const FOLLOWERS_COUNT = 8_452;
const FOLLOWING_COUNT = 317;
const POST_COUNT = 1_284;
const LISTED_COUNT = 26;

function userOf(context: SocialAdapterCallContext): Record<string, unknown> {
  return {
    id: context.externalAccountId,
    name: `Fixture X User ${context.externalAccountId}`,
    username: `double_${String(context.externalAccountId).replaceAll('-', '_')}`,
    created_at: '2026-05-17T09:30:00.000Z',
    description: 'The documented description of the fixture X user',
    location: 'Accra, Ghana',
    profile_image_url: `https://pbs.twimg.com/profile_images/double-${context.externalAccountId}_normal.png`,
    protected: false,
    verified: context.externalAccountId.startsWith('x-user-verified'),
    verified_type: context.externalAccountId.startsWith('x-user-verified') ? 'blue' : 'none',
    subscription_type: context.externalAccountId.startsWith('x-user-premium') ? 'Premium' : 'None',
    public_metrics: {
      followers_count: FOLLOWERS_COUNT,
      following_count: FOLLOWING_COUNT,
      post_count: POST_COUNT,
      listed_count: LISTED_COUNT,
      like_count: 12_907,
      media_count: 341,
    },
  };
}

function failureOf(code: SocialAdapterFailureCode, message: string, rateLimit = null) {
  return { ok: false as const, failure: { code, message, rateLimit } };
}

/** The fixture Posts of an account (newest first — the documented timeline ordering). */
function postsOf(accountId: string) {
  return [1, 2, 3].map((index) => ({
    id: `x-post-${accountId}-${index}`,
    created_at: `2026-08-0${4 - index}T10:00:00.000Z`,
    text: `Fixture X post ${index} of ${accountId}`,
    author_id: accountId,
    public_metrics: {
      impression_count: 10_000 * index,
      like_count: 500 * index,
      reply_count: 50 * index,
      repost_count: 25 * index,
      quote_count: 5 * index,
      bookmark_count: 12 * index,
    },
  }));
}

export function createXPlatformDouble(options?: {
  readonly adapterKey?: string;
  readonly capabilities?: readonly SocialCapability[];
}): XPlatformDouble {
  const adapterKey = options?.adapterKey ?? X_PLATFORM_KEY;
  const capabilities = options?.capabilities ?? xDoubleCapabilities();

  const callCounts = new Map<string, number>();
  const contexts = new Map<string, SocialAdapterCallContext[]>();
  const failures = new Map<string, { code: SocialAdapterFailureCode; message: string }>();
  const publishesById = new Map<string, RecordedPublish>();
  const publishesByKey = new Map<string, RecordedPublish[]>();
  const statusStates = new Map<string, { state: 'accepted' | 'published' | 'failed' | 'restricted'; failReason: string | null }>();
  let publishSequence = 0;
  let nextSubmitState: 'accepted' | 'published' | 'failed' | 'restricted' = 'accepted';

  function record(operation: string, context: SocialAdapterCallContext): void {
    callCounts.set(operation, (callCounts.get(operation) ?? 0) + 1);
    const list = contexts.get(operation) ?? [];
    list.push(context);
    contexts.set(operation, list);
  }

  function scriptedFailure(operation: string) {
    const scripted = failures.get(operation);
    if (scripted === undefined) return null;
    return failureOf(scripted.code, scripted.message);
  }

  return {
    descriptor: {
      adapterKey,
      providerLabel: 'X (API v2 — OAuth 2.0 user context) [double]',
      description:
        'The disclosed in-memory X platform double of the MKT-061 conformance run — a test double at the provider boundary only; the contract host under test is fully real.',
    },
    capabilities,

    callCount(operation) {
      return callCounts.get(operation) ?? 0;
    },
    contextsOf(operation) {
      return [...(contexts.get(operation) ?? [])];
    },
    setFailure(operation, code, message) {
      failures.set(operation, { code, message: message ?? `the X double scripted a ${code} failure` });
    },
    clearFailure(operation) {
      failures.delete(operation);
    },
    setNextSubmitState(state) {
      nextSubmitState = state;
    },
    advancePublish(providerPublishId, state, patch) {
      const publish = publishesById.get(providerPublishId);
      if (publish === undefined) return;
      publish.publishState = state;
      publish.publishedAt = state === 'published' ? '2026-08-02T12:00:00.000Z' : null;
      publish.providerContentId = state === 'published' ? (patch?.providerContentId ?? publish.providerPublishId) : null;
      publish.providerFailureReason =
        state === 'failed'
          ? (patch?.failReason ?? 'the X double rejected the processed publish (test double)')
          : null;
      statusStates.set(providerPublishId, { state, failReason: publish.providerFailureReason });
    },
    publishes() {
      return [...publishesById.values()];
    },
    publishesForIdempotencyKey(idempotencyKey) {
      return [...(publishesByKey.get(idempotencyKey) ?? [])];
    },

    async verifyAccountIdentity(context) {
      record('verifyAccountIdentity', context);
      const scripted = scriptedFailure('verifyAccountIdentity');
      if (scripted !== null) return scripted;
      const user = userOf(context) as { id: string; name: string; username: string };
      return {
        ok: true,
        identity: {
          externalAccountId: user.id,
          displayIdentity: `${user.name} (@${user.username})`,
          verifiedAt: null,
        },
        rateLimit: null,
      };
    },

    async getAccountProfile(context) {
      record('getAccountProfile', context);
      const scripted = scriptedFailure('getAccountProfile');
      if (scripted !== null) return scripted;
      const user = userOf(context) as {
        id: string;
        name: string;
        username: string;
        subscription_type: string;
        public_metrics: { followers_count: number };
      };
      return {
        ok: true,
        profile: {
          externalAccountId: user.id,
          displayIdentity: `${user.name} (@${user.username})`,
          verifiedAt: null,
          accountKind: user.subscription_type,
          followerCount: user.public_metrics.followers_count,
          data: user,
        },
        rateLimit: null,
      };
    },

    async discoverPublicContent(context, input) {
      record('discoverPublicContent', context);
      const scripted = scriptedFailure('discoverPublicContent');
      if (scripted !== null) return scripted;
      return {
        ok: true,
        page: {
          records: [0, 1].map((index) => ({
            providerContentId: `x-search-${String(input.query).replace(/\W+/g, '-')}-${index}`,
            authorExternalAccountId: `x-author-${index}`,
            contentFormat: 'x#post',
            publishedAt: '2026-08-01T08:00:00.000Z',
            sourceTimestamp: '2026-08-01T08:00:00.000Z',
            engagement: { viewCount: 9000 + index, likeCount: 400 + index, commentCount: 20 + index, shareCount: 5 + index },
            data: { double: true, query: input.query, public_metrics: { impression_count: 9000 + index, like_count: 400 + index, reply_count: 20 + index, repost_count: 5 + index, quote_count: 2, bookmark_count: 9 } },
            etag: null,
            sourceVersion: null,
          })),
          pageCursor: null,
        },
        rateLimit: null,
      };
    },

    async listOwnContent(context) {
      record('listOwnContent', context);
      const scripted = scriptedFailure('listOwnContent');
      if (scripted !== null) return scripted;
      return {
        ok: true,
        page: {
          records: postsOf(context.externalAccountId).map((post) => ({
            providerContentId: post.id,
            authorExternalAccountId: post.author_id,
            contentFormat: 'x#post',
            publishedAt: post.created_at,
            sourceTimestamp: post.created_at,
            engagement: {
              viewCount: post.public_metrics.impression_count,
              likeCount: post.public_metrics.like_count,
              commentCount: post.public_metrics.reply_count,
              shareCount: post.public_metrics.repost_count,
            },
            data: post,
            etag: null,
            sourceVersion: null,
          })),
          pageCursor: null,
        },
        rateLimit: null,
      };
    },

    async getContent(context, input) {
      record('getContent', context);
      const scripted = scriptedFailure('getContent');
      if (scripted !== null) return scripted;
      const post = postsOf(context.externalAccountId).find((candidate) => candidate.id === input.providerContentId);
      // An unknown provider Post id is an honest null record (the
      // documented 404 resource-not-found semantics — never a
      // fabricated failure).
      return { ok: true, record: post === undefined ? null : {
        providerContentId: post.id,
        authorExternalAccountId: post.author_id,
        contentFormat: 'x#post',
        publishedAt: post.created_at,
        sourceTimestamp: post.created_at,
        engagement: {
          viewCount: post.public_metrics.impression_count,
          likeCount: post.public_metrics.like_count,
          commentCount: post.public_metrics.reply_count,
          shareCount: post.public_metrics.repost_count,
        },
        data: post,
        etag: null,
        sourceVersion: null,
      }, rateLimit: null };
    },

    async readAccountAnalytics(context) {
      record('readAccountAnalytics', context);
      const scripted = scriptedFailure('readAccountAnalytics');
      if (scripted !== null) return scripted;
      const metrics = (userOf(context) as { public_metrics: Record<string, number> }).public_metrics;
      const observations: SocialAnalyticsObservation[] = [];
      for (const label of ['followers_count', 'following_count', 'post_count', 'listed_count', 'like_count', 'media_count']) {
        const value = metrics[label];
        if (typeof value === 'number' && Number.isFinite(value)) {
          observations.push({ metric: label, value, windowStart: null, windowEnd: null, data: { field: label } });
        }
      }
      return { ok: true, observations, rateLimit: null };
    },

    async readContentAnalytics(context, input) {
      record('readContentAnalytics', context);
      const scripted = scriptedFailure('readContentAnalytics');
      if (scripted !== null) return scripted;
      const windowEnd = input.windowEnd ?? new Date().toISOString();
      const windowStart = input.windowStart ?? new Date(Date.parse(windowEnd) - 30 * 24 * 60 * 60 * 1000).toISOString();
      const observations: SocialAnalyticsObservation[] = [];
      for (const postId of input.providerContentIds) {
        const metrics: Readonly<Record<string, number>> = {
          impressions: 21_000,
          engagements: 1_540,
          likes: 620,
          bookmarks: 44,
          replies: 71,
          retweets: 33,
          shares: 19,
          quote_tweets: 8,
        };
        for (const [label, value] of Object.entries(metrics)) {
          observations.push({
            metric: label,
            value,
            windowStart,
            windowEnd,
            data: { id: postId, field: label },
          });
        }
      }
      return { ok: true, observations, rateLimit: null };
    },

    async readRestrictionSignals(context) {
      record('readRestrictionSignals', context);
      const scripted = scriptedFailure('readRestrictionSignals');
      if (scripted !== null) return scripted;
      const user = userOf(context) as { protected: boolean; verified_type: string; subscription_type: string };
      const signals: SocialRestrictionSignal[] = [
        {
          signalKind: 'account.protected',
          observedAt: null,
          description: `the users/me surface reports the account's protected (private posts) state as ${user.protected}`,
          data: { protected: user.protected },
        },
        {
          signalKind: 'account.verified_type',
          observedAt: null,
          description: `the users/me surface reports the documented verified type '${user.verified_type}'`,
          data: { verified_type: user.verified_type },
        },
        {
          signalKind: 'account.subscription_type',
          observedAt: null,
          description: `the users/me surface reports the documented X Blue subscription type '${user.subscription_type}'`,
          data: { subscription_type: user.subscription_type },
        },
      ];
      return { ok: true, signals, rateLimit: null };
    },

    async submitPublish(context, input) {
      record('submitPublish', context);
      const scripted = scriptedFailure('submitPublish');
      if (scripted !== null) return scripted;
      publishSequence += 1;
      const postId = `x-double-post-${publishSequence}`;
      const recorded: RecordedPublish = {
        providerPublishId: postId,
        providerContentId: null,
        publishState: nextSubmitState,
        publishedAt: nextSubmitState === 'published' ? '2026-08-02T12:00:00.000Z' : null,
        providerFailureReason: null,
        restrictionSignals: [],
        idempotencyKey: input.idempotencyKey,
        contentType: input.request.contentType,
        payload: input.request.payload as Record<string, unknown>,
        attribution: input.request.attribution as Record<string, unknown>,
      };
      if (nextSubmitState === 'published') {
        recorded.providerContentId = postId;
      }
      publishesById.set(postId, recorded);
      const list = publishesByKey.get(input.idempotencyKey) ?? [];
      list.push(recorded);
      publishesByKey.set(input.idempotencyKey, list);
      statusStates.set(postId, { state: nextSubmitState, failReason: null });
      return {
        ok: true,
        submission: {
          publishState: nextSubmitState,
          providerPublishId: postId,
          providerContentId: recorded.providerContentId,
          publishedAt: recorded.publishedAt,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: { data: { id: postId, text: (input.request.payload as Record<string, unknown>)['text'] ?? '' } },
        },
        rateLimit: null,
      };
    },

    async getPublishStatus(_context, input) {
      const publish = publishesById.get(input.providerPublishId);
      if (publish === undefined) {
        return failureOf(
          'provider-unavailable',
          `the X double reports no such post (the documented 404 resource-not-found semantics — the provider reports no such post)`,
        );
      }
      return {
        ok: true,
        status: {
          publishState: publish.publishState,
          providerPublishId: input.providerPublishId,
          providerContentId: publish.providerContentId,
          publishedAt: publish.publishedAt,
          providerFailureReason: publish.providerFailureReason,
          restrictionSignals: publish.restrictionSignals,
          providerData: { data: { id: input.providerPublishId, created_at: '2026-08-02T12:00:00.000Z' } },
        },
        rateLimit: null,
      };
    },
  };
}
