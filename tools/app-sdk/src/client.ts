/**
 * MOS App SDK — the typed HTTP CLIENT surface (MKT-049; the developer
 * workflow client over the Developer Portal route family + the /apps
 * registry public routes).
 *
 *   GET  /api/developer-portal/catalog                     the developer catalog
 *   GET  /api/developer-portal/apps/:appKey/versions       the version history view
 *   GET  /api/developer-portal/apps/:appKey/versions/:v    the developer version view (validation status)
 *   POST /api/developer-portal/validate                    online validation through the REAL registry guard (pure)
 *   POST /api/developer-portal/publish                     delegated publish (+ optional signature)
 *   GET  /api/developer-portal/docs                        the documentation surface
 *   POST /api/apps/compatibility                           the registry compatibility query
 *
 * The client is PRESENTATION over the authoritative APIs (the same
 * surface contract the UI uses — architecture-v1.5.md §15): it adds NO
 * authority, owns NO state and performs NO client-side permission
 * decisions. Failures surface as typed MosApiError (status + body)
 * preserving the server's 401/403/404/409/422 semantics.
 *
 * Uses the platform `fetch` (Node >= 18) — NO external dependencies,
 * NO imports from the MOS repository (standalone outbound artifact).
 */

import type { AppCompatibilityQuery, AppManifest, AppManifestSignature } from './types.ts';

// ---------------------------------------------------------------------------
// Response DTO types (the serialized route shapes)
// ---------------------------------------------------------------------------

/** One published App Version as the routes serialize it. */
export interface AppVersionDto {
  readonly appVersionId: string;
  readonly appKey: string;
  readonly publisher: string;
  readonly manifest: AppManifest;
  readonly certificationState: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One developer-catalog entry (distinct app key rollup). */
export interface AppCatalogEntryDto {
  readonly appKey: string;
  readonly publisher: string;
  readonly versionCount: number;
  readonly newestVersion: string;
  readonly newestByPublication: AppVersionDto;
  readonly certificationState: string;
}

/** The developer version view's validation-status block. */
export interface AppVersionValidationStatusDto {
  readonly published: boolean;
  readonly manifestValidAtPublish: boolean;
  readonly integrity: {
    readonly algorithm: 'manifest-sha256-fingerprint';
    readonly digest: string;
    readonly verified: boolean;
  };
}

/** The full developer version view (GET .../versions/:version). */
export interface AppVersionViewDto extends AppVersionDto {
  readonly validationStatus: AppVersionValidationStatusDto;
  readonly vocabulary: Readonly<Record<string, ReadonlyRecord>>;
}

interface ReadonlyRecord {
  [key: string]: unknown;
}

/** The online validation verdict (POST /api/developer-portal/validate). */
export interface ManifestValidationDto {
  readonly valid: boolean;
  readonly problems: readonly string[];
  readonly rejectionClass: 'certification-territory' | 'invalid' | null;
  readonly signature: {
    readonly algorithm: string;
    readonly digest: string;
    readonly verified: boolean;
  } | null;
}

/** The publish result (201) — plus the signature acceptance disclosure. */
export interface PublishResultDto {
  readonly appVersion: AppVersionDto;
  readonly signature: {
    readonly algorithm: 'manifest-sha256-fingerprint';
    readonly digest: string;
    readonly verified: boolean;
  } | null;
}

/** One eligible/ineligible entry of the compatibility report. */
export interface CompatibilityReportDto {
  readonly eligible: readonly AppVersionDto[];
  readonly ineligible: ReadonlyArray<{
    readonly appVersion: AppVersionDto;
    readonly reasons: readonly string[];
  }>;
}


/** The served documentation surface (GET /api/developer-portal/docs). */
export interface DeveloperPortalDocsDto {
  readonly title: string;
  readonly generatedFrom: string;
  readonly manifestFields: ReadonlyArray<{
    readonly field: string;
    readonly type: string;
    readonly required: boolean;
    readonly description: string;
  }>;
  readonly vocabularies: Readonly<Record<string, ReadonlyArray<{ value: string; meaning: string }>>>;
  readonly signature: Readonly<Record<string, unknown>>;
  readonly portalEndpoints: ReadonlyArray<{
    method: string;
    path: string;
    description: string;
  }>;
  readonly developerWorkflow: readonly string[];
  readonly sdk: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// The typed API error
// ---------------------------------------------------------------------------

/** The server's typed failure surface (401/403/404/409/422 semantics preserved). */
export class MosApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: readonly string[];

