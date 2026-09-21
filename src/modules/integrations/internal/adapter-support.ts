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
  NormalizedProviderEvent,
  NormalizedProviderRecord,
  NormalizedRateLimit,
  WebhookDeliveryInput,
  WebhookVerificationResult,
} from '../public.ts';
import { COMMERCE_EVENT_SHAPE_VERSION } from '../public.ts';

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

// ---------------------------------------------------------------------------
// The MKT-071 commerce provider JSON convention (shared, provider-neutral)
// ---------------------------------------------------------------------------
//
// The two first-party commerce connectors (the read-only commerce/CMS
// connector and the full commerce-store connector) talk to providers that
// share ONE commerce JSON convention: paged catalog/order listings with
// opaque cursor tokens, product/price/inventory reads, product/listing
// mutation results and identified webhook deliveries. The PURE mappers
// below normalize that convention into the source-record envelopes of the
// module contract (recordType 'commerce.*'); provider endpoints, request
// building and egress stay exclusively in the adapter subtrees.
//
// INVARIANTS: mapping failures are DATA ({ok:false + bounded error}),
// never throws; required identity (ids) and numeric fields fail closed;
// the provider's attribution/reference fields are carried VERBATIM as
// passthrough data (architecture §16 — no linking, matching or causal
// computation anywhere here).

/** The mapping outcome: normalized records as data, never a throw. */
export interface CommerceMappingResult {
  readonly ok: boolean;
  readonly records: readonly NormalizedProviderRecord[];
  readonly error: string | null;
}

/** The mutation-mapping outcome (one provider record, never a throw). */
export interface CommerceMutationMappingResult {
  readonly ok: boolean;
  readonly providerRecordId: string | null;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
}

function mappingFailure(error: string): CommerceMappingResult {
  return { ok: false, records: [], error };
}

/** Required non-empty string id (bounded) or a fail-closed error. */
function requireId(value: unknown, label: string): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
    return null;
  }
  void label;
  return value;
}

/** Optional bounded string (null when absent/malformed). */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 256 ? value : null;
}

/** Required finite number or null (fail-closed signal). */
function requireNumber(value: unknown): number | null {
  return parseNumberOrNull(value);
}

/**
 * The bounded paging-cursor query of a paged commerce read (pure): the
 * caller's { cursor } and { limit } parameters become '?cursor=&limit='
 * (bounded, encoded) or '' when absent. Anything malformed is ignored
 * (bounded defaults server-side at the provider).
 */
export function commerceReadQuery(parameters: Readonly<Record<string, unknown>>): string {
  const cursor =
    typeof parameters['cursor'] === 'string' && parameters['cursor'].trim() !== '' && parameters['cursor'].length <= 256
      ? encodeURIComponent(parameters['cursor'])
      : null;
  const rawLimit = parseNumberOrNull(parameters['limit']);
  const limit = rawLimit !== null && Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 250 ? rawLimit : null;
  if (cursor === null && limit === null) return '';
  const parts: string[] = [];
  if (cursor !== null) parts.push(`cursor=${cursor}`);
  if (limit !== null) parts.push(`limit=${limit}`);
  return `?${parts.join('&')}`;
}

/**
 * The bounded record-id parameter of a targeted commerce read (pure):
 * { productId } / { listingId } — a non-empty bounded string or null
 * (fail-closed signal: the adapter refuses the call without a valid id).
 */
export function commerceIdParameter(
  parameters: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = parameters[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256) {
    return null;
  }
  return value;
}

/**
 * The fail-closed data outcome of a targeted commerce read whose bounded
 * record-id parameter is missing/malformed (the adapter refuses the call
 * BEFORE any provider traffic — never a free-form URL).
 */
export function commerceReadParameterFailure(
  operation: string,
  key: string,
): { ok: false; records: never[]; error: string; rateLimit: null } {
  return {
    ok: false,
    records: [],
    error: `${operation} requires a bounded '${key}' parameter`,
    rateLimit: null,
  };
}

/**
 * Pure mapping: a commerce orders response → metric-observation
 * envelopes (order totals as revenue observations — the MKT-024
 * commerce-orders-read continuity, now part of the SHARED commerce
 * provider JSON convention both commerce connectors speak). Required
 * identity: order id; the total must be numeric when present and the
 * currency a non-empty string (fail closed otherwise); updatedAt maps to
 * the source timestamp.
 */
