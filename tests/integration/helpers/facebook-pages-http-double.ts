/**
 * MKT-059 integration-test harness — the COMBINED FACEBOOK PAGES PROVIDER
 * DOUBLE: ONE in-process loopback HTTP server standing in for the
 * provider (NO external network — not callable from the sandbox and
 * deliberately not attempted), serving BOTH provider planes exactly
 * like the single provider identity behind the documented Facebook
 * Graph API Pages surface (the MKT-057/MKT-058 combined-double pattern):
 *
 *   1. the OAUTH token plane — the provider-neutral local OAuth
 *      protocol (the same fixture protocol as the canonical
 *      tests/integration/helpers/oauth-provider.ts: the token endpoint
 *      code/refresh exchange + the revocation endpoint + the
 *      resource-owner fixture endpoint minting authorization codes
 *      bound to external PAGE identities, VERBATIM scope lists and
 *      capability tags). The double implements the LocalOAuthProvider
 *      interface so it serves as the conformance suite's `provider`
 *      argument and the createLocalOAuthFlow backend (the Facebook
 *      Login surface the Pages API rides on);
 *
 *   2. the FACEBOOK GRAPH API PAGES plane — a faithful mirror of the
 *      DOCUMENTED endpoints the real adapter
 *      (src/modules/social-accounts/internal/adapters/facebook-pages/adapter.ts)
 *      calls, on the SAME origin (the connection's providerConfig
 *      .apiBaseUrl points here — the documented deployment override of
 *      the https://graph.facebook.com/v21.0 host; the platform
 *      HttpCallPort permits loopback http for exactly this test shape):
 *        GET  /me/accounts?fields=id,name,access_token,tasks
 *                                             (the page resolution +
 *                                              the per-Page page-token
 *                                              surface — "The Facebook
 *                                              Pages that a person owns
 *                                              or is able to perform
 *                                              tasks on"; a user
 *                                              without a Page answers
 *                                              the documented EMPTY
 *                                              data[] answer)
 *        GET  /{page-id}?fields=id,name,category,followers_count,
 *              fan_count                      (the Page node)
 *        GET  /{page-id}/feed?fields=..&limit=..&after=..
 *        GET  /{page-id}/posts?fields=..&limit=..&after=..
 *        GET  /{post-id}?fields=..           (the Post node)
 *        GET  /{page-id}/insights?metric=..&period=day&since=..&until=..
 *        GET  /{post-id}/insights?metric=..  (the lifetime post
 *                                             metrics)
 *        POST /{page-id}/feed | /{page-id}/photos | /{page-id}/videos
 *                                             (the publishing surfaces
 *                                              incl. the documented
 *                                              published=false +
 *                                              scheduled_publish_time
 *                                              scheduled/unpublished
 *                                              posts and temporary=true
 *                                              on scheduled photos)
 *        GET  /{provider-publish-id}?fields=is_published,published,
 *              scheduled_publish_time,created_time,status
 *                                             (the publish status
 *                                              poll over BOTH node
 *                                              kinds)
 *
 * Documented-semantics fidelity (the surfaces the double enforces —
 * every behavior below mirrors the LIVE Meta documentation verified at
 * delivery time; see docs/runbooks/MKT-059.md §2):
 *   - THE PAGE-TOKEN MODEL: the OAuth token binds the USER (the token's
 *     account = the bound PAGE identity of the social account); the
 *     documented GET /me/accounts resolution answers the PAGE entries of
 *     the user that page belongs to, each carrying the per-Page
 *     access_token ("Only returned if the User making the request has a
 *     role (other than Live Contributor) on the Page") and the tasks
 *     list ("The User's tasks assigned to the Page"). The page token then
 *     authenticates the Page-scoped operations;
 *   - THE ACCOUNT-TYPE ENFORCEMENT (the MKT-059 AC): a fixture page of
 *     accountType 'no-page' models the USER WITHOUT A PAGE — /me/accounts
 *     answers the documented EMPTY data[] answer (ZERO accounts), and
 *     every adapter operation surfaces the honest restricted refusal
 *     through it (never a fabricated success);
 *   - THE PAGE-ROLE/TASK ENFORCEMENT: the documented endpoint task
 *     requirements — the feed/posts edges require CREATE_CONTENT/MANAGE/
 *     MODERATE; the insights edges require ANALYZE; the publishing
 *     surfaces require CREATE_CONTENT — a task-restricted fixture page
 *     (accountType 'task-restricted': the ANALYZE/ADVERTISE tasks only)
 *     answers the provider's OWN documented code-200 permissions-error
 *     semantics on the task-gated surfaces (the account family and the
 *     ANALYZE-gated insights stay green);
 *   - the documented field-expansion summaries on the Post node
 *     (reactions.summary.total_count / comments.summary.total_count)
 *     and the shares count — NO view count exists on the node (views
 *     are post_impressions Insights metrics);
 *   - the documented data[]/paging.cursors.after pagination on the
 *     feed/posts edges (the paging.next presence marks the next page);
 *   - the documented feed semantics ("Published and unpublished posts
 *     will be returned when querying the /{page-id}/feed endpoint");
 *   - the documented metric validation on the insights edges (an
 *     undocumented metric answers the code-100 invalid-parameter
 *     family; the live vocabularies the adapter requests are served);
 *   - the documented SCHEDULED/UNPUBLISHED post lifecycle: a POST with
 *     published=false + scheduled_publish_time creates the post with
 *     is_published=false + the scheduled stamp (scheduled photos carry
 *     temporary=true per the documented requirement); advancePost moves
 *     the scheduled window (is_published → true = the window arrived);
 *   - the documented VIDEO processing window: POST /{page-id}/videos
 *     answers the video id with status.video_status=processing;
 *     advanceVideo moves it to ready (the page post goes live →
 *     published=true) or error (the processing failure);
 *   - THE DOCUMENTED PAGES BUC RATE SURFACE: every Page-token API call
 *     counts against the per-page rolling-window budget (the documented
 *     formula "Calls within 24 hours = 4800 * Number of Engaged Users");
 *     the exhaustion answers the documented code-80001 envelope '(#80001)
 *     There have been too many calls to this Page account. Wait a bit and
 *     try again.' with the X-Business-Use-Case-Usage header carrying the
 *     estimated_time_to_regain_call_capacity seconds (the observable
 *     backoff signal the adapter reports on the rate-limited failure
 *     observation);
 *   - the documented observable usage headers: every API-plane response
 *     carries X-App-Usage (call-count/CPU/time percentages); the
 *     scripted request-limit failures carry X-Business-Use-Case-Usage
 *     with the regain-capacity seconds;
 *   - per-endpoint FAILURE INJECTION (the documented envelope shapes).
 *
 * Scriptable/observation surface (in-process control — the test owns
 * the server object): per-endpoint failure scripting, the account
 * fixtures (registerAccount with the account type), the BUC call-limit
 * controls, the post/video advance, the per-endpoint request counts
 * (the inertness/zero-traffic assertions) and the sent-header
 * observation.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { LocalOAuthMode, LocalOAuthProvider } from './oauth-provider.ts';

// ---------------------------------------------------------------------------
// The fixture data model (the documented resource shapes)
// ---------------------------------------------------------------------------

/**
 * The fixture account type of a bound PAGE identity:
 *   - 'admin' (default): the user administers the Page (ALL documented
 *     tasks) — the golden path;
 *   - 'no-page': THE USER WITHOUT A PAGE — the documented /me/accounts
 *     answer is the EMPTY data[] list (ZERO accounts; the MKT-059
 *     account-type honesty battery);
 *   - 'task-restricted': the user's Page role carries the ANALYZE +
 *     ADVERTISE tasks only — the task-gated surfaces (feed/posts reads,
 *     publishing) answer the documented code-200 permissions-error
 *     semantics while the account family and the ANALYZE-gated insights
 *     stay green (the page-role honesty battery).
 */
