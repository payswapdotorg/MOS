/**
 * MKT-071 — the NORMALIZED COMMERCE CAPABILITY CONTRACT of /integrations
 * (spec/architecture-v1.6.md §15: "The existing Integration boundary becomes
 * capable of commerce operations required by v1.6: catalog read, product
 * read/write where authorized, product listing, price/inventory read,
 * order read, order webhook and attribution data").
 *
 * This file is the PROVIDER-NEUTRAL normalized vocabulary + the PURE
 * mapping functions of the commerce capability surface. It lives under
 * internal/ (NOT under internal/adapters/) exactly like the shared
 * adapter-support module: the first-party commerce/CMS connector imports
 * these through the module PUBLIC entry (its only sanctioned import), the
 * module core consumes the webhook-event identity vocabulary through the
 * public contract, and unit tests import the pure functions through the
 * public entry (tests may import ONLY module public entries — the
 * arch-check TEST_MODULE_INTERNAL_IMPORT rule), so the normalized mapping
 * semantics are part of the tested module contract (MKT-071 AC-10).
 *
 * WHAT IS NORMALIZED HERE (and what deliberately is NOT):
 *   - the CAPABILITY KEYS and their declared operations (the closed
 *     commerce vocabulary — a capability-subset declaration is first-class:
 *     a read-only commerce adapter is valid; the adapter NEVER claims a
 *     mutation capability the provider grant does not include);
 *   - the ORDER/PRODUCT EVENT vocabulary + delivery outcomes + normalized
 *     shape versions (mirrored by the migration-049 CHECK fences);
 *   - the provider SCOPE convention of the commerce capability surface
 *     (the credential material's optional granted-scope list — the
 *     adapter-side authorization pre-check; a material without a scope
 *     list makes NO adapter-side claim, the provider decides);
 *   - the WIRE→NORMALIZED mapping functions for the commerce read surface
 *     (catalog pages, product detail, price, inventory, order details with
 *     line items) and the webhook-event normalization (provider event id +
 *     normalized event + attribution passthrough);
 *   - ATTRIBUTION IS PASSTHROUGH DATA (spec/architecture-v1.6.md §16 —
 *     every social-to-product action can carry a mission-scoped
 *     attribution reference): the provider's attribution/reference fields
 *     ride VERBATIM through the normalized shapes. There is NO
 *     attribution linking, matching or causal computation anywhere in
 *     this module (MKT-073 owns that later) — the fields are recorded,
 *     not interpreted.
 *
 * INVARIANTS (the MKT-023/MKT-024 boundary, frozen):
 *   - mapping functions are PURE: same payload → same normalized records;
 *     malformed provider payloads fail CLOSED as data errors ({ok:false +
 *     bounded error}), never throws, never partial records;
 *   - NO fabricated metrics: every new commerce read maps to source-record
 *     envelopes (evidence-only) — only the EXISTING listOrders operation
 *     maps order totals to revenue metric observations (METRIC-001, frozen
 *     by the MKT-024 source-mapping tests);
 *   - provider identities are normalized INSIDE the boundary (composite
 *     providerRecordId values — no raw provider id becomes a domain
 *     identity);
 *   - nothing secret can appear in any normalized shape (the §21
 *     material-key backstops run on every durable write path downstream).
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type {
  IntegrationCapability,
  NormalizedProviderRecord,
  WebhookEventIdentity,
} from '../public.ts';
import {
  asArray,
  asObject,
  isoTimestampOrNull,
  parseNumberOrNull,
  sourceRecordEnvelope,
} from './adapter-support.ts';

// ---------------------------------------------------------------------------
// The commerce capability vocabulary (MKT-071 AC-1)
// ---------------------------------------------------------------------------

/**
 * The closed commerce capability-key vocabulary of the MKT-071 surface.
 * `commerce-orders-read` EXISTS since MKT-024; `commerce-order-webhook`
 * EXTENDS the MKT-024 `commerce-event-stream` capability (the legacy
 * capability remains declared unchanged — event-stream continuity).
 */
export type CommerceCapabilityKey =
  | 'commerce-catalog-read'
  | 'commerce-product-read'
  | 'commerce-product-write'
  | 'commerce-listing-manage'
  | 'commerce-price-read'
  | 'commerce-inventory-read'
  | 'commerce-orders-read'
  | 'commerce-order-webhook';

export const COMMERCE_CAPABILITY_KEYS: readonly CommerceCapabilityKey[] = [
  'commerce-catalog-read',
  'commerce-product-read',
  'commerce-product-write',
  'commerce-listing-manage',
  'commerce-price-read',
  'commerce-inventory-read',
  'commerce-orders-read',
  'commerce-order-webhook',
];

/**
 * The READ-ONLY capability subset: every commerce capability EXCEPT the two
 * mutation capabilities. A capability-subset adapter is FIRST-CLASS (a
 * read-only commerce adapter is valid and tested) — the provider grant, not
 * the ambition of the platform, decides the declared surface.
 */
