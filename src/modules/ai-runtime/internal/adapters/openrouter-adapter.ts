/**
 * OpenRouter adapter — an HTTP-based provider adapter implementation
 * (MKT-018, AI-002 — spec/ai-runtime-and-routing.md §6).
 *
 * OpenRouter is permitted as an ADAPTER/Gateway in the AI Runtime. It is
 * NOT the MarketingOS routing authority (AI-AC-03 — the routing authority
 * is the /ai-runtime module itself; OpenRouter is pluggable and
 * replaceable). Domain modules never depend on it.
 *
 * This adapter uses the platform's HttpCallPort contract (fetch-based —
 * NO provider SDK is imported anywhere; the architecture boundary test
 * asserts ZERO SDK references in src/, including this file). The adapter
 * translates the provider-neutral AdapterRequest into an OpenRouter HTTP
 * API call and returns the provider-neutral AdapterResponse.
 *
 * INVARIANTS:
 *   - The adapter NEVER throws for invocation-level outcomes. Transport
 *     failures, provider errors and timeouts are RETURNED as data
 *     (ok=false with an error string), so the cascade can decide whether
 *     to escalate.
 *   - The adapter uses the platform's HttpCallPort (the composition root
 *     wires the FetchHttpCall implementation). Tests do NOT use this
 *     adapter directly — they supply fakes implementing the
 *     ProviderAdapter contract.
 *   - The adapter records the observed cost/latency telemetry in the
 *     AdapterResponse (the caller records this in the selection decision
 *     and cascade step rows for AI-AC-06).
 *   - The adapter does NOT pass through credential material from the
 *     AdapterRequest (the AdapterRequest carries no credentials —
 *     credentials are resolved at the composition root from the
 *     /credentials module and injected as the Authorization header here,
 *     never logged, never returned in the response).
 */

import type {
  AdapterRequest,
  AdapterResponse,
  ProviderAdapter,
} from '../../public.ts';
import type { HttpCallPort } from '../../../../platform/http/outbound.ts';

/**
 * The OpenRouter adapter configuration. The API key is resolved at the
 * composition root from the /credentials module (never carried in the
 * TaskProfile or the AdapterRequest). The endpoint URL is the OpenRouter
 * chat completions API.
 */
export interface OpenRouterAdapterConfig {
  /** The platform HttpCallPort (fetch-based — no SDK). */
  readonly http: HttpCallPort;
  /** The OpenRouter API endpoint (default: https://openrouter.ai/api/v1). */
  readonly endpoint: string;
  /** The API key (resolved from /credentials at the composition root). */
  readonly apiKey: string;
  /** The request timeout in milliseconds (default: 30000). */
  readonly timeoutMs?: number;
}

/**
 * The OpenRouter adapter. Implements the ProviderAdapter contract — the
 * routing core depends on the CONTRACT, not on this class. The
 * composition root wires this class and passes it to the /ai-runtime
 * module's routeTask method.
 */
export class OpenRouterAdapter implements ProviderAdapter {
  readonly providerLabel = 'openrouter';
  private readonly http: HttpCallPort;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: OpenRouterAdapterConfig) {
    this.http = config.http;
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async invoke(request: AdapterRequest): Promise<AdapterResponse> {
    const startedAt = Date.now();
    const body = JSON.stringify({
      model: request.modelKey,
      messages: [
        {
          role: 'system',
          content: `Task class: ${request.taskProfile.taskClass}. Quality target: ${request.taskProfile.qualityTarget}.`,
        },
        { role: 'user', content: JSON.stringify(request.input) },
      ],
      max_tokens: 1024,
    });

    try {
      const response = await this.http.request({
        url: `${this.endpoint}/chat/completions`,
        method: 'POST',
        headers: {
          'authorization': `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body,
        timeoutMs: this.timeoutMs,
        sizeCapBytes: 1_048_576,
      });
      const latencyMs = Date.now() - startedAt;

      // Transport refusal: the request never reached the server.
      if (response.transportRefused) {
        return {
          ok: false,
          output: null,
          error: `transport refused: ${response.body.slice(0, 200)}`,
          latencyMs,
          costAmount: 0,
          tokensIn: null,
          tokensOut: null,
        };
      }

      // Timeout: the outcome is ambiguous (the server may have processed
      // the request). Record as `unknown` (timeout in the error string so
      // the cascade records `unknown`, not `failed`).
      if (response.timedOut) {
        return {
          ok: false,
          output: null,
          error: 'timeout: request timed out before a response was received',
          latencyMs,
          costAmount: 0,
          tokensIn: null,
          tokensOut: null,
        };
      }

      // Non-2xx: provider error. Record as `failed` (the server processed
      // the request and returned an error).
      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          output: null,
          error: `provider error: ${response.status} ${response.body.slice(0, 200)}`,
          latencyMs,
          costAmount: 0,
          tokensIn: null,
          tokensOut: null,
        };
      }

      // Parse the OpenRouter response.
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(response.body) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          output: null,
          error: `provider returned non-JSON response: ${response.body.slice(0, 200)}`,
          latencyMs,
          costAmount: 0,
          tokensIn: null,
          tokensOut: null,
        };
      }

      const choices = parsed['choices'];
      if (!Array.isArray(choices) || choices.length === 0) {
        return {
          ok: false,
          output: null,
          error: 'provider returned no choices',
          latencyMs,
          costAmount: 0,
          tokensIn: null,
          tokensOut: null,
        };
      }
      const firstChoice = choices[0] as Record<string, unknown>;
      const message = firstChoice['message'] as Record<string, unknown> | undefined;
      const content = message === undefined ? null : message['content'];
      let output: Record<string, unknown>;
      if (typeof content === 'string' && content.length > 0) {
        try {
          output = JSON.parse(content) as Record<string, unknown>;
        } catch {
          // The content is not JSON — wrap it in a generic output object.
          output = { content };
        }
      } else if (typeof content === 'object' && content !== null) {
        output = content as Record<string, unknown>;
      } else {
        return {
          ok: false,
          output: null,
          error: 'provider returned no content',
          latencyMs,
          costAmount: 0,
          tokensIn: null,
          tokensOut: null,
        };
      }

      // Extract usage telemetry (tokens) when present.
      const usage = parsed['usage'] as Record<string, unknown> | undefined;
      const tokensIn = usage === undefined ? null : typeof usage['prompt_tokens'] === 'number' ? (usage['prompt_tokens'] as number) : null;
      const tokensOut = usage === undefined ? null : typeof usage['completion_tokens'] === 'number' ? (usage['completion_tokens'] as number) : null;

      // Cost estimate: the AdapterRequest carries no per-token cost (the
      // registry's declared signals are the cost source); the adapter
      // records 0 (the cascade step records the observed cost from the
      // registry's declared signals, not from the adapter response — the
      // adapter's cost estimate is provider-specific and not authoritative
      // for MarketingOS accounting).
      const costAmount = 0;

      return {
        ok: true,
        output,
        error: null,
        latencyMs,
        costAmount,
        tokensIn,
        tokensOut,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        output: null,
        error: `adapter exception: ${reason.slice(0, 400)}`,
        latencyMs,
        costAmount: 0,
        tokensIn: null,
        tokensOut: null,
      };
    }
  }
}
