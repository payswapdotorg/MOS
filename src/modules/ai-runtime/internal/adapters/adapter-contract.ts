/**
 * Provider-neutral adapter contract (MKT-018, AI-002 — the provider
 * independence port, spec/ai-runtime-and-routing.md §6 + §9).
 *
 * The provider adapter PORT is the ONLY sanctioned surface where a
 * provider (OpenRouter, a direct provider, an in-house adapter) is
 * invoked. The routing core depends on the PORT (this file's exports),
 * NOT on any implementation — the composition root wires the
 * implementation (the OpenRouter HTTP adapter), and tests supply fakes.
 *
 * INVARIANTS (frozen architecture — non-negotiable, AI-AC-02 + AI-AC-03):
 *   - NO provider SDK may be imported by this contract or any adapter
 *     implementation. The architecture boundary test asserts ZERO SDK
 *     references anywhere in src/ (the only sanctioned home for SDK
 *     imports, when they arrive, is src/modules/ai-runtime/internal/
 *     adapters/** — and even there, NO SDK is imported; the OpenRouter
 *     adapter uses the platform's HttpCallPort contract for HTTP, never
 *     an SDK package).
 *   - Domain modules NEVER import adapters (the architecture test guards
 *     this — domain code imports only platform ports, the /ai-runtime
 *     public entry, and the frozen-matrix /executions dependency). The
 *     routing core depends on the adapter CONTRACT (the types exported
 *     here), not on any implementation.
 *   - The adapter is WIRED at the composition root (the composition root
 *     imports the OpenRouter adapter and passes it to the /ai-runtime
 *     module). The module's routeTask method takes the adapter as a
 *     parameter — never imports it.
 *   - OpenRouter is NOT the routing authority (AI-AC-03). The routing
 *     authority is the /ai-runtime module itself. OpenRouter is one
 *     adapter implementation behind this contract — pluggable and
 *     replaceable without changing domain semantics (§9).
 *
 * This file is intentionally minimal: it re-exports the adapter types
 * from the public entry (so the adapter implementation file can import
 * them from here rather than from the public entry — keeping the import
 * graph clean). The actual contract types live in public.ts so they are
 * part of the module's public surface.
 */

export type {
  AdapterRequest,
  AdapterResponse,
  ProviderAdapter,
} from '../../public.ts';
