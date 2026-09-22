/**
 * MKT-058 integration-test harness — the COMBINED INSTAGRAM PROVIDER
 * DOUBLE: ONE in-process loopback HTTP server standing in for the
 * provider (NO external network — not callable from the sandbox and
 * deliberately not attempted), serving BOTH provider planes exactly
 * like the single provider identity behind the documented Instagram
 * Graph API surface (the MKT-057 combined-double pattern):
 *
 *   1. the OAUTH token plane — the provider-neutral local OAuth
 *      protocol (the same fixture protocol as the canonical
 *      tests/integration/helpers/oauth-provider.ts: the token endpoint
 *      code/refresh exchange + the revocation endpoint + the
 *      resource-owner fixture endpoint minting authorization codes
 *      bound to external IG account identities, VERBATIM scope lists
 *      and capability tags). The double implements the
 *      LocalOAuthProvider interface so it serves as the conformance
 *      suite's `provider` argument and the createLocalOAuthFlow backend
 *      (the Facebook Login surface the Instagram Graph API rides on);
 *
 *   2. the INSTAGRAM GRAPH API plane — a faithful mirror of the
 *      DOCUMENTED endpoints the real adapter
 *      (src/modules/social-accounts/internal/adapters/instagram/adapter.ts)
 *      calls, on the SAME origin (the connection's providerConfig
 *      .apiBaseUrl points here — the documented deployment override of
 *      the https://graph.facebook.com/v21.0 host; the platform
 *      HttpCallPort permits loopback http for exactly this test shape):
 *        GET  /{ig-user-id}?fields=..                (the IG User node)
 *        GET  /{ig-user-id}/media?fields=..&limit=..&after=..
 *        GET  /{media-id}?fields=..                  (the IG Media node)
 *        GET  /ig_hashtag_search?user_id=..&q=..
 *        GET  /{hashtag-id}/top_media?user_id=..&fields=..
 *        GET  /{ig-user-id}/insights?metric=..&period=day..
 *        GET  /{media-id}/insights?metric=..
 *        POST /{ig-user-id}/media                    (container creation)
 *        POST /{ig-user-id}/media_publish            (creation_id → media id)
 *        GET  /{container-id}?fields=status_code     (container status)
 *
 *      Fidelity model (the documented semantics — see
 *      docs/runbooks/MKT-058.md):
 *        - the Graph API standard error envelope on failures (the
 *          envelope-CODE classes: 190/102 token-session death, 4/17/32/
 *          613 the documented request-limit classes, 10 the documented
 *          permission/eligibility class, 100 the invalid-parameter/
 *          non-existing-object family — most errors ride HTTP 400);
 *        - THE ACCOUNT-TYPE ENFORCEMENT (the MKT-058 AC): the
 *          documented surface serves Business/Creator (Professional)
 *          accounts ONLY — an account registered as PERSONAL answers
 *          the provider's OWN documented error semantics, error code 10
 *          '(#10) The user is not an Instagram Business' (type
 *          OAuthException), on EVERY documented endpoint: an
 *          account-level limitation surfaced as honest error data,
 *          never a fabricated success;
 *        - the documented PUBLISH rate surface: the account-level
 *          content_publishing_limit quota (quota_total 50, quota_duration
 *          86400 seconds — the 24-hour publish window) enforced on the
 *          media_publish step; the exhaustion answers the documented
 *          request-limit error class (code 4) with the limit message;
 *        - the documented hashtag rate surface: 30 unique hashtags per
 *          rolling 7-day window per account on ig_hashtag_search (a new
 *          unique hashtag beyond the window answers the documented
 *          request-limit error class; repeat queries of an
 *          already-queried hashtag do not consume the window);
 *        - the documented container lifecycle: the container is born
 *          IN_PROGRESS; advanceContainer moves it to FINISHED/PUBLISHED/
 *          EXPIRED/ERROR (with the documented status text on ERROR);
 *          media_publish requires FINISHED (publishing before it
 *          finishes errors with the documented invalid-parameter class);
 *          a successful media_publish answers { id: media id } and
 *          marks the container PUBLISHED;
 *        - the documented provider-side source validation: a container
 *          creation with NO image_url/video_url/children answers the
 *          documented code-100 invalid-parameter family;
 *        - the documented observable usage headers: every API-plane
 *          response carries X-App-Usage (call-count/CPU/time
 *          percentages); the scripted request-limit failures carry
 *          X-Business-Use-Case-Usage with
 *          estimated_time_to_regain_call_capacity seconds (the
 *          observable backoff signal the adapter reports on the
 *          rate-limited failure observations);
 *        - the documented per-type media-insights metric vocabulary
 *          (requesting a metric the media type does not support errors
 *          with the code-100 family — the honest validation the
 *          adapter's type-resolution step exists to avoid);
 *        - the documented day-period account insights: data[] with
 *          name/period/values[] (value + end_time per day slice; the
 *          profile metrics and the per-slice end_time stamps).
 *
 * Scriptable/observation surface (in-process control — the test owns
 * the server object): per-endpoint failure scripting, the account
 * fixtures (registerAccount with the account type), the publish-quota
 * controls, the hashtag-window controls, the container advance, the
 * per-endpoint request counts (the inertness/zero-traffic assertions)
 * and the sent-header observation.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { LocalOAuthMode, LocalOAuthProvider } from './oauth-provider.ts';

// ---------------------------------------------------------------------------
// The fixture data model (the documented resource shapes)
// ---------------------------------------------------------------------------

export type InstagramAccountType = 'BUSINESS' | 'CREATOR' | 'PERSONAL';

export interface InstagramDoubleAccount {
  readonly igUserId: string;
  readonly accountType: InstagramAccountType;
  /** The documented IG User node fields. */
  readonly username: string;
  readonly followersCount: number;
  readonly mediaCount: number;
  readonly profilePictureUrl: string;
}