export type FacebookPagesAccountType = 'admin' | 'no-page' | 'task-restricted';

/** The documented Page-task vocabulary (the subset the double gates on). */
type PageTask = 'CREATE_CONTENT' | 'MANAGE' | 'MODERATE' | 'ADVERTISE' | 'ANALYZE';

const ADMIN_TASKS: readonly PageTask[] = ['CREATE_CONTENT', 'MANAGE', 'MODERATE', 'ADVERTISE', 'ANALYZE'];
const TASK_RESTRICTED_TASKS: readonly PageTask[] = ['ADVERTISE', 'ANALYZE'];
/** The documented feed/posts read task requirements (any of the three). */
const FEED_READ_TASKS: readonly PageTask[] = ['CREATE_CONTENT', 'MANAGE', 'MODERATE'];

export interface FacebookPagesDoublePage {
  readonly pageId: string;
  readonly accountType: FacebookPagesAccountType;
  /** The documented Page node fields. */
  readonly name: string;
  readonly category: string;
  readonly followersCount: number;
  readonly fanCount: number;
}

export interface FacebookPagesDoublePost {
  readonly postId: string;
  readonly pageId: string;
  /** The author of the post (the Page itself or a visitor user). */
  readonly fromId: string;
  readonly fromName: string;
  readonly message: string;
  readonly createdTime: string;
  readonly permalinkUrl: string;
  readonly statusType: string;
  isPublished: boolean;
  scheduledPublishTime: number | null;
  readonly likeTotal: number;
  readonly commentTotal: number;
  readonly shareCount: number;
}

