/**
 * /agents API routes (MKT-020 — Logical Agent/Capability contracts:
 * AGENT-001, acceptance "provider-neutral capability tests").
 *
 *   POST  /api/agents                                register PLATFORM-scoped logical agent (platform admin only)
 *   GET   /api/agents                                list ACTIVE platform-scoped declarations (any authenticated — catalog data)
 *   GET   /api/agents/:agentId                       read one (any authenticated for platform scope; owning-agency member for agency scope; retired history stays visible)
 *   POST  /api/agents/:agentId/retire                the single lifecycle edge, CAS (platform admin for platform scope; owner|admin of the owning agency otherwise)
 *   GET   /api/agents/:agentId/lifecycle-events      the append-only lifecycle history (same access as read)
 *
 *   POST  /api/agencies/:agencyId/agents             register AGENCY-scoped logical agent (owner|admin|platform admin)
 *   GET   /api/agencies/:agencyId/agents             list the agency's declarations in ALL states (any active member)
 *
 * The logical Agent surface is the PROVIDER-NEUTRAL capability contract
 * (AGENT-001): request DTOs REJECT provider/model/SDK/credential-shaped
 * keys, infrastructure-coupling keys (sandbox/pool/queue/runtime/
 * deployment) and tenant/workflow/execution references — at the top
 * level, on every capability descriptor AND (module-side) at every
 * nesting level of the descriptor parameters. The declaration carries NO
 * execution, NO workflow, NO deployment and NO tenant data: every
 * mutation route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the agency ownership for agency-scoped
 * registration, the record's own immutable scope for record-scoped
 * operations), authorizes against the SAME /agencies membership authority
 * as every other scoped check (no second authorization authority) and
 * rejects every server-derived authority field caller-side. Foreign
 * agency-scoped identifiers yield a UNIFORM 404 (no cross-tenant
 * oracle).
 */

import { NotFoundError, ForbiddenError } from '../platform/errors/errors.ts';
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
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import type { AgencyRoleKey } from '../modules/agencies/public.ts';
import { requirePlatformAdministrator, requireAgencyAccess, resolveContext } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  LogicalAgentLifecycleEventRecord,
  LogicalAgentRecord,
} from '../modules/agents/public.ts';
import {
  AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS,
  LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS,
} from '../modules/agents/public.ts';

const VERSION_MAX = Number.MAX_SAFE_INTEGER;

/** Fields always server-derived on logical agent RETIRE (authority fields). */
const LOGICAL_AGENT_RETIRE_AUTHORITY_FIELDS = [
  'agentId',
  'agentKey',
  'displayName',
  'versionLabel',
  'description',
  'capabilities',
  'scopeKind',
  'agencyId',
  'status',
  'idempotencyKey',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  'lifecycleEvents',
  // The provider-neutrality + no-infrastructure-coupling guard applies to
  // every mutation surface, retire included.
  'provider',
  'model',
  'modelId',
  'sdk',
  'adapter',
  'credential',
  'secret',
  'apiKey',
  'token',
  'password',
  'sandboxId',
  'poolId',
  'queueId',
  'runtimeClass',
  'deploymentId',
  'executionId',
  'workflowId',
  'clientId',
  'workspaceId',
  'goalId',
] as const;

// ---------------------------------------------------------------------------
// Serialization (opaque, non-secret registry representations)
// ---------------------------------------------------------------------------

