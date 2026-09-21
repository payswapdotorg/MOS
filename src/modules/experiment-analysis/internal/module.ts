/**
 * /experiment-analysis module implementation (MKT-067).
 *
 * Thin composition over the append-only store with the canonical owner
 * chain (the metrics/experiments pattern): every append resolves the
 * owning Client THROUGH the /clients canonical owner resolution, the
 * optional Workspace scope THROUGH the /workspaces canonical owner
 * resolution, and the anchored Experiment THROUGH the /experiments
 * public contract BEFORE any write (implementation-contract §2). Because
 * the frozen dependency matrix allows /experiment-analysis ──→
 * /experiments, /metrics, /evidence, /learnings only, the Client and
 * Workspace resolutions arrive through the STRUCTURAL PORTS declared in
 * the module's public contract — the concrete /clients and /workspaces
 * public-contract instances are wired at the composition root and
 * satisfy the ports structurally, so the resolution still executes
 * server-side, inside this module, through the exact public-contract
 * methods while the import matrix stays intact.
 *
 * THE MODULE NEVER MUTATES THE CONSUMED AUTHORITIES: /experiments is
 * read-only here (resolveExperimentOwnership only), /metrics and
 * /learnings are read-only lists, /evidence is read-only resolution.
 * Allocation results are recorded as DATA — there is no method that
 * writes experiment exposure, platform state or workflow inputs.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import {
  EXPERIMENT_ANALYSIS_DEFAULT_EXPLORATION_FLOOR,
  EXPERIMENT_ANALYSIS_DEFAULT_MIN_OBSERVATIONS_PER_ARM,
  EXPERIMENT_ANALYSIS_METHOD,
  EXPERIMENT_ANALYSIS_METHOD_VERSION,
  EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
  composeAllocationRecommendationOwnerContext,
  composeExperimentAnalysisOwnerContext,
  type ExperimentAnalysisInputSnapshot,
  type ExperimentAnalysisModuleApi,
  type ExperimentAnalysisModuleDeps,
  type ExperimentAnalysisUncertaintyLevel,
  type ExperimentAllocationInputSnapshot,
} from '../public.ts';
import {
  ALLOCATOR_STRATEGY_VERSION,
  computeAdaptiveAllocation,
  renderAllocationRationale,
} from './allocator.ts';
import { computeAllocationSnapshotDigest, computeExperimentAnalysisSnapshotDigest } from './digest.ts';
import { selectObservationsForAnalysis, splitByArm } from './selection.ts';
import {
  classifyAnalysisOutcome,
  computeSequentialState,
  computeTwoArmEffect,
  mergeConfounders,
  mergeLimitations,
  recommendedAllocationForOutcome,
} from './statistics.ts';
import { ExperimentAnalysisStore } from './store.ts';
import {
  assertValidAllocationRecommendationCreate,
  assertValidExperimentAnalysisCreate,
  assertValidExperimentAnalysisProvenance,
} from './validation.ts';

/** The bounded /metrics client-ledger read (the house store bound — the read-truncation caveat input). */
const METRICS_READ_BOUND = 500;

/** The fixed scoring level of the allocator's conservative signal. */
const ALLOCATION_SCORING_LEVEL: ExperimentAnalysisUncertaintyLevel = 0.95;