/** The recorded Page video (the documented video processing window). */
interface RecordedVideo {
  readonly videoId: string;
  readonly pageId: string;
  videoStatus: 'processing' | 'ready' | 'error';
  published: boolean;
  scheduledPublishTime: number | null;
  readonly params: Readonly<Record<string, string>>;
}

/** The per-endpoint scripted failure (the documented envelope shape). */
export interface FacebookPagesScriptedFailure {
  /** The HTTP status of the documented answer (the Graph norm is 400; 5xx for server errors). */
  readonly status: number;
  /**
   * The documented envelope code (10 the permission class; 4/17/32/613/80001
   * the request-limit classes; 190 the token class; 100 the
   * invalid-parameter class; 200 the permissions-error/task class).
   */
  readonly code: number;
  readonly message: string;
  readonly type?: string;
  readonly errorSubcode?: number;
  /** The documented observable backoff seconds (rides X-Business-Use-Case-Usage estimated_time_to_regain_call_capacity). */
  readonly retryAfterSeconds?: number | null;
}

export type FacebookPagesDoubleEndpoint =
  | 'accounts'
  | 'page-node'
  | 'feed'
  | 'posts'
  | 'post-node'
  | 'page-insights'
  | 'post-insights'
  | 'feed-publish'
  | 'photo-publish'
  | 'video-publish'
  | 'publish-status';

/**
 * The documented Pages BUC default (the rolling 24h window budget —
 * 'Calls within 24 hours = 4800 * Number of Engaged Users'; the default
 * fixture uses a generous engaged-user count so the batteries never trip
 * it accidentally; the BUC battery lowers it).
 */
const DEFAULT_BUC_CALL_LIMIT = 4800 * 100;

/** The documented live day-period Page insight metrics (the vocabulary the double serves). */
const PAGE_INSIGHT_METRICS = ['page_impressions', 'page_post_engagements', 'page_views_total', 'page_fans'] as const;
/** The documented live lifetime post insight metrics. */
const POST_INSIGHT_METRICS = [
  'post_clicks',
  'post_impressions_organic',
  'post_impressions_paid',
  'post_reactions_like_total',
] as const;

/** The default fixture page of an unknown bound page id (an administered Page). */
function defaultPageOf(pageId: string): FacebookPagesDoublePage {
  return {
    pageId,
    accountType: 'admin',
    name: `Page of ${pageId}`,
    category: 'Marketing Agency',
    followersCount: 1337,
    fanCount: 2048,
  };
}

/** The default own-post fixtures of a page (the documented Page posts edge view). */
function defaultPostsOf(pageId: string): FacebookPagesDoublePost[] {
  const own = [1, 2, 3].map((index): FacebookPagesDoublePost => ({
    postId: `page-post-${pageId}-${index}`,
    pageId,
    fromId: pageId,
    fromName: `Page of ${pageId}`,
    message: `Fixture Page post ${index} of ${pageId}`,
    createdTime: `2026-08-0${index}T10:00:00.000Z`,
    permalinkUrl: `https://www.facebook.com/double-${pageId}/posts/${index}/`,
    statusType: 'added_photos',
    isPublished: true,
    scheduledPublishTime: null,
    likeTotal: 50 * index,
    commentTotal: 5 * index,
    shareCount: 3 * index,
  }));
  // The documented feed semantics: the feed edge additionally carries
  // the visitor/user posts (the public discovery surface).
  const visitors = [0, 1].map(
    (index): FacebookPagesDoublePost => ({
      postId: `page-feed-post-${pageId}-${index}`,
      pageId,
      fromId: `visitor-${pageId}-${index}`,
      fromName: `Visitor ${index}`,
      message: `Public visitor post ${index} on the Page of ${pageId}`,
      createdTime: '2026-08-01T08:00:00.000Z',
      permalinkUrl: `https://www.facebook.com/double-${pageId}/posts/visitor-${index}/`,
      statusType: 'mobile_status_update',
      isPublished: true,
      scheduledPublishTime: null,
      likeTotal: 20 * (index + 1),
      commentTotal: 4 * (index + 1),
      shareCount: 2 * (index + 1),
    }),
  );
  return [...own, ...visitors];
}

