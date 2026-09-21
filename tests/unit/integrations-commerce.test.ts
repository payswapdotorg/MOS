/**
 * MKT-071 unit tests — the pure /integrations COMMERCE contract surfaces:
 * the frozen commerce vocabularies (capability keys, event kinds,
 * outcomes, mutation capability keys), the capability-subset adapter
 * declaration guard (the read-only commerce adapter is first-class; the
 * 'commerce-' namespace is a closed vocabulary), the normalized provider
 * event guard (§21 backstop included), the raw-event hash (the dedup
 * math), and the shared commerce provider JSON convention → normalized
 * source-record mapping (catalog pages, product, price, inventory, order
 * records with line items + attribution passthrough, mutation results,
 * identified webhook events).
 *
 * The behavioral half (round-trips, the fence, policy gates, isolation)
 * lives in tests/integration/integrations-commerce.test.ts; the static
 * isolation proofs in tests/architecture/integrations-commerce-boundary.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assertValidAdapterRegistration,
  assertValidNormalizedProviderEvent,
  buildAdapterRegistry,
  buildNormalizedCommerceEvent,
  COMMERCE_CAPABILITY_KEYS,
  COMMERCE_EVENT_KINDS,
  COMMERCE_EVENT_OUTCOMES,
  COMMERCE_EVENT_SHAPE_VERSION,
  COMMERCE_MUTATION_CAPABILITY_KEYS,
  hashWebhookPayload,
  isCommerceMutationCapability,
  mapCommerceCatalogPageResponse,
  mapCommerceInventoryResponse,
  mapCommerceMutationResponse,
  mapCommerceOrderRecordsResponse,
  mapCommerceOrdersResponse,
  mapCommercePriceResponse,
  mapCommerceProductResponse,
  type NormalizedProviderEvent,
  type IntegrationAdapter,
} from '../../src/modules/integrations/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (AC-1/AC-9)
// ---------------------------------------------------------------------------

test('MKT-071: the commerce capability-key vocabulary is frozen (9 keys: the 8 MKT-071 keys + the MKT-024 event-stream continuity)', () => {
  assert.deepEqual(COMMERCE_CAPABILITY_KEYS, [
    'commerce-catalog-read',
    'commerce-product-read',
    'commerce-product-write',
    'commerce-listing-manage',
    'commerce-price-read',
    'commerce-inventory-read',
    'commerce-orders-read',
    'commerce-order-webhook',
    'commerce-event-stream',
  ]);
  // The MKT-024 continuity: the orders-read and event-stream keys predate
  // MKT-071 and stay first-class.
  assert.ok(COMMERCE_CAPABILITY_KEYS.includes('commerce-orders-read'));
  assert.ok(COMMERCE_CAPABILITY_KEYS.includes('commerce-event-stream'));
});

test('MKT-071: the commerce event-kind and outcome vocabularies are frozen (mirrored by the migration-049 CHECKs)', () => {
  assert.deepEqual(COMMERCE_EVENT_KINDS, ['order', 'product', 'listing']);
  assert.deepEqual(COMMERCE_EVENT_OUTCOMES, ['ingested', 'duplicate-received']);
  assert.equal(COMMERCE_EVENT_SHAPE_VERSION, 'commerce-event-v1');
});

test('MKT-071 AC-4: the mutating commerce capability keys are exactly product-write and listing-manage', () => {
  assert.deepEqual(COMMERCE_MUTATION_CAPABILITY_KEYS, ['commerce-product-write', 'commerce-listing-manage']);
  assert.equal(isCommerceMutationCapability('commerce-product-write'), true);
  assert.equal(isCommerceMutationCapability('commerce-listing-manage'), true);
  assert.equal(isCommerceMutationCapability('commerce-orders-read'), false);
  assert.equal(isCommerceMutationCapability('commerce-order-webhook'), false);
  assert.equal(isCommerceMutationCapability('crm-contacts-write'), false);
});

// ---------------------------------------------------------------------------
// The capability-subset declaration (AC-1: a read-only commerce adapter is
// first-class; the commerce namespace is closed)
// ---------------------------------------------------------------------------

/** A READ-ONLY commerce adapter stub (the capability-subset posture). */
function readOnlyCommerceAdapter(): IntegrationAdapter {
  return {
    descriptor: {
      adapterKey: 'stub-commerce-readonly',
      providerLabel: 'Stub Read-Only Commerce',
      description: 'A read-only commerce adapter stub.',
    },
    capabilities: [
      { capabilityKey: 'commerce-catalog-read', kind: 'read', operations: ['listCatalog'], description: 'Catalog.' },
      { capabilityKey: 'commerce-product-read', kind: 'read', operations: ['getProduct'], description: 'Product.' },
      { capabilityKey: 'commerce-price-read', kind: 'read', operations: ['getPrice'], description: 'Price.' },
      { capabilityKey: 'commerce-inventory-read', kind: 'read', operations: ['getInventory'], description: 'Inventory.' },
      { capabilityKey: 'commerce-orders-read', kind: 'read', operations: ['listOrders'], description: 'Orders.' },
      { capabilityKey: 'commerce-order-webhook', kind: 'webhook', operations: ['order.created'], description: 'Webhooks.' },
    ],
    probeConnection: async () => ({ reachable: true, healthy: true, message: null, rateLimit: null }),
    read: async () => ({ ok: true, records: [], error: null, rateLimit: null }),
    mutate: async () => ({ ok: false, providerRecordId: null, data: null, error: 'declares no mutation capability', rateLimit: null }),
    verifyWebhook: async () => ({ verified: true, reason: null, normalizedEventType: null }),
  };
}

