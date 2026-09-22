/**
 * MKT-060 integration-test harness — the COMBINED TIKTOK PROVIDER
 * DOUBLE: ONE in-process loopback HTTP server standing in for the
 * provider (NO external network — not callable from the sandbox and
 * deliberately not attempted), serving BOTH provider planes exactly
 * like the single provider identity behind the documented TikTok for
 * Developers surface (the MKT-057/058/059 combined-double pattern):
 *
 *   1. the OAUTH token plane — the provider-neutral local OAuth
 *      protocol (the same fixture protocol as the canonical
 *      tests/integration/helpers/oauth-provider.ts: the token endpoint
 *      code/refresh exchange + the revocation endpoint + the
 *      resource-owner fixture endpoint minting authorization codes
 *      bound to external creator identities, VERBATIM scope lists and
 *      capability tags). The double implements the LocalOAuthProvider
 *      interface so it serves as the conformance suite's `provider`
 *      argument and the createLocalOAuthFlow backend (the Login Kit
 *      OAuth surface the documented API rides on);
 *
 *   2. the TIKTOK FOR DEVELOPERS API plane — a faithful mirror of the
 *      DOCUMENTED endpoints the real adapter
 *      (src/modules/social-accounts/internal/adapters/tiktok/adapter.ts)
 *      calls, on the SAME origin (the connection's providerConfig
 *      .apiBaseUrl points here — the documented deployment override of
 *      the https://open.tiktokapis.com host; the platform HttpCallPort
 *      permits loopback http for exactly this test shape):
 *        GET  /v2/user/info/?fields=...
 *                                             (the authorized user's
 *                                              profile + statistical
 *                                              fields, scope-gated per
 *                                              the documented field
 *                                              table: user.info.basic /
 *                                              user.info.profile /
 *                                              user.info.stats)
 *        POST /v2/video/list/?fields=...
 *                                             (the user's public video
 *                                              posts, the documented
 *                                              int64 Unix-MS cursor
 *                                              pagination, max_count
 *                                              bounded at 20)
 *        POST /v2/video/query/?fields=...
 *                                             (up to 20 video_ids per
 *                                              request; the documented
 *                                              ownership verification —
 *                                              an unknown id is ABSENT
 *                                              from the videos list)
 *        POST /v2/post/publish/creator_info/query/
 *                                             (the creator capability
 *                                              query: the documented
 *                                              privacy_level_options
 *                                              per the account's
 *                                              privacy mode + the
 *                                              duration bound + the
 *                                              interaction settings)
 *        POST /v2/post/publish/video/init/
 *                                             (the direct-post
 *                                              initiation: post_info +
 *                                              source_info
 *                                              PULL_FROM_URL/FILE_
 *                                              UPLOAD → the publish_id
 *                                              (+ upload_url for
 *                                              FILE_UPLOAD); the
 *                                              documented eligibility
 *                                              enforcement —
 *                                              privacy_level_option_
 *                                              mismatch, the audit
 *                                              model, the daily caps)
 *        POST /v2/post/publish/status/fetch/
 *                                             (the publish-status
 *                                              fetch by publish_id:
 *                                              PROCESSING_DOWNLOAD /
 *                                              PUBLISH_COMPLETE (with
 *                                              the public post id only
 *                                              for publicly-viewable
 *                                              posts) / FAILED with
 *                                              the documented
 *                                              fail_reason)
 *
 * Documented-semantics fidelity (the surfaces the double enforces —
 * every behavior below mirrors the LIVE developers.tiktok.com
 * documentation verified at delivery time; see docs/runbooks/MKT-060.md
 * §2):
 *   - THE ERROR MODEL: the documented v2 error struct
 *     {"error":{"code","message","log_id"}} (the nested endpoint shape;
 *     the error-handling reference's TOP-LEVEL shape is served on the
 *     token plane) and the documented 200-INTENTIONAL answers (an
 *     error.code != 'ok' body served over HTTP 200 — e.g. the
 *     creator_info/query spam_risk_too_many_posts answer);
 *   - THE ACCOUNT PRIVACY MODE (the eligibility AC): a fixture creator
 *     of privacyMode 'private' answers the documented PRIVATE-account
 *     privacy_level_options (FOLLOWER_OF_CREATOR, MUTUAL_FOLLOW_FRIENDS,
 *     SELF_ONLY — NO PUBLIC option) on creator_info/query, and a
 *     publish outside the options answers the documented 403
 *     privacy_level_option_mismatch;
 *   - THE AUDIT MODEL (the eligibility AC): an UNAUDITED client's
 *     non-private publish answers the documented 403
 *     unaudited_client_can_only_post_to_private_accounts ("All content
 *     posted by unaudited clients will be restricted to private viewing
 *     mode" — the audit note of the documented get-started flow); a
 *     private (SELF_ONLY) publish from an unaudited client is ACCEPTED
 *     and completes with NO public post id (the private viewing mode);
 *   - THE DAILY CAPS: the documented 403 spam_risk_too_many_posts /
 *     reached_active_user_cap classes (scriptable per account);
 *   - THE RATE WINDOWS: the documented per-endpoint one-minute sliding
 *     windows (user/info, video/query, video/list: 600; video/init: 6
 *     per user token; creator_info/query: 20; status/fetch: 30) — the
 *     exhaustion answers the documented 429 rate_limit_exceeded (with
 *     an observable Retry-After header, read opportunistically by the
 *     adapter as the backoff signal);
 *   - the documented video/list cursor pagination (int64 Unix-MS) and
 *     the documented max_count bound (default 10, maximum 20);
 *   - the documented video/query ownership verification (unknown ids
 *     are ABSENT from the answer — the honest null record);
 *   - the documented field-scope table on user/info (a field outside
 *     the token's granted scopes answers the documented 400
 *     scope_permission_missed);
 *   - the documented direct-post initiation validation (a source-less
 *     initiation answers the 400 invalid_param family);
 *   - the documented status lifecycle (PROCESSING_DOWNLOAD →
 *     PUBLISH_COMPLETE with publicaly_available_post_id only for
 *     publicly-viewable posts / FAILED with fail_reason), incl. the
 *     documented 400 invalid_publish_id of an unknown publish id;
 *   - per-endpoint FAILURE INJECTION (the documented envelope shapes).
 *
 * Scriptable/observation surface (in-process control — the test owns
 * the server object): per-endpoint failure scripting, the creator
 * account fixtures (registerAccount with the privacy mode), the daily
 * cap scripting, the audit state, the publish advance, the per-endpoint
 * rate budgets, the per-endpoint request counts (the inertness/
 * zero-traffic assertions) and the recorded publishes.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { LocalOAuthMode, LocalOAuthProvider } from './oauth-provider.ts';
import { PUBLIC_PRIVACY_LEVEL_OPTIONS, PRIVATE_PRIVACY_LEVEL_OPTIONS } from './tiktok-platform-double.ts';

// ---------------------------------------------------------------------------
// The fixture data model (the documented resource shapes)
// ---------------------------------------------------------------------------

/**
 * The fixture creator account of a bound OAuth identity:
 *   - privacyMode 'public' (default): the documented PUBLIC-account
 *     creator capability answer (PUBLIC_TO_EVERYONE among the options);
 *   - privacyMode 'private': the documented PRIVATE-account answer (NO
 *     PUBLIC option) — the MKT-060 private-mode eligibility battery;
 *   - dailyCapExhausted: the documented 403 spam_risk_too_many_posts
 *     class on the publishing surfaces (the daily post cap reached).
 */
