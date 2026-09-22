/**
 * MKT-059 integration-test harness — the FACEBOOK PAGES IN-MEMORY PLATFORM
 * DOUBLE (the conformance-suite adapter under test): a DISCLOSED TEST
 * DOUBLE AT THE PROVIDER BOUNDARY ONLY, faithfully modeled on the
 * DOCUMENTED Facebook Graph API Pages semantics (the same behavioral
 * model as the loopback HTTP double of
 * tests/integration/helpers/facebook-pages-http-double.ts, without the
 * wire — the MKT-057/MKT-058 double pattern; the contract HOST under
 * test is fully real).
 *
 * Fidelity model (the documented semantics — see docs/runbooks/MKT-059.md):
 *   - the HONEST capability matrix of the real adapter — FOUR of the
 *     five frozen families (account / content-read / analytics-read /
 *     publish); the restriction-signals family is honestly UNDECLARED
 *     (the documented Pages surface exposes no restriction-signal
 *     endpoint or field — account-level limitations surface as
 *     invocation failures, hidden moderation state is never invented,
 *     §11). The conformance suite's capability-subset scenario exercises
 *     the undeclared family's fail-closed refusal end-to-end;
 *   - the REAL Facebook Login scope names (pages_show_list,
 *     pages_read_engagement, pages_read_user_content, pages_manage_posts,
 *     read_insights — the verified documented permission set of the
 *     declared operations);
 *   - the documented PAGE-RESOLUTION model: every operation resolves the
 *     Page + its per-Page token through the documented /me/accounts
 *     surface (the echo semantics of the conformance run: the bound
 *     account of the suite's fixtures is a Page the user administers —
 *     the resolution succeeds and the Page name/tasks ride the identity
 *     answer; the HTTP double models the zero-page and task-restricted
 *     refusals for the real-adapter battery);
 *   - the documented Page feed/posts edges paginate over the
 *     data[]/paging.cursors.after protocol; the Post node exposes the
 *     reactions/comments summary totals and the shares count but NO
 *     view count (null — never fabricated);
 *   - the documented insights surfaces: day-period Page slices carrying
 *     end_time stamps (the provider labels VERBATIM) and per-post
 *     lifetime aggregates (no windows);
 *   - the documented SCHEDULED/UNPUBLISHED post lifecycle (the async
 *     path the conformance suite drives): the submission is born
 *     'accepted' (the pending unpublished/scheduled post — the post id
 *     is the provider publish identity); advancePublish moves the
 *     provider-side state (the scheduled window arriving → published
 *     with the post id as the content identity; the video processing
 *     error → the restricted/failed carriers of the real adapter's
 *     status mapping);
 *   - per-operation FAILURE INJECTION (setFailure/clearFailure) — the
 *     taxonomy battery;
 *   - CONTEXT RECORDING: every received SocialAdapterCallContext is
 *     recorded per operation — the account-identity/scope propagation
 *     battery asserts the host propagated the MKT-055 facts VERBATIM.
 */

import type {
  SocialAdapterCallContext,
  SocialAdapterFailureCode,
  SocialCapability,
  SocialPlatformAdapter,
  SocialRestrictionSignal,
} from '../../../src/modules/social-accounts/public.ts';

/** The Facebook Pages platform key (the frozen manifest's mvpSocialPlatforms[2]). */
export const FACEBOOK_PAGES_PLATFORM_KEY = 'facebook-pages';

/**
 * The REAL Facebook Login permission names (the verified documented
 * Pages scope surface — the conformance fixture grants).
 */
export const FACEBOOK_PAGES_FULL_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
  'read_insights',
] as const;
/**
 * The read-only grant (drives the insufficient-scope battery: the publish
 * family refuses — pages_manage_posts missing; account, content-read and
 * analytics-read stay satisfied).
 */
export const FACEBOOK_PAGES_READ_ONLY_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'read_insights',
] as const;

