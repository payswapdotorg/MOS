/**
 * /field-agents API routes (MKT-025 — the generic Human Agent authority:
 * FIELD-001 + HUMAN-001, v1.3 matrix override FIELD-AC-01..02 +
 * HUMAN-AC-01..03).
 *
 *   POST   /api/field-agents                                  create OWN profile (authenticated active user; identity server-derived)
 *   GET    /api/field-agents/:agentId                         read profile (owner | platform admin | service | agency co-member via ACTIVE human_agent membership)
 *   PATCH  /api/field-agents/:agentId/profile                 CAS content update — specializations/capabilities/relationship continuity (owner | platform admin | service)
 *   PATCH  /api/field-agents/:agentId/availability            CAS availability/territory declaration, FIELD-AC-01 (owner | platform admin | service)
 *   PATCH  /api/field-agents/:agentId/authorization           CAS authorization/contract state (platform admin | service ONLY)
 *   POST   /api/agencies/:agencyId/field-agents/eligibility   job-eligibility lookup, FIELD-AC-02 (any ACTIVE member of the agency)
 *
 * The Human Agent is a PLATFORM IDENTITY (human-agent-v1.3 §1): the profile
 * is not tenant-scoped and owns no Client data. Ownership is SERVER-DERIVED:
 * a profile belongs to exactly one durable platform user (user_id), and
 * agency linkage is EXACTLY the existing /agencies membership authority
 * (role 'human_agent') — composed here, never re-implemented (no second
 * authorization authority). A Human Agent is NOT a tenant: no route of this
 * file scopes profiles by Client, and NO Client data is read, joined or
 * serialized anywhere on these paths.
 *
 * HUMAN-AC-03 (fail-closed client boundary): this module exposes NO
 * client-data routes. Client-scoped profile/eligibility lookups require the
 * authorized Job/Execution context which DOES NOT EXIST YET (the /jobs
 * authority is MKT-026) — therefore every client-shaped request field
 * (clientId/clientIds/clients/…) is rejected at validation time, BEFORE any
 * traversal, and no client-scoped route exists to hit. The existing
 * /api/clients surface (MKT-003, any-active-member) is a different module's
 * frozen authority and is not changed by MKT-025.
 *
 * FIELD-AC-02 (eligibility without Client exposure): the eligibility lookup
 * composes the commissioning agency's ACTIVE human_agent memberships
 * (durable state, resolved through /agencies BEFORE the module call — the
 * frozen dependency matrix allows /field-agents → /users, /clients,
 * /policies only, NOT /agencies), then evaluates the pure profile matcher
 * inside the module. The response carries PROFILE DATA ONLY.
 *
 * HUMAN-AC-02 (one execution authority): these routes persist profile and
 * capability metadata ONLY — no Job/Task/Execution/offer/acceptance
 * concepts, no assignment, no queue (the Job authority is /jobs, MKT-026;
 * the Task/Execution authorities are /workflows and /executions).
 *
 * Cross-tenant posture: an agentId is never an authorization credential;
 * callers with no durable relationship to the profile get a UNIFORM 404
 * (no existence oracle), exactly like the other scoped authorities.
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
  arrayField,
  intField,
  objectField,
  optionalArrayField,
  stringField,
  validateObject,
  type FieldSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireAgencyAccess, requirePlatformAdministrator, resolveContext } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  AvailabilityWindow,
  HumanAgentDeclaration,
  HumanAgentRecord,
  RelationshipContinuity,
  ReliabilitySignals,
  Territory,
} from '../modules/field-agents/public.ts';

// ---------------------------------------------------------------------------
// Frozen vocabulary patterns (mirror the module public registries; the
// architecture test fails if the DB CHECK / code registry ever drift).
// ---------------------------------------------------------------------------

const SPECIALIZATION_PATTERN =
  /^(field_agent|chatter|creator_manager|content_manager|growth_manager|account_manager|reviewer|sales_agent)$/;
const CAPABILITY_LEVEL_PATTERN = /^(beginner|intermediate|advanced|expert)$/;
const TERRITORY_KIND_PATTERN = /^(country|region|city|postal_area)$/;
const SKILL_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;
const TERRITORY_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ,.-]{0,99}$/;
const AUTHORIZATION_STATE_PATTERN = /^(active|suspended|contract_ended)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Client-shaped keys are rejected OUTRIGHT on every request surface of this
 * module (HUMAN-AC-03 fail-closed): client-scoped lookups require the
 * authorized Job/Execution context, which does not exist yet (MKT-026).
 * Agency-linkage keys are equally rejected: agency linkage is the membership
 * authority's concern, never a profile field. Together with the
 * server-derived identity/authority keys this is the §23 authority-field
 * rejection contract.
 */