function serializeAgent(agent: LogicalAgentRecord): Record<string, unknown> {
  return {
    agentId: agent.agentId,
    agentKey: agent.agentKey,
    displayName: agent.displayName,
    versionLabel: agent.versionLabel,
    description: agent.description,
    capabilities: agent.capabilities,
    scopeKind: agent.scopeKind,
    ...(agent.agencyId === null ? {} : { agencyId: agent.agencyId }),
    status: agent.status,
    idempotencyKey: agent.idempotencyKey,
    version: agent.version,
    ...(agent.createdBy === null ? {} : { createdBy: agent.createdBy }),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function serializeLifecycleEvent(event: LogicalAgentLifecycleEventRecord): Record<string, unknown> {
  return {
    eventId: event.eventId,
    agentId: event.agentId,
    transition: event.transition,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    ...(event.reason === '' ? {} : { reason: event.reason }),
    ...(event.createdBy === null ? {} : { createdBy: event.createdBy }),
    createdAt: event.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAgentsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('agents.api');

  /**
   * The shared provider-neutral registration DTO spec (AGENT-001): the
   * top-level forbidden-key contract plus the capability-descriptor
   * contract — a descriptor is EXACTLY { capabilityKind, parameters }
   * with the descriptor-level forbidden-key contract. The module guard
   * additionally walks EVERY nesting level of parameters.
   */
  function registrationSpec() {
    return {
      forbiddenKeys: LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS,
      fields: {
        agentKey: stringField({ minLength: 2, maxLength: 100 }),
        displayName: stringField({ minLength: 1, maxLength: 200 }),
        versionLabel: stringField({ minLength: 1, maxLength: 64 }),
        description: stringField({ minLength: 1, maxLength: 2000 }),
        capabilities: arrayField({
          minItems: 1,
          maxItems: 64,
          item: objectField({
            forbiddenKeys: AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS,
            fields: {
              capabilityKind: stringField({ minLength: 2, maxLength: 64 }),
              parameters: recordField({ maxDepthKeys: 64 }),
            },
          }),
        }),
        idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
      },
    };
  }

  /**
   * Agent-scoped access check (the requireTaskProfileAccess pattern):
   * load the durable record first (uniform 404 — retired history stays
   * readable), then authorize against the record's OWN immutable scope:
   *   - platform-scoped declarations: any authenticated principal reads
   *     (catalog data); `roles` (mutation surfaces) requires the
   *     platform administrator;
   *   - agency-scoped declarations: authorize against the OWNING
   *     agency's durable membership chain (the same authority as every
   *     other scoped check). A caller with NO membership in the owning
   *     agency gets the SAME 404 as for an unknown agent — a foreign
   *     agent identifier is not a traversal/existence oracle. An agent
   *     ID is NEVER an authorization credential — it only selects WHICH
   *     durable ownership chain gets resolved.
   */
  async function requireAgentAccess(
    principal: Principal,
    agentId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<LogicalAgentRecord> {
    const agent = await modules.agents.getAgent(agentId);
    if (agent === null) {
      throw new NotFoundError('agent', agentId);
    }
    if (agent.scopeKind === 'platform') {
      // Platform catalog: reads are any-authenticated (the authenticator
      // already ran); mutations are platform-administrator only.
      if (roles !== undefined) {
        await requirePlatformAdministrator(modules, principal);
      }
      return agent;
    }
    if (principal.kind === 'service') return agent;
    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    if (context.platformRoles.includes('platform_administrator')) return agent;
    const membership = context.memberships.find((entry) => entry.agencyId === agent.agencyId);
    if (membership === undefined) {
      // Hard boundary: not a member of the owning agency → the same 404
      // as an unknown agent (uniform, no cross-tenant oracle).
      throw new NotFoundError('agent', agentId);
    }
    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenError('Active membership in the owning agency required');
    }
    if (roles !== undefined && !roles.includes(membership.role)) {
      throw new ForbiddenError('This operation requires a different agency role');
    }
    return agent;
  }

  /**
   * Canonical agency owner scope for agency-scoped registration: resolved
   * from durable state BEFORE authorize/validate/execute
   * (implementation-contract §2). Unknown agency → uniform 404.
   */
  async function agencyOwner(agencyId: string): Promise<OwnerScope> {
    const agency = await modules.agencies.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    return { kind: 'agency', agencyId };
  }

  // -------------------------------------------------------------------------
  // Platform-scoped logical agents (the platform capability catalog)
  // -------------------------------------------------------------------------

  // POST /api/agents — register a PLATFORM-scoped logical agent (the
  // model-registry posture: platform-normalized data, platform admin
  // only). The §8-style idempotency key is REQUIRED: a duplicate of the
  // same logical command converges (201 fresh / 200 replayed); a key
  // reused for a different command is a 409.
  router.add(
    'POST',
    '/api/agents',
    defineMutationRoute<Record<string, string>, { agent: LogicalAgentRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, registrationSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as Record<string, unknown>;
        return modules.agents.registerAgent({
          scope: { agencyId: null },
          agent: {
            agentKey: body['agentKey'] as string,
            displayName: body['displayName'] as string,
            versionLabel: body['versionLabel'] as string,
            description: body['description'] as string,
            capabilities: body['capabilities'] as {
              capabilityKind: string;
              parameters: Record<string, unknown>;
            }[],
          },
          idempotencyKey: body['idempotencyKey'] as string,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('agents.logical_agent.registered', undefined, {
          agent_id: ctx.result.agent.agentId,
          agent_key: ctx.result.agent.agentKey,
          scope: ctx.result.agent.scopeKind,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'agents.logical_agent.registered',
          targetType: 'logical_agent',
          targetId: ctx.result.agent.agentId,
          afterVersion: ctx.result.agent.version,
          idempotencyKey: `agents.logical_agent.registered:${ctx.result.agent.agentId}`,
          details: { agentKey: ctx.result.agent.agentKey, replayed: ctx.result.replayed },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          agent: serializeAgent(ctx.result.agent),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // GET /api/agents — the ACTIVE platform-scoped declarations (catalog
  // data: any authenticated principal — the same posture as the model
  // registry surface).
  router.add(
    'GET',
    '/api/agents',
    defineQueryRoute<Record<string, string>, readonly LogicalAgentRecord[]>({
      authenticator: services.auth,
      execute: async () => modules.agents.listAgents({ agencyId: null, includeRetired: false }),
      respond: (ctx) =>
        jsonResponse(200, { agents: ctx.result.map(serializeAgent) }),
    }),
  );

  // GET /api/agents/:agentId — read one (retired history stays visible;
  // uniform 404 for foreign agency-scoped/unknown identifiers).
  router.add(
    'GET',
    '/api/agents/:agentId',
    defineQueryRoute<{ agentId: string }, LogicalAgentRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgentAccess(ctx.principal, ctx.params.agentId);
      },
      execute: async (ctx) => {
        const agent = await modules.agents.getAgent(ctx.params.agentId);
        if (agent === null) {
          throw new NotFoundError('agent', ctx.params.agentId);
        }
        return agent;
      },
      respond: (ctx) => jsonResponse(200, serializeAgent(ctx.result)),
    }),
  );

  // POST /api/agents/:agentId/retire — the single lifecycle edge
  // (active → retired, terminal), CAS on the presented version.
  router.add(
    'POST',
    '/api/agents/:agentId/retire',
    defineMutationRoute<{ agentId: string }, LogicalAgentRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const agent = await modules.agents.getAgent(params.agentId);
        if (agent === null) {
          throw new NotFoundError('agent', params.agentId);
        }
        return agent.scopeKind === 'platform'
          ? { kind: 'platform' }
          : { kind: 'agency', agencyId: agent.agencyId as string };
      },
      authorize: async (ctx) => {
        await requireAgentAccess(ctx.principal, ctx.params.agentId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ version: number; reason?: string }>(ctx.request.body, {
          forbiddenKeys: LOGICAL_AGENT_RETIRE_AUTHORITY_FIELDS,
          fields: {
            version: intField({ min: 1, max: VERSION_MAX }),
            reason: optionalString({ minLength: 0, maxLength: 512 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { version: number; reason?: string };
        return modules.agents.retireAgent({
          agentId: ctx.params.agentId,
          expectedVersion: body.version,
          reason: body.reason ?? '',
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('agents.logical_agent.retired', undefined, {
          agent_id: ctx.result.agentId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'agents.logical_agent.retired',
          targetType: 'logical_agent',
          targetId: ctx.result.agentId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `agents.logical_agent.retired:${ctx.result.agentId}:${ctx.result.version}`,
          details: { agentKey: ctx.result.agentKey },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeAgent(ctx.result)),
    }),
  );

  // GET /api/agents/:agentId/lifecycle-events — the append-only lifecycle
  // history, oldest first (same access posture as the read).
  router.add(
    'GET',
    '/api/agents/:agentId/lifecycle-events',
    defineQueryRoute<{ agentId: string }, readonly LogicalAgentLifecycleEventRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgentAccess(ctx.principal, ctx.params.agentId);
      },
      execute: async (ctx) => {
        const agent = await modules.agents.getAgent(ctx.params.agentId);
        if (agent === null) {
          throw new NotFoundError('agent', ctx.params.agentId);
        }
        return modules.agents.listLifecycleEvents(ctx.params.agentId);
      },
      respond: (ctx) =>
        jsonResponse(200, { lifecycleEvents: ctx.result.map(serializeLifecycleEvent) }),
    }),
  );

  // -------------------------------------------------------------------------
  // Agency-scoped logical agents (reusable operational IP of one Agency)
  // -------------------------------------------------------------------------

  // POST /api/agencies/:agencyId/agents — register an AGENCY-scoped
  // logical agent (owner|admin|platform admin). The §8-style idempotency
  // key is REQUIRED; the (scope, agent_key) ACTIVE fence is a
  // deterministic 409, freed by retirement.
  router.add(
    'POST',
    '/api/agencies/:agencyId/agents',
    defineMutationRoute<{ agencyId: string }, { agent: LogicalAgentRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => agencyOwner(params.agencyId),
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, registrationSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as Record<string, unknown>;
        return modules.agents.registerAgent({
          scope: { agencyId: ctx.params.agencyId },
          agent: {
            agentKey: body['agentKey'] as string,
            displayName: body['displayName'] as string,
            versionLabel: body['versionLabel'] as string,
            description: body['description'] as string,
            capabilities: body['capabilities'] as {
              capabilityKind: string;
              parameters: Record<string, unknown>;
            }[],
          },
          idempotencyKey: body['idempotencyKey'] as string,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('agents.logical_agent.registered', undefined, {
          agent_id: ctx.result.agent.agentId,
          agent_key: ctx.result.agent.agentKey,
          scope: ctx.result.agent.scopeKind,
          agency_id: ctx.result.agent.agencyId,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'agents.logical_agent.registered',
          targetType: 'logical_agent',
          targetId: ctx.result.agent.agentId,
          afterVersion: ctx.result.agent.version,
          idempotencyKey: `agents.logical_agent.registered:${ctx.result.agent.agentId}`,
          details: { agentKey: ctx.result.agent.agentKey, replayed: ctx.result.replayed },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          agent: serializeAgent(ctx.result.agent),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // GET /api/agencies/:agencyId/agents — the agency's declarations in
  // EVERY lifecycle state (retired history stays visible), oldest first.
  router.add(
    'GET',
    '/api/agencies/:agencyId/agents',
    defineQueryRoute<{ agencyId: string }, readonly LogicalAgentRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        // The agency owner is resolved from durable state inside the
        // authorize step (query routes have no separate owner step —
        // requireAgencyAccess 404s an unknown agency BEFORE the list).
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) =>
        modules.agents.listAgents({ agencyId: ctx.params.agencyId, includeRetired: true }),
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          agents: ctx.result.map(serializeAgent),
        }),
    }),
  );

}
