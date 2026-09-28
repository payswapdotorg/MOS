/**
 * /product-marketing module implementation (MKT-070).
 *
 * Owns the migration-060 tables (through the store): the per-mission plan
 * headers + the append-only version tail + the nine FK-anchored citation
 * link tables.
 *
 * THE COMPOSITION: this module FETCHES the planning inputs through the
 * five frozen-row public contracts (/growth-missions, /product-intelligence,
 * /content-intelligence, /platform-health, /experiment-analysis — all
 * READ-ONLY), maps them onto the record-derived PlannerInput, and hands
 * them to the PURE deterministic core (planning.ts). The composed plan is
 * then persisted as ONE append-only plan version (+ its citation links),
 * IDEMPOTENTLY (the digest convergence check runs before any write).
 *
 * THE FABRICATION-RESISTANCE DISCIPLINE IS STRUCTURAL: the module API's
 * compose input is exactly the durable references + the REQUIRED reason —
 * there is NO portfolio/metric/verdict/citation parameter anywhere, the
 * pure core can only cite ids present in its input snapshot, and the
 * store validates every emitted citation against the snapshot before
 * persisting (the DB FK + scope triggers are the backstops).
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  PlannerAllocationSnapshot,
  PlannerContentHypothesisSnapshot,
  PlannerExperimentAnalysisSnapshot,
  PlannerHealthEvaluationSnapshot,
  PlannerInput,
  PlannerResearchSnapshot,
  ProductMarketingModuleApi,
  ProductMarketingModuleDeps,
  ProductMarketingPlanDetail,
  ProductMarketingPlanRecord,
} from '../public.ts';
import {
  PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE,
  PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE,
  PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE,
  PRODUCT_MARKETING_PLANNER_FAMILY,
} from '../public.ts';
import { isTerminalGrowthMissionStatus } from '../../growth-missions/public.ts';
import {
  assertValidComposeProductMarketingPlanInput,
  assertValidProductMarketingProvenance,
  composeProductMarketingPlanCore,
} from './planning.ts';
import { ProductMarketingStore } from './product-marketing-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The composed analyses bound (the bounded snapshot of the client's analysis tail). */
const ANALYSES_BOUND = 10;
/** The composed content-hypotheses bound (the bounded snapshot of current hypotheses). */
const HYPOTHESES_BOUND = 10;