export interface FacebookPagesProviderDouble extends LocalOAuthProvider {
  /** The number of API-plane requests received per endpoint (the zero-traffic assertions). */
  requestCount(endpoint: FacebookPagesDoubleEndpoint): number;
  /** The total number of API-plane requests received. */
  totalRequestCount(): number;
  /**
   * Registers (or replaces) a fixture page bound to an OAuth account id —
   * the ACCOUNT TYPE drives the documented /me/accounts + task
   * enforcement (admin | no-page | task-restricted).
   */
  registerAccount(input: {
    readonly pageId: string;
    readonly accountType: FacebookPagesAccountType;
  }): void;
  /** Replaces the per-page BUC call budget (the documented Pages rolling-window surface). */
  setBucCallLimit(limit: number): void;
  /** The consumed Page-token call count of a page in the current window. */
  bucCallCount(pageId: string): number;
  /** Resets the BUC window accounting. */
  resetBucWindow(): void;
  /** Scripts a documented error envelope on an endpoint (null clears). */
  scriptFailure(endpoint: FacebookPagesDoubleEndpoint, failure: FacebookPagesScriptedFailure | null): void;
  /** Moves a scheduled/unpublished post to the published state (the scheduled-window arrival). */
  advancePost(postId: string): void;
  /** Moves a recorded video to a later processing state (the video processing window). */
  advanceVideo(videoId: string, state: 'ready' | 'error'): void;
  /** The recorded Page posts of a page (incl. the published fixtures). */
  postsOf(pageId: string): readonly FacebookPagesDoublePost[];
  /** The recorded Page videos. */
  videos(): readonly RecordedVideo[];
  /** The most recent X-App-Usage header value sent (the documented observable usage header — the fidelity assertion). */
  lastAppUsageHeader(): string | null;
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

/** Boots the COMBINED Facebook Pages provider double (OAuth plane + documented Pages API plane, one loopback origin). */
export function startFacebookPagesProviderDouble(): Promise<FacebookPagesProviderDouble> {
  const authorizations = new Map<string, AuthorizationFixture>();
  const refreshTokens = new Map<string, AuthorizationFixture>();
  /** The USER-token → bound PAGE identity binding (minted at exchange time). */
  const tokenPages = new Map<string, string>();
  /** The fixture pages by their bound PAGE id. */
  const pages = new Map<string, FacebookPagesDoublePage>();
  const postsByPage = new Map<string, FacebookPagesDoublePost[]>();
  const postsById = new Map<string, FacebookPagesDoublePost>();
  const videosById = new Map<string, RecordedVideo>();
  const scripted = new Map<FacebookPagesDoubleEndpoint, FacebookPagesScriptedFailure>();
  const requestCounts = new Map<FacebookPagesDoubleEndpoint, number>();
  /** The documented per-page BUC window: the Page-token call accounting. */
  const bucCalls = new Map<string, number>();
  let bucCallLimit = DEFAULT_BUC_CALL_LIMIT;
  let mode: LocalOAuthMode = 'ok';
  let exchanges = 0;
  let revokes = 0;
  let postSequence = 0;
  let videoSequence = 0;
  let lastAppUsage = 'null';

  const pageOf = (pageId: string): FacebookPagesDoublePage => {
    const existing = pages.get(pageId);
    if (existing !== undefined) return existing;
    const fresh = defaultPageOf(pageId);
    pages.set(pageId, fresh);
    postsOf(fresh.pageId);
    return fresh;
  };

  const postsOf = (pageId: string): FacebookPagesDoublePost[] => {
    const existing = postsByPage.get(pageId);
    if (existing !== undefined) return existing;
    const fresh = defaultPostsOf(pageId);
    postsByPage.set(pageId, fresh);
    for (const post of fresh) postsById.set(post.postId, post);
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
        const appUsage = JSON.stringify({ call_count: 9.13, total_cputime: 0.07, total_time: 0.05 });
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
        const accessToken = `sandbox-fb-at-${randomUUID()}`;
        const refreshToken = `sandbox-fb-rt-${randomUUID()}`;
        const fresh: AuthorizationFixture = { ...fixture, refreshToken };
        refreshTokens.set(refreshToken, fresh);
        tokenPages.set(accessToken, fixture.accountId);
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
      // The Facebook Graph API Pages plane (the documented endpoints).
      // ------------------------------------------------------------------
      const bearer = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '');
      const pathParts = url.pathname.split('/').filter((part) => part !== '');
      const pathId = pathParts[0] ?? '';
      const suffix = pathParts[1] ?? '';

      const endpointOf = (path: string, method: string): FacebookPagesDoubleEndpoint | null => {
        if (pathId === undefined) return null;
        if (method === 'GET' && pathId === 'me' && suffix === 'accounts') return 'accounts';
        const fields = url.searchParams.get('fields') ?? '';
        if (method === 'GET' && suffix === 'feed') return 'feed';
        if (method === 'GET' && suffix === 'posts') return 'posts';
        if (method === 'GET' && suffix === 'insights') {
          return postsById.has(pathId) ? 'post-insights' : 'page-insights';
        }
        if (method === 'POST' && suffix === 'feed') return 'feed-publish';
        if (method === 'POST' && suffix === 'photos') return 'photo-publish';
        if (method === 'POST' && suffix === 'videos') return 'video-publish';
        if (method === 'GET' && suffix === '') {
          // The exact field TOKENS distinguish the node kinds (a plain
          // substring check would false-positive: the Post-node field
          // set carries status_type/is_published whose SUBSTRINGS are
          // status/published). The publish-status poll requests BOTH
          // node kinds' fields (is_published + published + status); the
          // Page node requests the profile fields; everything else is
          // the Post node.
          const fieldTokens = new Set(
            fields
              .split(',')
              .map((field) => field.trim().split('.')[0]?.trim() ?? ''),
          );
          if (fieldTokens.has('is_published') && (fieldTokens.has('published') || fieldTokens.has('status'))) {
            return 'publish-status';
          }
          if (fieldTokens.has('category') || fieldTokens.has('followers_count')) return 'page-node';
          return 'post-node';
        }
        return null;
      };
      const endpoint = endpointOf(url.pathname, req.method ?? 'GET');
      if (endpoint === null) {
        reply(404, { error: 'not_found' });
        return;
      }

      requestCounts.set(endpoint, (requestCounts.get(endpoint) ?? 0) + 1);

      /** The bearer-token → bound PAGE identity resolution (the token binds the page identity). */
      const pageIdOfToken = (): string | null => {
        if (bearer === null) return null;
        const bound = tokenPages.get(bearer[1]!);
        return bound ?? null;
      };

      /** The per-page token minting (the documented per-Page access_token surface — the token binds the page identity). */
      const pageTokenOf = (pageId: string): string => {
        const pageToken = `sandbox-fb-page-${pageId}-${randomUUID()}`;
        tokenPages.set(pageToken, pageId);
        return pageToken;
      };

      /**
       * The documented prelude: scripted failures, bearer validation, the
       * /me/accounts answer. The Page-token operations additionally ride
       * the BUC accounting (every Page-token call counts against the
       * per-page rolling-window budget; the exhaustion answers the
       * documented code-80001 envelope with the regain-capacity header).
       */
      const prelude = (
        isPageTokenCall: boolean,
      ): { ok: true; pageId: string } | { ok: false; status: number; body: string; headers: Record<string, string> } => {
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
                      [scriptedFailure.code === 32 || scriptedFailure.code === 80001 ? '123456789012345' : 'app']: [
                        {
                          call_count: 100,
                          total_cputime: 8,
                          total_time: 6,
                          type: 'pages',
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
        const pageId = pageIdOfToken();
        if (pageId === null) {
          const error = envelope(400, 190, 'The access token does not resolve to a Facebook Page identity.', 'OAuthException');
          return { ok: false, status: error.status, body: error.body, headers: {} };
        }
        if (isPageTokenCall) {
          // The documented Pages BUC accounting: the Page-token calls
          // count against the per-page rolling-window budget.
          const consumed = bucCalls.get(pageId) ?? 0;
          if (consumed >= bucCallLimit) {
            const error = envelope(
              400,
              80001,
              '(#80001) There have been too many calls to this Page account. Wait a bit and try again. For more info, please refer to https://developers.facebook.com/docs/graph-api/overview/rate-limiting.',
              'OAuthException',
            );
            return {
              ok: false,
              status: error.status,
              body: error.body,
              headers: {
                'x-business-use-case-usage': JSON.stringify({
                  [pageId]: [
                    {
                      call_count: 100,
                      total_cputime: 8,
                      total_time: 6,
                      type: 'pages',
                      estimated_time_to_regain_call_capacity: 180,
                    },
                  ],
                }),
              },
            };
          }
          bucCalls.set(pageId, consumed + 1);
        }
        return { ok: true, pageId };
      };

      /** The documented task check (the Page-role enforcement): the provider's own error semantics. */
      const taskGate = (pageId: string, requiredTasks: readonly PageTask[]): boolean => {
        const page = pageOf(pageId);
        const tasks =
          page.accountType === 'task-restricted' ? TASK_RESTRICTED_TASKS : page.accountType === 'admin' ? ADMIN_TASKS : [];
        return requiredTasks.some((task) => tasks.includes(task));
      };

      /** The documented permissions-error answer of a task-gated surface. */
      const taskRefused = (): { ok: false; status: number; body: string; headers: Record<string, string> } => {
        const error = envelope(
          400,
          200,
          '(#200) Permissions error — the user must be able to perform the required task on the Page (the documented Page-role/task requirement of this endpoint)',
          'OAuthException',
        );
        return { ok: false, status: error.status, body: error.body, headers: {} };
      };

      /** The documented Post-node answer shape (the field subset the fields param requests). */
      const postNode = (post: FacebookPagesDoublePost, fields: string): Record<string, unknown> => {
        const node: Record<string, unknown> = { id: post.postId };
        if (fields.includes('from')) node['from'] = { id: post.fromId, name: post.fromName };
        if (fields.includes('message')) node['message'] = post.message;
        if (fields.includes('story')) node['story'] = undefined;
        if (fields.includes('created_time')) node['created_time'] = post.createdTime;
        if (fields.includes('permalink_url')) node['permalink_url'] = post.permalinkUrl;
        if (fields.includes('status_type')) node['status_type'] = post.statusType;
        if (fields.includes('is_published')) node['is_published'] = post.isPublished;
        if (fields.includes('scheduled_publish_time') && post.scheduledPublishTime !== null)
          node['scheduled_publish_time'] = post.scheduledPublishTime;
        if (fields.includes('shares')) node['shares'] = { count: post.shareCount };
        if (fields.includes('reactions')) node['reactions'] = { summary: { total_count: post.likeTotal } };
        if (fields.includes('comments')) node['comments'] = { summary: { total_count: post.commentTotal } };
        return node;
      };

      // ------------------------------------------------------------------
      // GET /me/accounts — the documented page resolution + per-Page
      // page-token surface.
      // ------------------------------------------------------------------
      if (endpoint === 'accounts') {
        const gate = prelude(false);
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const page = pageOf(gate.pageId);
        // THE ACCOUNT-TYPE ENFORCEMENT (the MKT-059 AC): a user WITHOUT
        // a Page resolves ZERO accounts through the documented surface
        // — the documented EMPTY data[] answer (never a fabricated
        // entry, never a fabricated success).
        if (page.accountType === 'no-page') {
          reply(200, { data: [], paging: { cursors: {}, next: null } });
          return;
        }
        // The documented answer: the Page entries the user can perform
        // tasks on, each carrying the per-Page access_token + the
        // tasks list (the passthrough page-role facts).
        const tasks =
          page.accountType === 'task-restricted' ? TASK_RESTRICTED_TASKS : ADMIN_TASKS;
        reply(200, {
          data: [
            {
              id: page.pageId,
              name: page.name,
              access_token: pageTokenOf(page.pageId),
              tasks: [...tasks],
            },
          ],
          paging: { cursors: {}, next: null },
        });
        return;
      }

      // ------------------------------------------------------------------
      // GET /{page-id} — the Page node (the profile fields). Any Page
      // role reads the own Page node (the documented owned-data rule).
      // ------------------------------------------------------------------
      if (endpoint === 'page-node') {
        const gate = prelude(true);
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const page = pageOf(pathId);
        const fields = url.searchParams.get('fields') ?? '';
        const node: Record<string, unknown> = { id: page.pageId };
        if (fields.includes('name')) node['name'] = page.name;
        if (fields.includes('category')) node['category'] = page.category;
        if (fields.includes('followers_count')) node['followers_count'] = page.followersCount;
        if (fields.includes('fan_count')) node['fan_count'] = page.fanCount;
        reply(200, node);
        return;
      }

      // ------------------------------------------------------------------
      // GET /{page-id}/feed — the documented Page feed (the Page's own
      // posts + the visitor/user posts; published AND unpublished posts).
      // ------------------------------------------------------------------
      if (endpoint === 'feed') {
        const gate = prelude(true);
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        // The documented task requirement (CREATE_CONTENT/MANAGE/MODERATE).
        if (!taskGate(gate.pageId, FEED_READ_TASKS)) {
          const refused = taskRefused();
          reply(refused.status, refused.body, refused.headers);
          return;
        }
        const fields = url.searchParams.get('fields') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? '25');
        const after = url.searchParams.get('after');
        const all = postsOf(gate.pageId);
        const pageTwo = after === 'fb-page-2';
        const slice = pageTwo ? all.slice(2) : all.slice(0, Math.max(limit, 1));
        reply(200, {
          data: slice.map((post) => postNode(post, fields)),
          paging: {
            cursors: { after: 'fb-page-2' },
            next: !pageTwo && all.length > Math.max(limit, 1) ? `${url.origin}${url.pathname}?after=fb-page-2` : null,
          },
        });
        return;
      }

      // ------------------------------------------------------------------
      // GET /{page-id}/posts — the Page's own published posts.
      // ------------------------------------------------------------------
      if (endpoint === 'posts') {
        const gate = prelude(true);
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        // The documented task requirement (CREATE_CONTENT/MANAGE/MODERATE).
        if (!taskGate(gate.pageId, FEED_READ_TASKS)) {
          const refused = taskRefused();
          reply(refused.status, refused.body, refused.headers);
          return;
        }
        const fields = url.searchParams.get('fields') ?? '';
        const limit = Number(url.searchParams.get('limit') ?? '25');
        const after = url.searchParams.get('after');
        const own = postsOf(gate.pageId).filter((post) => post.fromId === gate.pageId && post.isPublished);
        const pageTwo = after === 'fb-page-2';
        const slice = pageTwo ? own.slice(2) : own.slice(0, Math.max(limit, 1));
        reply(200, {
          data: slice.map((post) => postNode(post, fields)),
          paging: {
            cursors: { after: 'fb-page-2' },
            next: !pageTwo && own.length > Math.max(limit, 1) ? `${url.origin}${url.pathname}?after=fb-page-2` : null,
          },
        });
        return;
      }

      // ------------------------------------------------------------------
      // GET /{post-id} — the single-content read (the Post node).
      // ------------------------------------------------------------------
      if (endpoint === 'post-node') {
        const gate = prelude(true);
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        if (!taskGate(gate.pageId, FEED_READ_TASKS)) {
          const refused = taskRefused();
          reply(refused.status, refused.body, refused.headers);
          return;
        }
        const post = postsById.get(pathId);
        if (post === undefined) {
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
        reply(200, postNode(post, fields));
        return;
      }

      // ------------------------------------------------------------------
      // GET /{page-id}/insights — the day-period Page insights.
      // ------------------------------------------------------------------
      if (endpoint === 'page-insights') {
        const gate = prelude(true);
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        // The documented insights requirement: the ANALYZE task.
        if (!taskGate(gate.pageId, ['ANALYZE'])) {
          const refused = taskRefused();
          reply(refused.status, refused.body, refused.headers);
          return;
        }
        const metrics = (url.searchParams.get('metric') ?? '').split(',').filter((m) => m !== '');
        for (const metric of metrics) {
          if (!(PAGE_INSIGHT_METRICS as readonly string[]).includes(metric)) {
            const error = envelope(
              400,
              100,
              `(#100) The metric '${metric}' is not a documented day-period Page insight metric`,
              'GraphMethodException',
            );
            reply(error.status, error.body);
            return;
          }
        }
        const page = pageOf(gate.pageId);
        void page;
        const facts: Record<string, number> = {
          page_impressions: 12345,
          page_post_engagements: 678,
          page_views_total: 910,
          page_fans: 2048,
        };
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
      // GET /{post-id}/insights — the lifetime post insights.
      // ------------------------------------------------------------------
      if (endpoint === 'post-insights') {
        const gate = prelude(true);
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        if (!taskGate(gate.pageId, ['ANALYZE'])) {
          const refused = taskRefused();
          reply(refused.status, refused.body, refused.headers);
          return;
        }
        const post = postsById.get(pathId);
        if (post === undefined) {
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
        for (const metric of metrics) {
          if (!(POST_INSIGHT_METRICS as readonly string[]).includes(metric)) {
            // The documented validation: requesting an undocumented
            // metric answers the code-100 invalid-parameter family.
            const error = envelope(
              400,
              100,
              `(#100) The metric '${metric}' is not a documented lifetime post insight metric`,
              'GraphMethodException',
            );
            reply(error.status, error.body);
            return;
          }
        }
        const lengthFactor = Math.max(post.postId.length, 1);
        const facts: Record<string, number> = {
          post_clicks: 40 * lengthFactor,
          post_impressions_organic: 1200 * lengthFactor,
          post_impressions_paid: 300 * lengthFactor,
          post_reactions_like_total: 60 * lengthFactor,
        };
        reply(200, {
          data: metrics.map((metric) => ({
            name: metric,
            period: 'lifetime',
            title: metric,
            values: [{ value: facts[metric] ?? 0 }],
          })),
        });
        return;
      }

      // ------------------------------------------------------------------
      // POST /{page-id}/feed | /{page-id}/photos | /{page-id}/videos —
      // the documented publishing surfaces.
      // ------------------------------------------------------------------
      if (endpoint === 'feed-publish' || endpoint === 'photo-publish' || endpoint === 'video-publish') {
        const gate = prelude(true);
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        // The documented publish requirement: the CREATE_CONTENT task
        // ("If you can perform the CREATE_CONTENT task, you will need:
        // A Page access token, The pages_manage_posts permission...").
        if (!taskGate(gate.pageId, ['CREATE_CONTENT'])) {
          const refused = taskRefused();
          reply(refused.status, refused.body, refused.headers);
          return;
        }
        const params: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(bodyText).entries()) {
          params[key] = value;
        }
        if (endpoint === 'video-publish') {
          // The documented video surface: the answer is the VIDEO id
          // riding the processing window (the page post about the
          // video goes live after processing / at the scheduled time).
          videoSequence += 1;
          const videoId = `page-video-${gate.pageId}-${videoSequence}`;
          const scheduled = params['published'] === 'false' && params['scheduled_publish_time'] !== undefined;
          videosById.set(videoId, {
            videoId,
            pageId: gate.pageId,
            videoStatus: 'processing',
            published: false,
            scheduledPublishTime: scheduled ? Number(params['scheduled_publish_time']) : null,
            params,
          });
          reply(200, { id: videoId });
          return;
        }
        // The documented provider-side validation: a feed publish
        // requires message or link; a photo publish requires url.
        if (endpoint === 'feed-publish' && (params['message'] ?? '') === '' && (params['link'] ?? '') === '') {
          const error = envelope(
            400,
            100,
            '(#100) The feed publish request carries neither message nor link — one of the two is required',
            'GraphMethodException',
          );
          reply(error.status, error.body);
          return;
        }
        if (endpoint === 'photo-publish' && (params['url'] ?? '') === '') {
          const error = envelope(
            400,
            100,
            '(#100) The photo publish request carries no url — the documented photo source is required',
            'GraphMethodException',
          );
          reply(error.status, error.body);
          return;
        }
        // The documented post creation: the answer is the post id. A
        // scheduled publish (published=false + scheduled_publish_time)
        // creates the post with is_published=false + the scheduled
        // stamp; an immediate publish creates the live post.
        postSequence += 1;
        const postId = `${gate.pageId}_page-publish-${postSequence}`;
        const scheduled = params['published'] === 'false' && params['scheduled_publish_time'] !== undefined;
        const post: FacebookPagesDoublePost = {
          postId,
          pageId: gate.pageId,
          fromId: gate.pageId,
          fromName: pageOf(gate.pageId).name,
          message: params['message'] ?? params['caption'] ?? params['description'] ?? '',
          createdTime: '2026-08-02T12:00:00.000Z',
          permalinkUrl: `https://www.facebook.com/double-${gate.pageId}/posts/publish-${postSequence}/`,
          statusType: endpoint === 'photo-publish' ? 'added_photos' : 'mobile_status_update',
          isPublished: !scheduled,
          scheduledPublishTime: scheduled ? Number(params['scheduled_publish_time']) : null,
          likeTotal: 0,
          commentTotal: 0,
          shareCount: 0,
        };
        postsById.set(postId, post);
        postsByPage.set(gate.pageId, [...postsOf(gate.pageId), post]);
        reply(200, { id: postId });
        return;
      }

      // ------------------------------------------------------------------
      // GET /{provider-publish-id}?fields=is_published,published,
      //   scheduled_publish_time,created_time,status — the publish
      //   status poll (the Post AND Video node kinds).
      // ------------------------------------------------------------------
      if (endpoint === 'publish-status') {
        const gate = prelude(true);
        if (!gate.ok) {
          reply(gate.status, gate.body, gate.headers);
          return;
        }
        const post = postsById.get(pathId);
        const video = videosById.get(pathId);
        if (post === undefined && video === undefined) {
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
        if (video !== undefined) {
          // The documented Video node: published + status.video_status.
          reply(200, {
            id: video.videoId,
            published: video.published,
            scheduled_publish_time: video.scheduledPublishTime ?? undefined,
            status: { video_status: video.videoStatus },
          });
          return;
        }
        // The documented Post node: is_published + the scheduled stamp.
        reply(200, {
          id: post!.postId,
          is_published: post!.isPublished,
          scheduled_publish_time: post!.scheduledPublishTime ?? undefined,
          created_time: post!.createdTime,
          status: post!.isPublished ? { video_status: 'ready' } : { video_status: 'processing' },
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
          const authorizationCode = `sandbox-fb-code-${randomUUID()}`;
          const refreshToken = `sandbox-fb-rt-${randomUUID()}`;
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
          pages.set(input.pageId, {
            ...defaultPageOf(input.pageId),
            accountType: input.accountType,
          });
          postsOf(input.pageId);
        },
        setBucCallLimit(limit) {
          bucCallLimit = limit;
        },
        bucCallCount(pageId) {
          return bucCalls.get(pageId) ?? 0;
        },
        resetBucWindow() {
          bucCalls.clear();
        },
        scriptFailure(endpoint, failure) {
          if (failure === null) {
            scripted.delete(endpoint);
          } else {
            scripted.set(endpoint, failure);
          }
        },
        advancePost(postId) {
          const post = postsById.get(postId);
          if (post === undefined) return;
          post.isPublished = true;
        },
        advanceVideo(videoId, state) {
          const video = videosById.get(videoId);
          if (video === undefined) return;
          video.videoStatus = state;
          video.published = state === 'ready';
        },
        postsOf(pageId) {
          return [...postsOf(pageId)];
        },
        videos() {
          return [...videosById.values()];
        },
        lastAppUsageHeader() {
          return lastAppUsage;
        },
      });
    });
  });
}
