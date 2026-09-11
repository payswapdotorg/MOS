/**
 * /experiments module implementation (MKT-015, EXP-001).
 *
 * Thin composition over the design/transition store with the canonical
 * owner chain (the goals/evidence/metrics pattern): every write resolves
 * the owning Client THROUGH the /clients canonical owner resolution and the
 * optional Workspace scope THROUGH the /workspaces canonical owner
 * resolution BEFORE any mutation (implementation-contract §2). Because the
 * frozen dependency matrix allows /experiments ──→ /evidence, /metrics,
 * /goals only, those two resolutions arrive through the STRUCTURAL PORTS
 * declared in the module's public contract — the concrete /clients and
 * /workspaces public-contract instances are wired at the composition root
 * (identical posture to /metrics). Agency/membership authorization stays
 * in /agencies — this module composes ownership with that authority and
 * never invents a second one.
 *
 * The module is the EXPERIMENT DESIGN authority only: it records the
 * declared design, applies the frozen lifecycle transitions and retains
 * the declared conclusions with their uncertainty and analysis metadata.
 * It never computes outcomes, never executes assignment, never creates
 * Learnings and never touches workflow/execution state.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  ExperimentsModuleApi,
  ExperimentsModuleDeps,
  ExperimentOwnerContext,
} from '../public.ts';
import { composeExperimentOwnerContext, EXPERIMENT_TRANSITION_TABLE } from '../public.ts';
import {
  assertValidExperimentCreate,
  assertValidExperimentConclusion,
  assertValidExperimentProvenance,
  assertValidExperimentTransitionInput,
  classifyExperimentWriteConflict,
  ExperimentStore,
} from './experiments-store.ts';

export function createExperimentsModule(deps: ExperimentsModuleDeps): ExperimentsModuleApi {
  const store = new ExperimentStore(deps.db, deps.clock, deps.ids);
  const { clients, workspaces, evidence } = deps;

  return {
    async createExperiment(input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidExperimentProvenance(provenance);
      // The frozen Experiment-contract shapes at the authority boundary.
      assertValidExperimentCreate(input);

      // CANONICAL Client owner resolution from durable state BEFORE any
      // write (THROUGH the /clients public-contract instance). Unknown or
      // tombstoned Client → uniform 404; disabled Client blocks new use
      // (409) without rewriting history (the goals/evidence/metrics
      // policy).
      const ownership = await clients.resolveClientOwnership(input.clientId);
      if (ownership === null) {
        throw new NotFoundError('client', input.clientId);
      }
      if (ownership.client.status !== 'active') {
        throw new ConflictError(
          `client ${input.clientId} is ${ownership.client.status}; experiments cannot be declared`,
        );
      }

      // Optional Workspace scope: resolved canonically THROUGH the
      // /workspaces public-contract instance. Unknown, tombstoned, or
      // belonging to a DIFFERENT Client → uniform 404 (a foreign workspace
      // identifier is not a traversal/existence oracle); disabled Workspace
      // blocks new use. The DB scope trigger is the final backstop.
      if (input.workspaceId !== null) {
        const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(input.workspaceId);
        if (workspaceOwnership === null || workspaceOwnership.workspace.clientId !== input.clientId) {
          throw new NotFoundError('workspace', input.workspaceId);
        }
        if (workspaceOwnership.workspace.status !== 'active') {
          throw new ConflictError(
            `workspace ${input.workspaceId} is ${workspaceOwnership.workspace.status}; experiments cannot be scoped to it`,
          );
        }
      }

      return store.insertExperiment(
        {
          clientId: input.clientId,
          workspaceId: input.workspaceId,
          hypothesis: input.hypothesis,
          decisionTarget: input.decisionTarget,
          populationUnit: input.populationUnit,
          treatment: input.treatment,
          comparison: input.comparison,
          assignmentMethod: input.assignmentMethod,
          designType: input.designType,
          primaryMetric: input.primaryMetric,
          guardrails: input.guardrails,
          analysisMethod: input.analysisMethod,
          analysisMethodVersion: input.analysisMethodVersion,
          expectedDirection: input.expectedDirection,
          startCriteria: input.startCriteria,
          stopCriteria: input.stopCriteria,
          minimumEvidenceRequirement: input.minimumEvidenceRequirement,
          uncertaintyRepresentation: input.uncertaintyRepresentation,
        },
        provenance,
      );
    },

    async getExperiment(experimentId) {
      return store.getExperiment(experimentId);
    },

    async resolveExperimentOwnership(experimentId) {
      const experiment = await store.getExperiment(experimentId);
      if (experiment === null) return null;
      // Canonical Client ownership THROUGH the /clients public-contract
      // instance — the ONLY Client ownership authority. A deleted
      // (tombstoned) Client never resolves, so an experiment owned by a
      // tombstoned Client is indistinguishable from an unknown experiment
      // identifier (uniform 404 upstream).
      const clientOwnership = await clients.resolveClientOwnership(experiment.clientId);
      if (clientOwnership === null) return null;
      const workspace =
        experiment.workspaceId === null
          ? null
          : await workspaces.resolveWorkspaceOwnership(experiment.workspaceId);
      return composeExperimentOwnerContext(
        experiment,
        clientOwnership,
        workspace,
        deps.clock.nowIso(),
      );
    },

    async listExperimentsForClient(clientId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership = await clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      return store.listExperimentsForClient(clientId);
    },

    async applyExperimentTransition(experimentId, input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidExperimentProvenance(provenance);
      // Known transition + conclusion present exactly when concluding.
      assertValidExperimentTransitionInput(input);

      // Canonical owner resolution BEFORE any dependent traversal: a
      // foreign experiment identifier is indistinguishable from an unknown
      // one (uniform 404 — no cross-tenant oracle).
      const experiment = await store.getExperiment(experimentId);
      if (experiment === null) {
        throw new NotFoundError('experiment', experimentId);
      }
      const clientOwnership = await clients.resolveClientOwnership(experiment.clientId);
      if (clientOwnership === null) {
        throw new NotFoundError('experiment', experimentId);
      }

      // The frozen state machine: the transition must be legal for the
      // CURRENT status (409 otherwise). The DB legal-successor trigger is
      // the race backstop.
      const edge = EXPERIMENT_TRANSITION_TABLE[input.transition];
      if (experiment.status !== edge.from) {
        throw new ConflictError(
          `experiment ${experimentId} is ${experiment.status}; transition '${input.transition}' requires ${edge.from}`,
        );
      }

      // The conclusion guard (pure over the experiment's IMMUTABLE declared
      // design + representation + the conclusion payload): the closed
      // result-state taxonomy, the CAUSAL EVIDENCE STANDARD gate
      // (EXP-AC-02), uncertainty-representation matching and analysis-
      // metadata shapes (EXP-AC-03).
      if (input.transition === 'conclude') {
        assertValidExperimentConclusion(
          experiment.designType,
          experiment.uncertaintyRepresentation,
          input.conclusion,
        );

        // Evidence citations (fail closed): every cited evidenceRef must
        // resolve to an /evidence record of the SAME Client — a foreign
        // evidence identifier is indistinguishable from an unknown one
        // (uniform 404, no cross-tenant oracle). The DB trigger is the
        // race backstop.
        if (input.conclusion !== null) {
          for (const evidenceRef of input.conclusion.evidenceRefs) {
            const linked = await evidence.getEvidence(evidenceRef);
            if (linked === null || linked.clientId !== experiment.clientId) {
              throw new NotFoundError('evidence', evidenceRef);
            }
          }
        }
      }

      try {
        return await store.applyTransition(
          experimentId,
          input.transition,
          input.transition === 'conclude' ? input.conclusion : null,
          provenance,
        );
      } catch (error) {
        const conflict = classifyExperimentWriteConflict(error);
        if (conflict === 'status-transition') {
          // Lost the lifecycle race (a concurrent transition won) —
          // converge to the uniform domain 409.
          throw new ConflictError(
            `experiment ${experimentId} no longer accepts transition '${input.transition}'`,
          );
        }
        if (conflict === 'evidence-refs-client') {
          // Lost the linkage race: the DB cross-tenant trigger rejected a
          // concurrently-changed evidence ownership — converge to the
          // uniform domain 404.
          throw new NotFoundError('evidence', 'cited-by-conclusion');
        }
        if (conflict === 'design-immutable') {
          // Belt-and-suspenders: the store never rewrites design columns;
          // a concurrent trigger rejection still surfaces as a conflict.
          throw new ConflictError(
            `experiment ${experimentId} declared design is immutable`,
          );
        }
        throw error;
      }
    },

    async listExperimentTransitions(experimentId) {
      // Canonical owner resolution before dependent traversal (§2).
      const ownership: ExperimentOwnerContext | null =
        await this.resolveExperimentOwnership(experimentId);
      if (ownership === null) {
        throw new NotFoundError('experiment', experimentId);
      }
      return store.listTransitionsForExperiment(experimentId);
    },
  };
}
