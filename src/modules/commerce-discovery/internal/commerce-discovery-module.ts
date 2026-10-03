/**
 * /commerce-discovery module implementation (MKT-072).
 *
 * Owns the migration-062 tables (through the store): the per-mission
 * program headers + the append-only version tail + the history tail + the
 * candidates + the demand tests + the outcomes + the guardrail
 * evaluations + the thirteen FK-anchored citation link tables.
 *
 * THE COMPOSITION: this module FETCHES the discovery inputs through the
 * six frozen-row public contracts (/growth-missions, /product-intelligence,
 * /content-intelligence, /experiment-analysis, /integrations,
 * /platform-health — all READ-ONLY), maps them onto the record-derived
 * DiscoveryInput, and hands them to the PURE deterministic core
 * (planning.ts). The composed plan is then persisted as ONE append-only
 * version record (+ its citation links), IDEMPOTENTLY (the digest
 * convergence check runs before any write). The demand-test arm creates
 * experiments THROUGH the /experiments authority (the disclosed launch
 * port); the learning loop derives outcomes from the REAL commerce-event
 * projections; the guardrails evaluate the declared bounds against the
 * real observations and produce the honest blocked/terminal states.
 *
 * THE FABRICATION-RESISTANCE DISCIPLINE IS STRUCTURAL: the module API's
 * compose input is exactly the durable references + the declared bounds +
 * the REQUIRED reason — there is NO selection/proposal/verdict/citation
 * parameter anywhere, the pure core can only cite ids present in its
 * input snapshot, and the store validates every emitted citation against
 * the snapshot before persisting (the DB FK + scope triggers are the
 * backstops).
 */

import { ConflictError, InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  CommerceDiscoveryCandidateDetail,
  CommerceDiscoveryDetail,
  CommerceDiscoveryDerivedExperimentDesign,
  CommerceDiscoveryMissionRecord,
  CommerceDiscoveryModuleApi,
  CommerceDiscoveryModuleDeps,
  CommerceDiscoveryOwnerContext,
  CommerceDiscoveryStatus,
  CommerceDiscoveryVersionRecord,
  DiscoveryCitation,
  DiscoveryContentCandidateSnapshot,
  DiscoveryContentHypothesisSnapshot,
  DiscoveryHealthEvaluationSnapshot,
  DiscoveryInput,
  DiscoveryMissionSnapshot,
} from '../public.ts';
import {
  COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE,
  COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
  COMMERCE_DISCOVERY_MISSION_FAMILY,
  COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE,
  COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE,
} from '../public.ts';
import { isTerminalGrowthMissionStatus } from '../../growth-missions/public.ts';
import type { GrowthMissionDetail } from '../../growth-missions/public.ts';
import {
  assertValidCommerceDiscoveryProvenance,
  assertValidComposeCommerceDiscoveryPlanInput,
  composeCommerceDiscoveryPlanCore,
  deriveDemandTestDesign,
  deriveOutcomeCore,
  evaluateGuardrailsCore,
} from './planning.ts';
import { CommerceDiscoveryStore } from './commerce-discovery-store.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bounded snapshot sizes (the bounded read discipline). */
const CONTENT_CANDIDATES_BOUND = 64;
const CONTENT_HYPOTHESES_BOUND = 16;
const HEALTH_EVALUATIONS_BOUND = 16;
const ANALYSES_BOUND = 10;
const COMMERCE_EVENTS_BOUND = 256;
const METRIC_OBSERVATIONS_BOUND = 128;
const CITED_EVENTS_BOUND = 128;
const CITED_METRICS_BOUND = 64;

/** The closed order-event kinds (the order-truth set). */
const ORDER_EVENT_KINDS = [
  'order.created',
  'order.updated',
  'order.fulfilled',
  'order.cancelled',
] as const;

function isOrderEventKind(kind: string): boolean {
  return (ORDER_EVENT_KINDS as readonly string[]).includes(kind);
}

/** The derived order-event shape read from the /integrations projection. */
interface CommerceOrderEventView {
  readonly commerceEventId: string;
  readonly connectionId: string;
  readonly eventKind: string;
  readonly providerSubjectId: string;
  readonly receivedAt: string;
  readonly normalizedPayload: Readonly<Record<string, unknown>>;
}

function requireUuid(value: string, resource: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new NotFoundError(resource, value);
  }
  return value;
}

