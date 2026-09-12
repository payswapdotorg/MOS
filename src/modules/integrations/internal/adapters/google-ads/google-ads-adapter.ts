/**
 * Google Ads (REST API-shaped) first-party connector — MKT-024, INT-001.
 *
 * One adapter subtree under internal/adapters/google-ads/: this file owns
 * ALL Google Ads-specific knowledge behind the generic IntegrationAdapter
 * port (implementation-contract §20). Wired ONLY at the composition root;
 * no domain module imports it. Egress uses the platform HttpCallPort
 * (fetch-based — NO Google SDK anywhere).
 *
 * providerConfig (non-secret connection data): apiBaseUrl (sandbox/loopback
 * override), customerId, apiVersion (default 'v16') and the reporting
 * currency. The credential material (opaque provider JSON — see
 * adapter-support) is resolved by the /integrations module after a
 * fail-closed /policies allow and is sent as an Authorization bearer
 * header, in-process only (§21).
 *
 * READ operations (Google Ads googleAds:search-shaped responses) map to
 * NORMALIZED observations (METRIC-001):
 *   - listCampaigns    → source-record envelopes (kind 'record') — campaign
 *     metadata as provider source facts;
 *   - getCampaignMetrics → one metric-observation envelope (kind 'metric')
 *     per (row x metric): impressions/clicks/cost/ctr. costMicros maps to
 *     currency units (micros / 1,000,000 — the provider's own documented
 *     unit transformation, applied INSIDE the boundary).
 * Source timestamp maps from segments.date (the day the metric was true);
 * ETag from the response header; sourceVersion maps from the API version
 * used for the call (v16) — the ETag/version metadata paths of the frozen
 * support list are exercised here.
 *
 * The connector declares NO webhook and NO mutation capability: the frozen
 * webhook requirement for MKT-024 covers the Meta and analytics connectors,
 * and mutations are only implemented where the natural provider contract
 * defines them (the CRM contact sync).
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
  WebhookVerificationResult,
} from '../../../public.ts';
import {
  asArray,
  asObject,
  callProviderJson,
  isoDateAtMidnightUtc,
  metricEnvelope,
  parseNumberOrNull,
  parseProviderCredential,
  parseRateLimitHeaders,
  probeFromHttpResult,
  sourceRecordEnvelope,
} from '../../adapter-support.ts';

/** The Google Ads connector configuration (wired at the composition root). */
export interface GoogleAdsAdapterConfig {
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
export type GoogleAdsMappingResult =
  | { readonly ok: true; readonly records: readonly NormalizedProviderRecord[] }
  | { readonly ok: false; readonly error: string };

/** The metric fields one Google Ads metrics row is mapped to. */
const METRIC_FIELDS = ['impressions', 'clicks', 'costMicros', 'ctr'] as const;

/**
 * Pure mapping: a googleAds:search campaigns response → source-record
 * envelopes. A row without a campaign object carrying a non-empty string
 * id rejects the payload (fail closed).
 */
export function mapGoogleAdsCampaignsResponse(
  payload: Readonly<Record<string, unknown>>,
  input: { readonly etag: string | null; readonly sourceVersion: string },
): GoogleAdsMappingResult {
  const rows = asArray(payload['results']);
  if (rows === null) {
    return { ok: false, error: "malformed Google Ads payload: 'results' is not an array" };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed Google Ads payload: results[${index}] is not an object` };
    }
    const campaign = asObject(row['campaign']);
    if (campaign === null) {
      return { ok: false, error: `malformed Google Ads payload: results[${index}].campaign is not an object` };
    }
    const id = campaign['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: `malformed Google Ads payload: results[${index}].campaign.id is missing` };
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(campaign)) {
      if (value !== null && value !== undefined) fields[key] = value;
    }
    records.push({
      providerRecordId: `google-ads:campaign:${id}`,
      data: sourceRecordEnvelope('googleads.campaign', fields) as unknown as Record<string, unknown>,
      sourceTimestamp: null,
      etag: input.etag,
      sourceVersion: input.sourceVersion,
    });
  }
  return { ok: true, records };
}

/**
 * Pure mapping: a googleAds:search metrics response → metric-observation
 * envelopes, one record per (row x metric). Required identity:
 * campaign.id and segments.date; a present-but-non-numeric metric value
 * rejects the payload (fail closed); an absent metric field produces no
 * record. costMicros is converted to currency units inside the boundary
 * (micros / 1e6). Source timestamp maps from segments.date; sourceVersion
 * carries the API version; the ETag from the response rides every record.
 */
export function mapGoogleAdsMetricsResponse(
  payload: Readonly<Record<string, unknown>>,
  input: { readonly etag: string | null; readonly sourceVersion: string; readonly currency: string },
): GoogleAdsMappingResult {
  const rows = asArray(payload['results']);
  if (rows === null) {
    return { ok: false, error: "malformed Google Ads payload: 'results' is not an array" };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed Google Ads payload: results[${index}] is not an object` };
    }
    const campaign = asObject(row['campaign']);
    const segments = asObject(row['segments']);
    const metrics = asObject(row['metrics']);
    if (campaign === null || segments === null || metrics === null) {
      return {
        ok: false,
        error: `malformed Google Ads payload: results[${index}] is missing campaign/segments/metrics`,
      };
    }
    const campaignId = campaign['id'];
    if (typeof campaignId !== 'string' || campaignId.trim() === '') {
      return { ok: false, error: `malformed Google Ads payload: results[${index}].campaign.id is missing` };
    }
    const sourceTimestamp = isoDateAtMidnightUtc(segments['date']);
    if (sourceTimestamp === null) {
      return { ok: false, error: `malformed Google Ads payload: results[${index}].segments.date is not a plain date` };
    }
    const date = segments['date'] as string;
    const campaignName = typeof campaign['name'] === 'string' ? (campaign['name'] as string) : '';
    const dimensions: Record<string, string> = { campaignId, date };
    if (campaignName !== '') dimensions['campaignName'] = campaignName;
    for (const field of METRIC_FIELDS) {
      const raw = metrics[field];
      if (raw === undefined || raw === null) continue;
      const numeric = parseNumberOrNull(raw);
      if (numeric === null) {
        return {
          ok: false,
          error: `malformed Google Ads payload: results[${index}].metrics.${field} is not a number`,
        };
      }
      const value = field === 'costMicros' ? numeric / 1_000_000 : numeric;
      const metricName = field === 'costMicros' ? 'googleads.cost' : `googleads.${field}`;
      const unit = field === 'costMicros' ? input.currency : field === 'ctr' ? 'percent' : 'count';
      records.push({
        providerRecordId: `google-ads:metrics:${campaignId}:${date}:${field}`,
        data: metricEnvelope({
          metricName,
          dimensions,
          value,
          unit,
          aggregationMethod: 'sum',
        }) as unknown as Record<string, unknown>,
        sourceTimestamp,
        etag: input.etag,
        sourceVersion: input.sourceVersion,
      });
    }
  }
  return { ok: true, records };
}

