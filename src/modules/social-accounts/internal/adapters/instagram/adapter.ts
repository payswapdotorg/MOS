/**
 * MKT-058 — the CONCRETE INSTAGRAM SOCIAL PLATFORM ADAPTER (the second
 * MKT-056 SocialPlatformAdapter implementation, after MKT-057 YouTube):
 * the honest capability matrix + the documented Instagram Graph API
 * surface (for Instagram PROFESSIONAL accounts — Business/Creator —
 * riding on the Facebook Login OAuth surface) mapped onto the frozen
 * normalized capability plane, over the platform HttpCallPort
 * (fetch-based, ZERO provider SDKs — the /integrations INT-001
 * discipline and the arch-check EXTERNAL_PACKAGE_IN_SRC rule).
 *
 * ONE-FILE SUBTREE (the arch-check adapter classification, the MKT-057
 * precedent): every file under an 'adapters' path segment is a CONCRETE
 * ADAPTER — the matrix and the adapter implementation share this single
 * file because a second subtree file would be an adapter importing
 * another adapter (ADAPTER_COUPLING). The frozen contract itself is
 * imported from the module-internal contract
 * ('../../adapter-contract.ts'), NOT through the
 * internal/adapters/adapter-contract.ts re-export shim — the shim is
 * itself under an 'adapters' path segment, so importing it from this
 * subtree would be the same ADAPTER_COUPLING violation; the direct
 * same-module import is the only arch-check-legal form of the
 * sanctioned dependency on the frozen contract.
 *
 * PROVIDER EVIDENCE (the documented surfaces this adapter maps — the
 * full evidence section with URLs lives in docs/runbooks/MKT-058.md):
 *   - Instagram Graph API (the documented platform surface for
 *     Instagram PROFESSIONAL accounts — Business and Creator — reached
 *     through Facebook Login):
 *     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api
 *     and the IG User node reference:
 *     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user
 *   - Facebook Login permissions/scopes (the REAL scope names below):
 *     instagram_basic, instagram_content_publish,
 *     instagram_manage_insights, pages_show_list, pages_read_engagement
 *   - Content Publishing guide (the container-based two-step publish +
 *     the 50-posts-per-24-hours account-level limit +
 *     content_publishing_limit):
 *     https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/guides/content-publishing
 *   - Graph API error reference + rate limiting (the error envelope
 *     with code/type/error_subcode/fbtrace_id; error codes 4/17/32/613
 *     the documented request-limit classes; the X-App-Usage /
 *     X-Business-Use-Case-Usage observable usage headers):
 *     https://developers.facebook.com/docs/graph-api/guides/error-handling
 *     https://developers.facebook.com/docs/graph-api/guides/rate-limiting
 *
 * WHAT THIS ADAPTER HOLDS (the frozen port contract,
 * ../../adapter-contract.ts):
 *   - invocation failures return as DATA (the frozen seven-code
 *     taxonomy), NEVER thrown — only malformed input throws;
 *   - the provider payload rides VERBATIM as passthrough data (the
 *     normalized record shapes record, they never interpret — MKT-062
 *     owns content normalization);
 *   - engagement observations are NULLABLE facts (only what the
 *     documented API exposes: the IG Media node exposes like_count and
 *     comments_count but NO view count (views are Insights metrics) and
 *     NO share count — both report null, never fabricated);
 *   - the rate-limit observation is a RECORD of observable signals per
 *     call: the documented Graph API exposes the X-App-Usage /
 *     X-Business-Use-Case-Usage usage headers on responses (call-count /
 *     CPU / total-time percentages plus, where the provider throttles,
 *     estimated_time_to_regain_call_capacity seconds) — percentages do
 *     not map onto the normalized observation shape's fields, so
 *     successful calls report rateLimit: null (disclosed — fabricating
 *     integers would be dishonest) and the recoverable backoff seconds
 *     ride the rate-limited failure observations where the provider
 *     sends them. Policy enforcement stays in /policies — observations
 *     are never decisions;
 *   - THE ACCOUNT-TYPE LIMITATION (the MKT-058 acceptance criterion):
 *     the documented surface serves Business/Creator (Professional)
 *     accounts ONLY. A personal account surfaces the provider's OWN
 *     documented error semantics — the Graph API error envelope with
 *     code 10, message '(#10) The user is not an Instagram Business'
 *     (type OAuthException; the documented eligibility answer of the
 *     non-Professional account surface) — which this adapter maps onto
 *     the honest 'restricted' data failure (an account-level
 *     eligibility block, exactly the MKT-057 youtubeSignupRequired
 *     precedent). NEVER a fabricated capability, NEVER a fabricated
 *     success;
 *   - the publish lifecycle follows the documented container-based
 *     TWO-STEP publish: submitPublish = POST /{ig-user-id}/media (the
 *     media container creation — the born 'accepted' submission; the
 *     provider publish identity is the CONTAINER id); getPublishStatus =
 *     GET /{container-id}?fields=status_code (the documented container
 *     status semantics: IN_PROGRESS → still accepted; FINISHED → the
 *     SECOND documented step fires here — POST
 *     /{ig-user-id}/media_publish with creation_id — and the answer
 *     reports 'published' with the media id; PUBLISHED → 'published'
 *     (the documented container status surface exposes NO content
 *     identity — providerContentId null, disclosed); ERROR → the honest
 *     'restricted' outcome carrying the container's own processing-
 *     failure status text as the restriction signal; EXPIRED → the
 *     honest 'failed' outcome — the documented 24h container expiry,
 *     the publish never happened);
 *   - the idempotency key is the at-most-once identity TOWARD the
 *     provider (the host fences (socialAccountId, idempotencyKey)
 *     durably — a replay NEVER reaches the adapter). The documented
 *     container creation exposes NO client idempotency token, so the
 *     host fence is the authority (the MKT-057 videos.insert precedent).
 *
 * DOCUMENTED API SEMANTICS IMPLEMENTED (the provider evidence section
 * with URLs lives in docs/runbooks/MKT-058.md):
 *   (IG User node)
 *                  GET  /{ig-user-id}?fields=username[,account_type,
 *                          followers_count,media_count,
 *                          profile_picture_url]
 *                  — the account identity/profile (Business/Creator
 *                    only: a personal account answers the documented
 *                    code-10 eligibility error).
 *   (Media edge)    GET  /{ig-user-id}/media?fields=<fields>
 *                          &limit=<n>&after=<cursor>
 *                  — the own-content listing (the documented
 *                    data[]/paging.cursors.after pagination).
 *   (Media node)    GET  /{media-id}?fields=<fields>
 *                  — the single-content read (like_count,
 *                    comments_count, media_type, timestamp...); an
 *                    unknown id answers the documented code-100 error
 *                    envelope ('Object does not exist') — surfaced as
 *                    the honest restricted data failure (the node-read
 *                    surface has NO empty-list semantics).
 *   (Hashtag)       GET  /ig_hashtag_search?user_id=<ig-user-id>&q=<q>
 *                  GET  /{hashtag-id}/top_media?user_id=<ig-user-id>
 *                          &fields=<fields>&limit=<n>&after=<cursor>
 *                  — the documented hashtag-scoped public discovery
 *                    surface (the only public-content discovery the
 *                    documented API permits; 30 unique hashtags per
 *                    rolling 7-day window per account — the documented
 *                    hashtag rate surface).
 *   (Insights)      GET  /{ig-user-id}/insights?metric=<m,...>
 *                          &period=day[&since=<s>&until=<s>]
 *                  GET  /{media-id}/insights?metric=<m,...>
 *                  — the observed metric points (data[].name VERBATIM +
 *                    data[].values[]; the account metrics are day-period
 *                    slices carrying end_time; the media metrics are
 *                    lifetime aggregates with no window; the per-type
 *                    documented metric vocabulary is requested by media
 *                    type — the type resolved by ONE documented
 *                    media-node read).
 *   (Containers)    POST /{ig-user-id}/media            (container
 *                      creation — {id: container-id})
 *                  POST /{ig-user-id}/media_publish      (creation_id
 *                      → {id: media-id} — the documented second step)
 *                  GET  /{container-id}?fields=status_code
 *                      — IN_PROGRESS | FINISHED | PUBLISHED | EXPIRED |
 *                        ERROR (the documented container status codes).
 *
 * DOCUMENTED ERROR ENVELOPE (the Graph API standard error body):
 *   { "error": { "message": "(#100) ...", "type":
 *                "GraphMethodException" | "OAuthException",
 *                "code": <int>, "error_subcode": <int?>,
 *                "error_user_msg": "<text>?", "fbtrace_id": "<id>" } }
 * mapped onto the frozen taxonomy (envelope-CODE-driven — the Graph API
 * serves most errors, including token errors, over HTTP 400):
 *   transport refused/timeout/5xx/oversized   → provider-unavailable (retryable)
 *   code 190 / 102 (token/session invalid)    → auth-expired (reauthorization)
 *   code 4 / 17 / 32 / 613 (the documented
 *       request-limit classes)                 → rate-limited (+ observation
 *                                                from the documented
 *                                                X-Business-Use-Case-Usage
 *                                                regain-capacity seconds
 *                                                where present)
 *   code 10 (permission/eligibility — including
 *       '(#10) The user is not an Instagram Business') → restricted
 *   other 4xx                                  → restricted (disclosed
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
 * header.
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
  SocialRestrictionSignal,
} from '../../adapter-contract.ts';
import type { HttpCallPort, HttpCallRequest, HttpCallResponse } from '../../../../../platform/http/outbound.ts';

// ---------------------------------------------------------------------------
// The honest capability matrix (the REAL Facebook Login scope names)
// ---------------------------------------------------------------------------

/** The platform identity: the SAME key the /integrations adapter registry uses (lock rule 18). */
export const INSTAGRAM_SOCIAL_ADAPTER_KEY = 'instagram';

