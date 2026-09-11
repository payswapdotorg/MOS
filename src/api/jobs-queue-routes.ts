/**
 * /jobs FIELD AGENT WORK QUEUE API routes (MKT-031 — UI-002, UI-AC-01..02:
 * the authoritative API surface a mobile/web work-queue frontend consumes
 * for MY QUEUE, territory/job discovery, acceptance/decline and the
 * execution/evidence obligation view).
 *
 *   GET    /api/jobs/queue                                      MY QUEUE: the caller's OPEN offers (descriptor view) + the jobs the caller ACCEPTED with live status and pending evidence/outcome obligations
 *   GET    /api/jobs/queue/discovery                            the caller's DECLARED service areas + the eligibility-gated job descriptors (the existing marketplace gate)
 *   POST   /api/jobs/queue/offers/:offerId/accept               the concurrency-safe acceptance claim by OFFER ID ALONE (authenticated identity + offer id — every decision stays in the /jobs authority)
 *   POST   /api/jobs/queue/offers/:offerId/decline              the per-offer decline right by offer id alone (never affects the Task)
 *
 * Authority composition (the frozen boundary — this file is a THIN
 * delegation layer, NOT a second authority):
 *
 *   - the queue is the CALLER'S OWN surface: the agent identity is resolved
 *     server-side from the authenticated principal through the merged
 *     /field-agents contract (activeAgentIdFor); no agent id, candidate
 *     identity or scope is ever accepted from a request body (§23);
 *   - ACCEPT/DECLINE converge EXACTLY with the direct MKT-026 surface
 *     (/api/jobs/:jobId/offers/:offerId/accept|decline): both routes call
 *     the SAME modules.jobs.acceptOffer/declineOffer with the SAME
 *     server-derived arguments (actor from the principal, job resolved
 *     from the offer itself), so replay convergence (replayed=true) and
 *     ConflictError passthrough (409) are the module's decision on both
 *     surfaces — the queue can never accept on different terms. A foreign
 *     offer (addressed to a different candidate) is the UNIFORM 404 —
 *     indistinguishable from an unknown identifier (no existence oracle);
 *   - MY QUEUE / discovery are composed ENTIRELY from existing public
 *     contract reads (listOffersForCandidate, getJob, listVisitsForJob,
 *     getJobOutcome, listVisitEvidence, listMarketplaceJobs,
 *     getHumanAgentByUser): no new module, no queue engine, no state
 *     machine, no second eligibility matcher. OPEN offer views and matched
 *     job views are DESCRIPTORS ONLY (no Client data — human-agent-v1.3.md
 *     §3); the full job record appears only for jobs the caller ACCEPTED
 *     (the current authorized Job scope, HUMAN-AC-03);
 *   - the EXECUTION/EVIDENCE obligations in MY QUEUE (job outcome due,
 *     open visits, evidence-due visits) are DERIVED reads over the MKT-027
 *     visits contract — the execution mutations themselves stay on the
 *     existing /api/jobs/:jobId/visits surface (UI-AC-02: a frontend
 *     surface cannot change authorization or workflow outcomes);
 *   - specialization-AGNOSTIC: the same surface serves every Human Agent
 *     specialization (field_agent, chatter, creator_manager, …) — the
 *     queue never filters by specialization; eligibility gating stays the
 *     merged /field-agents profile matcher;
 *   - the routes never mutate workflow state and never dispatch
 *     executions; audit emission mirrors the direct surface's actions and
 *     idempotency-key scheme so one logical acceptance converges to ONE
 *     audit row regardless of which surface performed it.
 *
 * Registered BEFORE the /api/jobs/:jobId-parameterized routes: the literal
 * 'queue' segment sits in the :jobId position and the router resolves
 * first-match-wins (exactly like the marketplace/offers literal segments).
 */

