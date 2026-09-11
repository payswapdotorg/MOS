/**
 * /policies module implementation (MKT-021, POL-001 + CRED-001 posture).
 *
 * Thin composition over the append-only store with the canonical scope
 * chain: every administration write resolves the owning Agency (platform
 * scope excepted) and the owning Client (client scope) THROUGH the
 * /agencies + /clients public contracts BEFORE any write
 * (implementation-contract §2 — exactly the frozen matrix dependency set
 * /policies ──→ /clients, /agencies). Every evaluation re-validates the
 * scope the same way BEFORE any policy read, then resolves the CRED-001
 * credential REFERENCE (references only — never material) for the secrets
 * dimension, composes the decision through the pure DENY-OVERRIDES core
 * and RECORDS the append-only decision with server-derived provenance.
 *
 * Fail-closed contract (POL-001 acceptance): unknown/missing/erroring
 * policy state denies — never allows by default:
 *   - unknown dimension / malformed action or provenance → InvalidRequest
 *     (fail-closed by rejection, before any policy read);
 *   - ambiguous scope (unresolvable/mismatched/disabled agency or client)
 *     → recorded 'deny' decision, reason 'ambiguous-scope';
 *   - unresolved or tenant-mismatched credential reference → recorded
 *     'deny' decision;
 *   - evaluation error (store failure) → recorded 'deny' decision, reason
 *     'evaluation-error'; if even the decision record cannot be persisted,
 *     BackendUnavailableError — never an allow.
 */

import { BackendUnavailableError, ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  PoliciesModuleApi,
  PoliciesModuleDeps,
  PolicyActionDescriptor,
  PolicyDecisionRecord,
  PolicyDecisionProvenance,
} from '../public.ts';
import { evaluatePolicyMatrix } from '../public.ts';
import {
  assertValidPolicyAction,
  assertValidPolicyDeclarationInput,
  assertValidPolicyDecisionProvenance,
  classifyPolicyWriteConflict,
  composeSecretsEffectiveAttributes,
  PoliciesStore,
} from './store.ts';

