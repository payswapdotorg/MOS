/**
 * MKT-071 integration-test harness — the LOCAL COMMERCE PROVIDER DOUBLE
 * (the oauth-provider.ts / sandbox-provider.ts house pattern: a disclosed
 * TEST DOUBLE AT THE PROVIDER BOUNDARY ONLY).
 *
 * An in-process loopback HTTP server standing in for the commerce/CMS
 * provider (NO external network, NO real commerce platform): the REAL
 * first-party CommerceCmsAdapter (wired in the spawned API process by the
 * composition root, and in the module-level in-process instance) makes
 * REAL HTTP calls (fetch-based platform HttpCallPort, loopback) against
 * this server, which serves REPRESENTATIVE payload fixtures shaped like
 * the commerce provider wire convention (the shapes the pure mapping
 * functions in the module public contract normalize).
 *
 * The FULL capability surface (MKT-071 AC-2):
 *   - READS: the paged store catalog (cursor paging over fixture pages),
 *     product detail, product price, product inventory, the summary
 *     orders listing (the MKT-024 shape) and the paged order details
 *     (line items + the attribution/reference fields carried by the
 *     fixtures);
 *   - MUTATIONS: product upsert + the listing lifecycle (create/update/
 *     end) — every received side effect is RECORDED so the round-trip
 *     proof asserts the EXACT provider-visible outcome of APPROVED
 *     operations (and the fail-closed negatives prove ZERO side effects);
 *   - WEBHOOK DELIVERY: the HMAC signature helper producing the
 *     X-Commerce-Signature header the adapter verifies.
 *
 * Scriptable behaviors (the error-taxonomy battery — AC-2):
 *   - 'ok' (default);
 *   - 'provider-down': the server DESTROYS the socket (connection reset —
 *     the transport-refused taxonomy);
 *   - 'unauthorized': 401 on the data endpoints;
 *   - 'rate-limited': 429 + Retry-After + X-RateLimit headers;
 *   - 'invalid-scope': 403 insufficient_scope on the data endpoints;
 *   - 'malformed': structurally malformed JSON payloads.
 *
 * AUTHORIZATION: bearer-token checks with PER-TOKEN GRANTED SCOPES (the
 * provider-side scope enforcement — defense in depth with the adapter's
 * credential-material scope pre-check): read endpoints require
 * catalog:read / orders:read, mutation endpoints require products:write /
 * listings:write; a token lacking the scope is answered 403
 * insufficient_scope. Tokens are FAKE sandbox strings ASSEMBLED AT RUNTIME
 * (the §21 posture: they exist only in the secrets-dir files and
 * in-process; the request log stores method+path only).
 */

import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** The scriptable failure mode served on the commerce data endpoints. */
export type CommerceProviderMode =
  | 'ok'
  | 'provider-down'
  | 'unauthorized'
  | 'rate-limited'
  | 'invalid-scope'
  | 'malformed';

export interface CommerceProviderDouble {
  readonly url: string;
  readonly port: number;
  /** The number of commerce data-endpoint requests received (auth failures included). */
  requestCount(): number;
  /** Sets the failure mode served on the commerce data endpoints. */
  setMode(mode: CommerceProviderMode): void;
  /** The product upserts received (the provider-visible side effect). */
  productUpserts(): readonly { body: Record<string, unknown> }[];
  /** The listing lifecycle mutations received, in order. */
  listingMutations(): readonly { kind: 'create' | 'update' | 'end'; path: string; body: Record<string, unknown> }[];
  close(): Promise<void>;
}

/** The per-token granted scopes (the provider-side authorization model). */
export interface CommerceTokenScopes {
  readonly [token: string]: readonly string[];
}

/** The webhook signature header for a commerce event delivery. */
export function commerceWebhookSignature(
  secret: string,
  payload: Record<string, unknown>,
): Record<string, string> {
  const mac = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  return { 'x-commerce-signature': mac };
}

