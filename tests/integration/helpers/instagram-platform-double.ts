/**
 * MKT-058 integration-test harness — the INSTAGRAM IN-MEMORY PLATFORM
 * DOUBLE (the conformance-suite adapter under test): a DISCLOSED TEST
 * DOUBLE AT THE PROVIDER BOUNDARY ONLY, faithfully modeled on the
 * DOCUMENTED Instagram Graph API semantics for Professional accounts
 * (the same behavioral model as the loopback HTTP double of
 * tests/integration/helpers/instagram-http-double.ts, without the wire —
 * the MKT-057 YouTube double pattern; the contract HOST under test is
 * fully real).
 *
 * Fidelity model (the documented semantics — see docs/runbooks/MKT-058.md):
 *   - the HONEST capability matrix of the real adapter — FOUR of the
 *     five frozen families (account / content-read / analytics-read /
 *     publish); the restriction-signals family is honestly UNDECLARED
 *     (the documented Instagram surface exposes no restriction-signal
 *     endpoint — account-level limitations surface as invocation
 *     failures, hidden moderation state is never invented, §11). The
 *     conformance suite's capability-subset scenario exercises the
 *     undeclared family's fail-closed refusal end-to-end;
 *   - the REAL Facebook Login scope names (instagram_basic,
 *     instagram_content_publish, instagram_manage_insights,
 *     pages_show_list, pages_read_engagement — the documented scope
 *     surface the Instagram Graph API rides on);
 *   - the account profile answers the documented IG User node shape
 *     (username, account_type=BUSINESS/CREATOR, followers_count,
 *     media_count — the Professional-account surface; verifiedAt is
 *     null: the documented node exposes no verification timestamp);
 *   - hashtag-scoped discovery pages (the documented
 *     ig_hashtag_search + top_media surface) and the own-content
 *     listing pages (the documented Media edge) paginate over the
 *     documented data[]/paging.cursors.after protocol; the media node
 *     exposes like_count/comments_count but NO view count and NO share
 *     count (both null — never fabricated);
 *   - the analytics reads surface the documented insight shapes:
 *     day-period account slices carrying end_time stamps (the provider
 *     labels VERBATIM) and per-media lifetime aggregates (no windows);
 *   - the publish lifecycle is the documented container-based two-step
 *     publish: the container is born IN_PROGRESS (the born 'accepted'
 *     submission — the container id is the provider publish identity);
 *     advancePublish moves the provider-side container state; the
 *     publish step (the FINISHED → media_publish transition) is
 *     represented by the suite handle's advancePublish(providerPublishId,
 *     'published', { providerContentId }) patch;
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

/** The Instagram platform key (the frozen manifest's mvpSocialPlatforms[1]). */
export const INSTAGRAM_PLATFORM_KEY = 'instagram';

/**
 * The REAL Facebook Login scope names (the documented Instagram Graph
 * API permission surface — the conformance fixture grants).
 */
export const INSTAGRAM_FULL_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
] as const;
/** The read-only grant (drives the insufficient-scope battery: analytics + publish refuse). */
export const INSTAGRAM_READ_ONLY_SCOPES = [
  'instagram_basic',
  'pages_show_list',
  'pages_read_engagement',
] as const;

/** The honest capability matrix (mirrors the real adapter declaration — 4 of 5 families). */
export function instagramDoubleCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: ['instagram_basic', 'pages_show_list'],
      description:
        'Instagram Professional account identity + profile reads over the documented IG User node (test double mirroring the documented surface: Business/Creator only, verifiedAt null).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: ['instagram_basic', 'pages_read_engagement'],
      description:
        'Hashtag-scoped discovery + own-content listing + single reads over the documented Media surfaces (test double mirroring the documented surface: no view/share counts, cursor pagination).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: ['instagram_basic', 'instagram_manage_insights'],
      description:
        'Observed metric points over the documented Insights edges (test double mirroring the documented surface: provider labels verbatim, day-period slices with end_time, lifetime media aggregates).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [
        'instagram_basic',
        'instagram_content_publish',
        'pages_show_list',
        'pages_read_engagement',
      ],
      description:
        'The documented container-based two-step publish (test double mirroring the documented surface: the born IN_PROGRESS container, the FINISHED → media_publish step, the 24h EXPIRED/ERROR outcomes).',
    },
  ];
}

