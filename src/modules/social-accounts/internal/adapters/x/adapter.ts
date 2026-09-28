/**
 * MKT-061 — the CONCRETE X (TWITTER) SOCIAL PLATFORM ADAPTER (the fifth
 * MKT-056 SocialPlatformAdapter implementation): the honest capability
 * matrix + the documented X API v2 surface (the OAuth 2.0 user-context
 * reads of /2/users/me, the Posts read surfaces (post lookup + the user
 * timeline + the recent search), the Posts analytics surface, the
 * chunked v2 media upload lifecycle (INIT/APPEND/FINALIZE + STATUS) and
 * the synchronous POST /2/tweets creation) mapped onto the frozen
 * normalized capability plane, over the platform HttpCallPort
 * (fetch-based, ZERO provider SDKs — the /integrations INT-001
 * discipline and the arch-check EXTERNAL_PACKAGE_IN_SRC rule).
 *
 * ONE-FILE SUBTREE (the arch-check adapter classification, the
 * MKT-057..060 discipline): every file under an 'adapters' path segment
 * is a CONCRETE ADAPTER — the matrix and the adapter implementation
 * share this single file because a second subtree file would be an
 * adapter importing another adapter (ADAPTER_COUPLING). The frozen
 * contract itself is imported from the module-internal contract
 * ('../../adapter-contract.ts'), NOT through the
 * internal/adapters/adapter-contract.ts re-export shim — the shim is
 * itself under an 'adapters' path segment, so importing it from this
 * subtree would be the same ADAPTER_COUPLING violation; the direct
 * same-module import is the only arch-check-legal form of the
 * sanctioned dependency on the frozen contract.
 *
 * PROVIDER EVIDENCE (the documented surfaces this adapter maps — the
 * full evidence section with URLs lives in docs/runbooks/MKT-061.md;
 * every fact below was verified against the LIVE docs.x.com
 * documentation at delivery time, fetched from the documented markdown
 * reference endpoints):
 *   - Chunked Media Upload quickstart (the v2 chunked flow):
 *     https://docs.x.com/x-api/media/quickstart/media-upload-chunked
 *   - Initialize Media Upload (POST /2/media/upload/initialize — a JSON
 *     body { media_type, total_bytes, media_category }):
 *     https://docs.x.com/x-api/media/initialize-media-upload
 *   - Append Media Upload (POST /2/media/upload/{id}/append — the media
 *     chunk anyOf binary | byte (base64); the endpoint accepts
 *     application/json OR multipart/form-data):
 *     https://docs.x.com/x-api/media/append-media-upload
 *   - Finalize Media Upload (POST /2/media/upload/{id}/finalize):
 *     https://docs.x.com/x-api/media/finalize-media-upload
 *   - Get Media Upload Status (GET /2/media/upload?command=STATUS):
 *     https://docs.x.com/x-api/media/get-media-upload-status
 *   - Create Post (POST /2/tweets — the synchronous creation, 201):
 *     https://docs.x.com/x-api/posts/create-post
 *   - Delete Post (DELETE /2/tweets/:id — documented, NOT mapped: the
 *     frozen publish operation vocabulary is closed, see the header
 *     notes): https://docs.x.com/x-api/posts/delete-post
 *   - Get Post By Id (GET /2/tweets/:id?post.fields=...):
 *     https://docs.x.com/x-api/posts/get-post-by-id
 *   - Get Posts By Ids (GET /2/tweets?ids=...):
 *     https://docs.x.com/x-api/posts/get-posts-by-ids
 *   - Search Recent Posts (GET /2/tweets/search/recent):
 *     https://docs.x.com/x-api/posts/search-recent-posts
 *   - Get Users Posts (GET /2/users/:id/tweets):
 *     https://docs.x.com/x-api/users/get-posts
 *   - Get Users Me (GET /2/users/me?user.fields=...):
 *     https://docs.x.com/x-api/users/user-lookup-me
 *   - Get Posts Analytics (GET /2/tweets/analytics):
 *     https://docs.x.com/x-api/posts/get-post-analytics
 *   - Rate limits (the x-rate-limit-* response headers):
 *     https://docs.x.com/x-api/fundamentals/rate-limits
 *   - Response codes & errors (the RFC 7807 problem envelope):
 *     https://docs.x.com/x-api/fundamentals/response-codes-and-errors
 *   - OAuth 2.0 Authorization Code Flow with PKCE (the documented
 *     scopes + the token endpoint):
 *     https://docs.x.com/x-api/fundamentals/authentication/oauth-2-0/authorization-code
 *
 * WHAT THIS ADAPTER HOLDS (the frozen port contract, ../../adapter-contract.ts):
 *   - invocation failures return as DATA (the frozen seven-code
 *     taxonomy), NEVER thrown — only malformed input throws
 *     (InvalidRequestError, fail-closed by rejection);
 *   - the provider payload rides VERBATIM as passthrough data (the
 *     normalized record shapes record, they never interpret — MKT-062
 *     owns content normalization);
 *   - engagement observations are NULLABLE facts — the documented
 *     Post.public_metrics object exposes ALL of impression_count,
 *     like_count, reply_count, repost_count (+ quote_count and
 *     bookmark_count riding the passthrough); the four normalized
 *     engagement slots map impression_count → viewCount, like_count →
 *     likeCount, reply_count → commentCount, repost_count → shareCount;
 *   - the rate-limit observation is a RECORD of observable signals per
 *     call: the documented X API response headers x-rate-limit-limit /
 *     x-rate-limit-remaining / x-rate-limit-reset (a Unix-epoch-seconds
 *     window reset) are read OPPORTUNISTICALLY from every provider
 *     answer — present headers ride the observation (successful calls
 *     included), absent headers report the honest null (the
 *     YouTube/TikTok no-header precedent), and the 429 answers add the
 *     observable Retry-After seconds where the provider sends one.
 *     Policy enforcement stays in /policies — observations are never
 *     decisions;
 *   - the publish lifecycle is the documented SYNCHRONOUS creation:
 *     submitPublish = (media present: the documented v2 chunked upload
 *     INIT → APPEND* → FINALIZE → the STATUS processing poll, then) the
 *     synchronous POST /2/tweets — the born 'published' submission (the
 *     MKT-059 immediate-publish precedent: the post is live when the
 *     201 answers; providerPublishId = providerContentId = the Post id;
 *     the 201 answer carries no timestamp — publishedAt reports the
 *     host-observed submission stamp, the MKT-059 precedent);
 *     getPublishStatus = the documented single-Post lookup
 *     (GET /2/tweets/:id?post.fields=... — the live Post's current
 *     observable state; a 404 resource-not-found answer maps onto the
 *     honest provider-unavailable, the provider reports no such post —
 *     the MKT-060 invalid_publish_id precedent);
 *   - the idempotency key is the at-most-once identity TOWARD the
 *     provider (the host fences (socialAccountId, idempotencyKey)
 *     durably — a replay NEVER reaches the adapter; POST /2/tweets
 *     exposes no client idempotency token, so the key is the
 *     adapter-side identity and the adapter never opens a second
 *     publish for a key it has already served).
 *
 * THE MEDIA-BYTE SOURCE (DISCLOSED — the smallest architecture-consistent
 * interpretation of the chunked upload requirement): the frozen
 * /social-accounts row of the module dependency matrix carries NO
 * /content-assets direction, and the §21 backstop refuses base64 blobs
 * in the normalized publish shapes — the ONLY architecture-consistent
 * byte path is the media-asset descriptor's URL hint, fetched through
 * the platform HttpCallPort in HTTP Range slices:
 *   - the port envelope (a bounded response body, at most 1,048,576
 *     bytes per call) forces the slicing: the adapter fetches the byte
 *     source in ≤512KiB Range slices and each slice becomes one
 *     documented APPEND segment (segment_index from 0 — the documented
 *     segment guidance "keep each segment at or below 5 MB" is
 *     satisfied; the port cap is the binding constraint);
 *   - each APPEND carries the chunk BASE64-encoded in the documented
 *     application/json body form — the documented AppendMediaUpload
 *     schema types the media field anyOf binary | byte (base64), and
 *     the documented upload-media description states "The media field
 *     carries the file content base64-encoded in JSON bodies (raw
 *     bytes in multipart bodies)";
 *   - the total_bytes of the documented INIT call are DISCOVERED from
 *     the byte source's own answers (the Content-Range total of a 206
 *     Partial Content answer, or the body length of a Range-ignoring
 *     200 answer) — never guessed;
 *   - the byte fidelity through the frozen port is TEXT-envelope-bound
 *     (the port carries string bodies and UTF-8-decoded responses):
 *     ASCII-clean media round-trips BYTE-EXACTLY end-to-end (verified
 *     by the loopback double's byte-exact reconstruction assertions);
 *     arbitrary binary media is lossy through the current port's
 *     UTF-8 text surface — a binary-safe port extension is a frozen
 *     platform-contract change owned by the TL, DISCLOSED here;
 *   - a media asset whose descriptor carries no resolvable byte source
 *     (no url) refuses honestly ('restricted' — the documented INIT/
 *     APPEND flow cannot proceed; the frozen taxonomy has no
 *     malformed-request code, the MKT-057..060 disclosed judgment).
 *
 * THE MEDIA PROCESSING WINDOW (the documented async part of the upload
 * flow): FINALIZE answers processing_info { state: pending |
 * in_progress | succeeded | failed, check_after_secs,
 * progress_percent } — the documented flow polls the STATUS command
 * with the documented check_after_secs cadence until succeeded/failed.
 * The adapter polls INSIDE submitPublish under a bounded deadline (the
 * providerConfig.mediaProcessingDeadlineMs deployment override, default
 * 120_000ms, bounded 1_000..600_000): the frozen poll input
 * (SocialPublishStatusInput = { providerPublishId } only) carries no
 * post body, so a still-pending upload CANNOT be completed by a later
 * getPublishStatus — a deadline-exceeded processing window fills the
 * honest TERMINAL failed attempt with the 'provider-unavailable'
 * taxonomy failure (the bounded submit window expired while the
 * provider-side processing continued — the recovery is a fresh
 * idempotency key; the frozen migration-050 CHECK forces a non-null
 * failure code on a 'failed' fill, and the timeout class is the honest
 * slot; a rejected post is REJECTED, never "pending" forever — the
 * AGENTS.md runtime rule; DISCLOSED).
 *
 * POST DELETION (declared NOT-SUPPORTED, a frozen-contract constraint —
 * DISCLOSED): DELETE /2/tweets/:id IS documented ({ data: { deleted:
 * true } }, scope tweet.write, 50/15min per user), but the frozen
 * MKT-056 publish operation vocabulary is CLOSED (submitPublish +
 * getPublishStatus ONLY — adapter-contract.ts SOCIAL_PUBLISH_OPERATIONS)
 * and the frozen contract's design rule is explicit: "unknown
 * capability keys and operations outside a declared family FAIL CLOSED
 * (registration refuses loudly)". An out-of-contract deletePost method
 * would be undeclarable through the frozen registration guards — the
 * adapter honestly declares deletion not-supported at the contract
 * level; a contract extension is the TL's frozen-schema authority, not
 * an adapter's.
 *
 * DOCUMENTED API SEMANTICS IMPLEMENTED (the provider evidence section
 * with URLs lives in docs/runbooks/MKT-061.md):
 *   users/me       GET /2/users/me?user.fields=<f,..>
 *                  — the authorized user's own User object (the
 *                    documented security: users.read + tweet.read).
 *   search/recent  GET /2/tweets/search/recent?query=<q>&max_results=<n>
 *                        &next_token=<token>&post.fields=<f,..>
 *                  — the documented recent search (the last-7-days
 *                    window; max_results minimum 10, maximum 100,
 *                    default 10; the base32hex next_token pagination;
 *                    the documented security: tweet.read + users.read).
 *   user posts     GET /2/users/{id}/tweets?max_results=<n>
 *                        &pagination_token=<token>&post.fields=<f,..>
 *                  — the user's own Posts timeline (max_results
 *                    minimum 5, maximum 100; the pagination_token
 *                    pagination; the documented security: tweet.read +
 *                    users.read).
 *   post lookup    GET /2/tweets/{id}?post.fields=<f,..>
 *                  — the single-Post read; an unknown/deleted/withheld
 *                    Post answers the documented 404
 *                    resource-not-found — the honest NULL record (the
 *                    MKT-057 empty-items precedent); a 200 answer may
 *                    carry partial errors (data + errors) — a missing
 *                    data member is the same honest null.
 *   analytics      GET /2/tweets/analytics?ids=<id,..>&start_time=<t>
 *                        &end_time=<t>&granularity=total
 *                        &analytics.fields=<f,..>
 *                  — the documented windowed per-Post analytics (ids
 *                    1..100 REQUIRED; start_time + end_time REQUIRED;
 *                    granularity total — the documented default
 *                    aggregate; the documented security: tweet.read +
 *                    users.read). The frozen input's NULL window
 *                    defaults to the trailing 30-day window (DISCLOSED
 *                    judgment — the documented required parameters
 *                    must be satisfied; the caller's explicit window
 *                    always rides verbatim).
 *   media INIT     POST /2/media/upload/initialize
 *                  body { media_type, total_bytes, media_category }
 *                  — the documented upload session initiation (the
 *                    documented media_category vocabulary tweet_image /
 *                    tweet_gif / tweet_video — the documented
 *                    inference "based on content type" when omitted;
 *                    the documented security: media.write).
 *   media APPEND   POST /2/media/upload/{id}/append
 *                  body { media: <base64 chunk>, segment_index }
 *                  — one documented APPEND per fetched byte-source
 *                    slice (segment_index from 0; the documented media
 *                    field accepts the base64 (format: byte) JSON
 *                    form).
 *   media FINALIZE POST /2/media/upload/{id}/finalize
 *                  — the documented upload completion (the answer
 *                    carries processing_info when processing is
 *                    required).
 *   media STATUS   GET /2/media/upload?command=STATUS&media_id=<id>
 *                  — the documented processing-status poll (state
 *                    pending/in_progress → keep polling after
 *                    check_after_secs; succeeded; failed).
 *   post create    POST /2/tweets
 *                  body { text, media: { media_ids }, reply, poll,
 *                         quote_tweet_id, reply_settings, ... }
 *                  — the synchronous creation (201 + { data: { id,
 *                    text } }; the documented security: users.read +
 *                    tweet.read + tweet.write; the documented media
 *                    bound: up to 4 photos, 1 GIF, or 1 video — the
 *                    provider enforces the bound, and the adapter
 *                    refuses a >4-asset request pre-upload citing the
 *                    documented CreatePostsMedia.media_ids maxItems
 *                    bound, never silently dropping assets).
 *
 * DOCUMENTED ERROR ENVELOPE (the RFC 7807 problem+json model of the
 * response-codes reference):
 *   { "title": "<text>", "detail": "<text>",
 *     "type": "https://api.x.com/2/problems/<kind>" } (+ status)
 * mapped onto the frozen taxonomy:
 *   transport refused/timeout/oversized/5xx
 *                                    → provider-unavailable (retryable)
 *   401 (any problem type)           → auth-expired (reauthorization)
 *   429 rate-limit-exceeded          → rate-limited (+ the observation:
 *                                      the documented x-rate-limit-*
 *                                      headers + the observable
 *                                      Retry-After where present)
 *   problem type usage-capped (any
 *   status — the documented usage-cap
 *   class)                           → rate-limited (+ observation)
 *   404 resource-not-found (the post
 *   lookup of an unknown Post)       → the honest NULL record (the
 *                                      single-content read only; every
 *                                      other operation's 404 rides the
 *                                      classes below)
 *   403/400 other (client-forbidden,
 *   not-authorized-for-resource,
 *   invalid-request, resource-not-
 *   found on non-read surfaces, ...) → restricted (DISCLOSED judgment:
 *                                      the frozen taxonomy has no
 *                                      malformed-request code and the
 *                                      frozen migration-050 CHECK
 *                                      (failed ⇒ failure_code NOT NULL)
 *                                      forbids the null-code processed-
 *                                      rejection row on the ATTEMPT
 *                                      ledger — the verbatim problem
 *                                      title/detail ride the failure
 *                                      message; the MKT-057..060
 *                                      precedent).
 *
 * The data-plane host resolves from the connection's NON-SECRET
 * providerConfig (the deployment override surface): apiBaseUrl
 * (defaulting to the documented public host https://api.x.com) and
 * mediaProcessingDeadlineMs (the bounded media processing poll
 * deadline, default 120_000ms). The credential MATERIAL (the §21
 * in-process bytes) carries the OAuth token bundle ({ accessToken,
 * ... }) the authorized flow provisioned — the adapter parses it
 * in-process ONLY and sends it as the documented Bearer header.
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
  SocialPublishMediaAsset,
  SocialPublishStatusInput,
  SocialPublishStatusResult,
  SocialPublishSubmitInput,
  SocialPublishSubmitResult,
  SocialRateLimitObservation,
  SocialRestrictionSignal,
  SocialRestrictionSignalsResult,
} from '../../adapter-contract.ts';
import type { HttpCallPort, HttpCallRequest, HttpCallResponse } from '../../../../../platform/http/outbound.ts';

// ---------------------------------------------------------------------------
// The honest capability matrix (the REAL documented X OAuth 2.0 scopes)
// ---------------------------------------------------------------------------

/** The platform identity: the SAME key the /integrations adapter registry uses (lock rule 18). */
export const X_SOCIAL_ADAPTER_KEY = 'x';