export function createProductMarketingModule(
  deps: ProductMarketingModuleDeps,
): ProductMarketingModuleApi {
  const store = new ProductMarketingStore(deps.db, deps.clock, deps.ids);
  const { clock, missions, productIntelligence, contentIntelligence, platformHealth, experimentAnalysis } =
    deps;
  const platformClasses = deps.platformClasses;
  const researchReferences = deps.researchReferences;
  const workspaces = deps.workspaces;

  /** The composed plan detail (header + versions + citations + disclosures). */
  async function composeDetail(plan: ProductMarketingPlanRecord): Promise<ProductMarketingPlanDetail> {
    const versions = await store.listVersionsByMission(plan.missionId);
    if (versions === null) {
      throw new NotFoundError('product marketing plan', plan.planId);
    }
    const current = versions.find((version) => version.versionSeq === plan.currentVersionSeq);
    if (current === undefined) {
      throw new NotFoundError('product marketing plan version', plan.planId);
    }
    const citations = await store.listCitations(current.planVersionId);
    return {
      plan,
      currentVersion: current,
      versions,
      citations,
      attributionDisclosure: PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE,
      experimentDisclosure: PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE,
      evidenceTierDisclosure: PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE,
    };
  }

  return {
    async composeProductMarketingPlan(input, provenance) {
      assertValidComposeProductMarketingPlanInput(input);
      assertValidProductMarketingProvenance(provenance);

      // --- (1) The mission resolution (READ-ONLY through /growth-missions —
      // the mission authority stays sole; the uniform 404 for
      // foreign/unknown missions). ---
      const missionOwnership = await missions.resolveGrowthMissionOwnership(input.missionId);
      if (missionOwnership === null) {
        throw new NotFoundError('mission', input.missionId);
      }
      const mission = missionOwnership.mission;
      if (isTerminalGrowthMissionStatus(mission.status)) {
        throw new ConflictError(
          'a terminal mission has frozen history — no new product-marketing plan versions are recorded on it',
        );
      }
      if (missionOwnership.mission.agencyId !== mission.agencyId) {
        throw new NotFoundError('mission', input.missionId);
      }

      // --- (2) The product-context resolution (READ-ONLY through
      // /product-intelligence; same-agency fence — a foreign context is
      // the uniform 404, never a traversal oracle). ---
      const contextOwnership =
        await productIntelligence.resolveProductContextOwnership(input.productContextId);
      if (contextOwnership === null || contextOwnership.scope.agencyId !== mission.agencyId) {
        throw new NotFoundError('product context', input.productContextId);
      }
      const contextDetail = await productIntelligence.getProductContextDetail(input.productContextId);
      if (contextDetail === null) {
        throw new NotFoundError('product context', input.productContextId);
      }

      // --- (3) The optional research-session resolution (READ-ONLY through
      // the research reference port — the MKT-069 by-reference seam). ---
      let researchSnapshot: PlannerResearchSnapshot | null = null;
      if (input.researchSessionId !== null) {
        const researchOwnership = await researchReferences.resolveResearchSessionOwnership(
          input.researchSessionId,
        );
        if (researchOwnership === null || researchOwnership.scope.agencyId !== mission.agencyId) {
          throw new NotFoundError('research session', input.researchSessionId);
        }
        const researchDetail = await researchReferences.getResearchSessionDetail(
          input.researchSessionId,
        );
        if (researchDetail === null) {
          throw new NotFoundError('research session', input.researchSessionId);
        }
        researchSnapshot = {
          researchSessionId: researchDetail.session.researchSessionId,
          currentVersionSeq: researchDetail.session.currentVersionSeq,
          topic: researchDetail.currentVersion.topic,
          insights: researchDetail.insights
            .filter((insight) => insight.supersededByResearchInsightId === null)
            .map((insight) => ({
              researchInsightId: insight.researchInsightId,
              derivationKind: insight.derivationKind,
              verificationState: insight.verificationState,
            })),
        };
      }

      // --- (4) The pursuit-scope resolution (the Growth Operator's exact
      // composition: workspace → client → agency, validated against the
      // mission's agency; a workspace of another agency is the uniform
      // 404; a disabled workspace blocks new use honestly). ---
      const workspace = await workspaces.resolveWorkspace(input.pursuitWorkspaceId);
      if (workspace === null || workspace.agencyId !== mission.agencyId) {
        throw new NotFoundError('workspace', input.pursuitWorkspaceId);
      }
      if (workspace.status !== 'active') {
        throw new ConflictError(
          'a disabled workspace blocks new product-marketing plan use without rewriting history',
        );
      }
      const pursuitClientId = workspace.clientId;

      // --- (5) The mission read model (the goal references BY REFERENCE —
      // the mission authority's own live /goals resolution). ---
      const missionDetail = await missions.getGrowthMissionDetail(input.missionId);
      if (missionDetail === null) {
        throw new NotFoundError('mission', input.missionId);
      }
      if (missionDetail.currentVersion.objectiveFamily !== PRODUCT_MARKETING_PLANNER_FAMILY) {
        throw new ConflictError(
          `this planner serves the '${PRODUCT_MARKETING_PLANNER_FAMILY}' objective family — the mission declares '${missionDetail.currentVersion.objectiveFamily}'`,
        );
      }

      // --- (6) The pursuit client's platform-health evaluations (latest
      // per account), experiment analyses + allocation recommendations,
      // and current content hypotheses — all READ-ONLY. ---
      const evaluationsTail = await platformHealth.listEvaluationsForClient(pursuitClientId);
      const latestPerAccount = new Map<string, PlannerHealthEvaluationSnapshot>();
      for (const evaluation of evaluationsTail) {
        const current = latestPerAccount.get(evaluation.socialAccountId);
        if (
          current === undefined ||
          evaluation.createdAt > current.evaluatedAt ||
          (evaluation.createdAt === current.evaluatedAt &&
            evaluation.evaluationId < current.evaluationId)
        ) {
          latestPerAccount.set(evaluation.socialAccountId, {
            evaluationId: evaluation.evaluationId,
            socialAccountId: evaluation.socialAccountId,
            platformId: evaluation.platformId,
            workspaceId: evaluation.workspaceId,
            state: evaluation.evaluatedState,
            confidence: evaluation.confidence,
            reasonCodes: [...evaluation.reasonCodes],
            evaluatedAt: evaluation.createdAt,
          });
        }
      }

      const analysesRecords = await experimentAnalysis.listExperimentAnalysesForClient(
        pursuitClientId,
      );
      const analyses: PlannerExperimentAnalysisSnapshot[] = analysesRecords
        .slice(0, ANALYSES_BOUND)
        .map((analysis) => ({
          analysisId: analysis.analysisId,
          experimentId: analysis.experimentId,
          outcome: analysis.outcome,
          recommendedNextAllocation: analysis.recommendedNextAllocation,
          effectEstimate: analysis.effectEstimate,
        }));
      const allocations: PlannerAllocationSnapshot[] = [];
      const seenExperiments = new Set<string>();
      for (const analysis of analyses) {
        if (seenExperiments.has(analysis.experimentId)) continue;
        seenExperiments.add(analysis.experimentId);
        const recommendations = await experimentAnalysis.listAllocationRecommendationsForExperiment(
          pursuitClientId,
          analysis.experimentId,
        );
        const latest = recommendations[recommendations.length - 1];
        if (latest !== undefined) {
          allocations.push({
            recommendationId: latest.recommendationId,
            experimentId: latest.experimentId,
            eligibleArms: [...latest.allocation.eligibleArms],
            shares: { ...latest.allocation.shares },
          });
        }
      }

      const hypothesisRecords = await contentIntelligence.listContentHypothesesForClient(
        pursuitClientId,
      );
      const hypotheses: PlannerContentHypothesisSnapshot[] = hypothesisRecords
        .filter((hypothesis) => hypothesis.supersededByContentHypothesisId === null)
        .slice(0, HYPOTHESES_BOUND)
        .map((hypothesis) => ({
          contentHypothesisId: hypothesis.contentHypothesisId,
          hypothesisKind: hypothesis.hypothesisKind,
          researchInsightIds: [...hypothesis.researchInsightIds],
        }));

      // --- (7) The pure deterministic core. ---
      const plannerInput: PlannerInput = {
        mission: {
          missionId: missionDetail.mission.missionId,
          agencyId: missionDetail.mission.agencyId,
          status: missionDetail.mission.status,
          versionSeq: missionDetail.currentVersion.versionSeq,
          objectiveFamily: missionDetail.currentVersion.objectiveFamily,
          objectiveExcerpt: missionDetail.currentVersion.objective.slice(0, 500),
          productContext:
            missionDetail.currentVersion.productContext === null
              ? null
              : {
                  name: missionDetail.currentVersion.productContext.name,
                  url: missionDetail.currentVersion.productContext.url,
                  summary: missionDetail.currentVersion.productContext.summary,
                },
          marketContext:
            missionDetail.currentVersion.marketContext === null
              ? null
              : {
                  audience: missionDetail.currentVersion.marketContext.audience,
                  geography: missionDetail.currentVersion.marketContext.geography,
                  summary: missionDetail.currentVersion.marketContext.summary,
                },
          goalRefs: missionDetail.goalMappings
            .filter((mapping) => mapping.removedAt === null)
            .map((mapping) => ({
              goalId: mapping.goalId,
              goalStatus: mapping.goalStatus,
            })),
        },
        productContext: {
          productContextId: contextDetail.context.productContextId,
          currentVersionSeq: contextDetail.currentVersion.versionSeq,
          name: contextDetail.currentVersion.name,
          inputs: contextDetail.currentVersion.inputs.map((declared) => ({
            inputId: declared.inputId,
            kind: declared.kind,
            reference: declared.reference,
            authorization: declared.authorization,
            position: declared.position,
          })),
          sourceFacts: contextDetail.sourceFacts.map((fact) => ({
            sourceFactId: fact.sourceFactId,
            factKind: fact.factKind,
            content: fact.content,
          })),
          derivedModels: contextDetail.derivedModels
            .filter((model) => model.supersededByDerivedModelId === null)
            .map((model) => ({
              derivedModelId: model.derivedModelId,
              derivationKind: model.derivationKind,
              verificationState: model.verificationState,
              evidenceSourceFactIds: [...model.evidenceSourceFactIds],
            })),
          riskFlags: contextDetail.riskFlags.map((flag) => ({
            riskFlagId: flag.riskFlagId,
            category: flag.category,
            severity: flag.severity,
            evidenceSourceFactIds: [...flag.evidenceSourceFactIds],
          })),
        },
        research: researchSnapshot,
        healthEvaluations: [...latestPerAccount.values()],
        experimentAnalyses: analyses,
        allocationRecommendations: allocations,
        contentHypotheses: hypotheses,
      };
      const composed = composeProductMarketingPlanCore(plannerInput, platformClasses);

      // --- (8) The IDEMPOTENT convergence check: the same observable world
      // → the same digest → the honest replay (no duplicate version, no
      // silent rewrite). ---
      const existingPlan = await store.getPlanByMission(input.missionId);
      if (existingPlan !== null) {
        const latest = await store.getLatestVersionByMission(input.missionId);
        if (latest !== null && latest.inputDigest === composed.inputDigest) {
          return composeDetail(existingPlan);
        }
      }

      // --- (9) The append-only version record (+ its citation links). ---
      const versionSeq = existingPlan === null ? 1 : existingPlan.currentVersionSeq + 1;
      const validCitations: Record<
        'product_input' | 'product_source_fact' | 'product_derived_model' | 'product_risk_flag' | 'research_insight' | 'platform_health_evaluation' | 'experiment_analysis' | 'allocation_recommendation' | 'content_hypothesis',
        ReadonlySet<string>
      > = {
        product_input: new Set(
          plannerInput.productContext.inputs.map((declared) => declared.inputId),
        ),
        product_source_fact: new Set(
          plannerInput.productContext.sourceFacts.map((fact) => fact.sourceFactId),
        ),
        product_derived_model: new Set(
          plannerInput.productContext.derivedModels.map((model) => model.derivedModelId),
        ),
        product_risk_flag: new Set(
          plannerInput.productContext.riskFlags.map((flag) => flag.riskFlagId),
        ),
        research_insight: new Set(
          (plannerInput.research?.insights ?? []).map((insight) => insight.researchInsightId),
        ),
        platform_health_evaluation: new Set(
          plannerInput.healthEvaluations.map((evaluation) => evaluation.evaluationId),
        ),
        experiment_analysis: new Set(
          plannerInput.experimentAnalyses.map((analysis) => analysis.analysisId),
        ),
        allocation_recommendation: new Set(
          plannerInput.allocationRecommendations.map((allocation) => allocation.recommendationId),
        ),
        content_hypothesis: new Set(
          plannerInput.contentHypotheses.map((hypothesis) => hypothesis.contentHypothesisId),
        ),
      };

      await store.appendPlanVersion({
        planId: store.newId(),
        missionId: input.missionId,
        agencyId: mission.agencyId,
        clientId: pursuitClientId,
        workspaceId: workspace.workspaceId,
        versionSeq,
        productContextId: contextDetail.context.productContextId,
        productContextVersionId: contextDetail.currentVersion.productContextVersionId,
        researchSessionId: input.researchSessionId,
        reason: input.reason,
        inputSnapshot: {
          missionVersionSeq: plannerInput.mission.versionSeq,
          goalRefs: plannerInput.mission.goalRefs.map((goal) => goal.goalId),
          productContextId: plannerInput.productContext.productContextId,
          productContextVersionSeq: plannerInput.productContext.currentVersionSeq,
          productInputIds: plannerInput.productContext.inputs.map((declared) => declared.inputId),
          productSourceFactIds: plannerInput.productContext.sourceFacts.map(
            (fact) => fact.sourceFactId,
          ),
          productDerivedModelIds: plannerInput.productContext.derivedModels.map(
            (model) => model.derivedModelId,
          ),
          productRiskFlagIds: plannerInput.productContext.riskFlags.map(
            (flag) => flag.riskFlagId,
          ),
          researchSessionId: input.researchSessionId,
          researchVersionSeq: plannerInput.research?.currentVersionSeq ?? null,
          researchInsightIds: (plannerInput.research?.insights ?? []).map(
            (insight) => insight.researchInsightId,
          ),
          healthEvaluationIds: plannerInput.healthEvaluations.map(
            (evaluation) => evaluation.evaluationId,
          ),
          experimentAnalysisIds: plannerInput.experimentAnalyses.map(
            (analysis) => analysis.analysisId,
          ),
          allocationRecommendationIds: plannerInput.allocationRecommendations.map(
            (allocation) => allocation.recommendationId,
          ),
          contentHypothesisIds: plannerInput.contentHypotheses.map(
            (hypothesis) => hypothesis.contentHypothesisId,
          ),
        },
        composed,
        provenance,
        validCitations,
      });

      const plan = await store.getPlanByMission(input.missionId);
      if (plan === null) {
        throw new NotFoundError('product marketing plan', input.missionId);
      }
      return composeDetail(plan);
    },

    async getProductMarketingPlan(missionId) {
      if (!UUID_PATTERN.test(missionId)) return null;
      return store.getPlanByMission(missionId);
    },

    async resolveProductMarketingPlanOwnership(missionId) {
      if (!UUID_PATTERN.test(missionId)) return null;
      const plan = await store.getPlanByMission(missionId);
      if (plan === null) return null;
      return {
        scope: {
          kind: 'product_marketing_plan',
          agencyId: plan.agencyId,
          missionId: plan.missionId,
          planId: plan.planId,
        },
        plan,
        resolvedAt: clock.nowIso(),
      };
    },

    async getProductMarketingPlanDetail(missionId) {
      if (!UUID_PATTERN.test(missionId)) return null;
      const plan = await store.getPlanByMission(missionId);
      if (plan === null) return null;
      return composeDetail(plan);
    },

    async getProductMarketingPlanVersions(missionId) {
      if (!UUID_PATTERN.test(missionId)) return null;
      return store.listVersionsByMission(missionId);
    },
  };
}
