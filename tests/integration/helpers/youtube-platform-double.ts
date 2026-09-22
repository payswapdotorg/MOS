/**
 * MKT-057 integration-test harness — the YOUTUBE IN-MEMORY PLATFORM
 * DOUBLE (the conformance-suite adapter under test): a DISCLOSED TEST
 * DOUBLE AT THE PROVIDER BOUNDARY ONLY, faithfully modeled on the
 * DOCUMENTED YouTube Data API v3 + Analytics API v2 semantics (the
 * same behavioral model as the loopback HTTP double of
 * tests/integration/helpers/youtube-http-double.ts, without the wire —
 * the MKT-056 reference-double pattern; the contract HOST under test
 * is fully real).
 *
 * Fidelity model (the documented semantics — see docs/runbooks/MKT-057.md):
 *   - the honest capability matrix of the real adapter (all five
 *     families, the closed per-family operation vocabularies, the REAL
 *     Google OAuth scope URIs —
 *     https://developers.google.com/identity/protocols/oauth2/scopes);
 *   - search pages carry NO statistics (the documented search.list
 *     limitation: every engagement observation null on discovery and
 *     own-listing pages) and paginate over the documented
 *     pageToken/nextPageToken protocol (discovery pages over TWO
 *     pages; own-content over two pages);
 *   - the single-content read exposes the documented statistics part
 *     (viewCount/likeCount/commentCount — NO shareCount: the Data API
 *     statistics expose no share count);
 *   - the analytics reads surface the documented YouTube Analytics
 *     metric labels VERBATIM (views, subscribersGained,
 *     subscribersLost, estimatedMinutesWatched, likes, comments,
 *     shares) with the observed values;
 *   - the restriction signals report ONLY the provider-exposed facts
 *     (the region-restricted public fixture video; hidden moderation
 *     state is never invented — §11);
 *   - the publish lifecycle models the documented resumable upload
 *     protocol: submitPublish = the metadata initiation (the born
 *     'accepted' upload session; providerContentId null until
 *     processing completes), advancePublish = the provider-side
 *     processing completion (published with the video id / failed /
 *     rejected with the documented rejectionReason), getPublishStatus
 *     = the session probe (still 'accepted' → the honest
 *     still-processing answer);
 *   - the documented QUOTA COST accounting (read=1, search=100,
 *     insert=1600 units against the 10,000 units/day default) with
 *     the 403 quotaExceeded exhaustion mapped onto the frozen
 *     'rate-limited' taxonomy code;
 *   - per-operation failure injection (setFailure/clearFailure) and
 *     the call-context recording (contextsOf) of the reference-double
 *     interface (the suite's adapterHandle contract).
 */

import type {
  SocialAdapterCallContext,
  SocialAdapterFailureCode,
  SocialCapability,
  SocialPlatformAdapter,
  SocialRestrictionSignal,
} from '../../../src/modules/social-accounts/public.ts';

/** The platform key of the YouTube double (the real adapter's key). */
export const YOUTUBE_PLATFORM_KEY = 'youtube';

/** The REAL Google OAuth scope URIs (the conformance fixture grants ride these). */
export const YOUTUBE_FULL_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.upload',
] as const;
/** The read-only grant (drives the insufficient-scope battery: analytics + publish refuse). */
export const YOUTUBE_READ_ONLY_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'] as const;

/** The honest capability matrix (mirrors the real adapter declaration). */
export function youTubeDoubleCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      description:
        'YouTube channel identity binding + profile reads over channels.list (mine=true). Limitations: no identity-verification timestamp (verifiedAt null); channel-level restrictions surface only as invocation failures (test double mirroring the documented surface).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      description:
        'Public discovery + own-content listing over search.list and single reads over videos.list. Limitations: search pages carry NO engagement statistics; the statistics expose NO share count; the documented pageToken pagination (test double mirroring the documented surface).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: ['https://www.googleapis.com/auth/yt-analytics.readonly'],
      description:
        'Observed metric points over the YouTube Analytics API v2 reports, provider labels verbatim. Limitations: one report per content id; a null window defaults to the wide documented window (test double mirroring the documented surface).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: ['https://www.googleapis.com/auth/youtube.upload'],
      description:
        'The documented resumable-upload lifecycle: the metadata initiation (born accepted session) + the session status probe. Limitations: the media-byte transfer awaits the content-asset wiring; no client idempotency token on videos.insert (test double mirroring the documented surface).',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
      description:
        'ONLY the provider-exposed observable signals (the region-restriction surface + uploadStatus rejected/failed passthrough). Limitations: hidden moderation state never invented (test double mirroring the documented surface).',
    },
  ];
}

