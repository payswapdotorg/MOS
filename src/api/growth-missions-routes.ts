/**
 * /api/growth-missions/* routes (MKT-053 — Growth Mission and Objective
 * Model: the durable mission record surface).
 *
 *   POST /api/agencies/:agencyId/growth-missions                              create (owner|admin|platform admin)
 *   GET  /api/agencies/:agencyId/growth-missions                              the agency's missions, ALL lifecycle states (any active member)
 *   GET  /api/growth-missions/:missionId                                     the composed honest read-back (record + current declaration + goal mappings with live goal status + full history) (any active member of the owning agency)
 *   GET  /api/growth-missions/:missionId/versions                             the append-only version tail (any active member)
 *   GET  /api/growth-missions/:missionId/history                             the append-only history tail (any active member)
 *   POST /api/growth-missions/:missionId/versions                            record a NEW declared version — the objective correction path (owner|admin; CAS)
 *   POST /api/growth-missions/:missionId/status                              lifecycle transition through the frozen state machine (owner|admin; CAS; REQUIRED reason)
 *   POST /api/growth-missions/:missionId/goal-mappings                        map an EXISTING goal (owner|admin)
 *   POST /api/growth-missions/:missionId/goal-mappings/:goalId/removal        remove a goal mapping HONESTLY (owner|admin; REQUIRED reason)
 *
 * SURFACE DISCIPLINE (the dispatch boundary battery): GET/POST ONLY — no
 * PUT, no PATCH, no DELETE (asserted by
 * tests/architecture/growth-missions-boundary.test.ts). The declared
 * objective is never rewritten in place: corrections are NEW version
 * records (POST .../versions); goal removal is a recorded removal, never
 * a DELETE. NO controller/scheduler/execution verb exists anywhere in
 * this family — MKT-054 (the Growth Operator) is a later Work Item and
 * will compose the module commands server-side, never this surface.
 *
 * Server-derived scope posture (implementation-contract §3/§23; the
 * app-metering precedent): every surface resolves the caller's
 * authorization context and the canonical scope from durable state BEFORE
 * the module call; the path identifiers only SELECT which durable scope
 * gets resolved (a caller-supplied identifier is never an authorization).
 * Uniform 404 for foreign/unknown/malformed agency/mission/goal
 * identifiers (no existence oracle — foreign ≡ unknown ≡ malformed); a
 * suspended membership or disabled identity is the 403; anonymous calls
 * fail closed 401 at the authenticator. Provenance is SERVER-DERIVED from
 * the authenticated principal + the ambient correlation context (never a
 * request field; the DTOs reject every provenance-shaped key).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
} from '../platform/http/pipeline.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  intField,
  numberField,
  objectField,
  optionalArrayField,
  optionalString,
  stringField,
  validateObject,
  type FieldSpec,
  type ObjectSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import { resolveContext } from './authorize.ts';
import type {
  GrowthMissionDetail,
  GrowthMissionEventRecord,
  GrowthMissionGoalView,
  GrowthMissionProvenance,
  GrowthMissionRecord,
  GrowthMissionTargetMetric,
  GrowthMissionVersionRecord,
} from '../modules/growth-missions/public.ts';
import {
  GROWTH_MISSION_OBJECTIVE_FAMILIES,
  GROWTH_MISSION_STATUSES,
  GROWTH_MISSION_VOCABULARY_VERSION,
} from '../modules/growth-missions/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAMILY_PATTERN = new RegExp(`^(${GROWTH_MISSION_OBJECTIVE_FAMILIES.join('|')})$`);
const STATUS_PATTERN = new RegExp(`^(${GROWTH_MISSION_STATUSES.join('|')})$`);
const COMPARATOR_PATTERN = /^(>=|>|<=|<|==)$/;

/** Fields that are always server-derived on CREATE (authority fields). */
const MISSION_CREATE_AUTHORITY_FIELDS = [
  'missionId',
  'agencyId',
  'status',
  'version',
  'currentVersionSeq',
  'createdActor',
  'createdAt',
  'updatedAt',
  'provenance',
] as const;

