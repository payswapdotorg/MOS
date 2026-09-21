/**
 * MKT-071 integration-test harness — the LOCAL COMMERCE PROVIDER DOUBLE
 * (the tests/integration/helpers/oauth-provider.ts house pattern: an
 * in-process loopback HTTP server standing in for the provider — NO
 * external network, NO real store SDK, fixture-driven).
 *
 * The double implements the SHARED COMMERCE PROVIDER JSON CONVENTION the
 * first-party commerce connectors speak (see
 * src/modules/integrations/internal/adapter-support.ts):
 *
 *   READS (scoped 'commerce.read'):
 *     GET  /health                                  the connect probe
 *     GET  /commerce/v1/catalog?cursor=&limit=      the PAGED catalog (2 fixture pages)
 *     GET  /commerce/v1/products/:id                one product
 *     GET  /commerce/v1/products/:id/price          the product price
 *     GET  /commerce/v1/products/:id/inventory      the product inventory
 *     GET  /commerce/v1/orders                      order totals (the MKT-024 revenue shape)
 *     GET  /commerce/v1/order-records?cursor=       the PAGED full order records (line items + attribution)
 *
 *   MUTATIONS (scoped 'commerce.write' — the provider AUTHORIZES per
 *   token: a read-only token gets an honest 403 invalid-scope refusal):
 *     POST   /commerce/v1/products                  createProduct
 *     PATCH  /commerce/v1/products/:id              updateProduct
 *     POST   /commerce/v1/listings                  createListing
 *     PATCH  /commerce/v1/listings/:id              updateListing
 *     POST   /commerce/v1/listings/:id/end          endListing
 *     (every received mutation is RECORDED so the E2E proof asserts the
 *     exact provider-visible side effects of APPROVED operations — and
 *     ZERO side effects under denials)
 *
 *   ERROR TAXONOMY (the scriptable failure modes):
 *     'ok' (default) | 'down' (the socket is destroyed — transport
 *     refused: provider-down) | 'rate-limited' (429 + Retry-After +
 *     X-RateLimit headers) — plus the natural per-request 401
 *     unauthorized for a wrong bearer token and the 403 invalid-scope
 *     refusals of write operations under a read-only token.
 *
 *   AUTHORIZATION MODEL (the partial-capability variants): the double is
 *   constructed with per-token GRANTS — a full token carries
 *   { accessToken, webhookSecret, scopes: ['commerce.read',
 *   'commerce.write'] }; a read-only token carries scopes:
 *   ['commerce.read'] only. The provider enforces the scopes on every
 *   request (the runtime per-connection authorization layer on top of
 *   the ADAPTER's static capability declaration).
 *
 *   WEBHOOK DELIVERY: commerceWebhookSignature() produces the
 *   X-Commerce-Signature HMAC-SHA256 header the connectors verify; the
 *   identified delivery payloads carry the provider's OWN event identity
 *   (eventId) that drives the (provider id, event id) dedup fence.
 *
 * Token materials are FAKE sandbox strings ASSEMBLED AT RUNTIME (the §21
 * posture: they exist only in the secrets-dir files and in-process).
 */

import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** The scriptable failure mode served by the double. */
export type CommerceProviderMode = 'ok' | 'down' | 'rate-limited';

/** One provider grant: the token material + the scopes it authorizes. */
export interface CommerceProviderGrant {
  /** The expected bearer token (never logged). */
  readonly accessToken: string;
  /** The scopes this token authorizes ('commerce.read' and/or 'commerce.write'). */
  readonly scopes: readonly ('commerce.read' | 'commerce.write')[];
}

