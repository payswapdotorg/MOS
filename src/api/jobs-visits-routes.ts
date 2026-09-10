/**
 * /jobs FIELD EXECUTION API routes (MKT-027 — the visit/field execution
 * surface: JOB-001 field subset, EVID-001 field subset, JOB-AC-03..04,
 * EVID-AC-01..03 field subset).
 *
 *   POST   /api/jobs/:jobId/visits                                 open one visit (the job's ACCEPTED agent only)
 *   GET    /api/jobs/:jobId/visits                                 list a job's visits (commissioning member | accepted agent)
 *   GET    /api/jobs/:jobId/visits/:visitId                        read one visit (commissioning member | accepted agent)
 *   GET    /api/jobs/:jobId/visits/:visitId/transitions            the append-only lifecycle history (full read posture)
 *   POST   /api/jobs/:jobId/visits/:visitId/start                  start the visit (the accepted agent only; replay converges)
 *   POST   /api/jobs/:jobId/visits/:visitId/cancel                 cancel the visit (the accepted agent only; replay converges)
 *   POST   /api/jobs/:jobId/visits/:visitId/complete               complete with the structured outcome (the accepted agent only)
 *   GET    /api/jobs/:jobId/visits/:visitId/outcome                read the structured outcome (full read posture)
 *   POST   /api/jobs/:jobId/visits/:visitId/evidence               CAPTURE one evidence record from the field (accepted agent only)
 *   GET    /api/jobs/:jobId/visits/:visitId/evidence               list the captured evidence (full read posture)
 *   GET    /api/jobs/:jobId/visits/:visitId/continuity             the DERIVED relationship chain (JOB-AC-04 — policy-gated for the agent)
 *
 * Authority composition (the frozen boundary — identical posture to the
 * MKT-026 jobs routes; the shared helpers are imported from
 * jobs-routes.ts so the two files of the SAME /jobs API surface compose
 * the SAME authorization, never a second permission engine):
 *
 *   - every mutating operation verifies the caller IS the job's ACCEPTED
 *     agent: a foreign job/visit identifier is the UNIFORM 404
 *     (indistinguishable from unknown — no existence oracle; the
 *     commissioning side can never execute field work or fabricate
 *     outcome/evidence actors on the agent's behalf; HUMAN-AC-03);
 *   - reads use the full-job posture (commissioning member | platform
 *     admin | service | the accepted agent — the current authorized Job
 *     scope); everyone else gets the uniform 404;
 *   - visit scope is SERVER-DERIVED from the Job (inherited); every
 *     scope-shaped, identity-shaped or provenance-shaped DTO field is
 *     rejected at validation time (§23 authority fields);
 *   - outcome/capture provenance is SERVER-DERIVED (actor from the
 *     authenticated principal, correlation from the ambient context,
 *     recording surface 'api', causation the job id); the module stamps
 *     the field-capture evidence with recordedVia 'field-agent' and
 *     causation the visit id (the /evidence frozen vocabulary);
 *   - CONTINUITY (JOB-AC-04): the chain is DERIVED (a read; history is
 *     never rewritten) and the exposure to the ACCEPTED AGENT is gated
 *     by the policy checkpoint visitContinuityExposedToAgent over the
 *     agent's frozen /field-agents profile relationship-continuity
 *     block (the merged policy-data seam; the /policies authority —
 *     MKT-021 — is the declared swap point). The commissioning side
 *     reads the full chain through its client scope;
 *   - the routes never mutate workflow state and never dispatch
 *     executions: /workflows stays the single workflow authority and
 *     visits are the /jobs-owned field-execution records inside the
 *     acceptance window.
 */