test('MKT-071 AC-1: a READ-ONLY commerce adapter registers first-class (the full subset, no mutation capability)', () => {
  const adapter = readOnlyCommerceAdapter();
  // The guard accepts the read-only commerce subset.
  assert.deepEqual(assertValidAdapterRegistration(adapter), []);
  // The registry registers it side-by-side with a full-surface adapter.
  const registry = buildAdapterRegistry([adapter]);
  assert.equal(registry.size, 1);
  assert.ok(registry.has('stub-commerce-readonly'));
  // It declares NO mutation capability (AC-4: never claims what the
  // provider does not grant).
  assert.equal(
    adapter.capabilities.some((capability) => capability.kind === 'mutation'),
    false,
  );
});

test('MKT-071: the commerce capability namespace is CLOSED — a misspelled commerce key is rejected at registration', () => {
  const problems = assertValidAdapterRegistration({
    ...readOnlyCommerceAdapter(),
    capabilities: [
      { capabilityKey: 'commerce-produt-write', kind: 'mutation', operations: ['createProduct'], description: 'typo' },
    ] as never,
  });
  assert.ok(
    problems.some((problem) => problem.includes('frozen commerce capability-key vocabulary')),
    `expected the namespace fence to fire, got ${JSON.stringify(problems)}`,
  );
  // The existing MKT-024 keys stay legal (the continuity).
  assert.doesNotThrow(() =>
    assertValidAdapterRegistration({
      ...readOnlyCommerceAdapter(),
      capabilities: [
        { capabilityKey: 'commerce-orders-read', kind: 'read', operations: ['listOrders'], description: 'orders' },
        { capabilityKey: 'commerce-event-stream', kind: 'webhook', operations: ['order.updated'], description: 'events' },
      ] as never,
    }),
  );
});

// ---------------------------------------------------------------------------
// The normalized provider event guard (the §21 backstop + the fence shape)
// ---------------------------------------------------------------------------

function validProviderEvent(): NormalizedProviderEvent {
  return {
    providerEventId: 'evt_918273',
    eventKind: 'order',
    providerRecordId: 'ord_2001',
    shapeVersion: COMMERCE_EVENT_SHAPE_VERSION,
    normalized: { orderId: 'ord_2001', status: 'paid' },
  };
}

test('MKT-071: a well-formed normalized provider event passes the guard', () => {
  assert.doesNotThrow(() => assertValidNormalizedProviderEvent(validProviderEvent()));
});

