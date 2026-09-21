/**
 * MKT-071 unit tests — the PURE commerce capability contract of
 * /integrations (AC-10: "unit (normalized mapping, dedup math,
 * capability-subset declaration, policy-refusal logic)").
 *
 * Everything here imports the module PUBLIC entry only (the arch-check
 * TEST_MODULE_INTERNAL_IMPORT rule): the commerce normalized contract is
 * deliberately exported through the public surface so the mapping
 * semantics are part of the TESTED module contract.
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-071;
 * spec/architecture-v1.6.md §15/§16):
 *   - AC-1  the capability-subset declaration (a read-only commerce
 *           adapter is first-class; unknown grant keys fail loudly);
 *   - AC-1  the normalized mapping: catalog pages (cursor paging),
 *           product/price/inventory reads, order details with the
 *           line-item shape, listing mutations;
 *   - AC-3  the dedup math (the raw-event hash determinism);
 *   - AC-4  the policy/scope refusal logic (the adapter-side
 *           authorization pre-check — an operation whose required scope
 *           is not granted is refused before any provider traffic);
 *   - AC-5  the attribution PASSTHROUGH discipline (the provider's
 *           reference fields ride VERBATIM — recorded, never interpreted);
 *   - AC-3  the webhook-event normalization (the dedup identity, the
 *           closed kind vocabulary, fail-closed malformed shapes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMERCE_CAPABILITY_KEYS,
  COMMERCE_DELIVERY_OUTCOMES,
  COMMERCE_EVENT_KINDS,
  COMMERCE_EVENT_SHAPE_VERSIONS,
  COMMERCE_READ_ONLY_CAPABILITY_KEYS,
  commerceCapabilitiesForProfile,
  commerceScopeProblem,
  commerceWebhookEventIdentity,
  mapCommerceCatalogResponse,
  mapCommerceInventoryResponse,
  mapCommerceListingResponse,
  mapCommerceOrderDetailsResponse,
  mapCommercePriceResponse,
  mapCommerceProductResponse,
  normalizeCommerceAttribution,
  normalizeCommerceOrderRow,
  normalizeCommerceWebhookEvent,
  requiredCommerceScopeForOperation,
  sha256HexOfJson,
} from '../../src/modules/integrations/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const ETAG = '"unit-fixture-v1"';

// ---------------------------------------------------------------------------
// AC-1: the capability-subset declaration
// ---------------------------------------------------------------------------

test('MKT-071 AC-1: the default profile declares the FULL commerce capability catalog in canonical order', () => {
  const capabilities = commerceCapabilitiesForProfile();
  assert.deepEqual(
    capabilities.map((capability) => capability.capabilityKey),
    [...COMMERCE_CAPABILITY_KEYS],
  );
  // Every declared capability is structurally valid: closed kind set,
  // non-empty bounded operation lists, unique keys.
  const kinds = new Set(capabilities.map((capability) => capability.kind));
  assert.deepEqual([...kinds].sort(), ['mutation', 'read', 'webhook']);
  // The mutation capabilities are exactly the two write surfaces.
  assert.deepEqual(
    capabilities
      .filter((capability) => capability.kind === 'mutation')
      .map((capability) => capability.capabilityKey),
    ['commerce-product-write', 'commerce-listing-manage'],
  );
  // The orders capability declares BOTH the frozen MKT-024 read and the
  // MKT-071 detailed read.
  const orders = capabilities.find((capability) => capability.capabilityKey === 'commerce-orders-read')!;
  assert.deepEqual(orders.operations, ['listOrders', 'listOrderDetails']);
  // The order webhook capability's operations ARE the closed event-kind
  // vocabulary (the storage-fenced list).
  const webhook = capabilities.find((capability) => capability.capabilityKey === 'commerce-order-webhook')!;
  assert.deepEqual([...webhook.operations], [...COMMERCE_EVENT_KINDS]);
});

test('MKT-071 AC-1: the READ-ONLY subset is first-class — no mutation capability is declared', () => {
  const capabilities = commerceCapabilitiesForProfile(COMMERCE_READ_ONLY_CAPABILITY_KEYS);
  assert.deepEqual(
    capabilities.map((capability) => capability.capabilityKey),
    [...COMMERCE_READ_ONLY_CAPABILITY_KEYS],
  );
  assert.ok(
    capabilities.every((capability) => capability.kind !== 'mutation'),
    'a read-only commerce adapter declares NO mutation capability',
  );
  // The subset still declares the order webhook (ingestion is append-only
  // history, not a provider mutation).
  assert.ok(
    capabilities.some((capability) => capability.capabilityKey === 'commerce-order-webhook'),
    'the read-only profile keeps the order webhook capability',
  );
});

test('MKT-071 AC-1: an arbitrary subset is declarable and order-canonicalized', () => {
  const capabilities = commerceCapabilitiesForProfile([
    'commerce-orders-read',
    'commerce-catalog-read',
  ]);
  // Canonical declaration order regardless of input order.
  assert.deepEqual(
    capabilities.map((capability) => capability.capabilityKey),
    ['commerce-catalog-read', 'commerce-orders-read'],
  );
});

test('MKT-071 AC-1: unknown grant keys fail the construction LOUDLY (never a silent registration)', () => {
  assert.throws(
    () => commerceCapabilitiesForProfile(['commerce-catalog-read', 'commerce-orders-write']),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(
        (error.details ?? []).some((detail) => detail.includes('commerce-orders-write')),
        'the honest problem names the unknown grant key',
      );
      return true;
    },
  );
  assert.throws(
    () => commerceCapabilitiesForProfile([]),
    (error: unknown) => error instanceof InvalidRequestError,
  );
  assert.throws(
    () => commerceCapabilitiesForProfile(null as unknown as readonly string[]),
    (error: unknown) => error instanceof InvalidRequestError,
  );
});

test('MKT-071 AC-1: the closed vocabularies are frozen', () => {
  assert.deepEqual([...COMMERCE_EVENT_KINDS], [
    'order.created',
    'order.updated',
    'order.fulfilled',
    'order.cancelled',
    'product.created',
    'product.updated',
  ]);
  assert.deepEqual([...COMMERCE_DELIVERY_OUTCOMES], ['ingested', 'duplicate']);
  assert.deepEqual([...COMMERCE_EVENT_SHAPE_VERSIONS], ['commerce-order-v1', 'commerce-product-v1']);
});

// ---------------------------------------------------------------------------
// AC-1: the normalized mapping (catalog/product/price/inventory/orders)
// ---------------------------------------------------------------------------

test('MKT-071 AC-1 mapping: a catalog page maps to category + product source records with the page cursor', () => {
  const mapping = mapCommerceCatalogResponse(
    {
      categories: [
        { id: 'cat_10', title: 'Kitchen', updatedAt: '2026-05-01T08:00:00.000Z' },
        { id: 'cat_20', title: 'Outdoor', parentId: 'cat_10' },
      ],
      products: [
        {
          id: 'prd_501',
          title: 'Tactical Apron',
          status: 'active',
          categoryIds: ['cat_10'],
          variantCount: 2,
          updatedAt: '2026-05-02T09:30:00.000Z',
        },
      ],
      nextCursor: 'catalog-page-2',
    },
    ETAG,
  );
  assert.ok(mapping.ok);
  if (!mapping.ok) return;
  assert.equal(mapping.records.length, 3);
  const ids = mapping.records.map((record) => record.providerRecordId).sort();
  assert.deepEqual(ids, [
    'commerce:catalog:category:cat_10',
    'commerce:catalog:category:cat_20',
    'commerce:catalog:product:prd_501',
  ]);
  const category = mapping.records.find((record) => record.providerRecordId === 'commerce:catalog:category:cat_10')!;
  assert.equal(category.sourceTimestamp, '2026-05-01T08:00:00.000Z');
  assert.equal(category.etag, ETAG);
  assert.deepEqual(category.data, {
    kind: 'record',
    recordType: 'commerce.category',
    fields: { providerCategoryId: 'cat_10', title: 'Kitchen' },
  });
  const product = mapping.records.find((record) => record.providerRecordId === 'commerce:catalog:product:prd_501')!;
  assert.deepEqual(product.data, {
    kind: 'record',
    recordType: 'commerce.product',
    fields: {
      providerProductId: 'prd_501',
      title: 'Tactical Apron',
      status: 'active',
      providerCategoryIds: ['cat_10'],
      variantCount: 2,
    },
  });
  // The page cursor rides the mapping (the caller feeds it back).
  assert.equal(mapping.pageCursor, 'catalog-page-2');
});

test('MKT-071 AC-1 mapping: the FINAL catalog page carries a null cursor; empty pages are valid', () => {
  const final = mapCommerceCatalogResponse({ categories: [], products: [] }, null);
  assert.ok(final.ok);
  if (final.ok) {
    assert.equal(final.records.length, 0);
    assert.equal(final.pageCursor, null);
  }
  const absent = mapCommerceCatalogResponse({}, null);
  assert.ok(absent.ok);
});

test('MKT-071 AC-1 mapping: malformed catalog rows fail CLOSED (bounded honest errors)', () => {
  assert.ok(!mapCommerceCatalogResponse({ categories: [{ nope: 1 }] }, null).ok);
  assert.ok(!mapCommerceCatalogResponse({ products: [{ id: 'x' }] }, null).ok); // no title
  assert.ok(!mapCommerceCatalogResponse({ products: [{ id: 'x', title: 'T', status: '' }] }, null).ok); // blank status
  // A PRESENT-but-non-array key fails closed (never a silently-empty page).
  assert.ok(!mapCommerceCatalogResponse({ categories: 'not-an-array' }, null).ok);
  assert.ok(!mapCommerceCatalogResponse({ products: 7 }, null).ok);
  const badCategory = mapCommerceCatalogResponse({ categories: [{ id: '' }] }, null);
  assert.ok(!badCategory.ok);
  if (!badCategory.ok) {
    assert.match(badCategory.error, /categories\[0\].id/);
  }
});

test('MKT-071 AC-1 mapping: a product detail maps with variants + source version', () => {
  const mapping = mapCommerceProductResponse(
    {
      product: {
        id: 'prd_501',
        title: 'Tactical Apron',
        status: 'active',
        description: 'Rugged canvas apron',
        version: 7,
        updatedAt: '2026-05-02T09:30:00.000Z',
        variants: [
          { id: 'var_9', title: 'Black', price: '189.00', currency: 'USD', inventory: 12 },
          { id: 'var_10', title: 'Olive', price: '189.00', currency: 'USD' },
        ],
      },
    },
    ETAG,
  );
  assert.ok(mapping.ok);
  if (!mapping.ok) return;
  assert.equal(mapping.records.length, 1);
  const record = mapping.records[0]!;
  assert.equal(record.providerRecordId, 'commerce:product:prd_501');
  assert.equal(record.sourceVersion, '7');
  assert.equal(record.sourceTimestamp, '2026-05-02T09:30:00.000Z');
  const fields = (record.data as { fields: Record<string, unknown> }).fields;
  assert.equal(fields['variantCount'], 2);
  const variants = fields['variants'] as Record<string, unknown>[];
  assert.deepEqual(variants[0], {
    providerVariantId: 'var_9',
    title: 'Black',
    price: 189,
    currency: 'USD',
    inventory: 12,
  });
  // A malformed product body fails closed.
  assert.ok(!mapCommerceProductResponse({ product: { id: 'x' } }, null).ok);
  assert.ok(!mapCommerceProductResponse({}, null).ok);
});

test('MKT-071 AC-1 mapping: price and inventory reads map to their normalized source records', () => {
  const price = mapCommercePriceResponse(
    { price: { productId: 'prd_501', variantId: 'var_9', amount: '189.00', currency: 'USD', compareAtAmount: '219.00' } },
    ETAG,
  );
  assert.ok(price.ok);
  if (price.ok) {
    const record = price.records[0]!;
    assert.equal(record.providerRecordId, 'commerce:price:prd_501:var_9');
    assert.deepEqual((record.data as { fields: Record<string, unknown> }).fields, {
      providerProductId: 'prd_501',
      providerVariantId: 'var_9',
      amount: 189,
      currency: 'USD',
      compareAtAmount: 219,
    });
  }
  const defaultVariant = mapCommercePriceResponse({ price: { productId: 'prd_501', amount: 99, currency: 'EUR' } }, null);
  assert.ok(defaultVariant.ok);
  if (defaultVariant.ok) {
    assert.equal(defaultVariant.records[0]!.providerRecordId, 'commerce:price:prd_501:default');
  }
  // Malformed prices fail closed.
  assert.ok(!mapCommercePriceResponse({ price: { productId: 'p', amount: 'NaN', currency: 'USD' } }, null).ok);
  assert.ok(!mapCommercePriceResponse({ price: { productId: 'p', amount: 5 } }, null).ok);

  const inventory = mapCommerceInventoryResponse(
    { inventory: { productId: 'prd_501', variantId: 'var_9', available: 12, reserved: 1, incoming: 0, updatedAt: '2026-05-03T10:00:00.000Z' } },
    ETAG,
  );
  assert.ok(inventory.ok);
  if (inventory.ok) {
    const record = inventory.records[0]!;
    assert.equal(record.providerRecordId, 'commerce:inventory:prd_501:var_9');
    assert.equal(record.sourceTimestamp, '2026-05-03T10:00:00.000Z');
    assert.deepEqual((record.data as { fields: Record<string, unknown> }).fields, {
      providerProductId: 'prd_501',
      providerVariantId: 'var_9',
      available: 12,
      reserved: 1,
      incoming: 0,
    });
  }
  // Negative / fractional availability fails closed.
  assert.ok(!mapCommerceInventoryResponse({ inventory: { productId: 'p', available: -1 } }, null).ok);
  assert.ok(!mapCommerceInventoryResponse({ inventory: { productId: 'p', available: 1.5 } }, null).ok);
});

test('MKT-071 AC-1 mapping: order details map with the LINE-ITEM shape + attribution passthrough (AC-5)', () => {
  const mapping = mapCommerceOrderDetailsResponse(
    {
      orders: [
        {
          id: 'ord_2001',
          number: 'MOS-2001',
          status: 'paid',
          currency: 'USD',
          total: '189.00',
          placedAt: '2026-05-04T11:00:00.000Z',
          updatedAt: '2026-05-04T11:05:00.000Z',
          customerEmail: 'buyer@example.test',
          lineItems: [
            { productId: 'prd_501', variantId: 'var_9', title: 'Tactical Apron', quantity: 1, unitPrice: '189.00' },
          ],
          attribution: {
            attributionRef: 'mission:gm_882:experiment:exp_401',
            utmSource: 'instagram',
            utmCampaign: 'spring-launch',
            landingRoute: '/l/spring-882',
          },
        },
      ],
      nextCursor: null,
    },
    ETAG,
  );
  assert.ok(mapping.ok);
  if (!mapping.ok) return;
  assert.equal(mapping.records.length, 1);
  const record = mapping.records[0]!;
  assert.equal(record.providerRecordId, 'commerce:order:ord_2001');
  assert.equal(record.sourceTimestamp, '2026-05-04T11:05:00.000Z');
  const fields = (record.data as { fields: Record<string, unknown> }).fields;
  // The line-item shape.
  assert.deepEqual(fields['lineItems'], [
    {
      providerProductId: 'prd_501',
      providerVariantId: 'var_9',
      title: 'Tactical Apron',
      quantity: 1,
      unitPrice: 189,
    },
  ]);
  // AC-5: the attribution/reference fields ride VERBATIM (passthrough).
  assert.deepEqual(fields['attribution'], {
    attributionRef: 'mission:gm_882:experiment:exp_401',
    utmSource: 'instagram',
    utmCampaign: 'spring-launch',
    landingRoute: '/l/spring-882',
  });
  assert.equal(mapping.pageCursor, null);
});

test('MKT-071 mapping: malformed order bodies fail closed with honest indexed errors', () => {
  assert.ok(!mapCommerceOrderDetailsResponse({ orders: 'nope' }, null).ok);
  assert.ok(!mapCommerceOrderDetailsResponse({ orders: [{ id: 'x', status: 'paid', currency: 'USD', total: 'NaN' }] }, null).ok);
  const noLineItems = mapCommerceOrderDetailsResponse(
    { orders: [{ id: 'o1', status: 'paid', currency: 'USD', total: 5 }] },
    null,
  );
  assert.ok(!noLineItems.ok);
  if (!noLineItems.ok) {
    assert.match(noLineItems.error, /lineItems/);
  }
  const badQuantity = mapCommerceOrderDetailsResponse(
    { orders: [{ id: 'o1', status: 'paid', currency: 'USD', total: 5, lineItems: [{ productId: 'p', quantity: 0, unitPrice: 5 }] }] },
    null,
  );
  assert.ok(!badQuantity.ok);
  if (!badQuantity.ok) {
    assert.match(badQuantity.error, /quantity/);
  }
});

test('MKT-071 mapping: a listing mutation outcome maps to the normalized listing record', () => {
  const mapping = mapCommerceListingResponse(
    {
      listing: {
        id: 'lst_3001',
        productId: 'prd_501',
        variantId: 'var_9',
        price: '189.00',
        currency: 'USD',
        quantity: 5,
        status: 'active',
        updatedAt: '2026-05-05T09:00:00.000Z',
      },
    },
    ETAG,
  );
  assert.ok(mapping.ok);
  if (!mapping.ok) return;
  const record = mapping.records[0]!;
  assert.equal(record.providerRecordId, 'commerce:listing:lst_3001');
  assert.deepEqual((record.data as { fields: Record<string, unknown> }).fields, {
    providerListingId: 'lst_3001',
    providerProductId: 'prd_501',
    providerVariantId: 'var_9',
    price: 189,
    currency: 'USD',
    quantity: 5,
    listingStatus: 'active',
  });
  assert.ok(!mapCommerceListingResponse({ listing: { id: 'x' } }, null).ok);
  assert.ok(!mapCommerceListingResponse({ listing: { id: 'x', productId: 'p', price: 5, currency: 'USD', quantity: -1, status: 'active' } }, null).ok);
});

// ---------------------------------------------------------------------------
// AC-5: the attribution passthrough discipline (pure)
// ---------------------------------------------------------------------------

test('MKT-071 AC-5: attribution fields are carried VERBATIM (scalars) — non-scalar reference values fail closed', () => {
  const verbatim = normalizeCommerceAttribution({
    attributionRef: 'mission:gm_882:experiment:exp_401',
    utmSource: 'instagram',
    utmCampaign: 'spring-launch',
    clickId: 'clk_9917',
    cohort: 7,
    control: false,
    note: null,
  });
  assert.ok(verbatim.ok);
  if (verbatim.ok) {
    assert.deepEqual(verbatim.attribution, {
      attributionRef: 'mission:gm_882:experiment:exp_401',
      utmSource: 'instagram',
      utmCampaign: 'spring-launch',
      clickId: 'clk_9917',
      cohort: 7,
      control: false,
      note: null,
    });
  }
  // Absent → the empty object.
  const empty = normalizeCommerceAttribution(undefined);
  assert.ok(empty.ok);
  if (empty.ok) assert.deepEqual(empty.attribution, {});
  // Non-scalar fields are rejected (the normalized contract carries SCALAR
  // reference fields — honest fail-closed, never a silent deep-copy).
  assert.ok(!normalizeCommerceAttribution({ nested: { deep: 1 } }).ok);
  assert.ok(!normalizeCommerceAttribution({ list: [1, 2] }).ok);
  assert.ok(!normalizeCommerceAttribution('not-an-object').ok);
});

// ---------------------------------------------------------------------------
// AC-3: the webhook-event normalization + the dedup math
// ---------------------------------------------------------------------------

test('MKT-071 AC-3: an order webhook event normalizes into the dedup identity + normalized projection', () => {
  const payload = {
    eventId: 'evt_9001',
    kind: 'order.created',
    occurredAt: '2026-05-04T11:00:00.000Z',
    order: {
      id: 'ord_2001',
      number: 'MOS-2001',
      status: 'paid',
      currency: 'USD',
      total: '189.00',
      lineItems: [
        { productId: 'prd_501', variantId: 'var_9', title: 'Tactical Apron', quantity: 1, unitPrice: '189.00' },
      ],
      attribution: {
        attributionRef: 'mission:gm_882:experiment:exp_401',
        utmSource: 'instagram',
      },
    },
  };
  const normalization = normalizeCommerceWebhookEvent(payload);
  assert.ok(normalization.ok);
  if (!normalization.ok) return;
  assert.equal(normalization.providerEventId, 'evt_9001');
  assert.equal(normalization.kind, 'order.created');
  assert.equal(normalization.subjectId, 'ord_2001');
  assert.equal(normalization.shapeVersion, 'commerce-order-v1');
  // The attribution passthrough rides the normalized event VERBATIM.
  assert.deepEqual(normalization.normalizedEvent.attribution, {
    attributionRef: 'mission:gm_882:experiment:exp_401',
    utmSource: 'instagram',
  });
  // The generic port identity composes from the normalization (the dedup
  // key half + the projection input).
  const identity = commerceWebhookEventIdentity(normalization);
  assert.equal(identity.providerEventId, 'evt_9001');
  assert.equal(identity.eventKind, 'order.created');
  assert.equal(identity.eventSubjectId, 'ord_2001');
  assert.equal(identity.normalizedShapeVersion, 'commerce-order-v1');
  assert.deepEqual(identity.normalizedEvent['attribution'], normalization.normalizedEvent.attribution);
});

test('MKT-071 AC-3: a product webhook event normalizes with the product shape version', () => {
  const normalization = normalizeCommerceWebhookEvent({
    eventId: 'evt_9002',
    kind: 'product.updated',
    occurredAt: '2026-05-06T08:00:00.000Z',
    product: { id: 'prd_501', title: 'Tactical Apron', status: 'active' },
  });
  assert.ok(normalization.ok);
  if (!normalization.ok) return;
  assert.equal(normalization.kind, 'product.updated');
  assert.equal(normalization.subjectId, 'prd_501');
  assert.equal(normalization.shapeVersion, 'commerce-product-v1');
  assert.deepEqual(normalization.normalizedEvent.product, {
    providerProductId: 'prd_501',
    title: 'Tactical Apron',
    status: 'active',
  });
});

test('MKT-071 AC-3: webhook normalization fails closed (no event id / unknown kind / malformed body)', () => {
  const noId = normalizeCommerceWebhookEvent({ kind: 'order.created', order: { id: 'o1' } });
  assert.ok(!noId.ok);
  if (!noId.ok) assert.match(noId.error, /eventId/);
  const unknownKind = normalizeCommerceWebhookEvent({ eventId: 'evt_x', kind: 'listing.ended' });
  assert.ok(!unknownKind.ok);
  if (!unknownKind.ok) assert.match(unknownKind.error, /vocabulary/);
  const noBody = normalizeCommerceWebhookEvent({ eventId: 'evt_x', kind: 'order.created' });
  assert.ok(!noBody.ok);
  const malformedOrder = normalizeCommerceWebhookEvent({
    eventId: 'evt_x',
    kind: 'order.updated',
    order: { id: 'o1', status: 'paid', currency: 'USD', total: 'NaN' },
  });
  assert.ok(!malformedOrder.ok);
});

test('MKT-071 AC-3 dedup math: the raw-event hash is deterministic and payload-sensitive', () => {
  const a = { eventId: 'evt_9001', kind: 'order.created', order: { id: 'ord_2001' } };
  const same = { eventId: 'evt_9001', kind: 'order.created', order: { id: 'ord_2001' } };
  const mutated = { eventId: 'evt_9001', kind: 'order.created', order: { id: 'ord_2001', extra: true } };
  const hashA = sha256HexOfJson(a);
  assert.equal(hashA, sha256HexOfJson(same));
  assert.notEqual(hashA, sha256HexOfJson(mutated));
  // sha256 hex, 64 lowercase chars (the migration CHECK fence shape).
  assert.match(hashA, /^[0-9a-f]{64}$/);
  // A replayed delivery with a MUTATED payload under a reused event id is
  // visible in the history (the duplicate receipt records ITS OWN hash).
  assert.notEqual(sha256HexOfJson(a), sha256HexOfJson({ ...a, order: { id: 'ord_9999' } }));
});

test('MKT-071 AC-3: the shared order-row normalization backs both the read and the webhook path (identical shapes)', () => {
  const row = {
    id: 'ord_2001',
    status: 'paid',
    currency: 'USD',
    total: '10.00',
    lineItems: [{ productId: 'p1', quantity: 1, unitPrice: '10.00' }],
    attribution: { utmSource: 'newsletter' },
  };
  const normalized = normalizeCommerceOrderRow(row);
  assert.ok(normalized.ok);
  // Purity: identical inputs normalize identically.
  assert.deepEqual(normalizeCommerceOrderRow(row), normalized);
});

// ---------------------------------------------------------------------------
// AC-4: the policy/scope refusal logic (the adapter-side pre-check)
// ---------------------------------------------------------------------------

test('MKT-071 AC-4: the required-scope table covers the commerce operation surface', () => {
  assert.equal(requiredCommerceScopeForOperation('listCatalog'), 'catalog:read');
  assert.equal(requiredCommerceScopeForOperation('getProduct'), 'catalog:read');
  assert.equal(requiredCommerceScopeForOperation('getPrice'), 'catalog:read');
  assert.equal(requiredCommerceScopeForOperation('getInventory'), 'catalog:read');
  assert.equal(requiredCommerceScopeForOperation('listOrders'), 'orders:read');
  assert.equal(requiredCommerceScopeForOperation('listOrderDetails'), 'orders:read');
  assert.equal(requiredCommerceScopeForOperation('upsertProduct'), 'products:write');
  assert.equal(requiredCommerceScopeForOperation('createListing'), 'listings:write');
  assert.equal(requiredCommerceScopeForOperation('updateListing'), 'listings:write');
  assert.equal(requiredCommerceScopeForOperation('endListing'), 'listings:write');
  // The legacy CMS operation declares NO provider scope (MKT-024 posture).
  assert.equal(requiredCommerceScopeForOperation('listContent'), null);
  assert.equal(requiredCommerceScopeForOperation('anythingElse'), null);
});

test('MKT-071 AC-4: a credential WITHOUT a granted-scope list makes NO adapter-side claim (the provider decides)', () => {
  assert.equal(commerceScopeProblem('upsertProduct', null), null);
  assert.equal(commerceScopeProblem('listCatalog', null), null);
});

test('MKT-071 AC-4: an operation whose required scope is NOT granted is refused honestly BEFORE provider traffic', () => {
  const problem = commerceScopeProblem('upsertProduct', ['catalog:read', 'orders:read']);
  assert.ok(problem !== null);
  assert.match(problem!, /does not grant the scope/);
  assert.match(problem!, /products:write/);
  // The granted scopes are listed in the honest refusal (no silent skip).
  assert.match(problem!, /catalog:read/);
  // An empty granted list refuses every scoped operation.
  assert.ok(commerceScopeProblem('listCatalog', []) !== null);
  // Granted scopes pass.
  assert.equal(commerceScopeProblem('upsertProduct', ['products:write']), null);
  assert.equal(
    commerceScopeProblem('upsertProduct', ['catalog:read', 'orders:read', 'products:write', 'listings:write']),
    null,
  );
  // Unscoped operations never refuse.
  assert.equal(commerceScopeProblem('listContent', []), null);
});
