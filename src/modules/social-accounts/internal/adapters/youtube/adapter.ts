/**
 * MKT-057 — the CONCRETE YOUTUBE SOCIAL PLATFORM ADAPTER (the first
 * MKT-056 SocialPlatformAdapter implementation): the honest capability
 * matrix + the documented YouTube Data API v3 + YouTube Analytics API
 * v2 surface mapped onto the frozen normalized capability plane, over
 * the platform HttpCallPort (fetch-based, ZERO provider SDKs — the
 * /integrations INT-001 discipline and the arch-check
 * EXTERNAL_PACKAGE_IN_SRC rule).
 *
 * ONE-FILE SUBTREE (the arch-check adapter classification): every file
 * under an 'adapters' path segment is a CONCRETE ADAPTER — the matrix
 * and the adapter implementation share this single file because a
 * second subtree file would be an adapter importing another adapter
 * (ADAPTER_COUPLING). The frozen contract itself is imported from the
 * module-internal contract ('../../adapter-contract.ts'), NOT through
 * the internal/adapters/adapter-contract.ts re-export shim — the shim
 * is itself under an 'adapters' path segment, so importing it from
 * this subtree would be the same ADAPTER_COUPLING violation; the
 * direct same-module import is the only arch-check-legal form of the
 * sanctioned dependency on the frozen contract.
 *
 * PROVIDER EVIDENCE (the documented surfaces this adapter maps — the
 * full evidence section with URLs lives in docs/runbooks/MKT-057.md):
 *   - YouTube Data API v3 reference (channels.list, search.list,
 *     videos.list, videos.insert + the video resource status
 *     uploadStatus/rejectionReason/privacyStatus and contentDetails
 *     regionRestriction):
 *     https://developers.google.com/youtube/v3/docs
 *   - YouTube Analytics API v2 reports (ids=channel==MINE,
 *     filters=video==<id>, the metric vocabulary):
 *     https://developers.google.com/youtube/analytics/reference
 *   - Google OAuth 2.0 scopes (the REAL scope URIs below):
 *     https://developers.google.com/identity/protocols/oauth2/scopes
 *   - Quota cost model (read=1, search.list=100, videos.insert=1600
 *     units; the default 10,000 units/day project quota):
 *     https://developers.google.com/youtube/v3/determine_quota_cost
 *     https://developers.google.com/youtube/v3/getting-started#quota
 *
 * WHAT THIS ADAPTER HOLDS (the frozen port contract, ../../adapter-contract.ts):
 *   - invocation failures return as DATA (the frozen seven-code
 *     taxonomy), NEVER thrown — only malformed input throws
 *     (InvalidRequestError, fail-closed by rejection);
 *   - the provider payload rides VERBATIM as passthrough data (the
 *     normalized record shapes record, they never interpret — MKT-062
 *     owns content normalization);
 *   - engagement observations are NULLABLE facts (only what the
 *     documented API exposes — search pages carry NO statistics and the
 *     Data API statistics expose NO share count);
 *   - the rate-limit observation is a RECORD of observable signals per
 *     call: YouTube Data API responses expose NO remaining-quota
 *     headers (the documented quota is project-side accounting —
 *     https://developers.google.com/youtube/v3/getting-started#quota),
 *     so successful calls report rateLimit: null and the observable
 *     quota signals surface on the documented 403
 *     quotaExceeded/rateLimitExceeded failures (the Retry-After header
 *     where the provider sends one). Policy enforcement stays in
 *     /policies — observations are never decisions;
 *   - the publish lifecycle follows the documented resumable upload
 *     protocol: submitPublish = the videos.insert metadata initiation
 *     (the born 'accepted' upload session; providerPublishId = the
 *     upload_id of the session URI; a documented 400 metadata rejection
 *     surfaces as the honest 'restricted' data failure with the
 *     verbatim envelope — see the taxonomy section below),
 *     getPublishStatus = the documented session status probe
 *     (PUT with the documented Content-Range status-probe value —
 *      308 Resume Incomplete while
 *     processing, 201 + the video resource when complete) mapping the
 *     terminal video status (uploadStatus processed/rejected/failed)
 *     onto published/restricted/failed with the documented
 *     rejectionReason passthrough;
 *   - the idempotency key is the at-most-once identity TOWARD the
 *     provider (the host fences (socialAccountId, idempotencyKey)
 *     durably — a replay NEVER reaches the adapter; YouTube's
 *     videos.insert exposes no client idempotency token, so the key is
 *     the adapter-side identity and the adapter never opens a second
 *     session for a key it has already served).
 *
 * DOCUMENTED API SEMANTICS IMPLEMENTED (the provider evidence section
 * with URLs lives in docs/runbooks/MKT-057.md):
 *   channels.list  GET /youtube/v3/channels?part=snippet[,statistics]&mine=true
 *                  — the authorized user's channel (identity + profile).
 *   search.list    GET /youtube/v3/search?part=snippet&q=<q>&type=video
 *                        &maxResults=<n>&pageToken=<token>
 *                  GET /youtube/v3/search?part=snippet&channelId=<own>
 *                        &order=date&maxResults=<n>&pageToken=<token>
 *                  — public discovery + own-content listing (the
 *                    documented nextPageToken pagination).
 *   videos.list    GET /youtube/v3/videos?part=snippet,statistics,contentDetails
 *                        &id=<videoId>
 *                  — the single-content read (statistics + status +
 *                    contentDetails.regionRestriction); an unknown id
 *                    returns an EMPTY items list (the honest null
 *                    record — never a fabricated failure).
 *   videos.insert  POST /upload/youtube/v3/videos?uploadType=resumable
 *                        &part=snippet,status
 *                  — the resumable-upload initiation (metadata
 *                    resource JSON; the response's Location header
 *                    carries the session URI with upload_id).
 *   (session)      PUT  /upload/youtube/v3/videos?uploadType=resumable
 *                        &upload_id=<id>   (the Content-Range
 *                         status-probe header)
 *                  — the documented session status probe: 308 Resume
 *                    Incomplete / 201 + the completed video resource /
 *                    404 unknown-expired session.
 *   reports (YT Analytics API v2)
 *                  GET  /youtubeAnalytics/v2/reports?ids=channel==MINE
 *                        &metrics=<m,...>&startDate=<d>&endDate=<d>
 *                        [&filters=video==<id>]
 *                  — the observed metric points (columnHeaders[].name
 *                    VERBATIM + rows[]).
 *
 * DOCUMENTED ERROR ENVELOPE (the Google API standard error body):
 *   { "error": { "code": <int>, "message": "<text>",
 *                "errors": [{ "reason": "<code>", "message": "<text>",
 *                             "domain": "<domain>" }] } }
 * mapped onto the frozen taxonomy:
 *   transport refused/timeout/5xx/oversized   → provider-unavailable (retryable)
 *   401 (unauthorized/requiredLogin/...)      → auth-expired (reauthorization)
 *   403 quotaExceeded/rateLimitExceeded/
 *       userRateLimitExceeded/dailyLimitExceeded
 *                                              → rate-limited (+ observation)
 *   403 other (forbidden/accountSuspended/
 *       youtubeSignupRequired/...)            → restricted
 *   400 on videos.insert initiation          → the honest 'restricted'
 *                                                data failure with the
 *                                                verbatim Google error
 *                                                envelope in the failure
 *                                                message (DISCLOSED: the
 *                                                frozen taxonomy has no
 *                                                malformed-request code
 *                                                and the frozen
 *                                                migration-050 CHECK
 *                                                (failed ⇒ failure_code
 *                                                NOT NULL) forbids the
 *                                                null-code processed-
 *                                                rejection row on the
 *                                                ATTEMPT ledger; the
 *                                                ASYNC post-processing
 *                                                rejection — the session
 *                                                probe's uploadStatus
 *                                                failed/rejected —
 *                                                remains the
 *                                                providerFailureReason
 *                                                carrier where the
 *                                                frozen OBSERVATION table
 *                                                allows the null code)
 *   other 4xx                                 → restricted (disclosed
 *                                                judgment: the closed
 *                                                taxonomy has no
 *                                                malformed-request
 *                                                code; a provider 4xx
 *                                                refusal is a
 *                                                non-retryable
 *                                                provider-side
 *                                                refusal and the
 *                                                verbatim envelope
 *                                                rides the message).
 *
 * The data-plane hosts resolve from the connection's NON-SECRET
 * providerConfig (the deployment override surface): apiBaseUrl (the
 * Data API + upload host) and analyticsApiBaseUrl (the Analytics API
 * host), defaulting to the documented public hosts. The credential
 * MATERIAL (the §21 in-process bytes) carries the OAuth token bundle
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
  SocialRestrictionSignalsResult,
} from '../../adapter-contract.ts';
import type { HttpCallPort, HttpCallRequest, HttpCallResponse } from '../../../../../platform/http/outbound.ts';

// ---------------------------------------------------------------------------
// The honest capability matrix (the REAL Google OAuth scope URIs)
// ---------------------------------------------------------------------------

/** The platform identity: the SAME key the /integrations adapter registry uses (lock rule 18). */
export const YOUTUBE_SOCIAL_ADAPTER_KEY = 'youtube';

