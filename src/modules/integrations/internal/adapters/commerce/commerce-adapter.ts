/**
 * Commerce/CMS first-party connector — MKT-024 (INT-001) + MKT-071 (the
 * Commerce Catalog and Order Capabilities: spec/architecture-v1.6.md §15 —
 * "The existing Integration boundary becomes capable of commerce operations
 * required by v1.6: catalog read, product read/write where authorized,
 * product listing, price/inventory read, order read, order webhook and
 * attribution data").
 *
 * One adapter subtree under internal/adapters/commerce/: this file owns
 * all commerce/CMS-specific knowledge behind the generic IntegrationAdapter
 * port. Wired ONLY at the composition root; no domain module imports it.
 * Egress uses the platform HttpCallPort — NO commerce/CMS SDK anywhere.
 *
 * providerConfig (non-secret): apiBaseUrl (sandbox/loopback override).
 * The credential material (opaque provider JSON — see adapter-support) is
 * resolved by the /integrations module after a fail-closed /policies allow
 * and is sent as an Authorization bearer header, in-process only (§21).
 *
 * THE MKT-071 CAPABILITY SURFACE (each operation declares its capability
 * key; the adapter declares the SUBSET the provider grant includes — a
 * read-only commerce adapter is first-class and the adapter NEVER claims a
 * mutation capability the provider does not grant):
 *
 *   commerce-catalog-read    (read)     listCatalog — paged category/product shape
 *   commerce-product-read    (read)     getProduct — versioned product detail
 *   commerce-product-write   (mutation) upsertProduct — WHERE AUTHORIZED
 *   commerce-listing-manage  (mutation) createListing/updateListing/endListing — WHERE AUTHORIZED
 *   commerce-price-read      (read)     getPrice
 *   commerce-inventory-read  (read)     getInventory
 *   commerce-orders-read     (read)     listOrders (MKT-024 revenue metrics — frozen)
 *                                       listOrderDetails — paged line-item shape + attribution passthrough
 *   commerce-order-webhook   (webhook)  order/product events, deduplicated by
 *                                       (provider, provider event id) — extends
 *                                       the MKT-024 commerce-event-stream capability
 *
 * AUTHORIZATION (two independent layers, both honest data failures):
 *   - the ADAPTER-DECLARED capability subset (construction profile): an
 *     operation outside the declared subset is rejected by the module's
 *     capability-discovery gate BEFORE any provider traffic, and directly
 *     by the adapter as a data error;
 *   - the PROVIDER-GRANTED SCOPES (the credential material's optional
 *     grantedScopes list — the commerce provider convention): an operation
 *     whose required scope is not granted is refused BEFORE any provider
 *     traffic ({ok:false + 'does not grant the scope'} — the invalid-scope
 *     taxonomy), and the provider's own 403 (a token whose scopes were
 *     narrowed provider-side) maps to the same honest taxonomy.
 *
 * ATTRIBUTION IS PASSTHROUGH (architecture-v1.6.md §16): order reads and
 * order/product webhook events carry the provider's attribution/reference
 * fields VERBATIM — recorded, never interpreted (no linking, matching or
 * causal computation: MKT-073 owns that later).
 *
 * INVARIANTS: invocation failures are DATA (ok=false + error), never
 * thrown; malformed provider payloads fail closed as data errors;
 * rate-limit/backoff metadata is surfaced on every outcome (§20); the
 * legacy MKT-024 operations (listOrders metric mapping, listContent,
 * the no-event-id webhook deliveries) behave EXACTLY as before.
 */