export const COMMERCE_READ_ONLY_CAPABILITY_KEYS: readonly CommerceCapabilityKey[] = [
  'commerce-catalog-read',
  'commerce-product-read',
  'commerce-price-read',
  'commerce-inventory-read',
  'commerce-orders-read',
  'commerce-order-webhook',
];

/** The closed commerce order/product event vocabulary (the webhook kinds). */
export type CommerceEventKind =
  | 'order.created'
  | 'order.updated'
  | 'order.fulfilled'
  | 'order.cancelled'
  | 'product.created'
  | 'product.updated';

export const COMMERCE_EVENT_KINDS: readonly CommerceEventKind[] = [
  'order.created',
  'order.updated',
  'order.fulfilled',
  'order.cancelled',
  'product.created',
  'product.updated',
];

/** The frozen delivery-outcome vocabulary of the webhook dedup fence. */
export type CommerceDeliveryOutcome = 'ingested' | 'duplicate';

export const COMMERCE_DELIVERY_OUTCOMES: readonly CommerceDeliveryOutcome[] = [
  'ingested',
  'duplicate',
];

/**
 * The closed normalized shape versions of the commerce event projection
 * (mirrored by the migration-049 CHECK fence — adding a shape version is a
 * schema change, never a runtime value).
 */
export const COMMERCE_EVENT_SHAPE_VERSIONS = [
  'commerce-order-v1',
  'commerce-product-v1',
] as const;

export type CommerceEventShapeVersion = (typeof COMMERCE_EVENT_SHAPE_VERSIONS)[number];

/**
 * The per-capability declaration table (pure DATA — no provider branch
 * anywhere): the capability key, the closed kind, the declared operations
 * and the bounded description. `commerce-orders-read` declares BOTH the
 * MKT-024 `listOrders` (revenue metric observations — frozen) and the
 * MKT-071 `listOrderDetails` (paged order records with the line-item
 * shape + attribution passthrough).
 */
const COMMERCE_CAPABILITY_DECLARATIONS: Readonly<
  Record<CommerceCapabilityKey, IntegrationCapability>
> = {
  'commerce-catalog-read': {
    capabilityKey: 'commerce-catalog-read',
    kind: 'read',
    operations: ['listCatalog'],
    description: 'Paged store catalog read normalized to category and product source records.',
  },
  'commerce-product-read': {
    capabilityKey: 'commerce-product-read',
    kind: 'read',
    operations: ['getProduct'],
    description: 'Single product detail read with variants, as a versioned source record.',
  },
  'commerce-product-write': {
    capabilityKey: 'commerce-product-write',
    kind: 'mutation',
    operations: ['upsertProduct'],
    description:
      'Product write (create or update) where the provider grant authorizes it; policy-gated and scope-checked.',
  },
  'commerce-listing-manage': {
    capabilityKey: 'commerce-listing-manage',
    kind: 'mutation',
    operations: ['createListing', 'updateListing', 'endListing'],
    description:
      'Product listing lifecycle management (create/update/end) where the provider grant authorizes it; policy-gated and scope-checked.',
  },
  'commerce-price-read': {
    capabilityKey: 'commerce-price-read',
    kind: 'read',
    operations: ['getPrice'],
    description: 'Product/variant price read as a source record (provider-verbatim amounts).',
  },
  'commerce-inventory-read': {
    capabilityKey: 'commerce-inventory-read',
    kind: 'read',
    operations: ['getInventory'],
    description: 'Product/variant inventory read as a source record.',
  },
  'commerce-orders-read': {
    capabilityKey: 'commerce-orders-read',
    kind: 'read',
    operations: ['listOrders', 'listOrderDetails'],
    description:
      'Order reads: listOrders normalizes order totals to revenue metric observations (MKT-024, frozen); listOrderDetails returns paged order records with line items and attribution passthrough (MKT-071).',
  },
  'commerce-order-webhook': {
    capabilityKey: 'commerce-order-webhook',
    kind: 'webhook',
    operations: [
      'order.created',
      'order.updated',
      'order.fulfilled',
      'order.cancelled',
      'product.created',
      'product.updated',
    ],
    description:
      'Inbound order/product event deliveries verified via X-Commerce-Signature and deduplicated by (provider, provider event id) — extends the commerce-event-stream capability.',
  },
};

/**
 * The capability declaration of one commerce capability key (pure lookup —
 * the returned object is a shared frozen description, never mutated).
 */
export function commerceCapabilityDeclaration(key: CommerceCapabilityKey): IntegrationCapability {
  return COMMERCE_CAPABILITY_DECLARATIONS[key];
}

/**
 * The CAPABILITY-SUBSET DECLARATION (MKT-071 AC-1): the declared capability
 * list for a commerce adapter instance, given the capability keys the
 * provider grant actually includes. `grantedCapabilityKeys` omitted → the
 * FULL commerce surface (the production default). Unknown keys fail the
 * construction LOUDLY (InvalidRequestError — an adapter may never register
 * a capability key outside the closed commerce vocabulary). The subset is
 * first-class: a read-only grant yields a read-only adapter.
 */