/** CAS mutations legitimately receive `version`; identity/scope/provenance are rejected. */
const MISSION_CAS_AUTHORITY_FIELDS = [
  'missionId',
  'agencyId',
  'currentVersionSeq',
  'createdActor',
  'createdAt',
  'updatedAt',
  'provenance',
] as const;

// ---------------------------------------------------------------------------
// Server-derived provenance (never a request field)
// ---------------------------------------------------------------------------

function serverProvenance(principal: Principal): GrowthMissionProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Authorization (the app-metering fail-closed posture)
// ---------------------------------------------------------------------------

/**
 * The agency-scoped posture (the requireMeteringAgency pattern): the
 * durable agency row and the caller's membership in THAT agency resolve
 * from durable state BEFORE the module call. A malformed, unknown or
 * FOREIGN agency identifier is the uniform 404 (cross-agency data must
 * 404, not 403-leak existence); a caller with an ACTIVE membership passes
 * (optionally restricted to `roles`); a suspended membership or a disabled
 * identity is the 403.
 */
async function requireGrowthMissionsAgency(
  modules: ApplicationModules,
  principal: Principal,
  agencyId: string,
  roles?: ReadonlyArray<string>,
): Promise<void> {
  if (!UUID_PATTERN.test(agencyId)) {
    // A malformed identifier is indistinguishable from an unknown one.
    throw new NotFoundError('agency', agencyId);
  }
  const agency = await modules.agencies.getAgency(agencyId);
  if (agency === null) {
    throw new NotFoundError('agency', agencyId);
  }

  if (principal.kind === 'service') return;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return;

  const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
  if (membership === undefined) {
    // Hard boundary: not a member of the agency → the same 404 as for an
    // unknown agency (uniform, no cross-agency existence oracle).
    throw new NotFoundError('agency', agencyId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in this agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
}

/**
 * The mission-scoped posture (the requireClientAccess pattern one level
 * up): the canonical mission ownership (mission → owning agency row)
 * resolves from durable state BEFORE authorization — a malformed or
 * unknown mission identifier is the uniform 404; a caller with NO
 * membership in the OWNING agency gets the SAME 404 (a foreign mission
 * identifier is not a traversal/existence oracle); a suspended membership
 * is the 403. Returns the owning agency id for the pipeline owner scope.
 */
async function requireGrowthMissionAccess(
  modules: ApplicationModules,
  principal: Principal,
  missionId: string,
  roles?: ReadonlyArray<string>,
): Promise<string> {
  if (!UUID_PATTERN.test(missionId)) {
    throw new NotFoundError('mission', missionId);
  }
  const ownership = await modules.growthMissions.resolveGrowthMissionOwnership(missionId);
  if (ownership === null) {
    throw new NotFoundError('mission', missionId);
  }
  const agencyId = ownership.mission.agencyId;

  if (principal.kind === 'service') return agencyId;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return agencyId;

  const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
  if (membership === undefined) {
    // Hard boundary: not a member of the OWNING agency → indistinguishable
    // from an unknown mission (uniform 404, no cross-tenant oracle).
    throw new NotFoundError('mission', missionId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in the mission agency required');
  }
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new ForbiddenError('This operation requires a different agency role');
  }
  return agencyId;
}

// ---------------------------------------------------------------------------
// DTO specs (strict validation — the goals/experiments discipline)
// ---------------------------------------------------------------------------

/** Optional strict nested-object field (absent passes as undefined — the experiments precedent). */
function optionalObjectField<T extends Record<string, unknown>>(
  spec: ObjectSpec<T>,
): FieldSpec<T | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      return objectField(spec).parse(value, problems);
    },
  };
}

/** Required boolean field (the explicit intermediate flag). */
function booleanField(): FieldSpec<boolean> {
  return {
    required: true,
    parse: (value, problems) => {
      if (typeof value !== 'boolean') {
        problems.push('must be a boolean');
        return false;
      }
      return value;
    },
  };
}

type ValidatedDeclaration = {
  readonly objective: string;
  readonly objectiveFamily: string;
  readonly productContext:
    | { name: string | undefined; url: string | undefined; summary: string | undefined }
    | undefined;
  readonly marketContext:
    | { audience: string | undefined; geography: string | undefined; summary: string | undefined }
    | undefined;
  readonly targetMetrics: readonly {
    metric: string;
    comparator: string;
    targetValue: number;
    unit: string | undefined;
    description: string | undefined;
    intermediate: boolean;
  }[] | undefined;
};

