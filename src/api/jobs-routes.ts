/**
 * /jobs API routes (MKT-026 — the Job marketplace boundary: JOB-001,
 * JOB-AC-01..03 + the v1.3 matrix override HUMAN-AC-02..03).
 *
 *   POST   /api/workflows/:workflowId/instances/:instanceId/jobs   project a governed human Task into a Job (agency owner/admin; scope server-derived from the instance)
 *   GET    /api/jobs/marketplace                                  eligibility-gated job DESCRIPTORS for the caller's Human Agent profile (§3 — no Client data)
 *   GET    /api/jobs/offers                                       the caller's OWN offers (candidate view)
 *   GET    /api/jobs/:jobId                                       read one job (commissioning member | accepted agent — the authorized Job scope)
 *   GET    /api/jobs/:jobId/offers                                list a job's offers (commissioning member)
 *   POST   /api/jobs/:jobId/offers                                create a candidate-specific offer (agency owner/admin; eligibility evaluated BEFORE exposure)
 *   POST   /api/jobs/:jobId/offers/:offerId/accept                the concurrency-safe acceptance claim (the offer's candidate ONLY)
 *   POST   /api/jobs/:jobId/offers/:offerId/decline               decline (the offer's candidate ONLY; never affects the Task)
 *   POST   /api/jobs/:jobId/outcome                               submit the outcome (the ACCEPTED agent ONLY; provenance server-derived)
 *   GET    /api/jobs/:jobId/outcome                               read the submitted outcome (commissioning member | accepted agent)
 *
 * Authority composition (the frozen boundary, AGENTS.md + the dependency
 * matrix /jobs ──→ /workflows, /executions, /field-agents, /clients,
 * /evidence, /policies — /agencies is NOT a module dependency, so agency
 * membership/role authorization is composed HERE exactly like
 * MKT-003/004/005/025 — requireClientAccess/resolveContext, never a
 * second permission engine):
 *
 *   - the Task reference comes from the PATH (instance + workflow parent)
 *     and is resolved through the /workflows public contract BEFORE any
 *     authorization decision that depends on tenant scope — a caller-
 *     supplied workflowInstanceId in the body is an authority field
 *     (rejected); the job scope is server-derived from the instance;
 *   - Job access follows human-agent-v1.3.md §3: the marketplace listing
 *     returns DESCRIPTORS ONLY (title, description and the profile-only
 *     eligibility requirements) to ELIGIBLE agents — evaluated through the
 *     merged /field-agents contract BEFORE any Client-specific detail is
 *     exposed; the candidate offer view carries the same descriptor + the
 *     offer terms; Client scope becomes visible only to the ACCEPTED
 *     agent (the current authorized Job scope, HUMAN-AC-03) and to the
 *     commissioning agency's members (client-scope access);
 *   - acceptance/decline/outcome are the CANDIDATE'S OWN claims: a
 *     foreign offer (or a job the caller did not win) is a UNIFORM 404 —
 *     indistinguishable from an unknown identifier (no existence oracle);
 *     the commissioning side can never claim or decline on an agent's
 *     behalf and can never fabricate an outcome actor;
 *   - outcome provenance is SERVER-DERIVED (actor from the authenticated
 *     principal, correlation from the ambient context, recording surface
 *     'api', causation the job id) — every provenance-shaped DTO field is
 *     rejected at validation time (JOB-AC-03);
 *   - the routes never mutate workflow state: no route here calls the
 *     /workflows instance transition port (Jobs report; the workflow
 *     authority owns workflow state — the module's read-only consumption
 *     is asserted by tests/architecture/jobs-boundary.test.ts).
 *
 * Literal segments (marketplace, offers) are registered BEFORE the
 * :jobId-parameterized routes so the router's first-match-wins resolution
 * cannot shadow them.
 */