/**
 * The REAL Facebook Login permission names the Instagram Graph API rides
 * on (the documented scope surface — least privilege per family).
 */
export const INSTAGRAM_SCOPES = {
  /** Read account info and media (the documented base permission). */
  basic: 'instagram_basic',
  /** Create/publish organic content (the documented publishing permission). */
  contentPublish: 'instagram_content_publish',
  /** Read insights (the documented analytics permission). */
  manageInsights: 'instagram_manage_insights',
  /** Access the Page list the IG Professional account is linked through (the documented account-resolution surface). */
  pagesShowList: 'pages_show_list',
  /** Read page engagement metadata (required for other accounts' media engagement in hashtag discovery). */
  pagesReadEngagement: 'pages_read_engagement',
} as const;

/** The adapter descriptor (the registry data view). */
export const INSTAGRAM_SOCIAL_ADAPTER_DESCRIPTOR = {
  adapterKey: INSTAGRAM_SOCIAL_ADAPTER_KEY,
  providerLabel: 'Instagram (Instagram Graph API, Professional accounts)',
  description:
    'The second concrete MKT-056 social platform adapter: the documented Instagram Graph API surface for Instagram PROFESSIONAL accounts (Business/Creator, via Facebook Login) mapped onto the normalized capability plane over the platform HttpCallPort (fetch-based, zero provider SDKs). Failures return as the frozen seven-code taxonomy data; provider payloads ride VERBATIM as passthrough; the wiring is inert without an authorized Instagram integration connection + OAuth grant (the fail-closed chain precedes every provider call). The documented surface serves Professional accounts ONLY — a personal account surfaces the documented error semantics as honest data, never a fabricated capability. Limitations are disclosed per capability (lock rule 37) — see docs/runbooks/MKT-058.md.',
} as const;

