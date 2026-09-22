/**
 * MKT-060 integration-test harness — the TIKTOK IN-MEMORY PLATFORM
 * DOUBLE (the conformance-suite adapter under test): a DISCLOSED TEST
 * DOUBLE AT THE PROVIDER BOUNDARY ONLY, faithfully modeled on the
 * DOCUMENTED TikTok for Developers semantics (the same behavioral model
 * as the loopback HTTP double of
 * tests/integration/helpers/tiktok-http-double.ts, without the wire —
 * the MKT-056 reference-double pattern; the contract HOST under test is
 * fully real).
 *
 * Fidelity model (the documented semantics — verified against the LIVE
 * developers.tiktok.com documentation at delivery time; see
 * docs/runbooks/MKT-060.md):
 *   - the honest capability matrix of the real adapter (ALL FIVE
 *     families with the closed per-family operation vocabularies, the
 *     REAL documented Login Kit scope names —
 *     https://developers.tiktok.com/docs/en/tiktok-api-scopes);
 *   - the documented user-info surface (open_id/display_name + the
 *     user.info.profile + user.info.stats fields; the statistical
 *     counts serve the account analytics labels VERBATIM);
 *   - the documented /v2/video/list/ cursor pagination (the int64
 *     Unix-MS cursor over two pages) and the documented
 *     /v2/video/query/ ownership verification (an unknown/not-owned id
 *     is ABSENT — the honest null record);
 *   - the documented Video Object exposes ALL FOUR engagement counts
 *     (view_count, like_count, comment_count, share_count);
 *   - the documented creator capability query (privacy_level_options —
 *     the PUBLIC-account vs the PRIVATE-account documented option sets
 *     — + max_video_post_duration_sec + the interaction settings);
 *   - the documented direct-post lifecycle (the born 'accepted'
 *     publish_id → the status-fetch states PROCESSING_DOWNLOAD /
 *     PUBLISH_COMPLETE (with the public post id for public posts, NO
 *     public post id for private-mode posts) / FAILED with the
 *     documented fail_reason split);
 *   - the documented eligibility/audit enforcement on the publish
 *     initiation: the private-mode account (no PUBLIC option → the
 *     403 privacy_level_option_mismatch) and the unaudited client (the
 *     403 unaudited_client_can_only_post_to_private_accounts);
 *   - the documented per-endpoint rate accounting (user/info,
 *     video/query, video/list: 600/minute; video/init: 6/minute per
 *     user token; creator_info/query: 20/minute; status/fetch:
 *     30/minute) with the 429 rate_limit_exceeded mapped onto the
 *     frozen 'rate-limited' taxonomy code;
 *   - per-operation failure injection (setFailure/clearFailure) and the
 *     call-context recording (contextsOf) of the reference-double
 *     interface (the suite's adapterHandle contract).
 */

import type {
  SocialAdapterCallContext,
  SocialAdapterFailureCode,
  SocialCapability,
  SocialPlatformAdapter,
  SocialRestrictionSignal,
} from '../../../src/modules/social-accounts/public.ts';

/** The platform key of the TikTok double (the real adapter's key). */
export const TIKTOK_PLATFORM_KEY = 'tiktok';

/** The REAL documented Login Kit scopes (the conformance fixture grants ride these). */
export const TIKTOK_FULL_SCOPES = [
  'user.info.basic',
  'user.info.profile',
  'user.info.stats',
  'video.list',
  'video.publish',
] as const;
/** The read-only grant (drives the insufficient-scope battery: publish + restriction-signals refuse — both require video.publish). */
export const TIKTOK_READ_ONLY_SCOPES = [
  'user.info.basic',
  'user.info.profile',
  'user.info.stats',
  'video.list',
] as const;

