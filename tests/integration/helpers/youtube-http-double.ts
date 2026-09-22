/**
 * MKT-057 integration-test harness — the COMBINED YOUTUBE PROVIDER
 * DOUBLE: ONE in-process loopback HTTP server standing in for the
 * provider (NO external network — not callable from the sandbox and
 * deliberately not attempted), serving BOTH provider planes exactly
 * like the single provider identity behind Google's API surface:
 *
 *   1. the OAUTH token plane — the provider-neutral local OAuth
 *      protocol (the same fixture protocol as the canonical
 *      tests/integration/helpers/oauth-provider.ts: the token endpoint
 *      code/refresh exchange + the revocation endpoint + the
 *      resource-owner fixture endpoint minting authorization codes
 *      bound to external channel identities, verbatim scope lists and
 *      capability tags). The double implements the LocalOAuthProvider
 *      interface so it serves as the conformance suite's `provider`
 *      argument and the createLocalOAuthFlow backend;
 *
 *   2. the YOUTUBE API plane — a faithful mirror of the DOCUMENTED
 *      Data API v3 + Analytics API v2 endpoints the real adapter
 *      (src/modules/social-accounts/internal/adapters/youtube/adapter.ts)
 *      calls, on the SAME origin (the connection's providerConfig
 *      .apiBaseUrl points here — the documented deployment override of
 *      the www.googleapis.com host; the platform HttpCallPort permits
 *      loopback http for exactly this test shape):
 *        GET  /youtube/v3/channels?part=..&mine=true
 *        GET  /youtube/v3/search?part=snippet&q=..|channelId=..
 *        GET  /youtube/v3/videos?part=..&id=..
 *        GET  /youtubeAnalytics/v2/reports?ids=channel==MINE..
 *        POST /upload/youtube/v3/videos?uploadType=resumable&part=..
 *        PUT  /upload/youtube/v3/videos?uploadType=resumable&upload_id=..
 *
 *      Fidelity model (the documented semantics):
 *        - the Google standard error envelope on failures (401
 *          unauthorized, 403 quotaExceeded/rateLimitExceeded/forbidden/
 *          youtubeSignupRequired, 400 invalidVideoMetadata, 404 unknown
 *          session, 5xx backendError);
 *        - the documented QUOTA COST accounting (read=1, search.list=100,
 *          videos.insert=1600 units against the 10,000 units/day default
 *          budget — https://developers.google.com/youtube/v3/determine_quota_cost)
 *          with exhaustion answering the documented 403 quotaExceeded
 *          (no Retry-After — the daily quota resets at the provider's
 *          midnight, the observable backoff carries only where the
 *          provider sends one);
 *        - the documented pageToken/nextPageToken pagination of
 *          search.list (public discovery pages; own-content listing);
 *          search results carry NO statistics (the documented search
 *          limitation) and search.list returns ONLY public videos
 *          (rejected/private uploads never appear — the documented
 *          indexing behavior);
 *        - the documented resumable-upload lifecycle: the initiation
 *          (metadata POST) answers 201 + the Location session URI
 *          (upload_id); the session status probe (PUT with the
 *          Content-Range status-probe value) answers 308 Resume
 *          Incomplete while processing and 201 + the video resource on
 *          completion (status.uploadStatus processed/rejected/failed +
 *          the documented rejectionReason);
 *        - the documented provider-side metadata validation: an
 *          initiation whose snippet carries NO title answers the
 *          documented 400 invalidVideoMetadata envelope (the processed
 *          rejection).
 *
 * Scriptable/observation surface (in-process control — the test owns
 * the server object): per-endpoint failure scripting, the quota
 * budget/exhaustion control + the consumed-units read, the upload
 * session advance, the channel fixtures (register/remove) and the
 * per-endpoint request counts (the inertness/zero-traffic assertions).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { LocalOAuthMode, LocalOAuthProvider } from './oauth-provider.ts';

// ---------------------------------------------------------------------------
// The fixture data model (the documented resource shapes)
// ---------------------------------------------------------------------------

export interface YouTubeDoubleVideo {
  readonly videoId: string;
  readonly title: string;
  readonly publishedAt: string;
  readonly channelId: string;
  /** The documented statistics part (viewCount/likeCount/commentCount — NO shareCount). */
  readonly statistics: { readonly viewCount: number; readonly likeCount: number; readonly commentCount: number };
  readonly status: {
    readonly uploadStatus: 'processed' | 'rejected' | 'failed' | 'uploaded';
    readonly privacyStatus: 'public' | 'private' | 'unlisted';
    readonly rejectionReason?: string;
  };
  /** The documented contentDetails.regionRestriction surface (null when absent). */
  readonly regionRestriction: { readonly allowed?: readonly string[]; readonly blocked?: readonly string[] } | null;
  /** The observed Analytics metric points of this video. */
  readonly analytics: Readonly<Record<string, number>>;
}

