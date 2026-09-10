/**
 * /evidence module implementation (MKT-013, EVID-001).
 *
 * Thin composition over the append-only store with the canonical owner
 * chain (the goals pattern): every append resolves the owning Client
 * THROUGH /clients resolveClientOwnership and the optional Workspace scope
 * THROUGH /workspaces resolveWorkspaceOwnership BEFORE any write
 * (implementation-contract §2). Agency/membership authorization stays in
 * /agencies — this module composes ownership with that authority and never
 * invents a second one.
 *
 * EVID-AC-03 (claims are never auto-promoted to authoritative observations)
 * is enforced at THREE layers here:
 *   1. there is NO update path at all — records are immutable (module API
 *      surface + DB triggers), so a stored record can never change class;
 *   2. supersession preserves the authority TIER — a claim-class record
 *      can only be superseded by another claim-class record (module guard
 *      + the evidence_supersession_legal DB trigger);
 *   3. provenance is a server-built argument type — no caller input can
 *      reach the provenance columns, and the caller-declared confidence
 *      score is stored as a separate column that nothing reads back into
 *      provenance, class or tier.
 * No promotion operation exists in this module's surface: an explicit,
 * authorized promotion path would be its own future Work Item with its own
 * audited route (frozen EVID-AC-03 forbids only AUTO-promotion — none
 * exists).
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { EvidenceModuleApi, EvidenceModuleDeps } from '../public.ts';
import { composeEvidenceOwnerContext, evidenceClassTier } from '../public.ts';
import {
  assertValidEvidenceAppend,
  assertValidEvidenceProvenance,
  classifyEvidenceInsertConflict,
  EvidenceStore,
} from './evidence-store.ts';

export function createEvidenceModule(deps: EvidenceModuleDeps): EvidenceModuleApi {
  const store = new EvidenceStore(deps.db, deps.clock, deps.ids);
  const { clients, workspaces } = deps;

  return {
    async appendEvidence(input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidEvidenceProvenance(provenance);
      // The frozen class/quality/content shapes at the authority boundary.
      assertValidEvidenceAppend(input);

      // CANONICAL Client owner resolution from durable state BEFORE any
      // write. Unknown or tombstoned Client → uniform 404; disabled Client
      // blocks new use (409) without rewriting history (goals policy).
      const ownership = await clients.resolveClientOwnership(input.clientId);
      if (ownership === null) {
        throw new NotFoundError('client', input.clientId);
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${input.clientId} is ${ownership.client.status}; evidence cannot be appended`,
        );
      }

      // Optional Workspace scope: resolved canonically THROUGH /workspaces.
      // Unknown, tombstoned, or belonging to a DIFFERENT Client → uniform
      // 404 (a foreign workspace identifier is not a traversal/existence
      // oracle); disabled Workspace blocks new use. The DB scope trigger is
      // the final backstop against races.
      if (input.workspaceId !== null) {
        const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(input.workspaceId);
        if (workspaceOwnership === null || workspaceOwnership.workspace.clientId !== input.clientId) {
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (workspaceOwnership.workspace.status !== 'active') {
          throw new ConflictError(
            `workspace ${input.workspaceId} is ${workspaceOwnership.workspace.status}; evidence cannot be scoped to it`,
          );
        }
      }

      // Explicit supersession invariants, fail closed. The pre-checks give
      // deterministic domain errors; the partial unique fence and the
      // evidence_supersession_legal trigger are the race + backstop.
      if (input.supersedesEvidenceId !== null) {
        const prior = await store.getEvidence(input.supersedesEvidenceId);
        if (prior === null || prior.clientId !== input.clientId) {
          // Uniform 404: a foreign evidence identifier is indistinguishable
          // from an unknown one (no cross-tenant oracle).
          throw new NotFoundError('evidence', input.supersedesEvidenceId);
        }
        if (prior.supersededBy !== null) {
          throw new ConflictError(
            `evidence ${prior.evidenceId} is already superseded by ${prior.supersededBy}; supersession is append-only history`,
          );
        }
        if (evidenceClassTier(input.class) !== evidenceClassTier(prior.class)) {
          if (evidenceClassTier(input.class) === 'authoritative') {
            throw new InvalidRequestError(
              'claims are never auto-promoted to authoritative classes (EVID-AC-03)',
              [
                `class: '${input.class}' (authoritative) cannot supersede '${prior.class}' (claim) — record a NEW authoritative observation instead`,
              ],
            );
          }
          throw new InvalidRequestError('supersession preserves the authority tier', [
            `class: '${input.class}' (claim) cannot supersede '${prior.class}' (authoritative) — an authoritative record can only be corrected by another authoritative record`,
          ]);
        }
      }

      try {
        return await store.insertEvidence(
          {
            clientId: input.clientId,
            workspaceId: input.workspaceId,
            class: input.class,
            sourceSystem: input.source.system,
            sourceRef: input.source.ref,
            observedAt: input.observedAt,
            content: input.content,
            contentRef: input.contentRef,
            quality: input.quality,
            confidence: input.confidence,
            supersedesEvidenceId: input.supersedesEvidenceId,
          },
          provenance,
        );
      } catch (error) {
        // Lost the supersession race: another correction of the same prior
        // record won the DB fence — converge to a deterministic conflict.
        if (classifyEvidenceInsertConflict(error) === 'supersession-fence') {
          throw new ConflictError(
            `evidence ${input.supersedesEvidenceId ?? ''} was superseded concurrently; supersession is single-correction`,
          );
        }
        throw error;
      }
    },

    async getEvidence(evidenceId) {
      return store.getEvidence(evidenceId);
    },

    async resolveEvidenceOwnership(evidenceId) {
      const evidence = await store.getEvidence(evidenceId);
      if (evidence === null) return null;
      // Canonical Client ownership THROUGH /clients — the ONLY Client
      // ownership authority. A deleted (tombstoned) Client never resolves,
      // so evidence owned by a tombstoned Client is indistinguishable from
      // an unknown evidence identifier (uniform 404 upstream).
      const clientOwnership = await clients.resolveClientOwnership(evidence.clientId);
      if (clientOwnership === null) return null;
      // The Workspace row is exposed as-is for workspace-scoped records
      // (tombstones included): deleting an organizational boundary never
      // erases immutable evidence history.
      const workspace =
        evidence.workspaceId === null
          ? null
          : await workspaces.getWorkspace(evidence.workspaceId);
      return composeEvidenceOwnerContext(
        evidence,
        clientOwnership,
        workspace,
        deps.clock.nowIso(),
      );
    },

    async listEvidenceForClient(clientId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listEvidenceForClient(clientId);
    },
  };
}
