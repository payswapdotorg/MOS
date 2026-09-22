/**
 * /api/content-intelligence surfaces (MKT-062 — Content Intelligence:
 * the durable candidate and hypothesis layer over the canonical evidence
 * authority).
 *
 *   POST /api/clients/:clientId/content-intelligence/ingestion-runs     run the observation ingestion (owner|admin)
 *   GET  /api/clients/:clientId/content-intelligence/ingestion-runs     the client's ingestion runs (any active member)
 *   POST /api/clients/:clientId/content-intelligence/candidates         record one candidate (owner|admin; evidence-linked)
 *   GET  /api/clients/:clientId/content-intelligence/candidates         the client's candidates (any active member)
 *   POST /api/clients/:clientId/content-intelligence/hypotheses         record one hypothesis (owner|admin; evidence-separated)
 *   GET  /api/clients/:clientId/content-intelligence/hypotheses         the client's hypotheses (any active member)
 *   GET  /api/content-candidates/:contentCandidateId                    one candidate + its evidence links (any active member)
 *   GET  /api/content-hypotheses/:contentHypothesisId                   one hypothesis + its links + the §6 framing (any active member)
 *
 * SURFACE DISCIPLINE (the boundary battery): GET/POST ONLY — no PUT, no
 * PATCH, no DELETE (asserted by
 * tests/architecture/content-intelligence-boundary.test.ts). Candidates
 * are append-only (a new observation is a NEW candidate); hypothesis
 * corrections are NEW superseding records (POST .../hypotheses with
 * supersedesContentHypothesisId). NO experiment verb exists anywhere in
 * this family — hypotheses are INPUTS to /experiments (the optional
 * experimentId reference is validated READ-ONLY); NO mutation toward any
 * platform exists (the ingestion POST is the bounded READ-ONLY observation
 * read through /integrations; the observations become canonical /evidence
 * records through the /evidence public contract).
 *
 * Server-derived scope posture (implementation-contract §3/§23; the
 * /evidence route precedent): every surface resolves the canonical Client
 * owner scope from durable state BEFORE authorization (unknown,
 * deleted-client and foreign identifiers are the uniform 404 — no
 * existence oracle); a suspended membership or disabled identity is the
 * 403; anonymous calls fail closed 401 at the authenticator. Provenance
 * is SERVER-DERIVED from the authenticated principal + the ambient
 * correlation context (never a request field; the DTOs reject every
 * provenance-shaped key).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { NotFoundError } from '../platform/errors/errors.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
} from '../platform/http/pipeline.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  arrayField,
  optionalNumber,
  optionalRecordField,
  optionalString,
  recordField,
  stringField,
  validateObject,
  type ObjectSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import { requireClientAccess } from './authorize.ts';
import type {
  ContentCandidateDetail,
  ContentCandidateFeaturesInput,
  ContentCandidateRecord,
  ContentHypothesisDetail,
  ContentHypothesisRecord,
  ContentIntelligenceProvenance,
  ContentObservationIngestionRunRecord,
} from '../modules/content-intelligence/public.ts';
import {
  CONTENT_INTELLIGENCE_AUDIENCE_FIT_SIGNALS,
  CONTENT_INTELLIGENCE_FORMATS,
  CONTENT_INTELLIGENCE_HYPOTHESIS_KINDS,
  CONTENT_INTELLIGENCE_LENGTH_UNITS,
  CONTENT_INTELLIGENCE_NARRATIVE_STRUCTURES,
  CONTENT_INTELLIGENCE_NOVELTY_STATES,
  CONTENT_INTELLIGENCE_FRESHNESS_STATES,
  CONTENT_INTELLIGENCE_REUSE_RISK_LEVELS,
} from '../modules/content-intelligence/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAT_PATTERN = new RegExp(`^(${CONTENT_INTELLIGENCE_FORMATS.join('|')})$`);
const LENGTH_UNIT_PATTERN = new RegExp(`^(${CONTENT_INTELLIGENCE_LENGTH_UNITS.join('|')})$`);
const HOOK_FEATURE_PATTERN = new RegExp(
  `^(${[
    'question', 'bold_claim', 'curiosity_gap', 'numbered_list', 'contrarian', 'emotional',
    'urgency', 'identity_callout', 'pattern_interrupt', 'offer_or_price', 'testimonial_lead',
    'statistic_lead',
  ].join('|')})$`,
);
const NARRATIVE_PATTERN = new RegExp(`^(${CONTENT_INTELLIGENCE_NARRATIVE_STRUCTURES.join('|')})$`);
const AUDIENCE_FIT_PATTERN = new RegExp(`^(${CONTENT_INTELLIGENCE_AUDIENCE_FIT_SIGNALS.join('|')})$`);
const FRESHNESS_PATTERN = new RegExp(`^(${CONTENT_INTELLIGENCE_FRESHNESS_STATES.join('|')})$`);
const NOVELTY_PATTERN = new RegExp(`^(${CONTENT_INTELLIGENCE_NOVELTY_STATES.join('|')})$`);
const REUSE_RISK_PATTERN = new RegExp(`^(${CONTENT_INTELLIGENCE_REUSE_RISK_LEVELS.join('|')})$`);
const HYPOTHESIS_KIND_PATTERN = new RegExp(`^(${CONTENT_INTELLIGENCE_HYPOTHESIS_KINDS.join('|')})$`);
const OBSERVATION_KIND_PATTERN = /^(platform_content|platform_analytics)$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Fields that are always server-derived (authority fields). */
const CANDIDATE_AUTHORITY_FIELDS = [
  'contentCandidateId',
  'clientId',
  'workspaceId',
  'evidenceIds',
  'metricObservationIds',
  'provenance',
] as const;

