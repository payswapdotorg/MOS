/**
 * MKT-059 — the CONCRETE FACEBOOK PAGES SOCIAL PLATFORM ADAPTER (the third
 * MKT-056 SocialPlatformAdapter implementation, after MKT-057 YouTube and
 * MKT-058 Instagram): the honest capability matrix + the documented
 * Facebook Graph API PAGES surface (first-party Page content discovery,
 * insights and publishing through the documented Pages API over the
 * Facebook Login OAuth surface) mapped onto the frozen normalized
 * capability plane, over the platform HttpCallPort (fetch-based, ZERO
 * provider SDKs — the /integrations INT-001 discipline and the arch-check
 * EXTERNAL_PACKAGE_IN_SRC rule).
 *
 * ONE-FILE SUBTREE (the arch-check adapter classification, the MKT-057/
 * MKT-058 precedent): every file under an 'adapters' path segment is a
 * CONCRETE ADAPTER — the matrix and the adapter implementation share this
 * single file because a second subtree file would be an adapter importing
 * another adapter (ADAPTER_COUPLING). The frozen contract itself is
 * imported from the module-internal contract
 * ('../../adapter-contract.ts'), NOT through the
 * internal/adapters/adapter-contract.ts re-export shim — the shim is
 * itself under an adapters path segment, so importing it from this
 * subtree would be the same ADAPTER_COUPLING violation; the direct
 * same-module import is the only arch-check-legal form of the sanctioned
 * dependency on the frozen contract.
 *
 * PROVIDER EVIDENCE (the documented surfaces this adapter maps — the
 * full evidence section with URLs lives in docs/runbooks/MKT-059.md; the
 * documented facts were verified against the LIVE Meta documentation at
 * delivery time, Graph API v26.0 references):
 *   - the Facebook Pages API overview (the Page access token model):
 *     https://developers.facebook.com/docs/pages/
 *     ("To interact with the Pages API, a Page access token is required.
 *     This token is obtained via user authentication... The app uses the
 *     token to request a Page access token"; the documented permission
 *     list: pages_show_list 'Show Pages managed by a user',
 *     pages_read_engagement 'Read content posted to the Page',
 *     pages_manage_posts 'Publish and schedule content',
 *     pages_manage_engagement 'Moderate comments, delete posts',
 *     pages_read_user_content 'Read user-generated content on the Page');
 *   - the documented PAGE-RESOLUTION + page-token surface: the User
 *     accounts edge GET /me/accounts
 *     (https://developers.facebook.com/docs/graph-api/reference/user/accounts/
 *     — "The Facebook Pages that a person owns or is able to perform
 *     tasks on"; the Page node's access_token field: "The Page's access
 *     token. Only returned if the User making the request has a role
 *     (other than Live Contributor) on the Page"; the tasks field: "The
 *     User's tasks assigned to the Page"). A USER WITHOUT A PAGE resolves
 *     ZERO accounts through this surface (the documented empty data[]
 *     answer) — personal-profile publishing is NOT a fabricatable
 *     capability (the honest analog of Instagram's Business/Creator
 *     rule, MKT-058);
 *   - the Page node (GET /{page-id}?fields=...):
 *     https://developers.facebook.com/docs/graph-api/reference/page/
 *     (id, name, category, followers_count 'Number of page followers',
 *     fan_count 'The number of users who like the Page');
 *   - the Page feed edge (GET + POST):
 *     https://developers.facebook.com/docs/graph-api/reference/page/feed/
 *     — reading: "The person requesting the access token must be able to
 *     perform one of the following tasks on the Page: CREATE_CONTENT /
 *     MANAGE / MODERATE ... The pages_read_engagement permission, The
 *     pages_read_user_content permission"; "Published and unpublished
 *     posts will be returned when querying the /{page-id}/feed
 *     endpoint"; "You can only read a maximum of 100 feed posts with the
 *     limit field"; publishing: "Requirements: If you can perform the
 *     CREATE_CONTENT task, you will need: A Page access token, The
 *     pages_manage_posts permission, The pages_read_engagement
 *     permission, The pages_show_list permission"; the documented
 *     SCHEDULED/UNPUBLISHED post semantics: published ("Whether a story
 *     is shown about this newly published object... Unpublished posts
 *     can be used in ads") + scheduled_publish_time ("UNIX timestamp
 *     indicating when post should go live. Must be date between 10
 *     minutes and 75 days from the time of the API request");
 *   - the Page posts edge (the Page's own published posts):
 *     https://developers.facebook.com/docs/graph-api/reference/page/posts/
 *     ("The posts of a Facebook Page" — the own-content listing);
 *   - the Post node (GET /{post-id}?fields=...):
 *     https://developers.facebook.com/docs/graph-api/reference/post/
 *     (is_published "Indicates whether a scheduled post was published
 *     (applies to scheduled Page Post only...)", scheduled_publish_time
 *     "UNIX timestamp of the scheduled publish time for the post",
 *     shares {count}, created_time, permalink_url, from, status_type);
 *   - the Page photos edge (POST /{page-id}/photos?url=...):
 *     https://developers.facebook.com/docs/graph-api/reference/page/photos/
 *     ("Uploading an unpublished photo: ... adding the argument
 *     published=false ... If the photo is used in a scheduled post,
 *     temporary=true must be used"; permissions pages_manage_posts +
 *     pages_show_list);
 *   - the Page videos edge (POST /{page-id}/videos?file_url=...):
 *     https://developers.facebook.com/docs/graph-api/reference/page/videos/
 *     (file_url "Accessible URL of a video file", description,
 *     scheduled_publish_time "Time when the page post about this video
 *     should go live, this should be between 10 mins and 6 months";
 *     permissions pages_manage_posts, pages_read_engagement,
 *     pages_show_list);
 *   - the Page insights edge (GET /{page-id}/insights and
 *     GET /{post-id}/insights):
 *     https://developers.facebook.com/docs/graph-api/reference/page/insights/
 *     — "Represents insights for Facebook Pages and Page posts";
 *     Requirements: "A Page access token requested by a person who can
 *     perform the ANALYZE task on the Page ... Permissions: read_insights,
 *     pages_read_engagement"; the documented live metric vocabularies:
 *     the day-period Page metrics (page_impressions, page_post_engagements,
 *     page_views_total, page_fans) and the lifetime post metrics
 *     (post_clicks, post_impressions_organic, post_impressions_paid,
 *     post_reactions_like_total) — the basic post_impressions metric is
 *     deprecated above Graph API v25 (the verified live vocabulary avoids
 *     it); "Only 90 days of insights can be viewed at one time when using
 *     the since and until parameters";
 *   - Graph API rate limiting (the documented Page-level Business-Use-Case
 *     surfaces and their error codes):
 *     https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
 *     — the Pages BUC formula: "Calls within 24 hours = 4800 * Number of
 *     Engaged Users" ("The Number of Engaged Users is the number of Users
 *     who engaged with the Page per 24 hours"); the documented error
 *     codes: "error code 32 — Page calls made with a User access token,
 *     error code 80001 — Page calls made with a Page or System User access
 *     token" (plus the app-level code 4, user-level code 17 and the 613
 *     request-limit class); the documented sample envelope '(#80001) There
 *     have been too many calls to this Page account. Wait a bit and try
 *     again.'; the observable X-App-Usage / X-Business-Use-Case-Usage
 *     usage headers (call-count/CPU/time percentages and
 *     estimated_time_to_regain_access / estimated_time_to_regain_call_capacity
 *     seconds where the provider throttles).
 *
 * WHAT THIS ADAPTER HOLDS (the frozen port contract,
 * ../../adapter-contract.ts):
 *   - invocation failures return as DATA (the frozen seven-code
 *     taxonomy), NEVER thrown — only malformed input throws;
 *   - the provider payload rides VERBATIM as passthrough data (the
 *     normalized record shapes record, they never interpret — MKT-062
 *     owns content normalization);
 *   - engagement observations are NULLABLE facts (only what the
 *     documented API exposes: the Post node carries the reactions
 *     summary total, the comments summary total and the shares count but
 *     NO view count — views are post_impressions Insights metrics —
 *     viewCount reports null, never fabricated);
 *   - the rate-limit observation is a RECORD of observable signals per
 *     call: the documented Graph API exposes the X-App-Usage /
 *     X-Business-Use-Case-Usage usage headers on responses (call-count /
 *     CPU / total-time percentages plus, where the provider throttles,
 *     the estimated_time_to_regain_call_capacity / _access seconds) —
 *     percentages do NOT map onto the normalized observation shape's
 *     fields, so successful calls report rateLimit: null (disclosed —
 *     fabricating integers would be dishonest) and the recoverable
 *     backoff seconds ride the rate-limited failure observations where
 *     the provider sends them. Policy enforcement stays in /policies —
 *     observations are never decisions;
 *   - THE ACCOUNT-TYPE LIMITATION (the honest analog of Instagram's
 *     Business/Creator rule, the MKT-059 AC): the documented Pages
 *     surface serves PAGES ONLY — the page-token resolution rides the
 *     documented GET /me/accounts surface ("The Facebook Pages that a
 *     person owns or is able to perform tasks on"), and a USER WITHOUT A
 *     PAGE resolves ZERO accounts through it (the documented empty
 *     data[] answer). The bound Page not being among the resolved pages
 *     is surfaced as the honest 'restricted' data failure (an
 *     account-level eligibility block, exactly the MKT-057
 *     youtubeSignupRequired and MKT-058 code-10 precedents) — NEVER a
 *     fabricated capability, NEVER a fabricated success;
 *     personal-profile publishing is not a fabricatable capability;
 *   - THE PAGE-ROLE LIMITATION: task-role page tokens carry reduced
 *     permissions per the documented token model (the feed edge
 *     requirements: the person must be able to perform the
 *     CREATE_CONTENT/MANAGE/MODERATE tasks; the insights requirements:
 *     the ANALYZE task; the /me/accounts answer carries the user's
 *     per-Page tasks verbatim as passthrough data). This adapter NEVER
 *     invents role state: a task the Page role lacks surfaces through
 *     the provider's OWN documented error semantics (the code-200
 *     permissions-error family) as honest taxonomy DATA;
 *   - the publish lifecycle follows the documented Page publishing
 *     surfaces: feed posts, photos and videos, and SCHEDULED/unpublished
 *     posts (published=false + scheduled_publish_time). An IMMEDIATE
 *     feed/photo publish is SYNCHRONOUS on the documented surface (the
 *     post is live when the POST answers) — the honest born 'published'
 *     submission (providerContentId = the post id). A SCHEDULED publish
 *     (published=false + scheduled_publish_time) rides the scheduled
 *     window — the honest born 'accepted' submission (providerPublishId
 *     = the post id). A VIDEO publish rides the documented video
 *     processing window (the page post about the video goes live after
 *     processing / at the scheduled time) — the born 'accepted'
 *     submission with the video id as the provider publish identity.
 *     getPublishStatus polls the documented post/video node semantics:
 *     is_published (Post) / published (Video) true → 'published';
 *     video status processing → still 'accepted'; video status error →
 *     the honest 'failed' outcome with the provider's own status as the
 *     failure reason; otherwise the scheduled window is still pending
 *     ('accepted');
 *   - the idempotency key is the at-most-once identity TOWARD the
 *     provider (the host fences (socialAccountId, idempotencyKey)
 *     durably — a replay NEVER reaches the adapter). The documented
 *     feed/photos/videos POST surfaces expose NO client idempotency
 *     token, so the host fence is the authority (the MKT-057/058
 *     precedent).
 *
 * DOCUMENTED API SEMANTICS IMPLEMENTED (the provider evidence section
 * with URLs lives in docs/runbooks/MKT-059.md):
 *   (accounts edge)  GET  /me/accounts?fields=id,name,access_token,tasks
 *                  — the page resolution + the per-Page page-token
 *                    surface (the documented token model: every
 *                    operation of this adapter first resolves the Page
 *                    access token through it with the USER token; a
 *                    user without a Page resolves zero accounts).
 *   (Page node)      GET  /{page-id}?fields=id,name,category,
 *                          followers_count,fan_count
 *                  — the account profile (the documented Page-node
 *                    fields, read with the Page access token).
 *   (feed edge)      GET  /{page-id}/feed?fields=<fields>
 *                          &limit=<n>&after=<cursor>
 *                  — the public-content discovery surface (the
 *                    documented Page feed: the Page's own posts + the
 *                    visitor/user posts + the tagged public posts; the
 *                    data[]/paging.cursors.after pagination; the caller
 *                    query is HONESTLY UNUSED — the documented edge
 *                    carries no query parameter, DISCLOSED).
 *   (posts edge)     GET  /{page-id}/posts?fields=<fields>
 *                          &limit=<n>&after=<cursor>
 *                  — the own-content listing (the Page's own published
 *                    posts).
 *   (Post node)      GET  /{post-id}?fields=<fields>
 *                  — the single-content read; an unknown id answers the
 *                    documented code-100 error envelope — surfaced as
 *                    the honest restricted data failure (the node
 *                    surface has NO empty-list semantics).
 *   (insights)       GET  /{page-id}/insights?metric=<m,...>
 *                          &period=day&since=<s>&until=<u>
 *                    GET  /{post-id}/insights?metric=<m,...>
 *                  — the observed metric points (data[].name VERBATIM +
 *                    data[].values[]; the Page metrics are day-period
 *                    slices carrying end_time; the post metrics are
 *                    lifetime aggregates with no window).
 *   (publish)        POST /{page-id}/feed           (message/link ...)
 *                    POST /{page-id}/photos          (url ...)
 *                    POST /{page-id}/videos          (file_url ...)
 *                  — the documented publishing surfaces (published +
 *                    scheduled_publish_time for the scheduled/unpublished
 *                    posts; temporary=true on scheduled photos);
 *                    GET  /{provider-publish-id}?fields=is_published,
 *                          published,scheduled_publish_time,created_time,
 *                          status
 *                  — the publish status poll (the documented post/video
 *                    node semantics).
 *
 * DOCUMENTED ERROR ENVELOPE (the Graph API standard error body):
 *   { "error": { "message": "(#200) ...", "type":
 *                "GraphMethodException" | "OAuthException",
 *                "code": <int>, "error_subcode": <int?>,
 *                "error_user_msg": "<text>?", "fbtrace_id": "<id>" } }
 * mapped onto the frozen taxonomy (envelope-CODE-driven — the Graph API
 * serves most errors, including token errors, over HTTP 400):
 *   transport refused/timeout/5xx/oversized   → provider-unavailable (retryable)
 *   code 190 / 102 (token/session invalid)    → auth-expired (reauthorization)
 *   code 4 / 17 / 32 / 613 / 80001 (the documented
 *       request-limit classes: app-level 4, user-level 17, the Page BUC
 *       32 (User-token Page calls) and 80001 (Page-token Page calls))
 *                                             → rate-limited (+ observation
 *                                                from the documented usage
 *                                                headers' regain-capacity
 *                                                seconds where present)
 *   code 10 / 200 (the permission/eligibility classes — including the
 *       Page-role/task refusals) and every other 4xx (incl. the
 *       code-100 invalid-parameter/non-existing-object family)
 *                                             → restricted (disclosed
 *                                                judgment: the closed
 *                                                taxonomy has no
 *                                                malformed-request code; a
 *                                                provider 4xx refusal is a
 *                                                non-retryable provider-
 *                                                side refusal and the
 *                                                verbatim envelope rides
 *                                                the message).
 *
 * The data-plane host resolves from the connection's NON-SECRET
 * providerConfig (the deployment override surface): apiBaseUrl (the
 * Graph API base, version included — the documented deployment override
 * of https://graph.facebook.com/v21.0). The credential MATERIAL (the
 * §21 in-process bytes) carries the OAuth token bundle
 * ({ accessToken, ... }) the authorized flow provisioned — the adapter
 * parses it in-process ONLY and sends it as the documented Bearer
 * header (the USER token of the /me/accounts page-token resolution; the
 * resolved PAGE token then carries the operations).
 */

