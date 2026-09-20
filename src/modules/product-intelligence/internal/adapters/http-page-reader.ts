/**
 * The REAL ProductPageReader implementation (MKT-069): the bounded,
 * GET-only public-page read over the platform HttpCallPort (fetch-based —
 * zero provider SDKs). This is the composition-root-wired production
 * adapter of the /product-intelligence page-reader contract; the test
 * suite supplies the disclosed in-repo test double instead (NO live
 * network in the test suite).
 *
 * READ-ONLY BY CONSTRUCTION: the adapter performs exactly one HTTP verb —
 * GET — and the HttpCallPort enforces the fail-closed transport envelope
 * (https-only except loopback, hard timeout, bounded body). No mutation
 * toward any external source is expressible here (boundary rule 7).
 */

import type {
  HttpCallPort,
  HttpCallRequest,
  HttpCallResponse,
} from '../../../../platform/http/outbound.ts';
import type {
  ProductPageFetchRequest,
  ProductPageFetchOutcome,
  ProductPageReader,
} from '../../public.ts';

/** A loopback-safe URL check mirroring the port's own envelope rule. */
function urlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `url is not a valid absolute URL: ${url}`;
  }
  const isLoopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    return `url must be https (http is only permitted for loopback hosts): ${url}`;
  }
  return null;
}

export class HttpPageReader implements ProductPageReader {
  private readonly http: HttpCallPort;

  constructor(http: HttpCallPort) {
    this.http = http;
  }

  async fetch(request: ProductPageFetchRequest): Promise<ProductPageFetchOutcome> {
    const problem = urlProblem(request.url);
    if (problem !== null) {
      return {
        ok: false,
        status: null,
        body: null,
        contentType: null,
        transportRefused: true,
        timedOut: false,
        error: problem,
      };
    }
    const envelope: HttpCallRequest = {
      url: request.url,
      // GET-ONLY: the read-only inspection contract (boundary rule 7).
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5' },
      body: null,
      timeoutMs: request.timeoutMs,
      sizeCapBytes: request.sizeCapBytes,
    };
    let response: HttpCallResponse;
    try {
      response = await this.http.request(envelope);
    } catch (error) {
      // The port throws only for invalid envelopes; transport outcomes are
      // data. An unexpected throw is still an honest transport failure.
      return {
        ok: false,
        status: null,
        body: null,
        contentType: null,
        transportRefused: true,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.transportRefused || response.timedOut) {
      return {
        ok: false,
        status: response.status,
        body: null,
        contentType: null,
        transportRefused: response.transportRefused,
        timedOut: response.timedOut,
        error:
          response.timedOut
            ? 'the fetch deadline expired before the page was received'
            : 'the transport refused the fetch before the request was processed',
      };
    }
    const okStatus = response.status >= 200 && response.status < 300;
    return {
      ok: okStatus,
      status: response.status,
      body: okStatus ? response.body : null,
      contentType: response.headers['content-type'] ?? null,
      transportRefused: false,
      timedOut: false,
      error: okStatus ? null : `http status ${response.status}`,
    };
  }
}
