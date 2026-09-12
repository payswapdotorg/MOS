/**
 * /integrations policy gate — the fail-closed enforcement helpers shared
 * by the module core (MKT-023, INT-001).
 *
 * Two pure responsibilities, both consumed by internal/module.ts:
 *
 *   - CANONICAL OWNER-CONTEXT COMPOSITION: the pure composition of the
 *     canonical connection owner context from an ALREADY-RESOLVED /clients
 *     ownership snapshot and the connection record (implementation-contract
 *     §2). The connection scope {kind: 'integration', agencyId, clientId,
 *     connectionId} is derived from the CLIENT chain, never from a caller
 *     value. Re-exported through public.ts for unit purity tests.
 *   - THE FAIL-CLOSED ENFORCEMENT OUTCOME: a thin delegation to the
 *     /policies public contract's `enforcementOutcome` (the frozen matrix
 *     dependency /integrations ──→ /policies, imported as a VALUE from the
 *     policies PUBLIC entry — the metrics-store/containsMaterialKey
 *     precedent for internal cross-module public imports). ONLY an
 *     explicit 'allow' permits; 'deny' AND 'unknown' both deny (POL-001
 *     fail-closed). This stays a separate function so the integrations
 *     core never depends on the policies decision shape directly.
 */

import { enforcementOutcome } from '../../policies/public.ts';
import type { PolicyDecisionRecord } from '../../policies/public.ts';
import type {
  IntegrationConnectionRecord,
  IntegrationsClientOwnershipSnapshot,
  IntegrationsConnectionOwnerContext,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Canonical owner-context composition (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * Pure composition of the canonical connection owner context from an
 * ALREADY-RESOLVED /clients canonical owner context and the connection
 * record. Purity is asserted by unit tests — the same inputs always
 * compose the same context. The scope derives entirely from the CLIENT
 * chain (the hard security boundary); no caller-supplied value can reach
 * it.
 */
export function composeIntegrationConnectionOwnerContext(
  connection: IntegrationConnectionRecord,
  clientOwnership: IntegrationsClientOwnershipSnapshot,
  resolvedAt: string,
): IntegrationsConnectionOwnerContext {
  return {
    scope: {
      kind: 'integration',
      agencyId: clientOwnership.scope.agencyId,
      clientId: connection.clientId,
      connectionId: connection.connectionId,
    },
    connection,
    clientOwnership,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// The fail-closed enforcement outcome (POL-001)
// ---------------------------------------------------------------------------

/**
 * The enforcement answer of an evaluated action: ONLY an explicit 'allow'
 * permits — 'deny' AND 'unknown' both deny (the POL-001 fail-closed
 * contract, delegated to the /policies public contract's pure function).
 * The integrations core consumes this and throws PolicyDeniedError on
 * anything that is not an allow: the action never happens.
 */
export function enforcementOutcomePolicy(
  decision: Pick<PolicyDecisionRecord, 'outcome'>,
): 'allow' | 'deny' {
  return enforcementOutcome(decision);
}