export interface InstagramDoubleMedia {
  readonly mediaId: string;
  readonly igUserId: string;
  readonly caption: string;
  readonly mediaType: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  readonly mediaUrl: string;
  readonly permalink: string;
  readonly timestamp: string;
  readonly likeCount: number;
  readonly commentsCount: number;
  /** The documented per-type insight metric points of this media. */
  readonly insights: Readonly<Record<string, number>>;
}

export interface InstagramDoubleHashtagMedia {
  readonly mediaId: string;
  readonly caption: string;
  readonly likeCount: number;
  readonly commentsCount: number;
  readonly timestamp: string;
}

/** The documented per-type media-insights metric vocabulary (the availability table the double enforces). */
const MEDIA_INSIGHT_METRICS: Readonly<Record<string, readonly string[]>> = {
  IMAGE: ['engagement', 'impressions', 'reach', 'saved'],
  VIDEO: ['engagement', 'impressions', 'reach', 'saved', 'video_views'],
  CAROUSEL_ALBUM: [
    'carousel_album_engagement',
    'carousel_album_impressions',
    'carousel_album_reach',
    'carousel_album_saved',
    'carousel_album_video_views',
  ],
};

/** The documented day-period account insight metrics. */
const ACCOUNT_INSIGHT_METRICS = ['follower_count', 'impressions', 'profile_views', 'reach'];

/** The default account fixture of an unknown IG user id (a BUSINESS Professional account). */
function defaultAccountOf(igUserId: string): InstagramDoubleAccount {
  return {
    igUserId,
    accountType: 'BUSINESS',
    username: `fixture_${igUserId}`,
    followersCount: 4242,
    mediaCount: 5,
    profilePictureUrl: `https://cdn.example/ig/${igUserId}.jpg`,
  };
}

/** The default media fixtures of an account (3 photos + 1 video + 1 carousel — the per-type insight battery). */
function defaultMediaOf(igUserId: string): InstagramDoubleMedia[] {
  const photo = (index: number): InstagramDoubleMedia => ({
    mediaId: `ig-media-${igUserId}-${index}`,
    igUserId,
    caption: `Fixture media ${index} of ${igUserId}`,
    mediaType: 'IMAGE',
    mediaUrl: `https://cdn.example/ig/${igUserId}-${index}.jpg`,
    permalink: `https://www.instagram.com/p/double-${igUserId}-${index}/`,
    timestamp: `2026-08-0${index}T10:00:00.000Z`,
    likeCount: 100 * index,
    commentsCount: 10 * index,
    insights: {
      engagement: 110 * index,
      impressions: 1000 * index,
      reach: 500 * index,
      saved: 10 * index,
    },
  });
  return [
    photo(1),
    photo(2),
    photo(3),
    {
      mediaId: `ig-media-${igUserId}-video`,
      igUserId,
      caption: `Fixture video of ${igUserId}`,
      mediaType: 'VIDEO',
      mediaUrl: `https://cdn.example/ig/${igUserId}-video.mp4`,
      permalink: `https://www.instagram.com/p/double-${igUserId}-video/`,
      timestamp: '2026-08-04T10:00:00.000Z',
      likeCount: 321,
      commentsCount: 43,
      insights: {
        engagement: 364,
        impressions: 4321,
        reach: 2100,
        saved: 22,
        video_views: 4096,
      },
    },
    {
      mediaId: `ig-media-${igUserId}-carousel`,
      igUserId,
      caption: `Fixture carousel of ${igUserId}`,
      mediaType: 'CAROUSEL_ALBUM',
      mediaUrl: `https://cdn.example/ig/${igUserId}-carousel.jpg`,
      permalink: `https://www.instagram.com/p/double-${igUserId}-carousel/`,
      timestamp: '2026-08-05T10:00:00.000Z',
      likeCount: 200,
      commentsCount: 20,
      insights: {
        carousel_album_engagement: 220,
        carousel_album_impressions: 2000,
        carousel_album_reach: 1000,
        carousel_album_saved: 5,
        carousel_album_video_views: 0,
      },
    },
  ];
}