import type { HttpCallPort } from '../../../../../platform/http/outbound.ts';
import type {
  AdapterProbeResult,
  IntegrationAdapter,
  IntegrationAdapterCallContext,
  IntegrationCapability,
  NormalizedMutationRequest,
  NormalizedMutationResult,
  NormalizedProviderRecord,
  NormalizedReadRequest,
  NormalizedReadResult,
  WebhookDeliveryInput,
  WebhookVerificationResult,
} from '../../../public.ts';
import {
  commerceCapabilitiesForProfile,
  commerceScopeProblem,
  commerceWebhookEventIdentity,
  mapCommerceCatalogResponse,
  mapCommerceInventoryResponse,
  mapCommerceListingResponse,
  mapCommerceOrderDetailsResponse,
  mapCommercePriceResponse,
  mapCommerceProductResponse,
  normalizeCommerceWebhookEvent,
} from '../../../public.ts';
import {
  asObject,
  callProviderJson,
  isoTimestampOrNull,
  metricEnvelope,
  parseNumberOrNull,
  parseProviderCredential,
  parseRateLimitHeaders,
  probeFromHttpResult,
  sourceRecordEnvelope,
  verifyHmacWebhookDelivery,
  type ProviderHttpResult,
} from '../../adapter-support.ts';

/** The commerce/CMS connector configuration (wired at the composition root). */
export interface CommerceCmsAdapterConfig {
  /** The platform HttpCallPort (fetch-based — no provider SDK). */
  readonly http: HttpCallPort;
  /** Request deadline in milliseconds (default 15000; port cap 60000). */
  readonly timeoutMs?: number;
  /** Response body cap in bytes (default 262144; port cap 1048576). */
  readonly sizeCapBytes?: number;
  /** Production default base URL; sandbox connections override via providerConfig.apiBaseUrl. */
  readonly defaultBaseUrl?: string;
  /**
   * MKT-071: the commerce capability keys the PROVIDER GRANT includes for
   * this adapter instance (the capability-subset declaration — a read-only
   * grant yields a read-only adapter). Omitted → the FULL commerce surface
   * (the production default). Unknown keys fail construction loudly.
   */
  readonly grantedCapabilityKeys?: readonly string[];
}

/** The mapping outcome: normalized records as data, never a throw. */
export type CommerceMappingResult =
  | { readonly ok: true; readonly records: readonly NormalizedProviderRecord[] }
  | { readonly ok: false; readonly error: string };

/**
 * Pure mapping: a commerce orders response → metric-observation envelopes
 * (order totals as revenue observations). Required identity: order id;
 * the total must be numeric when present and the currency a non-empty
 * string (fail closed otherwise); updatedAt maps to the source timestamp.
 * (The frozen MKT-024 listOrders mapping — unchanged.)
 */
export function mapCommerceOrdersResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const rows = Array.isArray(payload['orders']) ? (payload['orders'] as readonly unknown[]) : null;
  if (rows === null) {
    return { ok: false, error: "malformed commerce payload: 'orders' is not an array" };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed commerce payload: orders[${index}] is not an object` };
    }
    const id = row['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: `malformed commerce payload: orders[${index}].id is missing` };
    }
    const currency = row['currency'];
    if (typeof currency !== 'string' || currency.trim() === '') {
      return { ok: false, error: `malformed commerce payload: orders[${index}].currency is missing` };
    }
    const total = parseNumberOrNull(row['total']);
    if (total === null) {
      return { ok: false, error: `malformed commerce payload: orders[${index}].total is not a number` };
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
  return { ok: true, records };
}

/**
 * Pure mapping: a CMS content response → source-record envelopes. Required
 * identity: item id; the item version maps to sourceVersion when numeric
 * or string; publishedAt maps to the source timestamp.
 * (The frozen MKT-024 listContent mapping — unchanged.)
 */
export function mapCmsContentResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const rows = Array.isArray(payload['items']) ? (payload['items'] as readonly unknown[]) : null;
  if (rows === null) {
    return { ok: false, error: "malformed CMS payload: 'items' is not an array" };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed CMS payload: items[${index}] is not an object` };
    }
    const id = row['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: `malformed CMS payload: items[${index}].id is missing` };
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && value !== undefined) fields[key] = value;
    }
    const version = row['version'];
    const sourceVersion =
      typeof version === 'number'
        ? String(version)
        : typeof version === 'string' && version.trim() !== ''
          ? version
          : null;
    records.push({
      providerRecordId: `cms:content:${id}`,
      data: sourceRecordEnvelope('cms.content', fields) as unknown as Record<string, unknown>,
      sourceTimestamp: isoTimestampOrNull(row['publishedAt'] ?? row['published_at']),
      etag,
      sourceVersion,
    });
  }
  return { ok: true, records };
}