export function commerceCapabilitiesForProfile(
  grantedCapabilityKeys?: readonly string[],
): readonly IntegrationCapability[] {
  if (grantedCapabilityKeys === undefined) {
    return COMMERCE_CAPABILITY_KEYS.map(commerceCapabilityDeclaration);
  }
  if (grantedCapabilityKeys === null || !Array.isArray(grantedCapabilityKeys)) {
    throw new InvalidRequestError('Invalid commerce capability profile', [
      'grantedCapabilityKeys: must be an array of commerce capability keys when provided',
    ]);
  }
  const problems: string[] = [];
  const granted: CommerceCapabilityKey[] = [];
  for (const [index, key] of grantedCapabilityKeys.entries()) {
    if (typeof key !== 'string' || !(COMMERCE_CAPABILITY_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `grantedCapabilityKeys[${index}]: '${String(key)}' is not a commerce capability key (closed vocabulary: ${COMMERCE_CAPABILITY_KEYS.join(', ')})`,
      );
    } else if (!granted.includes(key as CommerceCapabilityKey)) {
      granted.push(key as CommerceCapabilityKey);
    }
  }
  if (granted.length === 0) {
    problems.push('grantedCapabilityKeys: at least one commerce capability key is required');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid commerce capability profile', problems);
  }
  // Canonical declaration order regardless of the grant's input order.
  return COMMERCE_CAPABILITY_KEYS.filter((key) => granted.includes(key)).map(
    commerceCapabilityDeclaration,
  );
}

// ---------------------------------------------------------------------------
// The provider scope convention (AC-2/AC-4 — the authorization pre-check)
// ---------------------------------------------------------------------------

/** The commerce read scope (catalog/product/price/inventory reads). */
export const COMMERCE_READ_SCOPE = 'catalog:read';
/** The commerce orders read scope. */
export const COMMERCE_ORDERS_SCOPE = 'orders:read';
/** The product write scope (the commerce-product-write capability). */
export const COMMERCE_PRODUCT_WRITE_SCOPE = 'products:write';
/** The listing management scope (the commerce-listing-manage capability). */
export const COMMERCE_LISTING_WRITE_SCOPE = 'listings:write';

/**
 * The scope a commerce operation requires from the provider credential
 * (pure): null when the operation needs NO provider scope (the legacy
 * MKT-024 CMS surface declares none). Scope names are the PROVIDER-side
 * authorization vocabulary the adapter checks against the credential
 * material's optional granted-scope list.
 */
export function requiredCommerceScopeForOperation(operation: string): string | null {
  switch (operation) {
    case 'listCatalog':
    case 'getProduct':
    case 'getPrice':
    case 'getInventory':
      return COMMERCE_READ_SCOPE;
    case 'listOrders':
    case 'listOrderDetails':
      return COMMERCE_ORDERS_SCOPE;
    case 'upsertProduct':
      return COMMERCE_PRODUCT_WRITE_SCOPE;
    case 'createListing':
    case 'updateListing':
    case 'endListing':
      return COMMERCE_LISTING_WRITE_SCOPE;
    default:
      return null;
  }
}

/**
 * The adapter-side AUTHORIZATION PRE-CHECK (pure refusal logic): the honest
 * error string when the credential material's granted-scope list does not
 * include the scope the operation requires, or null when the call may
 * proceed. A material WITHOUT a granted-scope list (grantedScopes null)
 * makes NO adapter-side claim — the provider decides at call time (the
 * MKT-024 backward-compatible posture: the scope list is optional provider
 * metadata). The adapter NEVER claims a mutation the provider does not
 * grant: with a scope list present, the required scope must be in it.
 */
export function commerceScopeProblem(
  operation: string,
  grantedScopes: readonly string[] | null,
): string | null {
  const required = requiredCommerceScopeForOperation(operation);
  if (required === null || grantedScopes === null) return null;
  if (grantedScopes.includes(required)) return null;
  return `commerce provider credential does not grant the scope required for operation '${operation}' (requires '${required}'; granted: ${
    grantedScopes.length === 0 ? '(none)' : grantedScopes.join(', ')
  }) — the operation is refused before any provider traffic`;
}

// ---------------------------------------------------------------------------
// Normalized mapping (pure) — the commerce read surface
// ---------------------------------------------------------------------------

/** The mapping outcome: normalized records as data, never a throw. */
export type CommerceMappingResult =
  | { readonly ok: true; readonly records: readonly NormalizedProviderRecord[] }
  | { readonly ok: false; readonly error: string };

/** The paged mapping outcome: records + the next-page cursor (or null). */
export type CommercePageMappingResult =
  | {
      readonly ok: true;
      readonly records: readonly NormalizedProviderRecord[];
      readonly pageCursor: string | null;
    }
  | { readonly ok: false; readonly error: string };

const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_STATUS_LENGTH = 64;
const MAX_ROW_COUNT = 200;
const MAX_LINE_ITEMS = 100;
const MAX_VARIANTS = 100;
const MAX_CATEGORY_IDS = 32;
const MAX_ATTRIBUTION_FIELDS = 32;
const MAX_ATTRIBUTION_VALUE_LENGTH = 512;

function boundedId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_PROVIDER_ID_LENGTH) return null;
  return trimmed;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxLength) return null;
  return trimmed;
}

