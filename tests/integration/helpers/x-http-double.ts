/**
 * MKT-061 integration-test harness — the COMBINED X (TWITTER) PROVIDER
 * DOUBLE: ONE in-process loopback HTTP server standing in for the
 * provider (NO external network — not callable from the sandbox and
 * deliberately not attempted), serving THREE provider planes exactly
 * like the single provider identity behind the documented X platform
 * (the MKT-057..060 combined-double pattern):
 *
 *   1. the CANONICAL local OAuth token plane (the provider-neutral
 *      fixture protocol of tests/integration/helpers/oauth-provider.ts:
 *      the JSON token endpoint + the revocation endpoint + the
 *      resource-owner fixture endpoint minting authorization codes) —
 *      the double implements the LocalOAuthProvider interface so it
 *      serves as the conformance suite's `provider` argument and the
 *      createLocalOAuthFlow backend (the capability-subset battery's
 *      'x-narrow' connections);
 *
 *   2. the X-SHAPED OAuth 2.0 token plane — the DOCUMENTED form of the
 *      X OAuth 2.0 Authorization Code Flow with PKCE
 *      (https://docs.x.com/x-api/fundamentals/authentication/oauth-2-0/authorization-code):
 *      POST /2/oauth2/token with application/x-www-form-urlencoded
 *      bodies (grant_type=authorization_code + code + code_verifier +
 *      client_id + redirect_uri — the PKCE verifier VERIFIED against
 *      the S256 code_challenge bound at issue time; grant_type=
 *      refresh_token + refresh_token + client_id), answering the
 *      documented token envelope { token_type: 'bearer', expires_in,
 *      access_token, scope, refresh_token }. The documented X surface
 *      carries NO user-token revocation endpoint (verified at delivery
 *      time — the resource owner revokes access through the X app
 *      settings), so this plane serves NO revoke route and the X flow
 *      double makes NO provider call on revocation (ZERO-traffic
 *      revoke, asserted);
 *
 *   3. the X API v2 plane — a faithful mirror of the DOCUMENTED
 *      endpoints the real adapter
 *      (src/modules/social-accounts/internal/adapters/x/adapter.ts)
 *      calls, on the SAME origin (the connection's providerConfig
 *      .apiBaseUrl points here — the documented deployment override of
 *      the https://api.x.com host; the platform HttpCallPort permits
 *      loopback http for exactly this test shape):
 *        GET  /2/users/me?user.fields=...        (the authorized user)
 *        GET  /2/tweets/search/recent?query=...  (the recent search,
 *                                                next_token pagination)
 *        GET  /2/users/{id}/tweets?...           (the user timeline,
 *                                                pagination_token)
 *        GET  /2/tweets/{id}?post.fields=...     (the single-Post read;
 *                                                unknown → the documented
 *                                                404 resource-not-found)
 *        GET  /2/tweets/analytics?ids=...        (the windowed analytics
 *                                                rows, labels verbatim)
 *        POST /2/media/upload/initialize         (the JSON INIT)
 *        POST /2/media/upload/{id}/append        (the JSON APPEND — the
 *                                                base64 media chunk,
 *                                                byte-exact reassembly)
 *        POST /2/media/upload/{id}/finalize      (the FINALIZE + the
 *                                                processing_info window)
 *        GET  /2/media/upload?command=STATUS&media_id=... (the poll)
 *        POST /2/tweets                          (the synchronous
 *                                                creation, 201)
 *        GET  /assets/{key}                      (the media byte-source
 *                                                asset server — HTTP
 *                                                Range capable, the
 *                                                disclosed adapter byte
 *                                                path)
 *
 * Documented-semantics fidelity (the surfaces the double enforces —
 * every behavior below mirrors the LIVE docs.x.com documentation
 * verified at delivery time; see docs/runbooks/MKT-061.md §2):
 *   - THE ERROR MODEL: the documented RFC 7807 problem envelope
 *     { title, detail, type, status } (the response-codes reference)
 *     with the documented problem types (invalid-request,
 *     resource-not-found, client-forbidden, rate-limit-exceeded,
 *     usage-capped) mapped onto the frozen taxonomy by the adapter;
 *   - THE RATE MODEL: the documented x-rate-limit-limit /
 *     x-rate-limit-remaining / x-rate-limit-reset response headers ride
 *     EVERY API answer (the rate-limits reference: "Response headers
 *     show your current rate limit status"); the documented per-user
 *     windows (users/me 75/15min; search 450/15min... the double models
 *     the documented table with scriptable budgets) exhaust into the
 *     documented 429 + the observable Retry-After;
 *   - THE SCOPE MODEL: every endpoint enforces its documented security
 *     requirement (users/me: users.read + tweet.read; the post reads +
 *     the timelines + the search + the analytics: tweet.read +
 *     users.read; the media endpoints: media.write; POST /2/tweets:
 *     tweet.read + tweet.write + users.read) — a token without the
 *     scope answers the documented 401 class;
 *   - THE POST LOOKUP: an unknown Post id answers the documented 404
 *     resource-not-found problem ("Could not find post with id: [...]")
 *     — the honest null record path of the single-content read;
 *   - THE PARTIAL-ERROR MODEL: the documented 200-with-errors shape;
 *   - THE MEDIA FLOW: the documented v2 chunked protocol (the JSON INIT
 *     with media_type/total_bytes/media_category; the JSON APPEND with
 *     the base64 media chunk + segment_index — the segments are
 *     reassembled BYTE-EXACTLY and compared against the registered
 *     asset; the FINALIZE with the processing_info window; the STATUS
 *     poll with the documented check_after_secs cadence) with the
 *     documented media-category size caps enforced as provider answers
 *     (tweet_image 5 MB / tweet_gif 15 MB — the provider-stated limit
 *     class surfacing battery) and the documented per-Post media bound
 *     (media_ids maxItems 4) enforced at creation;
 *   - THE CREATION: the documented synchronous POST /2/tweets (201 +
 *     { data: { id, text } }; text or media required; the created post
 *     joins the timeline);
 *   - THE ENTITLEMENT REFUSAL: the documented 403 Forbidden example of
 *     the chunked quickstart ("This user is not allowed to post a video
 *     longer than 20 minutes." — the posting-user entitlement class),
 *     scriptable per account;
 *   - per-endpoint FAILURE INJECTION (the documented problem shapes).
 *
 * Scriptable/observation surface (in-process control — the test owns
 * the server object): per-endpoint failure scripting, the fixture
 * accounts (registerAccount with the protected/verified_type/
 * subscription_type facts), the per-endpoint rate budgets + request
 * counts (the inertness/zero-traffic assertions), the registered media
 * assets (registerMedia — Range-capable or deliberately Range-ignoring
 * for the honest-refusal battery), the next-upload processing plan
 * (none / auto / stuck / failed — the bounded processing-poll battery),
 * the byte-exact reassembled uploads, the recorded post creations, the
 * X-shaped authorization fixtures (issueXAuthorization with the S256
 * code_challenge) and the X token-plane call counts (the ZERO-revoke
 * assertion).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LocalOAuthMode, LocalOAuthProvider } from './oauth-provider.ts';
import type {
  SocialAccountFlowCallContext,
  SocialAccountFlowExchangeOutcome,
  SocialAccountFlowImplementation,
} from '../../../src/modules/social-accounts/public.ts';

// ---------------------------------------------------------------------------
// The fixture data model (the documented resource shapes)
// ---------------------------------------------------------------------------

/** The fixture X account of a bound OAuth identity. */
export interface XDoubleAccount {
  readonly accountId: string;
  /** The documented protected flag (the account's own private-posts state). */
  readonly isProtected: boolean;
  /** The documented verified_type label (none/blue/business/government). */
  readonly verifiedType: string;
  /** The documented X Blue subscription_type label (None/Basic/Premium/PremiumPlus). */
  readonly subscriptionType: string;
  /** The scriptable documented entitlement refusal (the 403 video-cap class). */
  readonly videoDurationCapped: boolean;
}