/**
 * The honest error-taxonomy labeling of one failed provider call (AC-2):
 * provider-down (transport refused / timed out), unauthorized (401),
 * invalid-scope (403), rate-limited (429) — each surfaced as a labeled
 * data error so the taxonomy is assertable end to end.
 */
function taxonomyError(result: ProviderHttpResult): string {
  if (result.transportRefused || result.timedOut) {
    return `provider-down: ${result.error}`;
  }
  if (result.status === 401) {
    return `unauthorized: ${result.error}`;
  }
  if (result.status === 403) {
    return `invalid-scope: ${result.error}`;
  }
  if (result.status === 429) {
    return `rate-limited: ${result.error}`;
  }
  return result.error ?? 'provider call failed';
}

/** The commerce/CMS first-party adapter. */
export class CommerceCmsAdapter implements IntegrationAdapter {
  readonly descriptor = {
    adapterKey: 'commerce-cms',
    providerLabel: 'Commerce/CMS platform',
    description:
      'Commerce and CMS connector: catalog/product/listing/order capabilities with policy-gated mutations and webhook idempotency, order totals normalized to revenue metric observations, content records as source facts with version metadata, and HMAC-verified order/content event ingestion.',
  } as const;

  /**
   * The DECLARED capability surface: the MKT-071 commerce capabilities for
   * the construction profile (the subset the provider grant includes) plus
   * the two unchanged MKT-024 capabilities (cms-content-read and the
   * legacy commerce-event-stream — event-stream continuity). Assigned once
   * in the constructor (unknown grant keys fail construction loudly — the
   * adapter never registers a capability key outside the closed commerce
   * vocabulary).
   */
  readonly capabilities: readonly IntegrationCapability[];

  private readonly http: HttpCallPort;
  private readonly timeoutMs: number;
  private readonly sizeCapBytes: number;
  private readonly defaultBaseUrl: string;

  constructor(config: CommerceCmsAdapterConfig) {
    this.http = config.http;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sizeCapBytes = config.sizeCapBytes ?? 262_144;
    this.defaultBaseUrl = config.defaultBaseUrl ?? 'https://commerceprovider.example.com';
    this.capabilities = [
      ...commerceCapabilitiesForProfile(config.grantedCapabilityKeys),
      {
        capabilityKey: 'cms-content-read',
        kind: 'read' as const,
        operations: ['listContent'],
        description: 'CMS content listing as source facts with version metadata.',
      },
      {
        capabilityKey: 'commerce-event-stream',
        kind: 'webhook' as const,
        operations: ['order.updated', 'content.published'],
        description: 'Inbound commerce/CMS event deliveries verified via X-Commerce-Signature.',
      },
    ];
  }

