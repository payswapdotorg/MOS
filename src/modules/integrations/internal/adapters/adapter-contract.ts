/**
 * Provider-neutral integration adapter contract (MKT-023, INT-001 —
 * implementation-contract §20: "An integration adapter owns
 * provider-specific API/SDK details. Core domains exchange normalized
 * contracts only").
 *
 * The generic integration PORT is the ONLY sanctioned surface where a
 * marketing data provider (Meta, Google, an analytics platform, a CRM, a
 * commerce/CMS system) is contacted. The integration core depends on the
 * PORT (this file's exports), NOT on any implementation — adapter
 * instances arrive as DATA through the module dependencies
 * (`adapters: readonly IntegrationAdapter[]`) and are validated into a
 * registry keyed by adapterKey at construction (never a hardcoded
 * provider branch); the composition root wires future first-party
 * adapters (MKT-024), and tests supply stubs implementing this port.
 *
 * INVARIANTS (frozen architecture — non-negotiable, INT-001 +
 * implementation-contract §20/§21):
 *   - NO provider SDK may be imported by this contract or any adapter
 *     implementation. The architecture boundary test asserts ZERO SDK
 *     references anywhere in src/ (tools/arch-check
 *     EXTERNAL_PACKAGE_IN_SRC: the only permitted infrastructure client
 *     is 'pg' inside platform adapters). First-party adapters use the
 *     platform HttpCallPort contract for HTTP egress, never an SDK
 *     package — the /ai-runtime MKT-018 OpenRouter precedent.
 *   - Domain modules NEVER import adapters (CONCRETE_ADAPTER_ACCESS:
 *     adapter files under an 'adapters' path segment may only be imported
 *     by the composition root or inspected by tests — and in this Work
 *     Item nothing imports them at all). Core domains exchange ONLY the
 *     normalized contracts exported from the module public entry.
 *   - An adapter owns ALL provider-specific details — endpoints, request
 *     translation, error mapping, authenticity verification, rate-limit
 *     observation — and returns invocation failures as DATA (ok=false +
 *     error), never thrown exceptions, so the module records the
 *     health/rate-limit state and the caller decides.
 *   - The adapter receives credential MATERIAL only in-process inside
 *     IntegrationAdapterCallContext, resolved by the module AFTER a
 *     fail-closed /policies allow through the /credentials
 *     authorized-execution path — never persisted, logged, audited or
 *     queued (§21).
 *
 * This file is intentionally minimal: it re-exports the adapter port
 * types from the public entry (so the MKT-024 first-party adapter
 * implementations can import them from here rather than from the public
 * entry — keeping the import graph clean; the /ai-runtime
 * internal/adapters/adapter-contract.ts precedent). The actual contract
 * types live in public.ts so they are part of the module's public
 * surface. There are NO first-party connectors in MKT-023 — the
 * internal/adapters/ home is declared, guarded and documented here, and
 * MKT-024 lands the first implementations.
 */

export type {
  AdapterProbeResult,
  IntegrationAdapter,
  IntegrationAdapterCallContext,
  IntegrationAdapterDescriptor,
  IntegrationCapability,
  IntegrationCapabilityKind,
  NormalizedMutationRequest,
  NormalizedMutationResult,
  NormalizedProviderRecord,
  NormalizedRateLimit,
  NormalizedReadRequest,
  NormalizedReadResult,
  WebhookDeliveryInput,
  WebhookVerificationResult,
} from '../../public.ts';