const HYPOTHESIS_AUTHORITY_FIELDS = [
  'contentHypothesisId',
  'clientId',
  'workspaceId',
  'supersededByContentHypothesisId',
  'evidenceIds',
  'candidateIds',
  'researchInsightIds',
  'provenance',
] as const;

// ---------------------------------------------------------------------------
// Server-derived provenance (never a request field)
// ---------------------------------------------------------------------------

function serverProvenance(principal: Principal): ContentIntelligenceProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// DTO specs (strict validation — the evidence-route discipline)
// ---------------------------------------------------------------------------

type ValidatedFeatures = {
  topicEntity: string;
  niche: string;
  subNiche: string | undefined;
  contentFormat: string;
  lengthValue: number | undefined;
  lengthUnit: string | undefined;
  hookFeatures: string[];
  narrativeStructure: string;
  publishedAt: string | undefined;
  observedPerformance: Record<string, unknown>;
  performanceVelocity: Record<string, unknown> | undefined;
  engagement: Record<string, unknown> | undefined;
  audienceFit: string;
  freshness: string;
  novelty: string;
  reuseRisk: string;
};

function featuresSpec(): ObjectSpec<ValidatedFeatures> {
  return {
    forbiddenKeys: ['provenance'],
    fields: {
      topicEntity: stringField({ minLength: 1, maxLength: 300 }),
      niche: stringField({ minLength: 1, maxLength: 200 }),
      subNiche: optionalString({ minLength: 1, maxLength: 200 }),
      contentFormat: stringField({ pattern: FORMAT_PATTERN }),
      lengthValue: optionalNumber({ min: 0, max: 10_000_000 }),
      lengthUnit: optionalString({ pattern: LENGTH_UNIT_PATTERN }),
      hookFeatures: arrayField({
        maxItems: 8,
        item: stringField({ pattern: HOOK_FEATURE_PATTERN }),
      }),
      narrativeStructure: stringField({ pattern: NARRATIVE_PATTERN }),
      publishedAt: optionalString({ pattern: ISO_TIMESTAMP_PATTERN }),
      observedPerformance: recordField({ maxDepthKeys: 24, forbiddenKeys: ['provenance'] }),
      performanceVelocity: optionalRecordField({ maxDepthKeys: 24, forbiddenKeys: ['provenance'] }),
      engagement: optionalRecordField({ maxDepthKeys: 24, forbiddenKeys: ['provenance'] }),
      audienceFit: stringField({ pattern: AUDIENCE_FIT_PATTERN }),
      freshness: stringField({ pattern: FRESHNESS_PATTERN }),
      novelty: stringField({ pattern: NOVELTY_PATTERN }),
      reuseRisk: stringField({ pattern: REUSE_RISK_PATTERN }),
    },
  };
}