export interface TikTokDoubleCreator {
  readonly accountId: string;
  readonly privacyMode: 'public' | 'private';
  readonly dailyCapExhausted: boolean;
}

/** The per-endpoint scripted failure (the documented envelope shape). */
export interface TikTokScriptedFailure {
  /** The HTTP status of the documented answer (the v2 norm: 400/401/403/429/5xx). */
  readonly status: number;
  /**
   * The documented error code (the code-driven classification surface):
   * access_token_invalid / scope_not_authorized (401);
   * rate_limit_exceeded (429); spam_risk_too_many_posts /
   * reached_active_user_cap / unaudited_client_can_only_post_to_private_accounts
   * / privacy_level_option_mismatch / url_ownership_unverified /
   * spam_risk_user_banned_from_posting (403); invalid_param /
   * invalid_publish_id / token_not_authorized_for_specified_publish_id
   * / scope_permission_missed (400); internal_error (5xx).
   */
  readonly code: string;
  readonly message: string;
  /** The observable backoff seconds (rides the Retry-After header — read opportunistically by the adapter). */
  readonly retryAfterSeconds?: number | null;
}

export type TikTokDoubleEndpoint =
  | 'user-info'
  | 'video-list'
  | 'video-query'
  | 'creator-info'
  | 'video-init'
  | 'status-fetch';