export function mapCommerceOrdersResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const rows = asArray(payload['orders']);
  if (rows === null) {
    return mappingFailure("malformed commerce payload: 'orders' is not an array");
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return mappingFailure(`malformed commerce payload: orders[${index}] is not an object`);
    }
    const id = row['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      return mappingFailure(`malformed commerce payload: orders[${index}].id is missing`);
    }
    const currency = row['currency'];
    if (typeof currency !== 'string' || currency.trim() === '') {
      return mappingFailure(`malformed commerce payload: orders[${index}].currency is missing`);
    }
    const total = parseNumberOrNull(row['total']);
    if (total === null) {
      return mappingFailure(`malformed commerce payload: orders[${index}].total is not a number`);
    }
    const dimensions: Record<string, string> = { orderId: id };
    if (typeof row['number'] === 'string') dimensions['orderNumber'] = row['number'] as string;
    if (typeof row['status'] === 'string') dimensions['orderStatus'] = row['status'] as string;
    records.push({
      providerRecordId: `commerce:order:${id}:revenue`,
      data: metricEnvelope({
        metricName: 'commerce.revenue',
        dimensions,
        value: total,
        unit: currency,
        aggregationMethod: 'sum',
      }) as unknown as Record<string, unknown>,
      sourceTimestamp: isoTimestampOrNull(row['updatedAt'] ?? row['updated_at']),
      etag,
      sourceVersion: null,
    });
  }
  return { ok: true, records, error: null };
}

/**
 * Pure mapping: a paged commerce catalog response → the normalized
 * catalog-page envelope (AC-1: catalog read — paged, category/product
 * shape). ONE record per page: providerRecordId
 * 'commerce:catalog:page:<cursor-or-first>'; nextPageCursor rides the
 * fields so paged callers walk the catalog with { cursor } parameters.
 */
export function mapCommerceCatalogPageResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const rawCategories = asArray(payload['categories']);
  if (rawCategories === null) {
    return mappingFailure("malformed commerce catalog payload: 'categories' is not an array");
  }
  const rawProducts = asArray(payload['products']);
  if (rawProducts === null) {
    return mappingFailure("malformed commerce catalog payload: 'products' is not an array");
  }
  const categories: { categoryId: string; title: string }[] = [];
  for (const [index, entry] of rawCategories.entries()) {
    const row = asObject(entry);
    const id = row === null ? null : requireId(row['id'], 'category id');
    const title = row === null ? null : optionalString(row['title']);
    if (id === null || title === null) {
      return mappingFailure(`malformed commerce catalog payload: categories[${index}] is missing id/title`);
    }
    categories.push({ categoryId: id, title });
  }
  const products: { productId: string; title: string; categoryId: string | null; status: string }[] = [];
  for (const [index, entry] of rawProducts.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return mappingFailure(`malformed commerce catalog payload: products[${index}] is not an object`);
    }
    const id = requireId(row['id'], 'product id');
    const title = optionalString(row['title']);
    const status = optionalString(row['status']);
    if (id === null || title === null || status === null) {
      return mappingFailure(`malformed commerce catalog payload: products[${index}] is missing id/title/status`);
    }
    products.push({
      productId: id,
      title,
      categoryId: optionalString(row['categoryId']),
      status,
    });
  }
  const nextPageCursor = optionalString(payload['nextPageCursor']);
  return {
    ok: true,
    error: null,
    records: [
      {
        providerRecordId: `commerce:catalog:page:${nextPageCursor === null ? 'first' : nextPageCursor}`,
        data: sourceRecordEnvelope('commerce.catalog-page', {
          categories,
          products,
          nextPageCursor,
        }) as unknown as Record<string, unknown>,
        sourceTimestamp: null,
        etag,
        sourceVersion: null,
      },
    ],
  };
}

/**
 * Pure mapping: a commerce product response → the normalized product
 * envelope (AC-1: product read). Required identity: id; the provider's
 * custom `attributes` object rides VERBATIM (passthrough).
 */
export function mapCommerceProductResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const id = requireId(payload['id'], 'product id');
  const title = optionalString(payload['title']);
  const status = optionalString(payload['status']);
  if (id === null || title === null || status === null) {
    return mappingFailure('malformed commerce product payload: id/title/status are required');
  }
  const rawAttributes = payload['attributes'];
  const attributes =
    rawAttributes !== undefined && rawAttributes !== null
      ? asObject(rawAttributes)
      : {};
  if (attributes === null) {
    return mappingFailure('malformed commerce product payload: attributes is not an object');
  }
  return {
    ok: true,
    error: null,
    records: [
      {
        providerRecordId: `commerce:product:${id}`,
        data: sourceRecordEnvelope('commerce.product', {
          productId: id,
          title,
          description: optionalString(payload['description']),
          status,
          categoryId: optionalString(payload['categoryId']),
          attributes,
        }) as unknown as Record<string, unknown>,
        sourceTimestamp: isoTimestampOrNull(payload['updatedAt'] ?? payload['updated_at']),
        etag,
        sourceVersion: null,
      },
    ],
  };
}