/** The provider-visible side effect of one commerce mutation. */
export interface CommerceMutationCall {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export interface CommerceProvider {
  /** The loopback base URL. */
  readonly url: string;
  /** The listening port. */
  readonly port: number;
  /** Total requests received (auth failures and scope refusals included). */
  requestCount(): number;
  /** The commerce mutations received (the provider-visible side effects). */
  mutations(): readonly CommerceMutationCall[];
  /** Sets the failure mode served on the data endpoints. */
  setMode(mode: CommerceProviderMode): void;
  /** Closes the server. */
  close(): Promise<void>;
}

/**
 * The webhook signature header for a commerce delivery (the
 * X-Commerce-Signature HMAC-SHA256 convention the connectors verify).
 */
export function commerceWebhookSignature(
  secret: string,
  payload: Record<string, unknown>,
): Record<string, string> {
  const mac = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  return { 'x-commerce-signature': mac };
}

/**
 * The representative payload fixtures (the commerce provider JSON
 * convention SHAPES — the source-mapping tests assert the EXACT
 * normalized outcomes of these).
 */
export const COMMERCE_FIXTURES = {
  catalogPageOne: {
    categories: [
      { id: 'cat_apparel', title: 'Apparel' },
      { id: 'cat_drinkware', title: 'Drinkware' },
    ],
    products: [
      { id: 'prd_5001', title: 'Organic Cotton Tee', categoryId: 'cat_apparel', status: 'active' },
      { id: 'prd_5002', title: 'Insulated Bottle', categoryId: 'cat_drinkware', status: 'active' },
    ],
    nextPageCursor: 'catalog-page-2',
  },
  catalogPageTwo: {
    categories: [{ id: 'cat_stationery', title: 'Stationery' }],
    products: [
      { id: 'prd_5003', title: 'Recycled Notebook', categoryId: 'cat_stationery', status: 'draft' },
    ],
    nextPageCursor: null,
  },
  product: {
    id: 'prd_5001',
    title: 'Organic Cotton Tee',
    description: 'A soft organic cotton t-shirt.',
    status: 'active',
    categoryId: 'cat_apparel',
    attributes: { material: 'organic-cotton', sizes: ['S', 'M', 'L'] },
    updatedAt: '2026-05-01T09:30:00.000Z',
  },
  price: {
    productId: 'prd_5001',
    priceId: 'price_9001',
    amount: '29.90',
    currency: 'EUR',
    updatedAt: '2026-05-01T09:30:00.000Z',
  },
  inventory: {
    productId: 'prd_5001',
    available: 148,
    total: 160,
    updatedAt: '2026-05-02T14:05:00.000Z',
  },
  orders: {
    orders: [
      {
        id: 'ord_2001',
        number: 'STORE-2001',
        total: '89.70',
        currency: 'EUR',
        status: 'paid',
        updatedAt: '2026-05-03T10:12:00.000Z',
      },
    ],
  },
  orderRecordsPageOne: {
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
        attribution: {
          ref: 'mos_msn_7f3e_attribution',
          source: 'social',
          campaign: 'summer-launch',
          contentId: 'post_9812',
        },
        updatedAt: '2026-05-03T10:12:00.000Z',
      },
    ],
    nextPageCursor: 'order-records-page-2',
  },
  orderRecordsPageTwo: {
    orders: [
      {
        id: 'ord_2002',
        number: 'STORE-2002',
        status: 'fulfilled',
        currency: 'EUR',
        total: '19.90',
        placedAt: '2026-05-04T08:02:12.000Z',
        lineItems: [
          { id: 'li_02', productId: 'prd_5003', title: 'Recycled Notebook', quantity: 1, unitPrice: '19.90' },
        ],
        attribution: null,
        updatedAt: '2026-05-05T16:44:00.000Z',
      },
    ],
    nextPageCursor: null,
  },
} as const;

const RATE_LIMIT_HEADERS: Record<string, string> = {
  'x-ratelimit-remaining': '239',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
};

/**
 * Boots the LOCAL commerce provider double on an ephemeral loopback port.
 * `grants` maps bearer tokens to their authorized scopes (the
 * partial-capability variants: a full token vs a read-only token).
 */