/** The recorded direct-post publish (the documented lifecycle state). */
export interface TikTokDoublePublish {
  readonly publishId: string;
  readonly accountId: string;
  readonly privacyLevel: string;
  readonly videoUrl: string | null;
  readonly source: 'PULL_FROM_URL' | 'FILE_UPLOAD';
  readonly params: Readonly<Record<string, unknown>>;
  publishStatus: 'PROCESSING_DOWNLOAD' | 'PUBLISH_COMPLETE' | 'FAILED';
  failReason: string | null;
  /** The public post id — null until the publish completes for a publicly-viewable post. */
  publicPostId: number | null;
}

// ---------------------------------------------------------------------------
// The documented field-scope table (Get User Info)
// ---------------------------------------------------------------------------

/** The documented user fields of each scope (the live Get User Info field table). */
const USER_FIELDS_OF_SCOPE: Readonly<Record<string, readonly string[]>> = {
  'user.info.basic': ['open_id', 'union_id', 'avatar_url', 'avatar_url_100', 'avatar_large_url', 'display_name'],
  'user.info.profile': ['bio_description', 'profile_deep_link', 'is_verified', 'username'],
  'user.info.stats': ['follower_count', 'following_count', 'likes_count', 'video_count'],
};

/** The documented per-endpoint rate limits (the one-minute sliding windows + the per-user-token Content Posting limits). */
const DEFAULT_RATE_BUDGETS: Readonly<Record<TikTokDoubleEndpoint, number>> = {
  'user-info': 600,
  'video-list': 600,
  'video-query': 600,
  'creator-info': 20,
  'video-init': 6,
  'status-fetch': 30,
};

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

