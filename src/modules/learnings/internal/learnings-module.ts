/**
 * /learnings module implementation (MKT-016, LEARN-001).
 *
 * Thin composition over the append-only store with the canonical owner
 * chain (the goals/evidence/experiments pattern): every write resolves
 * the owning Client THROUGH the /clients canonical owner resolution and
 * the optional Workspace scope THROUGH the /workspaces canonical owner
 * resolution BEFORE any mutation (implementation-contract §2). Because
 * the frozen dependency matrix allows /learnings ──→ /evidence,
 * /experiments, /goals only, those two resolutions arrive through the
 * STRUCTURAL PORTS declared in the module's public contract — the
 * concrete /clients and /workspaces public-contract instances are wired
 * at the composition root (identical posture to /experiments and
 * /metrics). Agency/membership authorization stays in /agencies — this
 * module composes ownership with that authority and never invents a
 * second one.
 *
 * The module is the LEARNING authority only: it appends immutable
 * Learning records (statement + applicability + supporting references +
 * descriptive confidence), appends contradiction/supersession/retirement
 * relationship rows (LEARN-AC-02 — NEW rows, never mutations) and derives
 * the Learning state from that history at read time. It never normalizes
 * metrics, never runs experiment machinery, never classes evidence and
 * never touches workflow/execution state. Supporting references are
 * validated THROUGH the /evidence and /experiments public contracts
 * (same-Client, uniform 404; experiment references must have CONCLUDED —
 * an outcome reference requires a declared outcome).
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { LearningOwnerContext, LearningsModuleApi, LearningsModuleDeps } from '../public.ts';
import { composeLearningOwnerContext, isTerminalLearningStatus } from '../public.ts';
import {
  assertValidLearningCreate,
  assertValidLearningProvenance,
  assertValidLearningRelationshipInput,
  classifyLearningWriteConflict,
  LearningStore,
} from './learnings-store.ts';

export function createLearningModule(deps: LearningsModuleDeps): LearningsModuleApi {
  const store = new LearningStore(deps.db, deps.clock, deps.ids);
  const { clients, workspaces, evidence, experiments } = deps;

  return {
    async createLearning(input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidLearningProvenance(provenance);
      // The frozen Learning-contract shapes at the authority boundary.
      assertValidLearningCreate(input);

      // CANONICAL Client owner resolution from durable state BEFORE any
      // write (THROUGH the /clients public-contract instance). Unknown or
      // tombstoned Client → uniform 404; disabled Client blocks new use
      // (409) without rewriting history (the goals/evidence/experiments
      // policy).
      const ownership = await clients.resolveClientOwnership(input.clientId);
      if (ownership === null) {
        throw new NotFoundError('client', input.clientId);
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${input.clientId} is ${ownership.client.status}; learnings cannot be appended`,
        );
      }

      // Optional Workspace scope: resolved canonically THROUGH the
      // /workspaces public-contract instance. Unknown, tombstoned, or
      // belonging to a DIFFERENT Client → uniform 404 (a foreign workspace
      // identifier is not a traversal/existence oracle); disabled
      // Workspace blocks new use. The DB scope trigger is the final
      // backstop.
      if (input.workspaceId !== null) {
        const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(input.workspaceId);
        if (workspaceOwnership === null || workspaceOwnership.workspace.clientId !== input.clientId) {
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (workspaceOwnership.workspace.status !== 'active') {
          throw new ConflictError(
            `workspace ${input.workspaceId} is ${workspaceOwnership.workspace.status}; learnings cannot be scoped to it`,
          );
        }
      }

      // Supporting EVIDENCE references (fail closed, LEARN-AC-01): every
      // cited record must resolve to an /evidence record of the SAME
      // Client — a foreign evidence identifier is indistinguishable from
      // an unknown one (uniform 404, no cross-tenant oracle). The DB
      // trigger is the race backstop.
      for (const evidenceRef of input.evidenceRefs) {
        const linked = await evidence.getEvidence(evidenceRef);
        if (linked === null || linked.clientId !== input.clientId) {
          throw new NotFoundError('evidence', evidenceRef);
        }
      }

      // Supporting EXPERIMENT OUTCOME references (fail closed,
      // LEARN-AC-01): every cited experiment must resolve to an
      // /experiments record of the SAME Client (uniform 404 — no
      // cross-tenant oracle) AND must have CONCLUDED: an outcome
      // reference requires a declared outcome (result state + decision).
      // Validated THROUGH the /experiments public contract only.
      for (const experimentRef of input.experimentRefs) {
        const linked = await experiments.getExperiment(experimentRef);
        if (linked === null || linked.clientId !== input.clientId) {
          throw new NotFoundError('experiment', experimentRef);
        }
        if (linked.status !== 'concluded') {
          throw new InvalidRequestError(
            `learning cites experiment ${experimentRef} which is ${linked.status}; learnings reference CONCLUDED experiment outcomes`,
          );
        }
      }

      try {
        return await store.insertLearning(
          {
            clientId: input.clientId,
            workspaceId: input.workspaceId,
            statement: input.statement,
            applicability: input.applicability,
            evidenceRefs: input.evidenceRefs,
            experimentRefs: input.experimentRefs,
            confidence: input.confidence,
          },
          provenance,
        );
      } catch (error) {
        // Lost the reference/scope race: the DB tenant fences rejected a
        // concurrently-changed ownership — converge to the uniform domain
        // 404/409.
        const conflict = classifyLearningWriteConflict(error);
        if (conflict === 'refs-cross-tenant') {
          throw new NotFoundError('evidence', 'cited-by-learning');
        }
        if (conflict === 'workspace-scope') {
          throw new NotFoundError('workspace', input.workspaceId ?? '');
        }
        throw error;
      }
    },

    async getLearning(learningId) {
      return store.getLearning(learningId);
    },

    async resolveLearningOwnership(learningId) {
      const learning = await store.getLearning(learningId);
      if (learning === null) return null;
      // Canonical Client ownership THROUGH the /clients public-contract
      // instance — the ONLY Client ownership authority. A deleted
      // (tombstoned) Client never resolves, so a learning owned by a
      // tombstoned Client is indistinguishable from an unknown learning
      // identifier (uniform 404 upstream).
      const clientOwnership = await clients.resolveClientOwnership(learning.clientId);
      if (clientOwnership === null) return null;
      const workspace =
        learning.workspaceId === null
          ? null
          : await workspaces.resolveWorkspaceOwnership(learning.workspaceId);
      return composeLearningOwnerContext(
        learning,
        clientOwnership,
        workspace,
        deps.clock.nowIso(),
      );
    },

    async listLearningsForClient(clientId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listLearningsForClient(clientId);
    },

    async recordLearningRelationship(fromLearningId, input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidLearningProvenance(provenance);
      // The closed kind taxonomy + the to-learning presence rules.
      assertValidLearningRelationshipInput(fromLearningId, input);

      // Canonical owner resolution BEFORE any dependent traversal: a
      // foreign target learning identifier is indistinguishable from an
      // unknown one (uniform 404 — no cross-tenant oracle).
      const target = await store.getLearning(fromLearningId);
      if (target === null) {
        throw new NotFoundError('learning', fromLearningId);
      }
      const targetOwnership = await clients.resolveClientOwnership(target.clientId);
      if (targetOwnership === null) {
        throw new NotFoundError('learning', fromLearningId);
      }

      // The LATER learning must exist and belong to the SAME Client — a
      // foreign later-learning identifier is indistinguishable from an
      // unknown one (uniform 404). The DB cross-tenant trigger is the
      // race backstop.
      if (input.toLearningId !== null) {
        const later = await store.getLearning(input.toLearningId);
        if (later === null || later.clientId !== target.clientId) {
          throw new NotFoundError('learning', input.toLearningId);
        }
      }

      // Terminal-target pre-check (the DB trigger is the race backstop):
      // an already-superseded or already-retired learning accepts no
      // further relationships. A CONTRADICTED target stays legal — later
      // evidence may keep arriving.
      if (isTerminalLearningStatus(target.status)) {
        throw new ConflictError(
          `learning ${fromLearningId} is ${target.status}; its history is terminal and accepts no further relationships`,
        );
      }

      try {
        return await store.insertRelationship(
          fromLearningId,
          input.kind,
          input.toLearningId,
          provenance,
        );
      } catch (error) {
        // Lost the fence race (a concurrent supersession/retirement won)
        // or the terminal-target backstop fired — converge to the uniform
        // domain 409/404.
        const conflict = classifyLearningWriteConflict(error);
        if (conflict === 'supersession-fence' || conflict === 'retirement-fence') {
          throw new ConflictError(
            `learning ${fromLearningId} was already ${input.kind === 'retires' ? 'retired' : 'superseded'} concurrently; ${input.kind} is single-successor`,
          );
        }
        if (conflict === 'relationship-terminal') {
          throw new ConflictError(
            `learning ${fromLearningId} no longer accepts relationship '${input.kind}'`,
          );
        }
        if (conflict === 'relationship-cross-tenant') {
          throw new NotFoundError('learning', input.toLearningId ?? fromLearningId);
        }
        throw error;
      }
    },

    async listLearningRelationships(learningId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership: LearningOwnerContext | null =
        await this.resolveLearningOwnership(learningId);
      if (ownership === null) {
        throw new NotFoundError('learning', learningId);
      }
      return store.listRelationshipsForLearning(learningId);
    },
  };
}