/**
 * The REAL documented X OAuth 2.0 scope names (verified against the
 * live scope list of the OpenAPI securitySchemes and the OAuth 2.0
 * Authorization Code Flow with PKCE reference at delivery time —
 * https://docs.x.com/x-api/fundamentals/authentication/oauth-2-0/authorization-code):
 *   users.read    — "View any account you can see, including protected
 *                   accounts" (the documented scope of GET /2/users/me
 *                   alongside tweet.read);
 *   tweet.read    — "View all posts you can see, including those from
 *                   protected accounts" (the documented scope of the
 *                   post reads, the timelines and the recent search);
 *   tweet.write   — "Create and repost on your behalf" (the documented
 *                   scope of POST /2/tweets and DELETE /2/tweets/:id);
 *   media.write   — "Upload media, such as photos and videos, on your
 *                   behalf" (the documented scope of the media upload
 *                   endpoints);
 *   offline.access— "Request a refresh token for the app" (the
 *                   documented scope that provisions the refresh token
 *                   of the MKT-055 refresh round — carried by the
 *                   authorized grant, NOT required by any adapter
 *                   operation: no capability below declares it).
 */
export const X_SCOPES = {
  usersRead: 'users.read',
  tweetRead: 'tweet.read',
  tweetWrite: 'tweet.write',
  mediaWrite: 'media.write',
  offlineAccess: 'offline.access',
} as const;