/**
 * Pure mapping: a commerce price response → the normalized price
 * envelope (AC-1: price read). Required: productId, a finite amount and
 * a non-empty currency.
 */
export function mapCommercePriceResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const productId = requireId(payload['productId'] ?? payload['product_id'], 'product id');
  if (productId === null) {
    return mappingFailure('malformed commerce price payload: productId is required');
  }
  const amount = requireNumber(payload['amount']);
  if (amount === null) {
    return mappingFailure('malformed commerce price payload: amount is not a number');
  }
  const currency = optionalString(payload['currency']);
  if (currency === null) {
    return mappingFailure('malformed commerce price payload: currency is required');
  }
  return {
    ok: true,
    error: null,
    records: [
      {
        providerRecordId: `commerce:price:${productId}`,
        data: sourceRecordEnvelope('commerce.price', {
          productId,
          priceId: optionalString(payload['priceId'] ?? payload['price_id']),
          amount,
          currency,
        }) as unknown as Record<string, unknown>,
        sourceTimestamp: isoTimestampOrNull(payload['updatedAt'] ?? payload['updated_at']),
        etag,
        sourceVersion: null,
      },
    ],
  };
}

/**
 * Pure mapping: a commerce inventory response → the normalized inventory
 * envelope (AC-1: inventory read). Required: productId, a finite
 * available count.
 */
export function mapCommerceInventoryResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const productId = requireId(payload['productId'] ?? payload['product_id'], 'product id');
  if (productId === null) {
    return mappingFailure('malformed commerce inventory payload: productId is required');
  }
  const available = requireNumber(payload['available']);
  if (available === null) {
    return mappingFailure('malformed commerce inventory payload: available is not a number');
  }
  const rawTotal = payload['total'];
  return {
    ok: true,
    error: null,
    records: [
      {
        providerRecordId: `commerce:inventory:${productId}`,
        data: sourceRecordEnvelope('commerce.inventory', {
          productId,
          available,
          total: rawTotal === undefined || rawTotal === null ? null : requireNumber(rawTotal),
          updatedAt: isoTimestampOrNull(payload['updatedAt'] ?? payload['updated_at']),
        }) as unknown as Record<string, unknown>,
        sourceTimestamp: isoTimestampOrNull(payload['updatedAt'] ?? payload['updated_at']),
        etag,
        sourceVersion: null,
      },
    ],
  };
}

/**
 * Pure mapping: a paged commerce order-records response → normalized
 * order envelopes (AC-1: order read — paged, LINE-ITEM shape; AC-5:
 * attribution passthrough VERBATIM). ONE record per order:
 * 'commerce:order-record:<id>'.
 */
export function mapCommerceOrderRecordsResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const rows = asArray(payload['orders']);
  if (rows === null) {
    return mappingFailure("malformed commerce order-records payload: 'orders' is not an array");
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return mappingFailure(`malformed commerce order-records payload: orders[${index}] is not an object`);
    }
    const id = requireId(row['id'], 'order id');
    if (id === null) {
      return mappingFailure(`malformed commerce order-records payload: orders[${index}].id is missing`);
    }
    const status = optionalString(row['status']);
    const currency = optionalString(row['currency']);
    if (status === null || currency === null) {
      return mappingFailure(`malformed commerce order-records payload: orders[${index}] is missing status/currency`);
    }
    const total = requireNumber(row['total']);
    if (total === null) {
      return mappingFailure(`malformed commerce order-records payload: orders[${index}].total is not a number`);
    }
    const rawLineItems = asArray(row['lineItems'] ?? row['line_items']);
    if (rawLineItems === null) {
      return mappingFailure(`malformed commerce order-records payload: orders[${index}].lineItems is not an array`);
    }
    const lineItems: {
      lineItemId: string;
      productId: string | null;
      title: string;
      quantity: number;
      unitPrice: number;
    }[] = [];
    for (const [lineIndex, lineEntry] of rawLineItems.entries()) {
      const line = asObject(lineEntry);
      if (line === null) {
        return mappingFailure(
          `malformed commerce order-records payload: orders[${index}].lineItems[${lineIndex}] is not an object`,
        );
      }
      const lineId = requireId(line['id'], 'line item id');
      const title = optionalString(line['title']);
      const quantity = requireNumber(line['quantity']);
      const unitPrice = requireNumber(line['unitPrice'] ?? line['unit_price']);
      if (lineId === null || title === null || quantity === null || unitPrice === null) {
        return mappingFailure(
          `malformed commerce order-records payload: orders[${index}].lineItems[${lineIndex}] is missing id/title/quantity/unitPrice`,
        );
      }
      lineItems.push({
        lineItemId: lineId,
        productId: optionalString(line['productId'] ?? line['product_id']),
        title,
        quantity,
        unitPrice,
      });
    }
    // AC-5: the provider's attribution/reference fields ride VERBATIM as
    // passthrough data — no linking, matching or causal computation.
    const rawAttribution = row['attribution'];
    const attribution =
      rawAttribution === undefined || rawAttribution === null ? null : asObject(rawAttribution);
    if (rawAttribution !== undefined && rawAttribution !== null && attribution === null) {
      return mappingFailure(`malformed commerce order-records payload: orders[${index}].attribution is not an object`);
    }
    records.push({
      providerRecordId: `commerce:order-record:${id}`,
      data: sourceRecordEnvelope('commerce.order', {
        orderId: id,
        orderNumber: optionalString(row['number']),
        status,
        currency,
        total,
        placedAt: isoTimestampOrNull(row['placedAt'] ?? row['placed_at']),
        lineItems,
        attribution,
        nextPageCursor: null,
      }) as unknown as Record<string, unknown>,
      sourceTimestamp: isoTimestampOrNull(row['updatedAt'] ?? row['updated_at']),
      etag,
      sourceVersion: null,
    });
  }
  // The page cursor rides every record of the page (the paged read shape).
  const nextPageCursor = optionalString(payload['nextPageCursor']);
  if (nextPageCursor !== null && records.length > 0) {
    return {
      ok: true,
      error: null,
      records: records.map((record) => ({
        ...record,
        data: {
          ...(record.data as Record<string, unknown>),
          fields: {
            ...((record.data as { fields: Record<string, unknown> }).fields),
            nextPageCursor,
          },
        },
      })),
    };
  }
  return { ok: true, error: null, records };
}

/**
 * Pure mapping: a commerce mutation response → the normalized mutation
 * outcome data (AC-1: product write / listing management where
 * authorized). Required identity: id.
 */
export function mapCommerceMutationResponse(
  payload: Readonly<Record<string, unknown>>,
): CommerceMutationMappingResult {
  const id = requireId(payload['id'], 'provider record id');
  if (id === null) {
    return {
      ok: false,
      providerRecordId: null,
      data: null,
      error: 'malformed commerce mutation payload: id is missing',
    };
  }
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && value !== undefined) fields[key] = value;
  }
  return { ok: true, providerRecordId: id, data: fields, error: null };
}

/**
 * Pure builder: the NORMALIZED PROVIDER EVENT of an identified commerce
 * webhook delivery (MKT-071 webhook idempotency + attribution
 * passthrough). The provider's event identity (`eventId`/`event_id` of
 * the payload) is the dedup fence key half; the event kind derives from
 * the delivered event type family (order.* / product.* / listing.*);
 * the provider's attribution/reference fields ride VERBATIM. Returns
 * NULL when the payload carries no provider event identity (the legacy
 * unidentified path — no fence, no projection).
 */
export function buildNormalizedCommerceEvent(
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): NormalizedProviderEvent | null {
  const providerEventId = optionalString(payload['eventId'] ?? payload['event_id']);
  if (providerEventId === null) {
    return null;
  }
  let eventKind: 'order' | 'product' | 'listing';
  if (eventType.startsWith('order.')) {
    eventKind = 'order';
  } else if (eventType.startsWith('product.')) {
    eventKind = 'product';
  } else if (eventType.startsWith('listing.')) {
    eventKind = 'listing';
  } else {
    return null;
  }
  const providerRecordId =
    optionalString(payload['orderId'] ?? payload['order_id']) ??
    optionalString(payload['productId'] ?? payload['product_id']) ??
    optionalString(payload['listingId'] ?? payload['listing_id']);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && value !== undefined) normalized[key] = value;
  }
  return {
    providerEventId,
    eventKind,
    providerRecordId,
    shapeVersion: COMMERCE_EVENT_SHAPE_VERSION,
    normalized,
  };
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