import type {
  SocialAccountIdentityResult,
  SocialAccountProfileResult,
  SocialAdapterCallContext,
  SocialAnalyticsObservation,
  SocialAnalyticsResult,
  SocialCapability,
  SocialContentDiscoveryQuery,
  SocialContentListQuery,
  SocialContentPageResult,
  SocialContentReadInput,
  SocialContentResult,
  SocialOperationFailure,
  SocialPlatformAdapter,
  SocialPublishStatusInput,
  SocialPublishStatusResult,
  SocialPublishSubmitInput,
  SocialPublishSubmitResult,
  SocialRateLimitObservation,
} from '../../adapter-contract.ts';
import type { HttpCallPort, HttpCallRequest, HttpCallResponse } from '../../../../../platform/http/outbound.ts';

// ---------------------------------------------------------------------------
// The honest capability matrix (the REAL Facebook Login scope names)
// ---------------------------------------------------------------------------

/** The platform identity: the SAME key the /integrations adapter registry uses (lock rule 18). */
export const FACEBOOK_PAGES_SOCIAL_ADAPTER_KEY = 'facebook-pages';

/**
 * The REAL Facebook Login permission names the documented Pages surface
 * rides on (verified against the live permission reference + the live
 * endpoint Requirements tables at delivery time — see the file header).
 *
 * DISCLOSED: the dispatch's candidate list named pages_manage_engagement
 * as well — the live documentation defines it as the comment-moderation
 * permission ("Moderate comments, delete posts") and NO operation this
 * adapter declares manages comments, so it is deliberately NOT required.
 * The live /{page-id}/insights Requirements table names read_insights
 * (with pages_read_engagement) — the analytics-read family carries it.
 */