export interface YouTubeDoubleChannel {
  readonly channelId: string;
  readonly title: string;
  readonly subscriberCount: number;
  readonly videoCount: number;
  readonly viewCount: number;
  readonly videos: readonly YouTubeDoubleVideo[];
  readonly analytics: Readonly<Record<string, number>>;
}

/** The default channel fixture of an account (3 public videos + 1 region-restricted public video). */
function defaultChannelOf(channelId: string): YouTubeDoubleChannel {
  const base = (index: number): YouTubeDoubleVideo => ({
    videoId: `yt-video-${channelId}-${index}`,
    title: `Fixture video ${index} of ${channelId}`,
    publishedAt: `2026-08-0${index}T10:00:00.000Z`,
    channelId,
    statistics: { viewCount: 1000 * index, likeCount: 100 * index, commentCount: 10 * index },
    status: { uploadStatus: 'processed', privacyStatus: 'public' },
    regionRestriction: null,
    analytics: {
      views: 1000 * index,
      likes: 100 * index,
      comments: 10 * index,
      shares: 5 * index,
      estimatedMinutesWatched: 500 * index,
    },
  });
  return {
    channelId,
    title: `Fixture Channel ${channelId}`,
    subscriberCount: 4242,
    videoCount: 4,
    viewCount: 12345,
    videos: [
      base(1),
      base(2),
      base(3),
      {
        videoId: `yt-video-${channelId}-geo`,
        title: `Region-restricted fixture of ${channelId}`,
        publishedAt: '2026-08-04T10:00:00.000Z',
        channelId,
        statistics: { viewCount: 777, likeCount: 77, commentCount: 7 },
        status: { uploadStatus: 'processed', privacyStatus: 'public' },
        // The documented contentDetails.regionRestriction surface.
        regionRestriction: { blocked: ['DE', 'JP'] },
        analytics: { views: 777, likes: 77, comments: 7, shares: 3, estimatedMinutesWatched: 350 },
      },
    ],
    analytics: { views: 12345, subscribersGained: 42, subscribersLost: 7, estimatedMinutesWatched: 900_000 },
  };
}

/**
 * The default channel fixture constructor (the explicit registration
 * form — the double does NOT auto-register channels, so an account
 * without a registered channel observes the documented 403
 * youtubeSignupRequired eligibility answer).
 */
export function youTubeDoubleDefaultChannel(channelId: string): YouTubeDoubleChannel {
  return defaultChannelOf(channelId);
}

type UploadSessionState = 'accepted' | 'published' | 'failed' | 'rejected';

interface UploadSession {
  readonly uploadId: string;
  readonly channelId: string;
  state: UploadSessionState;
  videoId: string | null;
  rejectionReason: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly idempotencyHint: string | null;
}

/** The per-endpoint scripted failure (the documented envelope shape). */
interface ScriptedFailure {
  readonly status: number;
  readonly reason: string;
  readonly message: string;
  readonly retryAfterSeconds: number | null;
}

export type YouTubeDoubleEndpoint = 'channels' | 'search' | 'videos' | 'analytics' | 'insert' | 'session-probe';

/** The documented quota cost per call class (determine_quota_cost). */
const QUOTA_COST: Readonly<Record<YouTubeDoubleEndpoint, number>> = {
  channels: 1,
  search: 100,
  videos: 1,
  analytics: 1,
  insert: 1600,
  'session-probe': 1,
};

const DEFAULT_DAILY_QUOTA_UNITS = 10_000;