/** Maps the validated DTO onto the module features input. */
function toFeatures(body: ValidatedFeatures): ContentCandidateFeaturesInput {
  return {
    topicEntity: body.topicEntity,
    niche: body.niche,
    subNiche: body.subNiche ?? null,
    contentFormat: body.contentFormat as ContentCandidateFeaturesInput['contentFormat'],
    lengthValue: body.lengthValue ?? null,
    lengthUnit: (body.lengthUnit ?? null) as ContentCandidateFeaturesInput['lengthUnit'],
    hookFeatures: body.hookFeatures as ContentCandidateFeaturesInput['hookFeatures'],
    narrativeStructure:
      body.narrativeStructure as ContentCandidateFeaturesInput['narrativeStructure'],
    publishedAt: body.publishedAt ?? null,
    observedPerformance: body.observedPerformance,
    performanceVelocity: body.performanceVelocity ?? null,
    engagement: body.engagement ?? null,
    audienceFit: body.audienceFit as ContentCandidateFeaturesInput['audienceFit'],
    freshness: body.freshness as ContentCandidateFeaturesInput['freshness'],
    novelty: body.novelty as ContentCandidateFeaturesInput['novelty'],
    reuseRisk: body.reuseRisk as ContentCandidateFeaturesInput['reuseRisk'],
  };
}

// ---------------------------------------------------------------------------
// Serialization (presentation only; every field of the record ships)
// ---------------------------------------------------------------------------

function serializeProvenance(
  provenance: ContentCandidateRecord['provenance'],
): Record<string, unknown> {
  return {
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
    recordedAt: provenance.recordedAt,
  };
}

function serializeCandidate(candidate: ContentCandidateRecord): Record<string, unknown> {
  return {
    contentCandidateId: candidate.contentCandidateId,
    clientId: candidate.clientId,
    ...(candidate.workspaceId === null ? {} : { workspaceId: candidate.workspaceId }),
    topicEntity: candidate.topicEntity,
    niche: candidate.niche,
    ...(candidate.subNiche === null ? {} : { subNiche: candidate.subNiche }),
    contentFormat: candidate.contentFormat,
    ...(candidate.lengthValue === null
      ? {}
      : { lengthValue: candidate.lengthValue, lengthUnit: candidate.lengthUnit }),
    hookFeatures: candidate.hookFeatures,
    narrativeStructure: candidate.narrativeStructure,
    ...(candidate.publishedAt === null ? {} : { publishedAt: candidate.publishedAt }),
    observedPerformance: candidate.observedPerformance,
    ...(candidate.performanceVelocity === null
      ? {}
      : { performanceVelocity: candidate.performanceVelocity }),
    ...(candidate.engagement === null ? {} : { engagement: candidate.engagement }),
    audienceFit: candidate.audienceFit,
    freshness: candidate.freshness,
    novelty: candidate.novelty,
    reuseRisk: candidate.reuseRisk,
    evidenceIds: candidate.evidenceIds,
    metricObservationIds: candidate.metricObservationIds,
    provenance: serializeProvenance(candidate.provenance),
  };
}

function serializeCandidateDetail(detail: ContentCandidateDetail): Record<string, unknown> {
  return {
    candidate: serializeCandidate(detail.candidate),
    candidateTier: detail.candidateTier,
    vocabularyVersion: detail.vocabularyVersion,
  };
}