/** The REAL Google OAuth scope URIs the declared operations require (least privilege). */
export const YOUTUBE_SCOPES = {
  /** View your YouTube account (channels.list mine=true, videos.list, search.list). */
  readonly: 'https://www.googleapis.com/auth/youtube.readonly',
  /** Manage your YouTube videos (videos.insert — the documented upload scope). */
  upload: 'https://www.googleapis.com/auth/youtube.upload',
  /** View YouTube Analytics reports for your content (the Analytics API v2 reports). */
  analyticsReadonly: 'https://www.googleapis.com/auth/yt-analytics.readonly',
} as const;

/** The adapter descriptor (the registry data view). */
export const YOUTUBE_SOCIAL_ADAPTER_DESCRIPTOR = {
  adapterKey: YOUTUBE_SOCIAL_ADAPTER_KEY,
  providerLabel: 'YouTube (Data API v3 + Analytics API v2)',
  description:
    'The first concrete MKT-056 social platform adapter: the documented YouTube Data API v3 (channels/search/videos + the resumable upload lifecycle) and YouTube Analytics API v2 surfaces mapped onto the normalized capability plane over the platform HttpCallPort (fetch-based, zero provider SDKs). Failures return as the frozen seven-code taxonomy data; provider payloads ride VERBATIM as passthrough; the wiring is inert without an authorized YouTube integration connection + OAuth grant (the fail-closed chain precedes every provider call). Limitations are disclosed per capability (lock rule 37) — see docs/runbooks/MKT-057.md.',
} as const;

/**
 * The declared capability matrix: all five frozen families are honestly
 * supported by the documented YouTube surface — the SUBSET discipline
 * shows in the per-family operation vocabulary (exactly the closed
 * sets), the least-privilege REAL scopes and the disclosed limitations
 * per family (lock rule 37: the matrix must declare limitations before
 * acceptance).
 */
