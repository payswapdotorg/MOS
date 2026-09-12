/**
 * Creator-platform first-party connector — MKT-038, CREATOR-001 (the
 * CREATOR-AC-05 provider integration proof).
 *
 * ONE adapter subtree under internal/adapters/creator-platform/: this
 * file owns ALL creator-platform-specific knowledge behind the generic
 * IntegrationAdapter port — the MKT-024 first-party connector pattern
 * exactly. Wired ONLY at the composition root (injected as DATA into the
 * /integrations module's adapter set); no domain module, no pack file and
 * no route imports it. Egress uses the platform HttpCallPort — NO creator
 * platform SDK, NO browser automation, NO scraping anywhere (the
 * architecture boundary tests assert this).
 *
 * SANDBOXED PROVIDER (sanctioned by the MKT-038 work order: "real or
 * sandboxed"): the default base URL is a documented example host; the
 * integration tests point providerConfig.apiBaseUrl at the in-process
 * LOOPBACK sandbox provider (tests/integration/helpers/sandbox-provider.ts)
 * which serves representative fixture payloads shaped like a creator
 * platform's responses — REAL HTTP calls over the fetch-based platform
 * HttpCallPort, NO external network.
 *
 * The capabilities this adapter declares are the SEVEN normalized creator
 * capabilities the MKT-037 Creator Operations Domain Pack declared as §6
 * integration-bindings (spec/creator-operations-v1.3.md §6: read
 * creator/account metrics; read audience/fan records; read
 * conversations/events; send an APPROVED communication; publish APPROVED
 * content; read monetization/transaction observations; receive provider
 * events/webhooks) — mapped ONE-TO-ONE onto the /integrations
 * connection/capability/observation contracts. The pack carries only the
 * provider-neutral labels and the boundary declaration; the provider
 * shapes live here and nowhere else.
 *
 * providerConfig (non-secret, string→string): apiBaseUrl (sandbox/loopback
 * override) + accountHandle (the creator account whose provider-side
 * records the reads target). The credential material (opaque provider
 * JSON — the shared first-party convention) is resolved by the
 * /integrations module AFTER a fail-closed /policies allow (network
 * dimension 'integration.read'/'integration.mutate' + the secrets
 * dimension for credential use) and is sent as an Authorization bearer
 * header, in-process only (§21).
 *
 * APPROVED-ONLY side effects: the two MUTATION capabilities
 * (sendConversationMessage, publishContentAsset) are the provider halves
 * of the pack's CREATOR-AC-06 gated side effects. EVERY invocation is
 * policy-gated inside the /integrations module (fail-closed on
 * deny/unknown BEFORE any credential resolution or provider traffic); the
 * DOMAIN-side approval chain (pack human approval records + the
 * 'creator.conversation.send'/'creator.content.publish' policy gates)
 * composes BEFORE the provider send in the sanctioned flow — this
 * adapter contains NO policy logic and NEVER bypasses a gate (proven by
 * the MKT-038 E2E negative tests: an unapproved side effect never
 * reaches the provider).
 *
 * READ operations (METRIC-001 posture): readAccountMetrics maps provider
 * account-metric rows to metric envelopes (kind 'metric' — measured
 * series), listFans/listConversations map provider records to
 * source-record envelopes (kind 'record' — provider source facts), and
 * readMonetizationEvents maps transaction observations to metric
 * envelopes with the revenue-cents convention. The provider record ids
 * map to composite providerRecordIds INSIDE the boundary (no raw
 * provider id becomes a domain identity); the provider updatedAt maps to
 * the source timestamp; the response ETag rides every record.
 *
 * WEBHOOK/EVENT ingestion: provider deliveries are HMAC-SHA256-verified
 * (the X-Creator-Signature header — the shared first-party convention)
 * against the connection's webhookSecret, timing-safe, with the
 * normalized event type `creator-platform:<providerEventType>`. A
 * verified delivery lands in the MKT-023 append-only integration event
 * ledger THROUGH the /integrations module (replay/dedup semantics
 * preserved: append-only history, nothing rewrites, an unverified
 * delivery records nothing).
 *
 * INVARIANTS: invocation failures are DATA (ok=false + error), never
 * thrown; malformed provider payloads fail closed as data errors; rate-
 * limit/backoff metadata is surfaced on every outcome (§20); secret
 * material never appears in envelopes, records or errors.
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
  isoTimestampOrNull,
  metricEnvelope,
  parseNumberOrNull,
  parseProviderCredential,
  parseRateLimitHeaders,
  probeFromHttpResult,
  sourceRecordEnvelope,
  verifyHmacWebhookDelivery,
} from '../../adapter-support.ts';

/** The creator-platform connector configuration (wired at the composition root). */
export interface CreatorPlatformAdapterConfig {
  /** The platform HttpCallPort (fetch-based — no provider SDK). */
  readonly http: HttpCallPort;
  /** Request deadline in milliseconds (default 15000; port cap 60000). */
  readonly timeoutMs?: number;
  /** Response body cap in bytes (default 262144; port cap 1048576). */
  readonly sizeCapBytes?: number;
  /** Production default base URL; sandbox connections override via providerConfig.apiBaseUrl. */
  readonly defaultBaseUrl?: string;
}