/**
 * The declared capability matrix — the honest SUBSET: FOUR of the five
 * frozen families. The documented Instagram Graph API honestly supports
 * account / content-read / analytics-read / publish; the
 * restriction-signals family is deliberately UNDECLARED because the
 * documented surface exposes NO account-level restriction/eligibility
 * endpoint and NO media-level restriction field — account-level
 * limitations surface as invocation failures (the documented code-10
 * eligibility error, permission errors, the documented rate-limit
 * classes) which the frozen taxonomy carries as DATA, and hidden
 * moderation state is never invented (architecture-v1.6 §11). The
 * undeclared family fails closed (unsupported-capability, zero provider
 * traffic) — the strongest capability-subset demonstration in the MVP
 * adapter set (the UI and planner cannot assume parity, lock rule 19).
 */
export function instagramSocialAdapterCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [INSTAGRAM_SCOPES.basic, INSTAGRAM_SCOPES.pagesShowList],
      description:
        "Instagram Professional account identity binding + profile reads over the documented IG User node (GET /{ig-user-id}?fields=username,account_type,followers_count,media_count — the account_type passthrough is the provider's own BUSINESS/CREATOR label). Limitations: the documented surface serves Business/Creator accounts ONLY — a personal account surfaces the documented code-10 error '(#10) The user is not an Instagram Business' as the honest restricted data failure (never a fabricated capability); the node exposes no identity-verification timestamp (verifiedAt reports null); account-level restrictions surface only as invocation failures, never as invented state.",
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [INSTAGRAM_SCOPES.basic, INSTAGRAM_SCOPES.pagesReadEngagement],
      description:
        'Public discovery over the documented hashtag-scoped surface (GET /ig_hashtag_search + GET /{hashtag-id}/top_media — the only public-content discovery the documented API permits; 30 unique hashtags per rolling 7-day window per account), own-content listing over the documented Media edge (GET /{ig-user-id}/media — the data[]/paging.cursors.after pagination) and single reads over the documented Media node (GET /{media-id}). Limitations: hashtag discovery is hashtag-scoped only (no general keyword search exists in the documented API); the media node exposes like_count and comments_count but NO view count (views are Insights metrics) and NO share count (both null — never fabricated); an unknown content id answers the documented code-100 error envelope as the honest restricted data failure (the node-read surface has no empty-list semantics); hashtag media carry no author identity (authorExternalAccountId null — the documented hashtag media fields expose none).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [INSTAGRAM_SCOPES.basic, INSTAGRAM_SCOPES.manageInsights],
      description:
        "Observed metric points over the documented Insights edges: account metrics as day-period slices (GET /{ig-user-id}/insights?metric=follower_count,impressions,profile_views,reach&period=day — provider labels and per-slice end_time stamps verbatim) and per-media lifetime aggregates (GET /{media-id}/insights — the documented per-type metric vocabulary: IMAGE engagement/impressions/reach/saved, VIDEO +video_views, CAROUSEL_ALBUM carousel_album_*, REELS impressions/plays/reach/saved/shares; the media type resolves by ONE documented media-node read). Limitations: the media insights edge carries NO window parameters (lifetime aggregates — null windows, the caller window honestly unused); the account window maps onto the documented since/until only when passed; per-slice observations report only the provider's end_time (windowStart null); comments/likes INSIGHTS metrics are deprecated on the documented surface (they ride as media-node fields); an empty report yields NO observations.",
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [
        INSTAGRAM_SCOPES.basic,
        INSTAGRAM_SCOPES.contentPublish,
        INSTAGRAM_SCOPES.pagesShowList,
        INSTAGRAM_SCOPES.pagesReadEngagement,
      ],
      description:
        "The documented container-based two-step publish: submitPublish = POST /{ig-user-id}/media (the container creation — the born accepted submission, the CONTAINER id as the provider publish identity, no content id yet); getPublishStatus = the documented container status poll: IN_PROGRESS → still accepted; FINISHED → the second documented step fires (media_publish with creation_id) and reports published with the media id; PUBLISHED → published with no content id (the status surface exposes none); ERROR → the honest restricted outcome with the container failure status as the signal; EXPIRED → the honest failed outcome (the documented 24-hour expiry). Limitations: the documented publish rate surface is the account-level 50-posts/24h window; container creation maps caption/image_url/video_url/media_type/share_to_feed + media-asset URL descriptors (carousel/user-tags flows await the content-asset wiring); no idempotency token on creation — the host fence is the at-most-once identity.",
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

