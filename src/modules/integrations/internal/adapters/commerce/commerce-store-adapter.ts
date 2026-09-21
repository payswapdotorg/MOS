/**
 * Commerce STORE first-party connector — MKT-071, INT-001 (the FULL
 * commerce capability surface of spec/architecture-v1.6.md §15).
 *
 * One adapter subtree under internal/adapters/commerce/: this file owns
 * all commerce-store-specific knowledge behind the generic
 * IntegrationAdapter port. Wired ONLY at the composition root; no domain
 * module imports it. Egress uses the platform HttpCallPort — NO commerce
 * SDK anywhere (shopify & co. are on the architecture denylist).
 *
 * The COMMERCE-STORE provider (a store platform whose API grants
 * commerce.write scopes to authorized connections) is the counterpart of
 * the read-only commerce/CMS connector (commerce-adapter.ts): where THAT
 * adapter declares the read-only subset (its provider grants read scopes
 * only), THIS adapter declares the FULL surface including the MUTATING
 * capabilities — product write (createProduct/updateProduct) and listing
 * management (createListing/updateListing/endListing) — because its
 * provider authorizes them. Per-connection authorization still applies at
 * RUNTIME: the provider enforces the connection token's scopes on every
 * call (a read-only token gets an honest 403 invalid-scope refusal as
 * DATA — ok=false + error, never a silent skip, never a claimed
 * capability the provider does not grant).
 *
 * Reads (the shared commerce provider JSON convention — adapter-support):
 * every read maps provider payloads to normalized source records carrying
 * the §20 metadata (the provider ETag on every record, sourceTimestamp
 * from the provider's updatedAt, the page cursor in the fields):
 *   - listCatalog      → the paged normalized catalog-page source record;
 *   - getProduct       → the normalized product source record;
 *   - getPrice         → the normalized price source record;
 *   - getInventory     → the normalized inventory source record;
 *   - listOrders       → revenue metric observations (the MKT-024
 *                        commerce-orders-read continuity);
 *   - listOrderRecords → the normalized ORDER records: paged, LINE-ITEM
 *                        shape, the provider's attribution/reference
 *                        fields carried VERBATIM as passthrough data
 *                        (§16 — no linking/matching/causal computation;
 *                        MKT-073 owns attribution later).
 *
 * Mutations (AC-4 — every one gated by the /integrations policy engine
 * with its own capability key BEFORE any provider traffic):
 *   - createProduct / updateProduct (commerce-product-write);
 *   - createListing / updateListing / endListing (commerce-listing-manage).
 *
 * Webhook: X-Commerce-Signature HMAC-SHA256 verification (the shared
 * convention); verified deliveries carrying the provider's OWN event
 * identity (eventId/event_id) return the NORMALIZED provider event
 * (order/product/listing kind + attribution passthrough) so the module's
 * idempotent ingestion path dedups by (provider id, event id) — the
 * commerce-order-webhook capability extending the commerce-event-stream
 * family.
 *
 * INVARIANTS: invocation failures are DATA (ok=false + error), never
 * thrown; malformed provider payloads fail closed as data errors;
 * rate-limit/backoff metadata is surfaced on every outcome (§20); the
 * adapter NEVER claims a capability its provider does not offer.
 */

import type { HttpCallPort } from '../../../../../platform/http/outbound.ts';
import type {
  AdapterProbeResult,
  IntegrationAdapter,
  IntegrationAdapterCallContext,
  NormalizedMutationResult,
  NormalizedReadResult,
  NormalizedReadRequest,
  WebhookDeliveryInput,
  WebhookVerificationResult,
} from '../../../public.ts';
import {
  buildNormalizedCommerceEvent,
  callProviderJson,
  commerceIdParameter,
  commerceReadParameterFailure,
  commerceReadQuery,
  mapCommerceCatalogPageResponse,
  mapCommerceInventoryResponse,
  mapCommerceMutationResponse,
  mapCommerceOrderRecordsResponse,
  mapCommercePriceResponse,
  mapCommerceProductResponse,
  mapCommerceOrdersResponse,
  parseProviderCredential,
  parseRateLimitHeaders,
  probeFromHttpResult,
  verifyHmacWebhookDelivery,
} from '../../adapter-support.ts';
import type { CommerceMappingResult } from '../../adapter-support.ts';