/**
 * The provider-side reference vocabulary — the bounded, path-safe shapes
 * this adapter accepts for provider references (account handles,
 * conversation references, content references) arriving in the
 * connection's non-secret providerConfig or in the caller's normalized
 * parameters. Provider-specific validation of what looks like a provider
 * reference is adapter-owned knowledge; the /integrations module only
 * bounds the envelope.
 */
const PROVIDER_REF_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The mapping outcome: normalized records as data, never a throw. */
export type CreatorMappingResult =
  | { readonly ok: true; readonly records: readonly NormalizedProviderRecord[] }
  | { readonly ok: false; readonly error: string };

/**
 * Pure mapping: a creator-platform account-metrics response → metric
 * envelopes. A row without a parseable source timestamp rejects the
 * payload (fail closed); the provider's follower/engagement/revenue
 * fields map to the normalized metric names.
 */
export function mapCreatorAccountMetricsResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CreatorMappingResult {
  return mapCreatorMetricRows(payload, 'accountMetrics', 'creator.account.metrics', etag, [
    ['followerCount', 'creator.performance.fan_count', 'count'],
    ['engagementCount', 'creator.performance.engagement_count', 'count'],
    ['revenueTotalCents', 'creator.monetization.revenue_cents', 'cents'],
  ]);
}

/**
 * Pure mapping: a creator-platform monetization response → metric
 * envelopes (one metric per provider transaction observation row).
 */
export function mapCreatorMonetizationResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CreatorMappingResult {
  return mapCreatorMetricRows(payload, 'monetization', 'creator.monetization.event', etag, [
    ['amountCents', 'creator.monetization.revenue_cents', 'cents'],
  ]);
}

