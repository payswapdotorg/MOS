/**
 * MKT-060 — the CONCRETE TIKTOK SOCIAL PLATFORM ADAPTER (the fourth
 * MKT-056 SocialPlatformAdapter implementation): the honest capability
 * matrix + the documented TikTok for Developers surface (Login Kit
 * scopes + the Display API user/video reads + the Content Posting API
 * direct-post lifecycle + the Query Creator Info eligibility surface)
 * mapped onto the frozen normalized capability plane, over the platform
 * HttpCallPort (fetch-based, ZERO provider SDKs — the /integrations
 * INT-001 discipline and the arch-check EXTERNAL_PACKAGE_IN_SRC rule).
 *
 * ONE-FILE SUBTREE (the arch-check adapter classification, the
 * MKT-057/058/059 discipline): every file under an 'adapters' path
 * segment is a CONCRETE ADAPTER — the matrix and the adapter
 * implementation share this single file because a second subtree file
 * would be an adapter importing another adapter (ADAPTER_COUPLING). The
 * frozen contract itself is imported from the module-internal contract
 * ('../../adapter-contract.ts'), NOT through the
 * internal/adapters/adapter-contract.ts re-export shim — the shim is
 * itself under an 'adapters' path segment, so importing it from this
 * subtree would be the same ADAPTER_COUPLING violation; the direct
 * same-module import is the only arch-check-legal form of the sanctioned
 * dependency on the frozen contract.
 *
 * PROVIDER EVIDENCE (the documented surfaces this adapter maps — the
 * full evidence section with URLs lives in docs/runbooks/MKT-060.md;
 * every fact below was verified against the LIVE developers.tiktok.com
 * documentation at delivery time):
 *   - TikTok API scopes reference (the REAL Login Kit scope names):
 *     https://developers.tiktok.com/docs/en/tiktok-api-scopes
 *   - Get User Info (GET /v2/user/info/?fields=...):
 *     https://developers.tiktok.com/docs/en/tiktok-api-v2-get-user-info
 *   - List Videos (POST /v2/video/list/?fields=...):
 *     https://developers.tiktok.com/docs/en/tiktok-api-v2-video-list
 *   - Query Videos (POST /v2/video/query/?fields=...):
 *     https://developers.tiktok.com/docs/en/tiktok-api-v2-video-query
 *   - Video Object (the field vocabulary incl. the engagement counts):
 *     https://developers.tiktok.com/docs/en/tiktok-api-v2-video-object
 *   - Direct Post (POST /v2/post/publish/video/init/):
 *     https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
 *   - Get Post Status (POST /v2/post/publish/status/fetch/):
 *     https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status
 *   - Query Creator Info (POST /v2/post/publish/creator_info/query/):
 *     https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info
 *   - Rate Limits (the per-endpoint one-minute sliding windows):
 *     https://developers.tiktok.com/docs/en/tiktok-api-v2-rate-limit
 *   - Error Handling (the documented error struct + code table):
 *     https://developers.tiktok.com/docs/en/tiktok-api-v2-error-handling
 *
 * WHAT THIS ADAPTER HOLDS (the frozen port contract, ../../adapter-contract.ts):
 *   - invocation failures return as DATA (the frozen seven-code
 *     taxonomy), NEVER thrown — only malformed input throws
 *     (InvalidRequestError, fail-closed by rejection);
 *   - the provider payload rides VERBATIM as passthrough data (the
 *     normalized record shapes record, they never interpret — MKT-062
 *     owns content normalization);
 *   - engagement observations are NULLABLE facts — the documented
 *     Video Object exposes ALL FOUR counts (view_count, like_count,
 *     comment_count, share_count), so all four ride on content reads;
 *   - the rate-limit observation is a RECORD of observable signals per
 *     call: the documented TikTok rate surfaces expose NO
 *     remaining-quota headers (the limits are per-endpoint sliding
 *     windows enforced server-side — 600/minute for /v2/user/info/,
 *     /v2/video/query/ and /v2/video/list/; 6/minute per user token for
 *     the direct-post init, 20/minute for creator_info/query and
 *     30/minute for status/fetch), so successful calls report
 *     rateLimit: null and the observable quota signals surface on the
 *     documented 429 rate_limit_exceeded answers and the documented 403
 *     daily-cap classes (spam_risk_too_many_posts,
 *     reached_active_user_cap) with the honest all-null observation (no
 *     documented backoff/reset stamps — a Retry-After header, where the
 *     provider sends one, is read opportunistically as the observable
 *     backoff signal). Policy enforcement stays in /policies —
 *     observations are never decisions;
 *   - the publish lifecycle follows the documented DIRECT POST flow:
 *     submitPublish = the direct-post initiation
 *     (POST /v2/post/publish/video/init/ with post_info +
 *     source_info=PULL_FROM_URL — the born 'accepted' publish;
 *     providerPublishId = the documented publish_id; providerContentId
 *     stays null until the status fetch observes a PUBLIC post id),
 *     getPublishStatus = the documented status fetch
 *     (POST /v2/post/publish/status/fetch/ by publish_id:
 *     PROCESSING_UPLOAD/PROCESSING_DOWNLOAD/SEND_TO_USER_INBOX → still
 *     accepted; PUBLISH_COMPLETE → published with
 *     publicaly_available_post_id[0] as the content identity where the
 *     post is publicly viewable — a private-mode post completes with NO
 *     public post id, honestly null; FAILED → the fail_reason split:
 *     the documented spam_risk family → the honest restricted outcome
 *     carrying the restriction signal, every other documented
 *     fail_reason → the honest failed outcome carrying the provider's
 *     own reason as providerFailureReason);
 *   - the idempotency key is the at-most-once identity TOWARD the
 *     provider (the host fences (socialAccountId, idempotencyKey)
 *     durably — a replay NEVER reaches the adapter; the documented
 *     direct-post init exposes no client idempotency token, so the key
 *     is the adapter-side identity and the adapter never opens a second
 *     publish for a key it has already served).
 *
 * THE ELIGIBILITY/AUDIT HONESTY (the MKT-060 AC, the honest analog of
 * Instagram's Business/Creator rule and Facebook Pages' Pages-only
 * rule): the documented direct-post surface serves accounts authorized
 * for direct posting under the platform's OWN audit + privacy model —
 *   - an UNAUDITED client attempting a non-private publish answers the
 *     documented 403 unaudited_client_can_only_post_to_private_accounts
 *     (mapped onto the honest 'restricted' data failure — an eligibility
 *     block, never a fabricated success);
 *   - a PRIVATE-mode creator exposes no PUBLIC_TO_EVERYONE privacy
 *     option (the documented creator_info/query answer for a private
 *     account), and a publish outside the creator's documented options
 *     answers the 403 privacy_level_option_mismatch;
 *   - the documented audit note: "All content posted by unaudited
 *     clients will be restricted to private viewing mode" — the
 *     adapter NEVER invents audit state (no documented read endpoint
 *     exposes the client's audit status; §11 — hidden moderation state
 *     is never invented): the audit restriction surfaces ONLY through
 *     the documented publish error semantics as honest DATA.
 * The creator capability query (POST /v2/post/publish/creator_info/query/)
 * — the documented eligibility surface (privacy_level_options,
 * comment/duet/stitch settings, max_video_post_duration_sec) — is served
 * through the restriction-signals family as DATA: the ELIGIBILITY
 * signals (the privacy options + the duration bound) are reported as
 * signals; the creator's OWN interaction settings ride the VERBATIM
 * passthrough (the MKT-057 privacyStatus precedent: the owner's own
 * settings are deliberately not reported as restriction signals).
 *
 * DOCUMENTED API SEMANTICS IMPLEMENTED (the provider evidence section
 * with URLs lives in docs/runbooks/MKT-060.md):
 *   user/info      GET /v2/user/info/?fields=<f,..>
 *                  — the authorized user's profile fields (identity +
 *                    profile + the account-level statistical counts).
 *   video/list     POST /v2/video/list/?fields=<f,..>
 *                  body { cursor, max_count }
 *                  — the user's public video posts, create_time
 *                    descending, the documented cursor pagination
 *                    (the cursor is a UTC Unix-ms timestamp; the frozen
 *                    page-cursor shape stringifies it) with
 *                    max_count ≤ 20 per the documented bound.
 *   video/query    POST /v2/video/query/?fields=<f,..>
 *                  body { filters: { video_ids: [...] } }
 *                  — up to 20 video ids per request; the endpoint
 *                    "verifies that the videos belong to the user and
 *                    returns video details" — an unknown/not-owned id is
 *                    simply ABSENT from the videos list (the honest null
 *                    record — the documented empty-list semantics, the
 *                    MKT-057 videos.list precedent).
 *   creator_info   POST /v2/post/publish/creator_info/query/
 *                  — the creator capability/eligibility surface (the
 *                    documented privacy_level_options +
 *                    max_video_post_duration_sec + the interaction
 *                    settings; the documented 200-INTENTIONAL error
 *                    answers — e.g. spam_risk_too_many_posts served
 *                    over HTTP 200 with error.code != 'ok' — are
 *                    classified by the error code, per the documented
 *                    rule "Any code other than ok indicates the request
 *                    did not succeed").
 *   video/init     POST /v2/post/publish/video/init/
 *                  — the direct-post initiation (post_info: title,
 *                    privacy_level, disable_duet, disable_stitch,
 *                    disable_comment, video_cover_timestamp_ms,
 *                    brand toggles, is_aigc; source_info:
 *                    PULL_FROM_URL + video_url) — the born accepted
 *                    publish with the publish_id.
 *   status/fetch   POST /v2/post/publish/status/fetch/
 *                  body { publish_id }
 *                  — the documented publish-status fetch by publish_id
 *                    (status + fail_reason + publicaly_available_post_id
 *                    + the byte counters).
 *
 * DOCUMENTED ERROR STRUCT (the v2 error handling reference):
 *   { "error": { "code": "<string>", "message": "<text>",
 *                "log_id": "<id>" } }
 *   (the error-handling reference also documents the TOP-LEVEL variant
 *   { "code", "message", "log_id" } — both shapes are parsed) mapped
 *   onto the frozen taxonomy (the code-driven classification):
 *   transport refused/timeout/oversized/5xx
 *                                    → provider-unavailable (retryable)
 *   401 access_token_invalid /
 *       scope_not_authorized        → auth-expired (reauthorization)
 *   429 rate_limit_exceeded         → rate-limited (+ observation)
 *   403 spam_risk_too_many_posts /
 *       reached_active_user_cap     → rate-limited (the documented
 *                                    daily-quota classes; the honest
 *                                    all-null observation — no
 *                                    documented reset stamps)
 *   403 other (unaudited_client_can_only_post_to_private_accounts,
 *       spam_risk_user_banned_from_posting, spam_risk, spam_risk_text,
 *       url_ownership_unverified, privacy_level_option_mismatch)
 *                                    → restricted (the eligibility /
 *                                    restriction classes)
 *   400 invalid_publish_id (the status fetch of an unknown publish) →
 *                                    provider-unavailable (the provider
 *                                    reports no such publish — the
 *                                    MKT-057 unknown-session precedent)
 *   400 other (invalid_param(s), scope_permission_missed,
 *       token_not_authorized_for_specified_publish_id, ...)
 *                                    → restricted (DISCLOSED judgment:
 *                                    the frozen taxonomy has no
 *                                    malformed-request code and the
 *                                    frozen migration-050 CHECK (failed
 *                                    ⇒ failure_code NOT NULL) forbids
 *                                    the null-code processed-rejection
 *                                    row on the ATTEMPT ledger — the
 *                                    verbatim envelope rides the failure
 *                                    message; the MKT-057/058/059
 *                                    precedent)
 *   A 2xx answer carrying error.code != 'ok' classifies through the
 *   SAME code-driven table (the documented 200-intentional answers).
 *
 * The data-plane host resolves from the connection's NON-SECRET
 * providerConfig (the deployment override surface): apiBaseUrl,
 * defaulting to the documented public host (https://open.tiktokapis.com).
 * The credential MATERIAL (the §21 in-process bytes) carries the OAuth
 * token bundle ({ accessToken, ... }) the authorized flow provisioned —
 * the adapter parses it in-process ONLY and sends it as the documented
 * Bearer header.
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
  SocialRestrictionSignalsResult,
} from '../../adapter-contract.ts';
import type { HttpCallPort, HttpCallRequest, HttpCallResponse } from '../../../../../platform/http/outbound.ts';

// ---------------------------------------------------------------------------
// The honest capability matrix (the REAL documented Login Kit scopes)
// ---------------------------------------------------------------------------

/** The platform identity: the SAME key the /integrations adapter registry uses (lock rule 18). */
export const TIKTOK_SOCIAL_ADAPTER_KEY = 'tiktok';