/**
 * The representative fixtures (the commerce provider wire convention —
 * the exact normalized outcomes are asserted by the source-mapping tests).
 */
export const COMMERCE_FIXTURES = {
  catalogPage1: {
    categories: [
      { id: 'cat_10', title: 'Kitchen', updatedAt: '2026-05-01T08:00:00.000Z' },
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
      {
        id: 'prd_502',
        title: 'Field Notebook',
        status: 'active',
        categoryIds: ['cat_20'],
        variantCount: 1,
        updatedAt: '2026-05-02T09:31:00.000Z',
      },
    ],
    nextCursor: 'catalog-page-2',
  },
  catalogPage2: {
    categories: [{ id: 'cat_20', title: 'Outdoor', parentId: 'cat_10' }],
    products: [
      {
        id: 'prd_503',
        title: 'Trail Thermos',
        status: 'draft',
        categoryIds: ['cat_20'],
        variantCount: 1,
        updatedAt: '2026-05-02T09:32:00.000Z',
      },
    ],
    nextCursor: null,
  },
  productDetail: {
    product: {
      id: 'prd_501',
      title: 'Tactical Apron',
      status: 'active',
      description: 'Rugged waxed-canvas apron with tool loops',
      version: 7,
      updatedAt: '2026-05-02T09:30:00.000Z',
      variants: [
        { id: 'var_9', title: 'Black', price: '189.00', currency: 'USD', inventory: 12 },
        { id: 'var_10', title: 'Olive', price: '189.00', currency: 'USD' },
      ],
    },
  },
  price: {
    price: {
      productId: 'prd_501',
      variantId: 'var_9',
      amount: '189.00',
      currency: 'USD',
      compareAtAmount: '219.00',
      updatedAt: '2026-05-03T10:00:00.000Z',
    },
  },
  inventory: {
    inventory: {
      productId: 'prd_501',
      variantId: 'var_9',
      available: 12,
      reserved: 1,
      incoming: 0,
      updatedAt: '2026-05-03T10:00:00.000Z',
    },
  },
  ordersSummary: {
    orders: [
      {
        id: 'ord_1001',
        number: 'MOS-1001',
        total: '249.90',
        currency: 'USD',
        status: 'paid',
        customerEmail: 'buyer@example.test',
        updatedAt: '2026-03-14T11:05:00.000Z',
      },
    ],
  },
  orderDetailsPage1: {
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
          {
            productId: 'prd_501',
            variantId: 'var_9',
            title: 'Tactical Apron',
            quantity: 1,
            unitPrice: '189.00',
          },
        ],
        attribution: {
          attributionRef: 'mission:gm_882:experiment:exp_401',
          utmSource: 'instagram',
          utmCampaign: 'spring-launch',
          landingRoute: '/l/spring-882',
        },
      },
    ],
    nextCursor: 'orders-page-2',
  },
  orderDetailsPage2: {
    orders: [
      {
        id: 'ord_2002',
        number: 'MOS-2002',
        status: 'fulfilled',
        currency: 'USD',
        total: '189.00',
        placedAt: '2026-05-05T12:00:00.000Z',
        updatedAt: '2026-05-06T08:00:00.000Z',
        customerEmail: 'buyer2@example.test',
        lineItems: [
          {
            productId: 'prd_501',
            variantId: 'var_10',
            title: 'Tactical Apron',
            quantity: 1,
            unitPrice: '189.00',
          },
        ],
        attribution: {},
      },
    ],
    nextCursor: null,
  },
} as const;

const RATE_LIMIT_HEADERS: Record<string, string> = {
  'x-ratelimit-remaining': '12',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
};

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    etag: '"commerce-fixture-v1"',
    ...RATE_LIMIT_HEADERS,
    ...extra,
  });
  res.end(payload);
}

/**
 * Boots the LOCAL commerce provider double on an ephemeral loopback port.
 * `tokenScopes` maps every accepted bearer token to its granted scopes
 * (tokens not in the map are answered 401 — unknown credentials).
 */