export async function startCommerceProvider(
  grants: readonly CommerceProviderGrant[],
): Promise<CommerceProvider> {
  let requests = 0;
  let mode: CommerceProviderMode = 'ok';
  const mutationLog: CommerceMutationCall[] = [];

  const server = http.createServer((req, res) => {
    requests += 1;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    // Provider-down: destroy the socket before any response (transport
    // refused — the honest provider-down failure mode).
    if (mode === 'down') {
      req.destroy();
      res.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      const bodyText = Buffer.concat(chunks).toString('utf8');
      if (bodyText !== '') {
        try {
          body = JSON.parse(bodyText) as Record<string, unknown>;
        } catch {
          body = { unparseable: true };
        }
      }

      const reply = (status: number, payload: unknown, extra: Record<string, string> = {}): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
          etag: '"commerce-fixture-v1"',
          ...RATE_LIMIT_HEADERS,
          ...extra,
        });
        res.end(text);
      };

      // The bearer-token check (authorization without logging the value).
      const header = req.headers['authorization'] ?? '';
      const provided = Array.isArray(header) ? header[0] : header;
      const grant = grants.find((candidate) => `Bearer ${candidate.accessToken}` === provided);
      if (grant === undefined) {
        reply(401, { error: 'unauthorized' });
        return;
      }

      // The rate-limited failure mode (any data endpoint).
      if (mode === 'rate-limited') {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '30',
          ...RATE_LIMIT_HEADERS,
        });
        res.end(JSON.stringify({ error: 'rate limit exceeded' }));
        return;
      }

      const requiresWrite = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE';
      if (requiresWrite && !grant.scopes.includes('commerce.write')) {
        // The honest per-token authorization refusal (the runtime layer
        // under the adapter's static capability declaration).
        reply(403, { error: 'invalid_scope', required: 'commerce.write' });
        return;
      }

      if (req.method === 'GET' && path === '/health') {
        reply(200, { ok: true, id: 'commerce-store-sandbox' });
        return;
      }

      if (req.method === 'GET' && path === '/commerce/v1/catalog') {
        const cursor = url.searchParams.get('cursor');
        reply(200, cursor === 'catalog-page-2' ? COMMERCE_FIXTURES.catalogPageTwo : COMMERCE_FIXTURES.catalogPageOne);
        return;
      }

      if (req.method === 'GET' && /^\/commerce\/v1\/products\/[^/]+$/.test(path)) {
        reply(200, COMMERCE_FIXTURES.product);
        return;
      }
      if (req.method === 'GET' && /^\/commerce\/v1\/products\/[^/]+\/price$/.test(path)) {
        reply(200, COMMERCE_FIXTURES.price);
        return;
      }
      if (req.method === 'GET' && /^\/commerce\/v1\/products\/[^/]+\/inventory$/.test(path)) {
        reply(200, COMMERCE_FIXTURES.inventory);
        return;
      }
      if (req.method === 'GET' && path === '/commerce/v1/orders') {
        reply(200, COMMERCE_FIXTURES.orders);
        return;
      }
      if (req.method === 'GET' && path === '/commerce/v1/order-records') {
        const cursor = url.searchParams.get('cursor');
        reply(
          200,
          cursor === 'order-records-page-2' ? COMMERCE_FIXTURES.orderRecordsPageTwo : COMMERCE_FIXTURES.orderRecordsPageOne,
        );
        return;
      }

      // The mutations: every received side effect is RECORDED (the
      // provider-visible outcome of APPROVED operations).
      if (req.method === 'POST' && path === '/commerce/v1/products') {
        mutationLog.push({ method: req.method, path, body });
        const title = typeof body['title'] === 'string' ? body['title'] : 'Untitled';
        reply(201, { id: `prd_9${String(mutationLog.length).padStart(3, '0')}`, title, status: 'draft' });
        return;
      }
      if (req.method === 'PATCH' && /^\/commerce\/v1\/products\/[^/]+$/.test(path)) {
        mutationLog.push({ method: req.method, path, body });
        const id = path.split('/').pop() ?? '';
        reply(200, { id, ...body, status: 'active' });
        return;
      }
      if (req.method === 'POST' && path === '/commerce/v1/listings') {
        mutationLog.push({ method: req.method, path, body });
        reply(201, { id: `lst_7${String(mutationLog.length).padStart(3, '0')}`, status: 'active' });
        return;
      }
      if (req.method === 'PATCH' && /^\/commerce\/v1\/listings\/[^/]+$/.test(path)) {
        mutationLog.push({ method: req.method, path, body });
        const id = path.split('/').pop() ?? '';
        reply(200, { id, ...body });
        return;
      }
      if (req.method === 'POST' && /^\/commerce\/v1\/listings\/[^/]+\/end$/.test(path)) {
        mutationLog.push({ method: req.method, path, body });
        const id = path.split('/').at(-2) ?? '';
        reply(200, { id, status: 'ended' });
        return;
      }

      reply(404, { error: 'unknown commerce sandbox endpoint', path });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requestCount: () => requests,
    mutations: () => [...mutationLog],
    setMode: (next: CommerceProviderMode) => {
      mode = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