/**
 * The REAL documented Login Kit scope names (verified against the live
 * scopes reference at delivery time —
 * https://developers.tiktok.com/docs/en/tiktok-api-scopes). DISCLOSED:
 * the dispatch's candidate list named creator.info and creator.data —
 * those scopes are NOT part of the current documented Login Kit scope
 * reference (the Creator API product and its scopes are retired from
 * the current documented surface; the Query Creator Info endpoint is
 * authorized by video.publish), and the live reference adds
 * user.info.stats (the documented scope of the statistical fields
 * follower_count/following_count/likes_count/video_count) which the
 * dispatch's candidate list did not name.
 */
export const TIKTOK_SCOPES = {
  /** "Read a user's profile info (open id, avatar, display name ...)" — the base user fields. */
  infoBasic: 'user.info.basic',
  /** "Read access to profile_web_link, profile_deep_link, bio_description, is_verified." */
  infoProfile: 'user.info.profile',
  /** "Read access to a user's statistical data, such as likes count, follower count, following count, and video count." */
  infoStats: 'user.info.stats',
  /** "Read a user's public videos on TikTok" (List Videos + Query Videos). */
  videoList: 'video.list',
  /** "Directly post content to a user's TikTok profile." (Direct Post + Query Creator Info + Get Post Status). */
  videoPublish: 'video.publish',
} as const;