export function createExperimentAnalysisModule(
  deps: ExperimentAnalysisModuleDeps,
): ExperimentAnalysisModuleApi {
  const store = new ExperimentAnalysisStore(deps.db, deps.clock, deps.ids);
  const { clients, workspaces, experiments, metrics, evidence, learnings } = deps;

  /**
   * CANONICAL Client owner resolution from durable state BEFORE any
   * write (THROUGH the /clients public-contract instance). Unknown or
   * tombstoned Client → uniform 404; disabled Client blocks new use
   * (409) without rewriting history (the goals/evidence policy).
   */
  async function requireActiveClientOwnership(clientId: string) {
    const ownership = await clients.resolveClientOwnership(clientId);
    if (ownership === null) {
      throw new NotFoundError('client', clientId);
    }
    if (ownership.client.status !== 'active') {
      throw new ConflictError(
        `client ${clientId} is ${ownership.client.status}; experiment analyses cannot be recorded`,
      );
    }
    return ownership;
  }

  /**
   * Optional Workspace scope: resolved canonically THROUGH the
   * /workspaces public-contract instance. Unknown, tombstoned, or
   * belonging to a DIFFERENT Client → uniform 404 (a foreign workspace
   * identifier is not a traversal/existence oracle); disabled Workspace
   * blocks new use. The DB scope trigger is the final backstop against
   * races.
   */
  async function requireWorkspaceInClient(workspaceId: string, clientId: string): Promise<void> {
    const workspaceOwnership = await workspaces.resolveWorkspaceOwnership(workspaceId);
    if (workspaceOwnership === null || workspaceOwnership.workspace.clientId !== clientId) {
      throw new NotFoundError('workspace', workspaceId);
    }
    if (workspaceOwnership.workspace.status !== 'active') {
      throw new ConflictError(
        `workspace ${workspaceId} is ${workspaceOwnership.workspace.status}; experiment analyses cannot be scoped to it`,
      );
    }
  }

  /**
   * THE EXPERIMENT AUTHORITY ANCHOR: the experiment resolved THROUGH the
   * /experiments public contract (the sole experiment identity/design
   * authority — this module reads it, never re-states it). Unknown
   * experiment OR foreign-to-this-Client → uniform 404 (no cross-tenant
   * oracle); a tombstoned owning Client resolves null the same way.
   */
  async function requireExperimentInClient(experimentId: string, clientId: string) {
    const ownership = await experiments.resolveExperimentOwnership(experimentId);
    if (ownership === null || ownership.experiment.clientId !== clientId) {
      throw new NotFoundError('experiment', experimentId);
    }
    return ownership.experiment;
  }

  return {
    async recordExperimentAnalysis(input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidExperimentAnalysisProvenance(provenance);

      // CANONICAL Client owner resolution BEFORE any write.
      await requireActiveClientOwnership(input.clientId);
      if (input.workspaceId !== null) {
        await requireWorkspaceInClient(input.workspaceId, input.clientId);
      }

      // The experiment anchor (read-only through the /experiments public
      // contract — the sole experiment identity/design authority).
      const experiment = await requireExperimentInClient(input.experimentId, input.clientId);

      // The frozen analysis-input shapes at the authority boundary (the
      // reserved 'arm' dimension check needs the experiment's declared
      // primary-metric identity — validated BEFORE any write).
      assertValidExperimentAnalysisCreate(input, experiment.primaryMetric.dimensions);

      // Optional evidence citations (fail closed): every cited ref must
      // resolve to an /evidence record of the SAME Client — a foreign
      // evidence identifier is indistinguishable from an unknown one
      // (uniform 404, no cross-tenant oracle). The DB trigger is the race
      // backstop.
      const evidenceRefs = [...input.evidenceRefs].sort();
      for (const evidenceRef of evidenceRefs) {
        const linked = await evidence.getEvidence(evidenceRef);
        if (linked === null || linked.clientId !== input.clientId) {
          throw new NotFoundError('evidence', evidenceRef);
        }
      }

      // The observation ledger: the Client's /metrics observations
      // (bounded read — the house store bound) filtered to the
      // experiment's declared primary-metric identity, the reserved arm
      // split and the declared window. The read bound feeds the honest
      // may-be-truncated limitation.
      const clientObservations = await metrics.listMetricObservationsForClient(input.clientId);
      const selection = selectObservationsForAnalysis({
        observations: clientObservations,
        metricName: experiment.primaryMetric.name,
        declaredDimensions: experiment.primaryMetric.dimensions,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      });
      const observationReadTruncated = clientObservations.length >= METRICS_READ_BOUND;

      // The learning context: the Client's /learnings citing THIS
      // experiment, consumed with their statements and confidence
      // (sorted by learning id — canonical).
      const clientLearnings = await learnings.listLearningsForClient(input.clientId);
      const consumedLearnings = clientLearnings
        .filter((learning) => learning.experimentRefs.includes(experiment.experimentId))
        .map((learning) => ({
          learningId: learning.learningId,
          statement: learning.statement,
          confidence: learning.confidence,
        }))
        .sort((a, b) => (a.learningId < b.learningId ? -1 : a.learningId > b.learningId ? 1 : 0));

      // The sequential-state input: the prior-analysis count of this
      // experiment (the append-only tail this analysis extends).
      const priorAnalysisCount = await store.countAnalysesForExperiment(experiment.experimentId);

      // The resolved recorded defaults (nulls resolve; the RESOLVED value
      // always rides the snapshot with its defaulted flag).
      const uncertaintyLevel: ExperimentAnalysisUncertaintyLevel =
        input.uncertaintyLevel ?? 0.95;
      const uncertaintyLevelDefaulted = input.uncertaintyLevel === null;
      const minObservationsPerArm =
        input.minObservationsPerArm ?? EXPERIMENT_ANALYSIS_DEFAULT_MIN_OBSERVATIONS_PER_ARM;
      const minObservationsPerArmDefaulted = input.minObservationsPerArm === null;

      // THE FULL INPUT SNAPSHOT (the dispatch's required provenance) —
      // canonically ordered, digested deterministically.
      const snapshot: ExperimentAnalysisInputSnapshot = {
        experiment: {
          experimentId: experiment.experimentId,
          clientId: experiment.clientId,
          treatment: experiment.treatment,
          comparison: experiment.comparison,
          primaryMetricName: experiment.primaryMetric.name,
          primaryMetricDimensions: experiment.primaryMetric.dimensions,
          expectedDirection: experiment.expectedDirection,
          designType: experiment.designType,
          status: experiment.status,
          resultState: experiment.resultState,
        },
        window: { start: input.windowStart, end: input.windowEnd },
        observations: selection.consumed,
        evidenceRefs,
        learnings: consumedLearnings,
        priorAnalysisCount,
        minObservationsPerArm,
        minObservationsPerArmDefaulted,
        uncertaintyLevel,
        uncertaintyLevelDefaulted,
        practicalThreshold: input.practicalThreshold,
        declaredConfounders: input.declaredConfounders,
        declaredLimitations: input.declaredLimitations,
        analysisMethod: EXPERIMENT_ANALYSIS_METHOD,
        analysisMethodVersion: EXPERIMENT_ANALYSIS_METHOD_VERSION,
      };
      const inputDigest = computeExperimentAnalysisSnapshotDigest(snapshot);

      // THE DETERMINISTIC COMPUTATION (pure — same snapshot, same result).
      const { treatmentValues, comparisonValues } = splitByArm(selection.consumed);
      const effect = computeTwoArmEffect({
        treatmentValues,
        comparisonValues,
        level: uncertaintyLevel,
      });
      const outcome = classifyAnalysisOutcome({
        effect,
        practicalThreshold: input.practicalThreshold.value,
        minObservationsPerArm,
      });
      const sequentialState = computeSequentialState({
        priorAnalysisCount,
        level: uncertaintyLevel,
        effect,
        practicalThreshold: input.practicalThreshold.value,
        outcome,
      });
      const confounders = mergeConfounders({
        declared: input.declaredConfounders,
        nTreatment: effect.nTreatment,
        nComparison: effect.nComparison,
        nonOkQualityCount: selection.nonOkQualityCount,
      });
      const limitations = mergeLimitations({
        declared: input.declaredLimitations,
        nTreatment: effect.nTreatment,
        nComparison: effect.nComparison,
        minObservationsPerArm,
        observationReadTruncated,
        sequentialBudgetExhausted: !sequentialState.continueAllowed,
      });
      const recommendedNextAllocation = recommendedAllocationForOutcome(outcome);

      // The append (immutable — the DB triggers reject any later rewrite;
      // a negative or inconclusive outcome stays recorded exactly as
      // computed).
      return store.insertAnalysis(
        {
          analysisId: store.newAnalysisId(),
          clientId: input.clientId,
          workspaceId: input.workspaceId,
          experimentId: experiment.experimentId,
          analysisMethod: EXPERIMENT_ANALYSIS_METHOD,
          analysisMethodVersion: EXPERIMENT_ANALYSIS_METHOD_VERSION,
          vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          nTreatment: effect.nTreatment,
          nComparison: effect.nComparison,
          treatmentMean: effect.treatmentMean,
          comparisonMean: effect.comparisonMean,
          effectEstimate: effect.effectEstimate,
          standardError: effect.standardError,
          uncertainty: effect.uncertainty,
          sequentialState,
          confounders,
          limitations,
          practicalThreshold: input.practicalThreshold,
          outcome,
          recommendedNextAllocation,
          inputSnapshot: snapshot,
          inputDigest,
          evidenceRefs,
          metricObservationRefs: selection.consumed.map((observation) => observation.observationId),
          learningRefs: consumedLearnings.map((learning) => learning.learningId),
        },
        provenance,
      );
    },

    async getExperimentAnalysis(analysisId) {
      return store.getAnalysis(analysisId);
    },

    async resolveExperimentAnalysisOwnership(analysisId) {
      const analysis = await store.getAnalysis(analysisId);
      if (analysis === null) return null;
      // Canonical Client ownership THROUGH the /clients public-contract
      // instance — the ONLY Client ownership authority. A deleted
      // (tombstoned) Client never resolves, so an analysis owned by a
      // tombstoned Client is indistinguishable from an unknown analysis
      // (uniform 404 upstream — the hard-boundary posture).
      const ownership = await clients.resolveClientOwnership(analysis.clientId);
      if (ownership === null) return null;
      // The scoped Workspace snapshot when workspace-scoped and still
      // resolvable (null otherwise — the recorded analysis stays
      // readable; authorization depends only on the client/agency chain).
      let workspace = null;
      if (analysis.workspaceId !== null) {
        workspace = await workspaces.resolveWorkspaceOwnership(analysis.workspaceId);
      }
      return composeExperimentAnalysisOwnerContext(
        analysis,
        ownership,
        workspace,
        deps.clock.nowIso(),
      );
    },

    async listExperimentAnalysesForExperiment(clientId, experimentId) {
      // The Client and the experiment anchor are both resolved canonically
      // BEFORE the read (a foreign experiment identifier is not a
      // traversal/existence oracle — uniform 404).
      await requireActiveClientOwnership(clientId);
      await requireExperimentInClient(experimentId, clientId);
      return store.listAnalysesForExperiment(experimentId);
    },

    async listExperimentAnalysesForClient(clientId) {
      await requireActiveClientOwnership(clientId);
      return store.listAnalysesForClient(clientId);
    },

    async recordAllocationRecommendation(input, provenance) {
      // Provenance is server-derived and must be complete BEFORE anything
      // else runs — an incomplete provenance fails closed.
      assertValidExperimentAnalysisProvenance(provenance);

      // CANONICAL Client owner resolution BEFORE any write.
      await requireActiveClientOwnership(input.clientId);
      if (input.workspaceId !== null) {
        await requireWorkspaceInClient(input.workspaceId, input.clientId);
      }

      // The experiment anchor (read-only through the /experiments public
      // contract).
      const experiment = await requireExperimentInClient(input.experimentId, input.clientId);

      // The frozen allocation-input shapes at the authority boundary.
      assertValidAllocationRecommendationCreate(input);

      // The optional analysis linkage (fail closed): the referenced
      // analysis must exist AND belong to the SAME Client AND the SAME
      // experiment — otherwise the uniform 404 (the DB linkage trigger is
      // the race backstop).
      if (input.analysisId !== null) {
        const linked = await store.getAnalysis(input.analysisId);
        if (
          linked === null ||
          linked.clientId !== input.clientId ||
          linked.experimentId !== input.experimentId
        ) {
          throw new NotFoundError('experiment analysis', input.analysisId);
        }
      }

      // The resolved recorded exploration floor (DATA with its source —
      // never a hardcoded magic number).
      const explorationFloor =
        input.explorationFloor ?? EXPERIMENT_ANALYSIS_DEFAULT_EXPLORATION_FLOOR;
      const explorationFloorSource = input.explorationFloor === null ? 'module_default_v1' : 'declared_input';

      // THE FULL INPUT SNAPSHOT + digest (the reproducibility anchor —
      // arms sorted by armKey canonically inside the allocator).
      const snapshot: ExperimentAllocationInputSnapshot = {
        experiment: {
          experimentId: experiment.experimentId,
          clientId: experiment.clientId,
          status: experiment.status,
        },
        analysisId: input.analysisId,
        arms: [...input.arms].sort((a, b) =>
          a.armKey < b.armKey ? -1 : a.armKey > b.armKey ? 1 : 0,
        ),
        explorationFloor,
        explorationFloorSource,
        uncertaintyLevel: ALLOCATION_SCORING_LEVEL,
        strategyVersion: ALLOCATOR_STRATEGY_VERSION,
      };
      const inputDigest = computeAllocationSnapshotDigest(snapshot);

      // THE DETERMINISTIC ALLOCATION (pure — same snapshot, same
      // decision; zero-capacity arms including the human-treatment arm
      // are excluded and recorded, never errors).
      const computed = computeAdaptiveAllocation({
        arms: snapshot.arms,
        explorationFloor,
      });
      const rationale = renderAllocationRationale({
        computed,
        explorationFloorSource,
        strategyVersion: ALLOCATOR_STRATEGY_VERSION,
      });

      // The append (immutable — the DB triggers reject any later rewrite;
      // a revised allocation is a NEW recommendation).
      return store.insertAllocation(
        {
          recommendationId: store.newRecommendationId(),
          clientId: input.clientId,
          workspaceId: input.workspaceId,
          experimentId: experiment.experimentId,
          analysisId: input.analysisId,
          vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
          arms: snapshot.arms,
          allocation: computed,
          explorationFloor,
          explorationFloorSource,
          inputSnapshot: snapshot,
          inputDigest,
          rationale,
        },
        provenance,
      );
    },

    async getAllocationRecommendation(recommendationId) {
      return store.getAllocation(recommendationId);
    },

    async resolveAllocationRecommendationOwnership(recommendationId) {
      const recommendation = await store.getAllocation(recommendationId);
      if (recommendation === null) return null;
      const ownership = await clients.resolveClientOwnership(recommendation.clientId);
      if (ownership === null) return null;
      let workspace = null;
      if (recommendation.workspaceId !== null) {
        workspace = await workspaces.resolveWorkspaceOwnership(recommendation.workspaceId);
      }
      return composeAllocationRecommendationOwnerContext(
        recommendation,
        ownership,
        workspace,
        deps.clock.nowIso(),
      );
    },

    async listAllocationRecommendationsForExperiment(clientId, experimentId) {
      await requireActiveClientOwnership(clientId);
      await requireExperimentInClient(experimentId, clientId);
      return store.listAllocationsForExperiment(experimentId);
    },
  };
}