/** The adapter descriptor (the registry data view). */
export const X_SOCIAL_ADAPTER_DESCRIPTOR = {
  adapterKey: X_SOCIAL_ADAPTER_KEY,
  providerLabel: 'X (API v2 — OAuth 2.0 user context)',
  description:
    'The fifth concrete MKT-056 social platform adapter: the documented X API v2 surface (the users/me reads, the post lookup / user timeline / recent search reads, the posts analytics surface, the chunked v2 media upload lifecycle and the synchronous post creation) mapped onto the normalized capability plane over the platform HttpCallPort (fetch-based, zero provider SDKs). Failures return as the frozen seven-code taxonomy data; provider payloads ride VERBATIM as passthrough; the wiring is inert without an authorized X integration connection + OAuth 2.0 grant (the fail-closed chain precedes every provider call). Limitations are disclosed per capability (lock rule 37) — see docs/runbooks/MKT-061.md.',
} as const;

/**
 * The declared capability matrix: all five frozen families are honestly
 * supported by the documented surface — the SUBSET discipline shows in
 * the per-family REAL least-privilege documented scopes (the exact
 * documented security requirements of the mapped endpoints), the
 * documented operation mappings and the disclosed limitations per
 * family (lock rule 37: the matrix must declare limitations before
 * acceptance).
 */
export function xSocialAdapterCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [X_SCOPES.usersRead, X_SCOPES.tweetRead],
      description:
        'X account identity binding + profile reads over the documented Get Users Me endpoint (GET /2/users/me?user.fields=... — id/name/username + the profile fields + the public_metrics counts; the documented security of the endpoint is users.read + tweet.read). Limitations: the documented User object exposes the verified/verified_type BADGES and no verification timestamp — verifiedAt reports null (the badges ride the passthrough data); accountKind reports the documented subscription_type label (the X Blue subscription type, e.g. Basic/Premium/PremiumPlus/None) where the provider exposes it, null otherwise; the documented public_metrics of the surface are the account-level observed counts (followers_count, following_count, post_count, listed_count — the analytics-read family serves them as metric points).',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [X_SCOPES.tweetRead, X_SCOPES.usersRead],
      description:
        'Content reads over the documented Posts surfaces: discoverPublicContent rides GET /2/tweets/search/recent (the documented recent search — the last-7-days window, query length up to 4096, max_results 10..100 default 10, the base32hex next_token pagination); listOwnContent rides GET /2/users/{id}/tweets (the user\u2019s own Posts timeline — max_results 5..100, the pagination_token pagination); getContent rides GET /2/tweets/{id} (the single-Post read — an unknown/deleted/withheld Post answers the documented 404 resource-not-found, the honest null record). Limitations: the four normalized engagement slots map the documented public_metrics (impression/like/reply/repost counts) as observed facts, never fabricated; the search surface serves the RECENT window only (the full-archive search is a separately-gated product, not mapped).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [X_SCOPES.tweetRead, X_SCOPES.usersRead],
      description:
        'Observed metric points over the documented analytics surfaces: readAccountAnalytics = the documented users/me public_metrics (followers_count, following_count, post_count, listed_count — labels VERBATIM, current point-in-time values with null windows; the surface exposes no windowed series); readContentAnalytics = the documented Get Posts Analytics endpoint (GET /2/tweets/analytics — ids 1..100, start_time + end_time REQUIRED, granularity total: the observed metric points carry the provider\u2019s metric labels VERBATIM (impressions, engagements, likes, bookmarks, replies, retweets, shares, quote_tweets) over the requested window; the frozen input\u2019s NULL window defaults to the trailing 30-day window, DISCLOSED — the documented required parameters must be satisfied and the caller\u2019s explicit window always rides verbatim). An empty answer yields NO observations (never fabricated zeros).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [X_SCOPES.tweetRead, X_SCOPES.tweetWrite, X_SCOPES.usersRead, X_SCOPES.mediaWrite],
      description:
        'The documented synchronous post-creation lifecycle: submitPublish = (media present: the documented v2 chunked upload INIT → APPEND → FINALIZE + the STATUS processing poll over the platform HttpCallPort Range-sliced byte source) then POST /2/tweets (the born published submission — the 201 Post id is BOTH the provider publish identity and the content identity); getPublishStatus = the documented single-Post lookup (a 404 maps onto the honest provider-unavailable). Limitations: scheduledFor unused (no documented scheduling); the processing window polls under a bounded deadline (providerConfig.mediaProcessingDeadlineMs, default 120s — deadline-exceeded fills the honest TERMINAL failed attempt, never pending-forever); >4 media assets refuse pre-upload; the documented size/duration limits are the PROVIDER\u2019S to enforce; POST DELETION IS NOT SUPPORTED at the frozen contract level (the frozen publish vocabulary is closed); no idempotency token — the host fence is the at-most-once identity.',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: [X_SCOPES.usersRead, X_SCOPES.tweetRead],
      description:
        'The observable account entitlement/visibility facts of the documented users/me surface as DATA (X exposes no dedicated eligibility-query endpoint — the honest mapping of the family is the provider\u2019s own EXPOSED facts, never invented moderation state, §11): the signals are account.protected (the documented protected flag — the account\u2019s own private-posts state), account.verified_type (the documented verified type label, e.g. blue/government/business/none — the entitlement class of the documented video duration caps) and account.subscription_type (the documented X Blue subscription type, e.g. Basic/Premium/PremiumPlus/None — the documented Premium status the posting limits follow). Limitations: account-level enforcement answers (the 403 client-forbidden / not-authorized-for-resource classes) surface ONLY through the documented error semantics of the operation that hit them, as honest invocation-failure data — never pre-invented here.',
    },
  ];
}

// ---------------------------------------------------------------------------
// The documented host + the provider-config override surface
// ---------------------------------------------------------------------------

/** The documented X API server (the OpenAPI servers entry of every mapped endpoint). */
const DEFAULT_API_BASE = 'https://api.x.com';

/** The documented recent-search default page (max_results default 10; the documented minimum is 10, the maximum 100). */
const SEARCH_DEFAULT_MAX_RESULTS = 10;
/** The documented recent-search max_results bounds (minimum 10, maximum 100). */
const SEARCH_MIN_RESULTS = 10;
const SEARCH_MAX_RESULTS = 100;
/** The documented user-timeline max_results bounds (minimum 5, maximum 100); the adapter default is 10. */
const TIMELINE_MIN_RESULTS = 5;
const TIMELINE_MAX_RESULTS = 100;
const TIMELINE_DEFAULT_MAX_RESULTS = 10;

/**
 * The media byte-source slice size (one APPEND segment per slice): the
 * port envelope bounds request bodies at 1,048,576 characters and the
 * base64 JSON form expands 3 bytes to 4 characters — 512KiB of source
 * bytes base64-encode to ~699k characters, comfortably inside the port
 * envelope AND under the documented "keep each segment at or below
 * 5 MB" guidance (the port cap is the binding constraint).
 */
const MEDIA_SLICE_BYTES = 512 * 1024;

/** The documented media processing poll deadline default (the providerConfig.mediaProcessingDeadlineMs override is bounded 1s..10min). */
const DEFAULT_MEDIA_PROCESSING_DEADLINE_MS = 120_000;
const MIN_MEDIA_PROCESSING_DEADLINE_MS = 1_000;
const MAX_MEDIA_PROCESSING_DEADLINE_MS = 600_000;

const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_SIZE_CAP_BYTES = 512 * 1024;
/** The media byte-source fetch envelope: the port's maximum bounded response body (Range slices stay well under it). */
const MEDIA_FETCH_SIZE_CAP_BYTES = 1_048_576;

/** The documented per-Post media bound (CreatePostsMedia.media_ids maxItems: 4 — "up to 4 photos, 1 GIF, or 1 video"). */
const MAX_POST_MEDIA_ASSETS = 4;

function resolveBase(providerConfig: Readonly<Record<string, string>>): string {
  const override = providerConfig['apiBaseUrl'];
  const base = typeof override === 'string' && override !== '' ? override : DEFAULT_API_BASE;
  return base.replace(/\/+$/, '');
}

function resolveMediaProcessingDeadlineMs(providerConfig: Readonly<Record<string, string>>): number {
  const raw = providerConfig['mediaProcessingDeadlineMs'];
  if (typeof raw !== 'string' || raw === '') return DEFAULT_MEDIA_PROCESSING_DEADLINE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_MEDIA_PROCESSING_DEADLINE_MS;
  return Math.min(Math.max(parsed, MIN_MEDIA_PROCESSING_DEADLINE_MS), MAX_MEDIA_PROCESSING_DEADLINE_MS);
}

// ---------------------------------------------------------------------------
// The documented error envelope (RFC 7807 problem+json) + the taxonomy classification
// ---------------------------------------------------------------------------

/** The documented RFC 7807 problem subset the classifier reads. */
interface XProblemStruct {
  readonly type: string | null;
  readonly title: string | null;
  readonly detail: string | null;
}