test('MKT-071: the guard rejects malformed provider events fail-closed (bad kind, missing id, §21 material)', () => {
  const cases: ReadonlyArray<Record<string, unknown>> = [
    { providerEventId: '' },
    { providerEventId: 'x'.repeat(257) },
    { eventKind: 'invoice' },
    { providerRecordId: '' },
    { shapeVersion: '' },
    { shapeVersion: 'x'.repeat(65) },
    { normalized: {} },
    { normalized: { leak: { apiKey: 'x' } } },
    { normalized: [] },
  ];
  for (const overrides of cases) {
    assert.throws(
      () => assertValidNormalizedProviderEvent({ ...validProviderEvent(), ...overrides } as NormalizedProviderEvent),
      (error: unknown) => error instanceof InvalidRequestError,
      `expected the guard to reject ${JSON.stringify(overrides)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The raw-event hash (the dedup math — AC-3 provenance)
// ---------------------------------------------------------------------------

test('MKT-071: hashWebhookPayload is deterministic, collision-distinct and shape-faithful (the dedup math)', () => {
  const a = { eventId: 'evt_1', orderId: 'ord_2001', status: 'paid' };
  const b = { eventId: 'evt_1', orderId: 'ord_2001', status: 'paid' };
  const c = { eventId: 'evt_1', orderId: 'ord_2001', status: 'fulfilled' };
  // The same delivery object always hashes identically (replays match).
  assert.equal(hashWebhookPayload(a), hashWebhookPayload(b));
  // Distinct payloads hash distinctly (a different event body never
  // collides into the same fence identity).
  assert.notEqual(hashWebhookPayload(a), hashWebhookPayload(c));
  // The hash is the canonical sha256 hex of the serialized payload.
  const reference = createHash('sha256').update(JSON.stringify(a)).digest('hex');
  assert.equal(hashWebhookPayload(a), reference);
  assert.match(hashWebhookPayload(a), /^[a-f0-9]{64}$/);
});

// ---------------------------------------------------------------------------
// The shared commerce provider JSON convention → normalized records (AC-1)
// ---------------------------------------------------------------------------

test('MKT-071 AC-1: mapCommerceCatalogPageResponse — paged category/product shape with the cursor', () => {
  const result = mapCommerceCatalogPageResponse(
    {
      categories: [{ id: 'cat_a', title: 'Apparel' }],
      products: [
        { id: 'prd_1', title: 'Tee', categoryId: 'cat_a', status: 'active' },
        { id: 'prd_2', title: 'Bottle', categoryId: null, status: 'draft' },
      ],
      nextPageCursor: 'page-2',
    },
    '"etag-1"',
  );
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  const record = result.records[0]!;
  assert.equal(record.providerRecordId, 'commerce:catalog:page:page-2');
  const data = record.data as { kind: string; recordType: string; fields: Record<string, unknown> };
  assert.equal(data.kind, 'record');
  assert.equal(data.recordType, 'commerce.catalog-page');
  assert.deepEqual(data.fields['categories'], [{ categoryId: 'cat_a', title: 'Apparel' }]);
  assert.deepEqual(data.fields['products'], [
    { productId: 'prd_1', title: 'Tee', categoryId: 'cat_a', status: 'active' },
    { productId: 'prd_2', title: 'Bottle', categoryId: null, status: 'draft' },
  ]);
  assert.equal(data.fields['nextPageCursor'], 'page-2');
  // The terminal page's identity is 'first' (no cursor).
  const terminal = mapCommerceCatalogPageResponse(
    { categories: [], products: [], nextPageCursor: null },
    null,
  );
  assert.equal(terminal.records[0]!.providerRecordId, 'commerce:catalog:page:first');
  // Malformed payloads fail closed as data errors.
  for (const malformed of [
    { categories: 'nope' },
    { categories: [], products: 'nope' },
    { categories: [{ noId: true }], products: [] },
    { categories: [], products: [{ id: 'p', title: 't', status: 5 }] },
  ]) {
    const failure = mapCommerceCatalogPageResponse(malformed as never, null);
    assert.equal(failure.ok, false, `expected failure for ${JSON.stringify(malformed)}`);
    assert.ok(typeof failure.error === 'string' && failure.error.startsWith('malformed'));
  }
});

test('MKT-071 AC-1: mapCommerceProductResponse — the normalized product with attributes passthrough', () => {
  const result = mapCommerceProductResponse(
    {
      id: 'prd_5001',
      title: 'Organic Cotton Tee',
      description: 'A soft tee.',
      status: 'active',
      categoryId: 'cat_apparel',
      attributes: { material: 'organic-cotton', sizes: ['S', 'M'] },
      updatedAt: '2026-05-01T09:30:00.000Z',
    },
    '"etag-2"',
  );
  assert.equal(result.ok, true);
  const record = result.records[0]!;
  assert.equal(record.providerRecordId, 'commerce:product:prd_5001');
  assert.equal(record.sourceTimestamp, '2026-05-01T09:30:00.000Z');
  assert.equal(record.etag, '"etag-2"');
  const fields = (record.data as { fields: Record<string, unknown> }).fields;
  assert.equal(fields['productId'], 'prd_5001');
  assert.deepEqual(fields['attributes'], { material: 'organic-cotton', sizes: ['S', 'M'] });
  // Fail-closed: missing identity/status, non-object attributes.
  assert.equal(mapCommerceProductResponse({ title: 'x', status: 'active' }, null).ok, false);
  assert.equal(
    mapCommerceProductResponse({ id: 'p', title: 'x', status: 'active', attributes: 'nope' }, null).ok,
    false,
  );
});

test('MKT-071 AC-1: mapCommercePriceResponse + mapCommerceInventoryResponse — the normalized observations', () => {
  const price = mapCommercePriceResponse(
    { productId: 'prd_5001', priceId: 'price_9001', amount: '29.90', currency: 'EUR' },
    null,
  );
  assert.equal(price.ok, true);
  const priceFields = (price.records[0]!.data as { fields: Record<string, unknown> }).fields;
  assert.equal(priceFields['amount'], 29.9);
  assert.equal(priceFields['currency'], 'EUR');
  assert.equal(priceFields['priceId'], 'price_9001');
  assert.equal(price.records[0]!.providerRecordId, 'commerce:price:prd_5001');
  assert.equal(mapCommercePriceResponse({ productId: 'p', amount: 'NaN', currency: 'EUR' }, null).ok, false);

  const inventory = mapCommerceInventoryResponse(
    { productId: 'prd_5001', available: 148, total: 160, updatedAt: '2026-05-02T14:05:00.000Z' },
    null,
  );
  assert.equal(inventory.ok, true);
  const inventoryFields = (inventory.records[0]!.data as { fields: Record<string, unknown> }).fields;
  assert.equal(inventoryFields['available'], 148);
  assert.equal(inventoryFields['total'], 160);
  assert.equal(inventory.records[0]!.providerRecordId, 'commerce:inventory:prd_5001');
  assert.equal(mapCommerceInventoryResponse({ productId: 'p', available: 'many' }, null).ok, false);
});

test('MKT-071 AC-1/AC-5: mapCommerceOrderRecordsResponse — line-item shape with attribution VERBATIM passthrough', () => {
  const attribution = {
    ref: 'mos_msn_7f3e_attribution',
    source: 'social',
    campaign: 'summer-launch',
    contentId: 'post_9812',
  };
  const result = mapCommerceOrderRecordsResponse(
    {
      orders: [
        {
          id: 'ord_2001',
          number: 'STORE-2001',
          status: 'paid',
          currency: 'EUR',
          total: '89.70',
          placedAt: '2026-05-03T10:11:41.000Z',
          lineItems: [
            { id: 'li_01', productId: 'prd_5001', title: 'Organic Cotton Tee', quantity: 3, unitPrice: '29.90' },
          ],
          attribution,
          updatedAt: '2026-05-03T10:12:00.000Z',
        },
        {
          id: 'ord_2002',
          status: 'fulfilled',
          currency: 'EUR',
          total: '19.90',
          lineItems: [{ id: 'li_02', title: 'Notebook', quantity: 1, unitPrice: '19.90' }],
          attribution: null,
        },
      ],
      nextPageCursor: 'order-records-page-2',
    },
    '"etag-3"',
  );
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 2);
  const first = result.records[0]!;
  assert.equal(first.providerRecordId, 'commerce:order-record:ord_2001');
  const fields = (first.data as { fields: Record<string, unknown> }).fields;
  assert.equal(fields['orderNumber'], 'STORE-2001');
  assert.deepEqual(fields['lineItems'], [
    { lineItemId: 'li_01', productId: 'prd_5001', title: 'Organic Cotton Tee', quantity: 3, unitPrice: 29.9 },
  ]);
  // AC-5: the provider's attribution/reference fields ride VERBATIM —
  // deep-equal, no transformation, no computation.
  assert.deepEqual(fields['attribution'], attribution);
  assert.equal(fields['nextPageCursor'], 'order-records-page-2');
  // The attribution-free order carries null (no fabricated attribution).
  const secondFields = (result.records[1]!.data as { fields: Record<string, unknown> }).fields;
  assert.equal(secondFields['attribution'], null);
  // Fail-closed: malformed line items and non-object attribution.
  assert.equal(
    mapCommerceOrderRecordsResponse(
      { orders: [{ id: 'o', status: 's', currency: 'EUR', total: '1', lineItems: [{ noId: true }] }] },
      null,
    ).ok,
    false,
  );
  assert.equal(
    mapCommerceOrderRecordsResponse(
      { orders: [{ id: 'o', status: 's', currency: 'EUR', total: '1', lineItems: [], attribution: 'nope' }] },
      null,
    ).ok,
    false,
  );
});

test('MKT-071: mapCommerceOrdersResponse stays the MKT-024 revenue mapping (now shared by both commerce connectors)', () => {
  const result = mapCommerceOrdersResponse(
    {
      orders: [
        { id: 'ord_1001', number: 'MOS-1001', total: '249.90', currency: 'USD', status: 'paid', updatedAt: '2026-03-14T11:05:00.000Z' },
      ],
    },
    '"etag-4"',
  );
  assert.equal(result.ok, true);
  const record = result.records[0]!;
  assert.equal(record.providerRecordId, 'commerce:order:ord_1001:revenue');
  const envelope = record.data as { kind: string; metricName: string; value: number; unit: string };
  assert.equal(envelope.kind, 'metric');
  assert.equal(envelope.metricName, 'commerce.revenue');
  assert.equal(envelope.value, 249.9);
  assert.equal(envelope.unit, 'USD');
});

test('MKT-071: mapCommerceMutationResponse — the provider mutation outcome (required identity)', () => {
  const ok = mapCommerceMutationResponse({ id: 'prd_9001', title: 'New Tee', status: 'draft' });
  assert.equal(ok.ok, true);
  assert.equal(ok.providerRecordId, 'prd_9001');
  assert.deepEqual(ok.data, { id: 'prd_9001', title: 'New Tee', status: 'draft' });
  const malformed = mapCommerceMutationResponse({ noId: true });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.providerRecordId, null);
  assert.ok(typeof malformed.error === 'string');
});

// ---------------------------------------------------------------------------
// The identified webhook event builder (AC-3 fence key + AC-5 passthrough)
// ---------------------------------------------------------------------------

test('MKT-071 AC-3/AC-5: buildNormalizedCommerceEvent — the provider event identity, kind derivation and attribution passthrough', () => {
  const attribution = { ref: 'mos_msn_7f3e_attribution', campaign: 'summer-launch' };
  const event = buildNormalizedCommerceEvent('order.created', {
    eventId: 'evt_918273',
    orderId: 'ord_2001',
    status: 'paid',
    attribution,
  });
  assert.ok(event !== null);
  assert.equal(event.providerEventId, 'evt_918273');
  assert.equal(event.eventKind, 'order');
  assert.equal(event.providerRecordId, 'ord_2001');
  assert.equal(event.shapeVersion, COMMERCE_EVENT_SHAPE_VERSION);
  // The normalized fields carry the provider's attribution VERBATIM.
  assert.deepEqual(event.normalized['attribution'], attribution);

  // The other event families.
  assert.equal(buildNormalizedCommerceEvent('product.updated', { eventId: 'e2', productId: 'p1' })?.eventKind, 'product');
  assert.equal(buildNormalizedCommerceEvent('listing.updated', { eventId: 'e3', listingId: 'l1' })?.eventKind, 'listing');

  // NO provider event identity → null (the legacy unidentified path).
  assert.equal(buildNormalizedCommerceEvent('order.created', { orderId: 'ord_2001' }), null);
  // An unknown event family with an identity → null (fail-closed signal).
  assert.equal(buildNormalizedCommerceEvent('invoice.created', { eventId: 'e4' }), null);
});