export const FACEBOOK_PAGES_SCOPES = {
  /** Show Pages managed by a user (the /me/accounts page-resolution surface). */
  pagesShowList: 'pages_show_list',
  /** Read content posted to the Page (the documented feed/posts/post read permission). */
  pagesReadEngagement: 'pages_read_engagement',
  /** Read user-generated content on the Page (the documented feed-read permission). */
  pagesReadUserContent: 'pages_read_user_content',
  /** Publish and schedule content (the documented feed/photos/videos publish permission). */
  pagesManagePosts: 'pages_manage_posts',
  /** Read Insights data for Pages (the documented insights-edge permission). */
  readInsights: 'read_insights',
} as const;

/** The adapter descriptor (the registry data view). */
export const FACEBOOK_PAGES_SOCIAL_ADAPTER_DESCRIPTOR = {
  adapterKey: FACEBOOK_PAGES_SOCIAL_ADAPTER_KEY,
  providerLabel: 'Facebook Pages (Graph API Pages surface)',
  description:
    'The third concrete MKT-056 social platform adapter: the documented Facebook Graph API PAGES surface (page resolution through /me/accounts with per-Page tokens, first-party Page content discovery, Page/post insights and feed/photos/videos publishing incl. scheduled/unpublished posts) mapped onto the normalized capability plane over the platform HttpCallPort (fetch-based, zero provider SDKs). Failures return as the frozen seven-code taxonomy data; provider payloads ride VERBATIM as passthrough; the wiring is inert without an authorized facebook-pages integration connection + OAuth grant (the fail-closed chain precedes every provider call). The documented surface serves PAGES ONLY — a user without a Page resolves zero accounts and surfaces the documented error semantics as honest data, never a fabricated capability. Limitations are disclosed per capability (lock rule 37) — see docs/runbooks/MKT-059.md.',
} as const;

/**
 * The declared capability matrix — the honest SUBSET: FOUR of the five
 * frozen families. The documented Facebook Pages surface honestly
 * supports account / content-read / analytics-read / publish; the
 * restriction-signals family is deliberately UNDECLARED because the
 * documented Pages surface exposes NO account-level or post-level
 * restriction/eligibility-signal endpoint or field — account-level
 * limitations (the zero-page account-type answer, the Page-role/task
 * refusals, the permission classes) surface as invocation failures
 * through the documented error semantics, which the frozen taxonomy
 * carries as DATA, and hidden moderation state is never invented
 * (architecture-v1.6 §11). The undeclared family fails closed
 * (unsupported-capability, zero provider traffic) — the MKT-058
 * precedent (the UI and planner cannot assume parity, lock rule 19).
 */
export function facebookPagesSocialAdapterCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [FACEBOOK_PAGES_SCOPES.pagesShowList],
      description:
        "Facebook Page identity binding + profile reads over the documented page-resolution surface (GET /me/accounts?fields=id,name,access_token,tasks — the Page access token is requested through it; the profile reads the documented Page node fields id,name,category,followers_count,fan_count with the Page token). Limitations: the documented surface serves PAGES ONLY — a user without a Page resolves ZERO accounts through /me/accounts (the documented empty data[] answer) and the bound Page not being among the resolved pages surfaces as the honest restricted data failure, never a fabricated capability; the documented node exposes no identity-verification timestamp (verifiedAt reports null); the user's per-Page tasks ride the resolution answer VERBATIM as passthrough data (the page-role facts are records, never adapter-side policy).",
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [
        FACEBOOK_PAGES_SCOPES.pagesReadEngagement,
        FACEBOOK_PAGES_SCOPES.pagesReadUserContent,
        FACEBOOK_PAGES_SCOPES.pagesShowList,
      ],
      description:
        "Public discovery over the documented Page feed edge (GET /{page-id}/feed — the Page's own posts + the visitor/user posts + the tagged public posts; the CREATE_CONTENT/MANAGE/MODERATE task + pages_read_engagement + pages_read_user_content requirements; the data[]/paging.cursors.after pagination), the own-content listing over the documented posts edge (GET /{page-id}/posts) and single reads over the Post node. Limitations: the discovery is Page-feed-scoped ONLY — the documented edge carries NO query parameter, so the caller query is HONESTLY UNUSED (no keyword/hashtag content search exists on this surface); the feed returns published AND unpublished posts (the documented semantics — is_published rides the passthrough); the Post node exposes the reactions/comments summary totals and the shares count but NO view count (views are post_impressions Insights metrics — viewCount null, never fabricated); an unknown content id answers the documented code-100 envelope as honest restricted data.",
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [
        FACEBOOK_PAGES_SCOPES.pagesReadEngagement,
        FACEBOOK_PAGES_SCOPES.readInsights,
        FACEBOOK_PAGES_SCOPES.pagesShowList,
      ],
      description:
        'Observed metric points over the documented Page insights edges: the account report as day-period slices (GET /{page-id}/insights?metric=page_impressions,page_post_engagements,page_views_total,page_fans&period=day&since&until — provider labels and per-slice end_time stamps VERBATIM; the documented ANALYZE-task + read_insights + pages_read_engagement requirements) and the per-post lifetime aggregates (GET /{post-id}/insights — the verified live lifetime vocabulary; the basic post_impressions metric is deprecated above Graph API v25 and is deliberately not requested). Limitations: the post insights edge carries NO window parameters (lifetime aggregates — null windows, the caller window honestly unused there); the account window maps onto the documented since/until only when passed (the documented 90-day viewing window applies); per-slice observations report only the provider\'s end_time (windowStart null); an empty report yields NO observations.',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [
        FACEBOOK_PAGES_SCOPES.pagesManagePosts,
        FACEBOOK_PAGES_SCOPES.pagesReadEngagement,
        FACEBOOK_PAGES_SCOPES.pagesShowList,
      ],
      description:
        "The documented Page publishing surfaces — feed posts (POST /{page-id}/feed), photos (POST /{page-id}/photos: url; temporary=true when scheduled) and videos (POST /{page-id}/videos: file_url/description) — incl. the SCHEDULED/unpublished posts (published=false + scheduled_publish_time). An IMMEDIATE feed/photo publish is synchronous (the born 'published' submission, the post id as the content identity); a SCHEDULED publish rides the scheduled window and a VIDEO publish rides the video processing window (the born 'accepted' submissions; the video id is the provider publish identity). getPublishStatus polls the node semantics (is_published/published true → published; video processing → accepted; error → failed). Limitations: a Page role lacking CREATE_CONTENT surfaces through the provider's code-200 error semantics as honest data; no idempotency token on the POST surfaces — the host fence is the at-most-once identity; the Pages BUC rate surface (codes 32/80001) is rate-limited data.",
    },
  ];
}

// ---------------------------------------------------------------------------
// The documented host + the provider-config override surface
// ---------------------------------------------------------------------------

/**
 * The documented Graph API base (version included — the documented
 * deployment override replaces the whole base through the connection's
 * non-secret providerConfig.apiBaseUrl).
 */
const DEFAULT_GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

/** The documented default page size when the caller passes no limit (the feed/posts edges' limit parameter). */
const DEFAULT_POSTS_LIMIT = 25;
/** The documented bounded page-size ceiling ("You can only read a maximum of 100 feed posts with the limit field"). */
const MAX_POSTS_LIMIT = 100;