export interface TikTokProviderDouble extends LocalOAuthProvider {
  /** The number of API-plane requests received per endpoint (the zero-traffic assertions). */
  requestCount(endpoint: TikTokDoubleEndpoint): number;
  /** The total number of API-plane requests received. */
  totalRequestCount(): number;
  /** Registers (or replaces) a fixture creator bound to an OAuth account id — the PRIVACY MODE drives the documented creator capability answer + the publish eligibility enforcement. */
  registerAccount(input: { readonly accountId: string; readonly privacyMode: 'public' | 'private' }): void;
  /** Replaces the client audit state (the documented audit model: an unaudited client can only post privately). */
  setClientAudited(audited: boolean): void;
  /** Marks a fixture creator as having exhausted the documented daily post cap (the 403 spam_risk_too_many_posts class). */
  setDailyCapExhausted(accountId: string, exhausted: boolean): void;
  /** Scripts a documented error envelope on an endpoint (null clears). */
  scriptFailure(endpoint: TikTokDoubleEndpoint, failure: TikTokScriptedFailure | null): void;
  /** Replaces a per-endpoint rate budget (the documented rate accounting; the exhaustion battery). */
  setRateBudget(endpoint: TikTokDoubleEndpoint, budget: number): void;
  /** Resets the rate windows. */
  resetRateWindows(): void;
  /** Moves a recorded publish to a later status-fetch state (the documented lifecycle advance; an explicit null publicPostId keeps the private-mode completion — no public post id). */
  advancePublish(
    publishId: string,
    state: 'PROCESSING_DOWNLOAD' | 'PUBLISH_COMPLETE' | 'FAILED',
    patch?: { readonly failReason?: string; readonly publicPostId?: number | null },
  ): void;
  /** The recorded direct-post publishes. */
  publishes(): readonly TikTokDoublePublish[];
  /** The recorded direct-post publishes of a creator account (the double never sees the host idempotency key — the provider surface carries the documented params only). */
  publishesOf(accountId: string): readonly TikTokDoublePublish[];
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

/** Boots the COMBINED TikTok provider double (OAuth plane + documented API plane, one loopback origin). */
export function startTikTokProviderDouble(): Promise<TikTokProviderDouble> {
  const authorizations = new Map<string, AuthorizationFixture>();
  const refreshTokens = new Map<string, AuthorizationFixture>();
  /** The user-token → bound creator identity binding (minted at exchange time) + the granted scopes of the token. */
  const tokenAccounts = new Map<string, { accountId: string; scopes: readonly string[] }>();
  const creators = new Map<string, TikTokDoubleCreator>();
  const publishesById = new Map<string, TikTokDoublePublish>();
  const scripted = new Map<TikTokDoubleEndpoint, TikTokScriptedFailure>();
  const requestCounts = new Map<TikTokDoubleEndpoint, number>();
  /** The rate-window consumption map (the documented per-token Content Posting windows + the per-API read windows — keyed by the rate-window key). */
  const rateConsumedMap = new Map<string, number>();
  const rateBudgets = new Map<TikTokDoubleEndpoint, number>(Object.entries(DEFAULT_RATE_BUDGETS) as [TikTokDoubleEndpoint, number][]);
  let clientAudited = false;
  let mode: LocalOAuthMode = 'ok';
  let exchanges = 0;
  let revokes = 0;
  let publishSequence = 0;

  const creatorOf = (accountId: string): TikTokDoubleCreator =>
    creators.get(accountId) ?? { accountId, privacyMode: 'public', dailyCapExhausted: false };

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
        const accessToken = `sandbox-tt-at-${randomUUID()}`;
        const refreshToken = `sandbox-tt-rt-${randomUUID()}`;
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
      // The TikTok for Developers API plane (the documented endpoints).
      // ------------------------------------------------------------------
      const bearer = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '');
      const endpointOf = (path: string, method: string): TikTokDoubleEndpoint | null => {
        if (method === 'GET' && path === '/v2/user/info/') return 'user-info';
        if (method === 'POST' && path === '/v2/video/list/') return 'video-list';
        if (method === 'POST' && path === '/v2/video/query/') return 'video-query';
        if (method === 'POST' && path === '/v2/post/publish/creator_info/query/') return 'creator-info';
        if (method === 'POST' && path === '/v2/post/publish/video/init/') return 'video-init';
        if (method === 'POST' && path === '/v2/post/publish/status/fetch/') return 'status-fetch';
        return null;
      };
      const endpoint = endpointOf(url.pathname, req.method ?? 'GET');
      if (endpoint === null) {
        reply(404, { error: 'not_found' });
        return;
      }
      requestCounts.set(endpoint, (requestCounts.get(endpoint) ?? 0) + 1);

      /** The documented error envelope (the nested endpoint shape). */
      const envelope = (status: number, code: string, message: string): { status: number; body: string } => ({
        status,
        body: JSON.stringify({
          data: {},
          error: { code, message, log_id: `double-${randomUUID()}` },
        }),
      });

      /**
       * The documented rate-window key: the Content Posting endpoints
       * are documented PER USER ACCESS TOKEN ("Each user access_token is
       * limited to 6/20/30 requests per minute" — video/init,
       * creator_info/query, status/fetch); the Display API read endpoints
       * carry the API-level one-minute windows of the documented rate
       * page (user/info, video/query, video/list: 600).
       */
      const rateKey = (token: string): string =>
        endpoint === 'user-info' || endpoint === 'video-list' || endpoint === 'video-query'
          ? endpoint
          : `${endpoint}:${token}`;