export function startCommerceProvider(tokenScopes: CommerceTokenScopes): Promise<CommerceProviderDouble> {
  let mode: CommerceProviderMode = 'ok';
  let requests = 0;
  const upserts: { body: Record<string, unknown> }[] = [];
  const listingLog: { kind: 'create' | 'update' | 'end'; path: string; body: Record<string, unknown> }[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      if (bodyText.trim() !== '') {
        try {
          body = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          body = { unparseable: true };
        }
      }

      if (path === '/health') {
        const header = req.headers['authorization'] ?? '';
        const provided = Array.isArray(header) ? header[0] : header;
        const token = provided === '' ? null : provided.slice('Bearer '.length);
        if (token === null || !(token in tokenScopes)) {
          json(res, 401, { error: 'unauthorized' });
          return;
        }
        json(res, 200, { ok: true, id: 'sandbox' });
        return;
      }

      if (!path.startsWith('/commerce/') && !path.startsWith('/cms/')) {
        json(res, 404, { error: 'unknown sandbox endpoint', path });
        return;
      }
      requests += 1;

      // The bearer-token check with PER-TOKEN GRANTED SCOPES (the
      // provider-side authorization — never logged).
      const header = req.headers['authorization'] ?? '';
      const provided = Array.isArray(header) ? header[0] : header;
      const token = provided.startsWith('Bearer ') ? provided.slice('Bearer '.length) : '';
      const scopes = tokenScopes[token];
      if (scopes === undefined) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }

      // The scriptable failure modes (the error-taxonomy battery).
      if (mode === 'provider-down') {
        res.destroy();
        return;
      }
      if (mode === 'unauthorized') {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      if (mode === 'rate-limited') {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '30',
          ...RATE_LIMIT_HEADERS,
        });
        res.end(JSON.stringify({ error: 'rate limit exceeded' }));
        return;
      }
      if (mode === 'invalid-scope') {
        json(res, 403, { error: 'insufficient_scope', required: 'catalog:read' });
        return;
      }

      const requiresScope = (scope: string): boolean => {
        if (scopes.includes(scope)) return true;
        json(res, 403, { error: 'insufficient_scope', required: scope });
        return false;
      };

      // ----- READS -------------------------------------------------------
      if (req.method === 'GET' && path === '/commerce/v1/catalog') {
        if (!requiresScope('catalog:read')) return;
        const cursor = url.searchParams.get('cursor');
        if (mode === 'malformed') {
          json(res, 200, { categories: 'not-an-array' });
          return;
        }
        json(res, 200, cursor === 'catalog-page-2' ? COMMERCE_FIXTURES.catalogPage2 : COMMERCE_FIXTURES.catalogPage1);
        return;
      }
      if (req.method === 'GET' && /^\/commerce\/v1\/products\/[^/]+$/.test(path)) {
        if (!requiresScope('catalog:read')) return;
        json(res, 200, mode === 'malformed' ? { product: { id: 'x' } } : COMMERCE_FIXTURES.productDetail);
        return;
      }
      if (req.method === 'GET' && /^\/commerce\/v1\/products\/[^/]+\/price$/.test(path)) {
        if (!requiresScope('catalog:read')) return;
        json(res, 200, mode === 'malformed' ? { price: { productId: 'p', amount: 'NaN' } } : COMMERCE_FIXTURES.price);
        return;
      }
      if (req.method === 'GET' && /^\/commerce\/v1\/products\/[^/]+\/inventory$/.test(path)) {
        if (!requiresScope('catalog:read')) return;
        json(res, 200, mode === 'malformed' ? { inventory: { productId: 'p', available: -3 } } : COMMERCE_FIXTURES.inventory);
        return;
      }
      if (req.method === 'GET' && path === '/commerce/v1/orders') {
        if (!requiresScope('orders:read')) return;
        json(res, 200, mode === 'malformed' ? { orders: [{ id: 'x', total: 'NaN', currency: 'USD' }] } : COMMERCE_FIXTURES.ordersSummary);
        return;
      }
      if (req.method === 'GET' && path === '/commerce/v1/orders/details') {
        if (!requiresScope('orders:read')) return;
        const cursor = url.searchParams.get('cursor');
        if (mode === 'malformed') {
          json(res, 200, { orders: [{ id: 'x', status: 'paid', currency: 'USD', total: 'NaN' }] });
          return;
        }
        json(res, 200, cursor === 'orders-page-2' ? COMMERCE_FIXTURES.orderDetailsPage2 : COMMERCE_FIXTURES.orderDetailsPage1);
        return;
      }

      // ----- MUTATIONS (every side effect is RECORDED) -------------------
      if (req.method === 'POST' && path === '/commerce/v1/products') {
        if (!requiresScope('products:write')) return;
        upserts.push({ body });
        const product = (body['product'] ?? {}) as Record<string, unknown>;
        json(res, 200, {
          product: {
            id: typeof product['id'] === 'string' && product['id'] !== '' ? product['id'] : `prd_new_${upserts.length}`,
            title: product['title'] ?? 'Untitled',
            status: product['status'] ?? 'active',
            description: product['description'] ?? null,
            version: 1,
            updatedAt: '2026-05-07T09:00:00.000Z',
            variants: Array.isArray(product['variants']) ? product['variants'] : [],
          },
        });
        return;
      }
      if (req.method === 'POST' && path === '/commerce/v1/listings') {
        if (!requiresScope('listings:write')) return;
        listingLog.push({ kind: 'create', path, body });
        const listing = (body['listing'] ?? {}) as Record<string, unknown>;
        json(res, 200, {
          listing: {
            id: `lst_${3000 + listingLog.length}`,
            productId: listing['productId'] ?? 'prd_501',
            variantId: listing['variantId'] ?? null,
            price: listing['price'] ?? '0.00',
            currency: listing['currency'] ?? 'USD',
            quantity: listing['quantity'] ?? 1,
            status: 'active',
            updatedAt: '2026-05-07T10:00:00.000Z',
          },
        });
        return;
      }
      if (req.method === 'PATCH' && /^\/commerce\/v1\/listings\/[^/]+$/.test(path)) {
        if (!requiresScope('listings:write')) return;
        listingLog.push({ kind: 'update', path, body });
        const listing = (body['listing'] ?? {}) as Record<string, unknown>;
        const id = path.split('/').pop()!;
        json(res, 200, {
          listing: {
            id,
            productId: listing['productId'] ?? 'prd_501',
            variantId: listing['variantId'] ?? null,
            price: listing['price'] ?? '0.00',
            currency: listing['currency'] ?? 'USD',
            quantity: listing['quantity'] ?? 1,
            status: listing['status'] ?? 'active',
            updatedAt: '2026-05-07T11:00:00.000Z',
          },
        });
        return;
      }
      if (req.method === 'POST' && /^\/commerce\/v1\/listings\/[^/]+\/end$/.test(path)) {
        if (!requiresScope('listings:write')) return;
        listingLog.push({ kind: 'end', path, body });
        const id = path.split('/').at(-2)!;
        json(res, 200, {
          listing: {
            id,
            productId: 'prd_501',
            variantId: null,
            price: '0.00',
            currency: 'USD',
            quantity: 0,
            status: 'ended',
            updatedAt: '2026-05-07T12:00:00.000Z',
          },
        });
        return;
      }

      json(res, 404, { error: 'unknown sandbox endpoint', path });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requestCount: () => requests,
        setMode: (next: CommerceProviderMode) => {
          mode = next;
        },
        productUpserts: () => [...upserts],
        listingMutations: () => [...listingLog],
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error === undefined ? closeResolve() : closeReject(error)));
          }),
      });
    });
  });
}