/** The per-endpoint scripted failure (the documented RFC 7807 problem shape). */
export interface XScriptedFailure {
  /** The HTTP status of the documented answer (the documented norm: 400/401/403/404/429/5xx). */
  readonly status: number;
  /** The documented problem title (e.g. 'Unauthorized', 'Forbidden', 'Not Found Error', 'Too Many Requests'). */
  readonly title: string;
  /** The documented problem detail. */
  readonly detail: string;
  /** The documented problem type URI (e.g. https://api.x.com/2/problems/invalid-request). */
  readonly type: string;
  /** The observable backoff seconds (rides the Retry-After header — read opportunistically by the adapter). */
  readonly retryAfterSeconds?: number | null;
}

export type XDoubleEndpoint =
  | 'users-me'
  | 'search-recent'
  | 'user-timeline'
  | 'post-lookup'
  | 'tweets-analytics'
  | 'media-init'
  | 'media-append'
  | 'media-finalize'
  | 'media-status'
  | 'tweets-create';

/** The processing plan of the NEXT media upload (the bounded processing-poll battery). */
export type XMediaProcessingPlan = 'none' | 'auto' | 'stuck' | 'failed';

/** The recorded media upload (the documented chunked flow, byte-exact reassembly). */
export interface XDoubleMediaUpload {
  readonly mediaId: string;
  readonly mediaType: string;
  readonly mediaCategory: string;
  readonly totalBytes: number;
  readonly segmentCount: number;
  /** The byte-exact reassembled upload content (the ASCII fixture round-trip). */
  readonly reassembled: string;
  /** True iff the reassembled bytes match a registered asset's content exactly. */
  readonly matchesAsset: boolean;
  readonly processingState: 'succeeded' | 'pending' | 'in_progress' | 'failed';
}

/** The internal mutable upload record (the processing plan + the observed poll count). */
interface XDoubleMediaUploadRecord {
  mediaId: string;
  mediaType: string;
  mediaCategory: string;
  totalBytes: number;
  segmentCount: number;
  reassembled: string;
  matchesAsset: boolean;
  processingState: 'succeeded' | 'pending' | 'in_progress' | 'failed';
  plan: XMediaProcessingPlan;
  polls: number;
}

/** The recorded post creation (the documented synchronous surface). */
export interface XDoublePostCreation {
  readonly postId: string;
  readonly accountId: string;
  readonly text: string;
  readonly mediaIds: readonly string[];
  readonly body: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** The X-shaped authorization fixture (the documented PKCE binding). */
export interface IssuedXAuthorization {
  readonly code: string;
  readonly accountId: string;
  readonly scopes: readonly string[];
}

export interface XProviderDouble extends LocalOAuthProvider {
  /** The number of API-plane requests received per endpoint (the zero-traffic assertions). */
  requestCount(endpoint: XDoubleEndpoint): number;
  /** The total number of API-plane requests received. */
  totalRequestCount(): number;
  /** The number of X-SHAPED token-plane calls received (the PKCE battery + the ZERO-revoke assertion). */
  xTokenEndpointCount(): number;
  /** Registers (or replaces) a fixture X account. */
  registerAccount(input: {
    readonly accountId: string;
    readonly isProtected?: boolean;
    readonly verifiedType?: string;
    readonly subscriptionType?: string;
    readonly videoDurationCapped?: boolean;
  }): void;
  /** Scripts a documented problem envelope on an endpoint (null clears). */
  scriptFailure(endpoint: XDoubleEndpoint, failure: XScriptedFailure | null): void;
  /** Replaces a per-endpoint rate budget (the documented rate accounting; the exhaustion battery). */
  setRateBudget(endpoint: XDoubleEndpoint, budget: number): void;
  /** Resets the rate windows. */
  resetRateWindows(): void;
  /**
   * Registers a media byte-source asset under /assets/{key} (the
   * disclosed adapter byte path): serveRanges=true answers the
   * documented 206 Partial Content + Content-Range; serveRanges=false
   * deliberately ignores Range requests (the honest-refusal battery).
   */
  registerMedia(input: {
    readonly key: string;
    readonly content: string;
    readonly serveRanges?: boolean;
  }): void;
  /** The processing plan of the NEXT media upload (consumed at INIT; default: by media_category — tweet_video/tweet_gif process, tweet_image does not). */
  setNextMediaProcessingPlan(plan: XMediaProcessingPlan | null): void;
  /** The recorded media uploads (the byte-exact reassembly observations). */
  mediaUploads(): readonly XDoubleMediaUpload[];
  /** The recorded post creations. */
  postCreations(): readonly XDoublePostCreation[];
  /** The number of asset-byte-source requests received (the byte-path observations). */
  assetRequestCount(): number;
  /**
   * Mints an X-shaped authorization code bound to an external account
   * identity, a VERBATIM scope list and the S256 code_challenge of the
   * documented PKCE flow (the /2/oauth2/token exchange verifies the
   * code_verifier against it).
   */
  issueXAuthorization(input: {
    readonly accountId: string;
    readonly scopes: readonly string[];
    readonly codeChallenge: string;
  }): IssuedXAuthorization;
  /** Marks a created post as deleted (the documented 404 semantics of the post lookup). */
  deletePost(postId: string): void;
}

// ---------------------------------------------------------------------------
// The documented fixtures
// ---------------------------------------------------------------------------

/** The documented per-user rate windows (the rate-limits reference table — scriptable budgets). */
const DEFAULT_RATE_BUDGETS: Readonly<Record<XDoubleEndpoint, number>> = {
  'users-me': 75,
  'search-recent': 450,
  'user-timeline': 900,
  'post-lookup': 900,
  'tweets-analytics': 300,
  'media-init': 1_875,
  'media-append': 1_875,
  'media-finalize': 1_875,
  'media-status': 1_000,
  'tweets-create': 100,
};

/** The documented media-category size caps (the media introduction table: tweet_image 5 MB, tweet_gif 15 MB — the provider-stated limit class). */
const MEDIA_CATEGORY_SIZE_CAPS: Readonly<Record<string, number>> = {
  tweet_image: 5 * 1024 * 1024,
  tweet_gif: 15 * 1024 * 1024,
  tweet_video: 8 * 1024 * 1024 * 1024,
  amplify_video: 8 * 1024 * 1024 * 1024,
};

/** The documented media_type enum (the InitializeMediaUploadRequest schema). */
const DOCUMENTED_MEDIA_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/mp2t',
  'video/quicktime',
  'text/srt',
  'text/vtt',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/png',
  'image/webp',
  'image/pjpeg',
  'image/tiff',
  'model/gltf-binary',
  'model/vnd.usdz+zip',
]);

/** The documented analytics.fields vocabulary (the AnalyticsFieldsParameter enum). */
const DOCUMENTED_ANALYTICS_FIELDS = new Set([
  'app_install_attempts',
  'app_opens',
  'bookmarks',
  'detail_expands',
  'email_tweet',
  'engagements',
  'follows',
  'hashtag_clicks',
  'impressions',
  'likes',
  'media_views',
  'permalink_clicks',
  'quote_tweets',
  'replies',
  'retweets',
  'shares',
  'timestamp',
  'timestamped_metrics',
  'unfollows',
  'unlikes',
  'url_clicks',
  'user_profile_clicks',
]);

