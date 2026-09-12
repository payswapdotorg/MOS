/**
 * Meta (Marketing API-shaped) first-party connector — MKT-024, INT-001.
 *
 * One adapter subtree under internal/adapters/meta/: this file owns ALL
 * Meta-specific knowledge (request translation, payload normalization,
 * authenticity verification) behind the generic IntegrationAdapter port
 * (implementation-contract §20: "An integration adapter owns
 * provider-specific API/SDK details. Core domains exchange normalized
 * contracts only"). The class is wired ONLY at the composition root
 * (CONCRETE_ADAPTER_ACCESS); no domain module imports it.
 *
 * Egress uses the platform HttpCallPort (fetch-based — NO Meta SDK is
 * imported anywhere). The connection's providerConfig carries the
 * non-secret endpoint/identity data: apiBaseUrl (sandbox/loopback override),
 * accountId (the ad account id), apiVersion and the reporting currency.
 * The credential material (opaque provider JSON — see adapter-support) is
 * resolved by the /integrations module through the /credentials
 * authorized-execution path AFTER a fail-closed /policies allow and exists
 * only in-process. It is sent as an Authorization bearer header — never as
 * a query parameter — so no credential value can appear in any logged URL
 * (implementation-contract §21).
 *
 * READ operations map provider payloads to NORMALIZED observations
 * (METRIC-001):
 *   - listCampaigns  → source-record envelopes (kind 'record') — campaign
 *     metadata is a provider source fact, not a metric;
 *   - getInsights    → one metric-observation envelope (kind 'metric') per
 *     (insights row x metric): impressions/clicks/spend/ctr with the
 *     provider identity preserved as the composite providerRecordId and
 *     the dimensions (campaign id/name/date).
 * The provider id is mapped INSIDE the boundary (composite record id +
 * dimensions + source reference); no raw provider id ever becomes a domain
 * identifier. Source timestamp maps from the insights date_start (the day
 * the metric was true); ETag from the response header; sourceVersion null
 * (Meta insights rows carry no version).
 *
 * WEBHOOK/EVENT ingestion: Meta-style X-Hub-Signature-256 HMAC-SHA256
 * verification over the delivered payload (the app secret is the
 * credential material's webhookSecret field — in-process only), through
 * the boundary's existing append-oriented ingestion surface.
 *
 * INVARIANTS: invocation failures are DATA (ok=false + error), never
 * thrown; malformed provider payloads fail closed as data errors (a row
 * with a non-numeric metric value or a missing identity field rejects the
 * read — no silent partial mapping); rate-limit/backoff metadata is
 * surfaced on every outcome (§20).
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
  callProviderJson,
  isoDateAtMidnightUtc,
  metricEnvelope,
  parseNumberOrNull,
  parseProviderCredential,
  parseRateLimitHeaders,
  probeFromHttpResult,
  sourceRecordEnvelope,
  verifyHmacWebhookDelivery,
} from '../../adapter-support.ts';

/** The Meta connector configuration (wired at the composition root). */
export interface MetaAdsAdapterConfig {
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
export type MetaMappingResult =
  | { readonly ok: true; readonly records: readonly NormalizedProviderRecord[] }
  | { readonly ok: false; readonly error: string };

/** The metric fields one Meta insights row is mapped to. */
const INSIGHTS_METRIC_FIELDS = ['impressions', 'clicks', 'spend', 'ctr'] as const;

/**
 * Pure mapping: a Meta campaigns response payload → source-record
 * envelopes. A row without a non-empty string id rejects the payload
 * (malformed — fail closed); missing optional fields are preserved as-is.
 * The ETag observed on the response is carried on every record.
 */
export function mapMetaCampaignsResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): MetaMappingResult {
  const rows = asArray(payload['data']);
  if (rows === null) {
    return { ok: false, error: "malformed Meta campaigns payload: 'data' is not an array" };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed Meta campaigns payload: data[${index}] is not an object` };
    }
    const id = row['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: `malformed Meta campaigns payload: data[${index}].id is missing` };
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && value !== undefined) fields[key] = value;
    }
    const updated = typeof row['updated_time'] === 'string' ? new Date(row['updated_time']) : null;
    const sourceTimestamp =
      updated !== null && !Number.isNaN(updated.getTime()) ? updated.toISOString() : null;
    records.push({
      providerRecordId: `meta:campaign:${id}`,
      data: sourceRecordEnvelope('meta.campaign', fields) as unknown as Record<string, unknown>,
      sourceTimestamp,
      etag,
      sourceVersion: null,
    });
  }
  return { ok: true, records };
}

/**
 * Pure mapping: a Meta insights response payload → metric-observation
 * envelopes, one record per (row x metric). Identity fields (campaign_id,
 * date_start) are required; a present-but-non-numeric metric value rejects
 * the payload (fail closed); an ABSENT metric field simply produces no
 * record (the provider did not report it). Source timestamp maps from
 * date_start; dimensions preserve the provider identity (campaign id,
 * name, date); spend takes the connection's reporting currency.
 */
export function mapMetaInsightsResponse(
  payload: Readonly<Record<string, unknown>>,
  input: { readonly etag: string | null; readonly currency: string },
): MetaMappingResult {
  const rows = asArray(payload['data']);
  if (rows === null) {
    return { ok: false, error: "malformed Meta insights payload: 'data' is not an array" };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed Meta insights payload: data[${index}] is not an object` };
    }
    const campaignId = row['campaign_id'];
    if (typeof campaignId !== 'string' || campaignId.trim() === '') {
      return { ok: false, error: `malformed Meta insights payload: data[${index}].campaign_id is missing` };
    }
    const sourceTimestamp = isoDateAtMidnightUtc(row['date_start']);
    if (sourceTimestamp === null) {
      return { ok: false, error: `malformed Meta insights payload: data[${index}].date_start is not a plain date` };
    }
    const campaignName = typeof row['campaign_name'] === 'string' ? (row['campaign_name'] as string) : '';
    const date = typeof row['date_start'] === 'string' ? (row['date_start'] as string) : '';
    const dimensions: Record<string, string> = { campaignId, date };
    if (campaignName !== '') dimensions['campaignName'] = campaignName;
    for (const field of INSIGHTS_METRIC_FIELDS) {
      const raw = row[field];
      if (raw === undefined || raw === null) continue;
      const value = parseNumberOrNull(raw);
      if (value === null) {
        return {
          ok: false,
          error: `malformed Meta insights payload: data[${index}].${field} is not a number`,
        };
      }
      const unit = field === 'spend' ? input.currency : field === 'ctr' ? 'percent' : 'count';
      records.push({
        providerRecordId: `meta:insights:${campaignId}:${date}:${field}`,
        data: metricEnvelope({
          metricName: `meta.ads.${field}`,
          dimensions,
          value,
          unit,
          aggregationMethod: 'sum',
        }) as unknown as Record<string, unknown>,
        sourceTimestamp,
        etag: input.etag,
        sourceVersion: null,
      });
    }
  }
  return { ok: true, records };
}