const CLIENT_AND_LINKAGE_FIELDS = [
  'clientId',
  'clientIds',
  'clients',
  'agencyId',
  'agencyIds',
  'agencies',
  'workspaceId',
  'memberships',
  'jobId',
  'jobIds',
] as const;

const PROFILE_CREATE_AUTHORITY_FIELDS = [
  'agentId',
  'userId',
  'authorizationState',
  'reliability',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  ...CLIENT_AND_LINKAGE_FIELDS,
] as const;

const PROFILE_CAS_AUTHORITY_FIELDS = [
  'agentId',
  'userId',
  'authorizationState',
  'reliability',
  'location',
  'availability',
  'territories',
  'createdBy',
  'createdAt',
  'updatedAt',
  ...CLIENT_AND_LINKAGE_FIELDS,
] as const;

const DECLARATION_CAS_AUTHORITY_FIELDS = [
  'agentId',
  'userId',
  'specializations',
  'capabilities',
  'relationshipContinuity',
  'authorizationState',
  'reliability',
  'createdBy',
  'createdAt',
  'updatedAt',
  ...CLIENT_AND_LINKAGE_FIELDS,
] as const;

const AUTHORIZATION_CAS_AUTHORITY_FIELDS = [
  'agentId',
  'userId',
  'specializations',
  'capabilities',
  'relationshipContinuity',
  'location',
  'availability',
  'territories',
  'reliability',
  'createdBy',
  'createdAt',
  'updatedAt',
  ...CLIENT_AND_LINKAGE_FIELDS,
] as const;

const ELIGIBILITY_FORBIDDEN_FIELDS = [
  'agentId',
  'agentIds',
  'userId',
  'userIds',
  'authorizationState',
  'reliability',
  'version',
  ...CLIENT_AND_LINKAGE_FIELDS,
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

/** Nullable integer: absent/null → null; otherwise a strict integer. */
function nullableIntField(options: { min: number; max: number }): FieldSpec<number | null> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined || value === null) return null;
      return intField(options).parse(value, problems);
    },
  };
}

const territoryObjectField = objectField<{ kind: string; value: string }>({
  forbiddenKeys: [],
  fields: {
    kind: stringField({ pattern: TERRITORY_KIND_PATTERN }),
    value: stringField({ minLength: 1, maxLength: 100, pattern: TERRITORY_VALUE_PATTERN }),
  },
});

/** Nullable territory: absent/null (not declared) or a strict territory object. */
const nullableTerritoryField: FieldSpec<{ kind: string; value: string } | null> = {
  required: false,
  parse: (value, problems) => {
    if (value === undefined || value === null) return null;
    return territoryObjectField.parse(value, problems);
  },
};

/** Nullable string: absent/null → null; otherwise a strict patterned string. */
function nullableStringField(options: { pattern: RegExp }): FieldSpec<string | null> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined || value === null) return null;
      return stringField(options).parse(value, problems);
    },
  };
}

const capabilityObjectField = objectField<{ skill: string; level: string | null }>({
  forbiddenKeys: [],
  fields: {
    skill: stringField({ minLength: 2, maxLength: 49, pattern: SKILL_PATTERN }),
    level: nullableStringField({ pattern: CAPABILITY_LEVEL_PATTERN }),
  },
});

const availabilityWindowObjectField = objectField<{
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}>({
  forbiddenKeys: [],
  fields: {
    dayOfWeek: intField({ min: 0, max: 6 }),
    startMinute: intField({ min: 0, max: 1439 }),
    endMinute: intField({ min: 1, max: 1440 }),
  },
});