/** The adapter descriptor (the registry data view). */
export const TIKTOK_SOCIAL_ADAPTER_DESCRIPTOR = {
  adapterKey: TIKTOK_SOCIAL_ADAPTER_KEY,
  providerLabel: 'TikTok (Login Kit + Content Posting API)',
  description:
    'The fourth concrete MKT-056 social platform adapter: the documented TikTok for Developers surface (Login Kit user info + the Display API video reads + the Content Posting API direct-post lifecycle and the Query Creator Info eligibility surface) mapped onto the normalized capability plane over the platform HttpCallPort (fetch-based, zero provider SDKs). Failures return as the frozen seven-code taxonomy data; provider payloads ride VERBATIM as passthrough; the wiring is inert without an authorized TikTok integration connection + OAuth grant (the fail-closed chain precedes every provider call). Limitations are disclosed per capability (lock rule 37) — see docs/runbooks/MKT-060.md.',
} as const;

/**
 * The declared capability matrix: all five frozen families are honestly
 * supported by the documented surface — the SUBSET discipline shows in
 * the per-family REAL scopes (the least-privilege documented sets), the
 * documented operation mappings and the disclosed limitations per
 * family (lock rule 37: the matrix must declare limitations before
 * acceptance).
 */
export function tikTokSocialAdapterCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [TIKTOK_SCOPES.infoBasic, TIKTOK_SCOPES.infoProfile, TIKTOK_SCOPES.infoStats],
      description:
        'TikTok account identity binding + profile reads over the documented Get User Info endpoint (GET /v2/user/info/?fields=... — open_id/union_id/display_name + the user.info.profile fields + the user.info.stats counts). Limitations: the documented surface exposes a verified BADGE (is_verified), not a verification timestamp — verifiedAt reports null (the flag rides the passthrough data); no account-type label exists on the user-info surface — accountKind reports null; the private/public account mode surfaces ONLY through the documented creator capability query (the restriction-signals family), never as invented user-info state.',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [TIKTOK_SCOPES.videoList],
      description:
        'Content reads over the documented Display API video surfaces: discoverPublicContent and listOwnContent both ride POST /v2/video/list/ (the ONLY public-content listing the documented Login Kit surface permits — the user\u2019s public video posts, create_time descending, the documented cursor pagination with max_count \u2264 20); the caller discovery query is HONESTLY UNUSED (the documented endpoint carries no query parameter and no public keyword/hashtag search exists on the documented surface — the Research API is a separately-gated product; the MKT-059 disclosed precedent). getContent rides POST /v2/video/query/ (filters.video_ids — the documented ownership verification; an unknown id is ABSENT from the answer, the honest null record). Limitations: the documented Video Object exposes ALL FOUR engagement counts (view_count, like_count, comment_count, share_count) — all four ride as observed facts; a video not owned by the authorized user is never returned.',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [TIKTOK_SCOPES.infoStats, TIKTOK_SCOPES.videoList],
      description:
        'Observed metric points over the documented statistical surfaces (the retired Creator Insights API is NOT mapped — the creator.info/creator.data scopes no longer exist in the live documented scope reference; DISCLOSED): readAccountAnalytics = the documented user.info.stats account-level counts (follower_count, following_count, likes_count, video_count — labels VERBATIM, current point-in-time values with null windows, the surface exposes no windowed series); readContentAnalytics = the documented Video Object count fields per content id over Query Videos (view_count, like_count, comment_count, share_count — labels VERBATIM, lifetime values with null windows; ONE documented request per read — the endpoint accepts up to 20 video ids, the frozen input bound). An empty answer yields NO observations (never fabricated zeros).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [TIKTOK_SCOPES.videoPublish],
      description:
        'The documented DIRECT POST lifecycle: submitPublish = POST /v2/post/publish/video/init/ (post_info + source_info PULL_FROM_URL video_url; the born accepted publish_id; a missing privacyLevel defaults to SELF_ONLY, the least-exposure level); getPublishStatus = POST /v2/post/publish/status/fetch/ (in-process statuses \u2192 still accepted; PUBLISH_COMPLETE \u2192 published with publicaly_available_post_id[0] as the content identity when public \u2014 a private-mode post completes with NO public post id, honestly null; FAILED \u2192 the spam_risk fail_reasons map to restricted with the signal, others to failed with the provider\u2019s own reason). Limitations: scheduledFor is unused (no documented scheduling); the FILE_UPLOAD transfer awaits the content-asset wiring (PULL_FROM_URL used); the audit/private-mode restrictions surface through the documented 403 semantics as honest restricted data, never a fabricated success; video/init exposes NO idempotency token \u2014 the host fence is the at-most-once identity.',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: [TIKTOK_SCOPES.videoPublish],
      description:
        'The documented creator capability query (POST /v2/post/publish/creator_info/query/ — the documented eligibility surface, scope video.publish): the ELIGIBILITY facts ride as signals — privacy_level_options (a PRIVATE-mode creator account honestly exposes no PUBLIC_TO_EVERYONE option — the documented private-account answer) and max_video_post_duration_sec (the documented duration bound). Limitations: the creator\u2019s OWN interaction settings (comment_disabled, duet_disabled, stitch_disabled) ride the VERBATIM passthrough data and are deliberately NOT reported as signals (the owner\u2019s own settings, the MKT-057 privacyStatus precedent); the CLIENT\u2019s audit status is exposed by NO documented read endpoint — the audit restriction surfaces ONLY through the documented publish error semantics (403 unaudited_client_can_only_post_to_private_accounts) as honest data, never as invented state (architecture-v1.6 §11).',
    },
  ];
}

// ---------------------------------------------------------------------------
// The documented host + the provider-config override surface
// ---------------------------------------------------------------------------

/** The documented TikTok for Developers API host. */
const DEFAULT_API_BASE = 'https://open.tiktokapis.com';

/** The documented default page size when the caller passes no limit (the /v2/video/list/ default is 10; the documented maximum is 20). */
const DEFAULT_MAX_COUNT = 10;
/** The documented /v2/video/list/ per-request maximum (max_count). */
const MAX_COUNT_CEILING = 20;

const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_SIZE_CAP_BYTES = 512 * 1024;