/** The commerce-store connector configuration (wired at the composition root). */
export interface CommerceStoreAdapterConfig {
  /** The platform HttpCallPort (fetch-based — no provider SDK). */
  readonly http: HttpCallPort;
  /** Request deadline in milliseconds (default 15000; port cap 60000). */
  readonly timeoutMs?: number;
  /** Response body cap in bytes (default 262144; port cap 1048576). */
  readonly sizeCapBytes?: number;
  /** Production default base URL; sandbox connections override via providerConfig.apiBaseUrl. */
  readonly defaultBaseUrl?: string;
}

/** The commerce-store first-party adapter — the FULL v1.6 commerce surface. */
export class CommerceStoreAdapter implements IntegrationAdapter {
  readonly descriptor = {
    adapterKey: 'commerce-store',
    providerLabel: 'Commerce store platform',
    description:
      'Commerce store connector: the full v1.6 commerce surface — paged catalog reads, product reads and authorized product writes, listing management (create/update/end), price and inventory reads, order reads (revenue metrics + full line-item records with attribution passthrough), and HMAC-verified identified order/product webhook ingestion with (provider id, event id) idempotency.',
  } as const;

  readonly capabilities = [
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
      capabilityKey: 'commerce-product-write',
      kind: 'mutation',
      operations: ['createProduct', 'updateProduct'],
      description:
        'Product write WHERE THE PROVIDER AUTHORIZES IT: policy-gated on every call; the provider enforces the connection token scopes at runtime (invalid-scope refusals are honest data failures).',
    },
    {
      capabilityKey: 'commerce-listing-manage',
      kind: 'mutation',
      operations: ['createListing', 'updateListing', 'endListing'],
      description:
        'Listing lifecycle management (create/update/end) WHERE THE PROVIDER AUTHORIZES IT: policy-gated on every call; the provider enforces the connection token scopes at runtime.',
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
    {
      capabilityKey: 'commerce-orders-read',
      kind: 'read',
      operations: ['listOrders', 'listOrderRecords'],
      description:
        'Order reads: listOrders normalizes order totals to revenue metric observations; listOrderRecords returns the full line-item order records with attribution passthrough (paged).',
    },
    {
      capabilityKey: 'commerce-order-webhook',
      kind: 'webhook',
      operations: [
        'order.created',
        'order.updated',
        'order.fulfilled',
        'product.updated',
        'listing.updated',
      ],
      description:
        'Identified inbound order/product/listing event deliveries verified via X-Commerce-Signature; the provider event identity drives the (provider id, event id) idempotency fence (extends the commerce-event-stream family).',
    },
  ] as const;

  private readonly http: HttpCallPort;
  private readonly timeoutMs: number;
  private readonly sizeCapBytes: number;
  private readonly defaultBaseUrl: string;