function productContextSpec() {
  return {
    forbiddenKeys: ['provenance'],
    fields: {
      name: optionalString({ maxLength: 500 }),
      url: optionalString({ maxLength: 500 }),
      summary: optionalString({ maxLength: 500 }),
    },
  } satisfies ObjectSpec<{ name: string | undefined; url: string | undefined; summary: string | undefined }>;
}

function marketContextSpec() {
  return {
    forbiddenKeys: ['provenance'],
    fields: {
      audience: optionalString({ maxLength: 500 }),
      geography: optionalString({ maxLength: 500 }),
      summary: optionalString({ maxLength: 500 }),
    },
  } satisfies ObjectSpec<{ audience: string | undefined; geography: string | undefined; summary: string | undefined }>;
}

function targetMetricSpec() {
  return objectField<{
    metric: string;
    comparator: string;
    targetValue: number;
    unit: string | undefined;
    description: string | undefined;
    intermediate: boolean;
  }>({
    forbiddenKeys: ['provenance'],
    fields: {
      metric: stringField({ minLength: 1, maxLength: 100 }),
      comparator: stringField({ pattern: COMPARATOR_PATTERN }),
      targetValue: numberField(),
      unit: optionalString({ maxLength: 50 }),
      description: optionalString({ maxLength: 500 }),
      intermediate: booleanField(),
    },
  });
}

function declarationSpec() {
  return {
    objective: stringField({ minLength: 1, maxLength: 5000 }),
    objectiveFamily: stringField({ pattern: FAMILY_PATTERN }),
    productContext: optionalObjectField(productContextSpec()),
    marketContext: optionalObjectField(marketContextSpec()),
    targetMetrics: optionalArrayField({ maxItems: 50, item: targetMetricSpec() }),
  };
}