import { ForbiddenError, InvalidRequestError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  optionalIsoDateField,
  optionalNumber,
  optionalString,
  recordField,
  stringField,
  validateObject,
  type FieldSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import { resolveContext } from './authorize.ts';
import {
  actorUserId,
  canReadFullJob,
  jobOwnerScope,
  requireJob,
} from './jobs-routes.ts';
import type {
  EvidenceClass,
  EvidenceQualityGrade,
} from '../modules/evidence/public.ts';
import type {
  VisitContinuityView,
  VisitEvidenceLinkRecord,
  VisitOutcomeRecord,
  VisitRecord,
  VisitTransitionRecord,
} from '../modules/jobs/public.ts';
import {
  MAX_VISIT_NOTES_LENGTH,
  MAX_VISIT_REASON_LENGTH,
  visitContinuityExposedToAgent,
} from '../modules/jobs/public.ts';

// ---------------------------------------------------------------------------
// Frozen vocabulary patterns (mirror the module public registries; the
// architecture test fails if the DB CHECK / code registry / route pattern
// ever drift).
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ,.\-:/_]{0,199}$/;
const VISIT_RESULT_PATTERN = /^(succeeded|partial|no_contact|failed)$/;
const EVIDENCE_CLASS_PATTERN =
  /^(source_fact|observation|inference|hypothesis|attribution|prediction|causal_estimate|learning)$/;
const EVIDENCE_QUALITY_PATTERN = /^[A-F]$/;

/** §23 authority-field rejection: every field the server derives. */
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