export function createPoliciesModule(deps: PoliciesModuleDeps): PoliciesModuleApi {
  const store = new PoliciesStore(deps.db, deps.clock, deps.ids);
  const { agencies, clients, credentialReferences } = deps;

  /**
   * Canonical ADMINISTRATION scope resolution from durable state BEFORE
   * any write: platform scope needs no tenant resolution; agency scope
   * resolves the agency (unknown → uniform 404; disabled → 409 blocks new
   * declarations without rewriting history); client scope resolves the
   * canonical client ownership chain (the hard security boundary —
   * unknown/foreign client → uniform 404; the scope agency MUST match the
   * client's owning agency; disabled client → 409).
   */
  async function resolveDeclarationScope(scope: {
    readonly agencyId: string | null;
    readonly clientId: string | null;
  }): Promise<void> {
    if (scope.agencyId === null && scope.clientId === null) return; // platform scope
    if (scope.agencyId !== null) {
      const agency = await agencies.getAgency(scope.agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', scope.agencyId);
      }
      if (agency.status !== 'active') {
        throw new ConflictError(
          `agency ${scope.agencyId} is ${agency.status}; policy declarations are blocked`,
        );
      }
    }
    if (scope.clientId !== null) {
      const ownership = await clients.resolveClientOwnership(scope.clientId);
      if (ownership === null) {
        throw new NotFoundError('client', scope.clientId);
      }
      if (ownership.client.agencyId !== scope.agencyId) {
        // A client identifier of another agency is not a traversal oracle.
        throw new NotFoundError('client', scope.clientId);
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${scope.clientId} is ${ownership.client.status}; policy declarations are blocked`,
        );
      }
    }
  }

  /**
   * Canonical EVALUATION scope resolution from durable state BEFORE any
   * policy read — ambiguous scope is a fail-closed trigger that produces a
   * RECORDED 'deny' decision (not an exception): the evaluation endpoint
   * answers, and the answer is no.
   */
  async function evaluationScopeIsResolvable(scope: {
    readonly agencyId: string;
    readonly clientId: string | null;
  }): Promise<boolean> {
    const agency = await agencies.getAgency(scope.agencyId);
    if (agency === null || agency.status !== 'active') return false;
    if (scope.clientId !== null) {
      const ownership = await clients.resolveClientOwnership(scope.clientId);
      if (ownership === null) return false;
      if (ownership.client.agencyId !== scope.agencyId) return false;
      if (ownership.client.status !== 'active') return false;
    }
    return true;
  }

  return {
    async declarePolicyVersion(input) {
      // The frozen declaration shapes at the authority boundary (dimension,
      // scope legality, bounded rules, §21 material-key backstop).
      assertValidPolicyDeclarationInput(input);
      // Canonical tenant scope resolution from durable state.
      await resolveDeclarationScope(input.scope);
      try {
        return await store.insertPolicyVersion({
          dimension: input.dimension,
          agencyId: input.scope.agencyId,
          clientId: input.scope.clientId,
          rules: input.rules,
          description: input.description,
          createdBy: input.actorId,
        });
      } catch (error) {
        // Lost the declaration race: the DB fences converged a concurrent
        // duplicate — deterministic 409, never a silent overwrite.
        if (classifyPolicyWriteConflict(error) !== null) {
          throw new ConflictError(
            'concurrent policy declaration for this scope and dimension was applied first',
          );
        }
        throw error;
      }
    },

    async getPolicyVersion(policyId) {
      return store.getPolicyVersion(policyId);
    },

    async listPolicyVersions(input) {
      // Canonical scope validation before dependent traversal (platform
      // scope lists platform versions without tenant resolution).
      await resolveDeclarationScope(input.scope);
      return store.listPolicyVersions({
        agencyId: input.scope.agencyId,
        clientId: input.scope.clientId,
        dimension: input.dimension,
        includeSuperseded: input.includeSuperseded,
      });
    },

    async getActivePolicyVersion(input) {
      return store.getActivePolicyVersion({
        agencyId: input.scope.agencyId,
        clientId: input.scope.clientId,
        dimension: input.dimension,
      });
    },

    async evaluateAction(input, provenance) {
      // Fail-closed by REJECTION: malformed action (unknown dimension
      // included) or incomplete server-derived provenance never reaches
      // the policy state at all.
      assertValidPolicyDecisionProvenance(provenance);
      assertValidPolicyAction(input.action);

      // Whether the evaluation scope chain has been VALIDATED against
      // durable ownership state at the moment of recording: an unvalidated
      // client claim is never persisted on the decision row (the DB
      // cross-tenant fence would reject it — and SHOULD); the fail-closed
      // record attributes to the REQUESTING AGENCY with the client claim
      // dropped (the full proposal stays in the action payload/reasons).
      let scopeValidated = false;

      try {
        const decision = await evaluateAndRecord(
          input.action,
          input.scope,
          provenance,
          () => {
            scopeValidated = true;
          },
        );
        return decision;
      } catch (error) {
        // FAIL-CLOSED: any evaluation error becomes a RECORDED 'deny'
        // decision (reason 'evaluation-error') — the action never proceeds
        // and the audit trail keeps the failure. If even the decision
        // record cannot be persisted, surface unavailability — still never
        // an allow.
        try {
          return await store.insertDecision(
            {
              dimension: input.action.dimension,
              agencyId: input.scope.agencyId,
              clientId: scopeValidated ? input.scope.clientId : null,
              outcome: 'deny',
              reasonCode: 'evaluation-error',
              reasons: [
                `policy evaluation failed closed: ${error instanceof Error ? error.message : String(error)}`,
              ],
              action: input.action,
              matchedPolicyVersions: [],
            },
            provenance,
          );
        } catch {
          throw new BackendUnavailableError(
            'policy evaluation failed closed and the decision record could not be persisted',
          );
        }
      }
    },

    async getPolicyDecision(decisionId) {
      return store.getDecision(decisionId);
    },

    async listPolicyDecisions(input) {
      const agency = await agencies.getAgency(input.agencyId);
      if (agency === null) {
        throw new NotFoundError('agency', input.agencyId);
      }
      if (input.clientId !== null) {
        const ownership = await clients.resolveClientOwnership(input.clientId);
        if (ownership === null || ownership.client.agencyId !== input.agencyId) {
          throw new NotFoundError('client', input.clientId);
        }
      }
      return store.listDecisions(input.agencyId, input.clientId);
    },
  };

  /**
   * The recorded evaluation flow: scope resolution → credential reference
   * resolution (secrets dimension) → pure decision core → append-only
   * decision record. `markScopeValidated` flips once the scope chain has
   * been canonically resolved (see evaluateAction).
   */
  async function evaluateAndRecord(
    action: PolicyActionDescriptor,
    scope: { readonly agencyId: string; readonly clientId: string | null },
    provenance: PolicyDecisionProvenance,
    markScopeValidated: () => void,
  ): Promise<PolicyDecisionRecord> {
    // 1. Canonical scope resolution BEFORE any policy read (ambiguous
    //    scope → fail-closed recorded deny). The decision row attributes
    //    to the REQUESTING AGENCY with the client claim DROPPED — the
    //    unvalidated client never lands on the row (the DB cross-tenant
    //    fence enforces the same posture at the storage layer).
    const scopeResolvable = await evaluationScopeIsResolvable(scope);
    if (!scopeResolvable) {
      return store.insertDecision(
        {
          dimension: action.dimension,
          agencyId: scope.agencyId,
          clientId: null,
          outcome: 'deny',
          reasonCode: 'ambiguous-scope',
          reasons: [
            'the evaluation scope could not be canonically resolved (unknown, foreign or inactive agency/client)',
          ],
          action,
          matchedPolicyVersions: [],
        },
        provenance,
      );
    }
    markScopeValidated();

    // 2. CRED-001 access-proposal resolution for the secrets dimension:
    //    the engine resolves the credential REFERENCE (references only)
    //    and derives the credential-shaped matching attributes
    //    server-side; an unresolved or tenant-mismatched reference is a
    //    fail-closed recorded deny. The engine never sees material.
    let effectiveAttributes: Readonly<Record<string, string>> = action.attributes;
    if (action.dimension === 'secrets') {
      const reference =
        action.resource === null ? null : await credentialReferences.getCredentialReference(action.resource);
      if (reference === null || reference.status !== 'active') {
        return store.insertDecision(
          {
            dimension: action.dimension,
            agencyId: scope.agencyId,
            clientId: scope.clientId,
            outcome: 'deny',
            reasonCode: 'credential-reference-unresolved',
            reasons: [
              'the proposed credential reference is unknown, tombstoned or disabled (CRED-001 fail-closed)',
            ],
            action,
            matchedPolicyVersions: [],
          },
          provenance,
        );
      }
      const referenceScopeMatches =
        reference.agencyId === scope.agencyId &&
        (reference.clientId === null
          ? true
          : reference.clientId === scope.clientId);
      if (!referenceScopeMatches) {
        return store.insertDecision(
          {
            dimension: action.dimension,
            agencyId: scope.agencyId,
            clientId: scope.clientId,
            outcome: 'deny',
            reasonCode: 'credential-scope-mismatch',
            reasons: [
              'the proposed credential reference belongs to another tenant scope (cross-tenant secret access is denied)',
            ],
            action,
            matchedPolicyVersions: [],
          },
          provenance,
        );
      }
      effectiveAttributes = composeSecretsEffectiveAttributes(action.attributes, reference);
    }

    // 3. Load the consulted ACTIVE versions (client > agency > platform)
    //    and compose the decision through the pure DENY-OVERRIDES core.
    const consulted = await store.loadScopeChainVersions(action.dimension, scope);
    const core = evaluatePolicyMatrix(
      {
        dimension: action.dimension,
        operation: action.operation,
        resource: action.resource,
        attributes: effectiveAttributes,
      },
      consulted.map((version) => ({
        policyId: version.policyId,
        scopeKind: version.scopeKind,
        rules: version.rules,
      })),
    );

    // 4. RECORD the decision (append-only, server-derived provenance).
    return store.insertDecision(
      {
        dimension: action.dimension,
        agencyId: scope.agencyId,
        clientId: scope.clientId,
        outcome: core.outcome,
        reasonCode: core.reasonCode,
        reasons: core.reasons,
        action,
        matchedPolicyVersions: core.matchedPolicyVersions,
      },
      provenance,
    );
  }
}