/** Parses the documented problem envelope (a non-JSON body parses as the all-null problem — the classifier falls back to the status classes). */
function parseProblemStruct(body: string): XProblemStruct {
  try {
    const parsed = JSON.parse(body) as {
      type?: unknown;
      title?: unknown;
      detail?: unknown;
    };
    if (parsed === null || typeof parsed !== 'object') {
      return { type: null, title: null, detail: null };
    }
    return {
      type: typeof parsed.type === 'string' ? parsed.type : null,
      title: typeof parsed.title === 'string' ? parsed.title : null,
      detail: typeof parsed.detail === 'string' ? parsed.detail : null,
    };
  } catch {
    return { type: null, title: null, detail: null };
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
 * Reads the documented rate-limit observation of one provider answer
 * (the x-rate-limit-remaining / x-rate-limit-reset response headers of
 * the rate-limits reference, + the observable Retry-After seconds where
 * the provider sends one): present signals ride the observation — an
 * answer with none of them reports the honest null.
 */
function rateLimitObservationOf(response: HttpCallResponse): SocialRateLimitObservation | null {
  const header = (name: string): string | null => {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(response.headers)) {
      if (key.toLowerCase() === lower) return value;
    }
    return null;
  };
  const remaining = header('x-rate-limit-remaining');
  const reset = header('x-rate-limit-reset');
  const retryAfter = header('retry-after');
  const limitRemaining = remaining !== null && /^\d+$/.test(remaining) ? Number(remaining) : null;
  // The documented reset stamp is a Unix epoch in SECONDS.
  const limitResetAt = reset !== null && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).toISOString() : null;
  const retryAfterSeconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  const backoffUntil =
    retryAfterSeconds !== null ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString() : null;
  if (limitRemaining === null && limitResetAt === null && backoffUntil === null && retryAfterSeconds === null) {
    return null;
  }
  return { limitRemaining, limitResetAt, backoffUntil, retryAfterSeconds };
}

/**
 * Classifies a provider answer onto the frozen taxonomy (the documented
 * status/problem-type-driven mapping — see the file header). The
 * verbatim problem title/detail ride the failure message (bounded
 * excerpt).
 */
function classifyProviderFailure(
  operation: string,
  response: HttpCallResponse,
): { ok: false; failure: SocialOperationFailure } {
  const problem = parseProblemStruct(response.body);
  const problemLabel =
    problem.title !== null
      ? `problem '${problem.title}'${problem.detail !== null ? `: ${problem.detail.slice(0, 300)}` : ''}`
      : response.body.slice(0, 300);
  const label = `the X API ${operation} call failed (HTTP ${response.status}${problem.title !== null ? `, ${problemLabel}` : `: ${problemLabel}`})`;

  // Transport-class failures: the request was not satisfiably processed.
  if (response.status === 0) {
    if (response.timedOut) {
      return failureOf('provider-unavailable', `the X API ${operation} call timed out`);
    }
    if (response.transportRefused) {
      return failureOf(
        'provider-unavailable',
        `the X API ${operation} call was not processed (transport refused/unreachable)`,
      );
    }
    return failureOf(
      'provider-unavailable',
      `the X API ${operation} answer exceeded the bounded response envelope`,
    );
  }
  if (response.status >= 500) {
    return failureOf('provider-unavailable', `${label} — the provider reported a server error (retryable)`);
  }
  // The documented quota classes: the 429 rate-limit-exceeded answers
  // and the usage-capped problem type (the documented usage-cap class)
  // — the observable x-rate-limit-* headers ride the observation.
  if (response.status === 429 || (problem.type !== null && problem.type.endsWith('usage-capped'))) {
    const observation = rateLimitObservationOf(response);
    return failureOf('rate-limited', `${label} — the provider rate/quota limit was observed`, {
      limitRemaining: observation?.limitRemaining ?? null,
      limitResetAt: observation?.limitResetAt ?? null,
      backoffUntil: observation?.backoffUntil ?? null,
      retryAfterSeconds: observation?.retryAfterSeconds ?? null,
    });
  }
  // The documented 401 class: the authorization is unusable.
  if (response.status === 401) {
    return failureOf(
      'auth-expired',
      `the X API ${operation} call was refused as unauthorized (${problemLabel}) — reauthorization required`,
    );
  }
  // Every other documented refusal class (the 403 client-forbidden /
  // not-authorized-for-resource entitlement classes, the 400
  // invalid-request family, the 404 answers of the non-read surfaces —
  // the disclosed judgment): the honest non-retryable provider-side
  // refusal surfaced as 'restricted' with the verbatim problem excerpt
  // riding the message.
  return failureOf('restricted', `${label} — the provider refused the request`);
}

// ---------------------------------------------------------------------------
// The documented response shapes (the parsed subsets the mappings read)
// ---------------------------------------------------------------------------

/** The documented User object subset (Get Users Me). */
interface XUserObject {
  readonly id?: string;
  readonly name?: string;
  readonly username?: string;
  readonly created_at?: string;
  readonly description?: string;
  readonly location?: string;
  readonly profile_image_url?: string;
  readonly protected?: boolean;
  readonly verified?: boolean;
  readonly verified_type?: string;
  readonly subscription_type?: string;
  readonly public_metrics?: {
    readonly followers_count?: number;
    readonly following_count?: number;
    readonly post_count?: number;
    readonly listed_count?: number;
    readonly like_count?: number;
    readonly media_count?: number;
  };
}

/** The documented Post object subset (the reads + the creation answer). */
interface XPostObject {
  readonly id?: string;
  readonly text?: string;
  readonly created_at?: string;
  readonly author_id?: string;
  readonly public_metrics?: {
    readonly impression_count?: number;
    readonly like_count?: number;
    readonly reply_count?: number;
    readonly repost_count?: number;
    readonly quote_count?: number;
    readonly bookmark_count?: number;
  };
}

/** The documented processing_info subset (FINALIZE + STATUS). */
interface XProcessingInfo {
  readonly state?: string;
  readonly check_after_secs?: number;
  readonly progress_percent?: number;
}

/** The documented user fields the profile read requests (the least-privilege documented set of the mapped profile facts). */
const USER_PROFILE_FIELDS = [
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
] as const;

/** The documented user fields the identity binding requests. */
const USER_IDENTITY_FIELDS = ['id', 'name', 'username'] as const;

/** The documented user fields the restriction-signals read requests (the observable entitlement facts). */
const USER_SIGNAL_FIELDS = ['id', 'protected', 'verified', 'verified_type', 'subscription_type'] as const;

/** The documented post fields the content reads request. */
const POST_FIELDS = ['id', 'created_at', 'text', 'author_id', 'public_metrics'] as const;

/**
 * The documented analytics.fields set the per-content analytics read
 * requests (the bounded documented engagement vocabulary — every label
 * rides VERBATIM as the observed metric point).
 */
const ANALYTICS_FIELDS = [
  'impressions',
  'engagements',
  'likes',
  'bookmarks',
  'replies',
  'retweets',
  'shares',
  'quote_tweets',
] as const;

/** The documented NULL-window default of the per-content analytics read (DISCLOSED — the documented required start/end parameters must be satisfied). */
const ANALYTICS_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface XSocialAdapterOptions {
  /** The platform outbound HTTP port (fetch-based in production; the documented https-or-loopback envelope). */
  readonly http: HttpCallPort;
}

/**
 * Constructs the X social platform adapter (a pure object — NO provider
 * traffic at construction; the wiring is inert until the fail-closed
 * host chain hands it an authorized call context).
 */