/** The recorded upload session (the reference-double RecordedPublish shape + the idempotency-key observation). */
interface RecordedUpload {
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

export interface YouTubePlatformDouble extends SocialPlatformAdapter {
  /** The number of adapter-method invocations per operation. */
  callCount(operation: string): number;
  /** The recorded host call contexts per operation (the propagation battery). */
  contextsOf(operation: string): readonly SocialAdapterCallContext[];
  /** Scripts an operation to return the honest taxonomy failure. */
  setFailure(operation: string, code: SocialAdapterFailureCode, message?: string): void;
  /** Clears an operation's scripted failure. */
  clearFailure(operation: string): void;
  /** The state a fresh submit reports (default 'accepted' — the born upload session; a completed-instantly provider fast path for the batteries). */
  setNextSubmitState(state: 'accepted' | 'published' | 'failed' | 'restricted'): void;
  /** Moves a recorded upload session to a later state (the poll battery — the suite handle contract's providerContentId patch). */
  advancePublish(
    uploadId: string,
    state: 'accepted' | 'published' | 'failed' | 'restricted',
    patch?: { readonly providerContentId?: string; readonly rejectionReason?: string },
  ): void;
  /** The recorded upload sessions (the fence battery). */
  publishes(): readonly RecordedUpload[];
  /** The recorded upload sessions under a given idempotency key (the fence battery). */
  publishesForIdempotencyKey(idempotencyKey: string): readonly RecordedUpload[];
  /** The consumed quota units (the documented cost accounting: read=1, search=100, insert=1600). */
  consumedQuotaUnits(): number;
  /** Replaces the daily quota budget (the exhaustion battery). */
  setDailyQuotaUnits(units: number): void;
}

/** The default channel fixture identity facts of the double. */
const CHANNEL_SUBSCRIBER_COUNT = 4242;

/** The region-restriction signal of the fixture channel (the documented contentDetails.regionRestriction surface). */
const REGION_SIGNAL: SocialRestrictionSignal = {
  signalKind: 'video.regionRestriction',
  observedAt: null,
  description: 'video yt-video-geo carries a contentDetails.regionRestriction',
  data: { videoId: 'yt-video-geo', allowed: null, blocked: ['DE', 'JP'] },
};

function failureOf(code: SocialAdapterFailureCode, message: string, rateLimit = null) {
  return { ok: false as const, failure: { code, message, rateLimit } };
}

export function createYouTubePlatformDouble(options?: {
  readonly adapterKey?: string;
  readonly capabilities?: readonly SocialCapability[];
}): YouTubePlatformDouble {
  const adapterKey = options?.adapterKey ?? YOUTUBE_PLATFORM_KEY;
  const capabilities = options?.capabilities ?? youTubeDoubleCapabilities();

  const callCounts = new Map<string, number>();
  const contexts = new Map<string, SocialAdapterCallContext[]>();
  const failures = new Map<string, { code: SocialAdapterFailureCode; message: string }>();
  const uploadsById = new Map<string, RecordedUpload>();
  const uploadsByKey = new Map<string, RecordedUpload[]>();
  let uploadSequence = 0;
  let nextSubmitState: 'accepted' | 'published' | 'failed' | 'restricted' = 'accepted';
  let consumedUnits = 0;
  let dailyQuotaUnits = 10_000;

  const READ_COST = 1;
  const SEARCH_COST = 100;
  const INSERT_COST = 1600;

  function record(operation: string, context: SocialAdapterCallContext): void {
    callCounts.set(operation, (callCounts.get(operation) ?? 0) + 1);
    const list = contexts.get(operation) ?? [];
    list.push(context);
    contexts.set(operation, list);
  }

  /** The quota accounting prelude: the documented cost model + the 403 quotaExceeded exhaustion as rate-limited data. */
  function quotaPrelude(operation: string, cost: number): { ok: false; failure: { code: SocialAdapterFailureCode; message: string; rateLimit: null } } | null {
    consumedUnits += cost;
    if (consumedUnits <= dailyQuotaUnits) return null;
    return failureOf(
      'rate-limited',
      `the YouTube API ${operation} call failed (HTTP 403, reason 'quotaExceeded': The request cannot be completed because you have exceeded your quota.) — the provider quota/rate limit was observed`,
    );
  }

  function scriptedFailure(operation: string) {
    const scripted = failures.get(operation);
    if (scripted === undefined) return null;
    return failureOf(scripted.code, scripted.message);
  }

  /** The own-content fixture videos (the documented public-indexed view: processed + public only). */
  function ownVideos(context: SocialAdapterCallContext) {
    return [1, 2, 3].map((index) => ({
      videoId: `yt-video-${context.externalAccountId}-${index}`,
      title: `Fixture video ${index} of ${context.externalAccountId}`,
      publishedAt: `2026-08-0${index}T10:00:00.000Z`,
      statistics: { viewCount: 1000 * index, likeCount: 100 * index, commentCount: 10 * index },
    }));
  }

  return {
    descriptor: {
      adapterKey,
      providerLabel: 'YouTube (Data API v3 + Analytics API v2)',
      description:
        'The disclosed in-memory YouTube platform double of the MKT-057 conformance run — a test double at the provider boundary only, faithfully modeled on the documented YouTube API semantics; the contract host under test is fully real.',
    },
    capabilities,

    callCount(operation) {
      return callCounts.get(operation) ?? 0;
    },
    contextsOf(operation) {
      return [...(contexts.get(operation) ?? [])];
    },
    setFailure(operation, code, message) {
      failures.set(operation, { code, message: message ?? `the YouTube platform double scripted a(n) ${code} failure` });
    },
    clearFailure(operation) {
      failures.delete(operation);
    },
    setNextSubmitState(state) {
      nextSubmitState = state;
    },
    advancePublish(uploadId, state, patch) {
      const upload = uploadsById.get(uploadId);
      if (upload === undefined) return;
      upload.publishState = state;
      upload.providerContentId = patch?.providerContentId ?? upload.providerContentId;
      upload.publishedAt = state === 'published' ? '2026-08-02T12:00:00.000Z' : null;
      upload.providerFailureReason =
        state === 'failed' ? 'uploadStatus=failed (the provider reports the upload failed)' : null;
      upload.restrictionSignals =
        state === 'restricted'
          ? [
              {
                signalKind: 'video.uploadStatus.rejected',
                observedAt: null,
                description: `video ${upload.providerContentId ?? upload.providerPublishId} carries uploadStatus=rejected (rejectionReason: ${patch?.rejectionReason ?? 'inappropriate'})`,
                data: {
                  videoId: upload.providerContentId ?? upload.providerPublishId,
                  uploadStatus: 'rejected',
                  rejectionReason: patch?.rejectionReason ?? 'inappropriate',
                },
              },
            ]
          : [];
    },
    publishesForIdempotencyKey(idempotencyKey) {
      return [...(uploadsByKey.get(idempotencyKey) ?? [])];
    },
    publishes() {
      return [...uploadsById.values()];
    },
    consumedQuotaUnits() {
      return consumedUnits;
    },
    setDailyQuotaUnits(units) {
      dailyQuotaUnits = units;
    },

    async verifyAccountIdentity(context) {
      record('verifyAccountIdentity', context);
      const scripted = scriptedFailure('verifyAccountIdentity');
      if (scripted !== null) return scripted;
      const quota = quotaPrelude('verifyAccountIdentity (channels.list)', READ_COST);
      if (quota !== null) return quota;
      return {
        ok: true,
        // The documented channels.list mine=true view: the channel id +
        // title; the Data API exposes no verification timestamp.
        identity: {
          externalAccountId: context.externalAccountId,
          displayIdentity: `Fixture Channel ${context.externalAccountId}`,
          verifiedAt: null,
        },
        rateLimit: null,
      };
    },

    async getAccountProfile(context) {
      record('getAccountProfile', context);
      const scripted = scriptedFailure('getAccountProfile');
      if (scripted !== null) return scripted;
      const quota = quotaPrelude('getAccountProfile (channels.list)', READ_COST);
      if (quota !== null) return quota;
      return {
        ok: true,
        profile: {
          externalAccountId: context.externalAccountId,
          displayIdentity: `Fixture Channel ${context.externalAccountId}`,
          verifiedAt: null,
          accountKind: 'youtube#channel',
          followerCount: CHANNEL_SUBSCRIBER_COUNT,
          data: {
            kind: 'youtube#channel',
            etag: `double-channel-${context.externalAccountId}`,
            id: context.externalAccountId,
            snippet: { title: `Fixture Channel ${context.externalAccountId}` },
            statistics: {
              viewCount: '12345',
              subscriberCount: String(CHANNEL_SUBSCRIBER_COUNT),
              hiddenSubscriberCount: false,
              videoCount: '4',
            },
          },
        },
        rateLimit: null,
      };
    },

    async discoverPublicContent(context, input) {
      record('discoverPublicContent', context);
      const scripted = scriptedFailure('discoverPublicContent');
      if (scripted !== null) return scripted;
      const quota = quotaPrelude('discoverPublicContent (search.list)', SEARCH_COST);
      if (quota !== null) return quota;
      const slug = input.query.replace(/\W+/g, '-').slice(0, 40);
      const pageTwo = input.pageCursor === 'yt-page-2';
      // The documented search page: NO statistics (every engagement
      // fact null) + the nextPageToken pagination.
      return {
        ok: true,
        page: {
          records: (pageTwo ? [2] : [0, 1]).map((index) => ({
            providerContentId: `yt-search-${slug}-${index}`,
            authorExternalAccountId: `yt-search-author-${index}`,
            contentFormat: 'youtube#video',
            publishedAt: '2026-08-01T08:00:00.000Z',
            sourceTimestamp: '2026-08-01T08:00:00.000Z',
            engagement: { viewCount: null, likeCount: null, commentCount: null, shareCount: null },
            data: {
              kind: 'youtube#searchResult',
              etag: `double-search-${slug}-${index}`,
              id: { kind: 'youtube#video', videoId: `yt-search-${slug}-${index}` },
              snippet: {
                publishedAt: '2026-08-01T08:00:00.000Z',
                channelId: `yt-search-author-${index}`,
                title: `Public result ${index} for ${input.query}`,
                publishTime: '2026-08-01T08:00:00.000Z',
              },
            },
            etag: `double-search-${slug}-${index}`,
            sourceVersion: null,
          })),
          pageCursor: pageTwo ? null : 'yt-page-2',
        },
        rateLimit: null,
      };
    },

    async listOwnContent(context, input) {
      record('listOwnContent', context);
      const scripted = scriptedFailure('listOwnContent');
      if (scripted !== null) return scripted;
      const quota = quotaPrelude('listOwnContent (search.list)', SEARCH_COST);
      if (quota !== null) return quota;
      const all = ownVideos(context);
      const pageTwo = input.pageCursor === 'yt-page-2';
      const slice = pageTwo ? all.slice(2) : all.slice(0, 2);
      return {
        ok: true,
        page: {
          records: slice.map((video) => ({
            providerContentId: video.videoId,
            authorExternalAccountId: context.externalAccountId,
            contentFormat: 'youtube#video',
            publishedAt: video.publishedAt,
            sourceTimestamp: video.publishedAt,
            engagement: { viewCount: null, likeCount: null, commentCount: null, shareCount: null },
            data: {
              kind: 'youtube#searchResult',
              etag: `double-search-${video.videoId}`,
              id: { kind: 'youtube#video', videoId: video.videoId },
              snippet: {
                publishedAt: video.publishedAt,
                channelId: context.externalAccountId,
                title: video.title,
                publishTime: video.publishedAt,
              },
            },
            etag: `double-search-${video.videoId}`,
            sourceVersion: null,
          })),
          pageCursor: pageTwo || slice.length < 2 ? null : 'yt-page-2',
        },
        rateLimit: null,
      };
    },

    async getContent(context, input) {
      record('getContent', context);
      const scripted = scriptedFailure('getContent');
      if (scripted !== null) return scripted;
      const quota = quotaPrelude('getContent (videos.list)', READ_COST);
      if (quota !== null) return quota;
      const own = ownVideos(context).find((video) => video.videoId === input.providerContentId);
      const geo =
        input.providerContentId === 'yt-video-geo'
          ? {
              videoId: 'yt-video-geo',
              title: 'Region-restricted fixture',
              publishedAt: '2026-08-04T10:00:00.000Z',
              statistics: { viewCount: 777, likeCount: 77, commentCount: 7 },
            }
          : null;
      const video = own ?? geo;
      // The documented videos.list answer for an unknown id: an EMPTY
      // items list — the honest null record.
      if (video === null) {
        return { ok: true, record: null, rateLimit: null };
      }
      return {
        ok: true,
        record: {
          providerContentId: video.videoId,
          authorExternalAccountId: context.externalAccountId,
          contentFormat: 'youtube#video',
          publishedAt: video.publishedAt,
          sourceTimestamp: video.publishedAt,
          engagement: {
            viewCount: video.statistics.viewCount,
            likeCount: video.statistics.likeCount,
            commentCount: video.statistics.commentCount,
            // The documented Data API statistics expose NO share count.
            shareCount: null,
          },
          data: {
            kind: 'youtube#video',
            etag: `double-video-${video.videoId}`,
            id: video.videoId,
            snippet: { publishedAt: video.publishedAt, channelId: context.externalAccountId, title: video.title },
            statistics: {
              viewCount: String(video.statistics.viewCount),
              likeCount: String(video.statistics.likeCount),
              commentCount: String(video.statistics.commentCount),
            },
            status: { uploadStatus: 'processed', privacyStatus: 'public' },
            ...(geo !== null
              ? { contentDetails: { duration: 'PT1M30S', regionRestriction: { blocked: ['DE', 'JP'] } } }
              : {}),
          },
          etag: `double-video-${video.videoId}`,
          sourceVersion: null,
        },
        rateLimit: null,
      };
    },

    async readAccountAnalytics(context, input) {
      record('readAccountAnalytics', context);
      const scripted = scriptedFailure('readAccountAnalytics');
      if (scripted !== null) return scripted;
      const quota = quotaPrelude('readAccountAnalytics (Analytics reports)', READ_COST);
      if (quota !== null) return quota;
      const windowStart = input.windowStart ?? '2005-01-01T00:00:00.000Z';
      const windowEnd = input.windowEnd ?? '2099-12-31T00:00:00.000Z';
      // The documented report shape: columnHeaders[].name VERBATIM + rows[].
      const metrics: readonly { readonly name: string; readonly value: number }[] = [
        { name: 'views', value: 12345 },
        { name: 'subscribersGained', value: 42 },
        { name: 'subscribersLost', value: 7 },
        { name: 'estimatedMinutesWatched', value: 900_000 },
      ];
      return {
        ok: true,
        observations: metrics.map((metric) => ({
          metric: metric.name,
          value: metric.value,
          windowStart,
          windowEnd,
          data: { columnHeader: { name: metric.name, columnType: 'METRIC', dataType: 'LONG' } },
        })),
        rateLimit: null,
      };
    },

    async readContentAnalytics(context, input) {
      record('readContentAnalytics', context);
      const scripted = scriptedFailure('readContentAnalytics');
      if (scripted !== null) return scripted;
      const windowStart = input.windowStart ?? '2005-01-01T00:00:00.000Z';
      const windowEnd = input.windowEnd ?? '2099-12-31T00:00:00.000Z';
      const observations: {
        metric: string;
        value: number;
        windowStart: string;
        windowEnd: string;
        data: Record<string, unknown>;
      }[] = [];
      for (const videoId of input.providerContentIds) {
        const quota = quotaPrelude('readContentAnalytics (Analytics reports)', READ_COST);
        if (quota !== null) return quota;
        const lengthFactor = videoId.length;
        for (const [metric, value] of [
          ['views', 100 * lengthFactor],
          ['likes', 10 * lengthFactor],
          ['comments', lengthFactor],
          ['shares', 2 * lengthFactor],
          ['estimatedMinutesWatched', 50 * lengthFactor],
        ] as const) {
          observations.push({
            metric,
            value,
            windowStart,
            windowEnd,
            data: {
              columnHeader: { name: metric, columnType: 'METRIC', dataType: 'LONG' },
              providerContentId: videoId,
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
      const quota = quotaPrelude('submitPublish (videos.insert initiation)', INSERT_COST);
      if (quota !== null) return quota;
      uploadSequence += 1;
      const uploadId = `yt-upload-${uploadSequence}`;
      const upload: RecordedUpload = {
        providerPublishId: uploadId,
        providerContentId: nextSubmitState === 'published' ? `yt-video-published-${uploadId}` : null,
        publishState: nextSubmitState,
        publishedAt: null,
        providerFailureReason: null,
        restrictionSignals: [],
        idempotencyKey: input.idempotencyKey,
        contentType: input.request.contentType,
        payload: input.request.payload,
        attribution: input.request.attribution,
      };
      uploadsById.set(uploadId, upload);
      const keyList = uploadsByKey.get(input.idempotencyKey) ?? [];
      keyList.push(upload);
      uploadsByKey.set(input.idempotencyKey, keyList);
      return {
        ok: true,
        submission: {
          // The born upload session (the documented async processing:
          // 'accepted' by default; the completed-instantly fast path
          // when the battery scripted a terminal submit state).
          publishState: upload.publishState,
          providerPublishId: upload.providerPublishId,
          providerContentId: upload.providerContentId,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: upload.restrictionSignals,
          providerData: null,
        },
        rateLimit: null,
      };
    },

    async getPublishStatus(context, input) {
      record('getPublishStatus', context);
      const scripted = scriptedFailure('getPublishStatus');
      if (scripted !== null) return scripted;
      const quota = quotaPrelude('getPublishStatus (upload session probe)', READ_COST);
      if (quota !== null) return quota;
      const upload = uploadsById.get(input.providerPublishId);
      if (upload === undefined) {
        return failureOf(
          'provider-unavailable',
          `the YouTube upload session '${input.providerPublishId}' no longer resolves (the provider reports no such publish)`,
        );
      }
      if (upload.publishState === 'accepted') {
        return {
          ok: true,
          status: {
            publishState: 'accepted',
            providerPublishId: upload.providerPublishId,
            providerContentId: null,
            publishedAt: null,
            providerFailureReason: null,
            restrictionSignals: [],
            providerData: null,
          },
          rateLimit: null,
        };
      }
      const videoId = upload.providerContentId ?? `yt-video-published-${upload.providerPublishId}`;
      if (upload.publishState === 'restricted') {
        return {
          ok: true,
          status: {
            publishState: 'restricted',
            providerPublishId: upload.providerPublishId,
            providerContentId: videoId,
            publishedAt: null,
            providerFailureReason: null,
            restrictionSignals: upload.restrictionSignals,
            providerData: {
              kind: 'youtube#video',
              id: videoId,
              status: { uploadStatus: 'rejected', privacyStatus: 'public' },
            },
          },
          rateLimit: null,
        };
      }
      if (upload.publishState === 'failed') {
        return {
          ok: true,
          status: {
            publishState: 'failed',
            providerPublishId: upload.providerPublishId,
            providerContentId: videoId,
            publishedAt: null,
            providerFailureReason: upload.providerFailureReason,
            restrictionSignals: [],
            providerData: {
              kind: 'youtube#video',
              id: videoId,
              status: { uploadStatus: 'failed', privacyStatus: 'public' },
            },
          },
          rateLimit: null,
        };
      }
      return {
        ok: true,
        status: {
          publishState: 'published',
          providerPublishId: upload.providerPublishId,
          providerContentId: videoId,
          publishedAt: upload.publishedAt,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: {
            kind: 'youtube#video',
            id: videoId,
            snippet: { publishedAt: upload.publishedAt },
            status: { uploadStatus: 'processed', privacyStatus: 'public' },
          },
        },
        rateLimit: null,
      };
    },

    async readRestrictionSignals(context) {
      record('readRestrictionSignals', context);
      const scripted = scriptedFailure('readRestrictionSignals');
      if (scripted !== null) return scripted;
      const searchQuota = quotaPrelude('readRestrictionSignals (search.list)', SEARCH_COST);
      if (searchQuota !== null) return searchQuota;
      const videosQuota = quotaPrelude('readRestrictionSignals (videos.list)', READ_COST);
      if (videosQuota !== null) return videosQuota;
      // ONLY the provider-exposed observable facts: the fixture
      // channel's region-restricted public video (§11 — hidden
      // moderation state never invented).
      return { ok: true, signals: [REGION_SIGNAL], rateLimit: null };
    },
  };
}
