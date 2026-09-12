/**
 * Shared support helpers for the MKT-024 FIRST-PARTY CONNECTOR adapters
 * (Meta, Google Ads, generic analytics, CRM, commerce/CMS — INT-001).
 *
 * This file lives under internal/ (NOT under internal/adapters/) on
 * purpose: the static architecture checker forbids any file under an
 * 'adapters' path segment from importing another file under an 'adapters'
 * path segment (ADAPTER_COUPLING), while adapter implementations are only
 * importable by the composition root. Placing the SHARED, provider-neutral
 * helpers here lets every first-party adapter import them without any
 * adapter→adapter edge; provider-SPECIFIC knowledge still lives only in
 * the connector subtrees under internal/adapters/<provider>/.
 *
 * Everything in this file is provider-neutral plumbing:
 *   - the credential-material interpretation convention (opaque provider
 *     JSON — the ADAPTER owns the shape; the platform never inspects it);
 *   - normalized rate-limit/backoff header parsing (§20 metadata);
 *   - the HMAC-SHA256 webhook authenticity verification primitive
 *     (provider specifics = header name + normalized event type);
 *   - a bounded JSON-over-HttpCallPort call helper (the adapters use the
 *     platform HttpCallPort for egress — NO provider SDK anywhere);
 *   - the normalized observation ENVELOPE builders the connectors emit as
 *     NormalizedProviderRecord.data. The envelopes are the cross-boundary
 *     contract consumed by the server-side observation delivery in
 *     src/api/integration-observations.ts (validated there at runtime —
 *     the two sides are deliberately decoupled; source-mapping tests prove
 *     the exact shapes).
 *
 * INVARIANTS (MKT-023 boundary, frozen):
 *   - adapters NEVER throw for invocation-level outcomes — these helpers
 *     return failures as data ({ok:false + error});
 *   - credential material exists ONLY in-process inside the adapter call
 *     context (§21) — nothing here ever logs, persists or returns it;
 *   - secret material never appears in envelopes, records or errors.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HttpCallPort, HttpCallRequest, HttpCallResponse } from '../../../platform/http/outbound.ts';
import type {
  AdapterProbeResult,
  NormalizedRateLimit,
  WebhookDeliveryInput,
  WebhookVerificationResult,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Credential-material interpretation (§21 — opaque bytes, adapter-owned shape)
// ---------------------------------------------------------------------------

/**
 * The provider credential interpretation convention shared by the
 * first-party connectors: the credential MATERIAL (resolved in-process by
 * the /integrations module through the /credentials authorized-execution
 * path after a fail-closed policy allow) is an opaque JSON document whose
 * fields the ADAPTER defines. Providers differ; the platform never inspects
 * the bytes, and nothing secret is ever logged or persisted.
 */
export interface ProviderCredentialShape {
  readonly accessToken: string | null;
  readonly webhookSecret: string | null;
}

/**
 * Parses the credential material as the shared provider JSON shape.
 * Returns null when the material is absent or not the expected shape —
 * the adapter then fails closed as data ({ok:false + error}), never by
 * throwing. Material is never included in the error string.
 */