/** The honest capability matrix (mirrors the real adapter declaration — 4 of 5 families). */
export function facebookPagesDoubleCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: ['pages_show_list'],
      description:
        'Facebook Page identity + profile reads over the documented page-resolution surface /me/accounts + the Page node (test double mirroring the documented surface: Pages only, verifiedAt null).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: ['pages_read_engagement', 'pages_read_user_content', 'pages_show_list'],
      description:
        'Page-feed discovery + own-content listing + single reads over the documented feed/posts edges and the Post node (test double mirroring the documented surface: no view counts, cursor pagination).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: ['pages_read_engagement', 'read_insights', 'pages_show_list'],
      description:
        'Observed metric points over the documented Page insights edges (test double mirroring the documented surface: provider labels verbatim, day-period slices with end_time, lifetime post aggregates).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'],
      description:
        'The documented Page publishing surfaces incl. the scheduled/unpublished posts (test double mirroring the documented surface: the born pending post, the scheduled-window arrival, the video processing window).',
    },
  ];
}

/** The recorded Page post (the reference-double RecordedPublish shape + the idempotency-key observation). */
interface RecordedPost {
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
  readonly scheduled: boolean;
}

export interface FacebookPagesPlatformDouble extends SocialPlatformAdapter {
  /** The number of adapter-method invocations per operation. */
  callCount(operation: string): number;
  /** The recorded host call contexts per operation (the propagation battery). */
  contextsOf(operation: string): readonly SocialAdapterCallContext[];
  /** Scripts an operation to return the honest taxonomy failure. */
  setFailure(operation: string, code: SocialAdapterFailureCode, message?: string): void;
  /** Clears an operation's scripted failure. */
  clearFailure(operation: string): void;
  /** The state a fresh submit reports (default 'accepted' — the born pending/scheduled post; a terminal fast path for the batteries). */
  setNextSubmitState(state: 'accepted' | 'published' | 'failed' | 'restricted'): void;
  /** Moves a recorded post to a later state (the poll battery — the suite handle contract's providerContentId patch). */
  advancePublish(
    postId: string,
    state: 'accepted' | 'published' | 'failed' | 'restricted',
    patch?: { readonly providerContentId?: string; readonly statusText?: string },
  ): void;
  /** The recorded Page posts (the fence battery). */
  publishes(): readonly RecordedPost[];
  /** The recorded posts under a given idempotency key (the fence battery). */
  publishesForIdempotencyKey(idempotencyKey: string): readonly RecordedPost[];
}

/** The default Page fixture facts of the double (an administered Page). */
const FOLLOWERS_COUNT = 1337;
const FAN_COUNT = 2048;

function failureOf(code: SocialAdapterFailureCode, message: string, rateLimit = null) {
  return { ok: false as const, failure: { code, message, rateLimit } };
}

