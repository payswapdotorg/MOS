/**
 * MKT-024 sandbox provider harness — an in-process loopback HTTP server
 * that stands in for the five first-party connector providers (Meta,
 * Google Ads, generic analytics, CRM, commerce/CMS).
 *
 * This is the "sandbox provider" of the MKT-024 acceptance ("real/sandbox
 * provider integration tests per connector"): NO real provider SDK, NO
 * external network. The REAL first-party adapter classes (wired in the
 * spawned API process by the composition root) make REAL HTTP calls
 * (fetch-based platform HttpCallPort, loopback permitted by the port
 * contract) against this server, which serves REPRESENTATIVE payload
 * fixtures shaped like the providers' responses.
 *
 * Capabilities:
 *   - per-provider endpoints (probe + read + mutation + fixtures) with
 *     rate-limit headers (X-RateLimit-*) and ETag responses;
 *   - bearer-token authorization checks (the adapter sends the credential
 *     material's accessToken; the server compares against the expected
 *     token — proving the in-process material flow WITHOUT ever logging
 *     the token value; the request log stores method+path only);
 *   - scriptable failure modes per provider ('ok' default, 'rate-limited'
 *     → 429 + Retry-After, 'garbage' → non-JSON body, 'auth-reject' →
 *     401, 'malformed' → structurally malformed JSON payload) so the
 *     fail-closed adapter posture is provable per connector;
 *   - a request counter per provider (proving policy-denied actions cause
 *     ZERO provider traffic);
 *   - HMAC signature helpers producing the webhook signature headers the
 *     adapters verify (X-Hub-Signature-256 / X-Analytics-Signature /
 *     X-Commerce-Signature).
 */

import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** The scriptable failure mode served for one provider's data endpoints. */
export type SandboxMode = 'ok' | 'rate-limited' | 'garbage' | 'auth-reject' | 'malformed';

export interface SandboxProvider {
  /** The loopback base URL (per-provider path prefixes appended by the caller). */
  readonly url: string;
  /** The listening port. */
  readonly port: number;
  /** Number of requests seen per provider prefix (auth failures included). */
  requests(provider: SandboxProviderName): number;
  /** Sets the failure mode served on one provider's data endpoints. */
  setMode(provider: SandboxProviderName, mode: SandboxMode): void;
  /** The CRM upsert calls received (body + auth presence). */
  crmUpserts(): readonly { body: Record<string, unknown> }[];
  /** Closes the server. */
  close(): Promise<void>;
}

export type SandboxProviderName = 'meta' | 'google-ads' | 'analytics' | 'crm' | 'commerce-cms';

/** The expected bearer token per provider (set by the test; never logged). */
export interface SandboxAuth {
  readonly [provider: string]: string;
}

/** The webhook signature header for one provider's delivery shape. */
export function sandboxWebhookSignature(
  provider: 'meta' | 'analytics' | 'commerce-cms',
  secret: string,
  payload: Record<string, unknown>,
): Record<string, string> {
  const mac = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
  if (provider === 'meta') return { 'x-hub-signature-256': `sha256=${mac}` };
  if (provider === 'analytics') return { 'x-analytics-signature': mac };
  return { 'x-commerce-signature': mac };
}

/**
 * The representative payload fixtures (provider response SHAPES — the
 * source-mapping tests assert the EXACT normalized outcomes of these).
 */
export const SANDBOX_FIXTURES = {
  metaCampaigns: {
    data: [
      {
        id: '23840001',
        name: 'Spring Launch',
        status: 'PAUSED',
        objective: 'OUTCOME_TRAFFIC',
        created_time: '2026-01-02T09:14:00+0000',
        updated_time: '2026-01-20T17:03:11+0000',
      },
    ],
  },
  metaInsights: {
    data: [
      {
        campaign_id: '23840001',
        campaign_name: 'Spring Launch',
        date_start: '2026-01-15',
        impressions: '12845',
        clicks: '512',
        spend: '128.45',
        ctr: '3.98',
      },
    ],
  },
  googleAdsMetrics: {
    results: [
      {
        campaign: { resourceName: 'customers/1234567890/campaigns/21470001', id: '21470001', name: 'Search - Brand', status: 'ENABLED' },
        segments: { date: '2026-02-01' },
        metrics: { impressions: '1042', clicks: '77', costMicros: '4560000', ctr: '7.39' },
      },
    ],
  },
  googleAdsCampaigns: {
    results: [
      {
        campaign: { resourceName: 'customers/1234567890/campaigns/21470001', id: '21470001', name: 'Search - Brand', status: 'ENABLED' },
      },
    ],
  },
  analyticsReport: {
    dimensionHeaders: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }, { name: 'conversions', type: 'TYPE_INTEGER' }],
    rows: [
      {
        dimensionValues: [{ value: '20260301' }, { value: 'Organic Search' }],
        metricValues: [{ value: '4831' }, { value: '312' }],
      },
    ],
    rowCount: 1,
  },
  crmContacts: {
    contacts: [
      {
        id: 'cnt_0021',
        email: 'ada@example.test',
        firstName: 'Ada',
        lastName: 'Lovelace',
        status: 'active',
        updatedAt: '2026-03-12T08:30:00.000Z',
      },
    ],
  },
  crmUpsertResult: { id: 'cnt_0022', result: 'created' },
  commerceOrders: {
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
  cmsContent: {
    items: [
      {
        id: 'post_880',
        type: 'post',
        title: 'Spring lookbook',
        slug: 'spring-lookbook',
        version: 7,
        status: 'published',
        publishedAt: '2026-03-09T09:00:00.000Z',
      },
    ],
  },
} as const;