import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import { validateObject } from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { recordMutationAudit } from './audit-emit.ts';
import { resolveContext } from './authorize.ts';
import type { HumanAgentRecord } from '../modules/field-agents/public.ts';
import type {
  JobOfferRecord,
  JobRecord,
  JobStatus,
  VisitRecord,
  VisitStatus,
} from '../modules/jobs/public.ts';
// The shared posture helpers + serializers are imported from jobs-routes.ts
// so every file of the SAME /jobs API surface composes the SAME
// authorization and the SAME serialization (never a second permission
// engine, never a drifting response shape).
import {
  activeAgentIdFor,
  actorUserId,
  jobOwnerScope,
  serializeDescriptor,
  serializeJob,
  serializeOfferForCandidate,
  serializeOfferForCommissioning,
} from './jobs-routes.ts';

// ---------------------------------------------------------------------------
// Frozen vocabulary patterns (mirror jobs-routes.ts).
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * §23 authority-field rejection: every field the server derives on the
 * queue claim surfaces — offer/job identity, candidate identity, status,
 * acceptance bookkeeping, provenance — plus the agency/client linkage keys
 * (mirrors OFFER_CLAIM_AUTHORITY_FIELDS on the direct surface).
 */
const TENANT_AND_LINKAGE_FIELDS = [
  'agencyId',
  'agencyIds',
  'agencies',
  'clientId',
  'clientIds',
  'clients',
  'workspaceId',
  'workspaceIds',
] as const;

const QUEUE_CLAIM_AUTHORITY_FIELDS = [
  'offerId',
  'jobId',
  'candidateAgentId',
  'candidateUserId',
  'status',
  'terminalReason',
  'expiresAt',
  'acceptedAt',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  ...TENANT_AND_LINKAGE_FIELDS,
] as const;

// ---------------------------------------------------------------------------
// Pure queue-view derivation (unit-tested; the routes compose these — no
// decision ever lives in a serializer).
// ---------------------------------------------------------------------------

/** The pending obligations of one accepted job (DERIVED — a read view). */
export interface QueueJobObligations {
  /** The accepted agent still owes the job-level outcome report. */
  readonly jobOutcomeDue: boolean;
  /** Visits still planned or in progress (execution owed). */
  readonly openVisitIds: readonly string[];
  /** In-progress visits with NO captured evidence yet (evidence owed). */
  readonly evidenceDueVisitIds: readonly string[];
}

/**
 * PURE obligation derivation (UI-AC-01 — authoritative state): the job
 * outcome is due while the job sits in its acceptance window without a
 * submitted outcome; open visits are the not-yet-terminal visits; evidence
 * is due for every in-progress visit with no captured evidence record.
 */
export function deriveJobObligations(input: {
  readonly jobStatus: JobStatus;
  readonly hasJobOutcome: boolean;
  readonly visits: ReadonlyArray<{ readonly visitId: string; readonly status: VisitStatus }>;
  readonly evidenceCountByVisitId: ReadonlyMap<string, number>;
}): QueueJobObligations {
  const openVisitIds = input.visits
    .filter((visit) => visit.status === 'planned' || visit.status === 'in_progress')
    .map((visit) => visit.visitId);
  const evidenceDueVisitIds = input.visits
    .filter(
      (visit) =>
        visit.status === 'in_progress' &&
        (input.evidenceCountByVisitId.get(visit.visitId) ?? 0) === 0,
    )
    .map((visit) => visit.visitId);
  return {
    jobOutcomeDue: input.jobStatus === 'accepted' && !input.hasJobOutcome,
    openVisitIds,
    evidenceDueVisitIds,
  };
}

/**
 * PURE agent summary (profile data only — the queue's own identity block;
 * no Client data). Specialization-agnostic: every Human Agent profile gets
 * the same shape.
 */
export function serializeAgentQueueProfile(profile: HumanAgentRecord): Record<string, unknown> {
  return {
    agentId: profile.agentId,
    specializations: [...profile.specializations],
    capabilities: profile.capabilities.map((capability) => ({
      skill: capability.skill,
      ...(capability.level === null ? {} : { level: capability.level }),
    })),
    availability: profile.availability.map((window) => ({
      dayOfWeek: window.dayOfWeek,
      startMinute: window.startMinute,
      endMinute: window.endMinute,
    })),
    ...(profile.location === null
      ? {}
      : { location: { kind: profile.location.kind, value: profile.location.value } }),
    territories: profile.territories.map((territory) => ({
      kind: territory.kind,
      value: territory.value,
    })),
    authorizationState: profile.authorizationState,
  };
}

