/**
 * The production public-source fetcher of /product-intelligence (MKT-069,
 * AC-2): the ProductSourceFetcher port implementation riding the PLATFORM
 * HttpCallPort — bounded, https-only (plain http for loopback hosts
 * only), with a hard timeout and a bounded response body. NO provider
 * SDK, NO platform-specific knowledge: this is the generic fetch
 * capability behind the module's read-only port.
 *
 * Transport-level outcomes (refused connections, timeouts, HTTP error
 * statuses) are returned as DATA (ok=false) — never thrown — so the
 * inspection pipeline fails honestly per-input. The test suite supplies
 * the DISCLOSED test double instead (NO live network in the test suite);
 * the loopback-host allowance is what lets the integration tests drive
 * the PRODUCTION fetcher against a local fixture-page server (the
 * oauth-provider precedent).
 */

import type { HttpCallPort, HttpCallResponse } from '../../../platform/http/outbound.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type {
  ProductSourceFetch,
  ProductSourceFetcher,
} from '../public.ts';

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_SIZE_CAP_BYTES = 262_144;

export function createHttpProductSourceFetcher(
  http: HttpCallPort,
  clock: Clock,
): ProductSourceFetcher {
  return {
    async fetch(url: string): Promise<ProductSourceFetch> {
      const fetchedAt = clock.nowIso();
      let response: HttpCallResponse;
      try {
        response = await http.request({
          url,
          method: 'GET',
          headers: { accept: 'text/html,application/xhtml+xml,text/plain,application/json,*/*' },
          body: null,
          timeoutMs: FETCH_TIMEOUT_MS,
          sizeCapBytes: FETCH_SIZE_CAP_BYTES,
        });
      } catch {
        // Invalid request envelope (non-https/non-loopback URL, bad caps):
        // an honest per-input failure, never a throw past the port.
        return {
          url,
          ok: false,
          status: 0,
          contentType: null,
          body: null,
          fetchedAt,
        };
      }
      const contentType = response.headers['content-type'] ?? null;
      const ok = !response.transportRefused && !response.timedOut && response.status >= 200 && response.status < 300;
      return {
        url,
        ok,
        status: response.status,
        contentType,
        body: ok ? response.body : null,
        fetchedAt,
      };
    },
  };
}