/** The generated public hashtag media pages (the documented top_media view). */
function hashtagMediaOf(slug: string, index: number): InstagramDoubleHashtagMedia {
  return {
    mediaId: `ig-hashtag-media-${slug}-${index}`,
    caption: `Public result ${index} for #${slug}`,
    likeCount: 100 * (index + 1),
    commentsCount: 10 * (index + 1),
    timestamp: '2026-08-01T08:00:00.000Z',
  };
}

type ContainerState = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'EXPIRED' | 'ERROR';

interface RecordedContainer {
  readonly containerId: string;
  readonly igUserId: string;
  state: ContainerState;
  /** The published media id once the publish step fired. */
  mediaId: string | null;
  /** The documented container params (caption/image_url/video_url/media_type...). */
  readonly params: Readonly<Record<string, string>>;
  /** The documented status text (the ERROR outcome's own failure explanation). */
  statusText: string | null;
}

/** The per-endpoint scripted failure (the documented envelope shape). */
export interface InstagramScriptedFailure {
  /** The HTTP status of the documented answer (the Graph norm is 400; 5xx for server errors). */
  readonly status: number;
  /** The documented envelope code (10 the eligibility class; 4/17/32/613 the request-limit class; 190 the token class; 100 the invalid-parameter class). */
  readonly code: number;
  readonly message: string;
  readonly type?: string;
  readonly errorSubcode?: number;
  /** The documented observable backoff seconds (rides X-Business-Use-Case-Usage estimated_time_to_regain_call_capacity). */
  readonly retryAfterSeconds?: number | null;
}

export type InstagramDoubleEndpoint =
  | 'user-node'
  | 'media-edge'
  | 'media-node'
  | 'hashtag-search'
  | 'hashtag-media'
  | 'account-insights'
  | 'media-insights'
  | 'container-create'
  | 'container-status'
  | 'media-publish';

/** The documented content publishing limit defaults (quota_total 50, quota_duration 86400 — the 24-hour window). */
const DEFAULT_DAILY_PUBLISH_LIMIT = 50;
/** The documented hashtag window defaults (30 unique hashtags per rolling 7-day period). */
const DEFAULT_HASHTAG_WINDOW_LIMIT = 30;