/** Shared metric-row mapping: rows × fields → metric envelopes. */
function mapCreatorMetricRows(
  payload: Readonly<Record<string, unknown>>,
  listKey: string,
  recordIdPrefix: string,
  etag: string | null,
  fields: readonly (readonly [string, string, string])[],
): CreatorMappingResult {
  const rows = asArray(payload['rows']);
  if (rows === null) {
    return { ok: false, error: `malformed creator-platform payload: 'rows' of ${listKey} is not an array` };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed creator-platform payload: ${listKey}[${index}] is not an object` };
    }
    const observedAt = isoTimestampOrNull(row['observedAt'] ?? row['date']);
    if (observedAt === null) {
      return { ok: false, error: `malformed creator-platform payload: ${listKey}[${index}].observedAt is missing` };
    }
    const day = observedAt.slice(0, 10);
    for (const [providerField, metricName, unit] of fields) {
      const value = parseNumberOrNull(row[providerField]);
      if (value === null) {
        return {
          ok: false,
          error: `malformed creator-platform payload: ${listKey}[${index}].${providerField} is not a number`,
        };
      }
      records.push({
        providerRecordId: `creator:${recordIdPrefix}:${day}:${metricName}`,
        data: metricEnvelope({
          metricName,
          dimensions: { day },
          value,
          unit,
        }) as unknown as Record<string, unknown>,
        sourceTimestamp: observedAt,
        etag,
        sourceVersion: null,
      });
    }
  }
  return { ok: true, records };
}

/**
 * Pure mapping: a creator-platform fan/conversation listing →
 * source-record envelopes. A row without a non-empty string id rejects
 * the payload (fail closed); updatedAt maps to the source timestamp.
 */
export function mapCreatorRecordListingResponse(
  payload: Readonly<Record<string, unknown>>,
  listKey: string,
  recordType: string,
  idPrefix: string,
  etag: string | null,
): CreatorMappingResult {
  const rows = asArray(payload[listKey]);
  if (rows === null) {
    return { ok: false, error: `malformed creator-platform payload: '${listKey}' is not an array` };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed creator-platform payload: ${listKey}[${index}] is not an object` };
    }
    const id = row['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: `malformed creator-platform payload: ${listKey}[${index}].id is missing` };
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && value !== undefined) fields[key] = value;
    }
    records.push({
      providerRecordId: `creator:${idPrefix}:${id}`,
      data: sourceRecordEnvelope(recordType, fields) as unknown as Record<string, unknown>,
      sourceTimestamp: isoTimestampOrNull(row['updatedAt'] ?? row['updated_at']),
      etag,
      sourceVersion: null,
    });
  }
  return { ok: true, records };
}

/**
 * Pure mapping: a creator-platform send/publish response → the
 * normalized mutation outcome data. The provider's record identity must
 * be a non-empty string; the status is preserved verbatim.
 */
export function mapCreatorMutationResponse(
  payload: Readonly<Record<string, unknown>>,
  idPrefix: string,
): { ok: true; providerRecordId: string; data: Record<string, unknown> } | { ok: false; error: string } {
  const id = payload['id'];
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, error: 'malformed creator-platform mutation response: id is missing' };
  }
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && value !== undefined) data[key] = value;
  }
  return { ok: true, providerRecordId: `creator:${idPrefix}:${id}`, data };
}

/** The creator-platform first-party adapter (the MKT-038 connector). */
export class CreatorPlatformAdapter implements IntegrationAdapter {
  readonly descriptor = {
    adapterKey: 'creator-platform',
    providerLabel: 'Generic Creator Platform',
    description:
      'Creator-platform connector: the seven normalized creator capabilities of the MKT-037 pack §6 bindings — account-metric/fan/conversation/monetization reads, the policy-gated approved send/publish mutations, and HMAC-verified provider webhook events.',
  } as const;

  readonly capabilities = [
    {
      capabilityKey: 'read-creator-account-metrics',
      kind: 'read',
      operations: ['readAccountMetrics'],
      description: 'Read creator/account metrics (normalized metric envelopes behind the Integration boundary).',
    },
    {
      capabilityKey: 'read-audience-fan-records',
      kind: 'read',
      operations: ['listFans'],
      description: 'Read audience/fan records (provider source facts behind the Integration boundary).',
    },
    {
      capabilityKey: 'read-conversations-events',
      kind: 'read',
      operations: ['listConversations'],
      description: 'Read conversations/events (provider source facts behind the Integration boundary).',
    },
    {
      capabilityKey: 'send-approved-communication',
      kind: 'mutation',
      operations: ['sendConversationMessage'],
      description:
        'Send an APPROVED communication — the provider half of the pack-gated outbound side effect (every invocation is policy-gated inside /integrations).',
    },
    {
      capabilityKey: 'publish-approved-content',
      kind: 'mutation',
      operations: ['publishContentAsset'],
      description:
        'Publish APPROVED content — the provider half of the pack-gated publish side effect (every invocation is policy-gated inside /integrations).',
    },
    {
      capabilityKey: 'read-monetization-observations',
      kind: 'read',
      operations: ['readMonetizationEvents'],
      description: 'Read monetization/transaction observations (normalized metric envelopes behind the Integration boundary).',
    },
    {
      capabilityKey: 'receive-provider-events',
      kind: 'webhook',
      operations: ['message.created', 'fan.subscribed', 'monetization.recorded'],
      description: 'Creator-platform webhook deliveries verified via X-Creator-Signature (HMAC-SHA256).',
    },
  ] as const;