/** The documented default page size when the caller passes no limit (the Media edge / hashtag top_media limit parameter). */
const DEFAULT_MEDIA_LIMIT = 25;
/** The documented bounded page-size ceiling (the hashtag top_media limit maximum; the Media edge accepts up to 100 — the honest bounded request uses the documented hashtag maximum for both). */
const MAX_MEDIA_LIMIT = 50;

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
/** The documented request-limit error codes (the rate-limited class). */
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613]);

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
  const label = `the Instagram Graph API ${operation} call failed (HTTP ${response.status}${envelope.code !== null ? `, code ${envelope.code}${envelope.subcode !== null ? ` (subcode ${envelope.subcode})` : ''}, ${detail}` : `: ${detail}`})`;

  // Transport-class failures: the request was not satisfiably processed.
  if (response.status === 0) {
    if (response.timedOut) {
      return failureOf('provider-unavailable', `the Instagram Graph API ${operation} call timed out`);
    }
    if (response.transportRefused) {
      return failureOf(
        'provider-unavailable',
        `the Instagram Graph API ${operation} call was not processed (transport refused/unreachable)`,
      );
    }
    return failureOf(
      'provider-unavailable',
      `the Instagram Graph API ${operation} answer exceeded the bounded response envelope`,
    );
  }
  if (response.status >= 500) {
    return failureOf('provider-unavailable', `${label} — the provider reported a server error (retryable)`);
  }
  if (envelope.code !== null && AUTH_ERROR_CODES.has(envelope.code)) {
    return failureOf(
      'auth-expired',
      `the Instagram Graph API ${operation} call was refused as unauthorized (code ${envelope.code}${detail !== '' ? `: ${detail}` : ''}) — reauthorization required`,
    );
  }
  if (envelope.code !== null && RATE_LIMIT_ERROR_CODES.has(envelope.code)) {
    // The documented request-limit classes (app-level 4 / user-level 17 /
    // page-level 32 / 613): the observable backoff signals ride the
    // observation (the documented usage headers' regain-capacity seconds
    // where the provider sends them).
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
  if (envelope.code !== null && envelope.code === 10) {
    return failureOf(
      'restricted',
      `the Instagram Graph API ${operation} call was refused (code 10, ${detail}) — the provider signalled a permission/account-type eligibility block`,
    );
  }
  // The disclosed judgment call (the file header): every other 4xx —
  // including the documented code-100 family (invalid parameters,
  // non-existing objects) — is a non-retryable provider-side refusal
  // surfaced as 'restricted' with the verbatim envelope excerpt.
  return failureOf('restricted', `${label} — the provider refused the request`);
}

// ---------------------------------------------------------------------------
// The documented response shapes (the parsed subset the mappings read)
// ---------------------------------------------------------------------------

/** The documented IG User node subset (Business/Creator accounts). */
interface IgUserNode {
  readonly id?: string;
  readonly username?: string;
  readonly account_type?: string;
  readonly followers_count?: number;
  readonly media_count?: number;
  readonly profile_picture_url?: string;
}

/** The documented IG Media node subset. */
interface IgMediaNode {
  readonly id?: string;
  readonly caption?: string;
  readonly media_type?: string;
  readonly media_product_type?: string;
  readonly media_url?: string;
  readonly permalink?: string;
  readonly thumbnail_url?: string;
  readonly timestamp?: string;
  readonly username?: string;
  readonly like_count?: number;
  readonly comments_count?: number;
}

/** The documented paged edge answer (data[] + paging.cursors.after). */
interface IgPagedEdge {
  readonly data?: unknown;
  readonly paging?: { readonly cursors?: { readonly after?: unknown }; readonly next?: unknown };
}

/** The documented container creation answer ({ id }). */
interface IgContainerCreation {
  readonly id?: unknown;
}

/** The documented container status answer ({ id, status_code[, status] }). */
interface IgContainerStatus {
  readonly id?: unknown;
  readonly status_code?: unknown;
  readonly status?: unknown;
}

/** The documented media_publish answer ({ id }). */
interface IgMediaPublishAnswer {
  readonly id?: unknown;
}

/** The documented insights edge answer (data[]: name/period/values[]). */
interface IgInsightsEdge {
  readonly data?: readonly {
    readonly name?: unknown;
    readonly period?: unknown;
    readonly values?: readonly { readonly value?: unknown; readonly end_time?: unknown }[];
    readonly title?: unknown;
    readonly description?: unknown;
  }[];
}

/** The documented hashtag search answer (data[]: id). */
interface IgHashtagSearch {
  readonly data?: readonly { readonly id?: unknown }[];
}

/**
 * The documented per-type media-insights metric vocabulary (the
 * "Instagram Media Insights" availability table — the adapter requests
 * the documented set of the media's type; comments/likes as INSIGHTS
 * metrics are deprecated on the documented surface, they ride as
 * media-node fields).
 */
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
  REELS: ['impressions', 'plays', 'reach', 'saved', 'shares'],
};

/** The documented metric set of an unlisted/unknown media type (the honest bounded fallback). */
const FALLBACK_MEDIA_INSIGHT_METRICS: readonly string[] = ['impressions', 'reach'];

function mediaInsightMetricsOf(mediaType: string | null): readonly string[] {
  if (mediaType === null) return FALLBACK_MEDIA_INSIGHT_METRICS;
  return MEDIA_INSIGHT_METRICS[mediaType] ?? FALLBACK_MEDIA_INSIGHT_METRICS;
}

/** The documented account-insights day-period metric set. */
const ACCOUNT_INSIGHT_METRICS: readonly string[] = [
  'follower_count',
  'impressions',
  'profile_views',
  'reach',
];