export interface InstagramProviderDouble extends LocalOAuthProvider {
  /** The number of API-plane requests received per endpoint (the zero-traffic assertions). */
  requestCount(endpoint: InstagramDoubleEndpoint): number;
  /** The total number of API-plane requests received. */
  totalRequestCount(): number;
  /** Registers (or replaces) an account fixture — the account TYPE drives the documented eligibility enforcement. */
  registerAccount(input: { readonly igUserId: string; readonly accountType: InstagramAccountType }): void;
  /** Replaces the account-level 24h publish quota (the content_publishing_limit quota_total). */
  setDailyPublishLimit(limit: number): void;
  /** The consumed publish count of an account in the current window. */
  publishedCount(igUserId: string): number;
  /** Resets the publish-window accounting. */
  resetPublishWindow(): void;
  /** Replaces the unique-hashtag window limit (the documented 30-unique-hashtags rolling 7-day surface). */
  setHashtagWindowLimit(limit: number): void;
  /** The unique hashtags queried by an account in the current window. */
  queriedHashtags(igUserId: string): readonly string[];
  /** Resets the hashtag-window accounting. */
  resetHashtagWindow(): void;
  /** Scripts a documented error envelope on an endpoint (null clears). */
  scriptFailure(endpoint: InstagramDoubleEndpoint, failure: InstagramScriptedFailure | null): void;
  /** Moves a media container to a later state (the poll battery). */
  advanceContainer(
    containerId: string,
    state: ContainerState,
    patch?: { readonly statusText?: string },
  ): void;
  /** The recorded media containers. */
  containers(): readonly RecordedContainer[];
  /** The most recent X-App-Usage header value sent (the documented observable usage header — the fidelity assertion). */
  lastAppUsageHeader(): string | null;
  /** The media fixtures of an account (the read batteries). */
  mediaOf(igUserId: string): readonly InstagramDoubleMedia[];
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

/** Boots the COMBINED Instagram provider double (OAuth plane + documented Graph API plane, one loopback origin). */
export function startInstagramProviderDouble(): Promise<InstagramProviderDouble> {
  const authorizations = new Map<string, AuthorizationFixture>();
  const refreshTokens = new Map<string, AuthorizationFixture>();
  /** The bearer-token → IG account binding (minted at exchange time — the provider resolves the account from the token). */
  const tokenAccounts = new Map<string, string>();
  const accounts = new Map<string, InstagramDoubleAccount>();
  const mediaByAccount = new Map<string, InstagramDoubleMedia[]>();
  const mediaById = new Map<string, InstagramDoubleMedia>();
  const containersById = new Map<string, RecordedContainer>();
  const hashtagIds = new Map<string, string>();
  /** The documented hashtag window: per-account unique queried hashtags. */
  const hashtagWindow = new Map<string, string[]>();
  const scripted = new Map<InstagramDoubleEndpoint, InstagramScriptedFailure>();
  const requestCounts = new Map<InstagramDoubleEndpoint, number>();
  const publishedCounts = new Map<string, number>();
  let dailyPublishLimit = DEFAULT_DAILY_PUBLISH_LIMIT;
  let hashtagWindowLimit = DEFAULT_HASHTAG_WINDOW_LIMIT;
  let mode: LocalOAuthMode = 'ok';
  let exchanges = 0;
  let revokes = 0;
  let containerSequence = 0;
  let lastAppUsage = 'null';

  const accountOf = (igUserId: string): InstagramDoubleAccount => {
    const existing = accounts.get(igUserId);
    if (existing !== undefined) return existing;
    const fresh = defaultAccountOf(igUserId);
    accounts.set(igUserId, fresh);
    // Materialize the account's media fixtures (the documented Media
    // surface exists from the first API-plane view of the account — a
    // direct media-node/insights read resolves the fixtures too).
    mediaOf(igUserId);
    return fresh;
  };

  const mediaOf = (igUserId: string): InstagramDoubleMedia[] => {
    const existing = mediaByAccount.get(igUserId);
    if (existing !== undefined) return existing;
    const fresh = defaultMediaOf(igUserId);
    mediaByAccount.set(igUserId, fresh);
    for (const media of fresh) mediaById.set(media.mediaId, media);
    return fresh;
  };

  /** The documented Graph API error envelope. */
  const envelope = (status: number, code: number, message: string, type: string, subcode?: number): { status: number; body: string } => ({
    status,
    body: JSON.stringify({
      error: {
        message,
        type,
        code,
        ...(subcode !== undefined ? { error_subcode: subcode } : {}),
        fbtrace_id: `double-${randomUUID()}`,
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
        const appUsage = JSON.stringify({ call_count: 12.31, total_cputime: 0.04, total_time: 0.03 });
        lastAppUsage = appUsage;
        res.writeHead(status, {
          'content-type': 'application/json',
          'x-app-usage': appUsage,
          ...headers,
        });
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
        const accessToken = `sandbox-ig-at-${randomUUID()}`;
        const refreshToken = `sandbox-ig-rt-${randomUUID()}`;
        const fresh: AuthorizationFixture = { ...fixture, refreshToken };
        refreshTokens.set(refreshToken, fresh);
        tokenAccounts.set(accessToken, fixture.accountId);
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
      // The Instagram Graph API plane (the documented endpoints).
      // ------------------------------------------------------------------
      const bearer = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '');
      const endpointOf = (path: string, method: string): InstagramDoubleEndpoint | null => {
        const [id, ...suffixes] = path.split('/').filter((part) => part !== '');
        if (id === undefined) return null;
        if (method === 'POST' && suffixes.length === 1 && suffixes[0] === 'media') return 'container-create';
        if (method === 'POST' && suffixes.length === 1 && suffixes[0] === 'media_publish') return 'media-publish';
        if (method === 'GET' && id === 'ig_hashtag_search') return 'hashtag-search';
        if (method === 'GET' && suffixes.length === 1 && suffixes[0] === 'top_media') return 'hashtag-media';
        if (method === 'GET' && suffixes.length === 1 && suffixes[0] === 'media') return 'media-edge';
        if (method === 'GET' && suffixes.length === 1 && suffixes[0] === 'insights') {
          return mediaById.has(id) ? 'media-insights' : 'account-insights';
        }
        if (method === 'GET' && suffixes.length === 0) {
          const fields = url.searchParams.get('fields') ?? '';
          if (fields.includes('status_code')) return 'container-status';
          if (fields.includes('media_type') || fields.includes('caption')) return 'media-node';
          return 'user-node';
        }
        return null;
      };
      const endpoint = endpointOf(url.pathname, req.method ?? 'GET');
      if (endpoint === null) {
        reply(404, { error: 'not_found' });
        return;
      }

      requestCounts.set(endpoint, (requestCounts.get(endpoint) ?? 0) + 1);

      /** The bearer-token → account resolution (the provider resolves the account from the token). */
      const igUserIdOfToken = (): string | null => {
        if (bearer === null) return null;
        const bound = tokenAccounts.get(bearer[1]!);
        return bound ?? null;
      };

      /** The documented prelude: scripted failures, bearer validation, THE ACCOUNT-TYPE ENFORCEMENT. */
      const prelude = (): { ok: true; igUserId: string } | { ok: false; status: number; body: string; headers: Record<string, string> } => {
        const scriptedFailure = scripted.get(endpoint);
        if (scriptedFailure !== undefined) {
          const error = envelope(
            scriptedFailure.status,
            scriptedFailure.code,
            scriptedFailure.message,
            scriptedFailure.type ?? 'GraphMethodException',
            scriptedFailure.errorSubcode,
          );
          return {
            ok: false,
            status: error.status,
            body: error.body,
            headers:
              scriptedFailure.retryAfterSeconds !== undefined && scriptedFailure.retryAfterSeconds !== null
                ? {
                    'x-business-use-case-usage': JSON.stringify({
                      '17841400000000000': [
                        {
                          call_count: 100,
                          total_cputime: 8,
                          total_time: 6,
                          type: 'instagram',
                          estimated_time_to_regain_call_capacity: scriptedFailure.retryAfterSeconds,
                        },
                      ],
                    }),
                  }
                : {},
          };
        }
        if (bearer === null) {
          const error = envelope(400, 190, 'The access token is malformed or missing.', 'OAuthException');
          return { ok: false, status: error.status, body: error.body, headers: {} };
        }
        const igUserId = igUserIdOfToken();
        if (igUserId === null) {
          const error = envelope(400, 190, 'The access token does not resolve to an Instagram account.', 'OAuthException');
          return { ok: false, status: error.status, body: error.body, headers: {} };
        }
        // THE ACCOUNT-TYPE ENFORCEMENT (the MKT-058 AC): the documented
        // surface serves Business/Creator accounts ONLY — a personal
        // account answers the provider's OWN documented error semantics
        // (error code 10, '(#10) The user is not an Instagram Business',
        // type OAuthException — the documented eligibility answer) on
        // EVERY documented endpoint: never a fabricated success.
        if (accountOf(igUserId).accountType === 'PERSONAL') {
          const error = envelope(
            400,
            10,
            '(#10) The user is not an Instagram Business',
            'OAuthException',
          );
          return { ok: false, status: error.status, body: error.body, headers: {} };
        }
        return { ok: true, igUserId };
      };

      const pathParts = url.pathname.split('/').filter((part) => part !== '');
      const pathId = pathParts[0] ?? '';

      // ------------------------------------------------------------------
      // GET /{ig-user-id} — the IG User node (identity + profile).
      // ------------------------------------------------------------------
      if (endpoint === 'user-node') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const account = accountOf(gate.igUserId);
        const fields = (url.searchParams.get('fields') ?? '').split(',').filter((f) => f !== '');
        const node: Record<string, unknown> = { id: account.igUserId };
        for (const field of fields) {
          if (field === 'username') node['username'] = account.username;
          else if (field === 'account_type') node['account_type'] = account.accountType;
          else if (field === 'followers_count') node['followers_count'] = account.followersCount;
          else if (field === 'media_count') node['media_count'] = account.mediaCount;
          else if (field === 'profile_picture_url') node['profile_picture_url'] = account.profilePictureUrl;
        }
        reply(200, node);
        return;
      }

      // ------------------------------------------------------------------
      // GET /{ig-user-id}/media — the own-content listing (paged).
      // ------------------------------------------------------------------
      if (endpoint === 'media-edge') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const account = accountOf(pathId);
        const fields = url.searchParams.get('fields') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? '25');
        const after = url.searchParams.get('after');
        const all = mediaOf(account.igUserId);
        const pageTwo = after === 'ig-page-2';
        const slice = pageTwo ? all.slice(2) : all.slice(0, Math.max(limit, 1));
        const mediaNode = (media: InstagramDoubleMedia): Record<string, unknown> => {
          const node: Record<string, unknown> = { id: media.mediaId };
          if (fields.includes('caption')) node['caption'] = media.caption;
          if (fields.includes('media_type')) node['media_type'] = media.mediaType;
          if (fields.includes('media_url')) node['media_url'] = media.mediaUrl;
          if (fields.includes('permalink')) node['permalink'] = media.permalink;
          if (fields.includes('thumbnail_url')) node['thumbnail_url'] = media.mediaUrl;
          if (fields.includes('timestamp')) node['timestamp'] = media.timestamp;
          if (fields.includes('username')) node['username'] = account.username;
          if (fields.includes('like_count')) node['like_count'] = media.likeCount;
          if (fields.includes('comments_count')) node['comments_count'] = media.commentsCount;
          return node;
        };
        reply(200, {
          data: slice.map(mediaNode),
          paging: {
            cursors: { after: 'ig-page-2' },
            next: !pageTwo && all.length > Math.max(limit, 1) ? `${url.origin}${url.pathname}?after=ig-page-2` : null,
          },
        });
        return;
      }

      // ------------------------------------------------------------------
      // GET /{media-id} — the single-content read (the Media node).
      // ------------------------------------------------------------------
      if (endpoint === 'media-node') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const media = mediaById.get(pathId);
        if (media === undefined) {
          // The documented node-read answer for an unknown id: the
          // code-100 error envelope (the node surface has NO
          // empty-list semantics).
          const error = envelope(
            400,
            100,
            'Unsupported get request. Object does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com',
            'GraphMethodException',
            33,
          );
          reply(error.status, error.body);
          return;
        }
        const fields = url.searchParams.get('fields') ?? '';
        const account = accountOf(media.igUserId);
        const node: Record<string, unknown> = { id: media.mediaId };
        if (fields.includes('caption')) node['caption'] = media.caption;
        if (fields.includes('media_type')) node['media_type'] = media.mediaType;
        if (fields.includes('media_url')) node['media_url'] = media.mediaUrl;
        if (fields.includes('permalink')) node['permalink'] = media.permalink;
        if (fields.includes('thumbnail_url')) node['thumbnail_url'] = media.mediaUrl;
        if (fields.includes('timestamp')) node['timestamp'] = media.timestamp;
        if (fields.includes('username')) node['username'] = account.username;
        if (fields.includes('like_count')) node['like_count'] = media.likeCount;
        if (fields.includes('comments_count')) node['comments_count'] = media.commentsCount;
        reply(200, node);
        return;
      }

      // ------------------------------------------------------------------
      // GET /ig_hashtag_search — the documented hashtag lookup (the
      // 30-unique-hashtag rolling 7-day window per account).
      // ------------------------------------------------------------------
      if (endpoint === 'hashtag-search') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const query = url.searchParams.get('q') ?? '';
        const slug = query.replace(/\W+/g, '').slice(0, 30);
        const queried = hashtagWindow.get(gate.igUserId) ?? [];
        if (!queried.includes(slug)) {
          if (queried.length >= hashtagWindowLimit) {
            // A NEW unique hashtag beyond the documented window: the
            // request-limit error class (the documented hashtag rate
            // surface).
            const error = envelope(
              400,
              4,
              `(#4) The app user has already queried ${hashtagWindowLimit} unique hashtags within the 7-day period — the documented hashtag search rate limit`,
              'OAuthException',
            );
            reply(error.status, error.body);
            return;
          }
          hashtagWindow.set(gate.igUserId, [...queried, slug]);
        }
        const hashtagId = `ig-hashtag-${slug}`;
        hashtagIds.set(`${gate.igUserId}:${slug}`, hashtagId);
        reply(200, { data: [{ id: hashtagId, name: `#${slug}` }] });
        return;
      }