import { ForbiddenError, InvalidRequestError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  intField,
  objectField,
  optionalArrayField,
  optionalString,
  stringField,
  validateObject,
  type FieldSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import { requireClientAccess, resolveContext } from './authorize.ts';
import type {
  HumanSpecialization,
  Territory,
} from '../modules/field-agents/public.ts';
import type {
  JobOfferRecord,
  JobOutcomeRecord,
  JobRecord,
} from '../modules/jobs/public.ts';

// ---------------------------------------------------------------------------
// Frozen vocabulary patterns (mirror the module public registries + the
// /field-agents frozen registries; the architecture test fails if the DB
// CHECK / code registry / route pattern ever drift).
// ---------------------------------------------------------------------------

const SPECIALIZATION_PATTERN =
  /^(field_agent|chatter|creator_manager|content_manager|growth_manager|account_manager|reviewer|sales_agent)$/;
const TERRITORY_KIND_PATTERN = /^(country|region|city|postal_area)$/;
const SKILL_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;
const TERRITORY_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ,.-]{0,99}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * §23 authority-field rejection: every field the server derives — job
 * identity, scope, task reference (path-derived), status, acceptance
 * claim, provenance, bookkeeping — plus the agency/client linkage keys
 * (scope is ALWAYS server-derived from the Task's instance, never a
 * request field).
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

const JOB_PROJECTION_AUTHORITY_FIELDS = [
  'jobId',
  'workflowInstanceId',
  'status',
  'acceptedAgentId',
  'acceptedUserId',
  'acceptedOfferId',
  'acceptedAt',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'outcome',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  ...TENANT_AND_LINKAGE_FIELDS,
] as const;