  async probeConnection(context: IntegrationAdapterCallContext): Promise<AdapterProbeResult> {
    const credential = parseProviderCredential(context.credentialMaterial);
    if (credential === null || credential.accessToken === null) {
      return {
        reachable: false,
        healthy: false,
        message: 'credential material is not the expected provider JSON shape (accessToken missing)',
        rateLimit: null,
      };
    }
    const result = await callProviderJson(this.http, {
      url: `${this.baseUrl(context)}/health`,
      method: 'GET',
      headers: this.headers(credential.accessToken),
      body: null,
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    return probeFromHttpResult(result, 'commerce-cms');
  }

  async read(context: IntegrationAdapterCallContext, request: NormalizedReadRequest): Promise<NormalizedReadResult> {
    const credential = parseProviderCredential(context.credentialMaterial);
    if (credential === null || credential.accessToken === null) {
      return {
        ok: false,
        records: [],
        error: 'credential material is not the expected provider JSON shape (accessToken missing)',
        rateLimit: null,
      };
    }

    // The adapter-side AUTHORIZATION PRE-CHECK: the provider-granted scopes
    // of THIS connection's credential (null = no adapter-side claim — the
    // provider decides; the MKT-024 backward-compatible posture).
    const scopeProblem = commerceScopeProblem(request.operation, credential.grantedScopes);
    if (scopeProblem !== null) {
      return { ok: false, records: [], error: scopeProblem, rateLimit: null };
    }

    let url: string;
    if (request.operation === 'listOrders') {
      url = `${this.baseUrl(context)}/commerce/v1/orders`;
    } else if (request.operation === 'listOrderDetails') {
      url = `${this.baseUrl(context)}/commerce/v1/orders/details${this.pageQuery(request.parameters)}`;
    } else if (request.operation === 'listCatalog') {
      url = `${this.baseUrl(context)}/commerce/v1/catalog${this.pageQuery(request.parameters)}`;
    } else if (request.operation === 'listContent') {
      url = `${this.baseUrl(context)}/cms/v1/content`;
    } else if (request.operation === 'getProduct') {
      const productUrl = this.subjectUrl(context, request.parameters, 'productId');
      if (productUrl === null) {
        return this.missingSubject('getProduct', 'productId');
      }
      url = `${productUrl}`;
    } else if (request.operation === 'getPrice') {
      const productUrl = this.subjectUrl(context, request.parameters, 'productId');
      if (productUrl === null) {
        return this.missingSubject('getPrice', 'productId');
      }
      url = `${productUrl}/price${this.variantQuery(request.parameters)}`;
    } else if (request.operation === 'getInventory') {
      const productUrl = this.subjectUrl(context, request.parameters, 'productId');
      if (productUrl === null) {
        return this.missingSubject('getInventory', 'productId');
      }
      url = `${productUrl}/inventory${this.variantQuery(request.parameters)}`;
    } else {
      return {
        ok: false,
        records: [],
        error: `commerce-cms read operation '${request.operation}' is not mapped by this adapter`,
        rateLimit: null,
      };
    }
    const result = await callProviderJson(this.http, {
      url,
      method: 'GET',
      headers: this.headers(credential.accessToken),
      body: null,
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    const rateLimit = parseRateLimitHeaders(result.headers);
    if (!result.ok || result.body === null) {
      return { ok: false, records: [], error: taxonomyError(result), rateLimit };
    }
    const etag = result.headers['etag'] ?? null;
    if (request.operation === 'listOrders') {
      const mapping = mapCommerceOrdersResponse(result.body, etag);
      if (!mapping.ok) {
        return { ok: false, records: [], error: mapping.error, rateLimit };
      }
      return { ok: true, records: mapping.records, error: null, rateLimit };
    }
    if (request.operation === 'listContent') {
      const mapping = mapCmsContentResponse(result.body, etag);
      if (!mapping.ok) {
        return { ok: false, records: [], error: mapping.error, rateLimit };
      }
      return { ok: true, records: mapping.records, error: null, rateLimit };
    }
    if (request.operation === 'listCatalog' || request.operation === 'listOrderDetails') {
      const mapping =
        request.operation === 'listCatalog'
          ? mapCommerceCatalogResponse(result.body, etag)
          : mapCommerceOrderDetailsResponse(result.body, etag);
      if (!mapping.ok) {
        return { ok: false, records: [], error: mapping.error, rateLimit };
      }
      return {
        ok: true,
        records: mapping.records,
        error: null,
        rateLimit,
        pageCursor: mapping.pageCursor,
      };
    }
    const mapping =
      request.operation === 'getProduct'
        ? mapCommerceProductResponse(result.body, etag)
        : request.operation === 'getPrice'
          ? mapCommercePriceResponse(result.body, etag)
          : mapCommerceInventoryResponse(result.body, etag);
    if (!mapping.ok) {
      return { ok: false, records: [], error: mapping.error, rateLimit };
    }
    return { ok: true, records: mapping.records, error: null, rateLimit };
  }

  async mutate(
    context: IntegrationAdapterCallContext,
    request: NormalizedMutationRequest,
  ): Promise<NormalizedMutationResult> {
    const credential = parseProviderCredential(context.credentialMaterial);
    if (credential === null || credential.accessToken === null) {
      return {
        ok: false,
        providerRecordId: null,
        data: null,
        error: 'credential material is not the expected provider JSON shape (accessToken missing)',
        rateLimit: null,
      };
    }

    // The adapter-side AUTHORIZATION PRE-CHECK (the provider-granted scopes
    // of THIS connection's credential) — a mutation whose required scope
    // is not granted is refused BEFORE any provider traffic, exactly like
    // a read: the adapter NEVER claims a mutation the provider does not
    // grant (AC-4).
    const scopeProblem = commerceScopeProblem(request.operation, credential.grantedScopes);
    if (scopeProblem !== null) {
      return { ok: false, providerRecordId: null, data: null, error: scopeProblem, rateLimit: null };
    }

    let url: string;
    let body: Record<string, unknown>;
    if (request.operation === 'upsertProduct') {
      const product = asObject(request.parameters['product']);
      if (product === null) {
        return this.invalidMutationParameters("parameters.product: a product object is required");
      }
      url = `${this.baseUrl(context)}/commerce/v1/products`;
      body = { product };
    } else if (request.operation === 'createListing') {
      const listing = asObject(request.parameters['listing']);
      if (listing === null) {
        return this.invalidMutationParameters("parameters.listing: a listing object is required");
      }
      url = `${this.baseUrl(context)}/commerce/v1/listings`;
      body = { listing };
    } else if (request.operation === 'updateListing') {
      const listingId = this.boundedSubjectId(request.parameters['listingId']);
      if (listingId === null) {
        return this.invalidMutationParameters('parameters.listingId: a listing identifier is required');
      }
      const listing = asObject(request.parameters['listing']);
      if (listing === null) {
        return this.invalidMutationParameters("parameters.listing: a listing patch object is required");
      }
      url = `${this.baseUrl(context)}/commerce/v1/listings/${encodeURIComponent(listingId)}`;
      body = { listing };
    } else if (request.operation === 'endListing') {
      const listingId = this.boundedSubjectId(request.parameters['listingId']);
      if (listingId === null) {
        return this.invalidMutationParameters('parameters.listingId: a listing identifier is required');
      }
      url = `${this.baseUrl(context)}/commerce/v1/listings/${encodeURIComponent(listingId)}/end`;
      body = {};
    } else {
      return {
        ok: false,
        providerRecordId: null,
        data: null,
        error: `commerce-cms mutation operation '${request.operation}' is not mapped by this adapter (declared mutation capabilities: ${
          this.capabilities
            .filter((capability) => capability.kind === 'mutation')
            .map((capability) => capability.capabilityKey)
            .join(', ') || '(none — this adapter instance declares no mutation capability)'
        })`,
        rateLimit: null,
      };
    }
    const result = await callProviderJson(this.http, {
      url,
      method: request.operation === 'updateListing' ? 'PATCH' : 'POST',
      headers: this.headers(credential.accessToken),
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    const rateLimit = parseRateLimitHeaders(result.headers);
    if (!result.ok || result.body === null) {
      return { ok: false, providerRecordId: null, data: null, error: taxonomyError(result), rateLimit };
    }
    const etag = result.headers['etag'] ?? null;
    const mapping =
      request.operation === 'upsertProduct'
        ? mapCommerceProductResponse(result.body, etag)
        : mapCommerceListingResponse(result.body, etag);
    if (!mapping.ok) {
      return { ok: false, providerRecordId: null, data: null, error: mapping.error, rateLimit };
    }
    const record = mapping.records[0]!;
    return {
      ok: true,
      providerRecordId: record.providerRecordId,
      data: record.data,
      error: null,
      rateLimit,
    };
  }

  async verifyWebhook(
    context: IntegrationAdapterCallContext,
    delivery: WebhookDeliveryInput,
  ): Promise<WebhookVerificationResult> {
    const credential = parseProviderCredential(context.credentialMaterial);
    if (credential === null || credential.webhookSecret === null) {
      return {
        verified: false,
        reason: 'credential material is not the expected provider JSON shape (webhookSecret missing)',
        normalizedEventType: null,
      };
    }
    const verdict = verifyHmacWebhookDelivery(
      delivery,
      credential.webhookSecret,
      'x-commerce-signature',
      `commerce:${delivery.eventType}`,
    );
    if (!verdict.verified) {
      return verdict;
    }
    // MKT-071: a verified delivery whose payload carries the provider's OWN
    // event id is normalized into the WEBHOOK EVENT IDENTITY (the dedup
    // key half + the normalized projection input). A payload with NO event
    // id keeps the legacy append-only event-stream path (eventIdentity
    // null — no dedup is possible and none is fabricated); a payload WITH
    // an event id that fails normalization (kind outside the closed
    // order/product vocabulary, malformed body, non-scalar attribution)
    // fails CLOSED — the delivery is rejected with the honest reason and
    // nothing is recorded.
    if (typeof delivery.payload['eventId'] !== 'string' || (delivery.payload['eventId'] as string).trim() === '') {
      return { ...verdict, eventIdentity: null };
    }
    const normalization = normalizeCommerceWebhookEvent(delivery.payload);
    if (!normalization.ok) {
      return {
        verified: false,
        reason: `verified commerce event delivery failed normalization: ${normalization.error}`,
        normalizedEventType: null,
      };
    }
    return { ...verdict, eventIdentity: commerceWebhookEventIdentity(normalization) };
  }

  private baseUrl(context: IntegrationAdapterCallContext): string {
    const configured = context.providerConfig['apiBaseUrl'];
    return configured !== undefined && configured.trim() !== '' ? configured : this.defaultBaseUrl;
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    };
  }

  /** The paged-read query string (cursor + limit — both optional). */
  private pageQuery(parameters: Readonly<Record<string, unknown>>): string {
    const parts: string[] = [];
    const cursor =
      typeof parameters['cursor'] === 'string' && parameters['cursor'].trim() !== ''
        ? (parameters['cursor'] as string)
        : null;
    const limit = parseNumberOrNull(parameters['limit']);
    if (cursor !== null) parts.push(`cursor=${encodeURIComponent(cursor)}`);
    if (limit !== null && Number.isInteger(limit) && limit > 0 && limit <= 200) {
      parts.push(`limit=${limit}`);
    }
    return parts.length === 0 ? '' : `?${parts.join('&')}`;
  }

  /** The optional variant query parameter of the price/inventory reads. */
  private variantQuery(parameters: Readonly<Record<string, unknown>>): string {
    const variantId =
      typeof parameters['variantId'] === 'string' && parameters['variantId'].trim() !== ''
        ? (parameters['variantId'] as string)
        : null;
    return variantId === null ? '' : `?variantId=${encodeURIComponent(variantId)}`;
  }

  /** The subject URL of a single-product read (null on a missing subject). */
  private subjectUrl(
    context: IntegrationAdapterCallContext,
    parameters: Readonly<Record<string, unknown>>,
    key: 'productId',
  ): string | null {
    const subjectId = this.boundedSubjectId(parameters[key]);
    if (subjectId === null) return null;
    return `${this.baseUrl(context)}/commerce/v1/products/${encodeURIComponent(subjectId)}`;
  }

  private boundedSubjectId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > 128) return null;
    return trimmed;
  }

  private missingSubject(operation: string, key: string): NormalizedReadResult {
    return {
      ok: false,
      records: [],
      error: `commerce-cms read operation '${operation}' requires parameters.${key} (a non-empty product identifier)`,
      rateLimit: null,
    };
  }

  private invalidMutationParameters(problem: string): NormalizedMutationResult {
    return { ok: false, providerRecordId: null, data: null, error: problem, rateLimit: null };
  }
}