/** The recorded media container (the reference-double RecordedPublish shape + the idempotency-key observation). */
interface RecordedContainer {
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

export interface InstagramPlatformDouble extends SocialPlatformAdapter {
  /** The number of adapter-method invocations per operation. */
  callCount(operation: string): number;
  /** The recorded host call contexts per operation (the propagation battery). */
  contextsOf(operation: string): readonly SocialAdapterCallContext[];
  /** Scripts an operation to return the honest taxonomy failure. */
  setFailure(operation: string, code: SocialAdapterFailureCode, message?: string): void;
  /** Clears an operation's scripted failure. */
  clearFailure(operation: string): void;
  /** The state a fresh submit reports (default 'accepted' — the born IN_PROGRESS container; a terminal fast path for the batteries). */
  setNextSubmitState(state: 'accepted' | 'published' | 'failed' | 'restricted'): void;
  /** Moves a recorded container to a later state (the poll battery — the suite handle contract's providerContentId patch). */
  advancePublish(
    containerId: string,
    state: 'accepted' | 'published' | 'failed' | 'restricted',
    patch?: { readonly providerContentId?: string; readonly statusText?: string },
  ): void;
  /** The recorded media containers (the fence battery). */
  publishes(): readonly RecordedContainer[];
  /** The recorded containers under a given idempotency key (the fence battery). */
  publishesForIdempotencyKey(idempotencyKey: string): readonly RecordedContainer[];
}

/** The default IG account fixture facts of the double (a BUSINESS Professional account). */
const FOLLOWERS_COUNT = 4242;

function failureOf(code: SocialAdapterFailureCode, message: string, rateLimit = null) {
  return { ok: false as const, failure: { code, message, rateLimit } };
}

export function createInstagramPlatformDouble(options?: {
  readonly adapterKey?: string;
  readonly capabilities?: readonly SocialCapability[];
}): InstagramPlatformDouble {
  const adapterKey = options?.adapterKey ?? INSTAGRAM_PLATFORM_KEY;
  const capabilities = options?.capabilities ?? instagramDoubleCapabilities();

  const callCounts = new Map<string, number>();
  const contexts = new Map<string, SocialAdapterCallContext[]>();
  const failures = new Map<string, { code: SocialAdapterFailureCode; message: string }>();
  const containersById = new Map<string, RecordedContainer>();
  const containersByKey = new Map<string, RecordedContainer[]>();
  let containerSequence = 0;
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

  /** The own-content fixture media (the documented Media edge view). */
  function ownMedia(context: SocialAdapterCallContext) {
    return [1, 2, 3].map((index) => ({
      id: `ig-media-${context.externalAccountId}-${index}`,
      caption: `Fixture media ${index} of ${context.externalAccountId}`,
      media_type: 'IMAGE',
      media_url: `https://cdn.example/ig/${context.externalAccountId}-${index}.jpg`,
      permalink: `https://www.instagram.com/p/double-${context.externalAccountId}-${index}/`,
      timestamp: `2026-08-0${index}T10:00:00.000Z`,
      username: `fixture_${context.externalAccountId}`,
      like_count: 100 * index,
      comments_count: 10 * index,
    }));
  }

  /** The documented IG Media record mapping (like/comments only — no view/share counts). */
  function mediaRecordOf(media: ReturnType<typeof ownMedia>[number]) {
    return {
      providerContentId: media.id,
      authorExternalAccountId: null,
      contentFormat: media.media_type,
      publishedAt: media.timestamp,
      sourceTimestamp: media.timestamp,
      engagement: { viewCount: null, likeCount: media.like_count, commentCount: media.comments_count, shareCount: null },
      data: media as unknown as Readonly<Record<string, unknown>>,
      etag: null,
      sourceVersion: null,
    };
  }

  return {
    descriptor: {
      adapterKey,
      providerLabel: 'Instagram (Instagram Graph API, Professional accounts)',
      description:
        'The disclosed in-memory Instagram platform double of the MKT-058 conformance run — a test double at the provider boundary only, faithfully modeled on the documented Instagram Graph API semantics for Professional accounts; the contract host under test is fully real.',
    },
    capabilities,

    callCount(operation) {
      return callCounts.get(operation) ?? 0;
    },
    contextsOf(operation) {
      return [...(contexts.get(operation) ?? [])];
    },
    setFailure(operation, code, message) {
      failures.set(operation, { code, message: message ?? `the Instagram platform double scripted a(n) ${code} failure` });
    },
    clearFailure(operation) {
      failures.delete(operation);
    },
    setNextSubmitState(state) {
      nextSubmitState = state;
    },
    advancePublish(containerId, state, patch) {
      const container = containersById.get(containerId);
      if (container === undefined) return;
      container.publishState = state;
      container.providerContentId = patch?.providerContentId ?? container.providerContentId;
      container.publishedAt = state === 'published' ? '2026-08-02T12:00:00.000Z' : null;
      container.providerFailureReason =
        state === 'failed'
          ? 'status_code=EXPIRED — the documented 24-hour container expiry: the publish never happened; a fresh container (a new idempotency key) is the recovery'
          : null;
      container.restrictionSignals =
        state === 'restricted'
          ? [
              {
                signalKind: 'ig-container.status_code.ERROR',
                observedAt: null,
                description: `media container ${container.providerPublishId} carries status_code=ERROR (${patch?.statusText ?? 'the container failed to complete'})`,
                data: {
                  containerId: container.providerPublishId,
                  statusCode: 'ERROR',
                  status: patch?.statusText ?? 'the container failed to complete',
                },
              },
            ]
          : [];
    },
    publishesForIdempotencyKey(idempotencyKey) {
      return [...(containersByKey.get(idempotencyKey) ?? [])];
    },
    publishes() {
      return [...containersById.values()];
    },

    async verifyAccountIdentity(context) {
      record('verifyAccountIdentity', context);
      const scripted = scriptedFailure('verifyAccountIdentity');
      if (scripted !== null) return scripted;
      return {
        ok: true,
        // The documented IG User node view: the account id + username;
        // the documented node exposes no verification timestamp.
        identity: {
          externalAccountId: context.externalAccountId,
          displayIdentity: `fixture_${context.externalAccountId}`,
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
          displayIdentity: `fixture_${context.externalAccountId}`,
          verifiedAt: null,
          // The provider's own account-type label (the documented
          // account_type field: BUSINESS/CREATOR — the Professional-
          // account surface).
          accountKind: 'BUSINESS',
          followerCount: FOLLOWERS_COUNT,
          data: {
            id: context.externalAccountId,
            username: `fixture_${context.externalAccountId}`,
            account_type: 'BUSINESS',
            followers_count: FOLLOWERS_COUNT,
            media_count: 3,
            profile_picture_url: `https://cdn.example/ig/${context.externalAccountId}.jpg`,
          },
        },
        rateLimit: null,
      };
    },

    async discoverPublicContent(context, input) {
      record('discoverPublicContent', context);
      const scripted = scriptedFailure('discoverPublicContent');
      if (scripted !== null) return scripted;
      const slug = input.query.replace(/\W+/g, '').slice(0, 30);
      const pageTwo = input.pageCursor === 'ig-page-2';
      // The documented hashtag top_media page: like_count/comments_count
      // (no view/share counts — never fabricated) + the
      // data[]/paging.cursors.after pagination.
      return {
        ok: true,
        page: {
          records: (pageTwo ? [2] : [0, 1]).map((index) => ({
            providerContentId: `ig-hashtag-media-${slug}-${index}`,
            authorExternalAccountId: null,
            contentFormat: 'IMAGE',
            publishedAt: '2026-08-01T08:00:00.000Z',
            sourceTimestamp: '2026-08-01T08:00:00.000Z',
            engagement: { viewCount: null, likeCount: 100 * (index + 1), commentCount: 10 * (index + 1), shareCount: null },
            data: {
              id: `ig-hashtag-media-${slug}-${index}`,
              caption: `Public result ${index} for #${slug}`,
              media_type: 'IMAGE',
              media_url: `https://cdn.example/hashtag/${slug}-${index}.jpg`,
              permalink: `https://www.instagram.com/p/hashtag-${slug}-${index}/`,
              timestamp: '2026-08-01T08:00:00.000Z',
              like_count: 100 * (index + 1),
              comments_count: 10 * (index + 1),
            },
            etag: null,
            sourceVersion: null,
          })),
          pageCursor: pageTwo ? null : 'ig-page-2',
        },
        rateLimit: null,
      };
    },

    async listOwnContent(context, input) {
      record('listOwnContent', context);
      const scripted = scriptedFailure('listOwnContent');
      if (scripted !== null) return scripted;
      const all = ownMedia(context);
      const pageTwo = input.pageCursor === 'ig-page-2';
      const slice = pageTwo ? all.slice(2) : all.slice(0, 2);
      return {
        ok: true,
        page: {
          records: slice.map(mediaRecordOf),
          pageCursor: pageTwo || slice.length < 2 ? null : 'ig-page-2',
        },
        rateLimit: null,
      };
    },

    async getContent(context, input) {
      record('getContent', context);
      const scripted = scriptedFailure('getContent');
      if (scripted !== null) return scripted;
      const own = ownMedia(context).find((media) => media.id === input.providerContentId);
      // The documented node-read answer for an unknown id is the
      // code-100 error envelope on the real surface; the honest fused
      // double surfaces the equivalent taxonomy data failure (the
      // disclosed 4xx→restricted judgment) — never a fabricated record.
      if (own === undefined) {
        return failureOf(
          'restricted',
          `the Instagram Graph API getContent (Media node) call failed (HTTP 400, code 100, (#100) Unsupported get request. Object does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com) — the provider refused the request`,
        );
      }
      return { ok: true, record: mediaRecordOf(own), rateLimit: null };
    },

    async readAccountAnalytics(context, input) {
      record('readAccountAnalytics', context);
      const scripted = scriptedFailure('readAccountAnalytics');
      if (scripted !== null) return scripted;
      // The documented day-period account insights: data[] with
      // name/period/values[] (value + end_time per day slice).
      const metrics: readonly { readonly name: string; readonly value: number }[] = [
        { name: 'follower_count', value: 42 },
        { name: 'impressions', value: 12345 },
        { name: 'profile_views', value: 77 },
        { name: 'reach', value: 9000 },
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
      // The documented per-media lifetime insights (the IMAGE metric
      // vocabulary; no windows — lifetime aggregates).
      const observations: {
        metric: string;
        value: number;
        windowStart: string | null;
        windowEnd: string | null;
        data: Record<string, unknown>;
      }[] = [];
      for (const mediaId of input.providerContentIds) {
        const lengthFactor = mediaId.length;
        for (const [metric, value] of [
          ['engagement', 100 * lengthFactor],
          ['impressions', 1000 * lengthFactor],
          ['reach', 500 * lengthFactor],
          ['saved', 10 * lengthFactor],
        ] as const) {
          observations.push({
            metric,
            value,
            windowStart: null,
            windowEnd: null,
            data: {
              providerContentId: mediaId,
              mediaType: 'IMAGE',
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
      containerSequence += 1;
      const containerId = `ig-container-${containerSequence}`;
      const container: RecordedContainer = {
        providerPublishId: containerId,
        providerContentId: nextSubmitState === 'published' ? `ig-media-published-${containerId}` : null,
        publishState: nextSubmitState,
        publishedAt: null,
        providerFailureReason: null,
        restrictionSignals: [],
        idempotencyKey: input.idempotencyKey,
        contentType: input.request.contentType,
        payload: input.request.payload,
        attribution: input.request.attribution,
      };
      containersById.set(containerId, container);
      const keyList = containersByKey.get(input.idempotencyKey) ?? [];
      keyList.push(container);
      containersByKey.set(input.idempotencyKey, keyList);
      return {
        ok: true,
        submission: {
          // The born container (the documented async processing:
          // 'accepted' by default — the container id is the provider
          // publish identity and NO content id exists yet; the
          // terminal fast path when a battery scripted a submit state).
          publishState: container.publishState,
          providerPublishId: container.providerPublishId,
          providerContentId: container.providerContentId,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: container.restrictionSignals,
          providerData: null,
        },
        rateLimit: null,
      };
    },

    async getPublishStatus(context, input) {
      record('getPublishStatus', context);
      const scripted = scriptedFailure('getPublishStatus');
      if (scripted !== null) return scripted;
      const container = containersById.get(input.providerPublishId);
      if (container === undefined) {
        return failureOf(
          'provider-unavailable',
          `the Instagram Graph API getPublishStatus (container status) call failed (HTTP 400, code 100, (#100) Unsupported get request. Object does not exist, cannot be loaded due to missing permissions, or does not support this operation) — the provider refused the request`,
        );
      }
      if (container.publishState === 'accepted') {
        return {
          ok: true,
          status: {
            publishState: 'accepted',
            providerPublishId: container.providerPublishId,
            providerContentId: null,
            publishedAt: null,
            providerFailureReason: null,
            restrictionSignals: [],
            providerData: { id: container.providerPublishId, status_code: 'IN_PROGRESS' },
          },
          rateLimit: null,
        };
      }
      if (container.publishState === 'restricted') {
        return {
          ok: true,
          status: {
            publishState: 'restricted',
            providerPublishId: container.providerPublishId,
            providerContentId: null,
            publishedAt: null,
            providerFailureReason: null,
            restrictionSignals: container.restrictionSignals,
            providerData: { id: container.providerPublishId, status_code: 'ERROR' },
          },
          rateLimit: null,
        };
      }
      if (container.publishState === 'failed') {
        return {
          ok: true,
          status: {
            publishState: 'failed',
            providerPublishId: container.providerPublishId,
            providerContentId: null,
            publishedAt: null,
            providerFailureReason: container.providerFailureReason,
            restrictionSignals: [],
            providerData: { id: container.providerPublishId, status_code: 'EXPIRED' },
          },
          rateLimit: null,
        };
      }
      return {
        ok: true,
        status: {
          publishState: 'published',
          providerPublishId: container.providerPublishId,
          providerContentId: container.providerContentId,
          publishedAt: container.publishedAt,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: {
            id: container.providerPublishId,
            status_code: 'PUBLISHED',
            published_media_id: container.providerContentId,
          },
        },
        rateLimit: null,
      };
    },
  };
}