/** Maps the validated DTO onto the module declaration input. */
function toDeclaration(body: ValidatedDeclaration) {
  const productContext = body.productContext;
  const marketContext = body.marketContext;
  return {
    objective: body.objective,
    objectiveFamily: body.objectiveFamily as GrowthMissionVersionRecord['objectiveFamily'],
    productContext:
      productContext === undefined
        ? null
        : {
            name: productContext.name ?? null,
            url: productContext.url ?? null,
            summary: productContext.summary ?? null,
          },
    marketContext:
      marketContext === undefined
        ? null
        : {
            audience: marketContext.audience ?? null,
            geography: marketContext.geography ?? null,
            summary: marketContext.summary ?? null,
          },
    targetMetrics: (body.targetMetrics ?? []).map(
      (metric): GrowthMissionTargetMetric => ({
        metric: metric.metric,
        comparator: metric.comparator as GrowthMissionTargetMetric['comparator'],
        targetValue: metric.targetValue,
        unit: metric.unit ?? null,
        description: metric.description ?? null,
        intermediate: metric.intermediate,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Serialization (presentation only; every field of the record ships)
// ---------------------------------------------------------------------------

function serializeProvenance(
  provenance: GrowthMissionVersionRecord['provenance'],
): Record<string, unknown> {
  return {
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
    recordedAt: provenance.recordedAt,
  };
}

function serializeMission(mission: GrowthMissionRecord): Record<string, unknown> {
  return {
    missionId: mission.missionId,
    agencyId: mission.agencyId,
    status: mission.status,
    currentVersionSeq: mission.currentVersionSeq,
    version: mission.version,
    createdActor: mission.createdActor,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

function serializeVersion(version: GrowthMissionVersionRecord): Record<string, unknown> {
  return {
    missionVersionId: version.missionVersionId,
    missionId: version.missionId,
    versionSeq: version.versionSeq,
    objective: version.objective,
    objectiveFamily: version.objectiveFamily,
    productContext: version.productContext,
    marketContext: version.marketContext,
    targetMetrics: version.targetMetrics,
    provenance: serializeProvenance(version.provenance),
  };
}

function serializeEvent(event: GrowthMissionEventRecord): Record<string, unknown> {
  return {
    eventId: event.eventId,
    missionId: event.missionId,
    eventSeq: event.eventSeq,
    eventKind: event.eventKind,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    terminalDecisionFamily: event.terminalDecisionFamily,
    reason: event.reason,
    detail: event.detail,
    provenance: serializeProvenance(event.provenance),
  };
}

function serializeGoalMapping(mapping: GrowthMissionGoalView): Record<string, unknown> {
  return {
    mappingId: mapping.mappingId,
    missionId: mapping.missionId,
    goalId: mapping.goalId,
    goalStatus: mapping.goalStatus,
    goalClientId: mapping.goalClientId,
    addedAt: mapping.addedAt,
    addedBy: mapping.addedBy,
    removedAt: mapping.removedAt,
    removedBy: mapping.removedBy,
    removalReason: mapping.removalReason,
  };
}

function serializeDetail(detail: GrowthMissionDetail): Record<string, unknown> {
  return {
    mission: serializeMission(detail.mission),
    currentVersion: serializeVersion(detail.currentVersion),
    goalMappings: detail.goalMappings.map(serializeGoalMapping),
    history: detail.history.map(serializeEvent),
    terminalDecisionBasis: detail.terminalDecisionBasis,
    vocabularyVersion: GROWTH_MISSION_VOCABULARY_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerGrowthMissionsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('growthmissions.api');

  // -------------------------------------------------------------------------
  // POST /api/agencies/:agencyId/growth-missions — create an agency-scoped
  // Growth Mission (born 'draft', version 1 of the declared content, the
  // first history event). Agency ownership comes from the PATH and resolves
  // canonically BEFORE authorization; mission identity, status, provenance
  // and timestamps are server-derived; the caller declares the objective
  // (verbatim), the frozen §3 family, the product/market context and the
  // target metrics only.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/agencies/:agencyId/growth-missions',
    defineMutationRoute<{ agencyId: string }, GrowthMissionDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.agencyId)) {
          throw new NotFoundError('agency', params.agencyId);
        }
        const agency = await modules.agencies.getAgency(params.agencyId);
        if (agency === null) {
          throw new NotFoundError('agency', params.agencyId);
        }
        return { kind: 'agency', agencyId: params.agencyId };
      },
      authorize: async (ctx) => {
        await requireGrowthMissionsAgency(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedDeclaration>(ctx.request.body, {
          forbiddenKeys: MISSION_CREATE_AUTHORITY_FIELDS,
          fields: declarationSpec(),
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration;
        return modules.growthMissions.createGrowthMission(
          {
            agencyId: ctx.params.agencyId,
            declaration: toDeclaration(body),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('growthmissions.mission.created', undefined, {
          mission_id: ctx.result.mission.missionId,
          agency_id: ctx.params.agencyId,
          status: ctx.result.mission.status,
          objective_family: ctx.result.currentVersion.objectiveFamily,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'growthmissions.mission.created',
          targetType: 'growth_mission',
          targetId: ctx.result.mission.missionId,
          afterVersion: ctx.result.mission.version,
          idempotencyKey: `growthmissions.mission.created:${ctx.result.mission.missionId}`,
          details: {
            status: ctx.result.mission.status,
            objectiveFamily: ctx.result.currentVersion.objectiveFamily,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/agencies/:agencyId/growth-missions — the agency's missions in
  // ALL lifecycle states (terminal missions are visible business history).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/agencies/:agencyId/growth-missions',
    defineQueryRoute<{ agencyId: string }, readonly GrowthMissionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireGrowthMissionsAgency(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.growthMissions.listGrowthMissionsForAgency(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          missions: ctx.result.map(serializeMission),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId — the composed honest read-back:
  // the record + the CURRENT declared version (objective verbatim) + every
  // goal mapping (live goal status through the /goals public contract,
  // READ-ONLY) + the complete append-only history + the
  // terminal-decision-basis disclosure. Foreign/unknown → uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId',
    defineQueryRoute<{ missionId: string }, GrowthMissionDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireGrowthMissionAccess(modules, ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const detail = await modules.growthMissions.getGrowthMissionDetail(ctx.params.missionId);
        if (detail === null) {
          throw new NotFoundError('mission', ctx.params.missionId);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/versions — the append-only
  // declared-objective version tail (oldest first).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/versions',
    defineQueryRoute<{ missionId: string }, readonly GrowthMissionVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireGrowthMissionAccess(modules, ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const versions = await modules.growthMissions.getGrowthMissionVersions(
          ctx.params.missionId,
        );
        if (versions === null) {
          throw new NotFoundError('mission', ctx.params.missionId);
        }
        return versions;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          missionId: ctx.params.missionId,
          versions: ctx.result.map(serializeVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/history — the append-only history
  // tail (oldest first; every state transition with actor + provenance +
  // reason, terminal transitions with the declared-family decision basis).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/history',
    defineQueryRoute<{ missionId: string }, readonly GrowthMissionEventRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireGrowthMissionAccess(modules, ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const history = await modules.growthMissions.getGrowthMissionHistory(ctx.params.missionId);
        if (history === null) {
          throw new NotFoundError('mission', ctx.params.missionId);
        }
        return history;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          missionId: ctx.params.missionId,
          history: ctx.result.map(serializeEvent),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/growth-missions/:missionId/versions — the objective
  // CORRECTION path: append a NEW immutable declared version (the objective
  // is never rewritten in place) and advance the mission's version pointer
  // (CAS). Requires a non-terminal mission.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/versions',
    defineMutationRoute<{ missionId: string }, GrowthMissionDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.missionId)) {
          throw new NotFoundError('mission', params.missionId);
        }
        const ownership = await modules.growthMissions.resolveGrowthMissionOwnership(
          params.missionId,
        );
        if (ownership === null) {
          throw new NotFoundError('mission', params.missionId);
        }
        return { kind: 'agency', agencyId: ownership.mission.agencyId };
      },
      authorize: async (ctx) => {
        await requireGrowthMissionAccess(modules, ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedDeclaration & { version: number }>(ctx.request.body, {
          forbiddenKeys: MISSION_CAS_AUTHORITY_FIELDS,
          fields: {
            ...declarationSpec(),
            version: intField({ min: 1 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDeclaration & { version: number };
        return modules.growthMissions.recordGrowthMissionVersion(
          {
            missionId: ctx.params.missionId,
            declaration: toDeclaration(body),
            expectedVersion: body.version,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('growthmissions.mission.versionrecorded', undefined, {
          mission_id: ctx.params.missionId,
          version_seq: ctx.result.mission.currentVersionSeq,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'growthmissions.mission.versionrecorded',
          targetType: 'growth_mission',
          targetId: ctx.params.missionId,
          afterVersion: ctx.result.mission.version,
          idempotencyKey: `growthmissions.mission.versionrecorded:${ctx.result.mission.version}`,
          details: {
            versionSeq: ctx.result.mission.currentVersionSeq,
            objectiveFamily: ctx.result.currentVersion.objectiveFamily,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/growth-missions/:missionId/status — the lifecycle transition
  // through the frozen state machine (CAS; REQUIRED reason). Activation
  // requires at least one mapped goal; terminal states have no outgoing
  // transitions (the honest-state rule — a block is never silently
  // converted into success).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/status',
    defineMutationRoute<{ missionId: string }, GrowthMissionDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.missionId)) {
          throw new NotFoundError('mission', params.missionId);
        }
        const ownership = await modules.growthMissions.resolveGrowthMissionOwnership(
          params.missionId,
        );
        if (ownership === null) {
          throw new NotFoundError('mission', params.missionId);
        }
        return { kind: 'agency', agencyId: ownership.mission.agencyId };
      },
      authorize: async (ctx) => {
        await requireGrowthMissionAccess(modules, ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ status: string; reason: string; version: number }>(ctx.request.body, {
          forbiddenKeys: MISSION_CAS_AUTHORITY_FIELDS,
          fields: {
            status: stringField({ pattern: STATUS_PATTERN }),
            reason: stringField({ minLength: 1, maxLength: 2000 }),
            version: intField({ min: 1 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { status: string; reason: string; version: number };
        return modules.growthMissions.setGrowthMissionStatus(
          {
            missionId: ctx.params.missionId,
            status: body.status as GrowthMissionRecord['status'],
            reason: body.reason,
            expectedVersion: body.version,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('growthmissions.mission.transitioned', undefined, {
          mission_id: ctx.params.missionId,
          status: ctx.result.mission.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'growthmissions.mission.transitioned',
          targetType: 'growth_mission',
          targetId: ctx.params.missionId,
          afterVersion: ctx.result.mission.version,
          idempotencyKey: `growthmissions.mission.transitioned:${ctx.result.mission.version}`,
          details: {
            status: ctx.result.mission.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/growth-missions/:missionId/goal-mappings — map an EXISTING
  // goal (canonical goal reference through the /goals public contract,
  // READ-ONLY). Unknown/tombstoned/cross-agency goal → the uniform 404
  // (a foreign goal identifier is not a traversal/existence oracle).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/goal-mappings',
    defineMutationRoute<{ missionId: string }, GrowthMissionDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.missionId)) {
          throw new NotFoundError('mission', params.missionId);
        }
        const ownership = await modules.growthMissions.resolveGrowthMissionOwnership(
          params.missionId,
        );
        if (ownership === null) {
          throw new NotFoundError('mission', params.missionId);
        }
        return { kind: 'agency', agencyId: ownership.mission.agencyId };
      },
      authorize: async (ctx) => {
        await requireGrowthMissionAccess(modules, ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ goalId: string }>(ctx.request.body, {
          forbiddenKeys: MISSION_CAS_AUTHORITY_FIELDS,
          fields: {
            goalId: stringField({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { goalId: string };
        return modules.growthMissions.addGrowthMissionGoalMapping(
          {
            missionId: ctx.params.missionId,
            goalId: body.goalId,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('growthmissions.goal.mapped', undefined, {
          mission_id: ctx.params.missionId,
          mapping_count: ctx.result.goalMappings.filter((mapping) => mapping.removedAt === null)
            .length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'growthmissions.goal.mapped',
          targetType: 'growth_mission',
          targetId: ctx.params.missionId,
          afterVersion: ctx.result.mission.version,
          idempotencyKey: `growthmissions.goal.mapped:${ctx.result.mission.version}`,
          details: {
            activeMappings: ctx.result.goalMappings.filter((mapping) => mapping.removedAt === null)
              .length,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/growth-missions/:missionId/goal-mappings/:goalId/removal —
  // remove a goal mapping HONESTLY (the recorded removal triple + the
  // REQUIRED reason; never a DELETE — goal removal surfaces honestly,
  // history is never erased).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/goal-mappings/:goalId/removal',
    defineMutationRoute<{ missionId: string; goalId: string }, GrowthMissionDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        if (!UUID_PATTERN.test(params.missionId)) {
          throw new NotFoundError('mission', params.missionId);
        }
        const ownership = await modules.growthMissions.resolveGrowthMissionOwnership(
          params.missionId,
        );
        if (ownership === null) {
          throw new NotFoundError('mission', params.missionId);
        }
        return { kind: 'agency', agencyId: ownership.mission.agencyId };
      },
      authorize: async (ctx) => {
        await requireGrowthMissionAccess(modules, ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ reason: string }>(ctx.request.body, {
          forbiddenKeys: MISSION_CAS_AUTHORITY_FIELDS,
          fields: {
            reason: stringField({ minLength: 1, maxLength: 2000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { reason: string };
        return modules.growthMissions.removeGrowthMissionGoalMapping(
          {
            missionId: ctx.params.missionId,
            goalId: ctx.params.goalId,
            reason: body.reason,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('growthmissions.goal.unmapped', undefined, {
          mission_id: ctx.params.missionId,
          goal_id: ctx.params.goalId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'growthmissions.goal.unmapped',
          targetType: 'growth_mission',
          targetId: ctx.params.missionId,
          afterVersion: ctx.result.mission.version,
          idempotencyKey: `growthmissions.goal.unmapped:${ctx.result.mission.version}`,
          details: {
            goalId: ctx.params.goalId,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );
}