const relationshipContinuityObjectField = objectField<{
  prefersRepeatClients: boolean;
  continuity: string;
  maxConcurrentClientRelationships: number | null;
}>({
  forbiddenKeys: [],
  fields: {
    prefersRepeatClients: booleanField,
    continuity: stringField({ pattern: /^(any|preferred|required)$/ }),
    maxConcurrentClientRelationships: nullableIntField({ min: 1, max: 100 }),
  },
});

/** Cross-field window check (start BEFORE end) — objectField cannot do it. */
function assertWindowsWellFormed(
  windows: ReadonlyArray<{ dayOfWeek: number; startMinute: number; endMinute: number }>,
): void {
  const problems: string[] = [];
  windows.forEach((window, index) => {
    if (window.startMinute >= window.endMinute) {
      problems.push(`[${index}]: startMinute must be before endMinute`);
    }
  });
  if (problems.length > 0) {
    throw new InvalidRequestError('Availability windows failed validation', [
      `availability: ${problems.join('; ')}`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Serialization — PROFILE DATA ONLY (never Client data: the record
// structurally carries none; reliability is the server-derived aggregate).
// ---------------------------------------------------------------------------

function serializeTerritory(territory: Territory): Record<string, unknown> {
  return { kind: territory.kind, value: territory.value };
}

function serializeReliability(signals: ReliabilitySignals): Record<string, unknown> {
  return {
    completedJobs: signals.completedJobs,
    successfulJobs: signals.successfulJobs,
    onTimeCompletions: signals.onTimeCompletions,
    ratingSum: signals.ratingSum,
    ratingCount: signals.ratingCount,
  };
}

function serializeHumanAgent(record: HumanAgentRecord): Record<string, unknown> {
  return {
    agentId: record.agentId,
    userId: record.userId,
    specializations: [...record.specializations],
    capabilities: record.capabilities.map((capability) => ({
      skill: capability.skill,
      ...(capability.level === null ? {} : { level: capability.level }),
    })),
    availability: record.availability.map((window) => ({
      dayOfWeek: window.dayOfWeek,
      startMinute: window.startMinute,
      endMinute: window.endMinute,
    })),
    ...(record.location === null ? {} : { location: serializeTerritory(record.location) }),
    territories: record.territories.map(serializeTerritory),
    reliability: serializeReliability(record.reliability),
    relationshipContinuity: {
      prefersRepeatClients: record.relationshipContinuity.prefersRepeatClients,
      continuity: record.relationshipContinuity.continuity,
      maxConcurrentClientRelationships: record.relationshipContinuity.maxConcurrentClientRelationships,
    },
    authorizationState: record.authorizationState,
    version: record.version,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Authorization composition (server-derived ownership; agency linkage via
// the EXISTING /agencies membership authority — never re-implemented here)
// ---------------------------------------------------------------------------

/** Platform scope: the Human Agent profile is a platform identity record. */
const PLATFORM_OWNER: OwnerScope = { kind: 'platform' };

/**
 * Resolves the caller's durable identity context for a user principal
 * (null for non-user principals). Active-identity checks mirror the house
 * rules: a disabled identity never authorizes.
 */
async function activeUserContext(
  modules: ApplicationModules,
  principal: Principal,
): Promise<Awaited<ReturnType<typeof resolveContext>>> {
  if (principal.kind !== 'user') return null;
  return resolveContext(modules, principal);
}

function isPlatformController(context: Awaited<ReturnType<typeof resolveContext>>): boolean {
  return context !== null && context.platformRoles.includes('platform_administrator');
}

/** True when the caller is the internal service principal. */
function isServicePrincipal(principal: Principal): boolean {
  return principal.kind === 'service';
}

/**
 * Read authorization for one profile (server-derived ownership):
 *   - the internal service principal (server-side composition callers);
 *   - platform administrators (platform operators, house posture);
 *   - the profile's OWNING user with an ACTIVE identity;
 *   - any caller holding an ACTIVE membership in an agency where the
 *     profile's user holds an ACTIVE human_agent membership — agency
 *     linkage resolved from durable state through /agencies ONLY.
 * Everyone else: uniform 404 (no existence oracle).
 */
async function canReadProfile(
  modules: ApplicationModules,
  principal: Principal,
  record: HumanAgentRecord,
): Promise<boolean> {
  if (isServicePrincipal(principal)) return true;
  const context = await activeUserContext(modules, principal);
  if (context === null || context.principal.status !== 'active') return false;
  if (isPlatformController(context)) return true;
  if (principal.kind === 'user' && principal.userId === record.userId) return true;

  // Agency co-member visibility: the agent's ACTIVE human_agent memberships
  // (durable /agencies state) intersected with the caller's ACTIVE
  // memberships. No Client data is involved on this path.
  const agentMemberships = await modules.agencies.listMembershipsForUser(record.userId);
  const callerAgencyIds = new Set(
    context.memberships
      .filter((membership) => membership.membershipStatus === 'active')
      .map((membership) => membership.agencyId),
  );
  return agentMemberships.some(
    (membership) =>
      membership.role === 'human_agent' &&
      membership.status === 'active' &&
      callerAgencyIds.has(membership.agencyId),
  );
}

/**
 * Mutation authorization for declarable profile content: the OWNING user
 * (self-declaration, FIELD-AC-01), platform administrators or the service
 * principal. Agency co-members can READ (visibility) but never rewrite an
 * agent's self-declared profile.
 */
async function canMutateProfile(
  modules: ApplicationModules,
  principal: Principal,
  record: HumanAgentRecord,
): Promise<boolean> {
  if (isServicePrincipal(principal)) return true;
  const context = await activeUserContext(modules, principal);
  if (context === null || context.principal.status !== 'active') return false;
  if (isPlatformController(context)) return true;
  return principal.kind === 'user' && principal.userId === record.userId;
}

/** Resolves the profile or throws the uniform 404 (malformed identifiers too). */
async function requireProfile(
  modules: ApplicationModules,
  agentId: string,
): Promise<HumanAgentRecord> {
  // A malformed identifier is a uniform 404 BEFORE any database traversal —
  // never a distinguishable 500 (no shape oracle).
  if (!UUID_PATTERN.test(agentId)) {
    throw new NotFoundError('human-agent', agentId);
  }
  const record = await modules.fieldAgents.getHumanAgent(agentId);
  if (record === null) {
    throw new NotFoundError('human-agent', agentId);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerFieldAgentsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('field-agents.api');

  // -------------------------------------------------------------------------
  // POST /api/field-agents — create the caller's OWN Human Agent profile.
  // The platform identity link is SERVER-DERIVED from the authenticated
  // principal; a userId in the body is an authority field (rejected).
  // Self-declaration: FIELD-AC-01's subject is the (field) agent themself.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/field-agents',
    defineMutationRoute<Record<string, string>, HumanAgentRecord>({
      authenticator: services.auth,
      resolveOwner: async () => PLATFORM_OWNER,
      authorize: async (ctx) => {
        // Self-declaration requires an ACTIVE user identity (the profile
        // link is the principal itself; the service principal and anonymous
        // callers cannot self-declare).
        if (ctx.principal.kind !== 'user') {
          throw new ForbiddenError('Human Agent profiles are self-declared by active user identities');
        }
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      validate: (ctx) =>
        validateObject<{
          specializations: string[];
          capabilities: ReadonlyArray<{ skill: string; level: string | null }>;
          availability: ReadonlyArray<{
            dayOfWeek: number;
            startMinute: number;
            endMinute: number;
          }>;
          location: { kind: string; value: string } | null;
          territories: ReadonlyArray<{ kind: string; value: string }> | undefined;
          relationshipContinuity: {
            prefersRepeatClients: boolean;
            continuity: string;
            maxConcurrentClientRelationships: number | null;
          };
        }>(ctx.request.body, {
          forbiddenKeys: PROFILE_CREATE_AUTHORITY_FIELDS,
          fields: {
            specializations: arrayField({
              minItems: 1,
              maxItems: 8,
              item: stringField({ pattern: SPECIALIZATION_PATTERN }),
            }),
            capabilities: arrayField({ minItems: 1, maxItems: 50, item: capabilityObjectField }),
            availability: arrayField({
              minItems: 1,
              maxItems: 100,
              item: availabilityWindowObjectField,
            }),
            location: nullableTerritoryField,
            territories: optionalArrayField({ minItems: 0, maxItems: 50, item: territoryObjectField }),
            relationshipContinuity: relationshipContinuityObjectField,
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          specializations: string[];
          capabilities: ReadonlyArray<{ skill: string; level: string | null }>;
          availability: ReadonlyArray<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
          location: { kind: string; value: string } | null;
          territories: ReadonlyArray<{ kind: string; value: string }> | undefined;
          relationshipContinuity: {
            prefersRepeatClients: boolean;
            continuity: string;
            maxConcurrentClientRelationships: number | null;
          };
        };
        assertWindowsWellFormed(body.availability);
        const declaration: HumanAgentDeclaration = {
          specializations: body.specializations as HumanAgentDeclaration['specializations'],
          capabilities: body.capabilities.map((capability) => ({
            skill: capability.skill,
            level: (capability.level ?? null) as HumanAgentDeclaration['capabilities'][number]['level'],
          })),
          availability: body.availability.map((window) => ({
            dayOfWeek: window.dayOfWeek,
            startMinute: window.startMinute,
            endMinute: window.endMinute,
          })),
          location: body.location == null ? null : { kind: body.location.kind as Territory['kind'], value: body.location.value },
          territories: (body.territories ?? []).map((territory) => ({
            kind: territory.kind as Territory['kind'],
            value: territory.value,
          })),
          relationshipContinuity: body.relationshipContinuity as RelationshipContinuity,
        };
        return modules.fieldAgents.createHumanAgent({
          userId: ctx.principal.kind === 'user' ? ctx.principal.userId : '',
          declaration,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('field-agents.profile.created', undefined, {
          agent_id: ctx.result.agentId,
          user_id: ctx.result.userId,
          specializations: [...ctx.result.specializations],
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'field_agents.profile.created',
          targetType: 'human-agent',
          targetId: ctx.result.agentId,
          afterVersion: ctx.result.version,
          idempotencyKey: `field-agents.profile.created:${ctx.result.agentId}`,
          details: {
            userId: ctx.result.userId,
            specializations: ctx.result.specializations.join(','),
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeHumanAgent(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/field-agents/:agentId — read one profile. Ownership is
  // resolved from durable state; unrelated callers get a UNIFORM 404 (no
  // existence oracle). The response is profile data ONLY (HUMAN-AC-03).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/field-agents/:agentId',
    defineQueryRoute<{ agentId: string }, HumanAgentRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const record = await requireProfile(modules, ctx.params.agentId);
        const readable = await canReadProfile(modules, ctx.principal, record);
        if (!readable) {
          // Uniform 404: indistinguishable from an unknown identifier.
          throw new NotFoundError('human-agent', ctx.params.agentId);
        }
      },
      execute: async (ctx) => requireProfile(modules, ctx.params.agentId),
      respond: (ctx) => jsonResponse(200, serializeHumanAgent(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/field-agents/:agentId/profile — CAS content update
  // (specializations, capabilities, relationship continuity). Owner (self)
  // | platform admin | service. Callers that can read but not mutate get
  // 403; callers that cannot even read stay at the uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/field-agents/:agentId/profile',
    defineMutationRoute<{ agentId: string }, HumanAgentRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        await requireProfile(modules, params.agentId);
        return PLATFORM_OWNER;
      },
      authorize: async (ctx) => {
        const record = await requireProfile(modules, ctx.params.agentId);
        if (!(await canReadProfile(modules, ctx.principal, record))) {
          throw new NotFoundError('human-agent', ctx.params.agentId);
        }
        if (!(await canMutateProfile(modules, ctx.principal, record))) {
          throw new ForbiddenError(
            'Only the owning user or a platform administrator can update a Human Agent profile',
          );
        }
      },
      validate: (ctx) =>
        validateObject<{
          specializations: string[];
          capabilities: ReadonlyArray<{ skill: string; level: string | null }>;
          relationshipContinuity: {
            prefersRepeatClients: boolean;
            continuity: string;
            maxConcurrentClientRelationships: number | null;
          };
          version: number;
        }>(ctx.request.body, {
          forbiddenKeys: PROFILE_CAS_AUTHORITY_FIELDS,
          fields: {
            specializations: arrayField({
              minItems: 1,
              maxItems: 8,
              item: stringField({ pattern: SPECIALIZATION_PATTERN }),
            }),
            capabilities: arrayField({ minItems: 1, maxItems: 50, item: capabilityObjectField }),
            relationshipContinuity: relationshipContinuityObjectField,
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          specializations: string[];
          capabilities: ReadonlyArray<{ skill: string; level: string | null }>;
          relationshipContinuity: {
            prefersRepeatClients: boolean;
            continuity: string;
            maxConcurrentClientRelationships: number | null;
          };
          version: number;
        };
        return modules.fieldAgents.updateProfileContent({
          agentId: ctx.params.agentId,
          specializations: body.specializations as HumanAgentDeclaration['specializations'],
          capabilities: body.capabilities.map((capability) => ({
            skill: capability.skill,
            level: (capability.level ?? null) as HumanAgentDeclaration['capabilities'][number]['level'],
          })),
          relationshipContinuity: body.relationshipContinuity as RelationshipContinuity,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('field-agents.profile.updated', undefined, {
          agent_id: ctx.result.agentId,
          version: ctx.result.version,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'field_agents.profile.updated',
          targetType: 'human-agent',
          targetId: ctx.result.agentId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `field-agents.profile.updated:${ctx.result.agentId}:${ctx.result.version}`,
          details: { specializations: ctx.result.specializations.join(',') },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeHumanAgent(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/field-agents/:agentId/availability — CAS availability/
  // territory declaration (FIELD-AC-01: the (field) agent declares
  // location, territories and availability windows). Owner (self) |
  // platform admin | service.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/field-agents/:agentId/availability',
    defineMutationRoute<{ agentId: string }, HumanAgentRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        await requireProfile(modules, params.agentId);
        return PLATFORM_OWNER;
      },
      authorize: async (ctx) => {
        const record = await requireProfile(modules, ctx.params.agentId);
        if (!(await canReadProfile(modules, ctx.principal, record))) {
          throw new NotFoundError('human-agent', ctx.params.agentId);
        }
        if (!(await canMutateProfile(modules, ctx.principal, record))) {
          throw new ForbiddenError(
            'Only the owning user or a platform administrator can declare availability for a Human Agent profile',
          );
        }
      },
      validate: (ctx) =>
        validateObject<{
          availability: ReadonlyArray<{
            dayOfWeek: number;
            startMinute: number;
            endMinute: number;
          }>;
          location: { kind: string; value: string } | null;
          territories: ReadonlyArray<{ kind: string; value: string }> | undefined;
          version: number;
        }>(ctx.request.body, {
          forbiddenKeys: DECLARATION_CAS_AUTHORITY_FIELDS,
          fields: {
            availability: arrayField({
              minItems: 1,
              maxItems: 100,
              item: availabilityWindowObjectField,
            }),
            location: nullableTerritoryField,
            territories: optionalArrayField({ minItems: 0, maxItems: 50, item: territoryObjectField }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          availability: ReadonlyArray<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
          location: { kind: string; value: string } | null;
          territories: ReadonlyArray<{ kind: string; value: string }> | undefined;
          version: number;
        };
        assertWindowsWellFormed(body.availability);
        return modules.fieldAgents.declareAvailabilityTerritory({
          agentId: ctx.params.agentId,
          availability: body.availability.map((window) => ({
            dayOfWeek: window.dayOfWeek,
            startMinute: window.startMinute,
            endMinute: window.endMinute,
          })),
          location: body.location == null ? null : { kind: body.location.kind as Territory['kind'], value: body.location.value },
          territories: (body.territories ?? []).map((territory) => ({
            kind: territory.kind as Territory['kind'],
            value: territory.value,
          })),
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('field-agents.availability.declared', undefined, {
          agent_id: ctx.result.agentId,
          version: ctx.result.version,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'field_agents.availability.declared',
          targetType: 'human-agent',
          targetId: ctx.result.agentId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `field-agents.availability.declared:${ctx.result.agentId}:${ctx.result.version}`,
          details: {
            windows: ctx.result.availability.length,
            territories: ctx.result.territories.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeHumanAgent(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/field-agents/:agentId/authorization — CAS authorization/
  // contract-state transition (active/suspended/contract_ended; terminal
  // contract_ended). PLATFORM-CONTROLLED state: platform administrators and
  // the service principal ONLY. Agency-level standing is the EXISTING
  // /agencies membership lifecycle (an agency disables its human_agent
  // membership through /agencies — never here); a platform-level contract
  // state therefore cannot be mutated by any single agency.
  // -------------------------------------------------------------------------
  router.add(
    'PATCH',
    '/api/field-agents/:agentId/authorization',
    defineMutationRoute<{ agentId: string }, HumanAgentRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        await requireProfile(modules, params.agentId);
        return PLATFORM_OWNER;
      },
      authorize: async (ctx) => {
        await requireProfile(modules, ctx.params.agentId);
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ authorizationState: string; version: number }>(ctx.request.body, {
          forbiddenKeys: AUTHORIZATION_CAS_AUTHORITY_FIELDS,
          fields: {
            authorizationState: stringField({ pattern: AUTHORIZATION_STATE_PATTERN }),
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          authorizationState: HumanAgentRecord['authorizationState'];
          version: number;
        };
        return modules.fieldAgents.setAuthorizationState({
          agentId: ctx.params.agentId,
          authorizationState: body.authorizationState,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('field-agents.authorization.changed', undefined, {
          agent_id: ctx.result.agentId,
          authorization_state: ctx.result.authorizationState,
          version: ctx.result.version,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'field_agents.authorization.changed',
          targetType: 'human-agent',
          targetId: ctx.result.agentId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `field-agents.authorization.changed:${ctx.result.agentId}:${ctx.result.version}`,
          details: { authorizationState: ctx.result.authorizationState },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeHumanAgent(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/agencies/:agencyId/field-agents/eligibility — job-eligibility
  // lookup (FIELD-AC-02). Any ACTIVE member of the (existing) agency may
  // look up which of the agency's linked Human Agents match a job spec.
  //
  // The candidate pool is resolved from DURABLE state through /agencies
  // (ACTIVE human_agent memberships) BEFORE the module call — the module
  // itself may not import /agencies (frozen matrix), so the route composes
  // the authorities exactly like MKT-003/004/005 do. The response carries
  // PROFILE DATA ONLY: no Client data is read, joined or serialized on this
  // path (HUMAN-AC-03). Client-shaped request fields are rejected at
  // validation time, BEFORE any traversal — client-scoped eligibility
  // requires the authorized Job/Execution context (MKT-026), which does
  // not exist yet: fail-closed.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/agencies/:agencyId/field-agents/eligibility',
    defineQueryRoute<{ agencyId: string }, readonly HumanAgentRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        // Resolves the agency from durable state first (uniform 404 for
        // unknown identifiers) and requires an ACTIVE membership.
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        const body = validateObject<{
          specialization: string;
          requiredCapabilities: ReadonlyArray<string> | undefined;
          territory: { kind: string; value: string } | null;
          dayOfWeek: number;
          startMinute: number;
          endMinute: number;
        }>(ctx.request.body, {
          forbiddenKeys: ELIGIBILITY_FORBIDDEN_FIELDS,
          fields: {
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
        });
        if (body.startMinute >= body.endMinute) {
          throw new InvalidRequestError('Job eligibility spec failed validation', [
            'startMinute must be before endMinute',
          ]);
        }

        // Candidate pool: the commissioning agency's ACTIVE human_agent
        // memberships — durable state resolved BEFORE the module call.
        const memberships = await modules.agencies.listMemberships(ctx.params.agencyId);
        const candidateUserIds = memberships
          .filter(
            (membership) => membership.role === 'human_agent' && membership.status === 'active',
          )
          .map((membership) => membership.userId);

        const spec = {
          specialization: body.specialization as HumanAgentDeclaration['specializations'][number],
          requiredCapabilities: body.requiredCapabilities ?? [],
          territory:
            body.territory == null
              ? null
              : { kind: body.territory.kind as Territory['kind'], value: body.territory.value },
          availability: {
            dayOfWeek: body.dayOfWeek,
            startMinute: body.startMinute,
            endMinute: body.endMinute,
          } satisfies AvailabilityWindow,
        };
        return modules.fieldAgents.findEligibleAgents({
          spec,
          candidateUserIds,
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          matched: ctx.result.length,
          agents: ctx.result.map(serializeHumanAgent),
        }),
    }),
  );
}