/** The Meta (Marketing API-shaped) first-party adapter. */
export class MetaAdsAdapter implements IntegrationAdapter {
  readonly descriptor = {
    adapterKey: 'meta-ads',
    providerLabel: 'Meta (Marketing API)',
    description:
      'Meta marketing connector: campaign listing, campaign-level insights reads normalized to metric observations, and X-Hub-Signature-256 verified webhook ingestion.',
  } as const;

  readonly capabilities = [
    {
      capabilityKey: 'meta-insights-read',
      kind: 'read',
      operations: ['listCampaigns', 'getInsights'],
      description: 'Campaign listing and campaign-level insights reads (impressions, clicks, spend, ctr).',
    },
    {
      capabilityKey: 'meta-webhook-events',
      kind: 'webhook',
      operations: ['insights.updated', 'page.updated'],
      description: 'Meta webhook deliveries verified via X-Hub-Signature-256.',
    },
  ] as const;

  private readonly http: HttpCallPort;
  private readonly timeoutMs: number;
  private readonly sizeCapBytes: number;
  private readonly defaultBaseUrl: string;

  constructor(config: MetaAdsAdapterConfig) {
    this.http = config.http;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sizeCapBytes = config.sizeCapBytes ?? 262_144;
    this.defaultBaseUrl = config.defaultBaseUrl ?? 'https://graph.facebook.com';
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
    const baseUrl = this.baseUrl(context);
    const result = await callProviderJson(this.http, {
      url: `${baseUrl}/me`,
      method: 'GET',
      headers: this.headers(credential.accessToken),
      body: null,
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    return probeFromHttpResult(result, 'meta-ads');
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
    const baseUrl = this.baseUrl(context);
    const accountId = context.providerConfig['accountId'] ?? '';
    if (accountId.trim() === '') {
      return { ok: false, records: [], error: 'providerConfig.accountId is required for meta-ads reads', rateLimit: null };
    }
    const version = context.providerConfig['apiVersion'] ?? 'v13.0';
    const currency = context.providerConfig['currency'] ?? 'USD';

    let url: string;
    if (request.operation === 'listCampaigns') {
      url = `${baseUrl}/${version}/act_${accountId}/campaigns?fields=id,name,status,objective,created_time,updated_time`;
    } else if (request.operation === 'getInsights') {
      url = `${baseUrl}/${version}/act_${accountId}/insights?level=campaign&fields=campaign_id,campaign_name,date_start,impressions,clicks,spend,ctr`;
    } else {
      return {
        ok: false,
        records: [],
        error: `meta-ads read operation '${request.operation}' is not mapped by this adapter`,
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
    const mapping =
      request.operation === 'listCampaigns'
        ? mapMetaCampaignsResponse(result.body, etag)
        : mapMetaInsightsResponse(result.body, { etag, currency });
    if (!mapping.ok) {
      return { ok: false, records: [], error: mapping.error, rateLimit };
    }
    return { ok: true, records: mapping.records, error: null, rateLimit };
  }

  async mutate(): Promise<NormalizedMutationResult> {
    // The Meta connector declares no mutation capability — the module's
    // capability gate rejects mutations before reaching here; this is the
    // belt-and-braces data posture.
    return {
      ok: false,
      providerRecordId: null,
      data: null,
      error: 'meta-ads declares no mutation capability',
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
    return verifyHmacWebhookDelivery(delivery, credential.webhookSecret, 'x-hub-signature-256', `meta:${delivery.eventType}`);
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