const VISIT_OPEN_AUTHORITY_FIELDS = [
  'visitId',
  'jobId',
  'visitSeq',
  'status',
  'startedAt',
  'completedAt',
  'cancelledAt',
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

const VISIT_TRANSITION_AUTHORITY_FIELDS = [
  'visitId',
  'jobId',
  'visitSeq',
  'status',
  'targetIdentity',
  'scheduledAt',
  'startedAt',
  'completedAt',
  'cancelledAt',
  'followUpOfVisitId',
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

const VISIT_OUTCOME_AUTHORITY_FIELDS = [
  'visitOutcomeId',
  'visitId',
  'jobId',
  'reportedInstanceStatus',
  'status',
  'submittedBy',
  'submittedAt',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'provenance',
  'actor',
  'createdAt',
  'version',
  ...TENANT_AND_LINKAGE_FIELDS,
] as const;

const VISIT_EVIDENCE_AUTHORITY_FIELDS = [
  'evidenceId',
  'visitId',
  'jobId',
  'source',
  'sourceSystem',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'provenance',
  'actor',
  'supersedes',
  'supersedesEvidenceId',
  'supersededBy',
  'clientId',
  'workspaceId',
  'agencyId',
  'createdAt',
  ...TENANT_AND_LINKAGE_FIELDS,
] as const;

// ---------------------------------------------------------------------------
// Field specs (strict DTO shapes)
// ---------------------------------------------------------------------------

const booleanField: FieldSpec<boolean> = {
  required: true,
  parse: (value, problems) => {
    if (typeof value !== 'boolean') {
      problems.push('must be a boolean');
      return false;
    }
    return value;
  },
};

const nullableScheduledAtField = optionalIsoDateField();

// ---------------------------------------------------------------------------
// Serialization — the FULL record posture (commissioning member | accepted
// agent: both are inside the authorized Job scope; human-agent-v1.3.md §3).
// ---------------------------------------------------------------------------

function serializeVisit(visit: VisitRecord): Record<string, unknown> {
  return {
    visitId: visit.visitId,
    jobId: visit.jobId,
    visitSeq: visit.visitSeq,
    workspaceId: visit.workspaceId,
    clientId: visit.clientId,
    agencyId: visit.agencyId,
    targetIdentity: visit.targetIdentity,
    status: visit.status,
    ...(visit.scheduledAt === null ? {} : { scheduledAt: visit.scheduledAt }),
    ...(visit.startedAt === null ? {} : { startedAt: visit.startedAt }),
    ...(visit.completedAt === null ? {} : { completedAt: visit.completedAt }),
    ...(visit.cancelledAt === null ? {} : { cancelledAt: visit.cancelledAt }),
    ...(visit.followUpOfVisitId === null
      ? {}
      : { followUpOfVisitId: visit.followUpOfVisitId }),
    ...(visit.createdBy === null ? {} : { createdBy: visit.createdBy }),
    provenance: {
      recordedActor: visit.provenance.actor,
      recordedVia: visit.provenance.recordedVia,
      correlationId: visit.provenance.correlationId,
      ...(visit.provenance.causationId === null
        ? {}
        : { causationId: visit.provenance.causationId }),
      recordedAt: visit.provenance.recordedAt,
    },
    version: visit.version,
    createdAt: visit.createdAt,
    updatedAt: visit.updatedAt,
  };
}

function serializeVisitTransition(transition: VisitTransitionRecord): Record<string, unknown> {
  return {
    transitionId: transition.transitionId,
    visitId: transition.visitId,
    fromStatus: transition.fromStatus,
    toStatus: transition.toStatus,
    ...(transition.reason === '' ? {} : { reason: transition.reason }),
    ...(transition.createdBy === null ? {} : { createdBy: transition.createdBy }),
    provenance: {
      recordedActor: transition.provenance.actor,
      recordedVia: transition.provenance.recordedVia,
      correlationId: transition.provenance.correlationId,
      ...(transition.provenance.causationId === null
        ? {}
        : { causationId: transition.provenance.causationId }),
      recordedAt: transition.provenance.recordedAt,
    },
    createdAt: transition.createdAt,
  };
}

function serializeVisitOutcome(outcome: VisitOutcomeRecord): Record<string, unknown> {
  return {
    visitOutcomeId: outcome.visitOutcomeId,
    visitId: outcome.visitId,
    result: outcome.result,
    followUpRequired: outcome.followUpRequired,
    notes: outcome.notes,
    observations: outcome.observations,
    evidenceRef: outcome.evidenceRef,
    provenance: {
      recordedActor: outcome.provenance.actor,
      recordedVia: outcome.provenance.recordedVia,
      correlationId: outcome.provenance.correlationId,
      ...(outcome.provenance.causationId === null
        ? {}
        : { causationId: outcome.provenance.causationId }),
      recordedAt: outcome.provenance.recordedAt,
      ...(outcome.provenance.submittedBy === null
        ? {}
        : { submittedBy: outcome.provenance.submittedBy }),
      submittedAt: outcome.provenance.submittedAt,
    },
    createdAt: outcome.createdAt,
  };
}

function serializeVisitEvidenceLink(link: VisitEvidenceLinkRecord): Record<string, unknown> {
  return {
    visitId: link.visitId,
    evidenceId: link.evidenceId,
    ...(link.capturedBy === null ? {} : { capturedBy: link.capturedBy }),
    provenance: {
      recordedActor: link.provenance.actor,
      recordedVia: link.provenance.recordedVia,
      correlationId: link.provenance.correlationId,
      ...(link.provenance.causationId === null
        ? {}
        : { causationId: link.provenance.causationId }),
      recordedAt: link.provenance.recordedAt,
    },
  };
}

/** One entry of the continuity chain (the derived prior-visit view). */
function serializeContinuityEntry(
  entry: { visit: VisitRecord; outcome: VisitOutcomeRecord | null },
): Record<string, unknown> {
  return {
    visitId: entry.visit.visitId,
    jobId: entry.visit.jobId,
    visitSeq: entry.visit.visitSeq,
    targetIdentity: entry.visit.targetIdentity,
    status: entry.visit.status,
    completedAt: entry.visit.completedAt,
    ...(entry.visit.followUpOfVisitId === null
      ? {}
      : { followUpOfVisitId: entry.visit.followUpOfVisitId }),
    ...(entry.outcome === null
      ? {}
      : {
          outcome: {
            result: entry.outcome.result,
            followUpRequired: entry.outcome.followUpRequired,
            ...(entry.outcome.notes === '' ? {} : { notes: entry.outcome.notes }),
            observations: entry.outcome.observations,
            evidenceRef: entry.outcome.evidenceRef,
            submittedAt: entry.outcome.provenance.submittedAt,
          },
        }),
  };
}

// ---------------------------------------------------------------------------
// Authorization composition (server-derived ownership; §3 access postures)
// ---------------------------------------------------------------------------

/** The visit nested under its job, or the uniform 404. */
async function requireVisit(
  modules: ApplicationModules,
  jobId: string,
  visitId: string,
): Promise<VisitRecord> {
  if (!UUID_PATTERN.test(visitId)) {
    throw new NotFoundError('visit', visitId);
  }
  const visit = await modules.jobs.getVisit(jobId, visitId);
  if (visit === null) {
    throw new NotFoundError('visit', visitId);
  }
  return visit;
}

/** The continuity view, or the uniform 404. */
async function requireContinuity(
  modules: ApplicationModules,
  visitId: string,
): Promise<VisitContinuityView> {
  if (!UUID_PATTERN.test(visitId)) {
    throw new NotFoundError('visit', visitId);
  }
  const view = await modules.jobs.getVisitContinuity(visitId);
  if (view === null) {
    throw new NotFoundError('visit', visitId);
  }
  return view;
}

/**
 * The accepted-agent authorization: the caller must be an ACTIVE user
 * identity who IS the job's accepted agent (HUMAN-AC-03 — the authorized
 * Job scope). A job the caller did not win is the UNIFORM 404.
 */
async function requireAcceptedAgent(
  modules: ApplicationModules,
  principal: Principal,
  jobId: string,
): Promise<void> {
  const userId = actorUserId(principal);
  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  const job = await requireJob(modules, jobId);
  if (job.acceptedUserId !== userId) {
    throw new NotFoundError('job', jobId);
  }
}

/**
 * SERVER-DERIVED visit provenance (JOB-AC-03 posture): actor from the
 * authenticated principal, correlation from the ambient correlation
 * context, recording surface 'api', causation the job id. No value in
 * here is reachable from the request body (the DTO rejects every
 * provenance-shaped key). The module re-stamps the field-capture evidence
 * dimensions (recordedVia 'field-agent', causation the visit id).
 */
function visitProvenance(principal: Principal, jobId: string) {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: jobId,
  };
}

function principalActorId(principal: Principal): string | null {
  return principal.kind === 'user' ? principal.userId : null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerJobsVisitsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('jobs-visits.api');

  // -------------------------------------------------------------------------
  // POST /api/jobs/:jobId/visits — OPEN one visit (the job's ACCEPTED
  // agent only; the scope chain is INHERITED from the Job — server-derived;
  // the acceptance window is enforced by the module + the DB trigger).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/:jobId/visits',
    defineMutationRoute<{ jobId: string }, VisitRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => jobOwnerScope(modules, params.jobId),
      authorize: async (ctx) => {
        await requireAcceptedAgent(modules, ctx.principal, ctx.params.jobId);
      },
      validate: (ctx) =>
        validateObject<{
          targetIdentity: string;
          scheduledAt: string | undefined;
          followUpOfVisitId: string | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: VISIT_OPEN_AUTHORITY_FIELDS,
          fields: {
            targetIdentity: stringField({ minLength: 1, maxLength: 200, pattern: TARGET_IDENTITY_PATTERN }),
            scheduledAt: nullableScheduledAtField,
            followUpOfVisitId: optionalString({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          targetIdentity: string;
          scheduledAt: string | undefined;
          followUpOfVisitId: string | undefined;
        };
        return modules.jobs.openVisit({
          jobId: ctx.params.jobId,
          targetIdentity: body.targetIdentity,
          scheduledAtIso: body.scheduledAt === undefined ? null : body.scheduledAt,
          followUpOfVisitId: body.followUpOfVisitId === undefined ? null : body.followUpOfVisitId,
          actorUserId: actorUserId(ctx.principal),
          actorId: principalActorId(ctx.principal),
          provenance: visitProvenance(ctx.principal, ctx.params.jobId),
        });
      },
      emit: async (ctx) => {
        logger.info('jobs.visit.opened', undefined, {
          job_id: ctx.result.jobId,
          visit_id: ctx.result.visitId,
          visit_seq: ctx.result.visitSeq,
          target_identity: ctx.result.targetIdentity,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.visit.opened',
          targetType: 'visit',
          targetId: ctx.result.visitId,
          afterVersion: ctx.result.version,
          idempotencyKey: `jobs.visit.opened:${ctx.result.visitId}`,
          details: {
            jobId: ctx.result.jobId,
            visitSeq: ctx.result.visitSeq,
            targetIdentity: ctx.result.targetIdentity,
            ...(ctx.result.followUpOfVisitId === null
              ? {}
              : { followUpOfVisitId: ctx.result.followUpOfVisitId }),
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeVisit(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:jobId/visits — the job's visits (the full read posture:
  // commissioning member | platform admin | service | the accepted agent).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/:jobId/visits',
    defineQueryRoute<{ jobId: string }, readonly VisitRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        if (!(await canReadFullJob(modules, ctx.principal, job))) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      execute: async (ctx) => modules.jobs.listVisitsForJob(ctx.params.jobId),
      respond: (ctx) =>
        jsonResponse(200, {
          jobId: ctx.params.jobId,
          visits: ctx.result.map(serializeVisit),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:jobId/visits/:visitId — read one visit (full posture).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/:jobId/visits/:visitId',
    defineQueryRoute<{ jobId: string; visitId: string }, VisitRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        if (!(await canReadFullJob(modules, ctx.principal, job))) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      execute: async (ctx) => requireVisit(modules, ctx.params.jobId, ctx.params.visitId),
      respond: (ctx) => jsonResponse(200, serializeVisit(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:jobId/visits/:visitId/transitions — the append-only
  // lifecycle history with full provenance (full read posture).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/:jobId/visits/:visitId/transitions',
    defineQueryRoute<{ jobId: string; visitId: string }, readonly VisitTransitionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        if (!(await canReadFullJob(modules, ctx.principal, job))) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      execute: async (ctx) => {
        await requireVisit(modules, ctx.params.jobId, ctx.params.visitId);
        return modules.jobs.listVisitTransitions(ctx.params.visitId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          visitId: ctx.params.visitId,
          transitions: ctx.result.map(serializeVisitTransition),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/:jobId/visits/:visitId/start — START the visit
  // (planned → in_progress; the accepted agent only; replay converges).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/:jobId/visits/:visitId/start',
    defineMutationRoute<
      { jobId: string; visitId: string },
      { visit: VisitRecord; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => jobOwnerScope(modules, params.jobId),
      authorize: async (ctx) => {
        await requireAcceptedAgent(modules, ctx.principal, ctx.params.jobId);
        await requireVisit(modules, ctx.params.jobId, ctx.params.visitId);
      },
      validate: (ctx) =>
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: VISIT_TRANSITION_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) =>
        modules.jobs.startVisit({
          jobId: ctx.params.jobId,
          visitId: ctx.params.visitId,
          actorUserId: actorUserId(ctx.principal),
          actorId: principalActorId(ctx.principal),
          provenance: visitProvenance(ctx.principal, ctx.params.jobId),
        }),
      emit: async (ctx) => {
        logger.info('jobs.visit.started', undefined, {
          job_id: ctx.result.visit.jobId,
          visit_id: ctx.result.visit.visitId,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.visit.started',
          targetType: 'visit',
          targetId: ctx.result.visit.visitId,
          afterVersion: ctx.result.visit.version,
          idempotencyKey: `jobs.visit.started:${ctx.result.visit.visitId}:${ctx.result.visit.version}`,
          details: { jobId: ctx.result.visit.jobId, replayed: ctx.result.replayed },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, { visit: serializeVisit(ctx.result.visit), replayed: ctx.result.replayed }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/:jobId/visits/:visitId/cancel — CANCEL the visit
  // (planned | in_progress → cancelled; the accepted agent only; replay
  // converges; a completed visit's outcome stands).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/:jobId/visits/:visitId/cancel',
    defineMutationRoute<
      { jobId: string; visitId: string },
      { visit: VisitRecord; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => jobOwnerScope(modules, params.jobId),
      authorize: async (ctx) => {
        await requireAcceptedAgent(modules, ctx.principal, ctx.params.jobId);
        await requireVisit(modules, ctx.params.jobId, ctx.params.visitId);
      },
      validate: (ctx) =>
        validateObject<{ reason: string | undefined }>(ctx.request.body, {
          forbiddenKeys: VISIT_TRANSITION_AUTHORITY_FIELDS,
          fields: {
            reason: optionalString({ minLength: 1, maxLength: MAX_VISIT_REASON_LENGTH }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { reason: string | undefined };
        return modules.jobs.cancelVisit({
          jobId: ctx.params.jobId,
          visitId: ctx.params.visitId,
          reason: body.reason ?? '',
          actorUserId: actorUserId(ctx.principal),
          actorId: principalActorId(ctx.principal),
          provenance: visitProvenance(ctx.principal, ctx.params.jobId),
        });
      },
      emit: async (ctx) => {
        logger.info('jobs.visit.cancelled', undefined, {
          job_id: ctx.result.visit.jobId,
          visit_id: ctx.result.visit.visitId,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.visit.cancelled',
          targetType: 'visit',
          targetId: ctx.result.visit.visitId,
          afterVersion: ctx.result.visit.version,
          idempotencyKey: `jobs.visit.cancelled:${ctx.result.visit.visitId}:${ctx.result.visit.version}`,
          details: { jobId: ctx.result.visit.jobId, replayed: ctx.result.replayed },
        });
      },
      respond: (ctx) =>
        jsonResponse(200, { visit: serializeVisit(ctx.result.visit), replayed: ctx.result.replayed }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/:jobId/visits/:visitId/complete — COMPLETE the visit
  // with its STRUCTURED OUTCOME (in_progress → completed; JOB-AC-03 field
  // subset): result + follow-up declaration + notes + structured
  // observations + REQUIRED evidence reference. Provenance is
  // SERVER-DERIVED; the outcome row is append-only with the recorded
  // provenance preserved.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/:jobId/visits/:visitId/complete',
    defineMutationRoute<
      { jobId: string; visitId: string },
      { visit: VisitRecord; outcome: VisitOutcomeRecord; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => jobOwnerScope(modules, params.jobId),
      authorize: async (ctx) => {
        await requireAcceptedAgent(modules, ctx.principal, ctx.params.jobId);
        await requireVisit(modules, ctx.params.jobId, ctx.params.visitId);
      },
      validate: (ctx) =>
        validateObject<{
          result: string;
          followUpRequired: boolean | undefined;
          notes: string | undefined;
          observations: Record<string, unknown>;
          evidenceRef: string;
        }>(ctx.request.body, {
          forbiddenKeys: VISIT_OUTCOME_AUTHORITY_FIELDS,
          fields: {
            result: stringField({ pattern: VISIT_RESULT_PATTERN }),
            followUpRequired: {
              required: false,
              parse: (value, problems) => {
                if (value === undefined) return false;
                return booleanField.parse(value, problems);
              },
            },
            notes: optionalString({ minLength: 0, maxLength: MAX_VISIT_NOTES_LENGTH }),
            observations: recordField({ maxDepthKeys: 100 }),
            evidenceRef: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          result: string;
          followUpRequired: boolean | undefined;
          notes: string | undefined;
          observations: Record<string, unknown>;
          evidenceRef: string;
        };
        if (Object.keys(body.observations).length === 0) {
          throw new InvalidRequestError('Visit outcome submission failed validation', [
            'observations: must be a non-empty JSON object of structured field observations',
          ]);
        }
        return modules.jobs.completeVisit({
          jobId: ctx.params.jobId,
          visitId: ctx.params.visitId,
          result: body.result as 'succeeded' | 'partial' | 'no_contact' | 'failed',
          followUpRequired: body.followUpRequired ?? false,
          notes: body.notes ?? '',
          observations: body.observations,
          evidenceRef: body.evidenceRef,
          actorUserId: actorUserId(ctx.principal),
          actorId: principalActorId(ctx.principal),
          provenance: visitProvenance(ctx.principal, ctx.params.jobId),
        });
      },
      emit: async (ctx) => {
        const result = ctx.result;
        logger.info('jobs.visit.completed', undefined, {
          job_id: result.visit.jobId,
          visit_id: result.visit.visitId,
          result: result.outcome.result,
          evidence_ref: result.outcome.evidenceRef,
          replayed: result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.visit.completed',
          targetType: 'visit-outcome',
          targetId: result.outcome.visitOutcomeId,
          afterVersion: result.visit.version,
          idempotencyKey: `jobs.visit.completed:${result.outcome.visitOutcomeId}`,
          details: {
            visitId: result.visit.visitId,
            jobId: result.visit.jobId,
            result: result.outcome.result,
            followUpRequired: result.outcome.followUpRequired,
            evidenceRef: result.outcome.evidenceRef,
            replayed: result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          visit: serializeVisit(ctx.result.visit),
          outcome: serializeVisitOutcome(ctx.result.outcome),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:jobId/visits/:visitId/outcome — read the structured
  // outcome (full read posture). 404 while unresolved — UNKNOWN outcomes
  // stay unresolved and are never fabricated.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/:jobId/visits/:visitId/outcome',
    defineQueryRoute<{ jobId: string; visitId: string }, VisitOutcomeRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        if (!(await canReadFullJob(modules, ctx.principal, job))) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      execute: async (ctx) => {
        await requireVisit(modules, ctx.params.jobId, ctx.params.visitId);
        const outcome = await modules.jobs.getVisitOutcome(ctx.params.visitId);
        if (outcome === null) {
          throw new NotFoundError('visit-outcome', ctx.params.visitId);
        }
        return outcome;
      },
      respond: (ctx) => jsonResponse(200, serializeVisitOutcome(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/:jobId/visits/:visitId/evidence — CAPTURE one evidence
  // record from the field (EVID-AC-01..03 field subset; human-agent-v1.3
  // §5): the accepted agent appends an immutable /evidence record with a
  // SERVER-DERIVED scope (the job's Client/Workspace) and provenance
  // (recordedVia 'field-agent', causation the visit id — stamped by the
  // module). The declared class/quality/content are validated against the
  // frozen closed sets; claims stay claims — there is NO class-mutation
  // path (EVID-AC-03). The visit must be IN PROGRESS.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/:jobId/visits/:visitId/evidence',
    defineMutationRoute<{ jobId: string; visitId: string }, VisitEvidenceLinkRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => jobOwnerScope(modules, params.jobId),
      authorize: async (ctx) => {
        await requireAcceptedAgent(modules, ctx.principal, ctx.params.jobId);
        await requireVisit(modules, ctx.params.jobId, ctx.params.visitId);
      },
      validate: (ctx) =>
        validateObject<{
          class: string;
          quality: string;
          observedAt: string;
          sourceRef: string | undefined;
          content: Record<string, unknown>;
          contentRef: string | undefined;
          confidence: number | undefined;
        }>(ctx.request.body, {
          forbiddenKeys: VISIT_EVIDENCE_AUTHORITY_FIELDS,
          fields: {
            class: stringField({ pattern: EVIDENCE_CLASS_PATTERN }),
            quality: stringField({ pattern: EVIDENCE_QUALITY_PATTERN }),
            observedAt: stringField({
              pattern:
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/,
            }),
            sourceRef: optionalString({ minLength: 1, maxLength: 512 }),
            content: recordField({ maxDepthKeys: 100 }),
            contentRef: optionalString({ minLength: 1, maxLength: 512 }),
            confidence: optionalNumber({ min: 0, max: 1 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          class: string;
          quality: string;
          observedAt: string;
          sourceRef: string | undefined;
          content: Record<string, unknown>;
          contentRef: string | undefined;
          confidence: number | undefined;
        };
        if (Object.keys(body.content).length === 0) {
          throw new InvalidRequestError('Field evidence capture failed validation', [
            'content: must be a non-empty JSON object (traceable content)',
          ]);
        }
        return modules.jobs.captureVisitEvidence({
          jobId: ctx.params.jobId,
          visitId: ctx.params.visitId,
          class: body.class as EvidenceClass,
          quality: body.quality as EvidenceQualityGrade,
          observedAtIso: body.observedAt,
          sourceRef: body.sourceRef === undefined ? null : body.sourceRef,
          content: body.content,
          contentRef: body.contentRef === undefined ? null : body.contentRef,
          confidence: body.confidence === undefined ? null : body.confidence,
          actorUserId: actorUserId(ctx.principal),
          actorId: principalActorId(ctx.principal),
          provenance: visitProvenance(ctx.principal, ctx.params.jobId),
        });
      },
      emit: async (ctx) => {
        logger.info('jobs.visit.evidence.captured', undefined, {
          job_id: ctx.params.jobId,
          visit_id: ctx.result.visitId,
          evidence_id: ctx.result.evidenceId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.visit.evidence.captured',
          targetType: 'visit-evidence',
          targetId: ctx.result.evidenceId,
          idempotencyKey: `jobs.visit.evidence.captured:${ctx.result.visitId}:${ctx.result.evidenceId}`,
          details: {
            visitId: ctx.result.visitId,
            evidenceId: ctx.result.evidenceId,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeVisitEvidenceLink(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:jobId/visits/:visitId/evidence — the evidence records
  // captured through this visit (full read posture).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/:jobId/visits/:visitId/evidence',
    defineQueryRoute<{ jobId: string; visitId: string }, readonly VisitEvidenceLinkRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        if (!(await canReadFullJob(modules, ctx.principal, job))) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      execute: async (ctx) => {
        await requireVisit(modules, ctx.params.jobId, ctx.params.visitId);
        return modules.jobs.listVisitEvidence(ctx.params.visitId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          visitId: ctx.params.visitId,
          evidence: ctx.result.map(serializeVisitEvidenceLink),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:jobId/visits/:visitId/continuity — the DERIVED
  // relationship chain (JOB-AC-04): the prior COMPLETED visits of the
  // SAME relationship (agency + client + target identity), oldest first.
  // DERIVED data — history is never rewritten. SUBJECT TO POLICY for the
  // ACCEPTED AGENT: the chain is exposed to the executing agent only when
  // the policy checkpoint (visitContinuityExposedToAgent over the agent's
  // frozen /field-agents profile relationship-continuity block) passes —
  // otherwise the agent's view is the gated marker with NO prior-visit
  // data (fail closed). The commissioning side (client-scope member |
  // platform admin | service) always sees the full chain.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/:jobId/visits/:visitId/continuity',
    defineQueryRoute<{ jobId: string; visitId: string }, Record<string, unknown>>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        if (!(await canReadFullJob(modules, ctx.principal, job))) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      execute: async (ctx) => {
        await requireVisit(modules, ctx.params.jobId, ctx.params.visitId);
        const view = await requireContinuity(modules, ctx.params.visitId);
        const job = await requireJob(modules, ctx.params.jobId);

        // The POLICY CHECKPOINT (JOB-AC-04 "subject to policy"): for the
        // ACCEPTED AGENT the chain is exposed only when the agent's frozen
        // profile relationship-continuity policy opts in; the
        // commissioning side (and platform/service) reads the full chain.
        const isAcceptedAgent =
          ctx.principal.kind === 'user' && ctx.principal.userId === job.acceptedUserId;
        if (isAcceptedAgent && !visitContinuityExposedToAgent(view.agentContinuityPolicy)) {
          return {
            visitId: view.visit.visitId,
            relationship: view.relationship,
            gated: true,
            gatedReason:
              'relationship continuity is not exposed to this agent under the current continuity policy',
            priorVisits: [] as unknown[],
          };
        }
        return {
          visitId: view.visit.visitId,
          relationship: view.relationship,
          gated: false,
          priorVisits: view.priorVisits.map((entry) => serializeContinuityEntry(entry)),
        };
      },
      respond: (ctx) => jsonResponse(200, ctx.result),
    }),
  );
}