export function createXSocialAdapter(options: XSocialAdapterOptions): SocialPlatformAdapter {
  const http = options.http;

  // -------------------------------------------------------------------------
  // The provider call helper (the shared request/classify core)
  // -------------------------------------------------------------------------

  /**
   * Issues ONE documented request through the platform port. Transport
   * and envelope failures return as the honest data failures (never
   * thrown across the port); a non-2xx answer classifies through the
   * documented status/problem-type table. The documented x-rate-limit-*
   * response headers are read opportunistically on EVERY answer — the
   * observation rides the call result when the provider sent the
   * signals (the honest null otherwise).
   */
  async function callProviderJson(
    operation: string,
    request: Omit<HttpCallRequest, 'timeoutMs' | 'sizeCapBytes'>,
  ): Promise<
    { ok: true; parsed: unknown; rateLimit: SocialRateLimitObservation | null } | { ok: false; failure: SocialOperationFailure }
  > {
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
        `the X API ${operation} call could not be issued: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return classifyProviderFailure(operation, response);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body) as unknown;
    } catch {
      return failureOf('provider-unavailable', `the X API ${operation} answer was not the documented JSON body`);
    }
    return { ok: true, parsed, rateLimit: rateLimitObservationOf(response) };
  }

  /**
   * Resolves the documented Bearer credential from the §21 in-process
   * material (the authorized flow's token bundle). Unparseable/unusable
   * material is an honest auth-expired (the authorization is unusable).
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

  /** Reads the documented data object of an answer (the `data` envelope member). */
  function dataOf(parsed: unknown): Record<string, unknown> | null {
    if (parsed === null || typeof parsed !== 'object') return null;
    const data = (parsed as { data?: unknown }).data;
    if (data === null || data === undefined || typeof data !== 'object') return null;
    return data as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------
  // The account family (GET /2/users/me)
  // -------------------------------------------------------------------------

  async function readUserMe(
    context: SocialAdapterCallContext,
    operation: string,
    fields: readonly string[],
  ): Promise<
    | { ok: true; user: XUserObject; rateLimit: SocialRateLimitObservation | null }
    | { ok: false; failure: SocialOperationFailure }
  > {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    const answer = await callProviderJson(operation, {
      url: `${base}/2/users/me?user.fields=${fields.map((field) => encodeURIComponent(field)).join(',')}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const user = dataOf(answer.parsed);
    if (user === null) {
      return failureOf(
        'provider-unavailable',
        `the X API ${operation} answer carried no documented data object`,
      );
    }
    return { ok: true, user: user as unknown as XUserObject, rateLimit: answer.rateLimit };
  }

  async function verifyAccountIdentity(context: SocialAdapterCallContext): Promise<SocialAccountIdentityResult> {
    const outcome = await readUserMe(context, 'verifyAccountIdentity (users/me)', USER_IDENTITY_FIELDS);
    if (!outcome.ok) return outcome;
    if (typeof outcome.user.id !== 'string' || outcome.user.id === '') {
      return failureOf(
        'provider-unavailable',
        'the X API verifyAccountIdentity (users/me) answer carried no documented User id',
      );
    }
    const display =
      typeof outcome.user.name === 'string' && outcome.user.name !== ''
        ? typeof outcome.user.username === 'string' && outcome.user.username !== ''
          ? `${outcome.user.name} (@${outcome.user.username})`
          : outcome.user.name
        : typeof outcome.user.username === 'string' && outcome.user.username !== ''
          ? `@${outcome.user.username}`
          : outcome.user.id;
    return {
      ok: true,
      // The documented users/me surface exposes the verified /
      // verified_type BADGES (booleans and labels), not a verification
      // timestamp — verifiedAt null (disclosed; the badges ride the
      // profile passthrough data).
      identity: { externalAccountId: outcome.user.id, displayIdentity: display, verifiedAt: null },
      rateLimit: outcome.rateLimit,
    };
  }

  async function getAccountProfile(context: SocialAdapterCallContext): Promise<SocialAccountProfileResult> {
    const outcome = await readUserMe(context, 'getAccountProfile (users/me)', USER_PROFILE_FIELDS);
    if (!outcome.ok) return outcome;
    const user = outcome.user;
    if (typeof user.id !== 'string' || user.id === '') {
      return failureOf(
        'provider-unavailable',
        'the X API getAccountProfile (users/me) answer carried no documented User id',
      );
    }
    const display =
      typeof user.name === 'string' && user.name !== ''
        ? typeof user.username === 'string' && user.username !== ''
          ? `${user.name} (@${user.username})`
          : user.name
        : typeof user.username === 'string' && user.username !== ''
          ? `@${user.username}`
          : user.id;
    return {
      ok: true,
      profile: {
        externalAccountId: user.id,
        displayIdentity: display,
        // The documented surface exposes the verified/verified_type
        // badges, not a verification timestamp — null (disclosed).
        verifiedAt: null,
        // The documented account-type label of the surface: the X Blue
        // subscription_type (Basic/Premium/PremiumPlus/None) — the
        // provider's OWN account-tier label, passthrough-honest.
        accountKind:
          typeof user.subscription_type === 'string' && user.subscription_type !== '' ? user.subscription_type : null,
        followerCount:
          typeof user.public_metrics?.followers_count === 'number' &&
          Number.isFinite(user.public_metrics.followers_count)
            ? user.public_metrics.followers_count
            : null,
        data: user as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: outcome.rateLimit,
    };
  }

  // -------------------------------------------------------------------------
  // The content-read family (search/recent + users/:id/tweets + tweets/:id)
  // -------------------------------------------------------------------------

  /** Maps the documented Post object onto the normalized content record. */
  function postRecordOf(post: XPostObject) {
    const createdAt = typeof post.created_at === 'string' && post.created_at !== '' ? post.created_at : null;
    const metrics = post.public_metrics;
    return {
      providerContentId: post.id!,
      authorExternalAccountId: typeof post.author_id === 'string' && post.author_id !== '' ? post.author_id : null,
      contentFormat: 'x#post',
      // The documented created_at is the Post's creation timestamp
      // (ISO-8601, second precision).
      publishedAt: createdAt,
      sourceTimestamp: createdAt,
      // The documented Post.public_metrics object: the four normalized
      // engagement slots map impression_count → viewCount, like_count →
      // likeCount, reply_count → commentCount, repost_count →
      // shareCount (quote_count and bookmark_count ride the VERBATIM
      // passthrough) — observed facts only, never fabricated.
      engagement: {
        viewCount:
          typeof metrics?.impression_count === 'number' && Number.isFinite(metrics.impression_count)
            ? metrics.impression_count
            : null,
        likeCount:
          typeof metrics?.like_count === 'number' && Number.isFinite(metrics.like_count) ? metrics.like_count : null,
        commentCount:
          typeof metrics?.reply_count === 'number' && Number.isFinite(metrics.reply_count) ? metrics.reply_count : null,
        shareCount:
          typeof metrics?.repost_count === 'number' && Number.isFinite(metrics.repost_count)
            ? metrics.repost_count
            : null,
      },
      data: post as unknown as Readonly<Record<string, unknown>>,
      etag: null,
      sourceVersion: null,
    };
  }

  /** The documented Post list of an answer onto normalized records (malformed members are skipped, never guessed). */
  function postRecordsOf(data: unknown): readonly ReturnType<typeof postRecordOf>[] {
    const posts = Array.isArray(data) ? data : [];
    const records: ReturnType<typeof postRecordOf>[] = [];
    for (const candidate of posts) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const post = candidate as XPostObject;
      if (typeof post.id !== 'string' || post.id === '') continue;
      records.push(postRecordOf(post));
    }
    return records;
  }

  async function discoverPublicContent(
    context: SocialAdapterCallContext,
    input: SocialContentDiscoveryQuery,
  ): Promise<SocialContentPageResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('discoverPublicContent (search/recent)');
    const base = resolveBase(context.providerConfig);
    // The documented recent-search bound: max_results minimum 10,
    // maximum 100, default 10 (the frozen limit clamps into the
    // documented window).
    const maxResults = Math.min(
      Math.max(input.limit ?? SEARCH_DEFAULT_MAX_RESULTS, SEARCH_MIN_RESULTS),
      SEARCH_MAX_RESULTS,
    );
    const query = new URLSearchParams({
      query: input.query,
      max_results: String(maxResults),
      'post.fields': POST_FIELDS.join(','),
    });
    if (input.pageCursor !== null && input.pageCursor !== '') {
      query.set('next_token', input.pageCursor);
    }
    const answer = await callProviderJson('discoverPublicContent (search/recent)', {
      url: `${base}/2/tweets/search/recent?${query.toString()}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const parsed = answer.parsed as { data?: unknown; meta?: { next_token?: unknown } };
    const records = postRecordsOf(parsed?.data);
    const nextToken = parsed?.meta?.next_token;
    return {
      ok: true,
      page: {
        records,
        // The documented base32hex next_token pagination (the frozen
        // page-cursor shape carries it verbatim).
        pageCursor: typeof nextToken === 'string' && nextToken !== '' ? nextToken : null,
      },
      rateLimit: answer.rateLimit,
    };
  }

  async function listOwnContent(
    context: SocialAdapterCallContext,
    input: SocialContentListQuery,
  ): Promise<SocialContentPageResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('listOwnContent (users/:id/tweets)');
    const base = resolveBase(context.providerConfig);
    // The documented user-timeline bound: max_results minimum 5,
    // maximum 100 (the frozen limit clamps into the documented window).
    const maxResults = Math.min(
      Math.max(input.limit ?? TIMELINE_DEFAULT_MAX_RESULTS, TIMELINE_MIN_RESULTS),
      TIMELINE_MAX_RESULTS,
    );
    const query = new URLSearchParams({
      max_results: String(maxResults),
      'post.fields': POST_FIELDS.join(','),
    });
    if (input.pageCursor !== null && input.pageCursor !== '') {
      query.set('pagination_token', input.pageCursor);
    }
    const answer = await callProviderJson('listOwnContent (users/:id/tweets)', {
      url: `${base}/2/users/${encodeURIComponent(context.externalAccountId)}/tweets?${query.toString()}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const parsed = answer.parsed as { data?: unknown; meta?: { next_token?: unknown } };
    const records = postRecordsOf(parsed?.data);
    const nextToken = parsed?.meta?.next_token;
    return {
      ok: true,
      page: {
        records,
        pageCursor: typeof nextToken === 'string' && nextToken !== '' ? nextToken : null,
      },
      rateLimit: answer.rateLimit,
    };
  }

  async function getContent(
    context: SocialAdapterCallContext,
    input: SocialContentReadInput,
  ): Promise<SocialContentResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('getContent (tweets/:id)');
    const base = resolveBase(context.providerConfig);
    const query = new URLSearchParams({ 'post.fields': POST_FIELDS.join(',') });
    const answer = await callProviderJson('getContent (tweets/:id)', {
      url: `${base}/2/tweets/${encodeURIComponent(input.providerContentId)}?${query.toString()}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) {
      // The documented resource-not-found answer of the single-Post
      // lookup (HTTP 404 — an unknown/deleted/withheld Post): the
      // honest NULL record (the documented missing-resource semantics,
      // the MKT-057 empty-items precedent — never a fabricated
      // failure).
      if (answer.failure.code === 'restricted' && answer.failure.message.includes('HTTP 404')) {
        return { ok: true, record: null, rateLimit: null };
      }
      return answer;
    }
    const post = dataOf(answer.parsed) as XPostObject | null;
    if (post === null || typeof post.id !== 'string' || post.id === '') {
      // A 200 answer carrying partial errors with no data member is the
      // same honest null (the documented partial-error model).
      return { ok: true, record: null, rateLimit: answer.rateLimit };
    }
    return { ok: true, record: postRecordOf(post), rateLimit: answer.rateLimit };
  }

  // -------------------------------------------------------------------------
  // The analytics-read family (users/me public_metrics + /2/tweets/analytics)
  // -------------------------------------------------------------------------

  async function readAccountAnalytics(
    context: SocialAdapterCallContext,
    input: { readonly windowStart: string | null; readonly windowEnd: string | null },
  ): Promise<SocialAnalyticsResult> {
    void input;
    // The documented account-level statistical surface: the users/me
    // public_metrics (point-in-time current values — the surface
    // exposes no windowed series; the caller window is honestly unused
    // there, DISCLOSED). The labels ride VERBATIM.
    const outcome = await readUserMe(context, 'readAccountAnalytics (users/me public_metrics)', ['public_metrics']);
    if (!outcome.ok) return outcome;
    const metrics = outcome.user.public_metrics;
    const observations: SocialAnalyticsObservation[] = [];
    if (metrics !== undefined) {
      const metricLabels: readonly (keyof NonNullable<XUserObject['public_metrics']>)[] = [
        'followers_count',
        'following_count',
        'post_count',
        'listed_count',
        'like_count',
        'media_count',
      ];
      for (const label of metricLabels) {
        const value = metrics[label];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        observations.push({
          metric: label,
          value,
          windowStart: null,
          windowEnd: null,
          data: { field: label },
        });
      }
    }
    return { ok: true, observations, rateLimit: outcome.rateLimit };
  }

  /** Formats a frozen ISO window stamp onto the documented RFC3339 second-precision form the analytics endpoint reads. */
  function xTimestampOf(iso: string): string {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return iso;
    return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  async function readContentAnalytics(
    context: SocialAdapterCallContext,
    input: {
      readonly providerContentIds: readonly string[];
      readonly windowStart: string | null;
      readonly windowEnd: string | null;
    },
  ): Promise<SocialAnalyticsResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('readContentAnalytics (tweets/analytics)');
    const base = resolveBase(context.providerConfig);
    // The documented REQUIRED start_time/end_time parameters: the
    // caller's explicit window rides verbatim; a NULL window defaults
    // to the trailing 30-day window (DISCLOSED — the documented
    // required parameters must be satisfied; the observed window
    // stamps ride every metric point honestly).
    const windowEnd = input.windowEnd ?? new Date().toISOString();
    const windowStart =
      input.windowStart ?? new Date(Date.parse(windowEnd) - ANALYTICS_DEFAULT_WINDOW_MS).toISOString();
    const query = new URLSearchParams({
      ids: input.providerContentIds.join(','),
      start_time: xTimestampOf(windowStart),
      end_time: xTimestampOf(windowEnd),
      granularity: 'total',
      'analytics.fields': ANALYTICS_FIELDS.join(','),
    });
    const answer = await callProviderJson('readContentAnalytics (tweets/analytics)', {
      url: `${base}/2/tweets/analytics?${query.toString()}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const parsed = answer.parsed as { data?: unknown };
    const rows = Array.isArray(parsed?.data) ? (parsed!.data as unknown[]) : [];
    const observations: SocialAnalyticsObservation[] = [];
    for (const candidate of rows) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const row = candidate as Record<string, unknown>;
      const postId = typeof row['id'] === 'string' ? row['id'] : null;
      for (const label of ANALYTICS_FIELDS) {
        const value = row[label];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        observations.push({
          metric: label,
          value,
          windowStart,
          windowEnd,
          data: { id: postId, field: label },
        });
      }
    }
    return { ok: true, observations, rateLimit: answer.rateLimit };
  }

  // -------------------------------------------------------------------------
  // The restriction-signals family (the observable users/me entitlement facts)
  // -------------------------------------------------------------------------

  async function readRestrictionSignals(context: SocialAdapterCallContext): Promise<SocialRestrictionSignalsResult> {
    const outcome = await readUserMe(
      context,
      'readRestrictionSignals (users/me entitlement facts)',
      USER_SIGNAL_FIELDS,
    );
    if (!outcome.ok) return outcome;
    const user = outcome.user;
    const signals: SocialRestrictionSignal[] = [];
    // ONLY the documented observable account facts ride as signals —
    // the provider's own EXPOSED labels, never invented moderation
    // state (§11): the protected flag (the account's own private-posts
    // state), the verified_type label and the X Blue subscription_type
    // (the documented entitlement classes the posting limits follow).
    if (typeof user.protected === 'boolean') {
      signals.push({
        signalKind: 'account.protected',
        observedAt: null,
        description: `the users/me surface reports the account's protected (private posts) state as ${user.protected}`,
        data: { protected: user.protected },
      });
    }
    if (typeof user.verified_type === 'string' && user.verified_type !== '') {
      signals.push({
        signalKind: 'account.verified_type',
        observedAt: null,
        description: `the users/me surface reports the documented verified type '${user.verified_type}' (the entitlement class of the documented video duration caps)`,
        data: { verified_type: user.verified_type },
      });
    }
    if (typeof user.subscription_type === 'string' && user.subscription_type !== '') {
      signals.push({
        signalKind: 'account.subscription_type',
        observedAt: null,
        description: `the users/me surface reports the documented X Blue subscription type '${user.subscription_type}' (the documented Premium status the posting limits follow)`,
        data: { subscription_type: user.subscription_type },
      });
    }
    return { ok: true, signals, rateLimit: outcome.rateLimit };
  }

  // -------------------------------------------------------------------------
  // The publish family (the documented chunked upload + the synchronous creation)
  // -------------------------------------------------------------------------

  /**
   * The resolved byte source of one media asset (the disclosed
   * interpretation: the descriptor's url hint fetched through the
   * platform HttpCallPort in HTTP Range slices — the only
   * architecture-consistent byte path; /content-assets is not a
   * social-accounts matrix direction and the §21 backstop refuses
   * base64 blobs in the normalized shapes).
   */
  interface MediaByteSource {
    readonly url: string;
    readonly mimeType: string;
  }

  function mediaSourceOf(
    asset: SocialPublishMediaAsset,
  ): { ok: true; source: MediaByteSource } | { ok: false; failure: SocialOperationFailure } {
    const url = asset.descriptor['url'] ?? asset.descriptor['mediaUrl'];
    if (typeof url !== 'string' || url === '') {
      return failureOf(
        'restricted',
        `the media asset '${asset.assetReference}' carries no resolvable byte source (no url descriptor) — the documented v2 chunked upload (INIT/APPEND/FINALIZE) cannot proceed; the frozen taxonomy has no malformed-request code (the disclosed judgment), and the operation is refused before any provider traffic`,
      );
    }
    const mime = asset.descriptor['mime'] ?? asset.descriptor['mimeType'];
    if (typeof mime !== 'string' || mime === '') {
      return failureOf(
        'restricted',
        `the media asset '${asset.assetReference}' carries no mime hint — the documented INIT media_type cannot be determined; the operation is refused before any provider traffic (the disclosed judgment)`,
      );
    }
    return { ok: true, source: { url, mimeType: mime } };
  }

  /**
   * The documented media_category inference ("If you omit
   * media_category, the upload is treated as Post media (tweet_image,
   * tweet_video, or tweet_gif) based on content type") — derived from
   * the asset's own mime/media-kind facts, never guessed beyond the
   * documented inference.
   */
  function mediaCategoryOf(mimeType: string, mediaKind: string): string {
    if (mimeType === 'image/gif') return 'tweet_gif';
    if (mimeType.startsWith('video/')) return 'tweet_video';
    if (mimeType.startsWith('image/')) return 'tweet_image';
    if (mediaKind === 'gif') return 'tweet_gif';
    if (mediaKind === 'video') return 'tweet_video';
    return 'tweet_image';
  }

  /**
   * One bounded slice fetch of the media byte source (the documented
   * HTTP Range mechanism — the port envelope's bounded response body
   * forces the slicing). A range-capable source answers 206 Partial
   * Content with the Content-Range total; a range-ignoring source
   * answers 200 with the FULL asset (only usable when it fits the
   * bounded envelope — the honest refusal otherwise).
   */
  async function fetchMediaSlice(
    operation: string,
    url: string,
    offset: number,
    length: number,
  ): Promise<
    | {
        ok: true;
        readonly mode: 'ranged' | 'full';
        readonly body: string;
        readonly totalBytes: number;
      }
    | { ok: false; failure: SocialOperationFailure }
  > {
    let response: HttpCallResponse;
    try {
      response = await http.request({
        url,
        method: 'GET',
        headers: { range: `bytes=${offset}-${offset + length - 1}` },
        body: null,
        timeoutMs: REQUEST_TIMEOUT_MS,
        sizeCapBytes: MEDIA_FETCH_SIZE_CAP_BYTES,
      });
    } catch (error) {
      return failureOf(
        'provider-unavailable',
        `the media byte source fetch could not be issued: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 0) {
      if (response.timedOut) {
        return failureOf('provider-unavailable', `the media byte source fetch timed out (${operation})`);
      }
      if (response.transportRefused) {
        return failureOf(
          'provider-unavailable',
          `the media byte source fetch was not processed (transport refused/unreachable — ${operation})`,
        );
      }
      return failureOf(
        'provider-unavailable',
        `the media byte source answer exceeded the bounded response envelope (${operation})`,
      );
    }
    if (response.status >= 500) {
      return failureOf(
        'provider-unavailable',
        `the media byte source fetch failed (HTTP ${response.status} — retryable; ${operation})`,
      );
    }
    if (response.status === 206) {
      // The documented partial-content answer: the Content-Range header
      // carries the authoritative total ("bytes start-end/TOTAL").
      const contentRange = response.headers['content-range'] ?? response.headers['Content-Range'] ?? null;
      const totalMatch = contentRange !== null ? /\/(\d+|\*)$/.exec(contentRange) : null;
      const totalBytes = totalMatch !== null && totalMatch[1] !== '*' ? Number(totalMatch[1]) : null;
      if (totalBytes === null || !Number.isInteger(totalBytes)) {
        return failureOf(
          'restricted',
          `the media byte source answered 206 without a resolvable Content-Range total (${operation}) — the documented INIT total_bytes cannot be determined`,
        );
      }
      return { ok: true, mode: 'ranged', body: response.body, totalBytes };
    }
    if (response.status === 200) {
      // The byte source ignored the Range request: the full asset rides
      // the bounded body — only usable when the whole asset fits the
      // port envelope (the honest refusal otherwise; DISCLOSED).
      if (response.body.length === 0) {
        const contentLength = response.headers['content-length'] ?? response.headers['Content-Length'] ?? null;
        const declared = contentLength !== null && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
        if (declared !== null && declared > MEDIA_FETCH_SIZE_CAP_BYTES) {
          return failureOf(
            'restricted',
            `the media byte source does not serve HTTP Range requests and the asset (${declared} bytes) exceeds the bounded port envelope — the documented chunked upload cannot proceed (${operation}; DISCLOSED)`,
          );
        }
      }
      return { ok: true, mode: 'full', body: response.body, totalBytes: response.body.length };
    }
    const problem = parseProblemStruct(response.body);
    const problemLabel =
      problem.title !== null
        ? `problem '${problem.title}'${problem.detail !== null ? `: ${problem.detail.slice(0, 200)}` : ''}`
        : response.body.slice(0, 200);
    return failureOf(
      'restricted',
      `the media byte source fetch was refused (HTTP ${response.status}, ${problemLabel} — ${operation})`,
    );
  }

  /** Issues ONE provider request of the documented chunked upload flow (INIT/APPEND/FINALIZE/STATUS share the classify core). */
  async function mediaCall(
    operation: string,
    request: Omit<HttpCallRequest, 'timeoutMs' | 'sizeCapBytes'>,
  ): Promise<
    | { ok: true; data: Record<string, unknown>; rateLimit: SocialRateLimitObservation | null }
    | { ok: false; failure: SocialOperationFailure }
  > {
    const answer = await callProviderJson(operation, request);
    if (!answer.ok) return answer;
    const data = dataOf(answer.parsed);
    if (data === null) {
      return failureOf('provider-unavailable', `the X API ${operation} answer carried no documented data object`);
    }
    return { ok: true, data, rateLimit: answer.rateLimit };
  }

  /**
   * The documented v2 chunked media upload of ONE asset: INIT (the JSON
   * session initiation with the DISCOVERED total_bytes) → APPEND per
   * fetched byte-source slice (the documented base64 JSON form) →
   * FINALIZE → the bounded STATUS processing poll (the documented
   * check_after_secs cadence under the mediaProcessingDeadlineMs
   * deadline). Returns the documented media id on success (state
   * succeeded / no processing required).
   */
  async function uploadMediaAsset(
    context: SocialAdapterCallContext,
    asset: SocialPublishMediaAsset,
  ): Promise<
    | {
        ok: true;
        readonly mediaId: string;
        readonly providerData: Readonly<Record<string, unknown>>;
        readonly rateLimit: SocialRateLimitObservation | null;
      }
    | { ok: false; failure: SocialOperationFailure }
  > {
    const source = mediaSourceOf(asset);
    if (!source.ok) return source;
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('submitPublish (media upload)');
    const base = resolveBase(context.providerConfig);
    const operation = `submitPublish (media upload of ${asset.assetReference})`;

    // The FIRST slice fetch discovers the authoritative total (the
    // Content-Range total of a 206 answer, or the body length of a
    // range-ignoring 200 answer) — never a guessed number.
    const firstSlice = await fetchMediaSlice(operation, source.source.url, 0, MEDIA_SLICE_BYTES);
    if (!firstSlice.ok) return firstSlice;
    const totalBytes = firstSlice.totalBytes;

    // The documented INIT: the JSON session initiation.
    const init = await mediaCall(`${operation} INIT`, {
      url: `${base}/2/media/upload/initialize`,
      method: 'POST',
      headers: { ...authHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify({
        media_type: source.source.mimeType,
        total_bytes: totalBytes,
        media_category: mediaCategoryOf(source.source.mimeType, asset.mediaKind),
      }),
    });
    if (!init.ok) return init;
    const uploadId = init.data['id'];
    if (typeof uploadId !== 'string' || uploadId === '') {
      return failureOf(
        'provider-unavailable',
        `the X API ${operation} INIT answer carried no documented upload session id`,
      );
    }

    // The documented APPEND loop: one segment per fetched slice
    // (segment_index from 0; the media chunk rides the documented
    // base64 JSON form — the AppendMediaUpload schema types the media
    // field anyOf binary | byte).
    let segmentIndex = 0;
    let pending = firstSlice.body;
    let offset = firstSlice.mode === 'full' ? firstSlice.body.length : MEDIA_SLICE_BYTES;
    while (pending !== '' || segmentIndex === 0) {
      const append = await mediaCall(`${operation} APPEND[${segmentIndex}]`, {
        url: `${base}/2/media/upload/${encodeURIComponent(uploadId)}/append`,
        method: 'POST',
        headers: { ...authHeaders(bearer), 'content-type': 'application/json' },
        body: JSON.stringify({
          media: Buffer.from(pending, 'utf8').toString('base64'),
          segment_index: segmentIndex,
        }),
      });
      if (!append.ok) return append;
      segmentIndex += 1;
      if (firstSlice.mode === 'full' || offset >= totalBytes) break;
      const slice = await fetchMediaSlice(operation, source.source.url, offset, MEDIA_SLICE_BYTES);
      if (!slice.ok) return slice;
      pending = slice.body;
      offset += slice.body.length;
      if (pending === '') break;
    }

    // The documented FINALIZE: the upload completion (the answer
    // carries processing_info when processing is required).
    const finalize = await mediaCall(`${operation} FINALIZE`, {
      url: `${base}/2/media/upload/${encodeURIComponent(uploadId)}/finalize`,
      method: 'POST',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!finalize.ok) return finalize;

    // The documented processing window: poll the STATUS command with
    // the documented check_after_secs cadence until succeeded/failed,
    // under the bounded mediaProcessingDeadlineMs deadline (a
    // deadline-exceeded window reports the honest TERMINAL failed
    // state — the frozen poll input carries no post body, so a pending
    // upload cannot complete from a later poll; DISCLOSED).
    const deadline = Date.now() + resolveMediaProcessingDeadlineMs(context.providerConfig);
    let processingInfo = finalize.data['processing_info'] as XProcessingInfo | undefined;
    let lastData: Record<string, unknown> = finalize.data;
    let lastRateLimit: SocialRateLimitObservation | null = finalize.rateLimit;
    let waitMs =
      typeof processingInfo?.check_after_secs === 'number' ? Math.max(0, processingInfo.check_after_secs * 1000) : 0;
    let state = typeof processingInfo?.state === 'string' ? processingInfo.state : 'succeeded';
    while (state === 'pending' || state === 'in_progress') {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return failureOf(
          'provider-unavailable',
          `the media processing of upload ${uploadId} did not complete within the bounded submit window (state '${state}' at the deadline — the providerConfig.mediaProcessingDeadlineMs override bounds the documented STATUS poll; the upload session expires after the documented expires_after_secs; the honest recovery is a fresh idempotency key, which re-uploads; DISCLOSED)`,
        );
      }
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, remaining)));
      }
      const status = await mediaCall(`${operation} STATUS`, {
        url: `${base}/2/media/upload?command=STATUS&media_id=${encodeURIComponent(uploadId)}`,
        method: 'GET',
        headers: authHeaders(bearer),
        body: null,
      });
      if (!status.ok) return status;
      lastData = status.data;
      lastRateLimit = status.rateLimit;
      processingInfo = status.data['processing_info'] as XProcessingInfo | undefined;
      state = typeof processingInfo?.state === 'string' ? processingInfo.state : 'succeeded';
      waitMs =
        typeof processingInfo?.check_after_secs === 'number' ? Math.max(0, processingInfo.check_after_secs * 1000) : 0;
    }
    if (state === 'failed') {
      // The documented processing failure: the honest TERMINAL failed
      // state (the v2 processing_info carries the state; the current
      // documented schema exposes no error sub-object — the verbatim
      // processing_info rides the submission data).
      return failureOf(
        'restricted',
        `the media processing of upload ${uploadId} reported the documented processing_info state 'failed' (the provider's own processing rejection)`,
      );
    }
    if (state !== 'succeeded') {
      // An undocumented processing state: the honest refusal (never
      // guessed).
      return failureOf(
        'provider-unavailable',
        `the media processing of upload ${uploadId} answered the undocumented state '${String(state)}'`,
      );
    }
    return { ok: true, mediaId: uploadId, providerData: lastData, rateLimit: lastRateLimit };
  }

  /**
   * Maps the normalized publish request onto the documented POST
   * /2/tweets body: the provider-shaped payload params (text, the
   * interaction settings, the reply/quote/poll configuration) + the
   * uploaded media ids. The provider owns validation — a documented
   * 400/403 surfaces as the honest taxonomy data failure (never a
   * fabricated adapter-side rejection). scheduledFor is honestly
   * UNUSED (the documented creation surface exposes no scheduling
   * parameter).
   */
  function createPostBodyOf(
    input: SocialPublishSubmitInput,
    mediaIds: readonly string[],
  ): Readonly<Record<string, unknown>> {
    const payload = input.request.payload as Readonly<Record<string, unknown>>;
    const body: Record<string, unknown> = {};
    if (typeof payload['text'] === 'string') body['text'] = payload['text'];
    if (mediaIds.length > 0) {
      const media: Record<string, unknown> = { media_ids: [...mediaIds] };
      if (typeof payload['mediaDescription'] === 'string' && payload['mediaDescription'] !== '') {
        media['description'] = payload['mediaDescription'];
      }
      body['media'] = media;
    }
    const replyTo = payload['inReplyToPostId'] ?? payload['inReplyToTweetId'];
    if (typeof replyTo === 'string' && replyTo !== '') {
      const reply: Record<string, unknown> = { in_reply_to_tweet_id: replyTo };
      if (Array.isArray(payload['excludeReplyUserIds'])) {
        reply['exclude_reply_user_ids'] = (payload['excludeReplyUserIds'] as unknown[])
          .filter((id): id is string => typeof id === 'string' && id !== '')
          .slice(0, 100);
      }
      body['reply'] = reply;
    }
    const quoteId = payload['quotePostId'] ?? payload['quoteTweetId'];
    if (typeof quoteId === 'string' && quoteId !== '') body['quote_tweet_id'] = quoteId;
    const poll = payload['poll'];
    if (poll !== null && typeof poll === 'object' && !Array.isArray(poll)) {
      const pollInput = poll as Record<string, unknown>;
      const options = Array.isArray(pollInput['options'])
        ? (pollInput['options'] as unknown[]).filter((option): option is string => typeof option === 'string')
        : [];
      const durationMinutes = pollInput['durationMinutes'];
      if (options.length > 0) {
        const pollBody: Record<string, unknown> = { options: [...options] };
        if (typeof durationMinutes === 'number' && Number.isFinite(durationMinutes)) {
          pollBody['duration_minutes'] = durationMinutes;
        }
        body['poll'] = pollBody;
      }
    }
    for (const [payloadKey, documentedKey] of [
      ['replySettings', 'reply_settings'],
      ['forSuperFollowersOnly', 'for_super_followers_only'],
      ['shareWithFollowers', 'share_with_followers'],
      ['madeWithAi', 'made_with_ai'],
      ['paidPartnership', 'paid_partnership'],
      ['nullcast', 'nullcast'],
      ['communityId', 'community_id'],
      ['directMessageDeepLink', 'direct_message_deep_link'],
      ['cardUri', 'card_uri'],
    ] as const) {
      const value = payload[payloadKey];
      if (typeof value === 'string' && value !== '') body[documentedKey] = value;
      if (typeof value === 'boolean') body[documentedKey] = value;
    }
    const geo = payload['geo'];
    if (geo !== null && typeof geo === 'object' && !Array.isArray(geo)) {
      const placeId = (geo as Record<string, unknown>)['placeId'];
      if (typeof placeId === 'string' && placeId !== '') body['geo'] = { place_id: placeId };
    }
    return body;
  }

  async function submitPublish(
    context: SocialAdapterCallContext,
    input: SocialPublishSubmitInput,
  ): Promise<SocialPublishSubmitResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('submitPublish (tweets creation)');
    const base = resolveBase(context.providerConfig);
    const mediaAssets = input.request.mediaAssets;
    // The documented per-Post media bound (CreatePostsMedia.media_ids
    // maxItems: 4 — "A Post may include up to 4 photos, 1 animated GIF,
    // or 1 video"): the provider's own documented request shape. A
    // request exceeding it refuses PRE-UPLOAD citing the documented
    // bound (never a silent asset drop; the provider would reject the
    // creation with the same bound — the early refusal only saves the
    // pointless upload traffic).
    if (mediaAssets.length > MAX_POST_MEDIA_ASSETS) {
      return failureOf(
        'restricted',
        `the publish request carries ${mediaAssets.length} media assets — the documented CreatePostsMedia.media_ids bound is maxItems ${MAX_POST_MEDIA_ASSETS} ("A Post may include up to 4 photos, 1 animated GIF, or 1 video"); the operation is refused before any provider traffic`,
      );
    }
    // The documented chunked upload of every media asset (the honest
    // per-chunk failure states ride the taxonomy; the observation of
    // the LAST provider call of the chain rides the result).
    const mediaIds: string[] = [];
    let mediaRateLimit: SocialRateLimitObservation | null = null;
    let mediaProviderData: Readonly<Record<string, unknown>> | null = null;
    for (const asset of mediaAssets) {
      const upload = await uploadMediaAsset(context, asset);
      if (!upload.ok) return upload;
      mediaIds.push(upload.mediaId);
      mediaRateLimit = upload.rateLimit;
      mediaProviderData = upload.providerData;
    }
    // The documented synchronous creation: POST /2/tweets (201 + the
    // created Post id — the born published submission, the MKT-059
    // immediate-publish precedent).
    const creation = await callProviderJson('submitPublish (tweets creation)', {
      url: `${base}/2/tweets`,
      method: 'POST',
      headers: { ...authHeaders(bearer), 'content-type': 'application/json' },
      body: JSON.stringify(createPostBodyOf(input, mediaIds)),
    });
    if (!creation.ok) return creation;
    const created = dataOf(creation.parsed) as { id?: unknown } | null;
    const postId = created?.id;
    if (typeof postId !== 'string' || postId === '') {
      // A 2xx creation answer without the documented data.id (the
      // documented partial-error model may carry errors[] instead) —
      // the honest provider-unavailable, never a fabricated success.
      return failureOf(
        'provider-unavailable',
        'the X API submitPublish (tweets creation) answer carried no documented Post id',
      );
    }
    return {
      ok: true,
      submission: {
        // The documented synchronous surface: the Post is live when the
        // 201 answers — the born 'published' submission with the Post
        // id as BOTH the provider publish identity and the content
        // identity (the MKT-059 immediate-publish precedent). The 201
        // answer carries no timestamp — publishedAt reports the
        // host-observed submission stamp.
        publishState: 'published',
        providerPublishId: postId,
        providerContentId: postId,
        publishedAt: new Date().toISOString(),
        providerFailureReason: null,
        restrictionSignals: [],
        providerData: {
          ...(creation.parsed as Record<string, unknown>),
          ...(mediaProviderData !== null ? { media_uploads: [mediaProviderData] } : {}),
        },
      },
      rateLimit: creation.rateLimit ?? mediaRateLimit,
    };
  }

  async function getPublishStatus(
    context: SocialAdapterCallContext,
    input: SocialPublishStatusInput,
  ): Promise<SocialPublishStatusResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('getPublishStatus (tweets/:id)');
    const base = resolveBase(context.providerConfig);
    const query = new URLSearchParams({ 'post.fields': POST_FIELDS.join(',') });
    const answer = await callProviderJson('getPublishStatus (tweets/:id)', {
      url: `${base}/2/tweets/${encodeURIComponent(input.providerPublishId)}?${query.toString()}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) {
      // The documented 404 resource-not-found answer (the provider
      // reports no such post — the MKT-060 invalid_publish_id
      // precedent): the honest provider-unavailable, never a guessed
      // terminal state.
      if (answer.failure.code === 'restricted' && answer.failure.message.includes('HTTP 404')) {
        return failureOf(
          'provider-unavailable',
          `the X API getPublishStatus (tweets/:id) call resolved no such post (HTTP 404 resource-not-found — the provider reports no such post)`,
        );
      }
      return answer;
    }
    const post = dataOf(answer.parsed) as XPostObject | null;
    if (post === null || typeof post.id !== 'string' || post.id === '') {
      return failureOf(
        'provider-unavailable',
        'the X API getPublishStatus (tweets/:id) answer carried no documented Post id',
      );
    }
    return {
      ok: true,
      status: {
        // The live Post's current observable state: the documented
        // synchronous surface keeps the publish 'published' (the poll
        // observes the live post — its engagement facts ride the
        // VERBATIM passthrough).
        publishState: 'published',
        providerPublishId: post.id,
        providerContentId: post.id,
        publishedAt: typeof post.created_at === 'string' && post.created_at !== '' ? post.created_at : null,
        providerFailureReason: null,
        restrictionSignals: [],
        providerData: post as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: answer.rateLimit,
    };
  }

  return {
    descriptor: { ...X_SOCIAL_ADAPTER_DESCRIPTOR },
    capabilities: xSocialAdapterCapabilities(),
    verifyAccountIdentity,
    getAccountProfile,
    discoverPublicContent,
    listOwnContent,
    getContent,
    readAccountAnalytics,
    readContentAnalytics,
    submitPublish,
    getPublishStatus,
    readRestrictionSignals,
  };
}