      /**
       * The documented prelude: scripted failures, bearer validation,
       * the rate window (the documented one-minute sliding windows; the
       * exhaustion answers the 429 rate_limit_exceeded with an
       * observable Retry-After header).
       */
      const prelude = (): { ok: true; accountId: string; scopes: readonly string[] } | { ok: false; status: number; body: string; headers: Record<string, string> } => {
        const scriptedFailure = scripted.get(endpoint);
        if (scriptedFailure !== undefined) {
          const error = envelope(scriptedFailure.status, scriptedFailure.code, scriptedFailure.message);
          return {
            ok: false,
            status: error.status,
            body: error.body,
            headers:
              scriptedFailure.retryAfterSeconds !== undefined && scriptedFailure.retryAfterSeconds !== null
                ? { 'retry-after': String(scriptedFailure.retryAfterSeconds) }
                : {},
          };
        }
        if (bearer === null) {
          const error = envelope(401, 'access_token_invalid', 'The access token is malformed or missing.');
          return { ok: false, status: error.status, body: error.body, headers: {} };
        }
        const bound = tokenAccounts.get(bearer[1]!);
        if (bound === undefined) {
          const error = envelope(401, 'access_token_invalid', 'The access token is invalid or has expired.');
          return { ok: false, status: error.status, body: error.body, headers: {} };
        }
        const key = rateKey(bearer[1]!);
        const consumed = (rateConsumedMap.get(key) ?? 0) + 1;
        rateConsumedMap.set(key, consumed);
        if (consumed > (rateBudgets.get(endpoint) ?? 600)) {
          const error = envelope(429, 'rate_limit_exceeded', 'Your request is blocked due to exceeding the API rate limit. Please try again later.');
          return { ok: false, status: error.status, body: error.body, headers: { 'retry-after': '42' } };
        }
        return { ok: true, accountId: bound.accountId, scopes: bound.scopes };
      };

      /** The documented scope gate: the endpoint's scope requirement against the token's granted scopes. */
      const scopeGate = (
        scopes: readonly string[],
        required: string,
      ): { ok: true } | { ok: false; status: number; body: string } => {
        if (scopes.includes(required)) return { ok: true };
        const error = envelope(
          401,
          'scope_not_authorized',
          `The access_token does not bear user's grant on ${required} scope`,
        );
        return { ok: false, status: error.status, body: error.body };
      };