const USER_FIELD_SET = new Set([
  'id',
  'name',
  'username',
  'created_at',
  'description',
  'location',
  'profile_image_url',
  'protected',
  'verified',
  'verified_type',
  'subscription_type',
  'public_metrics',
]);

const POST_FIELD_SET = new Set(['id', 'created_at', 'text', 'author_id', 'public_metrics']);

/** The fixture User object of an account (the documented User shape). */
function userOf(account: XDoubleAccount): Record<string, unknown> {
  return {
    id: account.accountId,
    name: `Fixture X User ${account.accountId}`,
    username: `double_${account.accountId.replaceAll('-', '_')}`,
    created_at: '2026-05-17T09:30:00.000Z',
    description: 'The documented description of the fixture X user',
    location: 'Accra, Ghana',
    profile_image_url: `https://pbs.twimg.com/profile_images/double-${account.accountId}_normal.png`,
    protected: account.isProtected,
    verified: account.verifiedType !== 'none',
    verified_type: account.verifiedType,
    subscription_type: account.subscriptionType,
    public_metrics: {
      followers_count: 8_452,
      following_count: 317,
      post_count: 1_284,
      listed_count: 26,
      like_count: 12_907,
      media_count: 341,
    },
  };
}

/** The fixture Posts of an account (newest first — the documented timeline ordering). */
function postsOf(account: XDoubleAccount) {
  return [1, 2, 3].map((index) => ({
    id: `x-post-${account.accountId}-${index}`,
    created_at: `2026-08-0${4 - index}T10:00:00.000Z`,
    text: `Fixture X post ${index} of ${account.accountId}`,
    author_id: account.accountId,
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

// ---------------------------------------------------------------------------
// The canonical OAuth fixture protocol (the oauth-provider.ts protocol)
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

/** The X-shaped authorization fixture (the PKCE binding). */
interface XAuthorizationFixture {
  readonly accountId: string;
  readonly scopes: readonly string[];
  readonly codeChallenge: string;
  readonly authorizationCode: string;
  readonly refreshToken: string;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/** Boots the COMBINED X provider double (canonical OAuth plane + X-shaped PKCE plane + documented API plane + asset byte source, one loopback origin). */
export function startXProviderDouble(): Promise<XProviderDouble> {
  const authorizations = new Map<string, AuthorizationFixture>();
  const refreshTokens = new Map<string, AuthorizationFixture>();
  const xAuthorizations = new Map<string, XAuthorizationFixture>();
  const xRefreshTokens = new Map<string, XAuthorizationFixture>();
  /** The token → bound identity + granted scopes binding (minted at exchange time, BOTH planes). */
  const tokenAccounts = new Map<string, { accountId: string; scopes: readonly string[] }>();
  const accounts = new Map<string, XDoubleAccount>();
  const scripted = new Map<XDoubleEndpoint, XScriptedFailure>();
  const requestCounts = new Map<XDoubleEndpoint, number>();
  const rateConsumedMap = new Map<string, number>();
  const rateBudgets = new Map<XDoubleEndpoint, number>(
    Object.entries(DEFAULT_RATE_BUDGETS) as [XDoubleEndpoint, number][],
  );
  const mediaAssets = new Map<string, { content: string; serveRanges: boolean }>();
  const mediaUploads: XDoubleMediaUploadRecord[] = [];
  const postCreations: XDoublePostCreation[] = [];
  const createdPostsByAccount = new Map<string, { post: Record<string, unknown>; accountId: string }>();
  const deletedPosts = new Set<string>();
  let nextMediaProcessingPlan: XMediaProcessingPlan | null = null;
  let assetRequests = 0;
  let xTokenCalls = 0;
  let mode: LocalOAuthMode = 'ok';
  let exchanges = 0;
  let revokes = 0;
  let mediaSequence = 0;
  let postSequence = 0;

  const accountOf = (accountId: string): XDoubleAccount =>
    accounts.get(accountId) ?? {
      accountId,
      isProtected: false,
      verifiedType: 'none',
      subscriptionType: 'None',
      videoDurationCapped: false,
    };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const reply = (
        status: number,
        payload: unknown,
        headers: Readonly<Record<string, string>> = {},
      ): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      /** The documented RFC 7807 problem answer. */
      const problem = (
        status: number,
        title: string,
        detail: string,
        type: string,
        extra: Readonly<Record<string, string>> = {},
      ): void => {
        reply(status, { title, detail, type, status }, extra);
      };

      // ------------------------------------------------------------------
      // The canonical local OAuth plane (the oauth-provider.ts protocol).
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
          if (fixture !== undefined) authorizations.delete(String(parsed['code'] ?? ''));
        } else if (grantType === 'refresh_token') {
          fixture = refreshTokens.get(String(parsed['refresh_token'] ?? ''));
        }
        if (fixture === undefined) {
          reply(400, { error: 'invalid_grant' });
          return;
        }
        const accessToken = `sandbox-x-at-${randomUUID()}`;
        const refreshToken = `sandbox-x-rt-${randomUUID()}`;
        const fresh: AuthorizationFixture = { ...fixture, refreshToken };
        refreshTokens.set(refreshToken, fresh);
        tokenAccounts.set(accessToken, { accountId: fixture.accountId, scopes: [...fixture.scopes] });
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
      // The X-shaped OAuth 2.0 token plane (the documented PKCE form).
      // ------------------------------------------------------------------
      if (req.method === 'POST' && url.pathname === '/2/oauth2/token') {
        xTokenCalls += 1;
        if (mode === 'garbage') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('<html>not json</html>');
          return;
        }
        const form = new URLSearchParams(bodyText);
        const grantType = form.get('grant_type') ?? '';
        if (grantType === 'authorization_code') {
          const code = form.get('code') ?? '';
          const codeVerifier = form.get('code_verifier') ?? '';
          const clientId = form.get('client_id') ?? '';
          if (clientId === '') {
            problem(400, 'Invalid Request', 'The client_id parameter is required.', 'https://api.x.com/2/problems/invalid-request');
            return;
          }
          const fixture = xAuthorizations.get(code);
          if (fixture === undefined) {
            problem(400, 'Unauthorized', 'The authorization code is invalid or has expired.', 'https://api.x.com/2/problems/oauth-2-unauthorized');
            return;
          }
          // The documented PKCE verification: S256(code_verifier) must
          // equal the code_challenge bound at issue time.
          const derived = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
          if (derived !== fixture.codeChallenge) {
            problem(400, 'Unauthorized', 'The code_verifier does not match the code_challenge of the authorization request.', 'https://api.x.com/2/problems/oauth-2-unauthorized');
            return;
          }
          xAuthorizations.delete(code);
          const accessToken = `sandbox-x2-at-${randomUUID()}`;
          const refreshToken = `sandbox-x2-rt-${randomUUID()}`;
          const fresh: XAuthorizationFixture = { ...fixture, refreshToken };
          xRefreshTokens.set(refreshToken, fresh);
          tokenAccounts.set(accessToken, { accountId: fixture.accountId, scopes: [...fixture.scopes] });
          reply(200, {
            token_type: 'bearer',
            expires_in: 7_200,
            access_token: accessToken,
            scope: fixture.scopes.join(' '),
            refresh_token: refreshToken,
          });
          return;
        }
        if (grantType === 'refresh_token') {
          const refreshToken = form.get('refresh_token') ?? '';
          const clientId = form.get('client_id') ?? '';
          if (clientId === '') {
            problem(400, 'Invalid Request', 'The client_id parameter is required.', 'https://api.x.com/2/problems/invalid-request');
            return;
          }
          const fixture = xRefreshTokens.get(refreshToken);
          if (fixture === undefined) {
            problem(400, 'Unauthorized', 'The refresh token is invalid or has expired.', 'https://api.x.com/2/problems/oauth-2-unauthorized');
            return;
          }
          const accessToken = `sandbox-x2-at-${randomUUID()}`;
          const nextRefresh = `sandbox-x2-rt-${randomUUID()}`;
          const fresh: XAuthorizationFixture = { ...fixture, refreshToken: nextRefresh };
          xRefreshTokens.set(nextRefresh, fresh);
          tokenAccounts.set(accessToken, { accountId: fixture.accountId, scopes: [...fixture.scopes] });
          reply(200, {
            token_type: 'bearer',
            expires_in: 7_200,
            access_token: accessToken,
            scope: fixture.scopes.join(' '),
            refresh_token: nextRefresh,
          });
          return;
        }
        problem(400, 'Invalid Request', `The grant_type '${grantType}' is not supported.`, 'https://api.x.com/2/problems/invalid-request');
        return;
      }

      // ------------------------------------------------------------------
      // The media byte-source asset plane (the disclosed adapter byte path).
      // ------------------------------------------------------------------
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        assetRequests += 1;
        const key = decodeURIComponent(url.pathname.slice('/assets/'.length));
        const asset = mediaAssets.get(key);
        if (asset === undefined) {
          problem(404, 'Not Found Error', `Could not find the media asset '${key}'.`, 'https://api.x.com/2/problems/resource-not-found');
          return;
        }
        const buffer = Buffer.from(asset.content, 'utf8');
        const rangeHeader = req.headers['range'];
        if (asset.serveRanges && typeof rangeHeader === 'string') {
          const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
          if (match !== null) {
            const start = Number(match[1]);
            const end = match[2] === '' ? buffer.length - 1 : Math.min(Number(match[2]), buffer.length - 1);
            if (start >= buffer.length || start > end) {
              res.writeHead(416, {
                'content-range': `bytes */${buffer.length}`,
                'content-type': 'application/octet-stream',
              });
              res.end();
              return;
            }
            const slice = buffer.subarray(start, end + 1);
            res.writeHead(206, {
              'content-type': 'application/octet-stream',
              'content-length': String(slice.length),
              'content-range': `bytes ${start}-${end}/${buffer.length}`,
              'accept-ranges': 'bytes',
            });
            res.end(slice);
            return;
          }
        }
        // No Range request (or the deliberately Range-ignoring asset):
        // the full body (only usable inside the bounded port envelope —
        // the honest-refusal battery rides the deliberately oversized
        // Range-ignoring asset).
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(buffer.length),
        });
        res.end(buffer);
        return;
      }

      // ------------------------------------------------------------------
      // The X API v2 plane (the documented endpoints).
      // ------------------------------------------------------------------
      const bearerHeader = req.headers['authorization'];
      const bearer = typeof bearerHeader === 'string' && bearerHeader.startsWith('Bearer ')
        ? bearerHeader.slice('Bearer '.length)
        : null;

      /** The endpoint gate: the scripted failure, the bearer validation, the documented scope requirements + the rate window (the x-rate-limit headers ride every answer). */
      const apiGate = (
        endpoint: XDoubleEndpoint,
        requiredScopes: readonly string[],
      ): { ok: true; accountId: string; scopes: readonly string[] } | { ok: false } => {
        const consumed = (rateConsumedMap.get(endpoint) ?? 0) + 1;
        rateConsumedMap.set(endpoint, consumed);
        requestCounts.set(endpoint, (requestCounts.get(endpoint) ?? 0) + 1);
        const budget = rateBudgets.get(endpoint) ?? DEFAULT_RATE_BUDGETS[endpoint];
        const rateHeaders = {
          'x-rate-limit-limit': String(budget),
          'x-rate-limit-remaining': String(Math.max(0, budget - consumed)),
          'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900),
        };
        const scriptedFailure = scripted.get(endpoint);
        if (scriptedFailure !== undefined) {
          problem(scriptedFailure.status, scriptedFailure.title, scriptedFailure.detail, scriptedFailure.type, {
            ...rateHeaders,
            ...(scriptedFailure.retryAfterSeconds !== undefined && scriptedFailure.retryAfterSeconds !== null
              ? { 'retry-after': String(scriptedFailure.retryAfterSeconds) }
              : {}),
          });
          return { ok: false };
        }
        if (bearer === null) {
          problem(
            401,
            'Unauthorized',
            'The access token is malformed or missing.',
            'https://api.x.com/2/problems/oauth-2-unauthorized',
            rateHeaders,
          );
          return { ok: false };
        }
        const bound = tokenAccounts.get(bearer);
        if (bound === undefined) {
          problem(
            401,
            'Unauthorized',
            'The access token is invalid or has expired.',
            'https://api.x.com/2/problems/oauth-2-unauthorized',
            rateHeaders,
          );
          return { ok: false };
        }
        const missing = requiredScopes.filter((scope) => !bound.scopes.includes(scope));
        if (missing.length > 0) {
          problem(
            401,
            'Unauthorized',
            `The access token does not bear the required scope(s): ${missing.join(', ')}.`,
            'https://api.x.com/2/problems/oauth-2-unauthorized',
            rateHeaders,
          );
          return { ok: false };
        }
        if (consumed > budget) {
          problem(
            429,
            'Too Many Requests',
            'Rate limit exceeded. The request has been blocked because the rate window is exhausted.',
            'https://api.x.com/2/problems/rate-limit-exceeded',
            { ...rateHeaders, 'x-rate-limit-remaining': '0', 'retry-after': '42' },
          );
          return { ok: false };
        }
        return { ok: true, accountId: bound.accountId, scopes: bound.scopes };
      };

      /** The rate headers of a successful answer (the documented observation surface). */
      const okRateHeaders = (endpoint: XDoubleEndpoint): Record<string, string> => {
        const budget = rateBudgets.get(endpoint) ?? DEFAULT_RATE_BUDGETS[endpoint];
        const consumed = rateConsumedMap.get(endpoint) ?? 0;
        return {
          'x-rate-limit-limit': String(budget),
          'x-rate-limit-remaining': String(Math.max(0, budget - consumed)),
          'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900),
        };
      };

      /** The documented post.fields validation (an undocumented field answers the 400 invalid-request problem). */
      const postFieldsProblem = (fields: readonly string[]): string | null => {
        for (const field of fields) {
          if (!POST_FIELD_SET.has(field)) {
            return `The post.fields value '${field}' is not a documented Post field.`;
          }
        }
        return null;
      };

      const projectUser = (account: XDoubleAccount, fields: readonly string[]): Record<string, unknown> => {
        const user = userOf(account);
        const projected: Record<string, unknown> = {};
        for (const field of fields) {
          if (field in user) projected[field] = (user as Record<string, unknown>)[field];
        }
        return projected;
      };

      const projectPost = (post: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> => {
        const projected: Record<string, unknown> = {};
        for (const field of fields) {
          if (field in post) projected[field] = post[field];
        }
        return projected;
      };

      // -- GET /2/users/me -------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/2/users/me') {
        const gate = apiGate('users-me', ['users.read', 'tweet.read']);
        if (!gate.ok) return;
        const fields = (url.searchParams.get('user.fields') ?? '')
          .split(',')
          .map((field) => field.trim())
          .filter((field) => field !== '');
        for (const field of fields) {
          if (!USER_FIELD_SET.has(field)) {
            problem(400, 'Invalid Request', `The user.fields value '${field}' is not a documented User field.`, 'https://api.x.com/2/problems/invalid-request');
            return;
          }
        }
        reply(200, { data: projectUser(accountOf(gate.accountId), fields.length > 0 ? fields : ['id']) }, okRateHeaders('users-me'));
        return;
      }

      // -- GET /2/tweets/search/recent -------------------------------------
      if (req.method === 'GET' && url.pathname === '/2/tweets/search/recent') {
        const gate = apiGate('search-recent', ['tweet.read', 'users.read']);
        if (!gate.ok) return;
        const query = url.searchParams.get('query') ?? '';
        if (query === '') {
          problem(400, 'Invalid Request', 'The query parameter is required.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        const maxResults = Number(url.searchParams.get('max_results') ?? '10');
        if (!Number.isInteger(maxResults) || maxResults < 10 || maxResults > 100) {
          problem(400, 'Invalid Request', 'The max_results parameter must be between 10 and 100.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        const nextToken = url.searchParams.get('next_token');
        const fields = (url.searchParams.get('post.fields') ?? '')
          .split(',')
          .map((field) => field.trim())
          .filter((field) => field !== '');
        const fieldsProblem = postFieldsProblem(fields);
        if (fieldsProblem !== null) {
          problem(400, 'Invalid Request', fieldsProblem, 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        // The fixture search corpus: four query-matching posts over two
        // pages (the documented next_token pagination).
        const corpus = [1, 2, 3, 4].map((index) => ({
          id: `x-search-${index}`,
          created_at: `2026-08-01T1${index}:00:00.000Z`,
          text: `Fixture search post ${index} about ${query}`,
          author_id: `x-author-${index}`,
          public_metrics: {
            impression_count: 9_000 + index,
            like_count: 400 + index,
            reply_count: 20 + index,
            repost_count: 5 + index,
            quote_count: 2,
            bookmark_count: 9,
          },
        }));
        const page = nextToken === 'search-page-2' ? corpus.slice(2) : corpus.slice(0, Math.min(2, maxResults));
        const hasNext = nextToken !== 'search-page-2' && corpus.length > 2;
        reply(
          200,
          {
            data: page.map((post) => projectPost(post as unknown as Record<string, unknown>, fields)),
            meta: { next_token: hasNext ? 'search-page-2' : undefined },
          },
          okRateHeaders('search-recent'),
        );
        return;
      }

      // -- GET /2/users/{id}/tweets ----------------------------------------
      const timelineMatch = /^\/2\/users\/([^/]+)\/tweets$/.exec(url.pathname);
      if (req.method === 'GET' && timelineMatch !== null) {
        const gate = apiGate('user-timeline', ['tweet.read', 'users.read']);
        if (!gate.ok) return;
        const requestedId = decodeURIComponent(timelineMatch[1]!);
        if (requestedId !== gate.accountId) {
          // The documented not-authorized class: the token's own user is
          // the only timeline the fixture serves.
          problem(403, 'Forbidden', 'The token does not serve the timeline of another user.', 'https://api.x.com/2/problems/not-authorized-for-resource');
          return;
        }
        const maxResults = Number(url.searchParams.get('max_results') ?? '10');
        if (!Number.isInteger(maxResults) || maxResults < 5 || maxResults > 100) {
          problem(400, 'Invalid Request', 'The max_results parameter must be between 5 and 100.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        const paginationToken = url.searchParams.get('pagination_token');
        const fields = (url.searchParams.get('post.fields') ?? '')
          .split(',')
          .map((field) => field.trim())
          .filter((field) => field !== '');
        const account = accountOf(gate.accountId);
        const created = (createdPostsByAccount.get(gate.accountId) ?? { post: null, accountId: '' }).post;
        const corpus = [
          ...postsOf(account).map((post) => post as unknown as Record<string, unknown>),
          ...(created !== null ? [created as Record<string, unknown>] : []),
        ];
        const page =
          paginationToken === 'timeline-page-2' ? corpus.slice(2, 2 + maxResults) : corpus.slice(0, Math.min(2, maxResults));
        const hasNext = paginationToken !== 'timeline-page-2' && corpus.length > 2;
        reply(
          200,
          {
            data: page.map((post) => projectPost(post, fields)),
            meta: { next_token: hasNext ? 'timeline-page-2' : undefined, result_count: page.length },
          },
          okRateHeaders('user-timeline'),
        );
        return;
      }

      // -- GET /2/tweets/{id} ----------------------------------------------
      // (The documented analytics path /2/tweets/analytics is excluded —
      // it must not shadow onto the single-Post lookup.)
      const postMatch = /^\/2\/tweets\/(?!analytics$)([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && postMatch !== null) {
        const gate = apiGate('post-lookup', ['tweet.read', 'users.read']);
        if (!gate.ok) return;
        const postId = decodeURIComponent(postMatch[1]!);
        const account = accountOf(gate.accountId);
        const corpus: readonly Record<string, unknown>[] = [
          ...postsOf(account).map((post) => post as unknown as Record<string, unknown>),
          ...(createdPostsByAccount.get(gate.accountId) ?? { post: null }).post === null
            ? []
            : [(createdPostsByAccount.get(gate.accountId)!.post as Record<string, unknown>)],
        ];
        const found = corpus.find((post) => post['id'] === postId);
        if (found === undefined || deletedPosts.has(postId)) {
          // The documented resource-not-found answer of the single-Post
          // lookup ("Could not find post with id: [...].").
          problem(404, 'Not Found Error', `Could not find post with id: [${postId}].`, 'https://api.x.com/2/problems/resource-not-found');
          return;
        }
        const fields = (url.searchParams.get('post.fields') ?? '')
          .split(',')
          .map((field) => field.trim())
          .filter((field) => field !== '');
        reply(200, { data: projectPost(found, fields) }, okRateHeaders('post-lookup'));
        return;
      }

      // -- GET /2/tweets/analytics ------------------------------------------
      // (BEFORE the single-post route: the analytics path must not shadow
      // onto the /2/tweets/{id} lookup.)
      if (req.method === 'GET' && url.pathname === '/2/tweets/analytics') {
        const gate = apiGate('tweets-analytics', ['tweet.read', 'users.read']);
        if (!gate.ok) return;
        const ids = (url.searchParams.get('ids') ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '');
        if (ids.length === 0 || ids.length > 100) {
          problem(400, 'Invalid Request', 'The ids parameter must carry between 1 and 100 post ids.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        const startTime = url.searchParams.get('start_time');
        const endTime = url.searchParams.get('end_time');
        if (startTime === null || endTime === null) {
          problem(400, 'Invalid Request', 'The start_time and end_time parameters are required.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        if (Date.parse(endTime) <= Date.parse(startTime)) {
          problem(400, 'Invalid Request', 'The end_time must be later than the start_time.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        const analyticsFields = (url.searchParams.get('analytics.fields') ?? '')
          .split(',')
          .map((field) => field.trim())
          .filter((field) => field !== '');
        for (const field of analyticsFields) {
          if (!DOCUMENTED_ANALYTICS_FIELDS.has(field)) {
            problem(400, 'Invalid Request', `The analytics.fields value '${field}' is not a documented Analytics field.`, 'https://api.x.com/2/problems/invalid-request');
            return;
          }
        }
        const values: Readonly<Record<string, number>> = {
          impressions: 21_000,
          engagements: 1_540,
          likes: 620,
          bookmarks: 44,
          replies: 71,
          retweets: 33,
          shares: 19,
          quote_tweets: 8,
        };
        const rows = ids.map((id) => {
          const row: Record<string, unknown> = { id };
          for (const field of analyticsFields) {
            if (field in values) row[field] = values[field as keyof typeof values];
          }
          return row;
        });
        reply(200, { data: rows }, okRateHeaders('tweets-analytics'));
        return;
      }

      // -- POST /2/media/upload/initialize ----------------------------------
      if (req.method === 'POST' && url.pathname === '/2/media/upload/initialize') {
        const gate = apiGate('media-init', ['media.write']);
        if (!gate.ok) return;
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          problem(400, 'Invalid Request', 'The request body must be the documented JSON.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        const mediaType = body['media_type'];
        const totalBytes = body['total_bytes'];
        const mediaCategory = body['media_category'];
        if (typeof mediaType !== 'string' || !DOCUMENTED_MEDIA_TYPES.has(mediaType)) {
          problem(400, 'Invalid Request', 'The media_type must be one of the documented media types.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        if (typeof totalBytes !== 'number' || !Number.isInteger(totalBytes) || totalBytes < 0) {
          problem(400, 'Invalid Request', 'The total_bytes must be a non-negative integer.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        if (typeof mediaCategory !== 'string') {
          problem(400, 'Invalid Request', 'The media_category must be a documented category.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        // The provider-stated limit class (the documented media-category
        // size caps): the provider enforces and the answer CITES the
        // limit — the adapter surfaces it, never a hard-coded guess.
        const cap = MEDIA_CATEGORY_SIZE_CAPS[mediaCategory];
        if (cap !== undefined && totalBytes > cap) {
          problem(
            400,
            'Invalid Request',
            `The media exceeds the documented size limit of the '${mediaCategory}' category (${cap} bytes).`,
            'https://api.x.com/2/problems/invalid-request',
          );
          return;
        }
        mediaSequence += 1;
        const plan: XMediaProcessingPlan =
          nextMediaProcessingPlan ??
          (mediaCategory === 'tweet_video' || mediaCategory === 'tweet_gif' ? 'auto' : 'none');
        nextMediaProcessingPlan = null;
        // A SAFE-INTEGER id base (the double's ids must stay under
        // Number.MAX_SAFE_INTEGER — a larger base would collapse every
        // increment through IEEE-754 precision loss and collide the ids).
        const upload: XDoubleMediaUploadRecord = {
          mediaId: String(1_900_000_000_000_000 + mediaSequence),
          mediaType,
          mediaCategory,
          totalBytes,
          segmentCount: 0,
          reassembled: '',
          matchesAsset: false,
          processingState: plan === 'none' ? 'succeeded' : 'pending',
          polls: 0,
          plan,
        };
        mediaUploads.push(upload);
        reply(
          200,
          { data: { id: upload.mediaId, media_key: `13_${upload.mediaId}`, expires_after_secs: 86_400 } },
          okRateHeaders('media-init'),
        );
        return;
      }

      // -- POST /2/media/upload/{id}/append ---------------------------------
      const appendMatch = /^\/2\/media\/upload\/(\d+)\/append$/.exec(url.pathname);
      if (req.method === 'POST' && appendMatch !== null) {
        const gate = apiGate('media-append', ['media.write']);
        if (!gate.ok) return;
        const mediaId = appendMatch[1]!;
        const upload = mediaUploads.find((candidate) => candidate.mediaId === mediaId);
        if (upload === undefined) {
          problem(404, 'Not Found Error', `Could not find the media upload with id: [${mediaId}].`, 'https://api.x.com/2/problems/resource-not-found');
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          problem(400, 'Invalid Request', 'The request body must be the documented JSON.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        const media = body['media'];
        const segmentIndex = body['segment_index'];
        if (typeof media !== 'string' || media === '') {
          problem(400, 'Invalid Request', 'The media chunk is required.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        if (typeof segmentIndex !== 'number' || !Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex > 999) {
          problem(400, 'Invalid Request', 'The segment_index must be an integer between 0 and 999.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        if (segmentIndex !== upload.segmentCount) {
          problem(400, 'Invalid Request', `The segments must be appended in order: expected segment_index ${upload.segmentCount}.`, 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        // The documented base64 (format: byte) APPEND form: the chunk is
        // reassembled BYTE-EXACTLY (the ASCII fixture round-trip).
        const decoded = Buffer.from(media, 'base64').toString('utf8');
        upload.reassembled = upload.reassembled + decoded;
        upload.segmentCount = segmentIndex + 1;
        reply(200, { data: {} }, okRateHeaders('media-append'));
        return;
      }

      // -- POST /2/media/upload/{id}/finalize --------------------------------
      const finalizeMatch = /^\/2\/media\/upload\/(\d+)\/finalize$/.exec(url.pathname);
      if (req.method === 'POST' && finalizeMatch !== null) {
        const gate = apiGate('media-finalize', ['media.write']);
        if (!gate.ok) return;
        const mediaId = finalizeMatch[1]!;
        const upload = mediaUploads.find((candidate) => candidate.mediaId === mediaId);
        if (upload === undefined) {
          problem(404, 'Not Found Error', `Could not find the media upload with id: [${mediaId}].`, 'https://api.x.com/2/problems/resource-not-found');
          return;
        }
        // The byte-exact reassembly check against the registered assets.
        const matching = [...mediaAssets.values()].find((asset) => asset.content === upload.reassembled);
        upload.matchesAsset = matching !== undefined;
        if (upload.reassembled.length !== upload.totalBytes) {
          problem(
            400,
            'Invalid Request',
            `The uploaded media size (${upload.reassembled.length} bytes) does not match the initialized total_bytes (${upload.totalBytes} bytes).`,
            'https://api.x.com/2/problems/invalid-request',
          );
          return;
        }
        const plan = upload.plan;
        const answer: Record<string, unknown> = {
          id: upload.mediaId,
          media_key: `13_${upload.mediaId}`,
          size: upload.totalBytes,
          expires_after_secs: 86_400,
        };
        if (plan !== 'none') {
          answer['processing_info'] =
            plan === 'failed'
              ? { state: 'failed' }
              : { state: 'pending', check_after_secs: 1, progress_percent: 0 };
          upload.processingState = plan === 'failed' ? 'failed' : 'pending';
        }
        reply(200, { data: answer }, okRateHeaders('media-finalize'));
        return;
      }

      // -- GET /2/media/upload?command=STATUS --------------------------------
      if (req.method === 'GET' && url.pathname === '/2/media/upload') {
        const command = url.searchParams.get('command');
        if (command !== 'STATUS') {
          problem(400, 'Invalid Request', "The command parameter must be 'STATUS'.", 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        const gate = apiGate('media-status', ['media.write']);
        if (!gate.ok) return;
        const mediaId = url.searchParams.get('media_id') ?? '';
        const upload = mediaUploads.find((candidate) => candidate.mediaId === mediaId);
        if (upload === undefined) {
          problem(404, 'Not Found Error', `Could not find the media upload with id: [${mediaId}].`, 'https://api.x.com/2/problems/resource-not-found');
          return;
        }
        upload.polls += 1;
        if (upload.plan === 'auto') {
          // The documented processing advance: pending → in_progress →
          // succeeded (the second observed poll).
          if (upload.polls >= 2) {
            upload.processingState = 'succeeded';
          } else if (upload.polls === 1) {
            upload.processingState = 'in_progress';
          }
        }
        const processingInfo: Record<string, unknown> =
          upload.plan === 'none'
            ? { state: 'succeeded' }
            : {
                state: upload.processingState,
                ...(upload.processingState === 'succeeded' ? {} : { check_after_secs: 1 }),
                ...(upload.processingState === 'in_progress' ? { progress_percent: 50 } : {}),
              };
        reply(200, { data: { id: upload.mediaId, processing_info: processingInfo } }, okRateHeaders('media-status'));
        return;
      }

      // -- POST /2/tweets ----------------------------------------------------
      if (req.method === 'POST' && url.pathname === '/2/tweets') {
        const gate = apiGate('tweets-create', ['tweet.read', 'tweet.write', 'users.read']);
        if (!gate.ok) return;
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          problem(400, 'Invalid Request', 'The request body must be the documented JSON.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        const text = body['text'];
        const media = body['media'] as { media_ids?: unknown } | undefined;
        const mediaIds = Array.isArray(media?.media_ids) ? (media!.media_ids as unknown[]) : [];
        if (typeof text !== 'string' && mediaIds.length === 0) {
          problem(400, 'Invalid Request', 'The text is required unless media is provided.', 'https://api.x.com/2/problems/invalid-request');
          return;
        }
        // The documented per-Post media bound (CreatePostsMedia
        // media_ids maxItems: 4 — the provider's own request shape).
        if (mediaIds.length > 4) {
          problem(
            400,
            'Invalid Request',
            'A Post may include up to 4 media attachments (the documented media_ids bound).',
            'https://api.x.com/2/problems/invalid-request',
          );
          return;
        }
        for (const mediaId of mediaIds) {
          if (typeof mediaId !== 'string') {
            problem(400, 'Invalid Request', 'The media_ids entries must be strings.', 'https://api.x.com/2/problems/invalid-request');
            return;
          }
          const upload = mediaUploads.find((candidate) => candidate.mediaId === mediaId);
          if (upload === undefined) {
            problem(404, 'Not Found Error', `Could not find the media with id: [${mediaId}].`, 'https://api.x.com/2/problems/resource-not-found');
            return;
          }
          if (upload.processingState !== 'succeeded') {
            problem(
              400,
              'Invalid Request',
              `The media ${mediaId} has not finished processing (state '${upload.processingState}').`,
              'https://api.x.com/2/problems/invalid-request',
            );
            return;
          }
        }
        // The scriptable documented entitlement refusal (the chunked
        // quickstart 403 example: the posting-user video-cap class).
        const account = accountOf(gate.accountId);
        if (account.videoDurationCapped && mediaIds.length > 0) {
          problem(
            403,
            'Forbidden',
            'This user is not allowed to post a video longer than 20 minutes.',
            'about:blank',
          );
          return;
        }
        postSequence += 1;
        // A SAFE-INTEGER id base (the double's ids must stay under
        // Number.MAX_SAFE_INTEGER — a larger base would collapse every
        // increment through IEEE-754 precision loss and collide the ids).
        const postId = String(1_790_000_000_000_000 + postSequence);
        const createdAt = new Date().toISOString();
        const post: Record<string, unknown> = {
          id: postId,
          text: typeof text === 'string' ? text : '',
          created_at: createdAt,
          author_id: gate.accountId,
          public_metrics: {
            impression_count: 0,
            like_count: 0,
            reply_count: 0,
            repost_count: 0,
            quote_count: 0,
            bookmark_count: 0,
          },
        };
        createdPostsByAccount.set(gate.accountId, { post, accountId: gate.accountId });
        postCreations.push({
          postId,
          accountId: gate.accountId,
          text: typeof text === 'string' ? text : '',
          mediaIds: mediaIds.filter((id): id is string => typeof id === 'string'),
          body,
          createdAt,
        });
        reply(201, { data: { id: postId, text: typeof text === 'string' ? text : '' } }, okRateHeaders('tweets-create'));
        return;
      }

      reply(404, { error: 'not_found' });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;
      resolve({
        url,
        port: address.port,
        exchangeCount: () => exchanges,
        revokeCount: () => revokes,
        setMode: (next: LocalOAuthMode) => {
          mode = next;
        },
        skipHandleProvisioning: false,
        issueAuthorization(input) {
          const authorizationCode = `sandbox-code-${randomUUID()}`;
          const refreshToken = `sandbox-rt-${randomUUID()}`;
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
        issueXAuthorization(input) {
          const authorizationCode = `sandbox-x2-code-${randomUUID()}`;
          const refreshToken = `sandbox-x2-rt-${randomUUID()}`;
          const fixture: XAuthorizationFixture = {
            accountId: input.accountId,
            scopes: [...input.scopes],
            codeChallenge: input.codeChallenge,
            authorizationCode,
            refreshToken,
          };
          xAuthorizations.set(authorizationCode, fixture);
          xRefreshTokens.set(refreshToken, fixture);
          return { code: authorizationCode, accountId: input.accountId, scopes: [...input.scopes] };
        },
        requestCount: (endpoint: XDoubleEndpoint) => requestCounts.get(endpoint) ?? 0,
        totalRequestCount: () => [...requestCounts.values()].reduce((sum, count) => sum + count, 0),
        xTokenEndpointCount: () => xTokenCalls,
        registerAccount(input) {
          accounts.set(input.accountId, {
            accountId: input.accountId,
            isProtected: input.isProtected ?? false,
            verifiedType: input.verifiedType ?? 'none',
            subscriptionType: input.subscriptionType ?? 'None',
            videoDurationCapped: input.videoDurationCapped ?? false,
          });
        },
        scriptFailure(endpoint, failure) {
          if (failure === null) {
            scripted.delete(endpoint);
          } else {
            scripted.set(endpoint, failure);
          }
        },
        setRateBudget(endpoint, budget) {
          rateBudgets.set(endpoint, budget);
        },
        resetRateWindows() {
          rateConsumedMap.clear();
        },
        registerMedia(input) {
          mediaAssets.set(input.key, {
            content: input.content,
            serveRanges: input.serveRanges ?? true,
          });
        },
        setNextMediaProcessingPlan(plan) {
          nextMediaProcessingPlan = plan;
        },
        mediaUploads: () => [...mediaUploads],
        postCreations: () => [...postCreations],
        assetRequestCount: () => assetRequests,
        deletePost(postId) {
          deletedPosts.add(postId);
        },
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error === undefined ? closeResolve(error) : closeReject(error)));
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The X-shaped OAuth 2.0 (PKCE) flow double (the MKT-055 port implementation)
// ---------------------------------------------------------------------------

/**
 * The X-SHAPED OAuth 2.0 (PKCE) FLOW DOUBLE — the disclosed integration
 * test double of the provider-neutral SocialAccountFlowImplementation
 * port, speaking the DOCUMENTED X OAuth 2.0 Authorization Code Flow with
 * PKCE wire form (verified against the live reference at delivery time —
 * https://docs.x.com/x-api/fundamentals/authentication/oauth-2-0/authorization-code):
 *
 *   - buildAuthorizeUrl builds the documented authorize URL form
 *     (response_type=code, client_id, redirect_uri, scope, state,
 *     code_challenge, code_challenge_method=S256 — the documented
 *     parameter table), generating the PKCE code_verifier (a 43-char
 *     base64url secret) and remembering it by the round's state;
 *   - exchangeAuthorizationCode POSTs the documented token endpoint
 *     (application/x-www-form-urlencoded: grant_type=authorization_code,
 *     code, client_id, redirect_uri, code_verifier — the double
 *     verifies the S256 challenge), then reads the authorized user's
 *     identity through the documented GET /2/users/me (the documented
 *     flow: the token response carries no user identity);
 *   - refreshAuthorization POSTs the documented refresh_token grant;
 *   - revokeAuthorization performs NO provider call: X documents NO
 *     user-token revocation endpoint (verified at delivery time — the
 *     resource owner revokes access through the X app settings), so the
 *     honest outcome is revoked:false with the message naming the fact
 *     (the MOS-side fail-closed death is the authoritative revocation —
 *     the module treats provider-side revocation as best-effort
 *     DISCLOSURE only).
 *
 * DISCLOSED derivation: the exchange outcome's capabilityTags carry the
 * granted scope names themselves (the documented X scope vocabulary IS
 * the platform's capability vocabulary — no tag surface exists on the
 * documented token response).
 *
 * The connection's NON-SECRET providerConfig carries the deployment
 * override surface: apiBaseUrl (the documented token/user hosts default
 * to https://api.x.com — the tests point both at the loopback double),
 * oauthClientId, oauthRedirectUri and oauthAuthorizeBaseUrl (the
 * documented authorize host default https://x.com/i/oauth2/authorize —
 * the documented web-host surface the operator redirect targets; it is
 * never fetched by the tests).
 */
export function createXOAuthFlow(
  provider: XProviderDouble,
  options: {
    readonly adapterKey: string;
    readonly secretsDir: string;
  },
): SocialAccountFlowImplementation {
  let provisioned = 0;
  /** The PKCE verifier of each in-flight round, keyed by the round's state. */
  const verifiersByState = new Map<string, string>();

  /** Provisions the token bundle into the fs secret backend; returns the opaque handle. */
  function provisionTokenBundle(accessToken: string, refreshToken: string | null): string {
    provisioned += 1;
    const handle = `sa-oauth-${options.adapterKey}-${provisioned}-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(
      path.join(options.secretsDir, `${handle}.secret`),
      JSON.stringify({ accessToken, ...(refreshToken !== null ? { refreshToken } : {}) }),
      { mode: 0o600 },
    );
    return handle;
  }

  /** The documented token-plane host of the round (the connection's OAuth host override, defaulting to the API base, then the documented api.x.com). */
  function tokenBaseOf(context: SocialAccountFlowCallContext): string {
    const base = context.providerConfig['oauthTokenBaseUrl'] ?? context.providerConfig['apiBaseUrl'] ?? 'https://api.x.com';
    return base.replace(/\/+$/, '');
  }

  /** The documented token-endpoint answer (form-urlencoded round-trip). */
  async function tokenEndpoint(
    context: SocialAccountFlowCallContext,
    form: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${tokenBaseOf(context)}/2/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    if (!response.ok) {
      throw new Error(`the X token endpoint rejected the exchange (HTTP ${response.status})`);
    }
    const parsed = (await response.json()) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('the X token endpoint returned a malformed body');
    }
    return parsed;
  }

  /** The documented users/me identity read of the authorized token (the token-plane host). */
  async function readUserIdentity(
    context: SocialAccountFlowCallContext,
    accessToken: string,
  ): Promise<{ externalAccountId: string; displayIdentity: string; verifiedAt: string | null }> {
    const response = await fetch(`${tokenBaseOf(context)}/2/users/me?user.fields=id,name,username`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`the X users/me surface answered HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as { data?: { id?: string; name?: string; username?: string } };
    const user = parsed?.data;
    if (user === undefined || typeof user.id !== 'string' || user.id === '') {
      throw new Error('the X users/me answer carried no documented User id');
    }
    const display =
      typeof user.name === 'string' && user.name !== ''
        ? typeof user.username === 'string' && user.username !== ''
          ? `${user.name} (@${user.username})`
          : user.name
        : typeof user.username === 'string'
          ? `@${user.username}`
          : user.id;
    return { externalAccountId: user.id, displayIdentity: display, verifiedAt: null };
  }

  /** The exchange outcome of a documented token answer. */
  async function outcomeOf(
    context: SocialAccountFlowCallContext,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<SocialAccountFlowExchangeOutcome> {
    const accessToken = String(payload['access_token'] ?? '');
    const refreshToken = typeof payload['refresh_token'] === 'string' ? (payload['refresh_token'] as string) : null;
    const scopeText = String(payload['scope'] ?? '');
    const grantedScopes = scopeText === '' ? [] : scopeText.split(' ');
    const expiresIn = typeof payload['expires_in'] === 'number' ? (payload['expires_in'] as number) : null;
    const identity = await readUserIdentity(context, accessToken);
    const handle = provider.skipHandleProvisioning
      ? `sa-oauth-dangling-${randomUUID().slice(0, 8)}`
      : provisionTokenBundle(accessToken, refreshToken);
    return {
      identity,
      grantedScopes,
      capabilityTags: [...grantedScopes],
      tokenSecretHandle: handle,
      expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  return {
    descriptor: {
      adapterKey: options.adapterKey,
      flowLabel: `X OAuth 2.0 PKCE flow ${options.adapterKey}`,
      description:
        'The disclosed integration-test double of the provider-neutral flow port speaking the documented X OAuth 2.0 Authorization Code Flow with PKCE wire form (S256 code challenges, form-urlencoded token exchange, the users/me identity read; no documented user-token revocation endpoint — revocation reports the honest no-endpoint outcome). Served from the test process; the connection model under test is fully real.',
    },
    async buildAuthorizeUrl(
      context: SocialAccountFlowCallContext,
      input: { readonly state: string; readonly requestedScopes: readonly string[] | null },
    ): Promise<{ readonly authorizeUrl: string }> {
      // The documented PKCE pair: a random code_verifier, the S256
      // code_challenge derived from it.
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
      verifiersByState.set(input.state, verifier);
      const authorizeBase =
        context.providerConfig['oauthAuthorizeBaseUrl'] ?? 'https://x.com/i/oauth2/authorize';
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: context.providerConfig['oauthClientId'] ?? '',
        redirect_uri: context.providerConfig['oauthRedirectUri'] ?? '',
        state: input.state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      if (input.requestedScopes !== null && input.requestedScopes.length > 0) {
        query.set('scope', input.requestedScopes.join(' '));
      }
      return { authorizeUrl: `${authorizeBase.replace(/\/+$/, '')}?${query.toString()}` };
    },
    async exchangeAuthorizationCode(
      context: SocialAccountFlowCallContext,
      input: { readonly code: string; readonly state: string },
    ): Promise<SocialAccountFlowExchangeOutcome> {
      const verifier = verifiersByState.get(input.state) ?? '';
      verifiersByState.delete(input.state);
      const payload = await tokenEndpoint(context, {
        grant_type: 'authorization_code',
        code: input.code,
        client_id: context.providerConfig['oauthClientId'] ?? '',
        redirect_uri: context.providerConfig['oauthRedirectUri'] ?? '',
        code_verifier: verifier,
      });
      return outcomeOf(context, payload);
    },
    async refreshAuthorization(
      context: SocialAccountFlowCallContext,
      input: { readonly currentTokenMaterial: Uint8Array },
    ): Promise<SocialAccountFlowExchangeOutcome> {
      let refreshToken = '';
      try {
        const bundle = JSON.parse(new TextDecoder().decode(input.currentTokenMaterial)) as {
          refreshToken?: unknown;
        };
        refreshToken = typeof bundle.refreshToken === 'string' ? bundle.refreshToken : '';
      } catch {
        refreshToken = '';
      }
      const payload = await tokenEndpoint(context, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: context.providerConfig['oauthClientId'] ?? '',
      });
      return outcomeOf(context, payload);
    },
    async revokeAuthorization(
      _context: SocialAccountFlowCallContext,
      _input: { readonly currentTokenMaterial: Uint8Array },
    ): Promise<{ readonly revoked: boolean; readonly message: string | null }> {
      // ZERO provider traffic: X documents NO OAuth 2.0 user-token
      // revocation endpoint (verified at delivery time — the resource
      // owner revokes access through the X app settings). The honest
      // best-effort outcome rides the disclosure; the MOS-side
      // fail-closed death is the authoritative revocation.
      return {
        revoked: false,
        message:
          'X documents no OAuth 2.0 user-token revocation endpoint — the resource owner revokes access through the X app settings; the MOS-side fail-closed death is the authoritative revocation',
      };
    },
  };
}