function resolveBase(providerConfig: Readonly<Record<string, string>>): string {
  const override = providerConfig['apiBaseUrl'];
  const base = typeof override === 'string' && override !== '' ? override : DEFAULT_API_BASE;
  return base.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// The documented error struct + the taxonomy classification
// ---------------------------------------------------------------------------

/** The documented v2 error struct (the parsed subset the classifier reads). */
interface TikTokErrorStruct {
  readonly code: string | null;
  readonly message: string | null;
  readonly logId: string | null;
}

/** The documented error codes of the rate/quota classes (429 + the 403 daily caps). */
const RATE_LIMITED_CODES = new Set(['rate_limit_exceeded', 'spam_risk_too_many_posts', 'reached_active_user_cap']);

/** Parses the documented error struct from either documented shape (the nested endpoint envelope or the top-level error-handling variant). */
function parseErrorStruct(body: string): TikTokErrorStruct {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown; log_id?: unknown };
      code?: unknown;
      message?: unknown;
      log_id?: unknown;
    };
    if (parsed === null || typeof parsed !== 'object') {
      return { code: null, message: null, logId: null };
    }
    const nested = parsed.error;
    if (nested !== null && nested !== undefined && typeof nested === 'object') {
      const error = nested as { code?: unknown; message?: unknown; log_id?: unknown };
      return {
        code: typeof error.code === 'string' ? error.code : null,
        message: typeof error.message === 'string' ? error.message : null,
        logId: typeof error.log_id === 'string' ? error.log_id : null,
      };
    }
    return {
      code: typeof parsed.code === 'string' ? parsed.code : null,
      message: typeof parsed.message === 'string' ? parsed.message : null,
      logId: typeof parsed.log_id === 'string' ? parsed.log_id : null,
    };
  } catch {
    return { code: null, message: null, logId: null };
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
 * Classifies a provider answer onto the frozen taxonomy (the documented
 * code-driven mapping — see the file header). Works for BOTH the
 * non-2xx answers and the documented 200-INTENTIONAL error answers (a
 * 2xx body carrying error.code != 'ok' — the classification is driven
 * by the documented error code, per the documented rule "Any code other
 * than ok indicates the request did not succeed"). The verbatim
 * code/message ride the failure message (bounded excerpt).
 */
function classifyProviderFailure(
  operation: string,
  response: HttpCallResponse,
): { ok: false; failure: SocialOperationFailure } {
  const errorStruct = parseErrorStruct(response.body);
  const errorCode = errorStruct.code;
  const detail =
    errorCode !== null
      ? `error code '${errorCode}'${errorStruct.message !== null ? `: ${errorStruct.message.slice(0, 300)}` : ''}`
      : response.body.slice(0, 300);
  const label = `the TikTok API ${operation} call failed (HTTP ${response.status}${errorCode !== null ? `, ${detail}` : `: ${detail}`})`;

  // Transport-class failures: the request was not satisfiably processed.
  if (response.status === 0) {
    if (response.timedOut) {
      return failureOf('provider-unavailable', `the TikTok API ${operation} call timed out`);
    }
    if (response.transportRefused) {
      return failureOf(
        'provider-unavailable',
        `the TikTok API ${operation} call was not processed (transport refused/unreachable)`,
      );
    }
    return failureOf(
      'provider-unavailable',
      `the TikTok API ${operation} answer exceeded the bounded response envelope`,
    );
  }
  if (response.status >= 500) {
    return failureOf('provider-unavailable', `${label} — the provider reported a server error (retryable)`);
  }
  // The documented error-CODE classes (the 401/429/403/400 families and
  // the 200-intentional answers classify by the error code).
  if (errorCode === 'access_token_invalid' || errorCode === 'scope_not_authorized') {
    return failureOf(
      'auth-expired',
      `the TikTok API ${operation} call was refused as unauthorized (${detail}) — reauthorization required`,
    );
  }
  if (errorCode !== null && RATE_LIMITED_CODES.has(errorCode)) {
    // The documented rate surfaces: the 429 rate_limit_exceeded class
    // and the 403 daily-cap classes. No documented backoff/reset stamps
    // exist — a Retry-After header, where the provider sends one, is
    // the observable backoff signal; otherwise the honest all-null
    // observation.
    const retryAfterHeader = response.headers['retry-after'] ?? response.headers['Retry-After'] ?? null;
    const retryAfterSeconds =
      retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
    const backoffUntil =
      retryAfterSeconds !== null ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString() : null;
    return failureOf('rate-limited', `${label} — the provider rate/quota limit was observed`, {
      limitRemaining: null,
      limitResetAt: null,
      backoffUntil,
      retryAfterSeconds,
    });
  }
  if (errorCode === 'invalid_publish_id') {
    // The documented status-fetch answer of an unknown publish id: the
    // provider reports no such publish (the MKT-057 unknown-session
    // precedent — the honest provider-unavailable).
    return failureOf(
      'provider-unavailable',
      `the TikTok API ${operation} call resolved no such publish (error code 'invalid_publish_id': the publish_id does not exist)`,
    );
  }
  // Every other documented error class (the 403 eligibility/restriction
  // classes — unaudited_client_can_only_post_to_private_accounts,
  // spam_risk_user_banned_from_posting, spam_risk, spam_risk_text,
  // url_ownership_unverified, privacy_level_option_mismatch — and the
  // 400 invalid-parameter family incl. the disclosed judgment): the
  // honest non-retryable provider-side refusal surfaced as 'restricted'
  // with the verbatim envelope excerpt riding the message.
  return failureOf('restricted', `${label} — the provider refused the request`);
}

// ---------------------------------------------------------------------------
// The documented response shapes (the parsed subsets the mappings read)
// ---------------------------------------------------------------------------

/** The documented User Object subset (Get User Info). */
interface TikTokUserObject {
  readonly open_id?: string;
  readonly union_id?: string;
  readonly avatar_url?: string;
  readonly display_name?: string;
  readonly bio_description?: string;
  readonly profile_deep_link?: string;
  readonly is_verified?: boolean;
  readonly username?: string;
  readonly follower_count?: number;
  readonly following_count?: number;
  readonly likes_count?: number;
  readonly video_count?: number;
}

/** The documented Video Object subset (List Videos + Query Videos). */
interface TikTokVideoObject {
  readonly id?: string;
  readonly create_time?: number;
  readonly title?: string;
  readonly video_description?: string;
  readonly duration?: number;
  readonly cover_image_url?: string;
  readonly share_url?: string;
  readonly view_count?: number;
  readonly like_count?: number;
  readonly comment_count?: number;
  readonly share_count?: number;
}

/** The documented creator capability query answer subset (Query Creator Info). */
interface TikTokCreatorInfo {
  readonly creator_avatar_url?: string;
  readonly creator_username?: string;
  readonly creator_nickname?: string;
  readonly privacy_level_options?: readonly string[];
  readonly comment_disabled?: boolean;
  readonly duet_disabled?: boolean;
  readonly stitch_disabled?: boolean;
  readonly max_video_post_duration_sec?: number;
}

/** The documented direct-post init answer subset. */
interface TikTokInitData {
  readonly publish_id?: string;
  readonly upload_url?: string;
}

/** The documented status-fetch answer subset. */
interface TikTokStatusData {
  readonly status?: string;
  readonly fail_reason?: string;
  readonly publicaly_available_post_id?: readonly number[];
  readonly uploaded_bytes?: number;
  readonly downloaded_bytes?: number;
}

/** The documented fail_reason values of the provider-signalled restriction family (the status-fetch FAILED split). */
const SPAM_RISK_FAIL_REASONS = new Set([
  'spam_risk',
  'spam_risk_text',
  'spam_risk_user_banned_from_posting',
  'spam_risk_too_many_posts',
]);

/** The documented user fields the profile read requests (the full least-privilege documented set). */
const USER_PROFILE_FIELDS = [
  'open_id',
  'union_id',
  'avatar_url',
  'display_name',
  'username',
  'bio_description',
  'profile_deep_link',
  'is_verified',
  'follower_count',
  'following_count',
  'likes_count',
  'video_count',
] as const;

/** The documented video fields the content reads request. */
const VIDEO_FIELDS = [
  'id',
  'create_time',
  'title',
  'video_description',
  'duration',
  'cover_image_url',
  'share_url',
  'view_count',
  'like_count',
  'comment_count',
  'share_count',
] as const;

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface TikTokSocialAdapterOptions {
  /** The platform outbound HTTP port (fetch-based in production; the documented https-or-loopback envelope). */
  readonly http: HttpCallPort;
}

/**
 * Constructs the TikTok social platform adapter (a pure object — NO
 * provider traffic at construction; the wiring is inert until the
 * fail-closed host chain hands it an authorized call context).
 */
export function createTikTokSocialAdapter(options: TikTokSocialAdapterOptions): SocialPlatformAdapter {
  const http = options.http;

  // -------------------------------------------------------------------------
  // The provider call helper (the shared request/classify core)
  // -------------------------------------------------------------------------

  /**
   * Issues ONE documented request through the platform port. Transport
   * and envelope failures return as the honest data failures (never
   * thrown across the port); the answer is classified by the
   * documented error-code rule — a 2xx answer carrying error.code !=
   * 'ok' is an honest documented failure ("Any code other than ok
   * indicates the request did not succeed"), a non-2xx answer
   * classifies through the same code-driven table.
   */
  async function callProviderJson(
    operation: string,
    request: Omit<HttpCallRequest, 'timeoutMs' | 'sizeCapBytes'>,
  ): Promise<
    { ok: true; parsed: unknown } | { ok: false; failure: SocialOperationFailure }
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
        `the TikTok API ${operation} call could not be issued: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The transport/HTTP-status classes classify BEFORE any body parse
    // (a refused/failed transport carries no documented body).
    if (response.status < 200 || response.status >= 300) {
      return classifyProviderFailure(operation, response);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body) as unknown;
    } catch {
      return failureOf('provider-unavailable', `the TikTok API ${operation} answer was not the documented JSON body`);
    }
    // The DOCUMENTED success rule: "You can decide whether the request
    // is successful based on the error code. Any code other than ok
    // indicates the request did not succeed" — the documented
    // 200-INTENTIONAL error answers classify through the same
    // code-driven table; a 2xx body with NO error struct (or an 'ok'
    // code) is the documented success.
    const errorStruct = parseErrorStruct(response.body);
    if (errorStruct.code !== null && errorStruct.code !== 'ok') {
      return classifyProviderFailure(operation, response);
    }
    return { ok: true, parsed };
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
  // The account family (GET /v2/user/info/)
  // -------------------------------------------------------------------------

  async function readUserInfo(
    context: SocialAdapterCallContext,
    operation: string,
    fields: readonly string[],
  ): Promise<{ ok: true; user: TikTokUserObject } | { ok: false; failure: SocialOperationFailure }> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    const answer = await callProviderJson(operation, {
      url: `${base}/v2/user/info/?fields=${fields.map((field) => encodeURIComponent(field)).join(',')}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const data = dataOf(answer.parsed);
    const user = data === null ? undefined : (data['user'] as TikTokUserObject | undefined);
    // The documented fields request answers EXACTLY the requested
    // fields (the stats-only read carries no open_id) — the guard here
    // is only the documented `data.user` object presence; the identity
    // ops assert their own requested open_id.
    if (user === null || user === undefined || typeof user !== 'object') {
      return failureOf(
        'provider-unavailable',
        `the TikTok API ${operation} answer carried no documented user object`,
      );
    }
    return { ok: true, user };
  }

  async function verifyAccountIdentity(context: SocialAdapterCallContext): Promise<SocialAccountIdentityResult> {
    const outcome = await readUserInfo(context, 'verifyAccountIdentity (user/info)', [
      'open_id',
      'union_id',
      'avatar_url',
      'display_name',
    ]);
    if (!outcome.ok) return outcome;
    if (typeof outcome.user.open_id !== 'string' || outcome.user.open_id === '') {
      return failureOf(
        'provider-unavailable',
        'the TikTok API verifyAccountIdentity (user/info) answer carried no documented open_id',
      );
    }
    const display =
      typeof outcome.user.display_name === 'string' && outcome.user.display_name !== ''
        ? outcome.user.display_name
        : outcome.user.open_id;
    return {
      ok: true,
      // The documented user-info surface exposes a verified BADGE
      // (is_verified), not a verification timestamp — verifiedAt null
      // (disclosed; the badge rides the profile passthrough data).
      identity: { externalAccountId: outcome.user.open_id, displayIdentity: display, verifiedAt: null },
      rateLimit: null,
    };
  }

  async function getAccountProfile(context: SocialAdapterCallContext): Promise<SocialAccountProfileResult> {
    const outcome = await readUserInfo(context, 'getAccountProfile (user/info)', USER_PROFILE_FIELDS);
    if (!outcome.ok) return outcome;
    const user = outcome.user;
    if (typeof user.open_id !== 'string' || user.open_id === '') {
      return failureOf(
        'provider-unavailable',
        'the TikTok API getAccountProfile (user/info) answer carried no documented open_id',
      );
    }
    const display =
      typeof user.display_name === 'string' && user.display_name !== ''
        ? user.display_name
        : typeof user.username === 'string' && user.username !== ''
          ? user.username
          : user.open_id;
    return {
      ok: true,
      profile: {
        externalAccountId: user.open_id,
        displayIdentity: display,
        // The documented surface exposes is_verified (a badge bool), not
        // a verification timestamp — null (disclosed).
        verifiedAt: null,
        // The documented user-info surface exposes no account-type
        // label — null (the private/public mode surfaces through the
        // creator capability query, the restriction-signals family).
        accountKind: null,
        followerCount:
          typeof user.follower_count === 'number' && Number.isFinite(user.follower_count) ? user.follower_count : null,
        data: user as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: null,
    };
  }

  // -------------------------------------------------------------------------
  // The content-read family (POST /v2/video/list/ + POST /v2/video/query/)
  // -------------------------------------------------------------------------

  /** Maps the documented Video Object onto the normalized content record. */
  function videoRecordOf(video: TikTokVideoObject) {
    const createTime =
      typeof video.create_time === 'number' && Number.isFinite(video.create_time)
        ? new Date(video.create_time * 1000).toISOString()
        : null;
    return {
      providerContentId: video.id!,
      authorExternalAccountId: null,
      contentFormat: 'tiktok#video',
      // The documented create_time is a UTC Unix epoch in SECONDS.
      publishedAt: createTime,
      sourceTimestamp: createTime,
      // The documented Video Object exposes ALL FOUR engagement counts —
      // every count rides as the observed fact (never fabricated; null
      // only where the provider omitted the field).
      engagement: {
        viewCount: typeof video.view_count === 'number' && Number.isFinite(video.view_count) ? video.view_count : null,
        likeCount: typeof video.like_count === 'number' && Number.isFinite(video.like_count) ? video.like_count : null,
        commentCount:
          typeof video.comment_count === 'number' && Number.isFinite(video.comment_count)
            ? video.comment_count
            : null,
        shareCount:
          typeof video.share_count === 'number' && Number.isFinite(video.share_count) ? video.share_count : null,
      },
      data: video as unknown as Readonly<Record<string, unknown>>,
      etag: null,
      sourceVersion: null,
    };
  }

  /**
   * One documented /v2/video/list/ request (the cursor pagination: the
   * documented cursor is a UTC Unix-MS timestamp int64 — the frozen
   * page-cursor shape carries its string form).
   */
  async function videoListPage(
    context: SocialAdapterCallContext,
    operation: string,
    pageCursor: string | null,
    limit: number | null,
  ): Promise<SocialContentPageResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const base = resolveBase(context.providerConfig);
    const body: Record<string, unknown> = {
      // The documented bound: max_count defaults to 10, maximum 20.
      max_count: limit !== null ? Math.min(Math.max(limit, 1), MAX_COUNT_CEILING) : DEFAULT_MAX_COUNT,
    };
    if (pageCursor !== null && /^\d+$/.test(pageCursor)) {
      body['cursor'] = Number(pageCursor);
    }
    const answer = await callProviderJson(operation, {
      url: `${base}/v2/video/list/?fields=${VIDEO_FIELDS.map((field) => encodeURIComponent(field)).join(',')}`,
      method: 'POST',
      headers: { ...authHeaders(bearer), 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
    });
    if (!answer.ok) return answer;
    const data = dataOf(answer.parsed);
    const videos = Array.isArray(data?.['videos']) ? (data!['videos'] as unknown[]) : [];
    const records = videos
      .map((video) =>
        video !== null && typeof video === 'object' && typeof (video as TikTokVideoObject).id === 'string'
          ? videoRecordOf(video as TikTokVideoObject)
          : null,
      )
      .filter((record): record is NonNullable<typeof record> => record !== null);
    const hasMore = data?.['has_more'] === true;
    const cursor = data?.['cursor'];
    return {
      ok: true,
      page: {
        records,
        // The documented cursor (an int64 Unix-MS timestamp) stringified
        // onto the frozen page-cursor shape.
        pageCursor: hasMore && typeof cursor === 'number' && Number.isFinite(cursor) ? String(cursor) : null,
      },
      rateLimit: null,
    };
  }

  async function discoverPublicContent(
    context: SocialAdapterCallContext,
    input: SocialContentDiscoveryQuery,
  ): Promise<SocialContentPageResult> {
    // The ONLY public-content surface the documented Login Kit API
    // permits is the authorized user's public video list — the caller
    // query is HONESTLY UNUSED (the documented endpoint carries no
    // query parameter; no public keyword/hashtag search exists on the
    // documented surface — the MKT-059 disclosed precedent).
    return videoListPage(context, 'discoverPublicContent (video/list)', input.pageCursor, input.limit);
  }

  async function listOwnContent(
    context: SocialAdapterCallContext,
    input: SocialContentListQuery,
  ): Promise<SocialContentPageResult> {
    return videoListPage(context, 'listOwnContent (video/list)', input.pageCursor, input.limit);
  }

  async function getContent(
    context: SocialAdapterCallContext,
    input: SocialContentReadInput,
  ): Promise<SocialContentResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('getContent (video/query)');
    const base = resolveBase(context.providerConfig);
    const answer = await callProviderJson('getContent (video/query)', {
      url: `${base}/v2/video/query/?fields=${VIDEO_FIELDS.map((field) => encodeURIComponent(field)).join(',')}`,
      method: 'POST',
      headers: { ...authHeaders(bearer), 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ filters: { video_ids: [input.providerContentId] } }),
    });
    if (!answer.ok) return answer;
    const data = dataOf(answer.parsed);
    const videos = Array.isArray(data?.['videos']) ? (data!['videos'] as unknown[]) : [];
    const video = videos.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === 'object' &&
        (candidate as TikTokVideoObject).id === input.providerContentId,
    ) as TikTokVideoObject | undefined;
    // The documented Query Videos endpoint "verifies that the videos
    // belong to the user and returns video details" — an unknown or
    // not-owned id is ABSENT from the videos list: the honest null
    // record (the documented empty-list semantics, the MKT-057
    // videos.list precedent — never a fabricated failure).
    return { ok: true, record: video === undefined ? null : videoRecordOf(video), rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The analytics-read family (the documented statistical surfaces)
  // -------------------------------------------------------------------------

  async function readAccountAnalytics(
    context: SocialAdapterCallContext,
    input: { readonly windowStart: string | null; readonly windowEnd: string | null },
  ): Promise<SocialAnalyticsResult> {
    void input;
    // The documented account-level statistical surface: the user.info
    // count fields (point-in-time current values — the surface exposes
    // no windowed series; the caller window is honestly unused there,
    // DISCLOSED). The labels ride VERBATIM.
    const outcome = await readUserInfo(context, 'readAccountAnalytics (user/info stats fields)', [
      'follower_count',
      'following_count',
      'likes_count',
      'video_count',
    ]);
    if (!outcome.ok) return outcome;
    const user = outcome.user;
    const observations: SocialAnalyticsObservation[] = [];
    const metrics: readonly { readonly field: keyof TikTokUserObject; readonly label: string }[] = [
      { field: 'follower_count', label: 'follower_count' },
      { field: 'following_count', label: 'following_count' },
      { field: 'likes_count', label: 'likes_count' },
      { field: 'video_count', label: 'video_count' },
    ];
    for (const metric of metrics) {
      const value = user[metric.field];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      observations.push({
        metric: metric.label,
        value,
        windowStart: null,
        windowEnd: null,
        data: { field: metric.label },
      });
    }
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
    // ONE documented Query Videos request per read (the endpoint accepts
    // up to 20 video ids — exactly the frozen input bound): the
    // documented Video Object count fields ride as the observed metric
    // points, labels VERBATIM, lifetime values with null windows (the
    // surface exposes no windowed series; the caller window is honestly
    // unused there, DISCLOSED).
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('readContentAnalytics (video/query)');
    const base = resolveBase(context.providerConfig);
    const answer = await callProviderJson('readContentAnalytics (video/query)', {
      url: `${base}/v2/video/query/?fields=${['id', 'view_count', 'like_count', 'comment_count', 'share_count']
        .map((field) => encodeURIComponent(field))
        .join(',')}`,
      method: 'POST',
      headers: { ...authHeaders(bearer), 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ filters: { video_ids: [...input.providerContentIds] } }),
    });
    if (!answer.ok) return answer;
    const data = dataOf(answer.parsed);
    const videos = Array.isArray(data?.['videos']) ? (data!['videos'] as unknown[]) : [];
    const observations: SocialAnalyticsObservation[] = [];
    for (const candidate of videos) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const video = candidate as TikTokVideoObject;
      if (typeof video.id !== 'string') continue;
      const metrics: readonly { readonly field: keyof TikTokVideoObject; readonly label: string }[] = [
        { field: 'view_count', label: 'view_count' },
        { field: 'like_count', label: 'like_count' },
        { field: 'comment_count', label: 'comment_count' },
        { field: 'share_count', label: 'share_count' },
      ];
      for (const metric of metrics) {
        const value = video[metric.field];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        observations.push({
          metric: metric.label,
          value,
          windowStart: null,
          windowEnd: null,
          data: { videoId: video.id, field: metric.label },
        });
      }
    }
    return { ok: true, observations, rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The restriction-signals family (the documented creator capability query)
  // -------------------------------------------------------------------------

  async function readRestrictionSignals(context: SocialAdapterCallContext): Promise<SocialRestrictionSignalsResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('readRestrictionSignals (creator_info/query)');
    const base = resolveBase(context.providerConfig);
    // The documented creator capability query — the eligibility surface
    // (the direct-post flow's first documented step: "you must first use
    // the Query Creator Info endpoint to get the target creator's
    // latest information").
    const answer = await callProviderJson('readRestrictionSignals (creator_info/query)', {
      url: `${base}/v2/post/publish/creator_info/query/`,
      method: 'POST',
      headers: { ...authHeaders(bearer), 'content-type': 'application/json; charset=UTF-8' },
      body: '{}',
    });
    if (!answer.ok) return answer;
    const data = dataOf(answer.parsed) as TikTokCreatorInfo | null;
    const info: TikTokCreatorInfo = data === null ? {} : data;
    const signals: SocialRestrictionSignal[] = [];
    // ONLY the documented ELIGIBILITY facts ride as signals: the
    // privacy-level options (a private-mode creator honestly exposes no
    // PUBLIC_TO_EVERYONE option) and the duration bound. The creator's
    // OWN interaction settings ride the VERBATIM passthrough (the
    // owner's settings, the MKT-057 privacyStatus precedent —
    // deliberately NOT reported as signals). The CLIENT's audit status
    // is exposed by NO documented read endpoint — never invented (§11).
    if (Array.isArray(info.privacy_level_options)) {
      signals.push({
        signalKind: 'creator.privacy_level_options',
        observedAt: null,
        description: `the creator capability query reports the documented privacy level options [${info.privacy_level_options.join(', ')}]${info.privacy_level_options.includes('PUBLIC_TO_EVERYONE') ? '' : ' (no PUBLIC option — the documented private-mode answer)'}`,
        data: { privacy_level_options: [...info.privacy_level_options] },
      });
    }
    if (typeof info.max_video_post_duration_sec === 'number' && Number.isFinite(info.max_video_post_duration_sec)) {
      signals.push({
        signalKind: 'creator.max_video_post_duration_sec',
        observedAt: null,
        description: `the creator capability query reports the documented maximum video post duration of ${info.max_video_post_duration_sec} seconds`,
        data: { max_video_post_duration_sec: info.max_video_post_duration_sec },
      });
    }
    return { ok: true, signals, rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The publish family (the documented DIRECT POST lifecycle)
  // -------------------------------------------------------------------------

  /**
   * Maps the normalized publish request onto the documented direct-post
   * initiation body: post_info (the provider-shaped payload params —
   * title, privacy_level, the interaction toggles, the cover timestamp,
   * the brand toggles, is_aigc) + source_info (PULL_FROM_URL + the
   * video_url from the payload or the media-asset URL descriptor). A
   * missing privacyLevel defaults to SELF_ONLY — the least-exposure
   * documented level (the fail-closed reading; the provider's own
   * option validation stays authoritative). The provider owns
   * validation — a documented 400/403 surfaces as the honest taxonomy
   * data failure (never a fabricated adapter-side rejection).
   */
  function directPostInitBodyOf(input: SocialPublishSubmitInput): Readonly<Record<string, unknown>> {
    const payload = input.request.payload as Readonly<Record<string, unknown>>;
    const postInfo: Record<string, unknown> = {};
    if (typeof payload['title'] === 'string') postInfo['title'] = payload['title'];
    // The documented privacy_level enum: PUBLIC_TO_EVERYONE |
    // MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY. A missing
    // value defaults to SELF_ONLY (the least-exposure level).
    postInfo['privacy_level'] =
      typeof payload['privacyLevel'] === 'string' && payload['privacyLevel'] !== ''
        ? payload['privacyLevel']
        : 'SELF_ONLY';
    for (const [payloadKey, documentedKey] of [
      ['disableDuet', 'disable_duet'],
      ['disableStitch', 'disable_stitch'],
      ['disableComment', 'disable_comment'],
      ['brandContentToggle', 'brand_content_toggle'],
      ['brandOrganicToggle', 'brand_organic_toggle'],
      ['isAigc', 'is_aigc'],
    ] as const) {
      if (typeof payload[payloadKey] === 'boolean') postInfo[documentedKey] = payload[payloadKey];
    }
    if (typeof payload['videoCoverTimestampMs'] === 'number' && Number.isFinite(payload['videoCoverTimestampMs'])) {
      postInfo['video_cover_timestamp_ms'] = payload['videoCoverTimestampMs'];
    }
    // The documented PULL_FROM_URL transfer method: the TikTok server
    // pulls the video from a public URL (the FILE_UPLOAD byte-transfer
    // path awaits the content-asset wiring — the frozen
    // /social-accounts matrix row carries no /content-assets direction;
    // DISCLOSED).
    const videoUrl =
      typeof payload['videoUrl'] === 'string' && payload['videoUrl'] !== ''
        ? payload['videoUrl']
        : input.request.mediaAssets.find(
            (asset) => typeof asset.descriptor['url'] === 'string' && asset.descriptor['url'] !== '',
          )?.descriptor['url'];
    return {
      post_info: postInfo,
      source_info: {
        source: 'PULL_FROM_URL',
        ...(typeof videoUrl === 'string' ? { video_url: videoUrl } : {}),
      },
    };
  }

  async function submitPublish(
    context: SocialAdapterCallContext,
    input: SocialPublishSubmitInput,
  ): Promise<SocialPublishSubmitResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('submitPublish (video/init)');
    const base = resolveBase(context.providerConfig);
    const body = directPostInitBodyOf(input);
    const answer = await callProviderJson('submitPublish (video/init)', {
      url: `${base}/v2/post/publish/video/init/`,
      method: 'POST',
      headers: { ...authHeaders(bearer), 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
    });
    if (!answer.ok) {
      // The documented initiation failures (the 403 eligibility classes
      // — unaudited_client_can_only_post_to_private_accounts,
      // privacy_level_option_mismatch, url_ownership_unverified,
      // spam_risk — the 403 daily-cap classes — the 401/429 classes —
      // the 400 invalid_param family): the honest taxonomy DATA failure
      // recorded on the fence. The frozen migration-050 CHECK (failed ⇒
      // failure_code NOT NULL) forbids the null-code processed-rejection
      // row on the ATTEMPT ledger — the provider's verbatim envelope
      // rides the failure message (the MKT-057 initiation-400
      // precedent); the ASYNC post-processing rejection (the status
      // fetch's FAILED state) remains the providerFailureReason carrier
      // where the frozen OBSERVATION table allows the null code.
      return answer;
    }
    const data = dataOf(answer.parsed) as TikTokInitData | null;
    const publishId = data?.publish_id;
    if (typeof publishId !== 'string' || publishId === '') {
      return failureOf(
        'provider-unavailable',
        'the TikTok direct post initiation answered without the documented publish_id',
      );
    }
    return {
      ok: true,
      submission: {
        // The born direct post: the documented processing (the URL pull,
        // then the moderation window) is genuinely async — the honest
        // 'accepted' state with the publish_id as the provider publish
        // identity and NO content id yet (the public post id arrives
        // only through the status fetch, and only for publicly-viewable
        // posts).
        publishState: 'accepted',
        providerPublishId: publishId,
        providerContentId: null,
        publishedAt: null,
        providerFailureReason: null,
        restrictionSignals: [],
        providerData: data as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: null,
    };
  }

  async function getPublishStatus(
    context: SocialAdapterCallContext,
    input: SocialPublishStatusInput,
  ): Promise<SocialPublishStatusResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('getPublishStatus (status/fetch)');
    const base = resolveBase(context.providerConfig);
    // The documented publish-status fetch by publish_id.
    const answer = await callProviderJson('getPublishStatus (status/fetch)', {
      url: `${base}/v2/post/publish/status/fetch/`,
      method: 'POST',
      headers: { ...authHeaders(bearer), 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ publish_id: input.providerPublishId }),
    });
    if (!answer.ok) {
      // The documented 400 invalid_publish_id (the publish_id does not
      // exist) maps onto the honest provider-unavailable (the provider
      // reports no such publish — the classifier); every other
      // documented failure class rides the classifier's mapping.
      return answer;
    }
    const data = (dataOf(answer.parsed) as TikTokStatusData | null) ?? {};
    const status = typeof data.status === 'string' ? data.status : null;
    const providerData = data as unknown as Readonly<Record<string, unknown>>;
    if (status === 'PROCESSING_UPLOAD' || status === 'PROCESSING_DOWNLOAD' || status === 'SEND_TO_USER_INBOX') {
      // The documented in-process statuses: the upload (FILE_UPLOAD) /
      // the URL pull (PULL_FROM_URL) / the inbox notification (the
      // upload/draft flow) — the honest still-processing answer.
      return {
        ok: true,
        status: {
          publishState: 'accepted',
          providerPublishId: input.providerPublishId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData,
        },
        rateLimit: null,
      };
    }
    if (status === 'PUBLISH_COMPLETE') {
      // The documented completion: the public post id is "returned only
      // if the post is published for public viewership and has been
      // approved by the TikTok moderation process" — a private-mode
      // post (SELF_ONLY / an unaudited client's private viewing mode)
      // completes with NO public post id: the honest published state
      // with a null content identity (DISCLOSED). The status surface
      // exposes no publish timestamp — publishedAt null.
      const publicPostIds = Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id : [];
      const firstPublicPostId = publicPostIds.find((id) => typeof id === 'number' && Number.isFinite(id));
      return {
        ok: true,
        status: {
          publishState: 'published',
          providerPublishId: input.providerPublishId,
          providerContentId: firstPublicPostId !== undefined ? String(firstPublicPostId) : null,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData,
        },
        rateLimit: null,
      };
    }
    if (status === 'FAILED') {
      // The documented FAILED state with its fail_reason: the spam_risk
      // family ("TikTok TnS team has banned the creator..." / "too many
      // posts within the last 24 hours" — the provider-signalled
      // restriction classes, "Retry should not be done") maps onto the
      // honest RESTRICTED outcome carrying the restriction signal; every
      // other documented fail_reason (the pull failures, the
      // cancellation, the auth removal) maps onto the honest FAILED
      // outcome carrying the provider's own reason as
      // providerFailureReason (the MKT-057 uploadStatus rejected/failed
      // split precedent).
      const failReason = typeof data.fail_reason === 'string' ? data.fail_reason : null;
      if (failReason !== null && SPAM_RISK_FAIL_REASONS.has(failReason)) {
        return {
          ok: true,
          status: {
            publishState: 'restricted',
            providerPublishId: input.providerPublishId,
            providerContentId: null,
            publishedAt: null,
            providerFailureReason: null,
            restrictionSignals: [
              {
                signalKind: `publish.fail_reason.${failReason}`,
                observedAt: null,
                description: `the publish status fetch reports the documented fail_reason '${failReason}' (the provider-signalled restriction class)`,
                data: { publishId: input.providerPublishId, fail_reason: failReason },
              },
            ],
            providerData,
          },
          rateLimit: null,
        };
      }
      return {
        ok: true,
        status: {
          publishState: 'failed',
          providerPublishId: input.providerPublishId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason:
            failReason !== null
              ? `fail_reason=${failReason} (the provider reports the publish failed)`
              : 'the publish status fetch reports FAILED without a fail_reason',
          restrictionSignals: [],
          providerData,
        },
        rateLimit: null,
      };
    }
    // An undocumented status value: the honest provider-unavailable
    // (the answer is not a documented status surface — never guessed).
    return failureOf(
      'provider-unavailable',
      `the TikTok publish status fetch answered the undocumented status '${String(status)}'`,
    );
  }

  return {
    descriptor: { ...TIKTOK_SOCIAL_ADAPTER_DESCRIPTOR },
    capabilities: tikTokSocialAdapterCapabilities(),
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