/** The honest capability matrix (mirrors the real adapter declaration). */
export function tikTokDoubleCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: ['user.info.basic', 'user.info.profile', 'user.info.stats'],
      description:
        'TikTok account identity binding + profile reads over the documented Get User Info endpoint. Limitations: a verified badge, not a timestamp (verifiedAt null); no account-type label on the user-info surface (test double mirroring the documented surface).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: ['video.list'],
      description:
        'Content reads over the documented Display API video surfaces (video/list + video/query). Limitations: the caller discovery query is honestly unused (no documented public search); the documented Video Object exposes all four engagement counts (test double mirroring the documented surface).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: ['user.info.stats', 'video.list'],
      description:
        'Observed metric points over the documented statistical surfaces (user.info.stats counts + the Video Object count fields), labels verbatim. Limitations: point-in-time/lifetime values with null windows (test double mirroring the documented surface).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: ['video.publish'],
      description:
        'The documented direct-post lifecycle (video/init + status/fetch). Limitations: no scheduling parameter on the documented surface; PULL_FROM_URL transfer; the audit/private-mode eligibility restrictions surface through the documented 403 semantics (test double mirroring the documented surface).',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: ['video.publish'],
      description:
        'The documented creator capability query (creator_info/query): the eligibility facts ride as signals. Limitations: the owner interaction settings ride the passthrough; the client audit status is never invented (test double mirroring the documented surface).',
    },
  ];
}

/** The documented creator privacy-mode answer sets (the private/public option vocabulary). */
export const PUBLIC_PRIVACY_LEVEL_OPTIONS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'] as const;
export const PRIVATE_PRIVACY_LEVEL_OPTIONS = ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'] as const;

/** The recorded direct-post publish (the reference-double RecordedPublish shape + the idempotency-key observation). */
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

/** The status-fetch state a recorded publish currently serves. */
type PublishStatusState =
  | 'PROCESSING_UPLOAD'
  | 'PROCESSING_DOWNLOAD'
  | 'SEND_TO_USER_INBOX'
  | 'PUBLISH_COMPLETE'
  | 'FAILED';

export interface TikTokPlatformDouble extends SocialPlatformAdapter {
  /** The number of adapter-method invocations per operation. */
  callCount(operation: string): number;
  /** The recorded host call contexts per operation (the propagation battery). */
  contextsOf(operation: string): readonly SocialAdapterCallContext[];
  /** Scripts an operation to return the honest taxonomy failure. */
  setFailure(operation: string, code: SocialAdapterFailureCode, message?: string): void;
  /** Clears an operation's scripted failure. */
  clearFailure(operation: string): void;
  /** The state a fresh submit reports (default 'accepted' — the born direct post; terminal fast paths for the batteries). */
  setNextSubmitState(state: 'accepted' | 'published' | 'failed' | 'restricted'): void;
  /** Moves a recorded publish to a later status-fetch state (the poll battery — the suite handle contract's providerContentId patch). */
  advancePublish(
    publishId: string,
    state: 'accepted' | 'published' | 'failed' | 'restricted',
    patch?: { readonly providerContentId?: string; readonly failReason?: string },
  ): void;
  /** The recorded publishes (the fence battery). */
  publishes(): readonly RecordedPublish[];
  /** The recorded publishes under a given idempotency key (the fence battery). */
  publishesForIdempotencyKey(idempotencyKey: string): readonly RecordedPublish[];
  /**
   * Registers (or replaces) a fixture creator account — the privacy mode
   * drives the documented creator capability query answer and the
   * private-mode publish enforcement (the eligibility battery).
   */
  registerAccount(input: { readonly accountId: string; readonly privacyMode: 'public' | 'private' }): void;
  /** Replaces the client audit state (the documented audit enforcement: an unaudited client can only post privately). */
  setClientAudited(audited: boolean): void;
  /** Replaces a per-endpoint rate budget (the documented rate accounting; the exhaustion battery). */
  setRateBudget(operation: 'user-info' | 'video-list' | 'video-query' | 'creator-info' | 'video-init' | 'status-fetch', budget: number): void;
  /** The consumed request count of an endpoint in the current window. */
  rateConsumed(operation: 'user-info' | 'video-list' | 'video-query' | 'creator-info' | 'video-init' | 'status-fetch'): number;
  /** Resets the rate windows. */
  resetRateWindows(): void;
}

/** The default fixture creator facts of the double. */
const FOLLOWER_COUNT = 7351;
const FOLLOWING_COUNT = 128;
const LIKES_COUNT = 91_234;
const VIDEO_COUNT = 42;
const MAX_VIDEO_POST_DURATION_SEC = 600;

function failureOf(code: SocialAdapterFailureCode, message: string, rateLimit = null) {
  return { ok: false as const, failure: { code, message, rateLimit } };
}