export interface YouTubeProviderDouble extends LocalOAuthProvider {
  /** The number of API-plane requests received per endpoint (the zero-traffic assertions). */
  requestCount(endpoint: YouTubeDoubleEndpoint): number;
  /** The total number of API-plane requests received. */
  totalRequestCount(): number;
  /** Replaces the channel fixture of an account (auto-defaults on first use). */
  registerChannel(channel: YouTubeDoubleChannel): void;
  /** Removes an account's channel — channels.list mine=true then answers the documented 403 youtubeSignupRequired. */
  removeChannel(channelId: string): void;
  /** The consumed quota units (the documented cost accounting). */
  consumedQuotaUnits(): number;
  /** Replaces the daily quota budget (the exhaustion battery). */
  setDailyQuotaUnits(units: number): void;
  /** Resets the consumed quota accounting. */
  resetQuota(): void;
  /** Scripts a documented error envelope on an endpoint (null status clears). */
  scriptFailure(endpoint: YouTubeDoubleEndpoint, failure: ScriptedFailure | null): void;
  /** Moves an upload session to a later state (the poll battery). */
  advanceUploadSession(
    uploadId: string,
    state: UploadSessionState,
    patch?: { readonly videoId?: string; readonly rejectionReason?: string },
  ): void;
  /** The recorded upload sessions. */
  uploadSessions(): readonly UploadSession[];
}

// ---------------------------------------------------------------------------
// The OAuth fixture protocol (the canonical oauth-provider.ts protocol)
// ---------------------------------------------------------------------------