export function createCommerceDiscoveryModule(
  deps: CommerceDiscoveryModuleDeps,
): CommerceDiscoveryModuleApi {
  const store = new CommerceDiscoveryStore(deps.db, deps.clock, deps.ids);
  const {
    missions,
    productIntelligence,
    contentIntelligence,
    experimentAnalysis,
    integrations,
    platformHealth,
    experimentLaunches,
    metricObservations,
    policyContext,
    workspaces,
  } = deps;

  // -------------------------------------------------------------------------
  // The shared resolution helpers (fail-closed; uniform 404s)
  // -------------------------------------------------------------------------

  /** Resolves the mission READ-ONLY (the spine stays sole). */
  async function resolveMission(
    missionId: string,
    options: { readonly refuseTerminal: boolean },
  ): Promise<{
    readonly missionId: string;
    readonly agencyId: string;
    readonly status: string;
    readonly detail: GrowthMissionDetail;
  }> {
    requireUuid(missionId, 'mission');
    const ownership = await missions.resolveGrowthMissionOwnership(missionId);
    if (ownership === null) {
      throw new NotFoundError('mission', missionId);
    }
    const detail = await missions.getGrowthMissionDetail(missionId);
    if (detail === null) {
      throw new NotFoundError('mission', missionId);
    }
    if (detail.currentVersion.objectiveFamily !== COMMERCE_DISCOVERY_MISSION_FAMILY) {
      throw new ConflictError(
        `the commerce-discovery runtime serves the 'commerce_discovery' objective family only (mission declares '${detail.currentVersion.objectiveFamily}')`,
      );
    }
    if (options.refuseTerminal && isTerminalGrowthMissionStatus(detail.mission.status)) {
      throw new ConflictError(
        'a terminal mission has frozen history — no new commerce-discovery records are appended on it',
      );
    }
    return {
      missionId,
      agencyId: ownership.mission.agencyId,
      status: detail.mission.status,
      detail,
    };
  }

  /** Resolves the discovery program (the uniform 404 when absent). */
  async function resolveProgram(missionId: string): Promise<CommerceDiscoveryMissionRecord> {
    const program = await store.getProgramByMission(missionId);
    if (program === null) {
      throw new NotFoundError('commerce discovery program', missionId);
    }
    return program;
  }

  /** The composed detail read-back (the golden path in one view). */
  async function composeDetail(program: CommerceDiscoveryMissionRecord): Promise<CommerceDiscoveryDetail> {
    const versions = await store.listVersionsByMission(program.missionId);
    if (versions === null || versions.length === 0) {
      throw new NotFoundError('commerce discovery program', program.missionId);
    }
    const current = versions.find((version) => version.versionSeq === program.currentVersionSeq);
    if (current === undefined) {
      throw new NotFoundError('commerce discovery version', program.missionId);
    }
    const candidateRows = await store.listCandidates(program.discoveryMissionId);
    const candidates: CommerceDiscoveryCandidateDetail[] = [];
    for (const candidate of candidateRows) {
      candidates.push({
        candidate,
        citations: await store.listCandidateCitations(candidate.candidateId),
        recommendationDisclosure: COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE,
      });
    }
    return {
      mission: program,
      currentVersion: current,
      versions,
      candidates,
      demandTests: await store.listDemandTests(program.discoveryMissionId),
      outcomes: await store.listOutcomes(program.discoveryMissionId),
      guardrailEvaluations: await store.listEvaluations(program.discoveryMissionId),
      history: await store.listEvents(program.discoveryMissionId),
      orderTruthDisclosure: COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE,
      recommendationDisclosure: COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE,
      attributionDisclosure: COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE,
      guardrailDisclosure: COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
    };
  }

  /** Reads the pursuit client's INGESTED order events of the declared store connection. */
  async function readStoreOrderEvents(
    clientId: string,
    storeConnectionId: string,
  ): Promise<readonly CommerceOrderEventView[]> {
    const events = await integrations.listCommerceEventsForClient(clientId);
    return events
      .filter((event) => event.connectionId === storeConnectionId)
      .filter((event) => isOrderEventKind(event.eventKind))
      .slice(0, COMMERCE_EVENTS_BOUND)
      .map((event) => ({
        commerceEventId: event.commerceEventId,
        connectionId: event.connectionId,
        eventKind: event.eventKind,
        providerSubjectId: event.providerSubjectId,
        receivedAt: event.receivedAt,
        normalizedPayload: event.normalizedPayload,
      }));
  }

  /** Derives the guardrail evaluation inputs (the real observations + the policy context). */
  async function composeGuardrailInputs(program: CommerceDiscoveryMissionRecord): Promise<{
    readonly currentVersion: CommerceDiscoveryVersionRecord;
    readonly observed: { readonly spendMinorUnits: number; readonly demandTestCount: number; readonly orderCount: number };
    readonly policyVersionIds: readonly string[];
    readonly commerceEventIds: readonly string[];
    readonly metricObservationIds: readonly string[];
    readonly orderEvents: readonly CommerceOrderEventView[];
  }> {
    const versions = await store.listVersionsByMission(program.missionId);
    if (versions === null || versions.length === 0) {
      throw new NotFoundError('commerce discovery program', program.missionId);
    }
    const currentVersion = versions.find(
      (version) => version.versionSeq === program.currentVersionSeq,
    );
    if (currentVersion === undefined) {
      throw new NotFoundError('commerce discovery version', program.missionId);
    }

    const demandTests = await store.listDemandTests(program.discoveryMissionId);
    const spendMinorUnits = demandTests.reduce((sum, test) => sum + test.testSpendMinorUnits, 0);
    const demandTestCount = demandTests.length;

    const orderEvents = await readStoreOrderEvents(
      program.clientId,
      currentVersion.storeConnectionId,
    );
    const distinctOrders = new Set(orderEvents.map((event) => event.providerSubjectId));

    // The ACTIVE network policy versions on the program's scope chain
    // (platform / agency / client), read READ-ONLY — the declared-boundary
    // context the evaluation cites.
    const policyVersionIds: string[] = [];
    for (const scope of [
      { agencyId: null, clientId: null },
      { agencyId: program.agencyId, clientId: null },
      { agencyId: program.agencyId, clientId: program.clientId },
    ]) {
      const active = await policyContext.getActivePolicyVersion({
        scope,
        dimension: 'network',
      });
      if (active !== null) {
        policyVersionIds.push(active.policyId);
      }
    }

    const observations = await metricObservations.listMetricObservationsForClient(program.clientId);
    const metricObservationIds = observations
      .slice(0, METRIC_OBSERVATIONS_BOUND)
      .map((observation) => observation.observationId);

    return {
      currentVersion,
      observed: {
        spendMinorUnits,
        demandTestCount,
        orderCount: distinctOrders.size,
      },
      policyVersionIds,
      commerceEventIds: orderEvents.map((event) => event.commerceEventId),
      metricObservationIds,
      orderEvents,
    };
  }

  return {
    async composeCommerceDiscoveryPlan(input, provenance) {
      assertValidComposeCommerceDiscoveryPlanInput(input);
      assertValidCommerceDiscoveryProvenance(provenance);

      // --- (1) The mission resolution (READ-ONLY through /growth-missions). ---
      const mission = await resolveMission(input.missionId, { refuseTerminal: true });

      // --- (2) The product-context resolution (READ-ONLY through
      // /product-intelligence; same-agency fence). ---
      requireUuid(input.productContextId, 'product context');
      const contextOwnership = await productIntelligence.resolveProductContextOwnership(
        input.productContextId,
      );
      if (contextOwnership === null || contextOwnership.scope.agencyId !== mission.agencyId) {
        throw new NotFoundError('product context', input.productContextId);
      }
      const contextDetail = await productIntelligence.getProductContextDetail(input.productContextId);
      if (contextDetail === null) {
        throw new NotFoundError('product context', input.productContextId);
      }

      // --- (3) The pursuit-scope resolution (the operator's composition). ---
      requireUuid(input.pursuitWorkspaceId, 'workspace');
      const workspace = await workspaces.resolveWorkspace(input.pursuitWorkspaceId);
      if (workspace === null || workspace.agencyId !== mission.agencyId) {
        throw new NotFoundError('workspace', input.pursuitWorkspaceId);
      }
      if (workspace.status !== 'active') {
        throw new ConflictError('a disabled workspace blocks new discovery use');
      }

      // --- (4) The declared store connection (READ-ONLY through
      // /integrations; same-client fence). ---
      requireUuid(input.storeConnectionId, 'integration connection');
      const connectionOwnership = await integrations.resolveConnectionOwnership(
        input.storeConnectionId,
      );
      if (
        connectionOwnership === null ||
        connectionOwnership.scope.clientId !== workspace.clientId
      ) {
        throw new NotFoundError('integration connection', input.storeConnectionId);
      }

      // --- (5) The frozen-row input reads (READ-ONLY). ---
      const contentCandidateRows = await contentIntelligence.listContentCandidatesForClient(
        workspace.clientId,
      );
      const contentHypothesisRows = await contentIntelligence.listContentHypothesesForClient(
        workspace.clientId,
      );
      const healthRows = await platformHealth.listEvaluationsForClient(workspace.clientId);
      const analysisRows = await experimentAnalysis.listExperimentAnalysesForClient(
        workspace.clientId,
      );

      const contentCandidates: DiscoveryContentCandidateSnapshot[] = contentCandidateRows
        .slice(0, CONTENT_CANDIDATES_BOUND)
        .map((candidate) => ({
          contentCandidateId: candidate.contentCandidateId,
          topicEntity: candidate.topicEntity,
          niche: candidate.niche,
          subNiche: candidate.subNiche,
          contentFormat: candidate.contentFormat,
          audienceFit: candidate.audienceFit,
          freshness: candidate.freshness,
          novelty: candidate.novelty,
          reuseRisk: candidate.reuseRisk,
          observedPerformance: candidate.observedPerformance,
        }));
      const contentHypotheses: DiscoveryContentHypothesisSnapshot[] = contentHypothesisRows
        .filter((hypothesis) => hypothesis.supersededByContentHypothesisId === null)
        .slice(0, CONTENT_HYPOTHESES_BOUND)
        .map((hypothesis) => ({
          contentHypothesisId: hypothesis.contentHypothesisId,
          hypothesisKind: hypothesis.hypothesisKind,
        }));
      const latestPerAccount = new Map<string, (typeof healthRows)[number]>();
      for (const evaluation of healthRows) {
        const existing = latestPerAccount.get(evaluation.socialAccountId);
        if (
          existing === undefined ||
          evaluation.createdAt.localeCompare(existing.createdAt) > 0
        ) {
          latestPerAccount.set(evaluation.socialAccountId, evaluation);
        }
      }
      const healthEvaluations: DiscoveryHealthEvaluationSnapshot[] = [...latestPerAccount.values()]
        .slice(0, HEALTH_EVALUATIONS_BOUND)
        .map((evaluation) => ({
          evaluationId: evaluation.evaluationId,
          socialAccountId: evaluation.socialAccountId,
          platformId: evaluation.platformId,
          state: evaluation.evaluatedState,
          confidence: evaluation.confidence,
          reasonCodes: evaluation.reasonCodes,
          evaluatedAt: evaluation.createdAt,
        }));
      const experimentAnalyses = analysisRows.slice(0, ANALYSES_BOUND).map((analysis) => ({
        analysisId: analysis.analysisId,
        experimentId: analysis.experimentId,
        outcome: analysis.outcome,
      }));

      // --- (6) The record-derived mission snapshot. ---
      const missionSnapshot: DiscoveryMissionSnapshot = {
        missionId: mission.missionId,
        agencyId: mission.agencyId,
        status: mission.status,
        versionSeq: mission.detail.mission.currentVersionSeq,
        objectiveFamily: mission.detail.currentVersion.objectiveFamily,
        objectiveExcerpt: mission.detail.currentVersion.objective.slice(0, 300),
        productContext: mission.detail.currentVersion.productContext,
        marketContext: mission.detail.currentVersion.marketContext,
        goalRefs: mission.detail.goalMappings
          .filter((mapping) => mapping.removedAt === null)
          .map((mapping) => ({
            goalId: mapping.goalId,
            goalStatus: mapping.goalStatus,
          })),
      };
      const productContextSnapshot: DiscoveryInput['productContext'] = {
        productContextId: contextDetail.context.productContextId,
        currentVersionSeq: contextDetail.context.currentVersionSeq,
        name: contextDetail.currentVersion.name,
        derivedModels: contextDetail.derivedModels
          .filter((model) => model.supersededByDerivedModelId === null)
          .map((model) => ({
            derivedModelId: model.derivedModelId,
            derivationKind: model.derivationKind,
            verificationState: model.verificationState,
            evidenceSourceFactIds: model.evidenceSourceFactIds,
          })),
        riskFlags: contextDetail.riskFlags.map((flag) => ({
          riskFlagId: flag.riskFlagId,
          category: flag.category,
          severity: flag.severity,
          evidenceSourceFactIds: flag.evidenceSourceFactIds,
        })),
      };

      const discoveryInput: DiscoveryInput = {
        mission: missionSnapshot,
        productContext: productContextSnapshot,
        contentCandidates,
        contentHypotheses,
        healthEvaluations,
        experimentAnalyses,
        declared: input.declared,
      };

      // --- (7) The DETERMINISTIC pure core + the idempotent append. ---
      const composed = composeCommerceDiscoveryPlanCore(discoveryInput);
      const existingProgram = await store.getProgramByMission(input.missionId);
      if (existingProgram !== null) {
        const versions = await store.listVersionsByMission(input.missionId);
        const latest = versions?.[versions.length - 1];
        if (latest !== undefined && latest.inputDigest === composed.inputDigest) {
          // The honest replay convergence: the same observable world + the
          // same declared bounds → the EXISTING version.
          return composeDetail(existingProgram);
        }
        if (isTerminalCommerceDiscoveryProgram(existingProgram.status)) {
          throw new ConflictError(
            'a terminal discovery program has frozen history — no new versions are recorded on it',
          );
        }
      }

      const validCitations: Record<DiscoveryCitation['kind'], ReadonlySet<string>> = {
        product_derived_model: new Set(
          productContextSnapshot.derivedModels.map((model) => model.derivedModelId),
        ),
        content_candidate: new Set(contentCandidates.map((c) => c.contentCandidateId)),
        content_hypothesis: new Set(contentHypotheses.map((h) => h.contentHypothesisId)),
        platform_health_evaluation: new Set(healthEvaluations.map((e) => e.evaluationId)),
        experiment_analysis: new Set(experimentAnalyses.map((a) => a.analysisId)),
      };

      const result = await store.appendVersion({
        programId: store.newId(),
        missionId: input.missionId,
        agencyId: mission.agencyId,
        clientId: workspace.clientId,
        workspaceId: workspace.workspaceId,
        versionSeq: (existingProgram?.currentVersionSeq ?? 0) + 1,
        productContextId: contextDetail.context.productContextId,
        productContextVersionId: contextDetail.currentVersion.productContextVersionId,
        storeConnectionId: input.storeConnectionId,
        reason: input.reason,
        inputSnapshot: {
          missionVersionSeq: missionSnapshot.versionSeq,
          objectiveFamily: missionSnapshot.objectiveFamily,
          goalRefs: missionSnapshot.goalRefs.map((goal) => goal.goalId),
          productContextId: productContextSnapshot.productContextId,
          productContextVersionSeq: productContextSnapshot.currentVersionSeq,
          derivedModelIds: productContextSnapshot.derivedModels.map((m) => m.derivedModelId),
          riskFlagIds: productContextSnapshot.riskFlags.map((f) => f.riskFlagId),
          contentCandidateIds: contentCandidates.map((c) => c.contentCandidateId),
          contentHypothesisIds: contentHypotheses.map((h) => h.contentHypothesisId),
          healthEvaluationIds: healthEvaluations.map((e) => e.evaluationId),
          analysisIds: experimentAnalyses.map((a) => a.analysisId),
          storeConnectionId: input.storeConnectionId,
          pursuitWorkspaceId: input.pursuitWorkspaceId,
          declared: { ...input.declared },
        },
        composed,
        provenance,
        validCitations,
      });
      return composeDetail(result.program);
    },

    async getCommerceDiscoveryMission(missionId) {
      return store.getProgramByMission(missionId);
    },

    async resolveCommerceDiscoveryOwnership(missionId) {
      const program = await store.getProgramByMission(missionId);
      if (program === null) return null;
      const ownership: CommerceDiscoveryOwnerContext = {
        scope: {
          kind: 'commerce_discovery_program',
          agencyId: program.agencyId,
          missionId: program.missionId,
          discoveryMissionId: program.discoveryMissionId,
        },
        program,
        resolvedAt: store.nowIso(),
      };
      return ownership;
    },

    async getCommerceDiscoveryDetail(missionId) {
      const program = await store.getProgramByMission(missionId);
      if (program === null) return null;
      return composeDetail(program);
    },

    async getCommerceDiscoveryVersions(missionId) {
      return store.listVersionsByMission(missionId);
    },

    async recordCommerceDiscoveryCandidate(input, provenance) {
      assertValidCommerceDiscoveryProvenance(provenance);
      requireUuid(input.missionId, 'mission');
      const mission = await resolveMission(input.missionId, { refuseTerminal: true });
      const program = await resolveProgram(input.missionId);
      if (isTerminalCommerceDiscoveryProgram(program.status)) {
        throw new ConflictError(
          'a terminal discovery program has frozen history — no new candidates are recorded on it',
        );
      }
      // The mission family + terminal gates rode the resolution; the
      // program's cited product context grounds the provenance below.
      void mission.agencyId;

      // The input guards (the bounded candidate descriptor).
      const problems: string[] = [];
      if (typeof input.label !== 'string' || input.label.length < 1 || input.label.length > 200) {
        problems.push('label: required, 1..200 characters');
      }
      if (typeof input.niche !== 'string' || input.niche.length < 1 || input.niche.length > 200) {
        problems.push('niche: required, 1..200 characters');
      }
      if (
        input.subNiche !== null &&
        (typeof input.subNiche !== 'string' || input.subNiche.length < 1 || input.subNiche.length > 200)
      ) {
        problems.push('subNiche: null or 1..200 characters');
      }
      if (
        typeof input.productDescriptor !== 'string' ||
        input.productDescriptor.length < 1 ||
        input.productDescriptor.length > 2000
      ) {
        problems.push('productDescriptor: required, 1..2000 characters');
      }
      if (
        typeof input.estimatedCostMinorUnits !== 'number' ||
        !Number.isInteger(input.estimatedCostMinorUnits) ||
        input.estimatedCostMinorUnits < 0 ||
        input.estimatedCostMinorUnits > 2000000000
      ) {
        problems.push('estimatedCostMinorUnits: required integer 0..2000000000');
      }
      if (
        typeof input.estimatedPriceMinorUnits !== 'number' ||
        !Number.isInteger(input.estimatedPriceMinorUnits) ||
        input.estimatedPriceMinorUnits < 0 ||
        input.estimatedPriceMinorUnits > 2000000000
      ) {
        problems.push('estimatedPriceMinorUnits: required integer 0..2000000000');
      }
      if (
        typeof input.economicsCurrency !== 'string' ||
        !/^[A-Za-z]{3,8}$/.test(input.economicsCurrency)
      ) {
        problems.push('economicsCurrency: required, 3..8 letters');
      }
      if (
        typeof input.demandHypothesis !== 'string' ||
        input.demandHypothesis.length < 1 ||
        input.demandHypothesis.length > 2000
      ) {
        problems.push('demandHypothesis: required, 1..2000 characters (an input to /experiments, never a conclusion)');
      }
      if (problems.length > 0) {
        throw new InvalidRequestError('invalid record-commerce-discovery-candidate input', problems);
      }
      if (
        input.productDerivedModelIds.length + input.contentCandidateIds.length +
          input.contentHypothesisIds.length ===
        0
      ) {
        throw new InvalidRequestError('invalid record-commerce-discovery-candidate input', [
          'provenance: at least one citation is required (which signals produced this candidate)',
        ]);
      }

      // The provenance citations resolve through the frozen-row contracts
      // (READ-ONLY; the uniform 404 for foreign citations).
      const versions = await store.listVersionsByMission(input.missionId);
      const currentVersion = versions?.find((v) => v.versionSeq === program.currentVersionSeq);
      if (currentVersion === undefined) {
        throw new NotFoundError('commerce discovery version', input.missionId);
      }
      const contextDetail = await productIntelligence.getProductContextDetail(
        currentVersion.productContextId,
      );
      if (contextDetail === null) {
        throw new NotFoundError('product context', currentVersion.productContextId);
      }
      const currentModels = new Set(
        contextDetail.derivedModels
          .filter((model) => model.supersededByDerivedModelId === null)
          .map((model) => model.derivedModelId),
      );
      for (const modelId of input.productDerivedModelIds) {
        requireUuid(modelId, 'product derived model');
        if (!currentModels.has(modelId)) {
          throw new NotFoundError('product derived model', modelId);
        }
      }
      const clientCandidates = await contentIntelligence.listContentCandidatesForClient(
        program.clientId,
      );
      const clientCandidateIds = new Set(
        clientCandidates.map((candidate) => candidate.contentCandidateId),
      );
      for (const candidateId of input.contentCandidateIds) {
        requireUuid(candidateId, 'content candidate');
        if (!clientCandidateIds.has(candidateId)) {
          throw new NotFoundError('content candidate', candidateId);
        }
      }
      const clientHypotheses = await contentIntelligence.listContentHypothesesForClient(
        program.clientId,
      );
      const clientHypothesisIds = new Set(
        clientHypotheses.map((hypothesis) => hypothesis.contentHypothesisId),
      );
      for (const hypothesisId of input.contentHypothesisIds) {
        requireUuid(hypothesisId, 'content hypothesis');
        if (!clientHypothesisIds.has(hypothesisId)) {
          throw new NotFoundError('content hypothesis', hypothesisId);
        }
      }

      const citations: DiscoveryCitation[] = [
        ...input.productDerivedModelIds.map((id) =>
          cite('product_derived_model', id),
        ),
        ...input.contentCandidateIds.map((id) => cite('content_candidate', id)),
        ...input.contentHypothesisIds.map((id) => cite('content_hypothesis', id)),
      ];

      const candidate = await store.insertCandidate({
        candidateId: store.newId(),
        program,
        label: input.label,
        niche: input.niche,
        subNiche: input.subNiche,
        productDescriptor: input.productDescriptor,
        estimatedCostMinorUnits: input.estimatedCostMinorUnits,
        estimatedPriceMinorUnits: input.estimatedPriceMinorUnits,
        economicsCurrency: input.economicsCurrency,
        demandHypothesis: input.demandHypothesis,
        citations,
        reason: `candidate recorded: ${input.label}`,
        provenance,
      });
      return {
        candidate,
        citations,
        recommendationDisclosure: COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE,
      };
    },

    async getCommerceDiscoveryCandidate(candidateId) {
      return store.getCandidateById(candidateId);
    },

    async listCommerceDiscoveryCandidates(missionId) {
      const program = await store.getProgramByMission(missionId);
      if (program === null) return null;
      return store.listCandidates(program.discoveryMissionId);
    },

    async launchCommerceDiscoveryDemandTest(input, provenance) {
      assertValidCommerceDiscoveryProvenance(provenance);
      requireUuid(input.missionId, 'mission');
      requireUuid(input.candidateId, 'commerce discovery candidate');
      await resolveMission(input.missionId, { refuseTerminal: true });
      const program = await resolveProgram(input.missionId);
      if (program.status !== 'active') {
        throw new ConflictError(
          `the discovery program is '${program.status}' — new demand-test spend is refused (the honest blocked/terminal state)`,
        );
      }
      if (
        typeof input.testSpendMinorUnits !== 'number' ||
        !Number.isInteger(input.testSpendMinorUnits) ||
        input.testSpendMinorUnits < 0 ||
        input.testSpendMinorUnits > 2000000000
      ) {
        throw new InvalidRequestError('invalid launch-commerce-discovery-demand-test input', [
          'testSpendMinorUnits: required integer 0..2000000000 (minor units)',
        ]);
      }
      if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 4000) {
        throw new InvalidRequestError('invalid launch-commerce-discovery-demand-test input', [
          'reason: required, 1..4000 characters',
        ]);
      }

      const candidate = await store.getCandidateById(input.candidateId);
      if (candidate === null || candidate.discoveryMissionId !== program.discoveryMissionId) {
        throw new NotFoundError('commerce discovery candidate', input.candidateId);
      }

      const versions = await store.listVersionsByMission(input.missionId);
      const currentVersion = versions?.find((v) => v.versionSeq === program.currentVersionSeq);
      if (currentVersion === undefined) {
        throw new NotFoundError('commerce discovery version', input.missionId);
      }

      // --- THE FAIL-CLOSED BUDGET PRE-GATE (the honest seams). ---
      const demandTests = await store.listDemandTests(program.discoveryMissionId);
      const observedSpend = demandTests.reduce((sum, test) => sum + test.testSpendMinorUnits, 0);
      if (demandTests.length >= currentVersion.declared.maxDemandTests) {
        throw new ConflictError(
          `the declared maximum of ${currentVersion.declared.maxDemandTests} demand test(s) is reached — the launch is refused (raise the declared bounds through a new version, never a silent continue)`,
        );
      }
      if (observedSpend + input.testSpendMinorUnits > currentVersion.declared.testBudgetMinorUnits) {
        throw new ConflictError(
          `the recorded spend ${input.testSpendMinorUnits} minor units would exceed the declared test budget of ${currentVersion.declared.testBudgetMinorUnits} ${currentVersion.declared.spendCurrency} (observed ${observedSpend}) — the launch is refused (never silently continued)`,
        );
      }

      // --- The derived design + the experiment THROUGH the authority. ---
      const design: CommerceDiscoveryDerivedExperimentDesign = deriveDemandTestDesign({
        clientId: program.clientId,
        workspaceId: program.workspaceId,
        missionId: program.missionId,
        candidate: {
          label: candidate.label,
          niche: candidate.niche,
          demandHypothesis: candidate.demandHypothesis,
        },
        declared: currentVersion.declared,
      });
      const experiment = await experimentLaunches.createExperiment(design, provenance);
      if (experiment.clientId !== program.clientId) {
        // The authority's own scope fence backstop — never persisted.
        throw new ConflictError(
          'the created experiment belongs to another client — the demand test is refused',
        );
      }

      return store.insertDemandTest({
        demandTestId: store.newId(),
        program,
        candidateId: candidate.candidateId,
        experimentId: experiment.experimentId,
        testSpendMinorUnits: input.testSpendMinorUnits,
        spendCurrency: currentVersion.declared.spendCurrency,
        derivedDesign: design as unknown as Readonly<Record<string, unknown>>,
        reason: input.reason,
        provenance,
      });
    },

    async recordCommerceDiscoveryDemandTestConclusion(input, provenance) {
      assertValidCommerceDiscoveryProvenance(provenance);
      requireUuid(input.missionId, 'mission');
      requireUuid(input.demandTestId, 'demand test');
      if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 4000) {
        throw new InvalidRequestError('invalid record-demand-test-conclusion input', [
          'reason: required, 1..4000 characters',
        ]);
      }
      await resolveMission(input.missionId, { refuseTerminal: false });
      const program = await resolveProgram(input.missionId);
      const demandTest = await store.getDemandTestById(input.demandTestId);
      if (demandTest === null || demandTest.discoveryMissionId !== program.discoveryMissionId) {
        throw new NotFoundError('demand test', input.demandTestId);
      }
      if (demandTest.state === 'concluded') {
        throw new ConflictError(
          'the demand test is already concluded — the advance is single-shot',
        );
      }

      // The honest read-back from the authority (READ-ONLY).
      const experiment = await experimentLaunches.getExperiment(demandTest.experimentId);
      if (experiment === null) {
        throw new NotFoundError('experiment', demandTest.experimentId);
      }
      if (experiment.status !== 'concluded') {
        throw new ConflictError(
          `the experiment is '${experiment.status}' — a conclusion is recorded only from the authority's own concluded record (never fabricated)`,
        );
      }

      return store.advanceDemandTestConclusion({
        demandTestId: demandTest.demandTestId,
        program,
        conclusionResultState: experiment.resultState,
        conclusionUncertaintyRepresentation: experiment.uncertaintyRepresentation,
        reason: input.reason,
        provenance,
      });
    },

    async listCommerceDiscoveryDemandTests(missionId) {
      const program = await store.getProgramByMission(missionId);
      if (program === null) return null;
      return store.listDemandTests(program.discoveryMissionId);
    },

    async recordCommerceDiscoveryOutcome(input, provenance) {
      assertValidCommerceDiscoveryProvenance(provenance);
      requireUuid(input.missionId, 'mission');
      requireUuid(input.candidateId, 'commerce discovery candidate');
      if (
        !Array.isArray(input.commerceEventIds) ||
        input.commerceEventIds.length < 1 ||
        input.commerceEventIds.length > CITED_EVENTS_BOUND
      ) {
        throw new InvalidRequestError('invalid record-commerce-discovery-outcome input', [
          `commerceEventIds: required, 1..${CITED_EVENTS_BOUND} real commerce event ids`,
        ]);
      }
      if (
        !Array.isArray(input.metricObservationIds) ||
        input.metricObservationIds.length > CITED_METRICS_BOUND
      ) {
        throw new InvalidRequestError('invalid record-commerce-discovery-outcome input', [
          `metricObservationIds: at most ${CITED_METRICS_BOUND} observation ids`,
        ]);
      }
      if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 4000) {
        throw new InvalidRequestError('invalid record-commerce-discovery-outcome input', [
          'reason: required, 1..4000 characters',
        ]);
      }
      await resolveMission(input.missionId, { refuseTerminal: false });
      const program = await resolveProgram(input.missionId);
      if (isTerminalCommerceDiscoveryProgram(program.status)) {
        throw new ConflictError(
          'a terminal discovery program has frozen history — no new outcomes are recorded on it',
        );
      }
      const candidate = await store.getCandidateById(input.candidateId);
      if (candidate === null || candidate.discoveryMissionId !== program.discoveryMissionId) {
        throw new NotFoundError('commerce discovery candidate', input.candidateId);
      }

      const versions = await store.listVersionsByMission(input.missionId);
      const currentVersion = versions?.find((v) => v.versionSeq === program.currentVersionSeq);
      if (currentVersion === undefined) {
        throw new NotFoundError('commerce discovery version', input.missionId);
      }

      // The REAL order events (READ-ONLY through /integrations — the
      // declared store connection's ingested order events only; a
      // foreign/unknown/non-order citation is the uniform 404).
      const orderEvents = await readStoreOrderEvents(
        program.clientId,
        currentVersion.storeConnectionId,
      );
      const eventById = new Map(orderEvents.map((event) => [event.commerceEventId, event]));
      const citedEvents: CommerceOrderEventView[] = [];
      for (const commerceEventId of input.commerceEventIds) {
        requireUuid(commerceEventId, 'commerce event');
        const event = eventById.get(commerceEventId);
        if (event === undefined) {
          throw new NotFoundError('commerce event', commerceEventId);
        }
        citedEvents.push(event);
      }

      // The optionally co-cited /metrics observations (READ-ONLY; same client).
      const clientObservations = await metricObservations.listMetricObservationsForClient(
        program.clientId,
      );
      const observationIds = new Set(
        clientObservations.map((observation) => observation.observationId),
      );
      for (const observationId of input.metricObservationIds) {
        requireUuid(observationId, 'metric observation');
        if (!observationIds.has(observationId)) {
          throw new NotFoundError('metric observation', observationId);
        }
      }

      // The deterministic derivation over the REAL events.
      const derived = deriveOutcomeCore({
        declared: {
          minOrderCountForViability: currentVersion.declared.minOrderCountForViability,
        },
        candidateLabel: candidate.label,
        orderEvents: citedEvents.map((event) => {
          // The authority's normalized payload nests the order body under
          // 'order' (the NormalizedCommerceEvent shape).
          const order = (event.normalizedPayload['order'] ?? {}) as Readonly<Record<string, unknown>>;
          return {
            commerceEventId: event.commerceEventId,
            eventKind: event.eventKind,
            providerSubjectId: event.providerSubjectId,
            receivedAt: event.receivedAt,
            order: {
              orderStatus: String(order['orderStatus'] ?? ''),
              currency: String(order['currency'] ?? ''),
              total: Number(order['total'] ?? 0),
            },
          };
        }),
      });

      return store.insertOutcome({
        outcomeId: store.newId(),
        program,
        candidateId: candidate.candidateId,
        derived,
        commerceEventIds: input.commerceEventIds,
        metricObservationIds: input.metricObservationIds,
        reason: input.reason,
        provenance,
      });
    },

    async listCommerceDiscoveryOutcomes(missionId) {
      const program = await store.getProgramByMission(missionId);
      if (program === null) return null;
      return store.listOutcomes(program.discoveryMissionId);
    },

    async evaluateCommerceDiscoveryGuardrails(input, provenance) {
      assertValidCommerceDiscoveryProvenance(provenance);
      requireUuid(input.missionId, 'mission');
      if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 4000) {
        throw new InvalidRequestError('invalid evaluate-commerce-discovery-guardrails input', [
          'reason: required, 1..4000 characters',
        ]);
      }
      await resolveMission(input.missionId, { refuseTerminal: false });
      const program = await resolveProgram(input.missionId);
      if (isTerminalCommerceDiscoveryProgram(program.status)) {
        throw new ConflictError(
          'a terminal discovery program has frozen history — no new guardrail evaluations are recorded on it',
        );
      }

      const inputs = await composeGuardrailInputs(program);
      const evaluation = evaluateGuardrailsCore({
        declared: {
          spendCurrency: inputs.currentVersion.declared.spendCurrency,
          testBudgetMinorUnits: inputs.currentVersion.declared.testBudgetMinorUnits,
          maxDemandTests: inputs.currentVersion.declared.maxDemandTests,
        },
        observed: inputs.observed,
      });

      return store.insertEvaluation({
        evaluationId: store.newId(),
        program,
        evaluated: {
          spendCurrency: inputs.currentVersion.declared.spendCurrency,
          testBudgetMinorUnits: inputs.currentVersion.declared.testBudgetMinorUnits,
          maxDemandTests: inputs.currentVersion.declared.maxDemandTests,
        },
        observed: inputs.observed,
        verdict: evaluation.verdict,
        breachReasons: [...evaluation.breachReasons],
        rationale: evaluation.rationale,
        policyVersionIds: inputs.policyVersionIds,
        commerceEventIds: inputs.commerceEventIds,
        metricObservationIds: inputs.metricObservationIds,
        reason: input.reason,
        provenance,
      });
    },

    async resolveCommerceDiscoveryGuardrailBlock(input, provenance) {
      assertValidCommerceDiscoveryProvenance(provenance);
      requireUuid(input.missionId, 'mission');
      if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 4000) {
        throw new InvalidRequestError('invalid resolve-commerce-discovery-guardrail-block input', [
          'reason: required, 1..4000 characters',
        ]);
      }
      await resolveMission(input.missionId, { refuseTerminal: false });
      const program = await resolveProgram(input.missionId);
      if (program.status !== 'guardrail_blocked') {
        throw new ConflictError(
          `the discovery program is '${program.status}' — only a guardrail_blocked program resolves a block`,
        );
      }

      // The honest re-evaluation under the CURRENT declared bounds.
      const inputs = await composeGuardrailInputs(program);
      const evaluation = evaluateGuardrailsCore({
        declared: {
          spendCurrency: inputs.currentVersion.declared.spendCurrency,
          testBudgetMinorUnits: inputs.currentVersion.declared.testBudgetMinorUnits,
          maxDemandTests: inputs.currentVersion.declared.maxDemandTests,
        },
        observed: inputs.observed,
      });
      await store.insertEvaluation({
        evaluationId: store.newId(),
        program,
        evaluated: {
          spendCurrency: inputs.currentVersion.declared.spendCurrency,
          testBudgetMinorUnits: inputs.currentVersion.declared.testBudgetMinorUnits,
          maxDemandTests: inputs.currentVersion.declared.maxDemandTests,
        },
        observed: inputs.observed,
        verdict: evaluation.verdict,
        breachReasons: [...evaluation.breachReasons],
        rationale: evaluation.rationale,
        policyVersionIds: inputs.policyVersionIds,
        commerceEventIds: inputs.commerceEventIds,
        metricObservationIds: inputs.metricObservationIds,
        reason: input.reason,
        provenance,
      });
      if (evaluation.verdict !== 'within_bounds') {
        throw new ConflictError(
          `the guardrail observation is still breached (${evaluation.breachReasons.join(', ')}) — the block stands (never a silent lift)`,
        );
      }
      const updated = await store.transitionStatus({
        program,
        toStatus: 'active',
        reason: input.reason,
        eventKind: 'guardrail_resolved',
        detail: null,
        provenance,
      });
      return composeDetail(updated);
    },

    async listCommerceDiscoveryGuardrailEvaluations(missionId) {
      const program = await store.getProgramByMission(missionId);
      if (program === null) return null;
      return store.listEvaluations(program.discoveryMissionId);
    },

    async setCommerceDiscoveryStatus(input, provenance) {
      assertValidCommerceDiscoveryProvenance(provenance);
      requireUuid(input.missionId, 'mission');
      if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 4000) {
        throw new InvalidRequestError('invalid set-commerce-discovery-status input', [
          'reason: required, 1..4000 characters',
        ]);
      }
      if (
        typeof input.status !== 'string' ||
        !(COMMERCE_DISCOVERY_STATUS_SET as ReadonlySet<string>).has(input.status)
      ) {
        throw new InvalidRequestError('invalid set-commerce-discovery-status input', [
          `status: one of ${COMMERCE_DISCOVERY_STATUS_VALUES.join(', ')}`,
        ]);
      }
      const target = input.status as CommerceDiscoveryStatus;
      // The guarded transitions carry their own evidence (the evaluation /
      // resolve commands own the guardrail_blocked ↔ active pair).
      if (target === 'guardrail_blocked' || target === 'active') {
        throw new ConflictError(
          "the 'guardrail_blocked' ↔ 'active' pair is owned by the guardrail evaluation/resolve commands — this surface refuses those targets",
        );
      }
      await resolveMission(input.missionId, { refuseTerminal: false });
      const program = await resolveProgram(input.missionId);
      if (!isLegalTransition(program.status, target)) {
        throw new ConflictError(
          `the discovery program transition '${program.status}' → '${target}' is not legal (terminal history is never rewritten)`,
        );
      }
      const updated = await store.transitionStatus({
        program,
        toStatus: target,
        reason: input.reason,
        eventKind: 'state_transition',
        detail: null,
        provenance,
      });
      return composeDetail(updated);
    },
  };
}

/** The terminal-program predicate (the frozen vocabulary). */
function isTerminalCommerceDiscoveryProgram(status: CommerceDiscoveryStatus): boolean {
  return status === 'concluded' || status === 'stopped_by_user';
}

/** The legal-transition predicate (the frozen transition table). */
function isLegalTransition(from: CommerceDiscoveryStatus, to: CommerceDiscoveryStatus): boolean {
  const table: Record<CommerceDiscoveryStatus, readonly CommerceDiscoveryStatus[]> = {
    active: ['guardrail_blocked', 'concluded', 'stopped_by_user'],
    guardrail_blocked: ['active', 'concluded', 'stopped_by_user'],
    concluded: [],
    stopped_by_user: [],
  };
  return table[from].includes(to);
}

/** The citation constructor re-exported for the module's internal use. */
function cite(kind: DiscoveryCitation['kind'], refId: string): DiscoveryCitation {
  return { kind, refId };
}

const COMMERCE_DISCOVERY_STATUS_VALUES = [
  'active',
  'guardrail_blocked',
  'concluded',
  'stopped_by_user',
] as const;

const COMMERCE_DISCOVERY_STATUS_SET = new Set<string>(COMMERCE_DISCOVERY_STATUS_VALUES);