function serializeHypothesis(hypothesis: ContentHypothesisRecord): Record<string, unknown> {
  return {
    contentHypothesisId: hypothesis.contentHypothesisId,
    clientId: hypothesis.clientId,
    ...(hypothesis.workspaceId === null ? {} : { workspaceId: hypothesis.workspaceId }),
    hypothesisKind: hypothesis.hypothesisKind,
    statement: hypothesis.statement,
    supersedesContentHypothesisId: hypothesis.supersedesContentHypothesisId,
    supersededByContentHypothesisId: hypothesis.supersededByContentHypothesisId,
    evidenceIds: hypothesis.evidenceIds,
    candidateIds: hypothesis.candidateIds,
    researchInsightIds: hypothesis.researchInsightIds,
    ...(hypothesis.experimentId === null ? {} : { experimentId: hypothesis.experimentId }),
    provenance: serializeProvenance(hypothesis.provenance),
  };
}

function serializeHypothesisDetail(detail: ContentHypothesisDetail): Record<string, unknown> {
  return {
    hypothesis: serializeHypothesis(detail.hypothesis),
    hypothesisFraming: detail.hypothesisFraming,
    vocabularyVersion: detail.vocabularyVersion,
  };
}

function serializeIngestionRun(
  run: ContentObservationIngestionRunRecord,
): Record<string, unknown> {
  return {
    ingestionRunId: run.ingestionRunId,
    clientId: run.clientId,
    ...(run.workspaceId === null ? {} : { workspaceId: run.workspaceId }),
    connectionId: run.connectionId,
    observationKind: run.observationKind,
    operation: run.operation,
    status: run.status,
    recordsObserved: run.recordsObserved,
    evidenceAppended: run.evidenceAppended,
    appendedEvidenceIds: run.appendedEvidenceIds,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...(run.detail === null ? {} : { detail: run.detail }),
    provenance: serializeProvenance(run.provenance),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerContentIntelligenceRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('contentintelligence.api');

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-intelligence/ingestion-runs — run
  // the OBSERVATION INGESTION over one /integrations connection: the
  // frozen per-kind normalized operation label is executed READ-ONLY and
  // every normalized provider record becomes ONE canonical /evidence
  // 'observation' record (the sole evidence authority). The run row
  // records the honest outcome.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-intelligence/ingestion-runs',
    defineMutationRoute<
      { clientId: string },
      { run: ContentObservationIngestionRunRecord; appendedEvidenceCount: number }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const ownership = await modules.clients.resolveClientOwnership(params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', params.clientId);
        }
        return {
          kind: 'client',
          agencyId: ownership.client.agencyId,
          clientId: ownership.client.clientId,
        };
      },
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          connectionId: string;
          observationKind: string;
          workspaceId: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: ['provenance', 'status', 'recordsObserved', 'evidenceAppended'],
          fields: {
            connectionId: stringField({ pattern: UUID_PATTERN }),
            observationKind: stringField({ pattern: OBSERVATION_KIND_PATTERN }),
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          connectionId: string;
          observationKind: string;
          workspaceId: string | undefined;
        };
        const outcome = await modules.contentIntelligence.runObservationIngestion(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            connectionId: body.connectionId,
            observationKind: body.observationKind as 'platform_content' | 'platform_analytics',
          },
          serverProvenance(ctx.principal),
        );
        return {
          run: outcome.run,
          appendedEvidenceCount: outcome.appendedEvidence.length,
        };
      },
      emit: async (ctx) => {
        logger.info('contentintelligence.ingestion.completed', undefined, {
          client_id: ctx.params.clientId,
          ingestion_run_id: ctx.result.run.ingestionRunId,
          status: ctx.result.run.status,
          evidence_appended: ctx.result.run.evidenceAppended,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'contentintelligence.ingestion.completed',
          targetType: 'client',
          targetId: ctx.params.clientId,
          afterVersion: null,
          idempotencyKey: `contentintelligence.ingestion.completed:${ctx.result.run.ingestionRunId}`,
          details: {
            status: ctx.result.run.status,
            evidenceAppended: ctx.result.run.evidenceAppended,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          run: serializeIngestionRun(ctx.result.run),
          appendedEvidenceCount: ctx.result.appendedEvidenceCount,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-intelligence/ingestion-runs — the
  // client's observation-ingestion runs (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-intelligence/ingestion-runs',
    defineQueryRoute<{ clientId: string }, readonly ContentObservationIngestionRunRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.contentIntelligence.listObservationIngestionRuns(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          ingestionRuns: ctx.result.map(serializeIngestionRun),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-intelligence/candidates — record
  // one CANDIDATE (the §6 observed-feature set as data; ≥1 same-client
  // /evidence link required; optional /metrics observation anchors).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-intelligence/candidates',
    defineMutationRoute<{ clientId: string }, ContentCandidateRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const ownership = await modules.clients.resolveClientOwnership(params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', params.clientId);
        }
        return {
          kind: 'client',
          agencyId: ownership.client.agencyId,
          clientId: ownership.client.clientId,
        };
      },
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<
          ValidatedFeatures & {
            workspaceId: string | undefined;
            evidenceIds: string[];
            metricObservationIds: string[];
          }
        >(ctx.request.body, {
          forbiddenKeys: CANDIDATE_AUTHORITY_FIELDS,
          fields: {
            ...featuresSpec().fields,
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
            evidenceIds: arrayField({
              minItems: 1,
              maxItems: 20,
              item: stringField({ pattern: UUID_PATTERN }),
            }),
            metricObservationIds: arrayField({
              maxItems: 20,
              item: stringField({ pattern: UUID_PATTERN }),
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedFeatures & {
          workspaceId: string | undefined;
          evidenceIds: string[];
          metricObservationIds: string[];
        };
        return modules.contentIntelligence.recordContentCandidate(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            features: toFeatures(body),
            evidenceIds: body.evidenceIds,
            metricObservationIds: body.metricObservationIds,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('contentintelligence.candidate.recorded', undefined, {
          client_id: ctx.params.clientId,
          content_candidate_id: ctx.result.contentCandidateId,
          niche: ctx.result.niche,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'contentintelligence.candidate.recorded',
          targetType: 'client',
          targetId: ctx.params.clientId,
          afterVersion: null,
          idempotencyKey: `contentintelligence.candidate.recorded:${ctx.result.contentCandidateId}`,
          details: {
            niche: ctx.result.niche,
            contentFormat: ctx.result.contentFormat,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeCandidate(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-intelligence/candidates — the
  // client's candidates (oldest first; append-only history).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-intelligence/candidates',
    defineQueryRoute<{ clientId: string }, readonly ContentCandidateRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.contentIntelligence.listContentCandidatesForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          candidates: ctx.result.map(serializeCandidate),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/content-intelligence/hypotheses — record
  // one HYPOTHESIS with honest framing (§6: observed competitor/platform
  // performance does NOT by itself establish causality; hypotheses are
  // inputs to /experiments, never conclusions). ≥1 same-client evidence
  // reference required (evidence/hypothesis separation).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/content-intelligence/hypotheses',
    defineMutationRoute<{ clientId: string }, ContentHypothesisRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const ownership = await modules.clients.resolveClientOwnership(params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', params.clientId);
        }
        return {
          kind: 'client',
          agencyId: ownership.client.agencyId,
          clientId: ownership.client.clientId,
        };
      },
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          workspaceId: string | undefined;
          hypothesisKind: string;
          statement: Record<string, unknown>;
          evidenceIds: string[];
          candidateIds: string[];
          researchInsightIds: string[];
          experimentId: string | undefined;
          supersedesContentHypothesisId: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: HYPOTHESIS_AUTHORITY_FIELDS,
          fields: {
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
            hypothesisKind: stringField({ pattern: HYPOTHESIS_KIND_PATTERN }),
            statement: recordField({ maxDepthKeys: 16, forbiddenKeys: ['provenance'] }),
            evidenceIds: arrayField({
              minItems: 1,
              maxItems: 20,
              item: stringField({ pattern: UUID_PATTERN }),
            }),
            candidateIds: arrayField({
              maxItems: 20,
              item: stringField({ pattern: UUID_PATTERN }),
            }),
            researchInsightIds: arrayField({
              maxItems: 10,
              item: stringField({ pattern: UUID_PATTERN }),
            }),
            experimentId: optionalString({ pattern: UUID_PATTERN }),
            supersedesContentHypothesisId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          workspaceId: string | undefined;
          hypothesisKind: string;
          statement: Record<string, unknown>;
          evidenceIds: string[];
          candidateIds: string[];
          researchInsightIds: string[];
          experimentId: string | undefined;
          supersedesContentHypothesisId: string | undefined;
        };
        return modules.contentIntelligence.recordContentHypothesis(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            hypothesisKind: body.hypothesisKind as ContentHypothesisRecord['hypothesisKind'],
            statement: body.statement,
            evidenceIds: body.evidenceIds,
            candidateIds: body.candidateIds,
            researchInsightIds: body.researchInsightIds,
            experimentId: body.experimentId ?? null,
            supersedesContentHypothesisId: body.supersedesContentHypothesisId ?? null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('contentintelligence.hypothesis.recorded', undefined, {
          client_id: ctx.params.clientId,
          content_hypothesis_id: ctx.result.contentHypothesisId,
          hypothesis_kind: ctx.result.hypothesisKind,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'contentintelligence.hypothesis.recorded',
          targetType: 'client',
          targetId: ctx.params.clientId,
          afterVersion: null,
          idempotencyKey: `contentintelligence.hypothesis.recorded:${ctx.result.contentHypothesisId}`,
          details: {
            hypothesisKind: ctx.result.hypothesisKind,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeHypothesis(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/content-intelligence/hypotheses — the
  // client's hypotheses (oldest first; superseded history stays readable).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/content-intelligence/hypotheses',
    defineQueryRoute<{ clientId: string }, readonly ContentHypothesisRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        return modules.contentIntelligence.listContentHypothesesForClient(ctx.params.clientId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          hypotheses: ctx.result.map(serializeHypothesis),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/content-candidates/:contentCandidateId — one candidate with
  // its evidence links + the §6 observed-features note. Foreign/unknown →
  // uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/content-candidates/:contentCandidateId',
    defineQueryRoute<{ contentCandidateId: string }, ContentCandidateDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (!UUID_PATTERN.test(ctx.params.contentCandidateId)) {
          throw new NotFoundError('content candidate', ctx.params.contentCandidateId);
        }
        const ownership = await modules.contentIntelligence.resolveContentCandidateOwnership(
          ctx.params.contentCandidateId,
        );
        if (ownership === null) {
          throw new NotFoundError('content candidate', ctx.params.contentCandidateId);
        }
        await requireClientAccess(modules, ctx.principal, ownership.scope.clientId);
      },
      execute: async (ctx) => {
        const detail = await modules.contentIntelligence.getContentCandidateDetail(
          ctx.params.contentCandidateId,
        );
        if (detail === null) {
          throw new NotFoundError('content candidate', ctx.params.contentCandidateId);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeCandidateDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/content-hypotheses/:contentHypothesisId — one hypothesis with
  // its links + the §6 non-causality framing disclosure. Foreign/unknown →
  // uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/content-hypotheses/:contentHypothesisId',
    defineQueryRoute<{ contentHypothesisId: string }, ContentHypothesisDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (!UUID_PATTERN.test(ctx.params.contentHypothesisId)) {
          throw new NotFoundError('content hypothesis', ctx.params.contentHypothesisId);
        }
        const ownership = await modules.contentIntelligence.resolveContentHypothesisOwnership(
          ctx.params.contentHypothesisId,
        );
        if (ownership === null) {
          throw new NotFoundError('content hypothesis', ctx.params.contentHypothesisId);
        }
        await requireClientAccess(modules, ctx.principal, ownership.scope.clientId);
      },
      execute: async (ctx) => {
        const detail = await modules.contentIntelligence.getContentHypothesisDetail(
          ctx.params.contentHypothesisId,
        );
        if (detail === null) {
          throw new NotFoundError('content hypothesis', ctx.params.contentHypothesisId);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeHypothesisDetail(ctx.result)),
    }),
  );
}