export function youTubeSocialAdapterCapabilities(): readonly SocialCapability[] {
  return [
    {
      family: 'account',
      operations: ['verifyAccountIdentity', 'getAccountProfile'],
      requiredScopes: [YOUTUBE_SCOPES.readonly],
      description:
        'YouTube channel identity binding + profile reads over channels.list (part=snippet[,statistics], mine=true — the documented authorized-user channel view). Limitations: the Data API exposes no identity-verification timestamp (verifiedAt reports null) and no channel-level restriction endpoint — channel-level restrictions surface only as invocation failures (403 forbidden/accountSuspended), never as invented state.',
    },
    {
      family: 'content-read',
      operations: ['discoverPublicContent', 'listOwnContent', 'getContent'],
      requiredScopes: [YOUTUBE_SCOPES.readonly],
      description:
        'Public discovery over search.list (q, type=video), own-content listing over search.list (channelId, order=date) and single reads over videos.list (part=snippet,statistics,contentDetails). Limitations: search results carry NO engagement statistics (every engagement observation is null on discovery/listing pages — never fabricated); the Data API statistics expose viewCount/likeCount/commentCount but NO share count (shareCount is always null — shares are observable only as a YouTube Analytics metric); pagination is the documented pageToken/nextPageToken protocol (search costs 100 quota units per call).',
    },
    {
      family: 'analytics-read',
      operations: ['readAccountAnalytics', 'readContentAnalytics'],
      requiredScopes: [YOUTUBE_SCOPES.analyticsReadonly],
      description:
        'Observed metric points over the YouTube Analytics API v2 reports (ids=channel==MINE; per-video filters=video==<id>): the provider metric labels ride VERBATIM (views, estimatedMinutesWatched, averageViewDuration, subscribersGained, subscribersLost, likes, comments, shares). Limitations: one documented report request per content id; a null window defaults to the wide documented-legal window (lifetime aggregate — startDate/endDate are required report parameters); an empty report window yields NO observations (never zeros).',
    },
    {
      family: 'publish',
      operations: ['submitPublish', 'getPublishStatus'],
      requiredScopes: [YOUTUBE_SCOPES.upload],
      description:
        'The documented resumable-upload lifecycle: submitPublish initiates videos.insert (uploadType=resumable, part=snippet,status — the video-metadata resource: snippet + status, publishAt=scheduledFor) and reports the born accepted upload session (providerPublishId = the upload_id; providerContentId null until processing completes; a documented 400 metadata rejection surfaces as the honest restricted data failure with the verbatim envelope); getPublishStatus probes the session (308 → still accepted) and maps the terminal video status (processed → published with the video id, rejected → restricted with the documented rejectionReason, failed → failed). Limitations: the media-byte transfer awaits the content-asset wiring (no /content-assets matrix direction — mediaAssets ride as opaque references, the media-kind hint rides x-upload-content-type); metadata validation is provider-side; videos.insert exposes NO client idempotency token — the host fence is the at-most-once identity.',
    },
    {
      family: 'restriction-signals',
      operations: ['readRestrictionSignals'],
      requiredScopes: [YOUTUBE_SCOPES.readonly],
      description:
        "ONLY the provider-exposed observable signals: own-video uploadStatus rejected/failed (with the documented status.rejectionReason passthrough) and contentDetails.regionRestriction (the allowed/blocked country lists) over search.list(channelId)+videos.list(part=status,contentDetails). Limitations: hidden moderation state is NEVER invented (architecture-v1.6 §11); channel-level restrictions surface as invocation failures, not as a dedicated signals endpoint; privacyStatus is the owner's own setting, not a platform restriction, and is deliberately not reported as a signal.",
    },
  ];
}

// ---------------------------------------------------------------------------
// The documented hosts + the provider-config override surface
// ---------------------------------------------------------------------------

/** The documented Data API host (also serves /upload/youtube/v3 for videos.insert). */
const DEFAULT_DATA_API_BASE = 'https://www.googleapis.com';
/** The documented YouTube Analytics API host. */
const DEFAULT_ANALYTICS_API_BASE = 'https://youtubeanalytics.googleapis.com';

/** The wide documented-legal report window used when the caller passes none (startDate/endDate are REQUIRED report parameters). */
const WIDE_WINDOW_START = '2005-01-01';
const WIDE_WINDOW_END = '2099-12-31';

/** The documented default page size when the caller passes no limit (1..50 per search.list). */
const DEFAULT_MAX_RESULTS = 25;

const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_SIZE_CAP_BYTES = 512 * 1024;

interface YouTubeBases {
  readonly dataApi: string;
  readonly analyticsApi: string;
}