/** The Google Ads (REST API-shaped) first-party adapter. */
export class GoogleAdsAdapter implements IntegrationAdapter {
  readonly descriptor = {
    adapterKey: 'google-ads',
    providerLabel: 'Google Ads',
    description:
      'Google Ads connector: campaign listing and campaign-metric reads (impressions, clicks, cost from micros, ctr) normalized to metric observations with ETag and API-version source metadata.',
  } as const;

  readonly capabilities = [
    {
      capabilityKey: 'google-ads-campaign-metrics',
      kind: 'read',
      operations: ['listCampaigns', 'getCampaignMetrics'],
      description: 'Campaign listing and campaign-metric reads through googleAds:search-shaped requests.',
    },
  ] as const;

  private readonly http: HttpCallPort;
  private readonly timeoutMs: number;
  private readonly sizeCapBytes: number;
  private readonly defaultBaseUrl: string;

  constructor(config: GoogleAdsAdapterConfig) {
    this.http = config.http;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sizeCapBytes = config.sizeCapBytes ?? 262_144;
    this.defaultBaseUrl = config.defaultBaseUrl ?? 'https://googleads.googleapis.com';
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
      url: this.customerUrl(context),
      method: 'GET',
      headers: this.headers(credential.accessToken),
      body: null,
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    return probeFromHttpResult(result, 'google-ads');
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
    const customerId = context.providerConfig['customerId'] ?? '';
    if (customerId.trim() === '') {
      return { ok: false, records: [], error: 'providerConfig.customerId is required for google-ads reads', rateLimit: null };
    }
    const sourceVersion = context.providerConfig['apiVersion'] ?? 'v16';
    const currency = context.providerConfig['currency'] ?? 'USD';

    const query =
      request.operation === 'listCampaigns'
        ? 'SELECT campaign.id, campaign.name, campaign.status FROM campaign'
        : request.operation === 'getCampaignMetrics'
          ? 'SELECT campaign.id, campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr FROM campaign WHERE segments.date DURING LAST_30_DAYS'
          : null;
    if (query === null) {
      return {
        ok: false,
        records: [],
        error: `google-ads read operation '${request.operation}' is not mapped by this adapter`,
        rateLimit: null,
      };
    }

    const result = await callProviderJson(this.http, {
      url: `${this.customerUrl(context)}/googleAds:search`,
      method: 'POST',
      headers: this.headers(credential.accessToken),
      body: JSON.stringify({ query }),
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    const rateLimit = parseRateLimitHeaders(result.headers);
    if (!result.ok || result.body === null) {
      return { ok: false, records: [], error: result.error, rateLimit };
    }
    const etag = result.headers['etag'] ?? null;
    const mapping =
      request.operation === 'listCampaigns'
        ? mapGoogleAdsCampaignsResponse(result.body, { etag, sourceVersion })
        : mapGoogleAdsMetricsResponse(result.body, { etag, sourceVersion, currency });
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
      error: 'google-ads declares no mutation capability',
      rateLimit: null,
    };
  }

  async verifyWebhook(): Promise<WebhookVerificationResult> {
    // No webhook capability is declared; the module rejects webhook
    // ingestion before reaching here (belt-and-braces data posture).
    return { verified: false, reason: 'google-ads declares no webhook capability', normalizedEventType: null };
  }

  private customerUrl(context: IntegrationAdapterCallContext): string {
    const configured = context.providerConfig['apiBaseUrl'];
    const base = configured !== undefined && configured.trim() !== '' ? configured : this.defaultBaseUrl;
    const version = context.providerConfig['apiVersion'] ?? 'v16';
    const customerId = context.providerConfig['customerId'] ?? 'unknown';
    return `${base}/${version}/customers/${customerId}`;
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }
}