  constructor(config: CommerceStoreAdapterConfig) {
    this.http = config.http;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sizeCapBytes = config.sizeCapBytes ?? 262_144;
    this.defaultBaseUrl = config.defaultBaseUrl ?? 'https://commercestore.example.com';
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
    return probeFromHttpResult(result, 'commerce-store');
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
    let url: string;
    if (request.operation === 'listCatalog') {
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
    } else if (request.operation === 'listOrders') {
      url = `${this.baseUrl(context)}/commerce/v1/orders`;
    } else if (request.operation === 'listOrderRecords') {
      url = `${this.baseUrl(context)}/commerce/v1/order-records${commerceReadQuery(request.parameters)}`;
    } else {
      return {
        ok: false,
        records: [],
        error: `commerce-store read operation '${request.operation}' is not mapped by this adapter`,
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
    switch (request.operation) {
      case 'listCatalog':
        mapping = mapCommerceCatalogPageResponse(result.body, etag);
        break;
      case 'getProduct':
        mapping = mapCommerceProductResponse(result.body, etag);
        break;
      case 'getPrice':
        mapping = mapCommercePriceResponse(result.body, etag);
        break;
      case 'getInventory':
        mapping = mapCommerceInventoryResponse(result.body, etag);
        break;
      case 'listOrderRecords':
        mapping = mapCommerceOrderRecordsResponse(result.body, etag);
        break;
      default:
        mapping = mapCommerceOrdersResponse(result.body, etag);
        break;
    }
    if (!mapping.ok) {
      return { ok: false, records: [], error: mapping.error, rateLimit };
    }
    return { ok: true, records: mapping.records, error: null, rateLimit };
  }

  async mutate(
    context: IntegrationAdapterCallContext,
    request: { readonly operation: string; readonly parameters: Readonly<Record<string, unknown>> },
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
    let url: string;
    let method: 'POST' | 'PATCH';
    if (request.operation === 'createProduct') {
      url = `${this.baseUrl(context)}/commerce/v1/products`;
      method = 'POST';
    } else if (request.operation === 'updateProduct') {
      const productId = commerceIdParameter(request.parameters, 'productId');
      if (productId === null) {
        return commerceMutateParameterFailure('updateProduct', 'productId');
      }
      url = `${this.baseUrl(context)}/commerce/v1/products/${encodeURIComponent(productId)}`;
      method = 'PATCH';
    } else if (request.operation === 'createListing') {
      url = `${this.baseUrl(context)}/commerce/v1/listings`;
      method = 'POST';
    } else if (request.operation === 'updateListing') {
      const listingId = commerceIdParameter(request.parameters, 'listingId');
      if (listingId === null) {
        return commerceMutateParameterFailure('updateListing', 'listingId');
      }
      url = `${this.baseUrl(context)}/commerce/v1/listings/${encodeURIComponent(listingId)}`;
      method = 'PATCH';
    } else if (request.operation === 'endListing') {
      const listingId = commerceIdParameter(request.parameters, 'listingId');
      if (listingId === null) {
        return commerceMutateParameterFailure('endListing', 'listingId');
      }
      url = `${this.baseUrl(context)}/commerce/v1/listings/${encodeURIComponent(listingId)}/end`;
      method = 'POST';
    } else {
      return {
        ok: false,
        providerRecordId: null,
        data: null,
        error: `commerce-store mutation operation '${request.operation}' is not mapped by this adapter`,
        rateLimit: null,
      };
    }
    const result = await callProviderJson(this.http, {
      url,
      method,
      headers: {
        ...this.headers(credential.accessToken),
        'content-type': 'application/json',
      },
      body: JSON.stringify(request.parameters),
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    const rateLimit = parseRateLimitHeaders(result.headers);
    if (!result.ok || result.body === null) {
      // The honest provider refusal (unauthorized / invalid-scope /
      // rate-limited / provider-down) — DATA, never a throw, never a
      // silent skip. The module records it in the commerce mutation
      // ledger; the caller decides.
      return { ok: false, providerRecordId: null, data: null, error: result.error, rateLimit };
    }
    const mapping = mapCommerceMutationResponse(result.body);
    if (!mapping.ok) {
      return { ok: false, providerRecordId: null, data: null, error: mapping.error, rateLimit };
    }
    return { ok: true, providerRecordId: mapping.providerRecordId, data: mapping.data, error: null, rateLimit };
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

/** The fail-closed data outcome of a mutation with a missing bounded id parameter. */
function commerceMutateParameterFailure(
  operation: string,
  key: string,
): { ok: false; providerRecordId: null; data: null; error: string; rateLimit: null } {
  return {
    ok: false,
    providerRecordId: null,
    data: null,
    error: `${operation} requires a bounded '${key}' parameter`,
    rateLimit: null,
  };
}