/** Parses a documented count number — never fabricated. */
function countOf(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface InstagramSocialAdapterOptions {
  /** The platform outbound HTTP port (fetch-based in production; the documented https-or-loopback envelope). */
  readonly http: HttpCallPort;
}

/**
 * Constructs the Instagram social platform adapter (a pure object — NO
 * provider traffic at construction; the wiring is inert until the
 * fail-closed host chain hands it an authorized call context).
 */
export function createInstagramSocialAdapter(options: InstagramSocialAdapterOptions): SocialPlatformAdapter {
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
        `the Instagram Graph API ${operation} call could not be issued: ${error instanceof Error ? error.message : String(error)}`,
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
        `the Instagram Graph API ${operation} answer was not the documented JSON body`,
      );
    }
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

  /** The documented GET query form (null/undefined parameters are omitted). */
  function buildQuery(params: Readonly<Record<string, string | number | null>>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) search.set(key, String(value));
    }
    return search.toString();
  }

  // -------------------------------------------------------------------------
  // The account family (the documented IG User node)
  // -------------------------------------------------------------------------

  async function readIgUser(
    context: SocialAdapterCallContext,
    operation: string,
    fields: string,
  ): Promise<{ ok: true; user: IgUserNode } | { ok: false; failure: SocialOperationFailure }> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    const answer = await callProviderJson(operation, {
      url: `${base}/${encodeURIComponent(context.externalAccountId)}?${buildQuery({ fields })}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const node = answer.parsed as IgUserNode;
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') {
      return failureOf(
        'provider-unavailable',
        `the Instagram Graph API ${operation} answer was not the documented IG User node body`,
      );
    }
    return { ok: true, user: node };
  }

  async function verifyAccountIdentity(context: SocialAdapterCallContext): Promise<SocialAccountIdentityResult> {
    const outcome = await readIgUser(context, 'verifyAccountIdentity (IG User node)', 'username,account_type');
    if (!outcome.ok) return outcome;
    const user = outcome.user;
    // The documented node exposes no identity-verification timestamp —
    // null (disclosed). A personal account never reaches this line: it
    // answers the documented code-10 eligibility error, classified as
    // the honest 'restricted' data failure by the taxonomy above.
    return {
      ok: true,
      identity: {
        externalAccountId: user.id as string,
        displayIdentity:
          typeof user.username === 'string' && user.username !== '' ? user.username : (user.id as string),
        verifiedAt: null,
      },
      // The documented Graph API usage headers (X-App-Usage /
      // X-Business-Use-Case-Usage) expose call-count/CPU/time
      // percentages, not the normalized shape's fields — null (disclosed).
      rateLimit: null,
    };
  }

  async function getAccountProfile(context: SocialAdapterCallContext): Promise<SocialAccountProfileResult> {
    const outcome = await readIgUser(
      context,
      'getAccountProfile (IG User node)',
      'username,account_type,followers_count,media_count,profile_picture_url',
    );
    if (!outcome.ok) return outcome;
    const user = outcome.user;
    return {
      ok: true,
      profile: {
        externalAccountId: user.id as string,
        displayIdentity:
          typeof user.username === 'string' && user.username !== '' ? user.username : (user.id as string),
        // The documented node exposes no identity-verification timestamp.
        verifiedAt: null,
        // The provider's own account-type label rides verbatim
        // (BUSINESS/CREATOR — the Professional-account surface).
        accountKind: typeof user.account_type === 'string' ? user.account_type : null,
        followerCount: countOf(user.followers_count),
        data: user as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: null,
    };
  }

  // -------------------------------------------------------------------------
  // The content-read family (hashtag discovery + Media edge/node)
  // -------------------------------------------------------------------------

  /** The documented media-node field set the reads request (bounded, the documented node fields). */
  const MEDIA_FIELDS =
    'id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,username,like_count,comments_count';

  function mediaRecordOf(media: IgMediaNode): {
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
    if (media === null || typeof media !== 'object' || typeof media.id !== 'string' || media.id === '') return null;
    return {
      providerContentId: media.id,
      // The documented hashtag media fields expose NO author identity —
      // the username field rides the payload where present, and the
      // author id is the honest null (never fabricated).
      authorExternalAccountId: null,
      contentFormat: typeof media.media_type === 'string' ? media.media_type : 'IMAGE',
      publishedAt: typeof media.timestamp === 'string' ? media.timestamp : null,
      sourceTimestamp: typeof media.timestamp === 'string' ? media.timestamp : null,
      engagement: {
        // The documented IG Media node exposes like_count and
        // comments_count but NO view count (views are Insights metrics)
        // and NO share count — null, never fabricated.
        viewCount: null,
        likeCount: countOf(media.like_count),
        commentCount: countOf(media.comments_count),
        shareCount: null,
      },
      data: media as unknown as Readonly<Record<string, unknown>>,
      etag: null,
      sourceVersion: null,
    };
  }

  /** Reads one paged edge (the documented data[]/paging.cursors.after protocol). */
  async function readPagedEdge(
    context: SocialAdapterCallContext,
    operation: string,
    url: string,
  ): Promise<{ ok: true; records: unknown[]; nextCursor: string | null } | { ok: false; failure: SocialOperationFailure }> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const answer = await callProviderJson(operation, {
      url,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const edge = answer.parsed as IgPagedEdge;
    const data = Array.isArray(edge?.data) ? (edge.data as unknown[]) : [];
    const after = edge?.paging?.cursors?.after;
    // The documented pagination: the paging.next URL's presence marks a
    // next page; the after cursor is the opaque next-page token.
    const hasNext = typeof edge?.paging?.next === 'string' && edge.paging.next !== '';
    const nextCursor = hasNext && typeof after === 'string' && after !== '' ? after : null;
    return { ok: true, records: data, nextCursor };
  }

  async function discoverPublicContent(
    context: SocialAdapterCallContext,
    input: SocialContentDiscoveryQuery,
  ): Promise<SocialContentPageResult> {
    const operation = 'discoverPublicContent (ig_hashtag_search + top_media)';
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    // Step 1: the documented hashtag search (user_id + q → the hashtag
    // id). The rate surface is the documented 30-unique-hashtags rolling
    // 7-day window — a limit-exceeded search answers the documented
    // request-limit error class (rate-limited data).
    const search = await callProviderJson('discoverPublicContent (ig_hashtag_search)', {
      url: `${base}/ig_hashtag_search?${buildQuery({ user_id: context.externalAccountId, q: input.query })}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!search.ok) return search;
    const hashtagSearch = search.parsed as IgHashtagSearch;
    const hashtagId =
      Array.isArray(hashtagSearch?.data) && hashtagSearch.data.length > 0
        ? typeof hashtagSearch.data[0]?.id === 'string'
          ? hashtagSearch.data[0].id
          : null
        : null;
    // An empty hashtag search data set: no hashtag exists for the query
    // — the honest EMPTY page (never a fabricated failure).
    if (hashtagId === null) {
      return { ok: true, page: { records: [], pageCursor: null }, rateLimit: null };
    }
    // Step 2: the documented top_media edge of the hashtag.
    const limit = input.limit !== null ? Math.min(Math.max(input.limit, 1), MAX_MEDIA_LIMIT) : DEFAULT_MEDIA_LIMIT;
    const topMedia = await readPagedEdge(
      context,
      operation,
      `${base}/${encodeURIComponent(hashtagId)}/top_media?${buildQuery({
        user_id: context.externalAccountId,
        fields: 'id,caption,like_count,comments_count,media_type,media_url,permalink,thumbnail_url,timestamp',
        limit,
        after: input.pageCursor,
      })}`,
    );
    if (!topMedia.ok) return topMedia;
    const records = topMedia.records
      .map((media) => (media !== null && typeof media === 'object' ? mediaRecordOf(media as IgMediaNode) : null))
      .filter((record): record is NonNullable<typeof record> => record !== null);
    return { ok: true, page: { records, pageCursor: topMedia.nextCursor }, rateLimit: null };
  }

  async function listOwnContent(
    context: SocialAdapterCallContext,
    input: SocialContentListQuery,
  ): Promise<SocialContentPageResult> {
    const operation = 'listOwnContent (Media edge)';
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    const limit = input.limit !== null ? Math.min(Math.max(input.limit, 1), MAX_MEDIA_LIMIT) : DEFAULT_MEDIA_LIMIT;
    const outcome = await readPagedEdge(
      context,
      operation,
      `${base}/${encodeURIComponent(context.externalAccountId)}/media?${buildQuery({
        fields: MEDIA_FIELDS,
        limit,
        after: input.pageCursor,
      })}`,
    );
    if (!outcome.ok) return outcome;
    const records = outcome.records
      .map((media) => (media !== null && typeof media === 'object' ? mediaRecordOf(media as IgMediaNode) : null))
      .filter((record): record is NonNullable<typeof record> => record !== null);
    return { ok: true, page: { records, pageCursor: outcome.nextCursor }, rateLimit: null };
  }

  async function getContent(
    context: SocialAdapterCallContext,
    input: SocialContentReadInput,
  ): Promise<SocialContentResult> {
    const operation = 'getContent (Media node)';
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    const answer = await callProviderJson(operation, {
      url: `${base}/${encodeURIComponent(input.providerContentId)}?${buildQuery({ fields: MEDIA_FIELDS })}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const node = answer.parsed as IgMediaNode;
    // The documented node-read answer for an unknown id is the code-100
    // error envelope (classified as data above — the node surface has
    // NO empty-list semantics); a 2xx answer without a node id is the
    // honest provider-unavailable.
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') {
      return failureOf(
        'provider-unavailable',
        `the Instagram Graph API ${operation} answer was not the documented IG Media node body`,
      );
    }
    return { ok: true, record: mediaRecordOf(node), rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The analytics-read family (the documented Insights edges)
  // -------------------------------------------------------------------------

  /** Maps one documented insight data entry onto normalized observations (labels VERBATIM). */
  function observationsOfInsight(
    entry: NonNullable<IgInsightsEdge['data']>[number],
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
      // The day-period account slices carry the provider's own end_time
      // stamp; the lifetime media aggregates carry no window at all.
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
    const operation = 'readAccountAnalytics (Insights edge, period=day)';
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    const since =
      input.windowStart !== null && !Number.isNaN(Date.parse(input.windowStart))
        ? Math.floor(Date.parse(input.windowStart) / 1000)
        : null;
    const until =
      input.windowEnd !== null && !Number.isNaN(Date.parse(input.windowEnd))
        ? Math.floor(Date.parse(input.windowEnd) / 1000)
        : null;
    // The documented day-period account report (follower_count,
    // impressions, profile_views, reach). A null caller window omits
    // since/until — the provider's own documented default window
    // answers, and the observations carry the provider's per-slice
    // end_time stamps verbatim.
    const answer = await callProviderJson(operation, {
      url: `${base}/${encodeURIComponent(context.externalAccountId)}/insights?${buildQuery({
        metric: ACCOUNT_INSIGHT_METRICS.join(','),
        period: 'day',
        since,
        until,
      })}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const edge = answer.parsed as IgInsightsEdge;
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
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('readContentAnalytics (media type + Insights edges)');
    const base = resolveBase(context.providerConfig);
    const observations: SocialAnalyticsObservation[] = [];
    for (const mediaId of input.providerContentIds) {
      // Step 1: ONE documented media-node read — the media type selects
      // the documented metric vocabulary (the Insights edge rejects
      // metrics the media type does not support).
      const typeRead = await callProviderJson('readContentAnalytics (Media node)', {
        url: `${base}/${encodeURIComponent(mediaId)}?${buildQuery({ fields: 'media_type' })}`,
        method: 'GET',
        headers: authHeaders(bearer),
        body: null,
      });
      if (!typeRead.ok) return typeRead;
      const node = typeRead.parsed as IgMediaNode;
      const mediaType = typeof node?.media_type === 'string' ? node.media_type : null;
      // Step 2: the documented media Insights edge (lifetime aggregates
      // — the edge carries NO window parameters; the caller window is
      // honestly unused on this surface, disclosed).
      const answer = await callProviderJson('readContentAnalytics (Insights edge)', {
        url: `${base}/${encodeURIComponent(mediaId)}/insights?${buildQuery({
          metric: mediaInsightMetricsOf(mediaType).join(','),
        })}`,
        method: 'GET',
        headers: authHeaders(bearer),
        body: null,
      });
      if (!answer.ok) return answer;
      const edge = answer.parsed as IgInsightsEdge;
      const data = Array.isArray(edge?.data) ? edge.data : [];
      for (const entry of data) {
        observations.push(...observationsOfInsight(entry, { providerContentId: mediaId, mediaType }));
      }
    }
    return { ok: true, observations, rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The publish family (the documented container-based two-step publish)
  // -------------------------------------------------------------------------

  /**
   * Maps the normalized publish request onto the documented media
   * container creation parameters (form-encoded POST params). The
   * provider owns parameter validation — a documented error surfaces as
   * the honest taxonomy data failure with the verbatim envelope.
   */
  function containerParamsOf(input: SocialPublishSubmitInput): Record<string, string> {
    const payload = input.request.payload as Readonly<Record<string, unknown>>;
    const params: Record<string, string> = {};
    // The documented single-container creation parameters the
    // normalized request can carry VERBATIM (the provider-shaped
    // passthrough names).
    for (const key of [
      'caption',
      'image_url',
      'video_url',
      'media_type',
      'share_to_feed',
      'location_id',
      'cover_url',
      'accessibility_caption',
    ]) {
      const value = payload[key];
      if (typeof value === 'string' && value !== '') params[key] = value;
    }
    // The media-asset URL descriptors fill image_url/video_url when the
    // payload carries none (the content-asset resolution seam — the
    // asset reference rides the descriptor's url hint).
    if (params['image_url'] === undefined) {
      const asset = input.request.mediaAssets.find((candidate) => candidate.mediaKind === 'image');
      const url = asset?.descriptor['url'] ?? asset?.descriptor['mediaUrl'];
      if (typeof url === 'string' && url !== '') params['image_url'] = url;
    }
    if (params['video_url'] === undefined) {
      const asset = input.request.mediaAssets.find(
        (candidate) => candidate.mediaKind === 'video' || candidate.mediaKind === 'reel',
      );
      const url = asset?.descriptor['url'] ?? asset?.descriptor['mediaUrl'];
      if (typeof url === 'string' && url !== '') params['video_url'] = url;
    }
    return params;
  }

  async function submitPublish(
    context: SocialAdapterCallContext,
    input: SocialPublishSubmitInput,
  ): Promise<SocialPublishSubmitResult> {
    const operation = 'submitPublish (media container creation)';
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    const params = containerParamsOf(input);
    // The documented FIRST step: POST /{ig-user-id}/media — the media
    // container creation. The answer is { id: <container-id> }. The
    // publish step (media_publish) fires on the documented container
    // status semantics: FINISHED (below, in getPublishStatus) — the
    // documented flow requires waiting for the container to finish
    // processing before publishing, so the born submission is the
    // honest 'accepted' (the provider accepted the publish job, the
    // container id is the provider publish identity, NO content id
    // exists yet).
    const creation = await callProviderJson(operation, {
      url: `${base}/${encodeURIComponent(context.externalAccountId)}/media`,
      method: 'POST',
      headers: { ...authHeaders(bearer), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (!creation.ok) return creation;
    const answer = creation.parsed as IgContainerCreation;
    const containerId = typeof answer?.id === 'string' && answer.id !== '' ? answer.id : null;
    if (containerId === null) {
      return failureOf(
        'provider-unavailable',
        'the Instagram media container creation answered without the documented container id ({ id })',
      );
    }
    return {
      ok: true,
      submission: {
        // The born container: the media is NOT yet processed — the
        // honest 'accepted' (async) state with the container as the
        // provider publish identity and NO content id yet.
        publishState: 'accepted',
        providerPublishId: containerId,
        providerContentId: null,
        publishedAt: null,
        providerFailureReason: null,
        restrictionSignals: [],
        providerData: null,
      },
      rateLimit: null,
    };
  }

  async function getPublishStatus(
    context: SocialAdapterCallContext,
    input: SocialPublishStatusInput,
  ): Promise<SocialPublishStatusResult> {
    const operation = 'getPublishStatus (container status)';
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    // The documented container status poll:
    // GET /{container-id}?fields=status_code →
    //   IN_PROGRESS — media is still processing;
    //   FINISHED   — ready to publish;
    //   PUBLISHED  — the container has been published;
    //   EXPIRED    — the container was not published within 24 hours;
    //   ERROR      — the container failed to complete.
    const poll = await callProviderJson(operation, {
      url: `${base}/${encodeURIComponent(input.providerPublishId)}?${buildQuery({ fields: 'status_code' })}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!poll.ok) return poll;
    const statusAnswer = poll.parsed as IgContainerStatus;
    const statusCode = typeof statusAnswer?.status_code === 'string' ? statusAnswer.status_code : null;
    const statusText = typeof statusAnswer?.status === 'string' ? statusAnswer.status : null;
    const containerId =
      typeof statusAnswer?.id === 'string' && statusAnswer.id !== '' ? statusAnswer.id : input.providerPublishId;

    if (statusCode === 'IN_PROGRESS') {
      // Still processing — the honest still-accepted answer.
      return {
        ok: true,
        status: {
          publishState: 'accepted',
          providerPublishId: containerId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: statusAnswer as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }

    if (statusCode === 'FINISHED') {
      // The documented SECOND step fires here: the container is ready,
      // the publish is POST /{ig-user-id}/media_publish with
      // creation_id = the container id. The answer { id } is the
      // published media id — the content is live when the call returns.
      const publish = await callProviderJson('getPublishStatus (media_publish)', {
        url: `${base}/${encodeURIComponent(context.externalAccountId)}/media_publish`,
        method: 'POST',
        headers: { ...authHeaders(bearer), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ creation_id: input.providerPublishId }).toString(),
      });
      if (!publish.ok) return publish;
      const published = publish.parsed as IgMediaPublishAnswer;
      const mediaId = typeof published?.id === 'string' && published.id !== '' ? published.id : null;
      if (mediaId === null) {
        return failureOf(
          'provider-unavailable',
          'the Instagram media_publish answer carried no published media id ({ id })',
        );
      }
      return {
        ok: true,
        status: {
          publishState: 'published',
          providerPublishId: containerId,
          providerContentId: mediaId,
          publishedAt: new Date().toISOString(),
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: published as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }

    if (statusCode === 'PUBLISHED') {
      // The container has been published — the honest published answer.
      // DISCLOSED: the documented container status surface exposes NO
      // content identity ({ id, status_code } only) — providerContentId
      // is null here; the publish-time answer (the FINISHED branch
      // above) carried the media id and the host ledger records it.
      return {
        ok: true,
        status: {
          publishState: 'published',
          providerPublishId: containerId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: statusAnswer as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }

    if (statusCode === 'ERROR') {
      // The container failed to complete — the provider's OWN
      // processing-failure signal. The honest 'restricted' outcome with
      // the documented container status text as the restriction signal
      // (the disclosed mapping — a provider-side content refusal; the
      // taxonomy carries the outcome, the signal carries the
      // provider's own status text verbatim).
      const signal: SocialRestrictionSignal = {
        signalKind: 'ig-container.status_code.ERROR',
        observedAt: null,
        description:
          statusText !== null
            ? `media container ${containerId} carries status_code=ERROR (${statusText})`
            : `media container ${containerId} carries status_code=ERROR`,
        data: {
          containerId,
          statusCode: 'ERROR',
          status: statusText,
        },
      };
      return {
        ok: true,
        status: {
          publishState: 'restricted',
          providerPublishId: containerId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [signal],
          providerData: statusAnswer as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }

    if (statusCode === 'EXPIRED') {
      // The documented 24-hour container expiry — the publish never
      // happened. The honest 'failed' outcome with the provider's own
      // expiry semantics as the failure reason (retrying media_publish
      // on an expired container is documented as futile — a fresh
      // container, i.e. a NEW idempotency key, is the recovery).
      return {
        ok: true,
        status: {
          publishState: 'failed',
          providerPublishId: containerId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason:
            statusText !== null
              ? `status_code=EXPIRED (${statusText}) — the documented 24-hour container expiry: the publish never happened; a fresh container (a new idempotency key) is the recovery`
              : 'status_code=EXPIRED — the documented 24-hour container expiry: the publish never happened; a fresh container (a new idempotency key) is the recovery',
          restrictionSignals: [],
          providerData: statusAnswer as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }

    // An unknown/absent status_code: the honest provider-unavailable
    // (the documented status vocabulary is closed; anything else is an
    // unparseable provider answer).
    return failureOf(
      'provider-unavailable',
      `the Instagram container status answer carried no documented status_code ('${String(statusCode)}')`,
    );
  }

  // NOTE (the frozen port contract): the restriction-signals family is
  // deliberately NOT implemented — the capability matrix above honestly
  // declares no restriction-signals capability, and the registration
  // guards refuse a declared operation without its implementing method
  // (an undeclared readRestrictionSignals call never reaches this
  // adapter: the host answers 'unsupported-capability' fail-closed with
  // ZERO provider traffic — proven end-to-end by the conformance suite's
  // capability-subset scenario).

  return {
    descriptor: { ...INSTAGRAM_SOCIAL_ADAPTER_DESCRIPTOR },
    capabilities: instagramSocialAdapterCapabilities(),
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
