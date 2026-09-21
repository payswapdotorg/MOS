/**
 * Commerce/CMS first-party connector — MKT-024, INT-001; EXTENDED by
 * MKT-071 (Commerce Catalog and Order Capabilities) with the read-only
 * commerce capability surface: catalog read (paged), product read, price
 * read and inventory read, next to the existing orders/CMS reads.
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
 * READ operations map provider payloads to NORMALIZED observations
 * (METRIC-001):
 *   - listOrders  → metric-observation envelopes (kind 'metric'): the
 *     order total as 'commerce.revenue' with the row's own currency as
 *     the unit and the provider order identity as dimensions;
 *   - listContent → source-record envelopes (kind 'record'): CMS content
 *     metadata as provider source facts, with the provider content
 *     version mapping to sourceVersion (the §20 version-metadata path);
 *   - MKT-071 additions (the shared commerce provider JSON convention —
 *     see adapter-support): listCatalog → the paged normalized
 *     catalog-page source record (category/product shape + cursor);
 *     getProduct → the normalized product source record; getPrice → the
 *     normalized price source record; getInventory → the normalized
 *     inventory source record.
 *
 * WEBHOOK/EVENT ingestion: commerce platforms push order/content events —
 * X-Commerce-Signature HMAC-SHA256 verification over the delivered
 * payload (the signing secret is the credential material's webhookSecret
 * field — in-process only), through the boundary's existing
 * append-oriented ingestion surface. MKT-071: when the delivery payload
 * carries the provider's OWN event identity (eventId/event_id), the
 * verification result carries the NORMALIZED provider event (order/
 * product/listing kind + attribution passthrough) so the module's
 * idempotent ingestion path can dedup by (provider id, event id);
 * deliveries without an event identity keep the legacy append-only path.
 *
 * MKT-071 capability-subset posture: this connector is the FIRST-CLASS
 * READ-ONLY commerce adapter — its provider (the commerce/CMS platform)
 * grants READ scopes only, so the adapter declares NO mutation capability
 * and NEVER claims one (AC-4). Product writes and listing management live
 * exclusively on the commerce-store connector whose provider authorizes
 * them (commerce-store-adapter.ts).
 *
 * INVARIANTS: invocation failures are DATA (ok=false + error), never
 * thrown; malformed provider payloads fail closed as data errors;
 * rate-limit/backoff metadata is surfaced on every outcome (§20).
 */

import type { HttpCallPort } from '../../../../../platform/http/outbound.ts';
import type {
  AdapterProbeResult,
  IntegrationAdapter,
  IntegrationAdapterCallContext,
  NormalizedMutationResult,
  NormalizedProviderRecord,
  NormalizedReadRequest,
  NormalizedReadResult,
  WebhookDeliveryInput,
  WebhookVerificationResult,
} from '../../../public.ts';
import {
  asArray,
  asObject,
  buildNormalizedCommerceEvent,
  callProviderJson,
  commerceIdParameter,
  commerceReadParameterFailure,
  commerceReadQuery,
  isoTimestampOrNull,
  mapCommerceCatalogPageResponse,
  mapCommerceInventoryResponse,
  mapCommerceOrdersResponse,
  mapCommercePriceResponse,
  mapCommerceProductResponse,
  parseProviderCredential,
  parseRateLimitHeaders,
  probeFromHttpResult,
  sourceRecordEnvelope,
  verifyHmacWebhookDelivery,
} from '../../adapter-support.ts';
import type { CommerceMappingResult } from '../../adapter-support.ts';

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
}

/** The mapping outcome: normalized records as data, never a throw. */
export type { CommerceMappingResult } from '../../adapter-support.ts';

/**
 * Pure mapping: a CMS content response → source-record envelopes. Required
 * identity: item id; the item version maps to sourceVersion when numeric
 * or string; publishedAt maps to the source timestamp.
 */
export function mapCmsContentResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const rows = asArray(payload['items']);
  if (rows === null) {
    return { ok: false, records: [], error: "malformed CMS payload: 'items' is not an array" };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, records: [], error: `malformed CMS payload: items[${index}] is not an object` };
    }
    const id = row['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, records: [], error: `malformed CMS payload: items[${index}].id is missing` };
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
  return { ok: true, records, error: null };
}

/** The commerce/CMS first-party adapter. */
export class CommerceCmsAdapter implements IntegrationAdapter {
  readonly descriptor = {
    adapterKey: 'commerce-cms',
    providerLabel: 'Commerce/CMS platform',
    description:
      'Commerce and CMS connector: order totals normalized to revenue metric observations, content records as source facts with version metadata, HMAC-verified order/content event ingestion, and the MKT-071 read-only commerce surface (paged catalog, product, price and inventory reads).',
  } as const;