  constructor(status: number, body: unknown) {
    const record = (body ?? {}) as Record<string, unknown>;
    super(
      typeof record['message'] === 'string'
        ? (record['message'] as string)
        : `MOS API request failed with status ${status}`,
    );
    this.name = 'MosApiError';
    this.status = status;
    this.code = typeof record['code'] === 'string' ? (record['code'] as string) : null;
    this.details = Array.isArray(record['details'])
      ? ((record['details'] as unknown[]).filter((detail): detail is string => typeof detail === 'string'))
      : [];
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface MosDeveloperPortalClientOptions {
  /** The API base URL (e.g. 'http://127.0.0.1:3000' — no trailing slash). */
  readonly baseUrl: string;
  /** The bearer token (the authenticated platform developer). */
  readonly token: string;
  /** Injectable fetch (tests stub this; defaults to global fetch). */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export class MosDeveloperPortalClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: MosDeveloperPortalClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  // -- reads -----------------------------------------------------------------

  /** The developer catalog: distinct app keys with version counts + newest. */
  async getCatalog(): Promise<readonly AppCatalogEntryDto[]> {
    const body = await this.getJson('/api/developer-portal/catalog');
    const apps = (body as Record<string, unknown>)['apps'];
    if (!Array.isArray(apps)) throw new MosApiError(500, { message: 'catalog: malformed response' });
    return apps as readonly AppCatalogEntryDto[];
  }

  /** The version history view of one app key (newest first). */
  async getAppVersions(appKey: string): Promise<readonly AppVersionDto[]> {
    const body = await this.getJson(`/api/developer-portal/apps/${encodeURIComponent(appKey)}/versions`);
    const versions = (body as Record<string, unknown>)['versions'];
    if (!Array.isArray(versions)) throw new MosApiError(500, { message: 'versions: malformed response' });
    return versions as readonly AppVersionDto[];
  }

  /** The developer version view: manifest + validation status + annotations. */
  async getAppVersion(appKey: string, version: string): Promise<AppVersionViewDto> {
    return (await this.getJson(
      `/api/developer-portal/apps/${encodeURIComponent(appKey)}/versions/${encodeURIComponent(version)}`,
    )) as AppVersionViewDto;
  }

  /** The documentation surface (generated from the frozen contracts). */
  async getDocs(): Promise<DeveloperPortalDocsDto> {
    return (await this.getJson('/api/developer-portal/docs')) as DeveloperPortalDocsDto;
  }

  /** The registry compatibility query (pure read, POST body). */
  async queryCompatibility(query: AppCompatibilityQuery): Promise<CompatibilityReportDto> {
    return (await this.postJson('/api/apps/compatibility', query)) as CompatibilityReportDto;
  }

  // -- pure validation --------------------------------------------------------

  /**
   * Online validation through the REAL registry guard (pure — no state
   * change). The manifest rides in its TYPED form (the guard's own
   * language: network-destination ports are numbers). Optionally verify
   * a signature attestation in the same call.
   */
  async validateManifest(
    manifest: AppManifest,
    signature?: AppManifestSignature | null,
  ): Promise<ManifestValidationDto> {
    const body: Record<string, unknown> = { manifest };
    if (signature !== undefined && signature !== null) {
      body['signature'] = signature;
    }
    return (await this.postJson('/api/developer-portal/validate', body)) as ManifestValidationDto;
  }

  // -- the delegated mutation ---------------------------------------------------

  /**
   * The HTTP WIRE form of the manifest: the publish DTOs accept the
   * network-destination `port` as a STRING (the MKT-047 route surface
   * contract) while the canonical typed manifest (and the canonical
   * FINGERPRINT the signature attests) carries it as a NUMBER — the
   * registry deserializes the wire form back to the identical typed
   * form, so the developer's signature still verifies. The client
   * accepts the TYPED manifest everywhere and wire-ifies internally.
   */
  private toWireManifest(manifest: AppManifest): Record<string, unknown> {
    const wire = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    const destinations = wire['networkDestinations'];
    if (Array.isArray(destinations)) {
      wire['networkDestinations'] = destinations.map((destination) => {
        if (destination !== null && typeof destination === 'object') {
          const record = destination as Record<string, unknown>;
          return {
            ...record,
            ...(typeof record['port'] === 'number'
              ? { port: String(record['port']) }
              : {}),
          };
        }
        return destination;
      });
    }
    return wire;
  }

  /**
   * Publish a NEW immutable App Version through the Developer Portal
   * (delegates to the /apps registry publish command; the publisher
   * identity is server-derived; the optional signature is verified
   * server-side against the CANONICAL typed manifest). Returns 201 with
   * the published record + the signature acceptance disclosure.
   */
  async publishAppVersion(
    manifest: AppManifest,
    idempotencyKey: string,
    signature?: AppManifestSignature | null,
  ): Promise<PublishResultDto> {
    const body: Record<string, unknown> = {
      manifest: this.toWireManifest(manifest),
      idempotencyKey,
    };
    if (signature !== undefined && signature !== null) {
      body['signature'] = signature;
    }
    const response = await this.requestJson('POST', '/api/developer-portal/publish', body);
    return response as unknown as PublishResultDto;
  }

  // -- internals -----------------------------------------------------------------

  private async getJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}` },
    });
    return this.unwrap(response);
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return this.unwrap(response);
  }

  private async requestJson(method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> {
    return method === 'GET' ? this.getJson(path) : this.postJson(path, body);
  }

  private async unwrap(response: Response): Promise<unknown> {
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { raw: text };
      }
    }
    if (!response.ok) {
      throw new MosApiError(response.status, body);
    }
    return body;
  }
}