/**
 * PURE compact visit summary (the queue's obligation-oriented view of the
 * MKT-027 visits contract — the authoritative visit records stay on the
 * /api/jobs/:jobId/visits surface).
 */
export function summarizeQueueVisit(visit: VisitRecord): Record<string, unknown> {
  return {
    visitId: visit.visitId,
    visitSeq: visit.visitSeq,
    targetIdentity: visit.targetIdentity,
    status: visit.status,
    ...(visit.scheduledAt === null ? {} : { scheduledAt: visit.scheduledAt }),
    ...(visit.startedAt === null ? {} : { startedAt: visit.startedAt }),
    ...(visit.completedAt === null ? {} : { completedAt: visit.completedAt }),
    ...(visit.cancelledAt === null ? {} : { cancelledAt: visit.cancelledAt }),
    ...(visit.followUpOfVisitId === null ? {} : { followUpOfVisitId: visit.followUpOfVisitId }),
  };
}

// ---------------------------------------------------------------------------
// Authorization composition (server-derived identity; the caller's OWN queue)
// ---------------------------------------------------------------------------

/**
 * The work-queue posture (the marketplace posture of jobs-routes.ts): the
 * caller must be an ACTIVE user identity with a Human Agent profile.
 */
async function requireQueueAgent(
  modules: ApplicationModules,
  principal: Principal,
): Promise<string> {
  const agentId = await activeAgentIdFor(modules, principal);
  if (agentId === null) {
    throw new ForbiddenError(
      'The work queue requires an active user identity with a Human Agent profile',
    );
  }
  return agentId;
}

/**
 * The caller's OWN offer by offer id, or the uniform 404. The offer is
 * resolved through the candidate-scoped public contract (the caller's own
 * offer surface): a foreign or unknown offer id is indistinguishable from
 * a malformed one — no existence oracle. The job reference for the claim is
 * derived from the offer itself (never caller input).
 */