      // ------------------------------------------------------------------
      // GET /{hashtag-id}/top_media — the hashtag-scoped public pages.
      // ------------------------------------------------------------------
      if (endpoint === 'hashtag-media') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const slug = pathId.replace(/^ig-hashtag-/, '');
        const limit = Number(url.searchParams.get('limit') ?? '25');
        const after = url.searchParams.get('after');
        const pageTwo = after === 'ig-page-2';
        const fields = url.searchParams.get('fields') ?? '';
        const all = [0, 1, 2].map((index) => hashtagMediaOf(slug, index));
        const slice = pageTwo ? all.slice(2) : all.slice(0, Math.max(limit, 1));
        const mediaNode = (media: InstagramDoubleHashtagMedia): Record<string, unknown> => {
          const node: Record<string, unknown> = { id: media.mediaId };
          if (fields.includes('caption')) node['caption'] = media.caption;
          if (fields.includes('media_type')) node['media_type'] = 'IMAGE';
          if (fields.includes('media_url')) node['media_url'] = `https://cdn.example/hashtag/${media.mediaId}.jpg`;
          if (fields.includes('permalink')) node['permalink'] = `https://www.instagram.com/p/${media.mediaId}/`;
          if (fields.includes('timestamp')) node['timestamp'] = media.timestamp;
          if (fields.includes('like_count')) node['like_count'] = media.likeCount;
          if (fields.includes('comments_count')) node['comments_count'] = media.commentsCount;
          return node;
        };
        reply(200, {
          data: slice.map(mediaNode),
          paging: {
            cursors: { after: 'ig-page-2' },
            next: !pageTwo && all.length > Math.max(limit, 1) ? `${url.origin}${url.pathname}?after=ig-page-2` : null,
          },
        });
        return;
      }

      // ------------------------------------------------------------------
      // GET /{ig-user-id}/insights — the day-period account insights.
      // ------------------------------------------------------------------
      if (endpoint === 'account-insights') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const metrics = (url.searchParams.get('metric') ?? '').split(',').filter((m) => m !== '');
        for (const metric of metrics) {
          if (!ACCOUNT_INSIGHT_METRICS.includes(metric)) {
            const error = envelope(
              400,
              100,
              `(#100) The metric '${metric}' is not a documented day-period account insight metric`,
              'GraphMethodException',
            );
            reply(error.status, error.body);
            return;
          }
        }
        const account = accountOf(gate.igUserId);
        const facts: Record<string, number> = {
          follower_count: 42,
          impressions: 12345,
          profile_views: 77,
          reach: 9000,
        };
        void account;
        // The documented day-period slices: values[] with value +
        // end_time (three day slices, the most recent first is not
        // guaranteed — the provider's own ordering rides verbatim).
        const endTimes = ['2026-08-05T00:00:00.000Z', '2026-08-04T00:00:00.000Z', '2026-08-03T00:00:00.000Z'];
        reply(200, {
          data: metrics.map((metric) => ({
            name: metric,
            period: 'day',
            title: metric,
            values: endTimes.map((end_time) => ({ value: facts[metric] ?? 0, end_time })),
          })),
        });
        return;
      }

      // ------------------------------------------------------------------
      // GET /{media-id}/insights — the per-type lifetime media insights.
      // ------------------------------------------------------------------
      if (endpoint === 'media-insights') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const media = mediaById.get(pathId);
        if (media === undefined) {
          const error = envelope(
            400,
            100,
            'Unsupported get request. Object does not exist, cannot be loaded due to missing permissions, or does not support this operation.',
            'GraphMethodException',
            33,
          );
          reply(error.status, error.body);
          return;
        }
        const metrics = (url.searchParams.get('metric') ?? '').split(',').filter((m) => m !== '');
        const documented = MEDIA_INSIGHT_METRICS[media.mediaType] ?? [];
        for (const metric of metrics) {
          if (!documented.includes(metric)) {
            // The documented validation: requesting a metric the media
            // type does not support errors with the code-100 family.
            const error = envelope(
              400,
              100,
              `(#100) The metric '${metric}' is not supported for the media type '${media.mediaType}'`,
              'GraphMethodException',
            );
            reply(error.status, error.body);
            return;
          }
        }
        reply(200, {
          data: metrics.map((metric) => ({
            name: metric,
            period: 'lifetime',
            title: metric,
            values: [{ value: media.insights[metric] ?? 0 }],
          })),
        });
        return;
      }

      // ------------------------------------------------------------------
      // POST /{ig-user-id}/media — the container creation (step one of
      // the documented two-step publish).
      // ------------------------------------------------------------------
      if (endpoint === 'container-create') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const params: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(bodyText).entries()) {
          params[key] = value;
        }
        if ((params['image_url'] ?? '') === '' && (params['video_url'] ?? '') === '' && (params['children'] ?? '') === '') {
          // The documented provider-side source validation: a container
          // creation without a media source answers the code-100
          // invalid-parameter family (the PROCESSED refusal).
          const error = envelope(
            400,
            100,
            '(#100) The media container creation request carries no media source — an image_url, video_url, or children parameter is required',
            'GraphMethodException',
          );
          reply(error.status, error.body);
          return;
        }
        containerSequence += 1;
        const containerId = `ig-container-${containerSequence}`;
        containersById.set(containerId, {
          containerId,
          igUserId: gate.igUserId,
          state: 'IN_PROGRESS',
          mediaId: null,
          params,
          statusText: null,
        });
        // The documented creation answer: { id: container-id }.
        reply(200, { id: containerId });
        return;
      }

      // ------------------------------------------------------------------
      // POST /{ig-user-id}/media_publish — the publish (step two of the
      // documented two-step publish, gated on the FINISHED container).
      // ------------------------------------------------------------------
      if (endpoint === 'media-publish') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const creationId = new URLSearchParams(bodyText).get('creation_id') ?? '';
        const container = containersById.get(creationId);
        if (container === undefined) {
          const error = envelope(
            400,
            100,
            '(#100) The specified creation_id does not reference a media container',
            'GraphMethodException',
          );
          reply(error.status, error.body);
          return;
        }
        if (container.state === 'IN_PROGRESS') {
          // The documented flow: publishing before the container
          // finishes processing errors (the invalid-parameter family —
          // the wait is not optional).
          const error = envelope(
            400,
            100,
            '(#100) The media container is still processing — the publish step requires the container status_code to be FINISHED',
            'GraphMethodException',
          );
          reply(error.status, error.body);
          return;
        }
        if (container.state === 'EXPIRED' || container.state === 'ERROR') {
          const error = envelope(
            400,
            100,
            `(#100) The media container cannot be published (status_code=${container.state}) — a fresh container is required`,
            'GraphMethodException',
          );
          reply(error.status, error.body);
          return;
        }
        if (container.state === 'PUBLISHED' && container.mediaId !== null) {
          // Already published: the creation_id answers the SAME media id
          // (the at-most-once identity toward the provider).
          reply(200, { id: container.mediaId });
          return;
        }
        // The documented 24-hour publish window (content_publishing_limit
        // quota_total): enforced at the account level on the publish step.
        const published = publishedCounts.get(gate.igUserId) ?? 0;
        if (published >= dailyPublishLimit) {
          const error = envelope(
            400,
            4,
            '(#4) You have reached the maximum number of posts you can publish in a 24-hour period — the Instagram Graph API content publishing limit',
            'OAuthException',
          );
          reply(error.status, error.body);
          return;
        }
        publishedCounts.set(gate.igUserId, published + 1);
        const mediaId = `ig-media-published-${container.containerId}`;
        container.state = 'PUBLISHED';
        container.mediaId = mediaId;
        // The published media joins the account's media surface (the
        // documented post-publish view — the content reads observe it).
        const media: InstagramDoubleMedia = {
          mediaId,
          igUserId: gate.igUserId,
          caption: container.params['caption'] ?? '',
          mediaType: (container.params['media_type'] === 'REELS' ? 'VIDEO' : container.params['video_url'] !== undefined ? 'VIDEO' : 'IMAGE'),
          mediaUrl: container.params['image_url'] ?? container.params['video_url'] ?? '',
          permalink: `https://www.instagram.com/p/published-${container.containerId}/`,
          timestamp: '2026-08-02T12:00:00.000Z',
          likeCount: 0,
          commentsCount: 0,
          insights: {},
        };
        mediaById.set(mediaId, media);
        mediaByAccount.set(gate.igUserId, [...mediaOf(gate.igUserId), media]);
        // The documented publish answer: { id: media-id }.
        reply(200, { id: mediaId });
        return;
      }

      // ------------------------------------------------------------------
      // GET /{container-id}?fields=status_code — the container status.
      // ------------------------------------------------------------------
      if (endpoint === 'container-status') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const container = containersById.get(pathId);
        if (container === undefined) {
          const error = envelope(
            400,
            100,
            'Unsupported get request. Object does not exist, cannot be loaded due to missing permissions, or does not support this operation.',
            'GraphMethodException',
            33,
          );
          reply(error.status, error.body);
          return;
        }
        const statusTexts: Readonly<Record<ContainerState, string>> = {
          IN_PROGRESS: 'Media is still being processed.',
          FINISHED: 'Media is ready to be published.',
          PUBLISHED: 'The media has been published.',
          EXPIRED: 'The media was not published within 24 hours.',
          ERROR: 'The container failed to complete.',
        };
        reply(200, {
          id: container.containerId,
          status_code: container.state,
          status: container.statusText ?? statusTexts[container.state],
        });
        return;
      }

      reply(404, { error: 'not_found' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const serverUrl = `http://127.0.0.1:${address.port}`;
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
          const authorizationCode = `sandbox-ig-code-${randomUUID()}`;
          const refreshToken = `sandbox-ig-rt-${randomUUID()}`;
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
        registerAccount(input) {
          accounts.set(input.igUserId, {
            ...defaultAccountOf(input.igUserId),
            accountType: input.accountType,
          });
          // The account's media fixtures materialize with the account.
          mediaOf(input.igUserId);
        },
        setDailyPublishLimit(limit) {
          dailyPublishLimit = limit;
        },
        publishedCount(igUserId) {
          return publishedCounts.get(igUserId) ?? 0;
        },
        resetPublishWindow() {
          publishedCounts.clear();
        },
        setHashtagWindowLimit(limit) {
          hashtagWindowLimit = limit;
        },
        queriedHashtags(igUserId) {
          return [...(hashtagWindow.get(igUserId) ?? [])];
        },
        resetHashtagWindow() {
          hashtagWindow.clear();
        },
        scriptFailure(endpoint, failure) {
          if (failure === null) {
            scripted.delete(endpoint);
          } else {
            scripted.set(endpoint, failure);
          }
        },
        advanceContainer(containerId, state, patch) {
          const container = containersById.get(containerId);
          if (container === undefined) return;
          container.state = state;
          container.statusText = patch?.statusText ?? null;
        },
        containers() {
          return [...containersById.values()];
        },
        lastAppUsageHeader() {
          return lastAppUsage;
        },
        mediaOf(igUserId) {
          return [...mediaOf(igUserId)];
        },
      });
    });
  });
}