/** The documented public-video fixtures of an account (create_time DESCENDING — the documented /v2/video/list/ ordering; video 1 is the newest). */
function publicVideosOf(accountId: string) {
  return [1, 2, 3].map((index) => ({
    id: `tt-video-${accountId}-${index}`,
    create_time: Math.floor(Date.parse(`2026-08-0${4 - index}T10:00:00.000Z`) / 1000),
    title: `Fixture TikTok video ${index} of ${accountId}`,
    video_description: `The documented description of fixture video ${index}`,
    duration: 60 * index,
    cover_image_url: `https://p16-sign.tiktokcdn-us.com/double-cover-${accountId}-${index}`,
    share_url: `https://www.tiktok.com/@double-${accountId}/video/${index}`,
    view_count: 1000 * index,
    like_count: 100 * index,
    comment_count: 10 * index,
    share_count: index,
  }));
}

export function createTikTokPlatformDouble(options?: {
  readonly adapterKey?: string;
  readonly capabilities?: readonly SocialCapability[];
}): TikTokPlatformDouble {
  const adapterKey = options?.adapterKey ?? TIKTOK_PLATFORM_KEY;
  const capabilities = options?.capabilities ?? tikTokDoubleCapabilities();

  const callCounts = new Map<string, number>();
  const contexts = new Map<string, SocialAdapterCallContext[]>();
  const failures = new Map<string, { code: SocialAdapterFailureCode; message: string }>();
  const publishesById = new Map<string, RecordedPublish>();
  const publishesByKey = new Map<string, RecordedPublish[]>();
  /** The current status-fetch state each recorded publish serves. */
  const statusStates = new Map<string, { state: PublishStatusState; failReason: string | null }>();
  const accountPrivacyModes = new Map<string, 'public' | 'private'>();
  let publishSequence = 0;
  let nextSubmitState: 'accepted' | 'published' | 'failed' | 'restricted' = 'accepted';
  let clientAudited = false;
  /** The documented per-endpoint per-user-token rate budgets (the documented defaults). */
  const rateBudgets = new Map<string, number>([
    ['user-info', 600],
    ['video-list', 600],
    ['video-query', 600],
    ['creator-info', 20],
    ['video-init', 6],
    ['status-fetch', 30],
  ]);
  const rateConsumedMap = new Map<string, number>();

  const privacyModeOf = (accountId: string): 'public' | 'private' =>
    accountPrivacyModes.get(accountId) ?? 'public';

  function record(operation: string, context: SocialAdapterCallContext): void {
    callCounts.set(operation, (callCounts.get(operation) ?? 0) + 1);
    const list = contexts.get(operation) ?? [];
    list.push(context);
    contexts.set(operation, list);
  }

  /** The documented rate accounting prelude: the per-endpoint sliding window + the 429 rate_limit_exceeded as rate-limited data. */
  function ratePrelude(
    operation: string,
    endpoint: string,
  ): { ok: false; failure: { code: SocialAdapterFailureCode; message: string; rateLimit: null } } | null {
    const consumed = (rateConsumedMap.get(endpoint) ?? 0) + 1;
    rateConsumedMap.set(endpoint, consumed);
    if (consumed <= (rateBudgets.get(endpoint) ?? 600)) return null;
    return failureOf(
      'rate-limited',
      `the TikTok API ${operation} call failed (HTTP 429, error code 'rate_limit_exceeded': Your request is blocked due to exceeding the API rate limit.) — the provider rate/quota limit was observed`,
    );
  }

  function scriptedFailure(operation: string) {
    const scripted = failures.get(operation);
    if (scripted === undefined) return null;
    return failureOf(scripted.code, scripted.message);
  }

  /** The documented user object subset the fixture serves. */
  function userObjectOf(accountId: string) {
    return {
      open_id: accountId,
      union_id: `union-${accountId}`,
      avatar_url: `https://p19-sign.tiktokcdn-us.com/double-avatar-${accountId}`,
      display_name: `Fixture Creator ${accountId}`,
      bio_description: 'The documented bio of the fixture creator',
      profile_deep_link: `https://www.tiktok.com/@double-${accountId}`,
      is_verified: accountId.startsWith('tt-verified'),
      username: `double_${accountId.replaceAll('-', '_')}`,
      follower_count: FOLLOWER_COUNT,
      following_count: FOLLOWING_COUNT,
      likes_count: LIKES_COUNT,
      video_count: VIDEO_COUNT,
    };
  }

  return {
    descriptor: {
      adapterKey,
      providerLabel: 'TikTok (Login Kit + Content Posting API)',
      description:
        'The disclosed in-memory TikTok platform double of the MKT-060 conformance run — a test double at the provider boundary only, faithfully modeled on the documented TikTok for Developers semantics; the contract host under test is fully real.',
    },
    capabilities,

    callCount(operation) {
      return callCounts.get(operation) ?? 0;
    },
    contextsOf(operation) {
      return [...(contexts.get(operation) ?? [])];
    },
    setFailure(operation, code, message) {
      failures.set(operation, { code, message: message ?? `the TikTok platform double scripted a(n) ${code} failure` });
    },
    clearFailure(operation) {
      failures.delete(operation);
    },
    setNextSubmitState(state) {
      nextSubmitState = state;
    },
    advancePublish(publishId, state, patch) {
      const publish = publishesById.get(publishId);
      if (publish === undefined) return;
      publish.publishState = state;
      publish.providerContentId = patch?.providerContentId ?? publish.providerContentId;
      publish.publishedAt = state === 'published' ? '2026-08-02T12:00:00.000Z' : null;
      publish.providerFailureReason =
        state === 'failed'
          ? `fail_reason=${patch?.failReason ?? 'video_pull_failed'} (the provider reports the publish failed)`
          : null;
      publish.restrictionSignals =
        state === 'restricted'
          ? [
              {
                signalKind: `publish.fail_reason.${patch?.failReason ?? 'spam_risk'}`,
                observedAt: null,
                description: `the publish status fetch reports the documented fail_reason '${patch?.failReason ?? 'spam_risk'}' (the provider-signalled restriction class)`,
                data: { publishId, fail_reason: patch?.failReason ?? 'spam_risk' },
              },
            ]
          : [];
      statusStates.set(publishId, {
        state: state === 'published' ? 'PUBLISH_COMPLETE' : state === 'failed' ? 'FAILED' : 'PROCESSING_DOWNLOAD',
        failReason: state === 'failed' ? (patch?.failReason ?? 'video_pull_failed') : null,
      });
    },
    publishesForIdempotencyKey(idempotencyKey) {
      return [...(publishesByKey.get(idempotencyKey) ?? [])];
    },
    publishes() {
      return [...publishesById.values()];
    },
    registerAccount(input) {
      accountPrivacyModes.set(input.accountId, input.privacyMode);
    },
    setClientAudited(audited) {
      clientAudited = audited;
    },
    setRateBudget(operation, budget) {
      rateBudgets.set(operation, budget);
    },
    rateConsumed(operation) {
      return rateConsumedMap.get(operation) ?? 0;
    },
    resetRateWindows() {
      rateConsumedMap.clear();
    },

    async verifyAccountIdentity(context) {
      record('verifyAccountIdentity', context);
      const scripted = scriptedFailure('verifyAccountIdentity');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('verifyAccountIdentity (user/info)', 'user-info');
      if (quota !== null) return quota;
      const user = userObjectOf(context.externalAccountId);
      return {
        ok: true,
        // The documented user-info surface exposes no verification
        // timestamp — null.
        identity: {
          externalAccountId: user.open_id!,
          displayIdentity: user.display_name!,
          verifiedAt: null,
        },
        rateLimit: null,
      };
    },

    async getAccountProfile(context) {
      record('getAccountProfile', context);
      const scripted = scriptedFailure('getAccountProfile');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('getAccountProfile (user/info)', 'user-info');
      if (quota !== null) return quota;
      const user = userObjectOf(context.externalAccountId);
      return {
        ok: true,
        profile: {
          externalAccountId: user.open_id!,
          displayIdentity: user.display_name!,
          verifiedAt: null,
          accountKind: null,
          followerCount: FOLLOWER_COUNT,
          data: user,
        },
        rateLimit: null,
      };
    },

    async discoverPublicContent(context, input) {
      record('discoverPublicContent', context);
      const scripted = scriptedFailure('discoverPublicContent');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('discoverPublicContent (video/list)', 'video-list');
      if (quota !== null) return quota;
      // The documented video/list surface: the caller query is honestly
      // unused (no public search exists on the documented surface); the
      // documented cursor semantics fetch the videos posted BEFORE the
      // cursor timestamp.
      const all = publicVideosOf(context.externalAccountId);
      const filtered =
        input.pageCursor !== null && /^\d+$/.test(input.pageCursor)
          ? all.filter((video) => video.create_time * 1000 < Number(input.pageCursor))
          : all;
      const pageSize = input.limit !== null ? Math.min(Math.max(input.limit, 1), 20) : 10;
      const slice = filtered.slice(0, pageSize);
      const hasMore = filtered.length > slice.length;
      return {
        ok: true,
        page: {
          records: slice.map((video) => ({
            providerContentId: video.id,
            authorExternalAccountId: null,
            contentFormat: 'tiktok#video',
            publishedAt: new Date(video.create_time * 1000).toISOString(),
            sourceTimestamp: new Date(video.create_time * 1000).toISOString(),
            engagement: {
              viewCount: video.view_count,
              likeCount: video.like_count,
              commentCount: video.comment_count,
              shareCount: video.share_count,
            },
            data: video,
            etag: null,
            sourceVersion: null,
          })),
          pageCursor: hasMore && slice.length > 0 ? String(slice[slice.length - 1]!.create_time * 1000) : null,
        },
        rateLimit: null,
      };
    },

    async listOwnContent(context, input) {
      record('listOwnContent', context);
      const scripted = scriptedFailure('listOwnContent');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('listOwnContent (video/list)', 'video-list');
      if (quota !== null) return quota;
      const all = publicVideosOf(context.externalAccountId);
      const filtered =
        input.pageCursor !== null && /^\d+$/.test(input.pageCursor)
          ? all.filter((video) => video.create_time * 1000 < Number(input.pageCursor))
          : all;
      const pageSize = input.limit !== null ? Math.min(Math.max(input.limit, 1), 20) : 10;
      const slice = filtered.slice(0, pageSize);
      const hasMore = filtered.length > slice.length;
      return {
        ok: true,
        page: {
          records: slice.map((video) => ({
            providerContentId: video.id,
            authorExternalAccountId: null,
            contentFormat: 'tiktok#video',
            publishedAt: new Date(video.create_time * 1000).toISOString(),
            sourceTimestamp: new Date(video.create_time * 1000).toISOString(),
            engagement: {
              viewCount: video.view_count,
              likeCount: video.like_count,
              commentCount: video.comment_count,
              shareCount: video.share_count,
            },
            data: video,
            etag: null,
            sourceVersion: null,
          })),
          pageCursor: hasMore && slice.length > 0 ? String(slice[slice.length - 1]!.create_time * 1000) : null,
        },
        rateLimit: null,
      };
    },

    async getContent(context, input) {
      record('getContent', context);
      const scripted = scriptedFailure('getContent');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('getContent (video/query)', 'video-query');
      if (quota !== null) return quota;
      const all = publicVideosOf(context.externalAccountId);
      const video = all.find((candidate) => candidate.id === input.providerContentId);
      // The documented Query Videos ownership verification: an
      // unknown/not-owned id is ABSENT — the honest null record.
      if (video === undefined) {
        return { ok: true, record: null, rateLimit: null };
      }
      return {
        ok: true,
        record: {
          providerContentId: video.id,
          authorExternalAccountId: null,
          contentFormat: 'tiktok#video',
          publishedAt: new Date(video.create_time * 1000).toISOString(),
          sourceTimestamp: new Date(video.create_time * 1000).toISOString(),
          engagement: {
            viewCount: video.view_count,
            likeCount: video.like_count,
            commentCount: video.comment_count,
            shareCount: video.share_count,
          },
          data: video,
          etag: null,
          sourceVersion: null,
        },
        rateLimit: null,
      };
    },

    async readAccountAnalytics(context, input) {
      record('readAccountAnalytics', context);
      const scripted = scriptedFailure('readAccountAnalytics');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('readAccountAnalytics (user/info stats fields)', 'user-info');
      if (quota !== null) return quota;
      void input;
      // The documented user.info.stats count fields, labels VERBATIM,
      // point-in-time values with null windows.
      const facts: readonly { readonly label: string; readonly value: number }[] = [
        { label: 'follower_count', value: FOLLOWER_COUNT },
        { label: 'following_count', value: FOLLOWING_COUNT },
        { label: 'likes_count', value: LIKES_COUNT },
        { label: 'video_count', value: VIDEO_COUNT },
      ];
      return {
        ok: true,
        observations: facts.map((fact) => ({
          metric: fact.label,
          value: fact.value,
          windowStart: null,
          windowEnd: null,
          data: { field: fact.label },
        })),
        rateLimit: null,
      };
    },

    async readContentAnalytics(context, input) {
      record('readContentAnalytics', context);
      const scripted = scriptedFailure('readContentAnalytics');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('readContentAnalytics (video/query)', 'video-query');
      if (quota !== null) return quota;
      const all = publicVideosOf(context.externalAccountId);
      const observations: {
        metric: string;
        value: number;
        windowStart: null;
        windowEnd: null;
        data: Record<string, unknown>;
      }[] = [];
      for (const videoId of input.providerContentIds) {
        const video = all.find((candidate) => candidate.id === videoId);
        if (video === undefined) continue;
        for (const [label, value] of [
          ['view_count', video.view_count],
          ['like_count', video.like_count],
          ['comment_count', video.comment_count],
          ['share_count', video.share_count],
        ] as const) {
          observations.push({
            metric: label,
            value,
            windowStart: null,
            windowEnd: null,
            data: { videoId, field: label },
          });
        }
      }
      return { ok: true, observations, rateLimit: null };
    },

    async readRestrictionSignals(context) {
      record('readRestrictionSignals', context);
      const scripted = scriptedFailure('readRestrictionSignals');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('readRestrictionSignals (creator_info/query)', 'creator-info');
      if (quota !== null) return quota;
      // The documented creator capability query answer: the privacy
      // options follow the account's documented privacy mode (a PRIVATE
      // account exposes no PUBLIC option) + the duration bound; the
      // owner interaction settings ride the passthrough, never as
      // signals.
      const privacyMode = privacyModeOf(context.externalAccountId);
      const options =
        privacyMode === 'private' ? [...PRIVATE_PRIVACY_LEVEL_OPTIONS] : [...PUBLIC_PRIVACY_LEVEL_OPTIONS];
      const signals: SocialRestrictionSignal[] = [
        {
          signalKind: 'creator.privacy_level_options',
          observedAt: null,
          description: `the creator capability query reports the documented privacy level options [${options.join(', ')}]${privacyMode === 'private' ? ' (no PUBLIC option — the documented private-mode answer)' : ''}`,
          data: { privacy_level_options: options },
        },
        {
          signalKind: 'creator.max_video_post_duration_sec',
          observedAt: null,
          description: `the creator capability query reports the documented maximum video post duration of ${MAX_VIDEO_POST_DURATION_SEC} seconds`,
          data: { max_video_post_duration_sec: MAX_VIDEO_POST_DURATION_SEC },
        },
      ];
      return { ok: true, signals, rateLimit: null };
    },

    async submitPublish(context, input) {
      record('submitPublish', context);
      const scripted = scriptedFailure('submitPublish');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('submitPublish (video/init)', 'video-init');
      if (quota !== null) return quota;
      // The documented eligibility/audit enforcement on the initiation:
      //   - a privacy_level outside the creator's documented options →
      //     the 403 privacy_level_option_mismatch (restricted);
      //   - an UNAUDITED client attempting a non-private publish → the
      //     403 unaudited_client_can_only_post_to_private_accounts
      //     (restricted — never a fabricated success).
      const payload = input.request.payload as Readonly<Record<string, unknown>>;
      const privacyLevel =
        typeof payload['privacyLevel'] === 'string' && payload['privacyLevel'] !== ''
          ? payload['privacyLevel']
          : 'SELF_ONLY';
      const options: readonly string[] =
        privacyModeOf(context.externalAccountId) === 'private'
          ? [...PRIVATE_PRIVACY_LEVEL_OPTIONS]
          : [...PUBLIC_PRIVACY_LEVEL_OPTIONS];
      if (!options.includes(privacyLevel)) {
        return failureOf(
          'restricted',
          `the TikTok API submitPublish (video/init) call failed (HTTP 403, error code 'privacy_level_option_mismatch': privacy_level is not specified or not among the options from the privacy_level_options returned in /publish/creator_info/query/ API) — the provider refused the request`,
        );
      }
      if (!clientAudited && privacyLevel !== 'SELF_ONLY') {
        return failureOf(
          'restricted',
          `the TikTok API submitPublish (video/init) call failed (HTTP 403, error code 'unaudited_client_can_only_post_to_private_accounts': Unaudited clients can only post to a private account. The publish attempt will be blocked when calling /publish/video/init/) — the provider refused the request`,
        );
      }
      publishSequence += 1;
      const publishId = `v_pub_url~double-${publishSequence}`;
      const publish: RecordedPublish = {
        providerPublishId: publishId,
        providerContentId: nextSubmitState === 'published' ? `tt-post-published-${publishSequence}` : null,
        publishState: nextSubmitState,
        publishedAt: null,
        providerFailureReason: null,
        restrictionSignals: [],
        idempotencyKey: input.idempotencyKey,
        contentType: input.request.contentType,
        payload: input.request.payload,
        attribution: input.request.attribution,
      };
      publishesById.set(publishId, publish);
      const keyList = publishesByKey.get(input.idempotencyKey) ?? [];
      keyList.push(publish);
      publishesByKey.set(input.idempotencyKey, keyList);
      statusStates.set(publishId, { state: 'PROCESSING_DOWNLOAD', failReason: null });
      return {
        ok: true,
        submission: {
          // The born direct post (the documented async processing:
          // 'accepted' by default; the completed-instantly fast path
          // when the battery scripted a terminal submit state).
          publishState: publish.publishState,
          providerPublishId: publish.providerPublishId,
          providerContentId: publish.providerContentId,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: publish.restrictionSignals,
          providerData: { publish_id: publishId },
        },
        rateLimit: null,
      };
    },

    async getPublishStatus(context, input) {
      record('getPublishStatus', context);
      const scripted = scriptedFailure('getPublishStatus');
      if (scripted !== null) return scripted;
      const quota = ratePrelude('getPublishStatus (status/fetch)', 'status-fetch');
      if (quota !== null) return quota;
      const publish = publishesById.get(input.providerPublishId);
      if (publish === undefined) {
        // The documented invalid_publish_id answer: the provider reports
        // no such publish.
        return failureOf(
          'provider-unavailable',
          `the TikTok API getPublishStatus (status/fetch) call resolved no such publish (error code 'invalid_publish_id': the publish_id does not exist)`,
        );
      }
      const statusState = statusStates.get(input.providerPublishId) ?? { state: 'PROCESSING_DOWNLOAD', failReason: null };
      if (statusState.state === 'PROCESSING_DOWNLOAD' || statusState.state === 'PROCESSING_UPLOAD' || statusState.state === 'SEND_TO_USER_INBOX') {
        return {
          ok: true,
          status: {
            publishState: 'accepted',
            providerPublishId: publish.providerPublishId,
            providerContentId: null,
            publishedAt: null,
            providerFailureReason: null,
            restrictionSignals: [],
            providerData: { status: statusState.state, downloaded_bytes: 10_000 },
          },
          rateLimit: null,
        };
      }
      if (statusState.state === 'PUBLISH_COMPLETE') {
        // The documented completion: the public post id arrives only for
        // publicly-viewable posts (a private-mode post completes with NO
        // public post id).
        const publicPostId = publish.providerContentId;
        return {
          ok: true,
          status: {
            publishState: 'published',
            providerPublishId: publish.providerPublishId,
            providerContentId: publicPostId,
            publishedAt: publish.publishedAt,
            providerFailureReason: null,
            restrictionSignals: [],
            providerData: {
              status: 'PUBLISH_COMPLETE',
              ...(publicPostId !== null ? { publicaly_available_post_id: [Number(publicPostId.replace(/\D/g, ''))] } : {}),
            },
          },
          rateLimit: null,
        };
      }
      // FAILED: the documented fail_reason split (the spam_risk family →
      // the restricted outcome with the signal; other reasons → the
      // failed outcome with the provider's own reason).
      const failReason = statusState.failReason ?? 'video_pull_failed';
      if (['spam_risk', 'spam_risk_text', 'spam_risk_user_banned_from_posting', 'spam_risk_too_many_posts'].includes(failReason)) {
        return {
          ok: true,
          status: {
            publishState: 'restricted',
            providerPublishId: publish.providerPublishId,
            providerContentId: null,
            publishedAt: null,
            providerFailureReason: null,
            restrictionSignals: [
              {
                signalKind: `publish.fail_reason.${failReason}`,
                observedAt: null,
                description: `the publish status fetch reports the documented fail_reason '${failReason}' (the provider-signalled restriction class)`,
                data: { publishId: publish.providerPublishId, fail_reason: failReason },
              },
            ],
            providerData: { status: 'FAILED', fail_reason: failReason },
          },
          rateLimit: null,
        };
      }
      return {
        ok: true,
        status: {
          publishState: 'failed',
          providerPublishId: publish.providerPublishId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason: `fail_reason=${failReason} (the provider reports the publish failed)`,
          restrictionSignals: [],
          providerData: { status: 'FAILED', fail_reason: failReason },
        },
        rateLimit: null,
      };
    },
  };
}