/**
 * The attribution/reference fields VERBATIM as passthrough data
 * (architecture-v1.6.md §16): every scalar field of the provider's
 * attribution object is carried through UNMODIFIED (the field NAMES and
 * VALUES are the provider's — e.g. attributionRef, utmSource, utmCampaign,
 * landingRoute — never interpreted, matched or linked here). Fail-closed
 * honesty: non-scalar field values are rejected (the normalized contract
 * carries SCALAR reference fields), as are oversized values or field
 * counts. An absent attribution object normalizes to the empty object.
 */
export function normalizeCommerceAttribution(
  value: unknown,
): { readonly ok: true; readonly attribution: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly error: string } {
  if (value === null || value === undefined) return { ok: true, attribution: {} };
  const object = asObject(value);
  if (object === null) {
    return { ok: false, error: 'attribution must be a JSON object of scalar reference fields (passthrough)' };
  }
  const fields: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (Object.keys(object).length > MAX_ATTRIBUTION_FIELDS) {
      return { ok: false, error: `attribution carries more than ${MAX_ATTRIBUTION_FIELDS} reference fields` };
    }
    if (entry !== null && typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      return {
        ok: false,
        error: `attribution.${key} is not a scalar passthrough reference field (objects/arrays are rejected)`,
      };
    }
    if (typeof entry === 'string' && entry.length > MAX_ATTRIBUTION_VALUE_LENGTH) {
      return {
        ok: false,
        error: `attribution.${key} exceeds the ${MAX_ATTRIBUTION_VALUE_LENGTH}-character passthrough bound`,
      };
    }
    fields[key] = entry;
  }
  return { ok: true, attribution: fields };
}

/**
 * Pure mapping: a catalog response → category/product source records (the
 * paged catalog shape). Wire convention: { categories?: [...], products?:
 * [...], nextCursor?: string } with category rows { id, title?, parentId? }
 * and product rows { id, title, status, categoryIds?, variantCount?,
 * updatedAt? }. Required identity: non-empty ids; product rows additionally
 * require a title and a status. The page cursor is the provider's
 * nextCursor (null when absent/blank — the final page).
 */
export function mapCommerceCatalogResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommercePageMappingResult {
  const records: NormalizedProviderRecord[] = [];
  // A PRESENT key must be an array (an absent key is an empty page — a
  // malformed present key fails closed, never a silently-empty catalog).
  const categoriesRaw = payload['categories'];
  const categories = categoriesRaw === undefined ? [] : asArray(categoriesRaw);
  if (categories === null) {
    return { ok: false, error: "malformed catalog payload: 'categories' is not an array" };
  }
  const productsRaw = payload['products'];
  const products = productsRaw === undefined ? [] : asArray(productsRaw);
  if (products === null) {
    return { ok: false, error: "malformed catalog payload: 'products' is not an array" };
  }
  if (categories.length + products.length > MAX_ROW_COUNT) {
    return { ok: false, error: `catalog page carries more than ${MAX_ROW_COUNT} rows` };
  }
  for (const [index, entry] of categories.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed catalog payload: categories[${index}] is not an object` };
    }
    const id = boundedId(row['id']);
    if (id === null) {
      return { ok: false, error: `malformed catalog payload: categories[${index}].id is missing or invalid` };
    }
    const title = boundedText(row['title'], MAX_TITLE_LENGTH);
    const parentId = boundedId(row['parentId']);
    records.push({
      providerRecordId: `commerce:catalog:category:${id}`,
      data: sourceRecordEnvelope('commerce.category', {
        providerCategoryId: id,
        ...(title === null ? {} : { title }),
        ...(parentId === null ? {} : { parentCategoryId: parentId }),
      }) as unknown as Record<string, unknown>,
      sourceTimestamp: isoTimestampOrNull(row['updatedAt']),
      etag,
      sourceVersion: null,
    });
  }
  for (const [index, entry] of products.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed catalog payload: products[${index}] is not an object` };
    }
    const id = boundedId(row['id']);
    if (id === null) {
      return { ok: false, error: `malformed catalog payload: products[${index}].id is missing or invalid` };
    }
    const title = boundedText(row['title'], MAX_TITLE_LENGTH);
    if (title === null) {
      return { ok: false, error: `malformed catalog payload: products[${index}].title is missing` };
    }
    const status = boundedText(row['status'], MAX_STATUS_LENGTH);
    if (status === null) {
      return { ok: false, error: `malformed catalog payload: products[${index}].status is missing` };
    }
    const categoryIds = asArray(row['categoryIds']);
    if (categoryIds !== null && categoryIds.length > MAX_CATEGORY_IDS) {
      return { ok: false, error: `malformed catalog payload: products[${index}].categoryIds carries more than ${MAX_CATEGORY_IDS} entries` };
    }
    const providerCategoryIds: string[] = [];
    if (categoryIds !== null) {
      for (const [catIndex, catId] of categoryIds.entries()) {
        const bounded = boundedId(catId);
        if (bounded === null) {
          return {
            ok: false,
            error: `malformed catalog payload: products[${index}].categoryIds[${catIndex}] is not a valid identifier`,
          };
        }
        providerCategoryIds.push(bounded);
      }
    }
    const variantCount = parseNumberOrNull(row['variantCount']);
    records.push({
      providerRecordId: `commerce:catalog:product:${id}`,
      data: sourceRecordEnvelope('commerce.product', {
        providerProductId: id,
        title,
        status,
        ...(categoryIds === null ? {} : { providerCategoryIds }),
        ...(variantCount === null || !Number.isInteger(variantCount) ? {} : { variantCount }),
      }) as unknown as Record<string, unknown>,
      sourceTimestamp: isoTimestampOrNull(row['updatedAt']),
      etag,
      sourceVersion: null,
    });
  }
  const nextCursor = boundedText(payload['nextCursor'], MAX_PROVIDER_ID_LENGTH);
  return { ok: true, records, pageCursor: nextCursor };
}