  readonly capabilities = [
    {
      capabilityKey: 'commerce-orders-read',
      kind: 'read',
      operations: ['listOrders'],
      description: 'Order listing normalized to revenue metric observations.',
    },
    {
      capabilityKey: 'cms-content-read',
      kind: 'read',
      operations: ['listContent'],
      description: 'CMS content listing as source facts with version metadata.',
    },
    {
      capabilityKey: 'commerce-event-stream',
      kind: 'webhook',
      operations: ['order.updated', 'content.published'],
      description: 'Inbound commerce/CMS event deliveries verified via X-Commerce-Signature.',
    },
    // ----- MKT-071 additions: the READ-ONLY commerce capability surface.
    // The commerce/CMS platform grants READ scopes only — this adapter
    // deliberately declares NO mutation capability (the first-class
    // capability-subset posture; product write + listing management live
    // on the commerce-store connector whose provider authorizes them).
    {
      capabilityKey: 'commerce-catalog-read',
      kind: 'read',
      operations: ['listCatalog'],
      description: 'Paged catalog read (category/product shape) as normalized catalog-page source records.',
    },
    {
      capabilityKey: 'commerce-product-read',
      kind: 'read',
      operations: ['getProduct'],
      description: 'Product read as a normalized product source record (provider attributes passthrough).',
    },
    {
      capabilityKey: 'commerce-price-read',
      kind: 'read',
      operations: ['getPrice'],
      description: 'Product price read as a normalized price source record.',
    },
    {
      capabilityKey: 'commerce-inventory-read',
      kind: 'read',
      operations: ['getInventory'],
      description: 'Product inventory read as a normalized inventory source record.',
    },
  ] as const;

  private readonly http: HttpCallPort;
  private readonly timeoutMs: number;
  private readonly sizeCapBytes: number;
  private readonly defaultBaseUrl: string;

  constructor(config: CommerceCmsAdapterConfig) {
    this.http = config.http;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sizeCapBytes = config.sizeCapBytes ?? 262_144;
    this.defaultBaseUrl = config.defaultBaseUrl ?? 'https://commerceprovider.example.com';
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
    // The MKT-071 parametered reads: a bounded cursor/product id from the
    // call parameters (validated fail-closed — no free-form URL building).
    let url: string;
    if (request.operation === 'listOrders') {
      url = `${this.baseUrl(context)}/commerce/v1/orders`;
    } else if (request.operation === 'listContent') {
      url = `${this.baseUrl(context)}/cms/v1/content`;
    } else if (request.operation === 'listCatalog') {
      url = `${this.baseUrl(context)}/commerce/v1/catalog${commerceReadQuery(request.parameters)}`;
    } else if (request.operation === 'getProduct') {
      const productId = commerceIdParameter(request.parameters, 'productId');
      if (productId === null) {
        return commerceReadParameterFailure('getProduct', 'productId');
      }
      url = `${this.baseUrl(context)}/commerce/v1/products/${encodeURIComponent(productId)}`;
    } else if (request.operation === 'getPrice') {
      const productId = commerceIdParameter(request.parameters, 'productId');
      if (productId === null) {
        return commerceReadParameterFailure('getPrice', 'productId');
      }
      url = `${this.baseUrl(context)}/commerce/v1/products/${encodeURIComponent(productId)}/price`;
    } else if (request.operation === 'getInventory') {
      const productId = commerceIdParameter(request.parameters, 'productId');
      if (productId === null) {
        return commerceReadParameterFailure('getInventory', 'productId');
      }
      url = `${this.baseUrl(context)}/commerce/v1/products/${encodeURIComponent(productId)}/inventory`;
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
      return { ok: false, records: [], error: result.error, rateLimit };
    }
    const etag = result.headers['etag'] ?? null;
    let mapping: CommerceMappingResult;
    if (request.operation === 'listOrders') {
      mapping = mapCommerceOrdersResponse(result.body, etag);
    } else if (request.operation === 'listContent') {
      mapping = mapCmsContentResponse(result.body, etag);
    } else if (request.operation === 'listCatalog') {
      mapping = mapCommerceCatalogPageResponse(result.body, etag);
    } else if (request.operation === 'getProduct') {
      mapping = mapCommerceProductResponse(result.body, etag);
    } else if (request.operation === 'getPrice') {
      mapping = mapCommercePriceResponse(result.body, etag);
    } else {
      mapping = mapCommerceInventoryResponse(result.body, etag);
    }
    if (!mapping.ok) {
      return { ok: false, records: [], error: mapping.error, rateLimit };
    }
    return { ok: true, records: mapping.records, error: null, rateLimit };
  }

  async mutate(): Promise<NormalizedMutationResult> {
    return {
      ok: false,
      providerRecordId: null,
      data: null,
      error: 'commerce-cms declares no mutation capability',
      rateLimit: null,
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
    const verification = verifyHmacWebhookDelivery(
      delivery,
      credential.webhookSecret,
      'x-commerce-signature',
      `commerce:${delivery.eventType}`,
    );
    if (!verification.verified) {
      return verification;
    }
    // MKT-071: when the delivery payload carries the provider's OWN event
    // identity, attach the normalized provider event (the idempotent
    // ingestion path dedups by it); otherwise the legacy append-only path.
    const providerEvent = buildNormalizedCommerceEvent(delivery.eventType, delivery.payload);
    return { ...verification, providerEvent };
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
}