const OFFER_CREATE_AUTHORITY_FIELDS = [
  'offerId',
  'jobId',
  'candidateUserId',
  'status',
  'terminalReason',
  'acceptedAt',
  'expiresAtIso',
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

const OFFER_CLAIM_AUTHORITY_FIELDS = [
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

const OUTCOME_SUBMIT_AUTHORITY_FIELDS = [
  'jobOutcomeId',
  'jobId',
  'reportedInstanceStatus',
  'instanceStatus',
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

// ---------------------------------------------------------------------------
// Field specs (strict DTO shapes)
// ---------------------------------------------------------------------------

const territoryObjectField = objectField<{ kind: string; value: string }>({
  forbiddenKeys: [],
  fields: {
    kind: stringField({ pattern: TERRITORY_KIND_PATTERN }),
    value: stringField({ minLength: 1, maxLength: 100, pattern: TERRITORY_VALUE_PATTERN }),
  },
});

/** Nullable territory: absent/null (no territory requirement) or a strict object. */
const nullableTerritoryField: FieldSpec<{ kind: string; value: string } | null> = {
  required: false,
  parse: (value, problems) => {
    if (value === undefined || value === null) return null;
    return territoryObjectField.parse(value, problems);
  },
};

// ---------------------------------------------------------------------------
// Serialization — two postures (human-agent-v1.3.md §3):
//   1. the DESCRIPTOR (marketplace/candidate view): NO Client, Agency,
//      Workspace or Task identifiers — the minimum data required;
//   2. the FULL record (commissioning member | accepted agent): the
//      governed scope, because the commissioning side owns it and the
//      accepted agent holds the current authorized Job scope.
// Exported for the MKT-031 work-queue surface (jobs-queue-routes.ts): the
// queue composes the SAME serializers so its responses are byte-identical
// to the direct surface's — one /jobs authority, one response vocabulary.
// ---------------------------------------------------------------------------

export function serializeDescriptor(job: JobRecord): Record<string, unknown> {
  return {
    jobId: job.jobId,
    title: job.title,
    description: job.description,
    eligibility: {
      specialization: job.eligibility.specialization,
      requiredCapabilities: [...job.eligibility.requiredCapabilities],
      ...(job.eligibility.territory === null
        ? {}
        : { territory: serializeTerritory(job.eligibility.territory) }),
      availability: {
        dayOfWeek: job.eligibility.availability.dayOfWeek,
        startMinute: job.eligibility.availability.startMinute,
        endMinute: job.eligibility.availability.endMinute,
      },
    },
    status: job.status,
    createdAt: job.createdAt,
  };
}

function serializeTerritory(territory: { kind: string; value: string }): Record<string, unknown> {
  return { kind: territory.kind, value: territory.value };
}

export function serializeJob(job: JobRecord): Record<string, unknown> {
  return {
    jobId: job.jobId,
    workflowInstanceId: job.workflowInstanceId,
    nodeId: job.nodeId,
    workspaceId: job.workspaceId,
    clientId: job.clientId,
    agencyId: job.agencyId,
    title: job.title,
    description: job.description,
    eligibility: {
      specialization: job.eligibility.specialization,
      requiredCapabilities: [...job.eligibility.requiredCapabilities],
      ...(job.eligibility.territory === null
        ? {}
        : { territory: serializeTerritory(job.eligibility.territory) }),
      availability: {
        dayOfWeek: job.eligibility.availability.dayOfWeek,
        startMinute: job.eligibility.availability.startMinute,
        endMinute: job.eligibility.availability.endMinute,
      },
    },
    status: job.status,
    ...(job.acceptedAgentId === null
      ? {}
      : {
          accepted: {
            agentId: job.acceptedAgentId,
            userId: job.acceptedUserId,
            offerId: job.acceptedOfferId,
            at: job.acceptedAt,
          },
        }),
    ...(job.createdBy === null ? {} : { createdBy: job.createdBy }),
    version: job.version,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/** The commissioning-side offer view (candidate identity included; shared by the MKT-031 queue claim responses). */
export function serializeOfferForCommissioning(offer: JobOfferRecord): Record<string, unknown> {
  return {
    offerId: offer.jobOfferId,
    jobId: offer.jobId,
    candidateAgentId: offer.candidateAgentId,
    candidateUserId: offer.candidateUserId,
    status: offer.status,
    ...(offer.terminalReason === null ? {} : { terminalReason: offer.terminalReason }),
    expiresAt: offer.expiresAt,
    ...(offer.acceptedAt === null ? {} : { acceptedAt: offer.acceptedAt }),
    ...(offer.createdBy === null ? {} : { createdBy: offer.createdBy }),
    version: offer.version,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  };
}

/** The candidate-side offer view: offer terms + the job DESCRIPTOR only. */
export function serializeOfferForCandidate(
  offer: JobOfferRecord,
  job: JobRecord,
): Record<string, unknown> {
  return {
    offerId: offer.jobOfferId,
    job: serializeDescriptor(job),
    status: offer.status,
    ...(offer.terminalReason === null ? {} : { terminalReason: offer.terminalReason }),
    expiresAt: offer.expiresAt,
    ...(offer.acceptedAt === null ? {} : { acceptedAt: offer.acceptedAt }),
    createdAt: offer.createdAt,
  };
}

function serializeOutcome(outcome: JobOutcomeRecord): Record<string, unknown> {
  return {
    jobOutcomeId: outcome.jobOutcomeId,
    jobId: outcome.jobId,
    outcome: outcome.outcome,
    ...(outcome.payloadRef === null ? {} : { payloadRef: outcome.payloadRef }),
    evidenceRef: outcome.evidenceRef,
    reportedInstanceStatus: outcome.reportedInstanceStatus,
    provenance: {
      recordedActor: outcome.provenance.actor,
      recordedVia: outcome.provenance.recordedVia,
      correlationId: outcome.provenance.correlationId,
      ...(outcome.provenance.causationId === null
        ? {}
        : { causationId: outcome.provenance.causationId }),
      ...(outcome.provenance.submittedBy === null
        ? {}
        : { submittedBy: outcome.provenance.submittedBy }),
      submittedAt: outcome.provenance.submittedAt,
    },
    createdAt: outcome.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Authorization composition (server-derived ownership; §3 access postures)
// ---------------------------------------------------------------------------

/** The job row, or the uniform 404 (malformed identifiers included). */
export async function requireJob(modules: ApplicationModules, jobId: string): Promise<JobRecord> {
  if (!UUID_PATTERN.test(jobId)) {
    throw new NotFoundError('job', jobId);
  }
  const job = await modules.jobs.getJob(jobId);
  if (job === null) {
    throw new NotFoundError('job', jobId);
  }
  return job;
}

/** The offer (nested under its job), or the uniform 404. */
async function requireOffer(
  modules: ApplicationModules,
  jobId: string,
  offerId: string,
): Promise<JobOfferRecord> {
  if (!UUID_PATTERN.test(offerId)) {
    throw new NotFoundError('job-offer', offerId);
  }
  const offer = await modules.jobs.getOffer(jobId, offerId);
  if (offer === null) {
    throw new NotFoundError('job-offer', offerId);
  }
  return offer;
}

/** Job-scoped owner scope (the audit event target's tenant scope). */
export async function jobOwnerScope(modules: ApplicationModules, jobId: string): Promise<OwnerScope> {
  const job = await requireJob(modules, jobId);
  return { kind: 'client', agencyId: job.agencyId, clientId: job.clientId };
}

/**
 * Read authorization for the FULL job record:
 *   - the internal service principal (server-side composition callers);
 *   - platform administrators;
 *   - any ACTIVE member of the commissioning agency (client-scope access —
 *     a non-member gets the uniform 404, exactly like requireClientAccess);
 *   - the ACCEPTED agent (the current authorized Job scope — HUMAN-AC-03).
 * Everyone else: uniform 404 (no existence oracle).
 */
export async function canReadFullJob(
  modules: ApplicationModules,
  principal: Principal,
  job: JobRecord,
): Promise<boolean> {
  if (principal.kind === 'service') return true;
  if (principal.kind !== 'user') return false;
  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') return false;
  if (context.platformRoles.includes('platform_administrator')) return true;
  if (principal.userId === job.acceptedUserId) return true;
  try {
    await requireClientAccess(modules, principal, job.clientId);
    return true;
  } catch {
    // Unknown client (deleted tombstone) or no membership — the uniform
    // 404 posture; re-surfaced by the caller as NotFoundError.
    return false;
  }
}

/**
 * Agent-surface authorization: the caller must be an ACTIVE user identity
 * holding a Human Agent profile (resolved through the merged /field-agents
 * authority). Returns the profile's agent id (null when absent — the
 * caller throws the 403: the agent surface requires the agent identity).
 * Exported for the MKT-031 work-queue surface (jobs-queue-routes.ts): the
 * queue composes the SAME agent posture as the marketplace (one /jobs
 * authorization surface, never a second permission engine).
 */
export async function activeAgentIdFor(
  modules: ApplicationModules,
  principal: Principal,
): Promise<string | null> {
  if (principal.kind !== 'user') return null;
  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') return null;
  const profile = await modules.fieldAgents.getHumanAgentByUser(principal.userId);
  return profile === null ? null : profile.agentId;
}

/**
 * SERVER-DERIVED outcome provenance (JOB-AC-03): actor from the
 * authenticated principal, correlation from the ambient correlation
 * context, recording surface 'api', causation the job id. No value in
 * here is reachable from the request body (the DTO rejects every
 * provenance-shaped key).
 */
function outcomeProvenance(principal: Principal, jobId: string) {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: jobId,
  };
}

export function actorUserId(principal: Principal): string {
  if (principal.kind !== 'user') {
    throw new ForbiddenError('This operation requires a user identity');
  }
  return principal.userId;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerJobsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('jobs.api');

  // Literal agent-surface routes FIRST (the router resolves first-match:
  // /api/jobs/marketplace and /api/jobs/offers must not be captured by the
  // later /api/jobs/:jobId patterns).

  // -------------------------------------------------------------------------
  // GET /api/jobs/marketplace — the ELIGIBILITY-GATED listing (§3, FIELD-AC-02
  // posture at the jobs boundary): job DESCRIPTORS for jobs whose round is
  // open, filtered by the merged /field-agents PROFILE-ONLY matcher BEFORE
  // any Client-specific detail is exposed. The response structurally
  // carries NO clientId/agencyId/workspaceId/task identifiers — the
  // eligible agent sees only the minimum data required (HUMAN-AC-03
  // fail-closed at the boundary, not by redaction).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/marketplace',
    defineQueryRoute<Record<string, string>, readonly JobRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const agentId = await activeAgentIdFor(modules, ctx.principal);
        if (agentId === null) {
          throw new ForbiddenError(
            'The job marketplace requires an active user identity with a Human Agent profile',
          );
        }
      },
      execute: async (ctx) => {
        const agentId = await activeAgentIdFor(modules, ctx.principal);
        if (agentId === null) {
          throw new ForbiddenError(
            'The job marketplace requires an active user identity with a Human Agent profile',
          );
        }
        return modules.jobs.listMarketplaceJobs(agentId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          matched: ctx.result.length,
          jobs: ctx.result.map(serializeDescriptor),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/offers — the CALLER'S OWN offers (candidate view: offer
  // terms + job descriptor only — no Client data). Offers addressed to
  // other candidates are not visible on this surface at all.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/offers',
    defineQueryRoute<
      Record<string, string>,
      ReadonlyArray<{ offer: JobOfferRecord; job: JobRecord | null }>
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind !== 'user') {
          throw new ForbiddenError('The offers surface requires a user identity');
        }
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      execute: async (ctx) => {
        if (ctx.principal.kind !== 'user') {
          throw new ForbiddenError('The offers surface requires a user identity');
        }
        const offers = await modules.jobs.listOffersForCandidate(ctx.principal.userId);
        // Attach the job descriptor for the candidate's decision surface.
        const jobs = new Map<string, JobRecord>();
        for (const offer of offers) {
          if (!jobs.has(offer.jobId)) {
            const job = await modules.jobs.getJob(offer.jobId);
            if (job !== null) jobs.set(offer.jobId, job);
          }
        }
        return offers.map((offer) => ({
          offer,
          job: jobs.get(offer.jobId) ?? null,
        }));
      },
      respond: (ctx) => {
        const entries = ctx.result;
        return jsonResponse(200, {
          offers: entries.map((entry) =>
            entry.job === null
              ? {
                  offerId: entry.offer.jobOfferId,
                  jobId: entry.offer.jobId,
                  status: entry.offer.status,
                  expiresAt: entry.offer.expiresAt,
                  createdAt: entry.offer.createdAt,
                }
              : serializeOfferForCandidate(entry.offer, entry.job),
          ),
        });
      },
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/workflows/:workflowId/instances/:instanceId/jobs — project a
  // governed human Task into a Job (JOB-AC-01). The Task reference comes
  // from the PATH and is resolved through the /workflows public contract
  // before any write; the job's scope chain is SERVER-DERIVED from the
  // instance (a body workflowInstanceId is an authority field). Agency
  // owner/admin only (the workflow-lifecycle mutation posture of
  // MKT-009's routes).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/workflows/:workflowId/instances/:instanceId/jobs',
    defineMutationRoute<{ workflowId: string; instanceId: string }, JobRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        // Resolve the instance from durable state BEFORE anything else; an
        // instance of a DIFFERENT workflow is a uniform 404 (the parent
        // path is part of the identity, exactly like the instance routes).
        if (!UUID_PATTERN.test(params.instanceId)) {
          throw new NotFoundError('workflow instance', params.instanceId);
        }
        const instance = await modules.workflows.getWorkflowInstance(params.instanceId);
        if (instance === null || instance.workflowId !== params.workflowId) {
          throw new NotFoundError('workflow instance', params.instanceId);
        }
        return { kind: 'client', agencyId: instance.agencyId, clientId: instance.clientId };
      },
      authorize: async (ctx) => {
        const instance = await modules.workflows.getWorkflowInstance(ctx.params.instanceId);
        if (instance === null || instance.workflowId !== ctx.params.workflowId) {
          throw new NotFoundError('workflow instance', ctx.params.instanceId);
        }
        await requireClientAccess(modules, ctx.principal, instance.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{
          nodeId: string;
          title: string;
          description: string;
          specialization: string;
          requiredCapabilities: ReadonlyArray<string> | undefined;
          territory: { kind: string; value: string } | null;
          dayOfWeek: number;
          startMinute: number;
          endMinute: number;
        }>(ctx.request.body, {
          forbiddenKeys: JOB_PROJECTION_AUTHORITY_FIELDS,
          fields: {
            nodeId: stringField({ minLength: 1, maxLength: 200 }),
            title: stringField({ minLength: 1, maxLength: 200 }),
            description: stringField({ minLength: 0, maxLength: 2000 }),
            specialization: stringField({ pattern: SPECIALIZATION_PATTERN }),
            requiredCapabilities: optionalArrayField({
              minItems: 0,
              maxItems: 50,
              item: stringField({ minLength: 2, maxLength: 49, pattern: SKILL_PATTERN }),
            }),
            territory: nullableTerritoryField,
            dayOfWeek: intField({ min: 0, max: 6 }),
            startMinute: intField({ min: 0, max: 1439 }),
            endMinute: intField({ min: 1, max: 1440 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          nodeId: string;
          title: string;
          description: string;
          specialization: string;
          requiredCapabilities: ReadonlyArray<string> | undefined;
          territory: { kind: string; value: string } | null;
          dayOfWeek: number;
          startMinute: number;
          endMinute: number;
        };
        if (body.startMinute >= body.endMinute) {
          throw new InvalidRequestError('Job projection failed validation', [
            'endMinute: must be after startMinute',
          ]);
        }
        return modules.jobs.projectJob({
          workflowInstanceId: ctx.params.instanceId,
          nodeId: body.nodeId,
          descriptor: {
            title: body.title,
            description: body.description,
            eligibility: {
              specialization: body.specialization as HumanSpecialization,
              requiredCapabilities: body.requiredCapabilities ?? [],
              territory:
                body.territory == null
                  ? null
                  : { kind: body.territory.kind as Territory['kind'], value: body.territory.value },
              availability: {
                dayOfWeek: body.dayOfWeek,
                startMinute: body.startMinute,
                endMinute: body.endMinute,
              },
            },
          },
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('jobs.task.projected', undefined, {
          job_id: ctx.result.jobId,
          workflow_instance_id: ctx.result.workflowInstanceId,
          node_id: ctx.result.nodeId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.task.projected',
          targetType: 'job',
          targetId: ctx.result.jobId,
          afterVersion: ctx.result.version,
          idempotencyKey: `jobs.task.projected:${ctx.result.jobId}`,
          details: {
            workflowInstanceId: ctx.result.workflowInstanceId,
            nodeId: ctx.result.nodeId,
            title: ctx.result.title,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeJob(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:jobId — read one job. Full record for the commissioning
  // member / platform admin / service / the ACCEPTED agent (the current
  // authorized Job scope); everyone else gets the UNIFORM 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/:jobId',
    defineQueryRoute<{ jobId: string }, JobRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        if (!(await canReadFullJob(modules, ctx.principal, job))) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      execute: async (ctx) => requireJob(modules, ctx.params.jobId),
      respond: (ctx) => jsonResponse(200, serializeJob(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:jobId/offers — the job's offers (commissioning member
  // view: candidate identity included; terminal history visible).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/:jobId/offers',
    defineQueryRoute<{ jobId: string }, readonly JobOfferRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        // The accepted agent also sees the round's offers (their own claim
        // context); everyone else needs the commissioning side.
        if (!(await canReadFullJob(modules, ctx.principal, job))) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      execute: async (ctx) => modules.jobs.listOffersForJob(ctx.params.jobId),
      respond: (ctx) =>
        jsonResponse(200, {
          jobId: ctx.params.jobId,
          offers: ctx.result.map(serializeOfferForCommissioning),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/:jobId/offers — create ONE candidate-specific Offer
  // (job-offer-v1.2). Agency owner/admin (commissioning posture). The
  // candidate Human Agent profile is resolved through the merged
  // /field-agents authority and ELIGIBILITY IS EVALUATED BEFORE the offer
  // (hence before any Client data) is exposed. One OPEN offer per
  // candidate is DB-fenced; the expiry is a bounded future timestamp.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/:jobId/offers',
    defineMutationRoute<{ jobId: string }, JobOfferRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => jobOwnerScope(modules, params.jobId),
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        await requireClientAccess(modules, ctx.principal, job.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ candidateAgentId: string; expiresAt: string }>(ctx.request.body, {
          forbiddenKeys: OFFER_CREATE_AUTHORITY_FIELDS,
          fields: {
            candidateAgentId: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
            expiresAt: stringField({ pattern: ISO_TIMESTAMP_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { candidateAgentId: string; expiresAt: string };
        return modules.jobs.createOffer({
          jobId: ctx.params.jobId,
          candidateAgentId: body.candidateAgentId,
          expiresAtIso: body.expiresAt,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('jobs.offer.created', undefined, {
          job_id: ctx.result.jobId,
          job_offer_id: ctx.result.jobOfferId,
          candidate_agent_id: ctx.result.candidateAgentId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.offer.created',
          targetType: 'job-offer',
          targetId: ctx.result.jobOfferId,
          afterVersion: ctx.result.version,
          idempotencyKey: `jobs.offer.created:${ctx.result.jobOfferId}`,
          details: {
            jobId: ctx.result.jobId,
            candidateAgentId: ctx.result.candidateAgentId,
            expiresAt: ctx.result.expiresAt,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeOfferForCommissioning(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/:jobId/offers/:offerId/accept — the CONCURRENCY-SAFE
  // ACCEPTANCE CLAIM (JOB-AC-02): the offer's candidate ONLY (a foreign
  // offer is the uniform 404 — no existence oracle). Repeated acceptance
  // of the SAME offer by the SAME agent converges idempotently; a
  // different agent's accept after the job has been claimed is a clean
  // 409 — never a partial state. The commissioning side can NEVER claim
  // on an agent's behalf (the service principal is not a candidate).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/:jobId/offers/:offerId/accept',
    defineMutationRoute<{ jobId: string; offerId: string }, { job: JobRecord; offer: JobOfferRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => jobOwnerScope(modules, params.jobId),
      authorize: async (ctx) => {
        await requireOffer(modules, ctx.params.jobId, ctx.params.offerId);
        // The claim requires the CANDIDATE'S OWN active user identity —
        // resolved server-side, never from the body.
        const userId = actorUserId(ctx.principal);
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
        const offer = await modules.jobs.getOffer(ctx.params.jobId, ctx.params.offerId);
        if (offer !== null && offer.candidateUserId !== userId) {
          // Uniform 404: the offer is not addressed to this caller —
          // indistinguishable from an unknown identifier.
          throw new NotFoundError('job-offer', ctx.params.offerId);
        }
      },
      validate: (ctx) =>
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: OFFER_CLAIM_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) =>
        modules.jobs.acceptOffer({
          jobId: ctx.params.jobId,
          offerId: ctx.params.offerId,
          actorUserId: actorUserId(ctx.principal),
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        }),
      emit: async (ctx) => {
        logger.info('jobs.offer.accepted', undefined, {
          job_id: ctx.result.job.jobId,
          job_offer_id: ctx.result.offer.jobOfferId,
          replayed: ctx.result.replayed,
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
          },
        });
      },
      respond: (ctx) => {
        const result = ctx.result;
        // The winner's read surface: the full job record (the authorized
        // scope opens with acceptance — HUMAN-AC-03) + the offer state.
        return jsonResponse(200, {
          job: serializeJob(result.job),
          offer: serializeOfferForCommissioning(result.offer),
          replayed: result.replayed,
        });
      },
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/:jobId/offers/:offerId/decline — the candidate's
  // per-offer decline right (never affects the underlying Task; repeated
  // decline converges idempotently — JOB-AC-02). The offer's candidate
  // ONLY; an accepted offer cannot be declined (the claim stands).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/:jobId/offers/:offerId/decline',
    defineMutationRoute<{ jobId: string; offerId: string }, { job: JobRecord; offer: JobOfferRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => jobOwnerScope(modules, params.jobId),
      authorize: async (ctx) => {
        await requireOffer(modules, ctx.params.jobId, ctx.params.offerId);
        const userId = actorUserId(ctx.principal);
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
        const offer = await modules.jobs.getOffer(ctx.params.jobId, ctx.params.offerId);
        if (offer !== null && offer.candidateUserId !== userId) {
          throw new NotFoundError('job-offer', ctx.params.offerId);
        }
      },
      validate: (ctx) =>
        validateObject<Record<string, never>>(ctx.request.body, {
          forbiddenKeys: OFFER_CLAIM_AUTHORITY_FIELDS,
          fields: {},
        }),
      execute: async (ctx) =>
        modules.jobs.declineOffer({
          jobId: ctx.params.jobId,
          offerId: ctx.params.offerId,
          actorUserId: actorUserId(ctx.principal),
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        }),
      emit: async (ctx) => {
        const result = ctx.result;
        logger.info('jobs.offer.declined', undefined, {
          job_id: result.job.jobId,
          job_offer_id: result.offer.jobOfferId,
          replayed: result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.offer.declined',
          targetType: 'job-offer',
          targetId: result.offer.jobOfferId,
          afterVersion: result.offer.version,
          idempotencyKey: `jobs.offer.declined:${result.offer.jobOfferId}:${result.offer.version}`,
          details: { jobId: result.job.jobId, replayed: result.replayed },
        });
      },
      respond: (ctx) => {
        const result = ctx.result;
        return jsonResponse(200, {
          job: serializeJob(result.job),
          offer: serializeOfferForCommissioning(result.offer),
          replayed: result.replayed,
        });
      },
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/jobs/:jobId/outcome — SUBMIT THE OUTCOME (JOB-AC-03): the
  // ACCEPTED agent reports succeeded|failed + optional payload reference +
  // REQUIRED evidence reference. Actor + provenance are SERVER-DERIVED
  // (every provenance-shaped DTO field rejected here); the module
  // preserves them on the append-only outcome row. Jobs never own
  // workflow state — this route records the REPORT; the workflow
  // authority decides what to do with it.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/jobs/:jobId/outcome',
    defineMutationRoute<{ jobId: string }, { job: JobRecord; outcome: JobOutcomeRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => jobOwnerScope(modules, params.jobId),
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        const userId = actorUserId(ctx.principal);
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
        // Only the ACCEPTED agent reports (uniform 404 otherwise — no
        // oracle; the commissioning side cannot fabricate an outcome actor).
        if (job.acceptedUserId !== userId) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      validate: (ctx) =>
        validateObject<{
          outcome: string;
          payloadRef: string | undefined;
          evidenceRef: string;
        }>(ctx.request.body, {
          forbiddenKeys: OUTCOME_SUBMIT_AUTHORITY_FIELDS,
          fields: {
            outcome: stringField({ pattern: /^(succeeded|failed)$/ }),
            payloadRef: optionalString({ minLength: 1, maxLength: 500 }),
            evidenceRef: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          outcome: string;
          payloadRef: string | undefined;
          evidenceRef: string;
        };
        return modules.jobs.submitOutcome({
          jobId: ctx.params.jobId,
          outcome: body.outcome as 'succeeded' | 'failed',
          payloadRef: body.payloadRef === undefined ? null : body.payloadRef,
          evidenceRef: body.evidenceRef,
          actorUserId: actorUserId(ctx.principal),
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          provenance: outcomeProvenance(ctx.principal, ctx.params.jobId),
        });
      },
      emit: async (ctx) => {
        const result = ctx.result;
        logger.info('jobs.outcome.submitted', undefined, {
          job_id: result.job.jobId,
          outcome: result.outcome.outcome,
          evidence_ref: result.outcome.evidenceRef,
          replayed: result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'jobs.outcome.submitted',
          targetType: 'job-outcome',
          targetId: result.outcome.jobOutcomeId,
          afterVersion: result.job.version,
          idempotencyKey: `jobs.outcome.submitted:${result.outcome.jobOutcomeId}`,
          details: {
            jobId: result.job.jobId,
            outcome: result.outcome.outcome,
            evidenceRef: result.outcome.evidenceRef,
            replayed: result.replayed,
          },
        });
      },
      respond: (ctx) => {
        const result = ctx.result;
        return jsonResponse(result.replayed ? 200 : 201, {
          job: serializeJob(result.job),
          outcome: serializeOutcome(result.outcome),
          replayed: result.replayed,
        });
      },
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/jobs/:jobId/outcome — read the submitted outcome (the
  // provenance record): commissioning member | accepted agent (the full-job
  // read posture). 404 while unresolved — UNKNOWN outcomes stay unresolved
  // and are never fabricated.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/jobs/:jobId/outcome',
    defineQueryRoute<{ jobId: string }, JobOutcomeRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const job = await requireJob(modules, ctx.params.jobId);
        if (!(await canReadFullJob(modules, ctx.principal, job))) {
          throw new NotFoundError('job', ctx.params.jobId);
        }
      },
      execute: async (ctx) => {
        const outcome = await modules.jobs.getJobOutcome(ctx.params.jobId);
        if (outcome === null) {
          throw new NotFoundError('job-outcome', ctx.params.jobId);
        }
        return outcome;
      },
      respond: (ctx) => jsonResponse(200, serializeOutcome(ctx.result)),
    }),
  );
}