/**
 * Pure mapping: a product detail response → one versioned product source
 * record. Wire convention: { product: { id, title, status, description?,
 * variants?: [{ id, title?, price?, currency?, inventory? }], updatedAt?,
 * version? } }. Required identity: the product id, title and status.
 */
export function mapCommerceProductResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const row = asObject(payload['product']);
  if (row === null) {
    return { ok: false, error: "malformed product payload: 'product' is not an object" };
  }
  const id = boundedId(row['id']);
  if (id === null) {
    return { ok: false, error: 'malformed product payload: product.id is missing or invalid' };
  }
  const title = boundedText(row['title'], MAX_TITLE_LENGTH);
  if (title === null) {
    return { ok: false, error: 'malformed product payload: product.title is missing' };
  }
  const status = boundedText(row['status'], MAX_STATUS_LENGTH);
  if (status === null) {
    return { ok: false, error: 'malformed product payload: product.status is missing' };
  }
  const description = boundedText(row['description'], 2000);
  const variantsRaw = asArray(row['variants']);
  if (variantsRaw !== null && variantsRaw.length > MAX_VARIANTS) {
    return { ok: false, error: `malformed product payload: more than ${MAX_VARIANTS} variants` };
  }
  const variants: Record<string, unknown>[] = [];
  if (variantsRaw !== null) {
    for (const [index, entry] of variantsRaw.entries()) {
      const variant = asObject(entry);
      if (variant === null) {
        return { ok: false, error: `malformed product payload: variants[${index}] is not an object` };
      }
      const variantId = boundedId(variant['id']);
      if (variantId === null) {
        return { ok: false, error: `malformed product payload: variants[${index}].id is missing or invalid` };
      }
      const variantTitle = boundedText(variant['title'], MAX_TITLE_LENGTH);
      const price = parseNumberOrNull(variant['price']);
      const currency = boundedText(variant['currency'], 16);
      const inventory = parseNumberOrNull(variant['inventory']);
      variants.push({
        providerVariantId: variantId,
        ...(variantTitle === null ? {} : { title: variantTitle }),
        ...(price === null ? {} : { price }),
        ...(currency === null ? {} : { currency }),
        ...(inventory === null || !Number.isInteger(inventory) ? {} : { inventory }),
      });
    }
  }
  const version = row['version'];
  const sourceVersion =
    typeof version === 'number'
      ? String(version)
      : typeof version === 'string' && version.trim() !== ''
        ? version
        : null;
  return {
    ok: true,
    records: [
      {
        providerRecordId: `commerce:product:${id}`,
        data: sourceRecordEnvelope('commerce.product.detail', {
          providerProductId: id,
          title,
          status,
          ...(description === null ? {} : { description }),
          ...(variantsRaw === null ? {} : { variants }),
          variantCount: variants.length,
        }) as unknown as Record<string, unknown>,
        sourceTimestamp: isoTimestampOrNull(row['updatedAt']),
        etag,
        sourceVersion,
      },
    ],
  };
}

/**
 * Pure mapping: a price response → one price source record. Wire
 * convention: { price: { productId, variantId?, amount, currency,
 * compareAtAmount?, updatedAt? } }. Required identity: the product id; the
 * amount must be numeric; the currency non-empty.
 */
export function mapCommercePriceResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const row = asObject(payload['price']);
  if (row === null) {
    return { ok: false, error: "malformed price payload: 'price' is not an object" };
  }
  const productId = boundedId(row['productId']);
  if (productId === null) {
    return { ok: false, error: 'malformed price payload: price.productId is missing or invalid' };
  }
  const variantId = boundedId(row['variantId']);
  const amount = parseNumberOrNull(row['amount']);
  if (amount === null) {
    return { ok: false, error: 'malformed price payload: price.amount is not a number' };
  }
  const currency = boundedText(row['currency'], 16);
  if (currency === null) {
    return { ok: false, error: 'malformed price payload: price.currency is missing' };
  }
  const compareAt = parseNumberOrNull(row['compareAtAmount']);
  return {
    ok: true,
    records: [
      {
        providerRecordId: `commerce:price:${productId}:${variantId ?? 'default'}`,
        data: sourceRecordEnvelope('commerce.price', {
          providerProductId: productId,
          ...(variantId === null ? {} : { providerVariantId: variantId }),
          amount,
          currency,
          ...(compareAt === null ? {} : { compareAtAmount: compareAt }),
        }) as unknown as Record<string, unknown>,
        sourceTimestamp: isoTimestampOrNull(row['updatedAt']),
        etag,
        sourceVersion: null,
      },
    ],
  };
}