const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_SIZE_CAP_BYTES = 512 * 1024;

function resolveBase(providerConfig: Readonly<Record<string, string>>): string {
  const override = providerConfig['apiBaseUrl'];
  const base = typeof override === 'string' && override !== '' ? override : DEFAULT_GRAPH_API_BASE;
  return base.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// The documented error envelope + the taxonomy classification
// ---------------------------------------------------------------------------

/** The documented Graph API error envelope (the parsed subset the classifier reads). */
interface GraphErrorEnvelope {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly message: string | null;
  readonly type: string | null;
}

/** The documented token/session-death error codes (the auth-expired class). */
const AUTH_ERROR_CODES = new Set([102, 190]);
/**
 * The documented request-limit error codes (the rate-limited class): the
 * app-level 4, the user-level 17, the 613 request-limit class AND the
 * documented PAGE-LEVEL Business-Use-Case codes — 32 (Page calls made
 * with a User access token) and 80001 (Page calls made with a Page or
 * System User access token, the documented '(#80001) There have been
 * too many calls to this Page account' envelope).
 */
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613, 80001]);

function parseErrorEnvelope(body: string): GraphErrorEnvelope {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (parsed === null || typeof parsed !== 'object' || parsed.error === null || typeof parsed.error !== 'object') {
      return { code: null, subcode: null, message: null, type: null };
    }
    const error = parsed.error as {
      code?: unknown;
      error_subcode?: unknown;
      message?: unknown;
      type?: unknown;
    };
    return {
      code: typeof error.code === 'number' ? error.code : null,
      subcode: typeof error.error_subcode === 'number' ? error.error_subcode : null,
      message: typeof error.message === 'string' ? error.message : null,
      type: typeof error.type === 'string' ? error.type : null,
    };
  } catch {
    return { code: null, subcode: null, message: null, type: null };
  }
}

/** Builds the honest taxonomy failure of an unsatisfying provider answer. */
function failureOf(
  code: SocialOperationFailure['code'],
  message: string,
  rateLimit: SocialRateLimitObservation | null = null,
): { ok: false; failure: SocialOperationFailure } {
  return { ok: false, failure: { code, message, rateLimit } };
}

/**
 * Parses the documented observable backoff seconds from the Graph API
 * usage headers (X-Business-Use-Case-Usage / X-App-Usage carry the
 * provider's estimated_time_to_regain_call_capacity /
 * estimated_time_to_regain_access where the provider throttles).
 */