interface AuthorizationFixture {
  readonly accountId: string;
  readonly displayIdentity: string;
  readonly verifiedAt: string | null;
  readonly scopes: readonly string[];
  readonly refreshScopes: readonly string[];
  readonly capabilityTags: readonly string[];
  readonly expiresInMs: number | null;
  readonly refreshExpiresInMs: number | null;
  readonly authorizationCode: string;
  readonly refreshToken: string;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** Boots the COMBINED YouTube provider double (OAuth plane + documented API plane, one loopback origin). */
export function startYouTubeProviderDouble(): Promise<YouTubeProviderDouble> {
  const authorizations = new Map<string, AuthorizationFixture>();
  const refreshTokens = new Map<string, AuthorizationFixture>();
  /** The bearer-token → channel binding (minted at exchange time — the provider resolves the account from the token). */
  const tokenChannels = new Map<string, string>();
  const channels = new Map<string, YouTubeDoubleChannel>();
  const sessions = new Map<string, UploadSession>();
  const scripted = new Map<YouTubeDoubleEndpoint, ScriptedFailure>();
  const requestCounts = new Map<YouTubeDoubleEndpoint, number>();
  let mode: LocalOAuthMode = 'ok';
  let exchanges = 0;
  let revokes = 0;
  let consumedUnits = 0;
  let dailyQuotaUnits = DEFAULT_DAILY_QUOTA_UNITS;
  let sessionSequence = 0;

  const channelOf = (channelId: string): YouTubeDoubleChannel => {
    const existing = channels.get(channelId);
    if (existing !== undefined) return existing;
    const fresh = defaultChannelOf(channelId);
    channels.set(channelId, fresh);
    return fresh;
  };

  /** The documented Google error envelope. */
  const envelope = (status: number, reason: string, message: string): { status: number; body: string } => ({
    status,
    body: JSON.stringify({
      error: {
        code: status,
        message,
        errors: [{ reason, message, domain: 'youtube.double' }],
      },
    }),
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const reply = (status: number, payload: unknown, headers: Readonly<Record<string, string>> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      // ------------------------------------------------------------------
      // The OAuth token plane (the canonical local OAuth protocol).
      // ------------------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/v1/ping') {
        reply(200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        exchanges += 1;
        if (mode === 'garbage') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('<html>not json</html>');
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          reply(400, { error: 'invalid_request' });
          return;
        }
        if (mode === 'reject-code') {
          reply(400, { error: 'invalid_grant' });
          return;
        }
        const grantType = parsed['grant_type'];
        let fixture: AuthorizationFixture | undefined;
        if (grantType === 'authorization_code') {
          fixture = authorizations.get(String(parsed['code'] ?? ''));
          if (fixture !== undefined) authorizations.delete(String(parsed['code']));
        } else if (grantType === 'refresh_token') {
          fixture = refreshTokens.get(String(parsed['refresh_token'] ?? ''));
        }
        if (fixture === undefined) {
          reply(400, { error: 'invalid_grant' });
          return;
        }
        const accessToken = `sandbox-yt-at-${randomUUID()}`;
        const refreshToken = `sandbox-yt-rt-${randomUUID()}`;
        const fresh: AuthorizationFixture = { ...fixture, refreshToken };
        refreshTokens.set(refreshToken, fresh);
        tokenChannels.set(accessToken, fixture.accountId);
        reply(200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          scope: (grantType === 'refresh_token' ? fixture.refreshScopes : fixture.scopes).join(' '),
          account_id: fixture.accountId,
          display_name: fixture.displayIdentity,
          verified_at: fixture.verifiedAt,
          expires_in_ms:
            grantType === 'refresh_token' ? fixture.refreshExpiresInMs : fixture.expiresInMs,
          capabilities: [...fixture.capabilityTags],
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
        revokes += 1;
        reply(200, { revoked: true });
        return;
      }

      // ------------------------------------------------------------------
      // The YouTube API plane (the documented endpoints).
      // ------------------------------------------------------------------
      const bearer = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '');
      const channelIdOfToken = (): string | null => {
        if (bearer === null) return null;
        const bound = tokenChannels.get(bearer[1]!);
        return bound ?? null;
      };

      /** The shared prelude: counting, quota accounting, scripted failures, bearer validation. */
      const prelude = (
        endpoint: YouTubeDoubleEndpoint,
      ): { ok: true; channelId: string | null } | { ok: false; status: number; body: string; headers: Record<string, string> } => {
        requestCounts.set(endpoint, (requestCounts.get(endpoint) ?? 0) + 1);
        const scriptedFailure = scripted.get(endpoint);
        if (scriptedFailure !== undefined) {
          const error = envelope(scriptedFailure.status, scriptedFailure.reason, scriptedFailure.message);
          return {
            ok: false,
            status: error.status,
            body: error.body,
            headers:
              scriptedFailure.retryAfterSeconds !== null
                ? { 'retry-after': String(scriptedFailure.retryAfterSeconds) }
                : {},
          };
        }
        consumedUnits += QUOTA_COST[endpoint];
        if (consumedUnits > dailyQuotaUnits) {
          // The documented daily-quota exhaustion (no Retry-After — the
          // daily quota resets at the provider's midnight).
          const error = envelope(
            403,
            'quotaExceeded',
            'The request cannot be completed because you have exceeded your quota.',
          );
          return { ok: false, status: error.status, body: error.body, headers: {} };
        }
        if (bearer === null) {
          const error = envelope(401, 'unauthorized', 'The request uses an invalid or missing authorization token.');
          return { ok: false, status: error.status, body: error.body, headers: {} };
        }
        return { ok: true, channelId: channelIdOfToken() };
      };

      if (req.method === 'GET' && url.pathname === '/youtube/v3/channels') {
        const gate = prelude('channels');
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        if (url.searchParams.get('mine') !== 'true' || gate.channelId === null) {
          const error = envelope(
            401,
            'unauthorized',
            'The channels.list mine=true view requires the authorized user token.',
          );
          reply(error.status, error.body);
          return;
        }
        if (!channels.has(gate.channelId)) {
          // The documented eligibility answer of an account with no YouTube channel.
          const error = envelope(
            403,
            'youtubeSignupRequired',
            'The authorization account does not have a YouTube channel.',
          );
          reply(error.status, error.body);
          return;
        }
        const channel = channelOf(gate.channelId);
        reply(200, {
          kind: 'youtube#channelListResponse',
          etag: 'double-channels-etag',
          pageInfo: { totalResults: 1, resultsPerPage: 1 },
          items: [
            {
              kind: 'youtube#channel',
              etag: `double-channel-${channel.channelId}`,
              id: channel.channelId,
              snippet: {
                title: channel.title,
                description: `The fixture channel ${channel.channelId} of the YouTube provider double.`,
                customUrl: `@${channel.channelId}`,
                publishedAt: '2025-01-01T00:00:00.000Z',
              },
              statistics: {
                viewCount: String(channel.viewCount),
                subscriberCount: String(channel.subscriberCount),
                hiddenSubscriberCount: false,
                videoCount: String(channel.videoCount),
              },
            },
          ],
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/youtube/v3/search') {
        const gate = prelude('search');
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const maxResults = Number(url.searchParams.get('maxResults') ?? '25');
        const pageToken = url.searchParams.get('pageToken');
        const channelId = url.searchParams.get('channelId');
        const query = url.searchParams.get('q');
        const searchItemOf = (video: YouTubeDoubleVideo): unknown => ({
          kind: 'youtube#searchResult',
          etag: `double-search-${video.videoId}`,
          id: { kind: 'youtube#video', videoId: video.videoId },
          snippet: {
            publishedAt: video.publishedAt,
            channelId: video.channelId,
            title: video.title,
            description: `The fixture description of ${video.videoId}.`,
            channelTitle: channelOf(video.channelId).title,
            publishTime: video.publishedAt,
          },
        });
        if (channelId !== null) {
          // The own-content listing: ONLY the channel's public processed
          // videos (the documented search.list indexing limitation).
          if (gate.channelId === null || !channels.has(channelId)) {
            const error = envelope(403, 'forbidden', 'The own-content search requires the authorized channel.');
            reply(error.status, error.body);
            return;
          }
          const channel = channelOf(channelId);
          const publicVideos = channel.videos.filter(
            (video) => video.status.uploadStatus === 'processed' && video.status.privacyStatus === 'public',
          );
          const firstPage = publicVideos.slice(0, Math.max(maxResults, 1));
          const rest = publicVideos.slice(Math.max(maxResults, 1));
          reply(200, {
            kind: 'youtube#searchListResponse',
            etag: 'double-search-etag',
            nextPageToken: rest.length > 0 && pageToken === null ? 'yt-page-2' : null,
            pageInfo: { totalResults: publicVideos.length, resultsPerPage: maxResults },
            items:
              pageToken === 'yt-page-2'
                ? rest.slice(0, Math.max(maxResults, 1)).map(searchItemOf)
                : firstPage.map(searchItemOf),
          });
          return;
        }
        if (query !== null) {
          // The public discovery: deterministic generated results over
          // two documented pages (the pageToken round-trip).
          const slug = query.replace(/\W+/g, '-').slice(0, 40);
          const pageTwo = pageToken === 'yt-page-2';
          const items = pageTwo
            ? [
                {
                  kind: 'youtube#searchResult',
                  etag: `double-search-${slug}-2`,
                  id: { kind: 'youtube#video', videoId: `yt-search-${slug}-2` },
                  snippet: {
                    publishedAt: '2026-08-01T08:00:00.000Z',
                    channelId: 'yt-search-author-2',
                    title: `Public result 2 for ${query}`,
                    description: 'A generated public discovery fixture.',
                    channelTitle: 'Search Author 2',
                    publishTime: '2026-08-01T08:00:00.000Z',
                  },
                },
              ]
            : [0, 1].map((index) => ({
                kind: 'youtube#searchResult',
                etag: `double-search-${slug}-${index}`,
                id: { kind: 'youtube#video', videoId: `yt-search-${slug}-${index}` },
                snippet: {
                  publishedAt: '2026-08-01T08:00:00.000Z',
                  channelId: `yt-search-author-${index}`,
                  title: `Public result ${index} for ${query}`,
                  description: 'A generated public discovery fixture.',
                  channelTitle: `Search Author ${index}`,
                  publishTime: '2026-08-01T08:00:00.000Z',
                },
              }));
          reply(200, {
            kind: 'youtube#searchListResponse',
            etag: 'double-search-etag',
            nextPageToken: pageTwo ? null : 'yt-page-2',
            pageInfo: { totalResults: 3, resultsPerPage: maxResults },
            items,
          });
          return;
        }
        const error = envelope(400, 'badRequest', 'The search request carries neither q nor channelId.');
        reply(error.status, error.body);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/youtube/v3/videos') {
        const gate = prelude('videos');
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const ids = (url.searchParams.get('id') ?? '').split(',').filter((id) => id !== '');
        const items: unknown[] = [];
        for (const id of ids) {
          for (const channel of channels.values()) {
            const video = channel.videos.find((entry) => entry.videoId === id);
            if (video === undefined) continue;
            items.push({
              kind: 'youtube#video',
              etag: `double-video-${video.videoId}`,
              id: video.videoId,
              snippet: {
                publishedAt: video.publishedAt,
                channelId: video.channelId,
                title: video.title,
                description: `The fixture description of ${video.videoId}.`,
              },
              statistics: {
                viewCount: String(video.statistics.viewCount),
                likeCount: String(video.statistics.likeCount),
                favoriteCount: '0',
                commentCount: String(video.statistics.commentCount),
              },
              status: {
                uploadStatus: video.status.uploadStatus,
                privacyStatus: video.status.privacyStatus,
                ...(video.status.rejectionReason !== undefined ? { rejectionReason: video.status.rejectionReason } : {}),
              },
              contentDetails: {
                duration: 'PT1M30S',
                ...(video.regionRestriction !== null ? { regionRestriction: video.regionRestriction } : {}),
              },
            });
          }
        }
        // The documented videos.list answer for unknown ids: an EMPTY items list.
        reply(200, {
          kind: 'youtube#videoListResponse',
          etag: 'double-videos-etag',
          pageInfo: { totalResults: items.length, resultsPerPage: ids.length },
          items,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/youtubeAnalytics/v2/reports') {
        const gate = prelude('analytics');
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const metrics = (url.searchParams.get('metrics') ?? '').split(',').filter((m) => m !== '');
        const videoFilter = url.searchParams.get('filters');
        const videoId = videoFilter !== null ? videoFilter.replace(/^video==/, '') : null;
        let facts: Readonly<Record<string, number>> | null;
        if (videoId !== null) {
          facts = null;
          for (const channel of channels.values()) {
            const video = channel.videos.find((entry) => entry.videoId === videoId);
            if (video !== undefined) facts = video.analytics;
          }
        } else {
          facts = gate.channelId !== null && channels.has(gate.channelId) ? channelOf(gate.channelId).analytics : null;
        }
        if (facts === null) {
          // An empty report: no rows (never fabricated zeros).
          reply(200, {
            columnHeaders: metrics.map((metric) => ({ name: metric, columnType: 'METRIC', dataType: 'LONG' })),
            rows: [],
          });
          return;
        }
        reply(200, {
          columnHeaders: metrics.map((metric) => ({ name: metric, columnType: 'METRIC', dataType: 'LONG' })),
          rows: [metrics.map((metric) => facts![metric] ?? 0)],
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/videos') {
        const gate = prelude('insert');
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        if (gate.channelId === null || !channels.has(gate.channelId)) {
          const error = envelope(403, 'forbidden', 'The upload requires the authorized channel.');
          reply(error.status, error.body);
          return;
        }
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          const error = envelope(400, 'badRequest', 'The upload initiation body was not the metadata resource.');
          reply(error.status, error.body);
          return;
        }
        const snippet = (metadata['snippet'] ?? {}) as { title?: unknown };
        if (typeof snippet.title !== 'string' || snippet.title === '') {
          // The documented provider-side metadata validation: the
          // PROCESSED 400 rejection (the video resource requires a title).
          const error = envelope(
            400,
            'invalidVideoMetadata',
            'The request metadata is invalid: the snippet title is required.',
          );
          reply(error.status, error.body);
          return;
        }
        sessionSequence += 1;
        const uploadId = `yt-upload-${sessionSequence}`;
        sessions.set(uploadId, {
          uploadId,
          channelId: gate.channelId,
          state: 'accepted',
          videoId: null,
          rejectionReason: null,
          metadata,
          idempotencyHint: (metadata['idempotencyKey'] as string | undefined) ?? null,
        });
        // The documented initiation answer: 201 + the Location session URI.
        reply(
          201,
          '',
          {
            location: `${serverAddressUrl()}/upload/youtube/v3/videos?uploadType=resumable&upload_id=${uploadId}&part=snippet,status`,
          },
        );
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/upload/youtube/v3/videos') {
        const gate = prelude('session-probe');
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const uploadId = url.searchParams.get('upload_id');
        const session = uploadId !== null ? sessions.get(uploadId) : undefined;
        if (session === undefined) {
          // The documented unknown/expired session answer.
          const error = envelope(404, 'notFound', 'The upload session does not exist or has expired.');
          reply(error.status, error.body);
          return;
        }
        if (session.state === 'accepted') {
          // The documented in-flight answer: 308 Resume Incomplete.
          res.writeHead(308, { 'content-type': 'application/json', range: 'bytes=0-0' });
          res.end();
          return;
        }
        const videoId = session.videoId ?? `yt-video-published-${session.uploadId}`;
        const uploadStatus =
          session.state === 'published' ? 'processed' : session.state === 'rejected' ? 'rejected' : 'failed';
        reply(201, {
          kind: 'youtube#video',
          etag: `double-session-${session.uploadId}`,
          id: videoId,
          snippet: {
            publishedAt: '2026-08-02T12:00:00.000Z',
            channelId: session.channelId,
            title: `Uploaded fixture ${session.uploadId}`,
            description: 'The uploaded fixture of the resumable session double.',
          },
          status: {
            uploadStatus,
            privacyStatus: 'public',
            ...(session.rejectionReason !== null ? { rejectionReason: session.rejectionReason } : {}),
          },
        });
        return;
      }

      reply(404, { error: 'not_found' });
    });
  });

  let serverUrl = '';
  const serverAddressUrl = (): string => serverUrl;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      serverUrl = `http://127.0.0.1:${address.port}`;
      resolve({
        url: serverUrl,
        port: address.port,
        exchangeCount: () => exchanges,
        revokeCount: () => revokes,
        setMode: (next: LocalOAuthMode) => {
          mode = next;
        },
        skipHandleProvisioning: false,
        issueAuthorization(input) {
          const authorizationCode = `sandbox-yt-code-${randomUUID()}`;
          const refreshToken = `sandbox-yt-rt-${randomUUID()}`;
          const fixture: AuthorizationFixture = {
            accountId: input.accountId,
            displayIdentity: input.displayIdentity,
            verifiedAt: input.verifiedAt,
            scopes: [...input.scopes],
            refreshScopes: [...(input.refreshScopes ?? input.scopes)],
            capabilityTags: [...input.capabilityTags],
            expiresInMs: input.expiresInMs,
            refreshExpiresInMs:
              input.refreshExpiresInMs === undefined ? input.expiresInMs : input.refreshExpiresInMs,
            authorizationCode,
            refreshToken,
          };
          authorizations.set(authorizationCode, fixture);
          refreshTokens.set(refreshToken, fixture);
          return { code: authorizationCode, accountId: input.accountId, scopes: [...input.scopes] };
        },
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error === undefined ? closeResolve() : closeReject(error)));
          }),
        requestCount(endpoint) {
          return requestCounts.get(endpoint) ?? 0;
        },
        totalRequestCount() {
          return [...requestCounts.values()].reduce((sum, count) => sum + count, 0);
        },
        registerChannel(channel) {
          channels.set(channel.channelId, channel);
        },
        removeChannel(channelId) {
          channels.delete(channelId);
        },
        consumedQuotaUnits() {
          return consumedUnits;
        },
        setDailyQuotaUnits(units) {
          dailyQuotaUnits = units;
        },
        resetQuota() {
          consumedUnits = 0;
        },
        scriptFailure(endpoint, failure) {
          if (failure === null) {
            scripted.delete(endpoint);
          } else {
            scripted.set(endpoint, failure);
          }
        },
        advanceUploadSession(uploadId, state, patch) {
          const session = sessions.get(uploadId);
          if (session === undefined) return;
          session.state = state;
          session.videoId = patch?.videoId ?? session.videoId;
          session.rejectionReason =
            state === 'rejected' ? (patch?.rejectionReason ?? 'inappropriate') : null;
        },
        uploadSessions() {
          return [...sessions.values()];
        },
      });
    });
  });
}