/**
 * Pure mapping: an inventory response → one inventory source record. Wire
 * convention: { inventory: { productId, variantId?, available, reserved?,
 * incoming?, updatedAt? } }. Required identity: the product id; the
 * available count must be a non-negative integer.
 */
export function mapCommerceInventoryResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const row = asObject(payload['inventory']);
  if (row === null) {
    return { ok: false, error: "malformed inventory payload: 'inventory' is not an object" };
  }
  const productId = boundedId(row['productId']);
  if (productId === null) {
    return { ok: false, error: 'malformed inventory payload: inventory.productId is missing or invalid' };
  }
  const variantId = boundedId(row['variantId']);
  const available = parseNumberOrNull(row['available']);
  if (available === null || !Number.isInteger(available) || available < 0) {
    return { ok: false, error: 'malformed inventory payload: inventory.available is not a non-negative integer' };
  }
  const reserved = parseNumberOrNull(row['reserved']);
  const incoming = parseNumberOrNull(row['incoming']);
  return {
    ok: true,
    records: [
      {
        providerRecordId: `commerce:inventory:${productId}:${variantId ?? 'default'}`,
        data: sourceRecordEnvelope('commerce.inventory', {
          providerProductId: productId,
          ...(variantId === null ? {} : { providerVariantId: variantId }),
          available,
          ...(reserved === null || !Number.isInteger(reserved) ? {} : { reserved }),
          ...(incoming === null || !Number.isInteger(incoming) ? {} : { incoming }),
        }) as unknown as Record<string, unknown>,
        sourceTimestamp: isoTimestampOrNull(row['updatedAt']),
        etag,
        sourceVersion: null,
      },
    ],
  };
}

/** The normalized line-item shape of a commerce order. */
export interface CommerceOrderLineItem {
  readonly providerProductId: string;
  readonly providerVariantId?: string;
  readonly title?: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

/**
 * Pure mapping of ONE provider order row (the shared shape of the order
 * detail read and the order webhook event): the line-item shape with the
 * attribution/reference fields carried VERBATIM as passthrough data.
 * Required identity: the order id; status/currency non-empty; the total
 * numeric; lineItems a bounded array of objects each requiring a product
 * id, a positive integer quantity and a numeric unit price.
 */
export function normalizeCommerceOrderRow(
  row: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly order: Readonly<Record<string, unknown>> } | { readonly ok: false; readonly error: string } {
  const id = boundedId(row['id']);
  if (id === null) {
    return { ok: false, error: 'malformed order payload: id is missing or invalid' };
  }
  const status = boundedText(row['status'], MAX_STATUS_LENGTH);
  if (status === null) {
    return { ok: false, error: 'malformed order payload: status is missing' };
  }
  const currency = boundedText(row['currency'], 16);
  if (currency === null) {
    return { ok: false, error: 'malformed order payload: currency is missing' };
  }
  const total = parseNumberOrNull(row['total']);
  if (total === null) {
    return { ok: false, error: 'malformed order payload: total is not a number' };
  }
  const lineItemsRaw = asArray(row['lineItems']);
  if (lineItemsRaw === null) {
    return { ok: false, error: "malformed order payload: 'lineItems' is not an array" };
  }
  if (lineItemsRaw.length > MAX_LINE_ITEMS) {
    return { ok: false, error: `malformed order payload: more than ${MAX_LINE_ITEMS} line items` };
  }
  const lineItems: CommerceOrderLineItem[] = [];
  for (const [index, entry] of lineItemsRaw.entries()) {
    const item = asObject(entry);
    if (item === null) {
      return { ok: false, error: `malformed order payload: lineItems[${index}] is not an object` };
    }
    const productId = boundedId(item['productId']);
    if (productId === null) {
      return { ok: false, error: `malformed order payload: lineItems[${index}].productId is missing or invalid` };
    }
    const variantId = boundedId(item['variantId']);
    const title = boundedText(item['title'], MAX_TITLE_LENGTH);
    const quantity = parseNumberOrNull(item['quantity']);
    if (quantity === null || !Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: `malformed order payload: lineItems[${index}].quantity is not a positive integer` };
    }
    const unitPrice = parseNumberOrNull(item['unitPrice']);
    if (unitPrice === null) {
      return { ok: false, error: `malformed order payload: lineItems[${index}].unitPrice is not a number` };
    }
    lineItems.push({
      providerProductId: productId,
      ...(variantId === null ? {} : { providerVariantId: variantId }),
      ...(title === null ? {} : { title }),
      quantity,
      unitPrice,
    });
  }
  const attributionResult = normalizeCommerceAttribution(row['attribution']);
  if (!attributionResult.ok) {
    return { ok: false, error: `malformed order payload: ${attributionResult.error}` };
  }
  const number = boundedText(row['number'], MAX_PROVIDER_ID_LENGTH);
  const customerEmail = boundedText(row['customerEmail'], 320);
  const order: Record<string, unknown> = {
    providerOrderId: id,
    orderStatus: status,
    currency,
    total,
    lineItems,
    attribution: attributionResult.attribution,
    ...(number === null ? {} : { orderNumber: number }),
    ...(customerEmail === null ? {} : { customerEmail }),
  };
  const placedAt = isoTimestampOrNull(row['placedAt']);
  if (placedAt !== null) order['placedAt'] = placedAt;
  const updatedAt = isoTimestampOrNull(row['updatedAt']);
  if (updatedAt !== null) order['updatedAt'] = updatedAt;
  return { ok: true, order };
}