      // ------------------------------------------------------------------
      // GET /v2/user/info/ — the documented user object (the
      // field-scope table: a field outside the token's granted scopes
      // answers the documented 400 scope_permission_missed).
      // ------------------------------------------------------------------
      if (endpoint === 'user-info') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const fields = (url.searchParams.get('fields') ?? '').split(',').map((f) => f.trim()).filter((f) => f !== '');
        if (fields.length === 0) {
          const error = envelope(400, 'invalid_params', 'The fields parameter is required.');
          reply(error.status, error.body);
          return;
        }
        for (const field of fields) {
          const owningScope = Object.entries(USER_FIELDS_OF_SCOPE).find(([, owned]) => owned.includes(field));
          if (owningScope === undefined) {
            const error = envelope(400, 'invalid_params', `The field '${field}' is not a documented user field.`);
            reply(error.status, error.body);
            return;
          }
          if (!gate.scopes.includes(owningScope[0])) {
            const error = envelope(
              400,
              'scope_permission_missed',
              `Access token is invalid, the field '${field}' needs the additional scope ${owningScope[0]}.`,
            );
            reply(error.status, error.body);
            return;
          }
        }
        const creator = creatorOf(gate.accountId);
        const user: Record<string, unknown> = {};
        for (const field of fields) {
          if (field === 'open_id') user['open_id'] = creator.accountId;
          if (field === 'union_id') user['union_id'] = `union-${creator.accountId}`;
          if (field === 'avatar_url') user['avatar_url'] = `https://p19-sign.tiktokcdn-us.com/double-avatar-${creator.accountId}`;
          if (field === 'avatar_url_100') user['avatar_url_100'] = `https://p19-sign.tiktokcdn-us.com/double-avatar-100-${creator.accountId}`;
          if (field === 'avatar_large_url') user['avatar_large_url'] = `https://p19-sign.tiktokcdn-us.com/double-avatar-lg-${creator.accountId}`;
          if (field === 'display_name') user['display_name'] = `Fixture Creator ${creator.accountId}`;
          if (field === 'bio_description') user['bio_description'] = 'The documented bio of the fixture creator';
          if (field === 'profile_deep_link') user['profile_deep_link'] = `https://www.tiktok.com/@double-${creator.accountId}`;
          if (field === 'is_verified') user['is_verified'] = creator.accountId.startsWith('tt-verified');
          if (field === 'username') user['username'] = `double_${creator.accountId.replaceAll('-', '_')}`;
          if (field === 'follower_count') user['follower_count'] = 7351;
          if (field === 'following_count') user['following_count'] = 128;
          if (field === 'likes_count') user['likes_count'] = 91_234;
          if (field === 'video_count') user['video_count'] = 42;
        }
        reply(200, {
          data: { user },
          error: { code: 'ok', message: '', log_id: `double-${randomUUID()}` },
        });
        return;
      }

      // ------------------------------------------------------------------
      // POST /v2/video/list/ — the user's public videos (the documented
      // int64 Unix-MS cursor pagination; max_count default 10, max 20).
      // ------------------------------------------------------------------
      if (endpoint === 'video-list') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const scope = scopeGate(gate.scopes, 'video.list');
        if (!scope.ok) {
          reply(scope.status, scope.body);
          return;
        }
        const fields = (url.searchParams.get('fields') ?? '').split(',').map((f) => f.trim()).filter((f) => f !== '');
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          const error = envelope(400, 'invalid_params', 'The request body must be the documented JSON.');
          reply(error.status, error.body);
          return;
        }
        const maxCount = typeof body['max_count'] === 'number' ? body['max_count'] : 10;
        if (maxCount < 1 || maxCount > 20) {
          const error = envelope(400, 'invalid_params', 'max_count must be between 1 and 20.');
          reply(error.status, error.body);
          return;
        }
        const all = publicVideosOf(gate.accountId);
        const cursor = typeof body['cursor'] === 'number' ? (body['cursor'] as number) : null;
        // The documented cursor semantics: a UTC Unix-MS timestamp —
        // the videos posted BEFORE the provided timestamp ride the page.
        const filtered = cursor !== null ? all.filter((video) => video.create_time * 1000 < cursor) : all;
        const slice = filtered.slice(0, maxCount);
        const hasMore = filtered.length > slice.length;
        const nextCursor = slice.length > 0 ? slice[slice.length - 1]!.create_time * 1000 : cursor;
        reply(200, {
          data: {
            videos: slice.map((video) => {
              const record: Record<string, unknown> = {};
              for (const field of fields) {
                if (field in video) record[field] = (video as unknown as Record<string, unknown>)[field];
              }
              return record;
            }),
            cursor: nextCursor,
            has_more: hasMore,
          },
          error: { code: 'ok', message: '', log_id: `double-${randomUUID()}` },
        });
        return;
      }

      // ------------------------------------------------------------------
      // POST /v2/video/query/ — the documented ownership verification:
      // up to 20 video_ids; unknown/not-owned ids are ABSENT.
      // ------------------------------------------------------------------
      if (endpoint === 'video-query') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const scope = scopeGate(gate.scopes, 'video.list');
        if (!scope.ok) {
          reply(scope.status, scope.body);
          return;
        }
        const fields = (url.searchParams.get('fields') ?? '').split(',').map((f) => f.trim()).filter((f) => f !== '');
        let body: { filters?: { video_ids?: unknown } } = {};
        try {
          body = JSON.parse(bodyText) as { filters?: { video_ids?: unknown } };
        } catch {
          const error = envelope(400, 'invalid_params', 'The request body must be the documented JSON.');
          reply(error.status, error.body);
          return;
        }
        const videoIds = Array.isArray(body.filters?.video_ids) ? (body.filters!.video_ids as unknown[]) : [];
        if (videoIds.length === 0 || videoIds.length > 20) {
          const error = envelope(400, 'invalid_params', 'filters.video_ids must carry 1..20 video ids.');
          reply(error.status, error.body);
          return;
        }
        const all = publicVideosOf(gate.accountId);
        const videos = videoIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => all.find((video) => video.id === id))
          .filter((video): video is NonNullable<typeof video> => video !== undefined);
        reply(200, {
          data: {
            videos: videos.map((video) => {
              const record: Record<string, unknown> = {};
              for (const field of fields) {
                if (field in video) record[field] = (video as unknown as Record<string, unknown>)[field];
              }
              return record;
            }),
          },
          error: { code: 'ok', message: '', log_id: `double-${randomUUID()}` },
        });
        return;
      }

      // ------------------------------------------------------------------
      // POST /v2/post/publish/creator_info/query/ — the documented
      // creator capability query (the privacy options follow the
      // account's documented privacy mode).
      // ------------------------------------------------------------------
      if (endpoint === 'creator-info') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const scope = scopeGate(gate.scopes, 'video.publish');
        if (!scope.ok) {
          reply(scope.status, scope.body);
          return;
        }
        const creator = creatorOf(gate.accountId);
        // The documented 200-INTENTIONAL answers of this endpoint (the
        // spam_risk / cap classes served over HTTP 200 with
        // error.code != 'ok').
        if (creator.dailyCapExhausted) {
          reply(200, {
            data: {},
            error: {
              code: 'spam_risk_too_many_posts',
              message: 'The daily post cap from the API is reached for the current user.',
              log_id: `double-${randomUUID()}`,
            },
          });
          return;
        }
        reply(200, {
          data: {
            creator_avatar_url: `https://lf16-tt4d.tiktokcdn.com/double-avatar-${creator.accountId}`,
            creator_username: `double_${creator.accountId.replaceAll('-', '_')}`,
            creator_nickname: `Fixture Creator ${creator.accountId}`,
            privacy_level_options:
              creator.privacyMode === 'private' ? [...PRIVATE_PRIVACY_LEVEL_OPTIONS] : [...PUBLIC_PRIVACY_LEVEL_OPTIONS],
            comment_disabled: false,
            duet_disabled: creator.privacyMode === 'private',
            stitch_disabled: true,
            max_video_post_duration_sec: 600,
          },
          error: { code: 'ok', message: '', log_id: `double-${randomUUID()}` },
        });
        return;
      }

      // ------------------------------------------------------------------
      // POST /v2/post/publish/video/init/ — the documented direct-post
      // initiation (the eligibility/audit/cap enforcement + the
      // publish_id answer).
      // ------------------------------------------------------------------
      if (endpoint === 'video-init') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const scope = scopeGate(gate.scopes, 'video.publish');
        if (!scope.ok) {
          reply(scope.status, scope.body);
          return;
        }
        let body: {
          post_info?: { privacy_level?: unknown };
          source_info?: { source?: unknown; video_url?: unknown; video_size?: unknown };
        } = {};
        try {
          body = JSON.parse(bodyText) as typeof body;
        } catch {
          const error = envelope(400, 'invalid_params', 'The request body must be the documented JSON.');
          reply(error.status, error.body);
          return;
        }
        const creator = creatorOf(gate.accountId);
        const privacyLevel = typeof body.post_info?.privacy_level === 'string' ? body.post_info.privacy_level : '';
        const options: readonly string[] =
          creator.privacyMode === 'private' ? [...PRIVATE_PRIVACY_LEVEL_OPTIONS] : [...PUBLIC_PRIVACY_LEVEL_OPTIONS];
        // The documented 403 eligibility classes (never a fabricated success).
        if (creator.dailyCapExhausted) {
          const error = envelope(403, 'spam_risk_too_many_posts', 'The daily post cap from the API is reached for the current user.');
          reply(error.status, error.body);
          return;
        }
        if (!options.includes(privacyLevel)) {
          const error = envelope(
            403,
            'privacy_level_option_mismatch',
            'privacy_level is not specified or not among the options from the privacy_level_options returned in /publish/creator_info/query/ API.',
          );
          reply(error.status, error.body);
          return;
        }
        if (!clientAudited && privacyLevel !== 'SELF_ONLY') {
          const error = envelope(
            403,
            'unaudited_client_can_only_post_to_private_accounts',
            'Unaudited clients can only post to a private account. The publish attempt will be blocked when calling /publish/video/init/.',
          );
          reply(error.status, error.body);
          return;
        }
        const source = body.source_info?.source === 'FILE_UPLOAD' ? 'FILE_UPLOAD' : 'PULL_FROM_URL';
        const videoUrl = typeof body.source_info?.video_url === 'string' ? body.source_info.video_url : null;
        if (source === 'PULL_FROM_URL' && (videoUrl === null || videoUrl === '')) {
          // The documented invalid_param family: a PULL_FROM_URL
          // initiation requires the video_url.
          const error = envelope(400, 'invalid_param', 'video_url is required when source is PULL_FROM_URL.');
          reply(error.status, error.body);
          return;
        }
        publishSequence += 1;
        const publishId = `v_pub_url~double-${publishSequence}`;
        const publish: TikTokDoublePublish = {
          publishId,
          accountId: gate.accountId,
          privacyLevel,
          videoUrl,
          source,
          params: JSON.parse(bodyText) as Record<string, unknown>,
          publishStatus: 'PROCESSING_DOWNLOAD',
          failReason: null,
          // The public post id arrives only when the publish completes
          // for a publicly-viewable post (the advance patch carries it;
          // a private (SELF_ONLY) publish completes WITHOUT one).
          publicPostId: null,
        };
        publishesById.set(publishId, publish);
        reply(200, {
          data: {
            publish_id: publishId,
            ...(source === 'FILE_UPLOAD'
              ? { upload_url: `https://open-upload.tiktokapis.com/video/?upload_id=${publishSequence}&upload_token=double` }
              : {}),
          },
          error: { code: 'ok', message: '', log_id: `double-${randomUUID()}` },
        });
        return;
      }

      // ------------------------------------------------------------------
      // POST /v2/post/publish/status/fetch/ — the documented
      // publish-status fetch by publish_id.
      // ------------------------------------------------------------------
      if (endpoint === 'status-fetch') {
        const gate = prelude();
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const scope = scopeGate(gate.scopes, 'video.publish');
        if (!scope.ok) {
          reply(scope.status, scope.body);
          return;
        }
        let body: { publish_id?: unknown } = {};
        try {
          body = JSON.parse(bodyText) as typeof body;
        } catch {
          const error = envelope(400, 'invalid_params', 'The request body must be the documented JSON.');
          reply(error.status, error.body);
          return;
        }
        const publishId = typeof body.publish_id === 'string' ? body.publish_id : '';
        const publish = publishesById.get(publishId);
        if (publish === undefined) {
          // The documented invalid_publish_id answer.
          const error = envelope(400, 'invalid_publish_id', 'The publish_id does not exist');
          reply(error.status, error.body);
          return;
        }
        if (publish.publishStatus === 'PROCESSING_DOWNLOAD') {
          reply(200, {
            data: { status: 'PROCESSING_DOWNLOAD', downloaded_bytes: 10_000 },
            error: { code: 'ok', message: '', log_id: `double-${randomUUID()}` },
          });
          return;
        }
        if (publish.publishStatus === 'PUBLISH_COMPLETE') {
          reply(200, {
            data: {
              status: 'PUBLISH_COMPLETE',
              // The documented completion: the public post id is returned
              // only for publicly-viewable posts (a private-mode publish
              // completes with an EMPTY list).
              publicaly_available_post_id: publish.publicPostId !== null ? [publish.publicPostId] : [],
            },
            error: { code: 'ok', message: '', log_id: `double-${randomUUID()}` },
          });
          return;
        }
        // FAILED with the documented fail_reason.
        reply(200, {
          data: { status: 'FAILED', fail_reason: publish.failReason ?? 'video_pull_failed' },
          error: { code: 'ok', message: '', log_id: `double-${randomUUID()}` },
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
          const authorizationCode = `sandbox-tt-code-${randomUUID()}`;
          const refreshToken = `sandbox-tt-rt-${randomUUID()}`;
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
          creators.set(input.accountId, {
            accountId: input.accountId,
            privacyMode: input.privacyMode,
            dailyCapExhausted: false,
          });
        },
        setClientAudited(audited) {
          clientAudited = audited;
        },
        setDailyCapExhausted(accountId, exhausted) {
          const existing = creatorOf(accountId);
          creators.set(accountId, { ...existing, dailyCapExhausted: exhausted });
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
        advancePublish(publishId, state, patch) {
          const publish = publishesById.get(publishId);
          if (publish === undefined) return;
          publish.publishStatus = state;
          publish.failReason = patch?.failReason ?? (state === 'FAILED' ? 'video_pull_failed' : null);
          // A PUBLISH_COMPLETE advance carries the public post id ONLY
          // when the post is publicly viewable (an explicit null keeps
          // the private-mode completion — no public post id).
          publish.publicPostId =
            state === 'PUBLISH_COMPLETE'
              ? patch?.publicPostId !== undefined
                ? patch.publicPostId
                : Math.floor(Math.random() * 1_000_000_000) + 7_000_000_000
              : null;
        },
        publishes() {
          return [...publishesById.values()];
        },
        publishesOf(accountId) {
          return [...publishesById.values()].filter((publish) => publish.accountId === accountId);
        },
      });
    });
  });
}