  private readonly http: HttpCallPort;
  private readonly timeoutMs: number;
  private readonly sizeCapBytes: number;
  private readonly defaultBaseUrl: string;

  constructor(config: CreatorPlatformAdapterConfig) {
    this.http = config.http;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sizeCapBytes = config.sizeCapBytes ?? 262_144;
    this.defaultBaseUrl = config.defaultBaseUrl ?? 'https://creatorplatform.example.com';
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
      url: `${this.baseUrl(context)}/v1/creator/health`,
      method: 'GET',
      headers: this.headers(credential.accessToken),
      body: null,
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    return probeFromHttpResult(result, 'creator-platform');
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
    if (
      request.operation !== 'readAccountMetrics' &&
      request.operation !== 'listFans' &&
      request.operation !== 'listConversations' &&
      request.operation !== 'readMonetizationEvents'
    ) {
      return {
        ok: false,
        records: [],
        error: `creator-platform read operation '${request.operation}' is not mapped by this adapter`,
        rateLimit: null,
      };
    }
    // The provider-side account handle is adapter-owned resolution: the
    // connection's non-secret providerConfig first, the sanctioned read
    // parameters second — both bounded to the provider ref vocabulary.
    const accountHandle = resolveAccountHandle(context.providerConfig, request.parameters);
    if (accountHandle === null) {
      return {
        ok: false,
        records: [],
        error: 'creator-platform reads require a bounded accountHandle in the connection providerConfig or read parameters',
        rateLimit: null,
      };
    }
    const url =
      request.operation === 'readAccountMetrics'
        ? `${this.baseUrl(context)}/v1/creator/accounts/${accountHandle}/metrics`
        : request.operation === 'listFans'
          ? `${this.baseUrl(context)}/v1/creator/accounts/${accountHandle}/fans`
          : request.operation === 'listConversations'
            ? `${this.baseUrl(context)}/v1/creator/accounts/${accountHandle}/conversations`
            : `${this.baseUrl(context)}/v1/creator/accounts/${accountHandle}/monetization`;
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
      request.operation === 'readAccountMetrics'
        ? mapCreatorAccountMetricsResponse(result.body, etag)
        : request.operation === 'listFans'
          ? mapCreatorRecordListingResponse(result.body, 'fans', 'creator.fan', 'fan', etag)
          : request.operation === 'listConversations'
            ? mapCreatorRecordListingResponse(result.body, 'conversations', 'creator.conversation', 'conversation', etag)
            : mapCreatorMonetizationResponse(result.body, etag);
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
    if (request.operation !== 'sendConversationMessage' && request.operation !== 'publishContentAsset') {
      return {
        ok: false,
        providerRecordId: null,
        data: null,
        error: `creator-platform mutation operation '${request.operation}' is not mapped by this adapter`,
        rateLimit: null,
      };
    }
    if (request.operation === 'sendConversationMessage') {
      // The provider-side conversation reference arrives in the normalized
      // parameters; this adapter owns the provider shape validation (a
      // bounded, path-safe provider ref and a bounded non-empty body —
      // payload munging never escapes the boundary). The parameters were
      // already bounded by the module (no material-shaped keys at any
      // level — §21); the approved body is forwarded as the provider
      // message body verbatim.
      const conversationRef = request.parameters['conversationRef'];
      if (typeof conversationRef !== 'string' || !PROVIDER_REF_PATTERN.test(conversationRef)) {
        return {
          ok: false,
          providerRecordId: null,
          data: null,
          error: 'sendConversationMessage parameters.conversationRef must match the provider reference vocabulary (^[a-z0-9][a-z0-9_-]{0,63}$)',
          rateLimit: null,
        };
      }
      const body = request.parameters['body'];
      if (typeof body !== 'string' || body.trim() === '' || body.length > 4096) {
        return {
          ok: false,
          providerRecordId: null,
          data: null,
          error: 'sendConversationMessage parameters.body must be a non-empty string of at most 4096 characters',
          rateLimit: null,
        };
      }
      const result = await callProviderJson(this.http, {
        url: `${this.baseUrl(context)}/v1/creator/conversations/${conversationRef}/messages`,
        method: 'POST',
        headers: this.headers(credential.accessToken),
        body: JSON.stringify({ body }),
        timeoutMs: this.timeoutMs,
        sizeCapBytes: this.sizeCapBytes,
      });
      return this.mapMutationOutcome(result, 'message');
    }
    // publishContentAsset: the provider-side asset reference and title
    // arrive in the normalized parameters; the same adapter-owned shape
    // validation applies.
    const assetRef = request.parameters['assetRef'];
    if (typeof assetRef !== 'string' || !PROVIDER_REF_PATTERN.test(assetRef)) {
      return {
        ok: false,
        providerRecordId: null,
        data: null,
        error: 'publishContentAsset parameters.assetRef must match the provider reference vocabulary (^[a-z0-9][a-z0-9_-]{0,63}$)',
        rateLimit: null,
      };
    }
    const title = request.parameters['title'];
    if (typeof title !== 'string' || title.trim() === '' || title.length > 256) {
      return {
        ok: false,
        providerRecordId: null,
        data: null,
        error: 'publishContentAsset parameters.title must be a non-empty string of at most 256 characters',
        rateLimit: null,
      };
    }
    const result = await callProviderJson(this.http, {
      url: `${this.baseUrl(context)}/v1/creator/content`,
      method: 'POST',
      headers: this.headers(credential.accessToken),
      body: JSON.stringify({ assetRef, title }),
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    return this.mapMutationOutcome(result, 'content');
  }

  async verifyWebhook(
    context: IntegrationAdapterCallContext,
    delivery: { readonly eventType: string; readonly payload: Readonly<Record<string, unknown>>; readonly headers: Readonly<Record<string, string>> },
  ): Promise<WebhookVerificationResult> {
    const credential = parseProviderCredential(context.credentialMaterial);
    if (credential === null || credential.webhookSecret === null) {
      return {
        verified: false,
        reason: 'credential material is not the expected provider JSON shape (webhookSecret missing)',
        normalizedEventType: null,
      };
    }
    return verifyHmacWebhookDelivery(
      delivery,
      credential.webhookSecret,
      'x-creator-signature',
      `creator-platform:${delivery.eventType}`,
    );
  }

  private mapMutationOutcome(
    result: Awaited<ReturnType<typeof callProviderJson>>,
    idPrefix: string,
  ): NormalizedMutationResult {
    const rateLimit = parseRateLimitHeaders(result.headers);
    if (!result.ok || result.body === null) {
      return { ok: false, providerRecordId: null, data: null, error: result.error, rateLimit };
    }
    const mapping = mapCreatorMutationResponse(result.body, idPrefix);
    if (!mapping.ok) {
      return { ok: false, providerRecordId: null, data: null, error: mapping.error, rateLimit };
    }
    return { ok: true, providerRecordId: mapping.providerRecordId, data: mapping.data, error: null, rateLimit };
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

/**
 * Resolves the provider-side account handle from the non-secret
 * providerConfig first, then the sanctioned read parameters — the
 * bounded provider reference vocabulary only. Pure.
 */
function resolveAccountHandle(
  providerConfig: Readonly<Record<string, string>>,
  parameters: Readonly<Record<string, unknown>>,
): string | null {
  const configured = providerConfig['accountHandle'];
  if (configured !== undefined && PROVIDER_REF_PATTERN.test(configured)) return configured;
  const supplied = parameters['accountHandle'];
  if (typeof supplied === 'string' && PROVIDER_REF_PATTERN.test(supplied)) return supplied;
  return null;
}