/**
 * Pure mapping: an order-details response → paged order source records
 * with the line-item shape + attribution passthrough. Wire convention:
 * { orders: [...], nextCursor? } with order rows validated by
 * normalizeCommerceOrderRow. The source timestamp is the order's updatedAt
 * (falling back to placedAt).
 */
export function mapCommerceOrderDetailsResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommercePageMappingResult {
  const rows = asArray(payload['orders']);
  if (rows === null) {
    return { ok: false, error: "malformed commerce payload: 'orders' is not an array" };
  }
  if (rows.length > MAX_ROW_COUNT) {
    return { ok: false, error: `order details page carries more than ${MAX_ROW_COUNT} rows` };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed commerce payload: orders[${index}] is not an object` };
    }
    const normalized = normalizeCommerceOrderRow(row);
    if (!normalized.ok) {
      return { ok: false, error: `malformed commerce payload: orders[${index}]: ${normalized.error}` };
    }
    records.push({
      providerRecordId: `commerce:order:${normalized.order['providerOrderId']}`,
      data: sourceRecordEnvelope('commerce.order', normalized.order) as unknown as Record<string, unknown>,
      sourceTimestamp:
        (typeof normalized.order['updatedAt'] === 'string' ? normalized.order['updatedAt'] : null) ??
        (typeof normalized.order['placedAt'] === 'string' ? normalized.order['placedAt'] : null),
      etag,
      sourceVersion: null,
    });
  }
  const nextCursor = boundedText(payload['nextCursor'], MAX_PROVIDER_ID_LENGTH);
  return { ok: true, records, pageCursor: nextCursor };
}

/**
 * Pure mapping: a product-listing response (the create/update/end mutation
 * outcome) → one listing source record. Wire convention: { listing: { id,
 * productId, variantId?, price, currency, quantity, status, updatedAt? } }.
 * Required identity: the listing id + product id; price numeric; currency
 * and status non-empty; quantity a non-negative integer.
 */
export function mapCommerceListingResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CommerceMappingResult {
  const row = asObject(payload['listing']);
  if (row === null) {
    return { ok: false, error: "malformed listing payload: 'listing' is not an object" };
  }
  const id = boundedId(row['id']);
  if (id === null) {
    return { ok: false, error: 'malformed listing payload: listing.id is missing or invalid' };
  }
  const productId = boundedId(row['productId']);
  if (productId === null) {
    return { ok: false, error: 'malformed listing payload: listing.productId is missing or invalid' };
  }
  const variantId = boundedId(row['variantId']);
  const price = parseNumberOrNull(row['price']);
  if (price === null) {
    return { ok: false, error: 'malformed listing payload: listing.price is not a number' };
  }
  const currency = boundedText(row['currency'], 16);
  if (currency === null) {
    return { ok: false, error: 'malformed listing payload: listing.currency is missing' };
  }
  const quantity = parseNumberOrNull(row['quantity']);
  if (quantity === null || !Number.isInteger(quantity) || quantity < 0) {
    return { ok: false, error: 'malformed listing payload: listing.quantity is not a non-negative integer' };
  }
  const status = boundedText(row['status'], MAX_STATUS_LENGTH);
  if (status === null) {
    return { ok: false, error: 'malformed listing payload: listing.status is missing' };
  }
  return {
    ok: true,
    records: [
      {
        providerRecordId: `commerce:listing:${id}`,
        data: sourceRecordEnvelope('commerce.listing', {
          providerListingId: id,
          providerProductId: productId,
          ...(variantId === null ? {} : { providerVariantId: variantId }),
          price,
          currency,
          quantity,
          listingStatus: status,
        }) as unknown as Record<string, unknown>,
        sourceTimestamp: isoTimestampOrNull(row['updatedAt']),
        etag,
        sourceVersion: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The webhook-event normalization (AC-3/AC-5 — the dedup identity + the
// normalized event projection input)
// ---------------------------------------------------------------------------

/**
 * THE RAW-EVENT HASH (AC-3 provenance): the sha256 hex digest of the
 * delivered payload's canonical JSON — recorded per delivery on the fence
 * receipt, so a replay with a MUTATED payload under a reused provider
 * event id is visible in the history (the duplicate receipt records ITS
 * OWN hash). Pure and deterministic: the same payload always hashes the
 * same (the dedup math is assertable by unit tests).
 */
export function sha256HexOfJson(payload: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * The normalized commerce event shape the adapter derives from a VERIFIED
 * webhook delivery: the event kind (closed vocabulary), the provider
 * subject identity, the provider's occurrence timestamp, the normalized
 * order or product body and the attribution/reference fields VERBATIM as
 * passthrough data (§16 — recorded, never interpreted).
 */
export interface NormalizedCommerceEvent {
  readonly kind: CommerceEventKind;
  readonly subjectId: string;
  /** The provider's occurrence timestamp (null when absent/invalid). */
  readonly occurredAt: string | null;
  readonly order?: Readonly<Record<string, unknown>>;
  readonly product?: Readonly<Record<string, unknown>>;
  readonly attribution: Readonly<Record<string, unknown>>;
}

/** The normalization outcome: the identity package as data, never a throw. */
export type CommerceWebhookEventResult =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      readonly providerEventId: string;
      readonly kind: CommerceEventKind;
      readonly subjectId: string;
      readonly shapeVersion: CommerceEventShapeVersion;
      readonly normalizedEvent: NormalizedCommerceEvent;
    };

/**
 * Pure normalization of a verified commerce webhook payload (the
 * order/product event wire convention):
 *   { eventId, kind, occurredAt?, order? | product? }
 * with the order/product body shaped exactly like the read-surface rows.
 * THE DEDUP IDENTITY (AC-3): the provider's own eventId — the (adapter
 * key, provider event id) pair is the webhook idempotency key. A payload
 * WITHOUT an eventId yields ok:false with the honest reason (the adapter
 * then falls back to the legacy non-idempotent event-stream path —
 * MKT-024 deliveries carried no event ids). Unknown kinds, malformed
 * bodies or non-scalar attribution fields fail closed with bounded errors.
 */
export function normalizeCommerceWebhookEvent(
  payload: Readonly<Record<string, unknown>>,
): CommerceWebhookEventResult {
  const eventId = boundedId(payload['eventId']);
  if (eventId === null) {
    return {
      ok: false,
      error: 'commerce event payload carries no provider eventId — the dedup identity is required for order/product event ingestion',
    };
  }
  const kindValue = payload['kind'];
  if (typeof kindValue !== 'string' || !(COMMERCE_EVENT_KINDS as readonly string[]).includes(kindValue)) {
    return {
      ok: false,
      error: `commerce event payload kind '${String(kindValue)}' is outside the closed order/product event vocabulary`,
    };
  }
  const kind = kindValue as CommerceEventKind;
  const occurredAt = isoTimestampOrNull(payload['occurredAt']);
  if (kind.startsWith('order.')) {
    const row = asObject(payload['order']);
    if (row === null) {
      return { ok: false, error: "commerce order event payload carries no 'order' object" };
    }
    const normalized = normalizeCommerceOrderRow(row);
    if (!normalized.ok) {
      return { ok: false, error: `commerce order event payload: ${normalized.error}` };
    }
    return {
      ok: true,
      providerEventId: eventId,
      kind,
      subjectId: String(normalized.order['providerOrderId']),
      shapeVersion: 'commerce-order-v1',
      normalizedEvent: {
        kind,
        subjectId: String(normalized.order['providerOrderId']),
        occurredAt,
        order: normalized.order,
        attribution: normalized.order['attribution'] as Readonly<Record<string, unknown>>,
      },
    };
  }
  const row = asObject(payload['product']);
  if (row === null) {
    return { ok: false, error: "commerce product event payload carries no 'product' object" };
  }
  const productId = boundedId(row['id']);
  if (productId === null) {
    return { ok: false, error: 'commerce product event payload: product.id is missing or invalid' };
  }
  const title = boundedText(row['title'], MAX_TITLE_LENGTH);
  if (title === null) {
    return { ok: false, error: 'commerce product event payload: product.title is missing' };
  }
  const status = boundedText(row['status'], MAX_STATUS_LENGTH);
  if (status === null) {
    return { ok: false, error: 'commerce product event payload: product.status is missing' };
  }
  return {
    ok: true,
    providerEventId: eventId,
    kind,
    subjectId: productId,
    shapeVersion: 'commerce-product-v1',
    normalizedEvent: {
      kind,
      subjectId: productId,
      occurredAt,
      product: {
        providerProductId: productId,
        title,
        status,
      },
      attribution: {},
    },
  };
}

/**
 * The ADAPTER-side composition of the generic WebhookEventIdentity (the
 * port's idempotency metadata) from a normalized commerce event — the
 * single shape the module consumes for the dedup fence + projection.
 */
export function commerceWebhookEventIdentity(
  normalization: Extract<CommerceWebhookEventResult, { ok: true }>,
): WebhookEventIdentity {
  return {
    providerEventId: normalization.providerEventId,
    eventKind: normalization.kind,
    eventSubjectId: normalization.subjectId,
    normalizedShapeVersion: normalization.shapeVersion,
    normalizedEvent: normalization.normalizedEvent as unknown as Record<string, unknown>,
  };
}
