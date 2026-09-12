/**
 * Generic analytics platform first-party connector — MKT-024, INT-001.
 *
 * One adapter subtree under internal/adapters/analytics/: this file owns
 * all analytics-platform-specific knowledge (GA4 runReport-shaped request/
 * response translation, event-stream authenticity verification) behind the
 * generic IntegrationAdapter port. Wired ONLY at the composition root; no
 * domain module imports it. Egress uses the platform HttpCallPort — NO
 * analytics SDK anywhere.
 *
 * providerConfig (non-secret): apiBaseUrl (sandbox/loopback override),
 * propertyId and the reporting currency. The credential material (opaque
 * provider JSON — see adapter-support) is resolved by the /integrations
 * module after a fail-closed /policies allow; its accessToken field
 * authorizes reads and its webhookSecret field verifies inbound event
 * deliveries (in-process only, §21).
 *
 * READ operations map runReport-shaped payloads to NORMALIZED metric
 * observations (METRIC-001): one metric-observation envelope per
 * (report row x metric). Dimension header names and values are preserved
 * as the observation dimensions (the provider's own dimension identity);
 * a compact GA4 'date' dimension maps to the source timestamp (the day
 * the metric was true); the metric header type maps the unit
 * (TYPE_INTEGER → count, TYPE_CURRENCY → the connection currency);
 * metricName is namespaced 'analytics.<provider metric name>'. The
 * provider row identity maps to the composite providerRecordId inside
 * the boundary.
 *
 * WEBHOOK/EVENT ingestion (one of the two frozen MKT-024 webhook
 * connectors, with meta-ads): X-Analytics-Signature HMAC-SHA256
 * verification over the delivered payload, through the boundary's
 * existing append-oriented ingestion surface with server-derived
 * provenance.
 *
 * INVARIANTS: invocation failures are DATA, never thrown; malformed
 * provider payloads fail closed as data errors; rate-limit/backoff
 * metadata is surfaced on every outcome (§20).
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
  compactDateToIsoUtc,
  metricEnvelope,
  parseNumberOrNull,
  parseProviderCredential,
  parseRateLimitHeaders,
  probeFromHttpResult,
  verifyHmacWebhookDelivery,
} from '../../adapter-support.ts';

/** The analytics connector configuration (wired at the composition root). */
export interface GenericAnalyticsAdapterConfig {
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
export type AnalyticsMappingResult =
  | { readonly ok: true; readonly records: readonly NormalizedProviderRecord[] }
  | { readonly ok: false; readonly error: string };

/**
 * Pure mapping: a runReport-shaped analytics response → metric-observation
 * envelopes, one record per (row x metric). The dimension header names and
 * the row's dimension values become the observation dimensions (provider
 * dimension identity preserved); a compact 'date' dimension maps to the
 * source timestamp; the metric header type maps the unit. A
 * present-but-non-numeric metric value rejects the payload (fail closed).
 */
export function mapAnalyticsReportResponse(
  payload: Readonly<Record<string, unknown>>,
  input: { readonly etag: string | null; readonly currency: string },
): AnalyticsMappingResult {
  const dimensionHeaders = asArray(payload['dimensionHeaders']);
  const metricHeaders = asArray(payload['metricHeaders']);
  const rows = asArray(payload['rows']);
  if (dimensionHeaders === null || metricHeaders === null || rows === null) {
    return {
      ok: false,
      error: 'malformed analytics report payload: dimensionHeaders/metricHeaders/rows must be arrays',
    };
  }
  const dimensionNames: string[] = [];
  for (const [index, entry] of dimensionHeaders.entries()) {
    const header = asObject(entry);
    const name = header === null ? header : header['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: `malformed analytics report payload: dimensionHeaders[${index}].name is missing` };
    }
    dimensionNames.push(name);
  }
  const metrics: { name: string; unit: string }[] = [];
  for (const [index, entry] of metricHeaders.entries()) {
    const header = asObject(entry);
    const name = header === null ? null : header['name'];
    const type = header === null ? null : header['type'];
    if (typeof name !== 'string' || name.trim() === '') {
      return { ok: false, error: `malformed analytics report payload: metricHeaders[${index}].name is missing` };
    }
    const unit = type === 'TYPE_CURRENCY' ? input.currency : 'count';
    metrics.push({ name, unit });
  }
  if (metrics.length === 0) {
    return { ok: false, error: 'malformed analytics report payload: no metric headers' };
  }

  const records: NormalizedProviderRecord[] = [];
  for (const [rowIndex, rowEntry] of rows.entries()) {
    const row = asObject(rowEntry);
    if (row === null) {
      return { ok: false, error: `malformed analytics report payload: rows[${rowIndex}] is not an object` };
    }
    const dimensionValues = asArray(row['dimensionValues']);
    const metricValues = asArray(row['metricValues']);
    if (dimensionValues === null || metricValues === null) {
      return {
        ok: false,
        error: `malformed analytics report payload: rows[${rowIndex}] dimensionValues/metricValues must be arrays`,
      };
    }
    const dimensions: Record<string, string> = {};
    const dimensionIdentities: string[] = [];
    for (const [dimensionIndex, entry] of dimensionValues.entries()) {
      const value = asObject(entry);
      const raw = value === null ? null : value['value'];
      if (typeof raw !== 'string') {
        return {
          ok: false,
          error: `malformed analytics report payload: rows[${rowIndex}].dimensionValues[${dimensionIndex}].value is not a string`,
        };
      }
      const name = dimensionNames[dimensionIndex] ?? `dim${dimensionIndex}`;
      dimensions[name] = raw;
      dimensionIdentities.push(raw);
    }
    // The compact 'date' dimension (YYYYMMDD) is the source timestamp.
    const sourceTimestamp =
      dimensions['date'] !== undefined ? compactDateToIsoUtc(dimensions['date']) : null;
    for (const [metricIndex, entry] of metricValues.entries()) {
      const metricValue = asObject(entry);
      const raw = metricValue === null ? null : metricValue['value'];
      const numeric = parseNumberOrNull(raw);
      if (numeric === null) {
        return {
          ok: false,
          error: `malformed analytics report payload: rows[${rowIndex}].metricValues[${metricIndex}].value is not a number`,
        };
      }
      const metric = metrics[metricIndex];
      if (metric === undefined) {
        return {
          ok: false,
          error: `malformed analytics report payload: rows[${rowIndex}] has more metric values than metric headers`,
        };
      }
      records.push({
        providerRecordId: `analytics:report:${dimensionIdentities.join(':')}:${metric.name}`,
        data: metricEnvelope({
          metricName: `analytics.${metric.name}`,
          dimensions,
          value: numeric,
          unit: metric.unit,
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

/** The generic analytics platform first-party adapter. */
export class GenericAnalyticsAdapter implements IntegrationAdapter {
  readonly descriptor = {
    adapterKey: 'generic-analytics',
    providerLabel: 'Generic analytics platform',
    description:
      'Analytics connector: runReport-shaped reads normalized to metric observations (provider dimension identity preserved) and HMAC-verified event-stream ingestion.',
  } as const;

  readonly capabilities = [
    {
      capabilityKey: 'analytics-reports',
      kind: 'read',
      operations: ['runReport'],
      description: 'Report reads: one normalized metric observation per report row and metric.',
    },
    {
      capabilityKey: 'analytics-event-stream',
      kind: 'webhook',
      operations: ['event.received'],
      description: 'Inbound event-stream deliveries verified via X-Analytics-Signature.',
    },
  ] as const;

  private readonly http: HttpCallPort;
  private readonly timeoutMs: number;
  private readonly sizeCapBytes: number;
  private readonly defaultBaseUrl: string;

  constructor(config: GenericAnalyticsAdapterConfig) {
    this.http = config.http;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sizeCapBytes = config.sizeCapBytes ?? 262_144;
    this.defaultBaseUrl = config.defaultBaseUrl ?? 'https://analyticsprovider.example.com';
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
    return probeFromHttpResult(result, 'generic-analytics');
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
    const propertyId = context.providerConfig['propertyId'] ?? '';
    if (propertyId.trim() === '') {
      return {
        ok: false,
        records: [],
        error: 'providerConfig.propertyId is required for generic-analytics reads',
        rateLimit: null,
      };
    }
    const currency = context.providerConfig['currency'] ?? 'USD';
    if (request.operation !== 'runReport') {
      return {
        ok: false,
        records: [],
        error: `generic-analytics read operation '${request.operation}' is not mapped by this adapter`,
        rateLimit: null,
      };
    }

    const result = await callProviderJson(this.http, {
      url: `${this.baseUrl(context)}/v1beta/properties/${propertyId}:runReport`,
      method: 'POST',
      headers: this.headers(credential.accessToken),
      body: JSON.stringify({
        dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }, { name: 'conversions' }],
      }),
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    const rateLimit = parseRateLimitHeaders(result.headers);
    if (!result.ok || result.body === null) {
      return { ok: false, records: [], error: result.error, rateLimit };
    }
    const etag = result.headers['etag'] ?? null;
    const mapping = mapAnalyticsReportResponse(result.body, { etag, currency });
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
      error: 'generic-analytics declares no mutation capability',
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
    return verifyHmacWebhookDelivery(delivery, credential.webhookSecret, 'x-analytics-signature', `analytics:${delivery.eventType}`);
  }

  private baseUrl(context: IntegrationAdapterCallContext): string {
    const configured = context.providerConfig['apiBaseUrl'];
    return configured !== undefined && configured.trim() !== '' ? configured : this.defaultBaseUrl;
  }

  private headers(accessToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }
}