function regainSecondsOf(response: HttpCallResponse): number | null {
  const raw =
    response.headers['x-business-use-case-usage'] ??
    response.headers['X-Business-Use-Case-Usage'] ??
    response.headers['x-app-usage'] ??
    response.headers['X-App-Usage'] ??
    null;
  if (raw === null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      // The documented shape: { "<object-id>": [ { call_count, ...,
      // estimated_time_to_regain_call_capacity } ] } (an ARRAY of
      // per-object usage entries) — both the array and the bare entry
      // form are handled honestly.
      const candidates = Array.isArray(entry) ? entry : [entry];
      for (const candidate of candidates) {
        if (candidate === null || typeof candidate !== 'object') continue;
        const usage = candidate as {
          estimated_time_to_regain_call_capacity?: unknown;
          estimated_time_to_regain_access?: unknown;
        };
        for (const value of [usage.estimated_time_to_regain_call_capacity, usage.estimated_time_to_regain_access]) {
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Classifies a non-2xx/transport provider answer onto the frozen
 * taxonomy (the documented mapping — see the file header). The Graph
 * API is envelope-CODE-driven: most documented errors, including token
 * errors, ride HTTP 400 with the class in the envelope's code field.
 * The verbatim message rides the failure message (bounded excerpt).
 */
function classifyProviderFailure(
  operation: string,
  response: HttpCallResponse,
): { ok: false; failure: SocialOperationFailure } {
  const envelope = parseErrorEnvelope(response.body);
  const detail = envelope.message !== null ? envelope.message.slice(0, 300) : response.body.slice(0, 300);
  const label = `the Facebook Graph API Pages ${operation} call failed (HTTP ${response.status}${envelope.code !== null ? `, code ${envelope.code}${envelope.subcode !== null ? ` (subcode ${envelope.subcode})` : ''}, ${detail}` : `: ${detail}`})`;

  // Transport-class failures: the request was not satisfiably processed.
  if (response.status === 0) {
    if (response.timedOut) {
      return failureOf('provider-unavailable', `the Facebook Graph API Pages ${operation} call timed out`);
    }
    if (response.transportRefused) {
      return failureOf(
        'provider-unavailable',
        `the Facebook Graph API Pages ${operation} call was not processed (transport refused/unreachable)`,
      );
    }
    return failureOf(
      'provider-unavailable',
      `the Facebook Graph API Pages ${operation} answer exceeded the bounded response envelope`,
    );
  }
  if (response.status >= 500) {
    return failureOf('provider-unavailable', `${label} — the provider reported a server error (retryable)`);
  }
  if (envelope.code !== null && AUTH_ERROR_CODES.has(envelope.code)) {
    return failureOf(
      'auth-expired',
      `the Facebook Graph API Pages ${operation} call was refused as unauthorized (code ${envelope.code}${detail !== '' ? `: ${detail}` : ''}) — reauthorization required`,
    );
  }
  if (envelope.code !== null && RATE_LIMIT_ERROR_CODES.has(envelope.code)) {
    // The documented request-limit classes (app-level 4 / user-level 17 /
    // the Page BUC codes 32 + 80001 / 613): the observable backoff
    // signals ride the observation (the documented usage headers'
    // regain-capacity seconds where the provider sends them).
    const retryAfterSeconds = regainSecondsOf(response);
    const backoffUntil =
      retryAfterSeconds !== null ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString() : null;
    return failureOf('rate-limited', `${label} — the provider request limit was observed`, {
      limitRemaining: null,
      limitResetAt: null,
      backoffUntil,
      retryAfterSeconds,
    });
  }
  // The disclosed judgment call (the file header): every other 4xx —
  // including the documented code-10/code-200 permission/Page-role
  // classes and the code-100 invalid-parameter/non-existing-object
  // family — is a non-retryable provider-side refusal surfaced as
  // 'restricted' with the verbatim envelope excerpt.
  return failureOf('restricted', `${label} — the provider refused the request`);
}

// ---------------------------------------------------------------------------
// The documented response shapes (the parsed subset the mappings read)
// ---------------------------------------------------------------------------

/** The documented /me/accounts edge answer (data[]: Page nodes + the page token + tasks). */
interface FbAccountsEdge {
  readonly data?: readonly {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly access_token?: unknown;
    readonly tasks?: readonly unknown[];
  }[];
}

/** The documented Page node subset (the profile fields). */
interface FbPageNode {
  readonly id?: string;
  readonly name?: string;
  readonly category?: string;
  readonly followers_count?: number;
  readonly fan_count?: number;
}

/**
 * The documented Post node subset (the content fields). The engagement
 * facts ride the documented field-expansion summaries:
 * reactions.summary.total_count / comments.summary.total_count /
 * shares.count.
 */
interface FbPostNode {
  readonly id?: string;
  readonly from?: { readonly id?: unknown; readonly name?: unknown };
  readonly message?: string;
  readonly story?: string;
  readonly created_time?: string;
  readonly permalink_url?: string;
  readonly status_type?: string;
  readonly is_published?: boolean;
  readonly scheduled_publish_time?: number;
  readonly shares?: { readonly count?: unknown };
  readonly reactions?: { readonly summary?: { readonly total_count?: unknown } };
  readonly comments?: { readonly summary?: { readonly total_count?: unknown } };
}

/** The documented paged edge answer (data[] + paging.cursors.after). */
interface FbPagedEdge {
  readonly data?: unknown;
  readonly paging?: { readonly cursors?: { readonly after?: unknown }; readonly next?: unknown };
}

/** The documented insights edge answer (data[]: name/period/values[]). */
interface FbInsightsEdge {
  readonly data?: readonly {
    readonly name?: unknown;
    readonly period?: unknown;
    readonly values?: readonly { readonly value?: unknown; readonly end_time?: unknown }[];
    readonly title?: unknown;
    readonly description?: unknown;
  }[];
}

/** The documented publish POST answer ({ id }). */
interface FbPublishAnswer {
  readonly id?: unknown;
}

/**
 * The documented publish status poll answer — ONE poll serves BOTH node
 * kinds (the Post node answers is_published; the Video node answers
 * published + status): { id, is_published?, published?,
 * scheduled_publish_time?, created_time?, status? { video_status } }.
 */
interface FbPublishStatusNode {
  readonly id?: unknown;
  readonly is_published?: unknown;
  readonly published?: unknown;
  readonly scheduled_publish_time?: unknown;
  readonly created_time?: unknown;
  readonly status?: { readonly video_status?: unknown };
}

/** The documented live day-period Page insight metric vocabulary (verified against the v26.0 reference). */
const PAGE_INSIGHT_METRICS: readonly string[] = [
  'page_impressions',
  'page_post_engagements',
  'page_views_total',
  'page_fans',
];

/**
 * The documented live lifetime post insight metric vocabulary (verified
 * against the v26.0 reference — the basic post_impressions metric is
 * deprecated above Graph API v25 and is deliberately not requested).
 */
const POST_INSIGHT_METRICS: readonly string[] = [
  'post_clicks',
  'post_impressions_organic',
  'post_impressions_paid',
  'post_reactions_like_total',
];

/** Parses a documented count number — never fabricated. */
function countOf(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface FacebookPagesSocialAdapterOptions {
  /** The platform outbound HTTP port (fetch-based in production; the documented https-or-loopback envelope). */
  readonly http: HttpCallPort;
}

/**
 * Constructs the Facebook Pages social platform adapter (a pure object —
 * NO provider traffic at construction; the wiring is inert until the
 * fail-closed host chain hands it an authorized call context).
 */
export function createFacebookPagesSocialAdapter(
  options: FacebookPagesSocialAdapterOptions,
): SocialPlatformAdapter {
  const http = options.http;

  // -------------------------------------------------------------------------
  // The provider call helper (the shared request/classify core)
  // -------------------------------------------------------------------------

  /**
   * Issues ONE documented request through the platform port. Transport
   * and envelope failures return as the honest data failures (never
   * thrown across the port); a 2xx answer returns the raw response for
   * the operation-specific documented mapping.
   */
  async function callProviderRaw(
    operation: string,
    request: Omit<HttpCallRequest, 'timeoutMs' | 'sizeCapBytes'>,
  ): Promise<{ ok: true; response: HttpCallResponse } | { ok: false; failure: SocialOperationFailure }> {
    let response: HttpCallResponse;
    try {
      response = await http.request({
        ...request,
        timeoutMs: REQUEST_TIMEOUT_MS,
        sizeCapBytes: RESPONSE_SIZE_CAP_BYTES,
      });
    } catch (error) {
      // The port throws only on envelope violations (an adapter bug —
      // fail honestly as data, never as an exception across the port).
      return failureOf(
        'provider-unavailable',
        `the Facebook Graph API Pages ${operation} call could not be issued: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, response };
    }
    return classifyProviderFailure(operation, response);
  }

  /** callProviderRaw + the documented JSON body parse (a non-JSON 2xx is an honest provider-unavailable). */
  async function callProviderJson(
    operation: string,
    request: Omit<HttpCallRequest, 'timeoutMs' | 'sizeCapBytes'>,
  ): Promise<{ ok: true; parsed: unknown } | { ok: false; failure: SocialOperationFailure }> {
    const answer = await callProviderRaw(operation, request);
    if (!answer.ok) return answer;
    try {
      return { ok: true, parsed: JSON.parse(answer.response.body) as unknown };
    } catch {
      return failureOf(
        'provider-unavailable',
        `the Facebook Graph API Pages ${operation} answer was not the documented JSON body`,
      );
    }
  }

  /**
   * Resolves the documented USER-token Bearer credential from the §21
   * in-process material (the authorized flow's token bundle). The USER
   * token drives the documented /me/accounts page-token resolution; the
   * resolved PAGE token then carries the operations. Unparseable/
   * unusable material is an honest auth-expired (the authorization is
   * unusable).
   */
  function bearerOf(context: SocialAdapterCallContext): string | null {
    try {
      const bundle = JSON.parse(new TextDecoder().decode(context.credentialMaterial)) as {
        accessToken?: unknown;
      };
      return typeof bundle.accessToken === 'string' && bundle.accessToken !== '' ? bundle.accessToken : null;
    } catch {
      return null;
    }
  }

  function authFailure(operation: string): { ok: false; failure: SocialOperationFailure } {
    return failureOf(
      'auth-expired',
      `the ${operation} call cannot authenticate: the provisioned credential material carries no usable access token — reauthorization required`,
    );
  }

  function authHeaders(bearer: string): Readonly<Record<string, string>> {
    return { authorization: `Bearer ${bearer}` };
  }

  /** The documented GET query form (null/undefined parameters are omitted). */
  function buildQuery(params: Readonly<Record<string, string | number | null>>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) search.set(key, String(value));
    }
    return search.toString();
  }

  // -------------------------------------------------------------------------
  // The documented page resolution (the /me/accounts page-token surface)
  // -------------------------------------------------------------------------

  /**
   * ONE resolved Page of the documented /me/accounts surface: the Page
   * identity, its per-Page PAGE ACCESS TOKEN (the documented token
   * model — "To interact with the Pages API, a Page access token is
   * required") and the user's tasks on it (passthrough facts).
   */
  interface ResolvedPage {
    readonly pageToken: string;
    readonly pageName: string | null;
    readonly tasks: readonly unknown[];
  }

  /**
   * The documented page resolution EVERY operation rides: GET
   * /me/accounts?fields=id,name,access_token,tasks with the USER token
   * ("The Facebook Pages that a person owns or is able to perform tasks
   * on"; the Page node's access_token: "Only returned if the User
   * making the request has a role (other than Live Contributor) on the
   * Page").
   *
   * THE ACCOUNT-TYPE HONESTY: a user WITHOUT a Page resolves ZERO
   * accounts through this surface (the documented empty data[] answer)
   * — the bound Page not being among the resolved pages is the honest
   * 'restricted' data failure (an account-level eligibility block; the
   * MKT-057 youtubeSignupRequired / MKT-058 code-10 precedent), NEVER a
   * fabricated capability. A resolved page WITHOUT the access_token
   * field (the documented no-role/Live-Contributor answer) is the same
   * honest refusal.
   */
  async function resolvePage(
    context: SocialAdapterCallContext,
    operation: string,
    fields: string,
  ): Promise<{ ok: true; page: ResolvedPage } | { ok: false; failure: SocialOperationFailure }> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    const answer = await callProviderJson(`${operation} (page resolution /me/accounts)`, {
      url: `${base}/me/accounts?${buildQuery({ fields })}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const edge = answer.parsed as FbAccountsEdge;
    const data = Array.isArray(edge?.data) ? edge.data : [];
    // The documented zero-account answer (a user without a Page) and
    // the not-among-the-pages answer (the bound Page is not one the
    // user can perform tasks on) are the SAME honest eligibility
    // refusal — surfaced as data, never invented state.
    const entry = data.find((candidate) => candidate?.id === context.externalAccountId);
    if (entry === undefined) {
      return failureOf(
        'restricted',
        `the ${operation} call was refused: the bound Page '${context.externalAccountId}' is not among the Pages the user can perform tasks on through the documented /me/accounts surface (${data.length} page(s) resolved${data.length === 0 ? ' — the documented zero-account answer of a user without a Page' : ''}) — the Pages surface serves Pages only, never a fabricated capability`,
      );
    }
    const pageToken = typeof entry.access_token === 'string' && entry.access_token !== '' ? entry.access_token : null;
    if (pageToken === null) {
      // The documented answer shape when the user has no usable Page
      // role on the Page (the access_token field is returned only for
      // role-carrying users): the honest eligibility refusal.
      return failureOf(
        'restricted',
        `the ${operation} call was refused: the documented /me/accounts resolution of the bound Page '${context.externalAccountId}' carries no Page access token (the field is returned only for users with a Page role) — the Page-role limitation surfaces through the documented semantics, never invented state`,
      );
    }
    return {
      ok: true,
      page: {
        pageToken,
        pageName: typeof entry.name === 'string' && entry.name !== '' ? entry.name : null,
        tasks: Array.isArray(entry.tasks) ? entry.tasks : [],
      },
    };
  }

  // -------------------------------------------------------------------------
  // The account family (the documented /me/accounts + Page node)
  // -------------------------------------------------------------------------

  async function verifyAccountIdentity(context: SocialAdapterCallContext): Promise<SocialAccountIdentityResult> {
    // The documented page-resolution surface IS the identity
    // re-verification: the bound Page must be among the user's Pages
    // (a drift — the user lost the Page role — surfaces as the honest
    // restricted data failure by resolvePage above).
    const outcome = await resolvePage(context, 'verifyAccountIdentity', 'id,name,access_token,tasks');
    if (!outcome.ok) return outcome;
    const page = outcome.page;
    return {
      ok: true,
      identity: {
        externalAccountId: context.externalAccountId,
        displayIdentity: page.pageName ?? context.externalAccountId,
        // The documented surface exposes no identity-verification
        // timestamp — null (disclosed).
        verifiedAt: null,
      },
      // The documented Graph API usage headers (X-App-Usage /
      // X-Business-Use-Case-Usage) expose call-count/CPU/time
      // percentages, not the normalized shape's fields — null (disclosed).
      rateLimit: null,
    };
  }

  async function getAccountProfile(context: SocialAdapterCallContext): Promise<SocialAccountProfileResult> {
    const operation = 'getAccountProfile';
    // Step 1: the documented page resolution (the Page access token).
    const resolution = await resolvePage(context, operation, 'id,name,access_token,tasks');
    if (!resolution.ok) return resolution;
    // Step 2: the documented Page node read (with the PAGE token).
    const bearer = resolution.page.pageToken;
    const base = resolveBase(context.providerConfig);
    const answer = await callProviderJson(`${operation} (Page node)`, {
      url: `${base}/${encodeURIComponent(context.externalAccountId)}?${buildQuery({
        fields: 'id,name,category,followers_count,fan_count',
      })}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const node = answer.parsed as FbPageNode;
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') {
      return failureOf(
        'provider-unavailable',
        `the Facebook Graph API Pages ${operation} answer was not the documented Page node body`,
      );
    }
    return {
      ok: true,
      profile: {
        externalAccountId: node.id,
        displayIdentity: typeof node.name === 'string' && node.name !== '' ? node.name : node.id,
        // The documented Page node exposes no identity-verification
        // timestamp — null (disclosed).
        verifiedAt: null,
        // The provider's own Page category label rides verbatim.
        accountKind: typeof node.category === 'string' ? node.category : null,
        followerCount: countOf(node.followers_count),
        data: node as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: null,
    };
  }

  // -------------------------------------------------------------------------
  // The content-read family (the documented feed/posts edges + Post node)
  // -------------------------------------------------------------------------

  /**
   * The documented Post-node field set the reads request (bounded, the
   * documented node fields + the documented field-expansion summaries:
   * reactions.summary(true).limit(0) / comments.summary(true).limit(0)).
   */
  const POST_FIELDS =
    'id,from,message,story,created_time,permalink_url,status_type,is_published,scheduled_publish_time,shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)';

  function postRecordOf(post: FbPostNode): {
    readonly providerContentId: string;
    readonly authorExternalAccountId: string | null;
    readonly contentFormat: string;
    readonly publishedAt: string | null;
    readonly sourceTimestamp: string | null;
    readonly engagement: {
      readonly viewCount: number | null;
      readonly likeCount: number | null;
      readonly commentCount: number | null;
      readonly shareCount: number | null;
    };
    readonly data: Readonly<Record<string, unknown>>;
    readonly etag: string | null;
    readonly sourceVersion: string | null;
  } | null {
    if (post === null || typeof post !== 'object' || typeof post.id !== 'string' || post.id === '') return null;
    return {
      providerContentId: post.id,
      // The documented Post node carries the author identity in the
      // from struct (the Page or the user author) — the honest author
      // id where the answer exposes one.
      authorExternalAccountId: typeof post.from?.id === 'string' && post.from.id !== '' ? post.from.id : null,
      contentFormat: typeof post.status_type === 'string' && post.status_type !== '' ? post.status_type : 'post',
      publishedAt: typeof post.created_time === 'string' ? post.created_time : null,
      sourceTimestamp: typeof post.created_time === 'string' ? post.created_time : null,
      engagement: {
        // The documented Post node exposes the reactions summary
        // total (the reactions total — like/love/care...; DISCLOSED:
        // the "like" count surface is the reactions total), the
        // comments summary total and the shares count, but NO view
        // count (views are post_impressions Insights metrics) —
        // viewCount null, never fabricated.
        viewCount: null,
        likeCount:
          typeof post.reactions?.summary?.total_count === 'number' && Number.isFinite(post.reactions.summary.total_count)
            ? post.reactions.summary.total_count
            : null,
        commentCount:
          typeof post.comments?.summary?.total_count === 'number' && Number.isFinite(post.comments.summary.total_count)
            ? post.comments.summary.total_count
            : null,
        shareCount:
          typeof post.shares?.count === 'number' && Number.isFinite(post.shares.count) ? post.shares.count : null,
      },
      data: post as unknown as Readonly<Record<string, unknown>>,
      etag: null,
      sourceVersion: null,
    };
  }

  /** Reads one paged edge (the documented data[]/paging.cursors.after protocol) with the PAGE token. */
  async function readPagedEdge(
    pageToken: string,
    context: SocialAdapterCallContext,
    operation: string,
    edge: 'feed' | 'posts',
    input: { readonly pageCursor: string | null; readonly limit: number | null },
  ): Promise<
    | { ok: true; records: unknown[]; nextCursor: string | null }
    | { ok: false; failure: SocialOperationFailure }
  > {
    const base = resolveBase(context.providerConfig);
    const limit = input.limit !== null ? Math.min(Math.max(input.limit, 1), MAX_POSTS_LIMIT) : DEFAULT_POSTS_LIMIT;
    const answer = await callProviderJson(`${operation} (${edge} edge)`, {
      url: `${base}/${encodeURIComponent(context.externalAccountId)}/${edge}?${buildQuery({
        fields: POST_FIELDS,
        limit,
        after: input.pageCursor,
      })}`,
      method: 'GET',
      headers: authHeaders(pageToken),
      body: null,
    });
    if (!answer.ok) return answer;
    const paged = answer.parsed as FbPagedEdge;
    const data = Array.isArray(paged?.data) ? (paged.data as unknown[]) : [];
    const after = paged?.paging?.cursors?.after;
    // The documented pagination: the paging.next URL's presence marks a
    // next page; the after cursor is the opaque next-page token.
    const hasNext = typeof paged?.paging?.next === 'string' && paged.paging.next !== '';
    const nextCursor = hasNext && typeof after === 'string' && after !== '' ? after : null;
    return { ok: true, records: data, nextCursor };
  }

  async function discoverPublicContent(
    context: SocialAdapterCallContext,
    input: SocialContentDiscoveryQuery,
  ): Promise<SocialContentPageResult> {
    const operation = 'discoverPublicContent';
    // The documented page resolution first (the Page access token).
    const resolution = await resolvePage(context, operation, 'id,name,access_token,tasks');
    if (!resolution.ok) return resolution;
    // The documented Page feed edge: the Page's own posts + the
    // visitor/user posts + the tagged public posts ("The Page Feed
    // encompasses any interactions with a Facebook Page including:
    // posts and links published by this Page, visitors to this Page,
    // and public posts in which the Page has been tagged"). The caller
    // query is HONESTLY UNUSED — the documented edge carries no query
    // parameter (DISCLOSED: the discovery is Page-feed-scoped only; no
    // general keyword/hashtag content search exists on the documented
    // Pages surface).
    const outcome = await readPagedEdge(resolution.page.pageToken, context, operation, 'feed', input);
    if (!outcome.ok) return outcome;
    const records = outcome.records
      .map((post) => (post !== null && typeof post === 'object' ? postRecordOf(post as FbPostNode) : null))
      .filter((record): record is NonNullable<typeof record> => record !== null);
    return { ok: true, page: { records, pageCursor: outcome.nextCursor }, rateLimit: null };
  }

  async function listOwnContent(
    context: SocialAdapterCallContext,
    input: SocialContentListQuery,
  ): Promise<SocialContentPageResult> {
    const operation = 'listOwnContent';
    // The documented page resolution first (the Page access token).
    const resolution = await resolvePage(context, operation, 'id,name,access_token,tasks');
    if (!resolution.ok) return resolution;
    // The documented Page posts edge: the Page's own published posts
    // ("The posts of a Facebook Page").
    const outcome = await readPagedEdge(resolution.page.pageToken, context, operation, 'posts', input);
    if (!outcome.ok) return outcome;
    const records = outcome.records
      .map((post) => (post !== null && typeof post === 'object' ? postRecordOf(post as FbPostNode) : null))
      .filter((record): record is NonNullable<typeof record> => record !== null);
    return { ok: true, page: { records, pageCursor: outcome.nextCursor }, rateLimit: null };
  }

  async function getContent(
    context: SocialAdapterCallContext,
    input: SocialContentReadInput,
  ): Promise<SocialContentResult> {
    const operation = 'getContent';
    // The documented page resolution first (the Page access token).
    const resolution = await resolvePage(context, operation, 'id,name,access_token,tasks');
    if (!resolution.ok) return resolution;
    const base = resolveBase(context.providerConfig);
    const answer = await callProviderJson(`${operation} (Post node)`, {
      url: `${base}/${encodeURIComponent(input.providerContentId)}?${buildQuery({ fields: POST_FIELDS })}`,
      method: 'GET',
      headers: authHeaders(resolution.page.pageToken),
      body: null,
    });
    if (!answer.ok) return answer;
    const node = answer.parsed as FbPostNode;
    // The documented node-read answer for an unknown id is the
    // code-100 error envelope (classified as data above — the node
    // surface has NO empty-list semantics); a 2xx answer without a
    // node id is the honest provider-unavailable.
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') {
      return failureOf(
        'provider-unavailable',
        `the Facebook Graph API Pages ${operation} answer was not the documented Post node body`,
      );
    }
    return { ok: true, record: postRecordOf(node), rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The analytics-read family (the documented Page insights edges)
  // -------------------------------------------------------------------------

  /** Maps one documented insight data entry onto normalized observations (labels VERBATIM). */
  function observationsOfInsight(
    entry: NonNullable<FbInsightsEdge['data']>[number],
    extraData: Readonly<Record<string, unknown>>,
  ): SocialAnalyticsObservation[] {
    const metric = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : null;
    if (metric === null) return [];
    const values = Array.isArray(entry?.values) ? entry.values : [];
    const observations: SocialAnalyticsObservation[] = [];
    for (const value of values) {
      if (value === null || typeof value !== 'object') continue;
      const observed = typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : null;
      if (observed === null) continue;
      // The day-period Page slices carry the provider's own end_time
      // stamp; the lifetime post aggregates carry no window at all.
      // windowStart is null in both cases — the provider exposes no
      // per-slice start (only the end), and fabricating one would be
      // dishonest.
      observations.push({
        metric,
        value: observed,
        windowStart: null,
        windowEnd: typeof value.end_time === 'string' && value.end_time !== '' ? value.end_time : null,
        data: { ...extraData, insight: entry as unknown as Record<string, unknown> },
      });
    }
    return observations;
  }

  async function readAccountAnalytics(
    context: SocialAdapterCallContext,
    input: { readonly windowStart: string | null; readonly windowEnd: string | null },
  ): Promise<SocialAnalyticsResult> {
    const operation = 'readAccountAnalytics';
    // The documented page resolution first (the Page access token — the
    // documented insights requirement: "A Page access token requested
    // by a person who can perform the ANALYZE task on the Page").
    const resolution = await resolvePage(context, operation, 'id,name,access_token,tasks');
    if (!resolution.ok) return resolution;
    const base = resolveBase(context.providerConfig);
    const since =
      input.windowStart !== null && !Number.isNaN(Date.parse(input.windowStart))
        ? Math.floor(Date.parse(input.windowStart) / 1000)
        : null;
    const until =
      input.windowEnd !== null && !Number.isNaN(Date.parse(input.windowEnd))
        ? Math.floor(Date.parse(input.windowEnd) / 1000)
        : null;
    // The documented day-period Page report (the verified live metric
    // vocabulary). A null caller window omits since/until — the
    // provider's own documented default window answers, and the
    // observations carry the provider's per-slice end_time stamps
    // verbatim.
    const answer = await callProviderJson(`${operation} (Page insights edge)`, {
      url: `${base}/${encodeURIComponent(context.externalAccountId)}/insights?${buildQuery({
        metric: PAGE_INSIGHT_METRICS.join(','),
        period: 'day',
        since,
        until,
      })}`,
      method: 'GET',
      headers: authHeaders(resolution.page.pageToken),
      body: null,
    });
    if (!answer.ok) return answer;
    const edge = answer.parsed as FbInsightsEdge;
    const data = Array.isArray(edge?.data) ? edge.data : [];
    const observations: SocialAnalyticsObservation[] = [];
    for (const entry of data) {
      observations.push(...observationsOfInsight(entry, { period: 'day' }));
    }
    // An empty report (no data in the window) yields NO observations —
    // never fabricated zeros.
    return { ok: true, observations, rateLimit: null };
  }

  async function readContentAnalytics(
    context: SocialAdapterCallContext,
    input: {
      readonly providerContentIds: readonly string[];
      readonly windowStart: string | null;
      readonly windowEnd: string | null;
    },
  ): Promise<SocialAnalyticsResult> {
    const operation = 'readContentAnalytics';
    // The documented page resolution first (the Page access token).
    const resolution = await resolvePage(context, operation, 'id,name,access_token,tasks');
    if (!resolution.ok) return resolution;
    const base = resolveBase(context.providerConfig);
    const observations: SocialAnalyticsObservation[] = [];
    for (const postId of input.providerContentIds) {
      // The documented per-post insights edge (lifetime aggregates —
      // the edge carries NO window parameters; the caller window is
      // honestly unused on this surface, disclosed). The verified live
      // lifetime metric vocabulary is requested.
      const answer = await callProviderJson(`${operation} (post insights edge)`, {
        url: `${base}/${encodeURIComponent(postId)}/insights?${buildQuery({
          metric: POST_INSIGHT_METRICS.join(','),
        })}`,
        method: 'GET',
        headers: authHeaders(resolution.page.pageToken),
        body: null,
      });
      if (!answer.ok) return answer;
      const edge = answer.parsed as FbInsightsEdge;
      const data = Array.isArray(edge?.data) ? edge.data : [];
      for (const entry of data) {
        observations.push(...observationsOfInsight(entry, { providerContentId: postId }));
      }
    }
    return { ok: true, observations, rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The publish family (the documented feed/photos/videos surfaces)
  // -------------------------------------------------------------------------

  /**
   * Maps the normalized publish request onto the documented publishing
   * surface + parameters (form-encoded POST params). The provider owns
   * parameter validation — a documented error surfaces as the honest
   * taxonomy data failure with the verbatim envelope.
   */
  function publishSurfaceOf(
    input: SocialPublishSubmitInput,
  ): {
    readonly surface: 'feed' | 'photos' | 'videos';
    readonly params: Record<string, string>;
    readonly scheduled: boolean;
  } {
    const payload = input.request.payload as Readonly<Record<string, unknown>>;
    const params: Record<string, string> = {};
    // The scheduled/unpublished-post semantics: published=false +
    // scheduled_publish_time (the UNIX timestamp of the request's
    // scheduledFor — the documented "when post should go live").
    const scheduledFor = input.request.scheduledFor;
    const scheduled = scheduledFor !== null && !Number.isNaN(Date.parse(scheduledFor));
    const contentType = input.request.contentType;
    // The documented surface selection: the feed (message/link), the
    // photos (url; temporary=true when scheduled) and the videos
    // (file_url/description) edges.
    const surface: 'feed' | 'photos' | 'videos' =
      contentType === 'facebook-pages.photo'
        ? 'photos'
        : contentType === 'facebook-pages.video'
          ? 'videos'
          : 'feed';

    if (surface === 'feed') {
      // The documented feed POST parameters the normalized request can
      // carry VERBATIM (the provider-shaped passthrough names).
      for (const key of ['message', 'link', 'place', 'tags', 'name', 'description']) {
        const value = payload[key];
        if (typeof value === 'string' && value !== '') params[key] = value;
      }
    } else if (surface === 'photos') {
      // The documented photos POST parameters.
      for (const key of ['url', 'caption', 'message']) {
        const value = payload[key];
        if (typeof value === 'string' && value !== '') params[key] = value;
      }
      // The media-asset URL descriptor fills url when the payload
      // carries none (the content-asset resolution seam — the asset
      // reference rides the descriptor's url hint).
      if (params['url'] === undefined) {
        const asset = input.request.mediaAssets.find((candidate) => candidate.mediaKind === 'image');
        const url = asset?.descriptor['url'] ?? asset?.descriptor['mediaUrl'];
        if (typeof url === 'string' && url !== '') params['url'] = url;
      }
      if (scheduled) {
        // The documented scheduled-photo requirement: "If the photo is
        // used in a scheduled post, temporary=true must be used."
        params['temporary'] = 'true';
      }
    } else {
      // The documented videos POST parameters.
      for (const key of ['file_url', 'description', 'title']) {
        const value = payload[key];
        if (typeof value === 'string' && value !== '') params[key] = value;
      }
      // The media-asset URL descriptor fills file_url when the payload
      // carries none.
      if (params['file_url'] === undefined) {
        const asset = input.request.mediaAssets.find((candidate) => candidate.mediaKind === 'video');
        const url = asset?.descriptor['url'] ?? asset?.descriptor['mediaUrl'];
        if (typeof url === 'string' && url !== '') params['file_url'] = url;
      }
    }

    if (scheduled) {
      // The documented scheduled/unpublished post: published=false +
      // scheduled_publish_time (UNIX seconds).
      params['published'] = 'false';
      params['scheduled_publish_time'] = String(Math.floor(Date.parse(scheduledFor as string) / 1000));
    }
    return { surface, params, scheduled };
  }

  async function submitPublish(
    context: SocialAdapterCallContext,
    input: SocialPublishSubmitInput,
  ): Promise<SocialPublishSubmitResult> {
    const operation = 'submitPublish';
    // The documented page resolution first (the Page access token — the
    // documented publish requirement: "A Page access token ... The
    // pages_manage_posts permission ... The pages_read_engagement
    // permission ... The pages_show_list permission" + the CREATE_CONTENT
    // task, which the provider enforces through its own documented
    // error semantics).
    const resolution = await resolvePage(context, operation, 'id,name,access_token,tasks');
    if (!resolution.ok) return resolution;
    const base = resolveBase(context.providerConfig);
    const { surface, params, scheduled } = publishSurfaceOf(input);
    // The documented publishing POST (the surface's edge): the answer
    // is { id } — the created post id (feed/photos) or video id
    // (videos).
    const creation = await callProviderJson(`${operation} (${surface} edge POST)`, {
      url: `${base}/${encodeURIComponent(context.externalAccountId)}/${surface}`,
      method: 'POST',
      headers: { ...authHeaders(resolution.page.pageToken), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (!creation.ok) return creation;
    const answer = creation.parsed as FbPublishAnswer;
    const providerId = typeof answer?.id === 'string' && answer.id !== '' ? answer.id : null;
    if (providerId === null) {
      return failureOf(
        'provider-unavailable',
        `the Facebook Graph API Pages ${surface} publish answered without the documented id ({ id })`,
      );
    }
    if (surface === 'videos') {
      // The documented VIDEO processing window: the page post about
      // the video goes live after the video processes (and/or at the
      // scheduled time) — the honest born 'accepted' submission with
      // the video id as the provider publish identity (the async
      // surface; the status poll observes the video/post node
      // semantics).
      return {
        ok: true,
        submission: {
          publishState: 'accepted',
          providerPublishId: providerId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: answer as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }
    if (scheduled) {
      // The documented SCHEDULED post (published=false +
      // scheduled_publish_time): the post exists but is NOT live — the
      // honest born 'accepted' submission riding the scheduled window
      // (the post id is the provider publish identity; the content id
      // reports when the window arrives).
      return {
        ok: true,
        submission: {
          publishState: 'accepted',
          providerPublishId: providerId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: answer as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }
    // The documented IMMEDIATE feed/photo publish is synchronous (the
    // post is live when the POST answers) — the honest born
    // 'published' submission with the post id as BOTH the provider
    // publish identity and the content identity.
    return {
      ok: true,
      submission: {
        publishState: 'published',
        providerPublishId: providerId,
        providerContentId: providerId,
        publishedAt: new Date().toISOString(),
        providerFailureReason: null,
        restrictionSignals: [],
        providerData: answer as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: null,
    };
  }

  async function getPublishStatus(
    context: SocialAdapterCallContext,
    input: SocialPublishStatusInput,
  ): Promise<SocialPublishStatusResult> {
    const operation = 'getPublishStatus';
    // The documented page resolution first (the Page access token).
    const resolution = await resolvePage(context, operation, 'id,name,access_token,tasks');
    if (!resolution.ok) return resolution;
    const base = resolveBase(context.providerConfig);
    // The documented publish status poll — ONE poll serves BOTH node
    // kinds (the Post node answers is_published; the Video node
    // answers published + status; the Graph API omits the fields the
    // node does not carry):
    //   GET /{provider-publish-id}?fields=is_published,published,
    //       scheduled_publish_time,created_time,status
    const poll = await callProviderJson(`${operation} (post/video node)`, {
      url: `${base}/${encodeURIComponent(input.providerPublishId)}?${buildQuery({
        fields: 'is_published,published,scheduled_publish_time,created_time,status',
      })}`,
      method: 'GET',
      headers: authHeaders(resolution.page.pageToken),
      body: null,
    });
    if (!poll.ok) return poll;
    const node = poll.parsed as FbPublishStatusNode;
    const providerId =
      typeof node?.id === 'string' && node.id !== '' ? node.id : input.providerPublishId;

    // The documented Post-node semantics: is_published ("Indicates
    // whether a scheduled post was published") true → the post is
    // live. The documented Video-node semantics: published true → the
    // page post about the video is live.
    const isLive = node?.is_published === true || node?.published === true;
    if (isLive) {
      return {
        ok: true,
        status: {
          publishState: 'published',
          providerPublishId: providerId,
          // The post/video id IS the content identity on this surface
          // (the publish answer carried it; the poll confirms liveness).
          providerContentId: providerId,
          publishedAt: typeof node?.created_time === 'string' && node.created_time !== '' ? node.created_time : null,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: node as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }

    // The documented Video-node status semantics (the video processing
    // window): status.video_status carries the provider's own
    // processing state.
    const videoStatus = typeof node?.status?.video_status === 'string' ? node.status.video_status : null;
    if (videoStatus === 'error') {
      // The provider's OWN processing-failure fact — the honest
      // 'failed' outcome (the video/page post never went live; the
      // recovery is a fresh publish under a NEW idempotency key).
      return {
        ok: true,
        status: {
          publishState: 'failed',
          providerPublishId: providerId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason:
            'status.video_status=error — the documented video processing failed: the page post about the video never went live; a fresh publish (a new idempotency key) is the recovery',
          restrictionSignals: [],
          providerData: node as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }
    if (videoStatus === 'processing') {
      // Still processing — the honest still-accepted answer.
      return {
        ok: true,
        status: {
          publishState: 'accepted',
          providerPublishId: providerId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: node as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }

    // The scheduled window is still pending (is_published/published
    // false — the documented scheduled-post semantics) or the video is
    // ready but the post's own liveness has not been observed yet: the
    // honest still-accepted answer with the verbatim node passthrough.
    return {
      ok: true,
      status: {
        publishState: 'accepted',
        providerPublishId: providerId,
        providerContentId: null,
        publishedAt: null,
        providerFailureReason: null,
        restrictionSignals: [],
        providerData: node as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: null,
    };
  }

  // NOTE (the frozen port contract): the restriction-signals family is
  // deliberately NOT implemented — the capability matrix above honestly
  // declares no restriction-signals capability, and the registration
  // guards refuse a declared operation without its implementing method
  // (an undeclared readRestrictionSignals call never reaches this
  // adapter: the host answers 'unsupported-capability' fail-closed with
  // ZERO provider traffic — proven end-to-end by the conformance suite's
  // capability-subset scenario; the MKT-058 precedent).

  return {
    descriptor: { ...FACEBOOK_PAGES_SOCIAL_ADAPTER_DESCRIPTOR },
    capabilities: facebookPagesSocialAdapterCapabilities(),
    verifyAccountIdentity,
    getAccountProfile,
    discoverPublicContent,
    listOwnContent,
    getContent,
    readAccountAnalytics,
    readContentAnalytics,
    submitPublish,
    getPublishStatus,
  };
}
