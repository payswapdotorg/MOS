/**
 * CRM first-party connector — MKT-024, INT-001.
 *
 * One adapter subtree under internal/adapters/crm/: this file owns all
 * CRM-specific knowledge behind the generic IntegrationAdapter port.
 * Wired ONLY at the composition root; no domain module imports it. Egress
 * uses the platform HttpCallPort — NO CRM SDK anywhere.
 *
 * providerConfig (non-secret): apiBaseUrl (sandbox/loopback override).
 * The credential material (opaque provider JSON — see adapter-support) is
 * resolved by the /integrations module AFTER a fail-closed /policies
 * allow (network dimension 'integration.mutate' for contact sync, plus
 * the secrets dimension for credential use) and is sent as an
 * Authorization bearer header, in-process only (§21).
 *
 * READ operations (METRIC-001 posture): listContacts maps provider
 * contact records to source-record envelopes (kind 'record') — contact
 * data is a provider source fact delivered through the /evidence public
 * contract, NOT a metric observation (no measured series). The provider
 * record id maps to the composite providerRecordId inside the boundary;
 * updatedAt maps to the source timestamp; the response ETag rides every
 * record.
 *
 * MUTATION operations — the one sanctioned mutation surface of the
 * MKT-024 first-party set (implementation-contract §20 "mutation
 * operations"; the CRM contact sync): upsertContact forwards the
 * validated caller parameters as the provider upsert body and maps the
 * provider's {id, result} outcome to the normalized mutation result.
 * EVERY invocation is policy-gated inside the /integrations module
 * (fail-closed on deny/unknown BEFORE any credential resolution or
 * provider traffic) — this adapter contains no policy logic and never
 * bypasses the gate.
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
  isoTimestampOrNull,
  parseProviderCredential,
  parseRateLimitHeaders,
  probeFromHttpResult,
  sourceRecordEnvelope,
} from '../../adapter-support.ts';

/** The CRM connector configuration (wired at the composition root). */
export interface CrmAdapterConfig {
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
export type CrmMappingResult =
  | { readonly ok: true; readonly records: readonly NormalizedProviderRecord[] }
  | { readonly ok: false; readonly error: string };

/**
 * Pure mapping: a CRM contacts response → source-record envelopes.
 * A row without a non-empty string id rejects the payload (fail closed);
 * updatedAt (when present and ISO-shaped) maps to the source timestamp.
 */
export function mapCrmContactsResponse(
  payload: Readonly<Record<string, unknown>>,
  etag: string | null,
): CrmMappingResult {
  const rows = asArray(payload['contacts']);
  if (rows === null) {
    return { ok: false, error: "malformed CRM payload: 'contacts' is not an array" };
  }
  const records: NormalizedProviderRecord[] = [];
  for (const [index, entry] of rows.entries()) {
    const row = asObject(entry);
    if (row === null) {
      return { ok: false, error: `malformed CRM payload: contacts[${index}] is not an object` };
    }
    const id = row['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: `malformed CRM payload: contacts[${index}].id is missing` };
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && value !== undefined) fields[key] = value;
    }
    records.push({
      providerRecordId: `crm:contact:${id}`,
      data: sourceRecordEnvelope('crm.contact', fields) as unknown as Record<string, unknown>,
      sourceTimestamp: isoTimestampOrNull(row['updatedAt'] ?? row['updated_at']),
      etag,
      sourceVersion: null,
    });
  }
  return { ok: true, records };
}

/**
 * Pure mapping: a CRM upsert response → the normalized mutation outcome
 * data. The provider's record identity must be a non-empty string; the
 * result field is preserved verbatim.
 */
export function mapCrmUpsertResponse(
  payload: Readonly<Record<string, unknown>>,
): { ok: true; providerRecordId: string; data: Record<string, unknown> } | { ok: false; error: string } {
  const id = payload['id'];
  if (typeof id !== 'string' || id.trim() === '') {
    return { ok: false, error: 'malformed CRM upsert response: id is missing' };
  }
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && value !== undefined) data[key] = value;
  }
  return { ok: true, providerRecordId: `crm:contact:${id}`, data };
}

/** The CRM first-party adapter (reads + the contact-sync mutation). */
export class CrmAdapter implements IntegrationAdapter {
  readonly descriptor = {
    adapterKey: 'crm',
    providerLabel: 'Generic CRM',
    description:
      'CRM connector: contact listing normalized to source facts, and the policy-gated upsertContact contact-sync mutation.',
  } as const;

  readonly capabilities = [
    {
      capabilityKey: 'crm-contacts-read',
      kind: 'read',
      operations: ['listContacts'],
      description: 'Contact listing (provider contact records as source facts).',
    },
    {
      capabilityKey: 'crm-contacts-sync',
      kind: 'mutation',
      operations: ['upsertContact'],
      description: 'Contact sync: policy-gated contact upsert through the provider API.',
    },
  ] as const;

  private readonly http: HttpCallPort;
  private readonly timeoutMs: number;
  private readonly sizeCapBytes: number;
  private readonly defaultBaseUrl: string;

  constructor(config: CrmAdapterConfig) {
    this.http = config.http;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.sizeCapBytes = config.sizeCapBytes ?? 262_144;
    this.defaultBaseUrl = config.defaultBaseUrl ?? 'https://crmprovider.example.com';
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
      url: `${this.baseUrl(context)}/v1/ping`,
      method: 'GET',
      headers: this.headers(credential.accessToken),
      body: null,
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    return probeFromHttpResult(result, 'crm');
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
    if (request.operation !== 'listContacts') {
      return {
        ok: false,
        records: [],
        error: `crm read operation '${request.operation}' is not mapped by this adapter`,
        rateLimit: null,
      };
    }
    const result = await callProviderJson(this.http, {
      url: `${this.baseUrl(context)}/v1/contacts`,
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
    const mapping = mapCrmContactsResponse(result.body, result.headers['etag'] ?? null);
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
    if (request.operation !== 'upsertContact') {
      return {
        ok: false,
        providerRecordId: null,
        data: null,
        error: `crm mutation operation '${request.operation}' is not mapped by this adapter`,
        rateLimit: null,
      };
    }
    // The parameters were already validated by the module (bounded object,
    // no material-shaped keys at any level — §21); they are forwarded as
    // the provider upsert body verbatim.
    const result = await callProviderJson(this.http, {
      url: `${this.baseUrl(context)}/v1/contacts/upsert`,
      method: 'POST',
      headers: this.headers(credential.accessToken),
      body: JSON.stringify(request.parameters),
      timeoutMs: this.timeoutMs,
      sizeCapBytes: this.sizeCapBytes,
    });
    const rateLimit = parseRateLimitHeaders(result.headers);
    if (!result.ok || result.body === null) {
      return { ok: false, providerRecordId: null, data: null, error: result.error, rateLimit };
    }
    const mapping = mapCrmUpsertResponse(result.body);
    if (!mapping.ok) {
      return { ok: false, providerRecordId: null, data: null, error: mapping.error, rateLimit };
    }
    return { ok: true, providerRecordId: mapping.providerRecordId, data: mapping.data, error: null, rateLimit };
  }

  async verifyWebhook(): Promise<WebhookVerificationResult> {
    return { verified: false, reason: 'crm declares no webhook capability', normalizedEventType: null };
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