async function requireOwnQueueOffer(
  modules: ApplicationModules,
  principal: Principal,
  offerId: string,
): Promise<JobOfferRecord> {
  if (!UUID_PATTERN.test(offerId)) {
    throw new NotFoundError('job-offer', offerId);
  }
  const userId = actorUserId(principal);
  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  // Candidate-scoped read: a user without a Human Agent profile has no
  // offer surface at all (fail closed); offers addressed to other
  // candidates are never returned here.
  const offers = await modules.jobs.listOffersForCandidate(userId);
  const offer = offers.find((candidate) => candidate.jobOfferId === offerId);
  if (offer === undefined) {
    throw new NotFoundError('job-offer', offerId);
  }
  return offer;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerJobsQueueRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('jobs-queue.api');

  // -------------------------------------------------------------------------
  // GET /api/jobs/queue — MY QUEUE (UI-AC-01 — authoritative state): the
  // caller's OPEN offers (descriptor view — no Client data) + the jobs the
  // caller ACCEPTED with their live status and the DERIVED pending
  // evidence/outcome obligations (thin composition over the existing /jobs
  // + /field-agents public contracts; the execution mutations stay on the
  // MKT-027 visits surface).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/queue',
    defineQueryRoute<
      Record<string, string>,
      {
        readonly profile: HumanAgentRecord;
        readonly openOffers: ReadonlyArray<{ offer: JobOfferRecord; job: JobRecord | null }>;
        readonly activeJobs: ReadonlyArray<{
          readonly job: JobRecord;
          readonly visits: readonly VisitRecord[];
          readonly obligations: QueueJobObligations;
        }>;
      }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireQueueAgent(modules, ctx.principal);
      },
      execute: async (ctx) => {
        const userId = actorUserId(ctx.principal);
        const profile = await modules.fieldAgents.getHumanAgentByUser(userId);
        if (profile === null) {
          // Unreachable after authorize (fail closed — the same posture).
          throw new ForbiddenError(
            'The work queue requires an active user identity with a Human Agent profile',
          );
        }
        const offers = await modules.jobs.listOffersForCandidate(userId);

        // The DECISION queue: OPEN offers only (terminal history stays on
        // the direct candidate offers surface). Descriptor view only.
        const openOffers: Array<{ offer: JobOfferRecord; job: JobRecord | null }> = [];
        for (const offer of offers) {
          if (offer.status !== 'open') continue;
          openOffers.push({ offer, job: await modules.jobs.getJob(offer.jobId) });
        }

        // The EXECUTION queue: jobs this caller WON (their accepted offer
        // → the winning claim), with live status and derived obligations.
        const seenJobIds = new Set<string>();
        const activeJobs: Array<{
          job: JobRecord;
          visits: readonly VisitRecord[];
          obligations: QueueJobObligations;
        }> = [];
        for (const offer of offers) {
          if (offer.status !== 'accepted' || seenJobIds.has(offer.jobId)) continue;
          const job = await modules.jobs.getJob(offer.jobId);
          if (job === null || job.acceptedUserId !== userId) {
            // Defensive: only the winning claim is the caller's execution
            // scope (the module guarantees this — HUMAN-AC-03).
            continue;
          }
          seenJobIds.add(offer.jobId);
          const visits = await modules.jobs.listVisitsForJob(job.jobId);
          const outcome = await modules.jobs.getJobOutcome(job.jobId);
          const evidenceCountByVisitId = new Map<string, number>();
          for (const visit of visits) {
            if (visit.status === 'in_progress') {
              const evidence = await modules.jobs.listVisitEvidence(visit.visitId);
              evidenceCountByVisitId.set(visit.visitId, evidence.length);
            }
          }
          activeJobs.push({
            job,
            visits,
            obligations: deriveJobObligations({
              jobStatus: job.status,
              hasJobOutcome: outcome !== null,
              visits,
              evidenceCountByVisitId,
            }),
          });
        }
        return { profile, openOffers, activeJobs };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agent: serializeAgentQueueProfile(ctx.result.profile),
          offers: ctx.result.openOffers.map(({ offer, job }) =>
            job === null
              ? {
                  offerId: offer.jobOfferId,
                  jobId: offer.jobId,
                  status: offer.status,
                  expiresAt: offer.expiresAt,
                  createdAt: offer.createdAt,
                }
              : serializeOfferForCandidate(offer, job),
          ),
          activeJobs: ctx.result.activeJobs.map((entry) => ({
            job: serializeJob(entry.job),
            obligations: entry.obligations,
            visits: entry.visits.map(summarizeQueueVisit),
          })),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/queue/discovery — TERRITORY/JOB DISCOVERY: the caller's
  // DECLARED service areas (profile geography) + the ELIGIBILITY-GATED job
  // descriptors (the existing marketplace gate — descriptors only, no
  // Client data; the queue adds no second matcher).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/queue/discovery',
    defineQueryRoute<Record<string, string>, { profile: HumanAgentRecord; jobs: readonly JobRecord[] }>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireQueueAgent(modules, ctx.principal);
      },
      execute: async (ctx) => {
        const agentId = await requireQueueAgent(modules, ctx.principal);
        const profile = await modules.fieldAgents.getHumanAgentByUser(actorUserId(ctx.principal));
        if (profile === null || profile.agentId !== agentId) {
          // Unreachable after authorize (fail closed — the same posture).
          throw new ForbiddenError(
            'The work queue requires an active user identity with a Human Agent profile',
          );
        }
        const jobs = await modules.jobs.listMarketplaceJobs(agentId);
        return { profile, jobs };
      },
      respond: (ctx) => {
        const { profile, jobs } = ctx.result;
        return jsonResponse(200, {
          serviceArea: {
            ...(profile.location === null
              ? {}
              : { location: { kind: profile.location.kind, value: profile.location.value } }),
            territories: profile.territories.map((territory) => ({
              kind: territory.kind,
              value: territory.value,
            })),
          },
          matched: jobs.length,
          jobs: jobs.map(serializeDescriptor),
        });
      },
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/queue/offers/:offerId/accept — the CONCURRENCY-SAFE
  // ACCEPTANCE CLAIM from the queue (authenticated identity + offer id
  // ONLY): the job reference is derived from the offer itself and the
  // claim is delegated to the SAME modules.jobs.acceptOffer the direct
  // MKT-026 surface calls — replay convergence (replayed=true) and
  // ConflictError (409) passthrough are the module's decision on both
  // surfaces (exact convergence; the queue can never accept on different
  // terms). A foreign offer is the uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/queue/offers/:offerId/accept',
    defineMutationRoute<
      { offerId: string },
      { job: JobRecord; offer: JobOfferRecord; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (ctx, params) => {
        const offer = await requireOwnQueueOffer(modules, ctx.principal, params.offerId);
        return jobOwnerScope(modules, offer.jobId);
      },
      authorize: async (ctx) => {
        await requireOwnQueueOffer(modules, ctx.principal, ctx.params.offerId);
      },
      validate: (ctx) =>
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: QUEUE_CLAIM_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        const offer = await requireOwnQueueOffer(modules, ctx.principal, ctx.params.offerId);
        return modules.jobs.acceptOffer({
          jobId: offer.jobId,
          offerId: offer.jobOfferId,
          actorUserId: actorUserId(ctx.principal),
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('jobs.offer.accepted', undefined, {
          job_id: ctx.result.job.jobId,
          job_offer_id: ctx.result.offer.jobOfferId,
          replayed: ctx.result.replayed,
          surface: 'queue',
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.offer.accepted',
          targetType: 'job-offer',
          targetId: ctx.result.offer.jobOfferId,
          beforeVersion: ctx.result.offer.version - (ctx.result.replayed ? 0 : 1),
          afterVersion: ctx.result.offer.version,
          idempotencyKey: `jobs.offer.accepted:${ctx.result.offer.jobOfferId}:${ctx.result.offer.version}`,
          details: {
            jobId: ctx.result.job.jobId,
            acceptedAgentId: ctx.result.job.acceptedAgentId,
            replayed: ctx.result.replayed,
            via: 'queue',
          },
        });
      },
      respond: (ctx) =>
        // The winner's read surface: byte-identical to the direct surface's
        // acceptance response (the SAME serializers — HUMAN-AC-03).
        jsonResponse(200, {
          job: serializeJob(ctx.result.job),
          offer: serializeOfferForCommissioning(ctx.result.offer),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/queue/offers/:offerId/decline — the candidate's
  // per-offer decline right from the queue (offer id alone; never affects
  // the underlying Task). Same delegation posture as accept: the module
  // decides (replay convergence, accepted-offer conflicts, round closure).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/queue/offers/:offerId/decline',
    defineMutationRoute<
      { offerId: string },
      { job: JobRecord; offer: JobOfferRecord; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (ctx, params) => {
        const offer = await requireOwnQueueOffer(modules, ctx.principal, params.offerId);
        return jobOwnerScope(modules, offer.jobId);
      },
      authorize: async (ctx) => {
        await requireOwnQueueOffer(modules, ctx.principal, ctx.params.offerId);
      },
      validate: (ctx) =>
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: QUEUE_CLAIM_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) => {
        const offer = await requireOwnQueueOffer(modules, ctx.principal, ctx.params.offerId);
        return modules.jobs.declineOffer({
          jobId: offer.jobId,
          offerId: offer.jobOfferId,
          actorUserId: actorUserId(ctx.principal),
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        const result = ctx.result;
        logger.info('jobs.offer.declined', undefined, {
          job_id: result.job.jobId,
          job_offer_id: result.offer.jobOfferId,
          replayed: result.replayed,
          surface: 'queue',
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.offer.declined',
          targetType: 'job-offer',
          targetId: result.offer.jobOfferId,
          afterVersion: result.offer.version,
          idempotencyKey: `jobs.offer.declined:${result.offer.jobOfferId}:${result.offer.version}`,
          details: { jobId: result.job.jobId, replayed: result.replayed, via: 'queue' },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          job: serializeJob(ctx.result.job),
          offer: serializeOfferForCommissioning(ctx.result.offer),
          replayed: ctx.result.replayed,
        }),
    }),
  );
}