export function parseProviderCredential(material: Uint8Array | null): ProviderCredentialShape | null {
  if (material === null || material.byteLength === 0) return null;
  let text: string;
  try {
    text = new TextDecoder().decode(material);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const accessToken = typeof record['accessToken'] === 'string' ? (record['accessToken'] as string) : null;
  const webhookSecret = typeof record['webhookSecret'] === 'string' ? (record['webhookSecret'] as string) : null;
  if (accessToken === null && webhookSecret === null) return null;
  return { accessToken, webhookSecret };
}

// ---------------------------------------------------------------------------
// Rate-limit / backoff metadata (implementation-contract §20)
// ---------------------------------------------------------------------------

/**
 * Parses the normalized rate-limit/backoff state from provider response
 * headers. Providers differ; the shared convention covers the common
 * header spellings:
 *   - x-ratelimit-remaining → limitRemaining (number);
 *   - x-ratelimit-reset     → limitResetAt (epoch seconds → ISO);
 *   - retry-after           → retryAfterSeconds (seconds; HTTP 429/503);
 *   - x-backoff-until       → backoffUntil (ISO timestamp).
 * Returns null when no header of the contract is present (the module keeps
 * the previously observed state).
 */
export function parseRateLimitHeaders(headers: Readonly<Record<string, string>>): NormalizedRateLimit | null {
  const remaining = parseNumberOrNull(headers['x-ratelimit-remaining'] ?? headers['x-app-usage-remaining']);
  const resetEpoch = parseNumberOrNull(headers['x-ratelimit-reset']);
  const retryAfter = parseNumberOrNull(headers['retry-after']);
  const backoffUntil = headers['x-backoff-until'] ?? null;
  if (remaining === null && resetEpoch === null && retryAfter === null && backoffUntil === null) {
    return null;
  }
  return {
    limitRemaining: remaining,
    limitResetAt:
      resetEpoch !== null && Number.isFinite(resetEpoch) && resetEpoch > 0
        ? new Date(resetEpoch * 1000).toISOString()
        : null,
    backoffUntil: backoffUntil !== null && backoffUntil.trim() !== '' ? backoffUntil : null,
    retryAfterSeconds: retryAfter,
  };
}

// ---------------------------------------------------------------------------
// Webhook authenticity verification primitive (append-oriented ingestion)
// ---------------------------------------------------------------------------

/**
 * Verifies one inbound webhook delivery with the HMAC-SHA256 convention
 * shared by the first-party connectors: the signature header carries
 * `sha256=<hex>` (Meta X-Hub-Signature-256 spelling) or bare `<hex>`, the
 * MAC being HMAC-SHA256(webhookSecret, JSON.stringify(payload)) over the
 * delivered payload object. Comparison is timing-safe. The secret is the
 * connection's credential material field — resolved in-process only, never
 * returned in the verdict.
 */
export function verifyHmacWebhookDelivery(
  delivery: WebhookDeliveryInput,
  secret: string,
  headerName: string,
  normalizedEventType: string,
): WebhookVerificationResult {
  const signature = delivery.headers[headerName] ?? delivery.headers[headerName.toLowerCase()] ?? null;
  if (signature === null || signature.trim() === '') {
    return {
      verified: false,
      reason: `missing signature header '${headerName}'`,
      normalizedEventType: null,
    };
  }
  const expected = createHmac('sha256', secret).update(JSON.stringify(delivery.payload)).digest();
  let provided: Buffer;
  try {
    const hex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
    provided = Buffer.from(hex.trim(), 'hex');
  } catch {
    return { verified: false, reason: 'signature header is not valid hex', normalizedEventType: null };
  }
  if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) {
    return { verified: false, reason: 'HMAC signature mismatch', normalizedEventType: null };
  }
  return { verified: true, reason: null, normalizedEventType };
}

// ---------------------------------------------------------------------------
// Bounded JSON egress through the platform HttpCallPort (NO provider SDK)
// ---------------------------------------------------------------------------

/** The never-throw outcome of one provider HTTP call. */
export interface ProviderHttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
  readonly timedOut: boolean;
  readonly transportRefused: boolean;
}

/**
 * Performs one bounded JSON provider call through the platform HttpCallPort.
 * Transport refusals, timeouts, non-2xx statuses and non-JSON bodies are
 * returned as DATA ({ok:false + bounded error string}); this helper throws
 * only on an invalid request envelope (asserted by the port contract) which
 * the caller maps to a data failure. Bounded response bodies (the port's
 * sizeCapBytes) keep the adapter fail-closed.
 */