function resolveBases(providerConfig: Readonly<Record<string, string>>): YouTubeBases {
  const override = (key: string): string | null => {
    const value = providerConfig[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  const dataApi = override('apiBaseUrl') ?? DEFAULT_DATA_API_BASE;
  const analyticsApi = override('analyticsApiBaseUrl') ?? DEFAULT_ANALYTICS_API_BASE;
  return { dataApi: dataApi.replace(/\/+$/, ''), analyticsApi: analyticsApi.replace(/\/+$/, '') };
}

// ---------------------------------------------------------------------------
// The documented error envelope + the taxonomy classification
// ---------------------------------------------------------------------------

/** The documented Google API error envelope (the parsed subset the classifier reads). */
interface GoogleErrorEnvelope {
  readonly code: number | null;
  readonly message: string | null;
  readonly reasons: readonly string[];
}

/** The documented reasons the 403 quota family surfaces (the rate-limited class). */
const QUOTA_REASONS = new Set([
  'quotaExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
]);

function parseErrorEnvelope(body: string): GoogleErrorEnvelope {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: unknown; message?: unknown; errors?: unknown };
    };
    if (parsed === null || typeof parsed !== 'object' || parsed.error === null || typeof parsed.error !== 'object') {
      return { code: null, message: null, reasons: [] };
    }
    const error = parsed.error as { code?: unknown; message?: unknown; errors?: unknown };
    const reasons: string[] = [];
    if (Array.isArray(error.errors)) {
      for (const entry of error.errors) {
        if (entry !== null && typeof entry === 'object' && typeof (entry as { reason?: unknown }).reason === 'string') {
          reasons.push((entry as { reason: string }).reason);
        }
      }
    }
    return {
      code: typeof error.code === 'number' ? error.code : null,
      message: typeof error.message === 'string' ? error.message : null,
      reasons,
    };
  } catch {
    return { code: null, message: null, reasons: [] };
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
 * Classifies a non-2xx/transport provider answer onto the frozen
 * taxonomy (the documented mapping — see the file header). The verbatim
 * reason/message ride the failure message (bounded excerpt).
 */
function classifyProviderFailure(
  operation: string,
  response: HttpCallResponse,
): { ok: false; failure: SocialOperationFailure } {
  const envelope = parseErrorEnvelope(response.body);
  const reason = envelope.reasons[0] ?? null;
  const detail =
    reason !== null
      ? `reason '${reason}'${envelope.message !== null ? `: ${envelope.message.slice(0, 300)}` : ''}`
      : response.body.slice(0, 300);
  const label = `the YouTube API ${operation} call failed (HTTP ${response.status}${reason !== null ? `, ${detail}` : `: ${detail}`})`;

  // Transport-class failures: the request was not satisfiably processed.
  if (response.status === 0) {
    if (response.timedOut) {
      return failureOf('provider-unavailable', `the YouTube API ${operation} call timed out`);
    }
    if (response.transportRefused) {
      return failureOf(
        'provider-unavailable',
        `the YouTube API ${operation} call was not processed (transport refused/unreachable)`,
      );
    }
    return failureOf(
      'provider-unavailable',
      `the YouTube API ${operation} answer exceeded the bounded response envelope`,
    );
  }
  if (response.status >= 500) {
    return failureOf('provider-unavailable', `${label} — the provider reported a server error (retryable)`);
  }
  if (response.status === 401) {
    return failureOf(
      'auth-expired',
      `the YouTube API ${operation} call was refused as unauthorized (HTTP 401${reason !== null ? `, ${detail}` : ''}) — reauthorization required`,
    );
  }
  if (response.status === 429 || (response.status === 403 && envelope.reasons.some((r) => QUOTA_REASONS.has(r)))) {
    // The documented quota/rate family: the observable backoff signals
    // ride the observation (the Retry-After header where present).
    const retryAfterHeader = response.headers['retry-after'] ?? response.headers['Retry-After'] ?? null;
    const retryAfterSeconds =
      retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
    const backoffUntil =
      retryAfterSeconds !== null ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString() : null;
    return failureOf('rate-limited', `${label} — the provider quota/rate limit was observed`, {
      limitRemaining: null,
      limitResetAt: null,
      backoffUntil,
      retryAfterSeconds,
    });
  }
  if (response.status === 403) {
    return failureOf(
      'restricted',
      `the YouTube API ${operation} call was refused (HTTP 403, ${detail}) — the provider signalled a restriction/eligibility block`,
    );
  }
  // The disclosed judgment call (the file header): every other 4xx is a
  // non-retryable provider-side refusal surfaced as 'restricted' with
  // the verbatim envelope excerpt.
  return failureOf('restricted', `${label} — the provider refused the request`);
}

// ---------------------------------------------------------------------------
// The documented response shapes (the parsed subset the mappings read)
// ---------------------------------------------------------------------------

interface ChannelResource {
  readonly kind: 'youtube#channel';
  readonly etag: string | null;
  readonly id: string;
  readonly snippet?: {
    readonly title?: string;
    readonly description?: string;
    readonly customUrl?: string;
    readonly publishedAt?: string;
  };
  readonly statistics?: {
    readonly viewCount?: string;
    readonly subscriberCount?: string;
    readonly hiddenSubscriberCount?: boolean;
    readonly videoCount?: string;
  };
}

interface SearchItem {
  readonly kind: 'youtube#searchResult';
  readonly etag: string | null;
  readonly id?: { readonly kind?: string; readonly videoId?: string };
  readonly snippet?: {
    readonly publishedAt?: string;
    readonly channelId?: string;
    readonly title?: string;
    readonly description?: string;
    readonly channelTitle?: string;
    readonly publishTime?: string;
  };
}

interface VideoResource {
  readonly kind: 'youtube#video';
  readonly etag: string | null;
  readonly id: string;
  readonly snippet?: {
    readonly publishedAt?: string;
    readonly channelId?: string;
    readonly title?: string;
    readonly description?: string;
  };
  readonly statistics?: {
    readonly viewCount?: string;
    readonly likeCount?: string;
    readonly favoriteCount?: string;
    readonly commentCount?: string;
  };
  readonly status?: {
    readonly uploadStatus?: string;
    readonly privacyStatus?: string;
    readonly rejectionReason?: string;
  };
  readonly contentDetails?: {
    readonly regionRestriction?: { readonly allowed?: readonly string[]; readonly blocked?: readonly string[] };
  };
}

/** Parses a documented statistics count string ('12345') into a number/null — never fabricated. */
function countOf(value: string | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface YouTubeSocialAdapterOptions {
  /** The platform outbound HTTP port (fetch-based in production; the documented https-or-loopback envelope). */
  readonly http: HttpCallPort;
}

/**
 * Constructs the YouTube social platform adapter (a pure object — NO
 * provider traffic at construction; the wiring is inert until the
 * fail-closed host chain hands it an authorized call context).
 */
export function createYouTubeSocialAdapter(options: YouTubeSocialAdapterOptions): SocialPlatformAdapter {
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
        `the YouTube API ${operation} call could not be issued: ${error instanceof Error ? error.message : String(error)}`,
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
      return failureOf('provider-unavailable', `the YouTube API ${operation} answer was not the documented JSON body`);
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

  // -------------------------------------------------------------------------
  // The account family (channels.list mine=true)
  // -------------------------------------------------------------------------

  async function readOwnChannel(
    context: SocialAdapterCallContext,
    operation: string,
    parts: string,
  ): Promise<{ ok: true; channel: ChannelResource } | { ok: false; failure: SocialOperationFailure }> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const bases = resolveBases(context.providerConfig);
    const answer = await callProviderJson(operation, {
      url: `${bases.dataApi}/youtube/v3/channels?part=${encodeURIComponent(parts)}&mine=true`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const list = answer.parsed as { items?: unknown };
    const items = Array.isArray(list?.items) ? (list.items as unknown[]) : [];
    const channel =
      items.find(
        (item): item is ChannelResource =>
          item !== null && typeof item === 'object' && typeof (item as ChannelResource).id === 'string',
      ) ?? null;
    if (channel === null) {
      // The documented channels.list answer for an authorized account
      // with no YouTube channel is 403 youtubeSignupRequired (mapped to
      // 'restricted' by the classifier); an EMPTY 200 items list is the
      // defensive honest restriction surface (no channel = no eligibility).
      return failureOf(
        'restricted',
        `the ${operation} call observed no YouTube channel on the authorized account (the account cannot use the YouTube surface — eligibility block)`,
      );
    }
    return { ok: true, channel };
  }

  async function verifyAccountIdentity(context: SocialAdapterCallContext): Promise<SocialAccountIdentityResult> {
    const outcome = await readOwnChannel(context, 'verifyAccountIdentity (channels.list)', 'snippet');
    if (!outcome.ok) return outcome;
    const snippet = outcome.channel.snippet ?? {};
    const title = typeof snippet.title === 'string' && snippet.title !== '' ? snippet.title : outcome.channel.id;
    return {
      ok: true,
      // The Data API exposes no identity-verification timestamp — null (disclosed).
      identity: { externalAccountId: outcome.channel.id, displayIdentity: title, verifiedAt: null },
      rateLimit: null,
    };
  }

  async function getAccountProfile(context: SocialAdapterCallContext): Promise<SocialAccountProfileResult> {
    const outcome = await readOwnChannel(context, 'getAccountProfile (channels.list)', 'snippet,statistics');
    if (!outcome.ok) return outcome;
    const snippet = outcome.channel.snippet ?? {};
    const statistics = outcome.channel.statistics ?? {};
    const title = typeof snippet.title === 'string' && snippet.title !== '' ? snippet.title : outcome.channel.id;
    // The documented hiddenSubscriberCount flag: a hidden subscriber
    // count is NOT exposed (null — never fabricated).
    const followerCount = statistics.hiddenSubscriberCount === true ? null : countOf(statistics.subscriberCount);
    return {
      ok: true,
      profile: {
        externalAccountId: outcome.channel.id,
        displayIdentity: title,
        verifiedAt: null,
        accountKind: outcome.channel.kind,
        followerCount,
        data: outcome.channel as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: null,
    };
  }

  // -------------------------------------------------------------------------
  // The content-read family (search.list + videos.list)
  // -------------------------------------------------------------------------

  function searchRecordOf(item: SearchItem): {
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
    const videoId = item?.id?.videoId;
    if (typeof videoId !== 'string' || videoId === '') return null;
    return {
      providerContentId: videoId,
      authorExternalAccountId: typeof item.snippet?.channelId === 'string' ? item.snippet.channelId : null,
      contentFormat: typeof item.id?.kind === 'string' ? item.id.kind : 'youtube#video',
      publishedAt: typeof item.snippet?.publishedAt === 'string' ? item.snippet.publishedAt : null,
      sourceTimestamp: typeof item.snippet?.publishTime === 'string' ? item.snippet.publishTime : null,
      // The documented search result carries NO statistics: every
      // engagement fact is null on search pages (never fabricated).
      engagement: { viewCount: null, likeCount: null, commentCount: null, shareCount: null },
      data: item as unknown as Readonly<Record<string, unknown>>,
      etag: typeof item.etag === 'string' ? item.etag : null,
      sourceVersion: null,
    };
  }

  function videoRecordOf(video: VideoResource) {
    return {
      providerContentId: video.id,
      authorExternalAccountId: typeof video.snippet?.channelId === 'string' ? video.snippet.channelId : null,
      contentFormat: video.kind,
      publishedAt: typeof video.snippet?.publishedAt === 'string' ? video.snippet.publishedAt : null,
      sourceTimestamp: typeof video.snippet?.publishedAt === 'string' ? video.snippet.publishedAt : null,
      engagement: {
        viewCount: countOf(video.statistics?.viewCount),
        likeCount: countOf(video.statistics?.likeCount),
        commentCount: countOf(video.statistics?.commentCount),
        // The documented Data API statistics expose NO share count
        // (shares are observable only as an Analytics metric) — null.
        shareCount: null,
      },
      data: video as unknown as Readonly<Record<string, unknown>>,
      etag: typeof video.etag === 'string' ? video.etag : null,
      sourceVersion: null,
    };
  }

  async function searchPage(
    context: SocialAdapterCallContext,
    operation: string,
    query: Readonly<Record<string, string>>,
  ): Promise<SocialContentPageResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const bases = resolveBases(context.providerConfig);
    const search = new URLSearchParams({ part: 'snippet', maxResults: String(DEFAULT_MAX_RESULTS), ...query });
    const answer = await callProviderJson(operation, {
      url: `${bases.dataApi}/youtube/v3/search?${search.toString()}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const list = answer.parsed as { items?: unknown; nextPageToken?: unknown };
    const items = Array.isArray(list?.items) ? (list.items as unknown[]) : [];
    const records = items
      .map((item) => (item !== null && typeof item === 'object' ? searchRecordOf(item as SearchItem) : null))
      .filter((record): record is NonNullable<typeof record> => record !== null);
    const nextPageToken =
      typeof list?.nextPageToken === 'string' && list.nextPageToken !== '' ? list.nextPageToken : null;
    return { ok: true, page: { records, pageCursor: nextPageToken }, rateLimit: null };
  }

  async function discoverPublicContent(
    context: SocialAdapterCallContext,
    input: SocialContentDiscoveryQuery,
  ): Promise<SocialContentPageResult> {
    const query: Record<string, string> = { q: input.query, type: 'video' };
    if (input.limit !== null) query['maxResults'] = String(Math.min(Math.max(input.limit, 1), 50));
    if (input.pageCursor !== null) query['pageToken'] = input.pageCursor;
    return searchPage(context, 'discoverPublicContent (search.list)', query);
  }

  async function listOwnContent(
    context: SocialAdapterCallContext,
    input: SocialContentListQuery,
  ): Promise<SocialContentPageResult> {
    const query: Record<string, string> = { channelId: context.externalAccountId, order: 'date' };
    if (input.limit !== null) query['maxResults'] = String(Math.min(Math.max(input.limit, 1), 50));
    if (input.pageCursor !== null) query['pageToken'] = input.pageCursor;
    return searchPage(context, 'listOwnContent (search.list)', query);
  }

  async function getContent(
    context: SocialAdapterCallContext,
    input: SocialContentReadInput,
  ): Promise<SocialContentResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('getContent (videos.list)');
    const bases = resolveBases(context.providerConfig);
    const answer = await callProviderJson('getContent (videos.list)', {
      url: `${bases.dataApi}/youtube/v3/videos?part=${encodeURIComponent('snippet,statistics,contentDetails')}&id=${encodeURIComponent(input.providerContentId)}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const list = answer.parsed as { items?: unknown };
    const items = Array.isArray(list?.items) ? (list.items as unknown[]) : [];
    const video = items.find(
      (item): item is VideoResource =>
        item !== null && typeof item === 'object' && typeof (item as VideoResource).id === 'string',
    );
    // The documented videos.list answer for an unknown id is an EMPTY
    // items list — the honest null record, never a fabricated failure.
    return { ok: true, record: video === undefined ? null : videoRecordOf(video), rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The analytics-read family (the YouTube Analytics API v2 reports)
  // -------------------------------------------------------------------------

  /** The documented report query (ids=channel==MINE; the required dates; the optional video filter). */
  async function readReport(
    context: SocialAdapterCallContext,
    operation: string,
    metrics: readonly string[],
    windowStart: string | null,
    windowEnd: string | null,
    videoId: string | null,
  ): Promise<
    | { ok: true; observations: readonly SocialAnalyticsObservation[] }
    | { ok: false; failure: SocialOperationFailure }
  > {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure(operation);
    const bases = resolveBases(context.providerConfig);
    const startDate = windowStart !== null ? windowStart.slice(0, 10) : WIDE_WINDOW_START;
    const endDate = windowEnd !== null ? windowEnd.slice(0, 10) : WIDE_WINDOW_END;
    const params = new URLSearchParams({
      ids: 'channel==MINE',
      metrics: metrics.join(','),
      // startDate/endDate are REQUIRED report parameters — a null caller
      // window defaults to the wide documented-legal window (disclosed).
      startDate,
      endDate,
    });
    if (videoId !== null) params.set('filters', `video==${videoId}`);
    const answer = await callProviderJson(operation, {
      url: `${bases.analyticsApi}/youtubeAnalytics/v2/reports?${params.toString()}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const report = answer.parsed as {
      columnHeaders?: readonly { name?: unknown }[];
      rows?: readonly unknown[][];
    };
    const columnHeaders = Array.isArray(report?.columnHeaders) ? report.columnHeaders : [];
    const rows = Array.isArray(report?.rows) ? report.rows : [];
    const firstRow = rows[0];
    // The provider metric labels ride VERBATIM (bounded); an empty
    // report (no data in the window) yields NO observations — never
    // fabricated zeros.
    const observations: SocialAnalyticsObservation[] = [];
    for (const [index, header] of columnHeaders.entries()) {
      const metric = typeof header?.name === 'string' ? header.name : null;
      if (metric === null) continue;
      const cell = Array.isArray(firstRow) ? firstRow[index] : undefined;
      if (typeof cell !== 'number' || !Number.isFinite(cell)) continue;
      observations.push({
        metric,
        value: cell,
        windowStart: `${startDate}T00:00:00.000Z`,
        windowEnd: `${endDate}T00:00:00.000Z`,
        data: { columnHeader: header as unknown as Record<string, unknown> },
      });
    }
    return { ok: true, observations };
  }

  async function readAccountAnalytics(
    context: SocialAdapterCallContext,
    input: { readonly windowStart: string | null; readonly windowEnd: string | null },
  ): Promise<SocialAnalyticsResult> {
    const outcome = await readReport(
      context,
      'readAccountAnalytics (Analytics reports)',
      ['views', 'subscribersGained', 'subscribersLost', 'estimatedMinutesWatched'],
      input.windowStart,
      input.windowEnd,
      null,
    );
    if (!outcome.ok) return outcome;
    return { ok: true, observations: outcome.observations, rateLimit: null };
  }

  async function readContentAnalytics(
    context: SocialAdapterCallContext,
    input: {
      readonly providerContentIds: readonly string[];
      readonly windowStart: string | null;
      readonly windowEnd: string | null;
    },
  ): Promise<SocialAnalyticsResult> {
    // One documented report request per content id (the safe documented
    // filters=video==<id> form — disclosed).
    const observations: SocialAnalyticsObservation[] = [];
    for (const videoId of input.providerContentIds) {
      const outcome = await readReport(
        context,
        'readContentAnalytics (Analytics reports)',
        ['views', 'likes', 'comments', 'shares', 'estimatedMinutesWatched'],
        input.windowStart,
        input.windowEnd,
        videoId,
      );
      if (!outcome.ok) return outcome;
      for (const observation of outcome.observations) {
        observations.push({ ...observation, data: { ...observation.data, providerContentId: videoId } });
      }
    }
    return { ok: true, observations, rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The restriction-signals family (videos.list part=status,contentDetails over own videos)
  // -------------------------------------------------------------------------

  async function readRestrictionSignals(context: SocialAdapterCallContext): Promise<SocialRestrictionSignalsResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('readRestrictionSignals');
    const bases = resolveBases(context.providerConfig);

    // Step 1: the own-video ids (the documented channelId search).
    const ownSearch = await callProviderJson('readRestrictionSignals (search.list)', {
      url: `${bases.dataApi}/youtube/v3/search?${new URLSearchParams({
        part: 'snippet',
        channelId: context.externalAccountId,
        order: 'date',
        maxResults: String(DEFAULT_MAX_RESULTS),
      }).toString()}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!ownSearch.ok) return ownSearch;
    const searchList = ownSearch.parsed as { items?: unknown };
    const searchItems = Array.isArray(searchList?.items) ? (searchList.items as unknown[]) : [];
    const videoIds = searchItems
      .map((item) =>
        item !== null && typeof item === 'object' ? (item as SearchItem).id?.videoId ?? null : null,
      )
      .filter((id): id is string => typeof id === 'string' && id !== '');
    if (videoIds.length === 0) {
      return { ok: true, signals: [], rateLimit: null };
    }

    // Step 2: the status/contentDetails facts of those videos.
    const answer = await callProviderJson('readRestrictionSignals (videos.list)', {
      url: `${bases.dataApi}/youtube/v3/videos?part=${encodeURIComponent('status,contentDetails')}&id=${videoIds.map((id) => encodeURIComponent(id)).join(',')}`,
      method: 'GET',
      headers: authHeaders(bearer),
      body: null,
    });
    if (!answer.ok) return answer;
    const list = answer.parsed as { items?: unknown };
    const items = Array.isArray(list?.items) ? (list.items as unknown[]) : [];
    const signals: SocialRestrictionSignal[] = [];
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue;
      const video = item as VideoResource;
      if (typeof video.id !== 'string') continue;
      const uploadStatus = typeof video.status?.uploadStatus === 'string' ? video.status.uploadStatus : null;
      // ONLY the provider-exposed restriction facts (§11 — hidden
      // moderation state is never invented): the documented rejected
      // and failed upload statuses (with the rejectionReason
      // passthrough) and the regionRestriction surface.
      if (uploadStatus === 'rejected' || uploadStatus === 'failed') {
        signals.push({
          signalKind: `video.uploadStatus.${uploadStatus}`,
          observedAt: null,
          description:
            uploadStatus === 'rejected'
              ? `video ${video.id} carries uploadStatus=rejected${typeof video.status?.rejectionReason === 'string' ? ` (rejectionReason: ${video.status.rejectionReason})` : ''}`
              : `video ${video.id} carries uploadStatus=failed`,
          data: {
            videoId: video.id,
            uploadStatus,
            rejectionReason: video.status?.rejectionReason ?? null,
          },
        });
      }
      const regionRestriction = video.contentDetails?.regionRestriction;
      if (regionRestriction !== null && regionRestriction !== undefined) {
        signals.push({
          signalKind: 'video.regionRestriction',
          observedAt: null,
          description: `video ${video.id} carries a contentDetails.regionRestriction`,
          data: {
            videoId: video.id,
            allowed: regionRestriction.allowed ?? null,
            blocked: regionRestriction.blocked ?? null,
          },
        });
      }
    }
    return { ok: true, signals, rateLimit: null };
  }

  // -------------------------------------------------------------------------
  // The publish family (the documented resumable upload lifecycle)
  // -------------------------------------------------------------------------

  /**
   * Maps the normalized publish request onto the documented video
   * resource metadata (snippet + status). The provider owns metadata
   * validation — a documented 400 surfaces as the processed
   * providerFailureReason (never a fabricated adapter-side rejection).
   */
  function videoResourceMetadataOf(input: SocialPublishSubmitInput): Readonly<Record<string, unknown>> {
    const payload = input.request.payload as Readonly<Record<string, unknown>>;
    const snippet: Record<string, unknown> = {};
    if (typeof payload['title'] === 'string') snippet['title'] = payload['title'];
    if (typeof payload['description'] === 'string') snippet['description'] = payload['description'];
    if (Array.isArray(payload['tags'])) snippet['tags'] = payload['tags'];
    if (typeof payload['categoryId'] === 'string') snippet['categoryId'] = payload['categoryId'];
    const status: Record<string, unknown> = {
      privacyStatus: typeof payload['privacyStatus'] === 'string' ? payload['privacyStatus'] : 'public',
      selfDeclaredMadeForKids: payload['selfDeclaredMadeForKids'] === true,
    };
    if (input.request.scheduledFor !== null) status['publishAt'] = input.request.scheduledFor;
    return { snippet, status };
  }

  async function submitPublish(
    context: SocialAdapterCallContext,
    input: SocialPublishSubmitInput,
  ): Promise<SocialPublishSubmitResult> {
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('submitPublish (videos.insert)');
    const bases = resolveBases(context.providerConfig);
    const metadata = videoResourceMetadataOf(input);
    const uploadContentType =
      input.request.mediaAssets.find((asset) => typeof asset.descriptor['mime'] === 'string')?.descriptor['mime'] ??
      'application/octet-stream';
    // The documented resumable-upload INITIATION: the metadata resource
    // POST (uploadType=resumable, part=snippet,status) — the response's
    // Location header carries the session URI (upload_id). The
    // media-byte transfer (the PUT of asset bytes to the session URI)
    // awaits the content-asset resolution wiring (the frozen
    // /social-accounts matrix row carries no /content-assets
    // direction) — DISCLOSED in docs/runbooks/MKT-057.md.
    const initiation = await callProviderRaw('submitPublish (videos.insert initiation)', {
      url: `${bases.dataApi}/upload/youtube/v3/videos?${new URLSearchParams({
        uploadType: 'resumable',
        part: 'snippet,status',
      }).toString()}`,
      method: 'POST',
      headers: {
        ...authHeaders(bearer),
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': String(uploadContentType),
      },
      body: JSON.stringify(metadata),
    });
    if (!initiation.ok) {
      // A documented 400 on the initiation (invalidVideoMetadata /
      // invalidTitle / badRequest — the provider validated and refused
      // the metadata): the honest 'restricted' DATA failure with the
      // verbatim envelope (the classifier's disclosed 4xx mapping —
      // see the file header). The frozen migration-050 CHECK (failed
      // ⇒ failure_code NOT NULL) forbids the null-code processed-
      // rejection row on the ATTEMPT ledger — the provider's own
      // reason rides the failure message; the ASYNC post-processing
      // rejection (the session probe's uploadStatus failed/rejected)
      // remains the providerFailureReason carrier where the frozen
      // OBSERVATION table allows the null code.
      return initiation;
    }
    // The session URI: the documented Location header of the initiation.
    const location = initiation.response.headers['location'] ?? initiation.response.headers['Location'] ?? null;
    const uploadId =
      location !== null && location !== '' ? new URL(location).searchParams.get('upload_id') : null;
    if (uploadId === null || uploadId === '') {
      return failureOf(
        'provider-unavailable',
        'the YouTube videos.insert initiation answered without the documented upload session reference (Location/upload_id)',
      );
    }
    return {
      ok: true,
      submission: {
        // The born upload session: the video is NOT yet processed — the
        // honest 'accepted' (async) state with the session as the
        // provider publish identity and NO content id yet.
        publishState: 'accepted',
        providerPublishId: uploadId,
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
    const bearer = bearerOf(context);
    if (bearer === null) return authFailure('getPublishStatus (upload session probe)');
    const bases = resolveBases(context.providerConfig);
    // The documented session status probe: an empty PUT to the session
    // endpoint with Content-Range: bytes */* — 308 Resume Incomplete
    // while the upload/processing is pending, 201 + the completed video
    // resource when done, 404 for an unknown/expired session.
    const probe = await callProviderRaw('getPublishStatus (upload session probe)', {
      url: `${bases.dataApi}/upload/youtube/v3/videos?${new URLSearchParams({
        uploadType: 'resumable',
        upload_id: input.providerPublishId,
      }).toString()}`,
      method: 'PUT',
      headers: { ...authHeaders(bearer), 'content-range': 'bytes */*' },
      body: null,
    });
    if (!probe.ok) {
      // The documented 404 of an unknown/expired session: the honest
      // provider-unavailable (the provider reports no such publish).
      if (probe.failure.code === 'restricted' && probe.failure.message.includes('HTTP 404')) {
        return failureOf(
          'provider-unavailable',
          `the YouTube upload session '${input.providerPublishId}' no longer resolves (the provider reports no such publish)`,
        );
      }
      return probe;
    }
    if (probe.response.status === 308) {
      // Resume Incomplete: the upload/processing is still pending — the
      // honest still-processing answer.
      return {
        ok: true,
        status: {
          publishState: 'accepted',
          providerPublishId: input.providerPublishId,
          providerContentId: null,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [],
          providerData: null,
        },
        rateLimit: null,
      };
    }
    // The completed session: 201 + the video resource.
    let video: VideoResource;
    try {
      video = JSON.parse(probe.response.body) as VideoResource;
    } catch {
      return failureOf(
        'provider-unavailable',
        'the YouTube upload session completion answer was not the documented video resource body',
      );
    }
    if (typeof video.id !== 'string' || video.id === '') {
      return failureOf('provider-unavailable', 'the YouTube upload session completion answer carried no video id');
    }
    const uploadStatus = typeof video.status?.uploadStatus === 'string' ? video.status.uploadStatus : 'processed';
    if (uploadStatus === 'rejected') {
      const rejectionReason =
        typeof video.status?.rejectionReason === 'string' ? video.status.rejectionReason : null;
      return {
        ok: true,
        status: {
          publishState: 'restricted',
          providerPublishId: input.providerPublishId,
          providerContentId: video.id,
          publishedAt: null,
          providerFailureReason: null,
          restrictionSignals: [
            {
              signalKind: 'video.uploadStatus.rejected',
              observedAt: null,
              description: `video ${video.id} carries uploadStatus=rejected${rejectionReason !== null ? ` (rejectionReason: ${rejectionReason})` : ''}`,
              data: { videoId: video.id, uploadStatus, rejectionReason },
            },
          ],
          providerData: video as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }
    if (uploadStatus === 'failed') {
      return {
        ok: true,
        status: {
          publishState: 'failed',
          providerPublishId: input.providerPublishId,
          providerContentId: video.id,
          publishedAt: null,
          providerFailureReason: 'uploadStatus=failed (the provider reports the upload failed)',
          restrictionSignals: [],
          providerData: video as unknown as Readonly<Record<string, unknown>>,
        },
        rateLimit: null,
      };
    }
    // processed (or uploaded→processed): the video is live.
    return {
      ok: true,
      status: {
        publishState: 'published',
        providerPublishId: input.providerPublishId,
        providerContentId: video.id,
        publishedAt: typeof video.snippet?.publishedAt === 'string' ? video.snippet.publishedAt : null,
        providerFailureReason: null,
        restrictionSignals: [],
        providerData: video as unknown as Readonly<Record<string, unknown>>,
      },
      rateLimit: null,
    };
  }

  return {
    descriptor: { ...YOUTUBE_SOCIAL_ADAPTER_DESCRIPTOR },
    capabilities: youTubeSocialAdapterCapabilities(),
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