export function createFacebookPagesPlatformDouble(options?: {
  readonly adapterKey?: string;
  readonly capabilities?: readonly SocialCapability[];
}): FacebookPagesPlatformDouble {
  const adapterKey = options?.adapterKey ?? FACEBOOK_PAGES_PLATFORM_KEY;
  const capabilities = options?.capabilities ?? facebookPagesDoubleCapabilities();

  const callCounts = new Map<string, number>();
  const contexts = new Map<string, SocialAdapterCallContext[]>();
  const failures = new Map<string, { code: SocialAdapterFailureCode; message: string }>();
  const postsById = new Map<string, RecordedPost>();
  const postsByKey = new Map<string, RecordedPost[]>();
  let postSequence = 0;
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

  /**
   * The documented /me/accounts page resolution (the echo semantics of
   * the conformance run: the bound account of the suite's fixtures is a
   * Page the user administers — the resolution succeeds).
   */
  function resolvePage(context: SocialAdapterCallContext): { ok: true; pageName: string } {
    return { ok: true, pageName: `Page of ${context.externalAccountId}` };
  }

  /** The own-content fixture posts (the documented Page posts edge view). */
  function ownPosts(context: SocialAdapterCallContext) {
    return [1, 2, 3].map((index) => ({
      id: `page-post-${context.externalAccountId}-${index}`,
      from: { id: context.externalAccountId, name: `Page of ${context.externalAccountId}` },
      message: `Fixture Page post ${index} of ${context.externalAccountId}`,
      story: undefined,
      created_time: `2026-08-0${index}T10:00:00.000Z`,
      permalink_url: `https://www.facebook.com/double-${context.externalAccountId}/posts/${index}/`,
      status_type: 'added_photos',
      is_published: true,
      scheduled_publish_time: undefined,
      shares: { count: 3 * index },
      reactions: { summary: { total_count: 50 * index } },
      comments: { summary: { total_count: 5 * index } },
    }));
  }

  /**
   * The documented visitor/user posts of the feed edge (the public
   * discovery surface: other authors' posts on the Page + the tagged
   * public posts).
   */
  function feedPosts(context: SocialAdapterCallContext) {
    return [0, 1].map((index) => ({
      id: `page-feed-post-${context.externalAccountId}-${index}`,
      from: { id: `visitor-${index}`, name: `Visitor ${index}` },
      message: `Public visitor post ${index} on the Page of ${context.externalAccountId}`,
      story: undefined,
      created_time: '2026-08-01T08:00:00.000Z',
      permalink_url: `https://www.facebook.com/double-${context.externalAccountId}/posts/visitor-${index}/`,
      status_type: 'mobile_status_update',
      is_published: true,
      scheduled_publish_time: undefined,
      shares: { count: 2 * (index + 1) },
      reactions: { summary: { total_count: 20 * (index + 1) } },
      comments: { summary: { total_count: 4 * (index + 1) } },
    }));
  }

  /** The documented Post record mapping (reactions/comments summaries + shares; NO view count). */
  function postRecordOf(post: ReturnType<typeof ownPosts>[number]) {
    return {
      providerContentId: post.id as string,
      authorExternalAccountId: (post.from as { id?: unknown }).id as string,
      contentFormat: post.status_type as string,
      publishedAt: post.created_time as string,
      sourceTimestamp: post.created_time as string,
      engagement: {
        viewCount: null,
        likeCount: (post.reactions as { summary: { total_count: number } }).summary.total_count,
        commentCount: (post.comments as { summary: { total_count: number } }).summary.total_count,
        shareCount: (post.shares as { count: number }).count,
      },
      data: post as unknown as Readonly<Record<string, unknown>>,
      etag: null,
      sourceVersion: null,
    };
  }

  return {
    descriptor: {
      adapterKey,
      providerLabel: 'Facebook Pages (Graph API Pages surface)',
      description:
        'The disclosed in-memory Facebook Pages platform double of the MKT-059 conformance run — a test double at the provider boundary only, faithfully modeled on the documented Facebook Graph API Pages semantics; the contract host under test is fully real.',
    },
    capabilities,

    callCount(operation) {
      return callCounts.get(operation) ?? 0;
    },
    contextsOf(operation) {
      return [...(contexts.get(operation) ?? [])];
    },
    setFailure(operation, code, message) {
      failures.set(operation, { code, message: message ?? `the Facebook Pages platform double scripted a(n) ${code} failure` });
    },
    clearFailure(operation) {
      failures.delete(operation);
    },
    setNextSubmitState(state) {
      nextSubmitState = state;
    },
    advancePublish(postId, state, patch) {
      const post = postsById.get(postId);
      if (post === undefined) return;
      post.publishState = state;
      post.providerContentId = patch?.providerContentId ?? post.providerContentId;
      post.publishedAt = state === 'published' ? '2026-08-02T12:00:00.000Z' : null;
      post.providerFailureReason =
        state === 'failed'
          ? 'status.video_status=error — the documented video processing failed: the page post about the video never went live; a fresh publish (a new idempotency key) is the recovery'
          : null;
      post.restrictionSignals =
        state === 'restricted'
          ? [
              {
                signalKind: 'fb-pages.provider.refused',
                observedAt: null,
                description: `the Page publish ${post.providerPublishId} was refused by the provider (${patch?.statusText ?? 'the documented permissions-error semantics'})`,
                data: {
                  postId: post.providerPublishId,
                  status: patch?.statusText ?? 'the documented permissions-error semantics',
                },
              },
            ]
          : [];
    },
    publishesForIdempotencyKey(idempotencyKey) {
      return [...(postsByKey.get(idempotencyKey) ?? [])];
    },
    publishes() {
      return [...postsById.values()];
    },

    async verifyAccountIdentity(context) {
      record('verifyAccountIdentity', context);
      const scripted = scriptedFailure('verifyAccountIdentity');
      if (scripted !== null) return scripted;
      const resolution = resolvePage(context);
      return {
        ok: true,
        // The documented /me/accounts resolution view: the Page id +
        // the Page name; the documented surface exposes no verification
        // timestamp.
        identity: {
          externalAccountId: context.externalAccountId,
          displayIdentity: resolution.pageName,
          verifiedAt: null,
        },
        rateLimit: null,
      };
    },

    async getAccountProfile(context) {
      record('getAccountProfile', context);
      const scripted = scriptedFailure('getAccountProfile');
      if (scripted !== null) return scripted;
      return {
        ok: true,
        profile: {
          externalAccountId: context.externalAccountId,
          displayIdentity: `Page of ${context.externalAccountId}`,
          verifiedAt: null,
          // The provider's own Page category label rides verbatim.
          accountKind: 'Marketing Agency',
          followerCount: FOLLOWERS_COUNT,
          data: {
            id: context.externalAccountId,
            name: `Page of ${context.externalAccountId}`,
            category: 'Marketing Agency',
            followers_count: FOLLOWERS_COUNT,
            fan_count: FAN_COUNT,
          },
        },
        rateLimit: null,
      };
    },

    async discoverPublicContent(context, input) {
      record('discoverPublicContent', context);
      const scripted = scriptedFailure('discoverPublicContent');
      if (scripted !== null) return scripted;
      const pageTwo = input.pageCursor === 'fb-page-2';
      // The documented Page feed edge: the visitor/user posts + the
      // tagged public posts (the Page-feed-scoped discovery surface —
      // the caller query carries no documented parameter, honestly
      // unused) + the data[]/paging.cursors.after pagination.
      return {
        ok: true,
        page: {
          records: feedPosts(context)
            .slice(pageTwo ? 1 : 0, pageTwo ? 2 : 1)
            .map((post) => ({
              ...postRecordOf(post),
              data: {
                ...post,
                callerQueryUnused: input.query,
              },
            })),
          pageCursor: pageTwo ? null : 'fb-page-2',
        },
        rateLimit: null,
      };
    },

    async listOwnContent(context, input) {
      record('listOwnContent', context);
      const scripted = scriptedFailure('listOwnContent');
      if (scripted !== null) return scripted;
      const all = ownPosts(context);
      const pageTwo = input.pageCursor === 'fb-page-2';
      const slice = pageTwo ? all.slice(2) : all.slice(0, 2);
      return {
        ok: true,
        page: {
          records: slice.map(postRecordOf),
          pageCursor: pageTwo || slice.length < 2 ? null : 'fb-page-2',
        },
        rateLimit: null,
      };
    },

    async getContent(context, input) {
      record('getContent', context);
      const scripted = scriptedFailure('getContent');
      if (scripted !== null) return scripted;
      const own = ownPosts(context).find((post) => post.id === input.providerContentId);
      // The documented node-read answer for an unknown id is the
      // code-100 error envelope on the real surface; the honest fused
      // double surfaces the equivalent taxonomy data failure (the
      // disclosed 4xx→restricted judgment) — never a fabricated record.
      if (own === undefined) {
        return failureOf(
          'restricted',
          'the Facebook Graph API Pages getContent (Post node) call failed (HTTP 400, code 100, (#100) Unsupported get request. Object does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com) — the provider refused the request',
        );
      }
      return { ok: true, record: postRecordOf(own), rateLimit: null };
    },

    async readAccountAnalytics(context, input) {
      record('readAccountAnalytics', context);
      const scripted = scriptedFailure('readAccountAnalytics');
      if (scripted !== null) return scripted;
      // The documented day-period Page insights: data[] with
      // name/period/values[] (value + end_time per day slice).
      const metrics: readonly { readonly name: string; readonly value: number }[] = [
        { name: 'page_impressions', value: 12345 },
        { name: 'page_post_engagements', value: 678 },
        { name: 'page_views_total', value: 910 },
        { name: 'page_fans', value: FAN_COUNT },
      ];
      const since = input.windowStart ?? '2026-08-01T00:00:00.000Z';
      return {
        ok: true,
        observations: metrics.map((metric) => ({
          metric: metric.name,
          value: metric.value,
          windowStart: null,
          windowEnd: '2026-08-02T00:00:00.000Z',
          data: {
            period: 'day',
            providerWindowSince: since,
            insight: {
              name: metric.name,
              period: 'day',
              values: [{ value: metric.value, end_time: '2026-08-02T00:00:00.000Z' }],
              title: metric.name,
            },
          },
        })),
        rateLimit: null,
      };
    },

    async readContentAnalytics(context, input) {
      record('readContentAnalytics', context);
      const scripted = scriptedFailure('readContentAnalytics');
      if (scripted !== null) return scripted;
      // The documented per-post lifetime insights (the verified live
      // metric vocabulary; no windows — lifetime aggregates).
      const observations: {
        metric: string;
        value: number;
        windowStart: string | null;
        windowEnd: string | null;
        data: Record<string, unknown>;
      }[] = [];
      for (const postId of input.providerContentIds) {
        const lengthFactor = postId.length;
        for (const [metric, value] of [
          ['post_clicks', 40 * lengthFactor],
          ['post_impressions_organic', 1200 * lengthFactor],
          ['post_impressions_paid', 300 * lengthFactor],
          ['post_reactions_like_total', 60 * lengthFactor],
        ] as const) {
          observations.push({
            metric,
            value,
            windowStart: null,
            windowEnd: null,
            data: {
              providerContentId: postId,
              insight: { name: metric, period: 'lifetime', values: [{ value }] },
            },
          });
        }
      }
      return { ok: true, observations, rateLimit: null };
    },

    async submitPublish(context, input) {
      record('submitPublish', context);
      const scripted = scriptedFailure('submitPublish');
      if (scripted !== null) return scripted;
      postSequence += 1;
      const postId = `page-publish-${postSequence}`;
      const scheduled = input.request.scheduledFor !== null;
      const post: RecordedPost = {
        providerPublishId: postId,
        providerContentId:
          nextSubmitState === 'published' ? `page-post-published-${postId}` : null,
        publishState: nextSubmitState,
        publishedAt: null,
        providerFailureReason: null,
        restrictionSignals: [],
        idempotencyKey: input.idempotencyKey,
        contentType: input.request.contentType,
        payload: input.request.payload,
        attribution: input.request.attribution,
        scheduled,
      };
      postsById.set(postId, post);
      const keyList = postsByKey.get(input.idempotencyKey) ?? [];
      keyList.push(post);
      postsByKey.set(input.idempotencyKey, keyList);
      return {
        ok: true,
        submission: {
          // The born pending post (the documented scheduled/unpublished
          // + video-processing surfaces are the async paths the
          // conformance suite drives): 'accepted' by default — the post
          // id is the provider publish identity and NO content id
          // exists yet; the terminal fast path when a battery
          // scripted a submit state.
          publishState: post.publishState,
          providerPublishId: post.providerPublishId,
          providerContentId: post.providerContentId,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: post.restrictionSignals,
          providerData: { id: post.providerPublishId, scheduled, scheduledFor: input.request.scheduledFor },
        },
        rateLimit: null,
      };
    },

    async getPublishStatus(context, input) {
      record('getPublishStatus', context);
      const scripted = scriptedFailure('getPublishStatus');
      if (scripted !== null) return scripted;
      const post = postsById.get(input.providerPublishId);
      if (post === undefined) {
        return failureOf(
          'restricted',
          'the Facebook Graph API Pages getPublishStatus (post/video node) call failed (HTTP 400, code 100, (#100) Unsupported get request. Object does not exist, cannot be loaded due to missing permissions, or does not support this operation) — the provider refused the request',
        );
      }
      const statusNode = {
        id: post.providerPublishId,
        is_published: post.publishState === 'published',
        published: post.publishState === 'published',
        scheduled_publish_time: post.scheduled ? Math.floor(Date.parse('2026-08-02T12:00:00.000Z') / 1000) : undefined,
        created_time: post.publishedAt,
        status:
          post.providerFailureReason !== null
            ? { video_status: 'error' }
            : post.publishState === 'published'
              ? { video_status: 'ready' }
              : { video_status: 'processing' },
      };
      return {
        ok: true,
        status: {
          publishState: post.publishState,
          providerPublishId: post.providerPublishId,
          // The post id IS the content identity on the published path
          // (the double mirrors the real adapter's providerContentId
          // carrier; the pending post carries none).
          providerContentId: post.publishState === 'published' ? post.providerContentId ?? post.providerPublishId : null,
          publishedAt: post.publishedAt,
          providerFailureReason: post.providerFailureReason,
          restrictionSignals: post.restrictionSignals,
          providerData: statusNode,
        },
        rateLimit: null,
      };
    },
  };
}