export async function callProviderJson(http: HttpCallPort, request: HttpCallRequest): Promise<ProviderHttpResult> {
  let response: HttpCallResponse;
  try {
    response = await http.request(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      headers: {},
      body: null,
      error: `provider call refused: ${reason.slice(0, 200)}`,
      timedOut: false,
      transportRefused: true,
    };
  }
  if (response.transportRefused) {
    return {
      ok: false,
      status: response.status,
      headers: response.headers,
      body: null,
      error: 'provider unreachable (transport refused before the request was processed)',
      timedOut: false,
      transportRefused: true,
    };
  }
  if (response.timedOut) {
    return {
      ok: false,
      status: response.status,
      headers: response.headers,
      body: null,
      error: 'provider call timed out before a response was received',
      timedOut: true,
      transportRefused: false,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      status: response.status,
      headers: response.headers,
      body: null,
      error: `provider error: HTTP ${response.status} ${response.body.slice(0, 200)}`,
      timedOut: false,
      transportRefused: false,
    };
  }
  if (response.body.trim() === '') {
    return {
      ok: false,
      status: response.status,
      headers: response.headers,
      body: null,
      error: 'provider returned an empty body',
      timedOut: false,
      transportRefused: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return {
      ok: false,
      status: response.status,
      headers: response.headers,
      body: null,
      error: `provider returned a non-JSON body: ${response.body.slice(0, 200)}`,
      timedOut: false,
      transportRefused: false,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      status: response.status,
      headers: response.headers,
      body: null,
      error: 'provider JSON body is not an object',
      timedOut: false,
      transportRefused: false,
    };
  }
  return {
    ok: true,
    status: response.status,
    headers: response.headers,
    body: parsed as Record<string, unknown>,
    error: null,
    timedOut: false,
    transportRefused: false,
  };
}

// ---------------------------------------------------------------------------
// The normalized observation ENVELOPES connectors emit as record.data
// ---------------------------------------------------------------------------

/**
 * The data-quality posture vocabulary mirrored from the /metrics contract
 * (METRIC-001). The closed set is the metric module's frozen taxonomy; the
 * delivery surface validates it again at runtime.
 */
export type ProviderObservationQuality = 'ok' | 'partial' | 'estimated' | 'restated' | 'suspect';

/** The metric-observation envelope: one measured value of one series. */
export interface ProviderMetricEnvelope {
  readonly kind: 'metric';
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string | number | boolean>>;
  readonly value: number;
  readonly unit: string;
  readonly quality: ProviderObservationQuality;
  readonly aggregationMethod: string | null;
}

/** The source-record envelope: a non-metric provider record (evidence-only). */
export interface ProviderSourceRecordEnvelope {
  readonly kind: 'record';
  readonly recordType: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Builds one metric-observation envelope (dimensions are scalar-valued). */
export function metricEnvelope(input: {
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string | number | boolean>>;
  readonly value: number;
  readonly unit: string;
  readonly quality?: ProviderObservationQuality;
  readonly aggregationMethod?: string | null;
}): ProviderMetricEnvelope {
  return {
    kind: 'metric',
    metricName: input.metricName,
    dimensions: input.dimensions,
    value: input.value,
    unit: input.unit,
    quality: input.quality ?? 'ok',
    aggregationMethod: input.aggregationMethod ?? null,
  };
}

/** Builds one source-record envelope (provider record fields, non-secret). */
export function sourceRecordEnvelope(
  recordType: string,
  fields: Readonly<Record<string, unknown>>,
): ProviderSourceRecordEnvelope {
  return { kind: 'record', recordType, fields };
}

// ---------------------------------------------------------------------------
// Small shared parsing utilities (pure, provider-neutral)
// ---------------------------------------------------------------------------

/** Safe object cast (null for non-objects/arrays). */
export function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Safe array cast. */
export function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

/** Finite number or null (accepts numeric strings — many providers stringify). */
export function parseNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** '2026-01-15' → '2026-01-15T00:00:00.000Z' (null when not a plain date). */
export function isoDateAtMidnightUtc(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match === null) return null;
  const date = new Date(`${match[1]!}-${match[2]!}-${match[3]!}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** '20260301' (GA4 compact date) → '2026-03-01T00:00:00.000Z' (or null). */
export function compactDateToIsoUtc(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match === null) return null;
  return isoDateAtMidnightUtc(`${match[1]!}-${match[2]!}-${match[3]!}`);
}

/** Passes through a provider ISO timestamp (bounded length, validated downstream). */
export function isoTimestampOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 64) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The connect-probe outcome shared by the connectors: a 2xx probe endpoint
 * is healthy; a 401/403 is REACHABLE but degraded (credential shape); any
 * other failure is unreachable.
 */
export function probeFromHttpResult(
  result: ProviderHttpResult,
  providerLabel: string,
): AdapterProbeResult {
  if (result.ok) {
    return { reachable: true, healthy: true, message: null, rateLimit: parseRateLimitHeaders(result.headers) };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      reachable: true,
      healthy: false,
      message: `${providerLabel} probe reached the provider but rejected the credential (HTTP ${result.status})`,
      rateLimit: parseRateLimitHeaders(result.headers),
    };
  }
  return {
    reachable: false,
    healthy: false,
    message: result.error ?? `${providerLabel} probe failed`,
    rateLimit: parseRateLimitHeaders(result.headers),
  };
}