const RATE_LIMIT_HEADERS: Record<string, string> = {
  'x-ratelimit-remaining': '480',
  'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
};

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    etag: '"sandbox-fixture-v1"',
    ...RATE_LIMIT_HEADERS,
    ...extra,
  });
  res.end(payload);
}

/**
 * Boots the sandbox provider on an ephemeral loopback port. `auth` maps
 * provider names to the expected bearer tokens (the provisioned
 * credential materials' accessToken fields — never logged).
 */
export async function startSandboxProvider(auth: SandboxAuth): Promise<SandboxProvider> {
  const requestCounts: Record<string, number> = {};
  const modes: Record<string, SandboxMode> = {};
  const upserts: { body: Record<string, unknown> }[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const provider = path.startsWith('/meta/')
      ? 'meta'
      : path.startsWith('/google-ads/')
        ? 'google-ads'
        : path.startsWith('/analytics/')
          ? 'analytics'
          : path.startsWith('/crm/')
            ? 'crm'
            : path.startsWith('/commerce-cms/')
              ? 'commerce-cms'
              : 'unknown';
    if (provider !== 'unknown') {
      requestCounts[provider] = (requestCounts[provider] ?? 0) + 1;
    }

    // The bearer-token check (authorization without logging the value).
    const expected = auth[provider];
    if (expected !== undefined && provider !== 'unknown') {
      const header = req.headers['authorization'] ?? '';
      const provided = Array.isArray(header) ? header[0] : header;
      if (provided !== `Bearer ${expected}`) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
    }

    const mode = modes[provider] ?? 'ok';

    if (req.method === 'GET' && (path === '/meta/me' || path === '/analytics/health' || path === '/crm/v1/ping' || path === '/commerce-cms/health' || /^\/google-ads\/v16\/customers\/[^/]+$/.test(path))) {
      json(res, 200, { ok: true, id: 'sandbox' });
      return;
    }

    if (mode === 'rate-limited') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30', ...RATE_LIMIT_HEADERS });
      res.end(JSON.stringify({ error: 'rate limit exceeded' }));
      return;
    }
    if (mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'text/plain', ...RATE_LIMIT_HEADERS });
      res.end('this is not json at all');
      return;
    }
    if (mode === 'auth-reject') {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    if (path === '/meta/v13.0/act_998877/campaigns') {
      json(res, 200, mode === 'malformed' ? { data: [{ nope: 1 }] } : SANDBOX_FIXTURES.metaCampaigns);
      return;
    }
    if (path === '/meta/v13.0/act_998877/insights') {
      json(res, 200, mode === 'malformed' ? { data: [{ campaign_id: 'x', date_start: '2026-01-15', spend: 'not-a-number' }] } : SANDBOX_FIXTURES.metaInsights);
      return;
    }
    if (path === '/google-ads/v16/customers/1234567890/googleAds:search') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const wantsMetrics = body.includes('metrics');
        json(
          res,
          200,
          mode === 'malformed'
            ? { results: [{ campaign: { id: '1' }, segments: { date: '2026-02-01' }, metrics: { impressions: 'NaN' } }] }
            : wantsMetrics
              ? SANDBOX_FIXTURES.googleAdsMetrics
              : SANDBOX_FIXTURES.googleAdsCampaigns,
        );
      });
      return;
    }
    if (path === '/analytics/v1beta/properties/prop_77:runReport') {
      json(res, 200, mode === 'malformed' ? { rows: [{ dimensionValues: [], metricValues: [] }] } : SANDBOX_FIXTURES.analyticsReport);
      return;
    }
    if (path === '/crm/v1/contacts') {
      json(res, 200, mode === 'malformed' ? { contacts: [{ email: 'x' }] } : SANDBOX_FIXTURES.crmContacts);
      return;
    }
    if (path === '/crm/v1/contacts/upsert') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          upserts.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        } catch {
          upserts.push({ body: { unparseable: true } });
        }
        json(res, 200, SANDBOX_FIXTURES.crmUpsertResult);
      });
      return;
    }
    if (path === '/commerce-cms/commerce/v1/orders') {
      json(res, 200, mode === 'malformed' ? { orders: [{ id: 'x', total: 'NaN', currency: 'USD' }] } : SANDBOX_FIXTURES.commerceOrders);
      return;
    }
    if (path === '/commerce-cms/cms/v1/content') {
      json(res, 200, mode === 'malformed' ? { items: [{ nope: true }] } : SANDBOX_FIXTURES.cmsContent);
      return;
    }

    json(res, 404, { error: 'unknown sandbox endpoint', path });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const port = address.port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests: (provider) => requestCounts[provider] ?? 0,
    setMode: (provider, mode) => {
      modes[provider] = mode;
    },
    crmUpserts: () => [...upserts],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
