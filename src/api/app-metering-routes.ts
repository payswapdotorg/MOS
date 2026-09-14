/**
 * /api/app-metering/* routes (MKT-052 — App Metering and Commercial
 * Attribution: the GET-only derived attribution read models).
 *
 *   GET  /api/app-metering/workspaces/:workspaceId     the WORKSPACE attribution view (any active member of the owning agency)
 *   GET  /api/app-metering/agencies/:agencyId          the AGENCY attribution view — the portfolio rollup: per app, per publisher, per period, totals (any active member of the agency)
 *   GET  /api/app-metering/publishers/:userId          the PUBLISHER attribution view — the commercial rollup of one platform developer's apps, per app + per period only, NO tenant identities (the publisher themself, a platform administrator, or the service principal)
 *
 * READ-ONLY BY CONSTRUCTION (AC-4: marketplace attribution is SEPARATE
 * from the core financial authority — mos-app-ecosystem-v1.5.md
 * "Economics"): exactly three GETs, no body, no DTO, no query
 * parameters — the surface is a read model, so a frontend bypass has
 * nothing to drive. NO POST/PUT/PATCH/DELETE route exists anywhere in
 * this family (asserted by
 * tests/architecture/app-metering-boundary.test.ts): the metering
 * collection, usage-observation ingestion and rollup recompute are
 * MODULE-LEVEL operations for server-side callers (the operating-graph
 * rebuild precedent — background workers and later v1.5 Work Items),
 * NEVER an HTTP mutation surface. The module exposes ZERO
 * billing/charging methods of any kind — no invoices, no payments, no
 * balance mutations, no prices (the architecture-lock financial-authority
 * separation).
 *
 * Server-derived scope posture (implementation-contract §3/§23; the
 * profit-intelligence precedent): every view resolves the caller's
 * authorization context and the canonical scope from durable state
 * BEFORE the module call; the path identifiers only SELECT which durable
 * scope gets resolved (a caller-supplied identifier is never
 * authorization). Uniform 404 for foreign/unknown/malformed
 * workspace/agency/publisher identifiers (no existence oracle); a
 * suspended membership or disabled identity is the 403; anonymous calls
 * fail closed 401 at the authenticator. The publisher view is
 * cross-tenant by design (the commercial rollup of the publisher's own
 * apps): the caller must BE the publisher (an active platform user) or a
 * platform administrator/service principal, and the view exposes NO
 * tenant identifiers (per app and per period aggregates only).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import { jsonResponse, defineQueryRoute } from '../platform/http/pipeline.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { ApplicationModules } from './application.ts';
import { resolveContext } from './authorize.ts';
import { requireWorkspaceAccess } from './authorize.ts';
import type {
  AgencyAppMeteringView,
  AppMeteringAppAttribution,
  AppMeteringDimensionAggregate,
  PublisherAppMeteringView,
  WorkspaceAppMeteringView,
} from '../modules/app-metering/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agency-scoped attribution posture (the profit-intelligence
 * requireProfitIntelligenceAgency pattern): the durable agency row and
 * the caller's membership in THAT agency resolve from durable state
 * BEFORE the module call. A malformed, unknown or FOREIGN agency
 * identifier is the uniform 404 (cross-agency data must 404, not
 * 403-leak existence); a caller with an ACTIVE membership passes (any
 * agency role — the read posture); a suspended membership or a disabled
 * identity is the 403.
 */
async function requireMeteringAgency(
  modules: ApplicationModules,
  principal: Principal,
  agencyId: string,
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
}

/**
 * The publisher-scoped attribution posture: the path userId names the
 * platform developer whose publisher identity ('dev:<userId>') the view
 * rolls up. The caller must BE that developer (an active platform user —
 * the server derives the publisher identity from the AUTHENTICATED
 * principal, never from the request) or a platform administrator / the
 * service principal. A malformed, unknown or FOREIGN publisher
 * identifier is the uniform 404 (no platform-wide publisher directory
 * oracle); a disabled identity is the 403.
 */
async function requireMeteringPublisher(
  modules: ApplicationModules,
  principal: Principal,
  publisherUserId: string,
): Promise<void> {
  if (!UUID_PATTERN.test(publisherUserId)) {
    // A malformed identifier is indistinguishable from an unknown one.
    throw new NotFoundError('publisher', publisherUserId);
  }

  if (principal.kind === 'service') return;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return;
  if (principal.kind === 'user' && principal.userId !== publisherUserId) {
    // A foreign publisher id is indistinguishable from an unknown one.
    throw new NotFoundError('publisher', publisherUserId);
  }
}

// ---------------------------------------------------------------------------
// Serialization — the attribution response vocabulary (presentation only;
// every field of the derived view ships, nothing invented)
// ---------------------------------------------------------------------------

function serializeDimensionAggregate(
  aggregate: AppMeteringDimensionAggregate,
): Record<string, unknown> {
  return {
    dimension: aggregate.dimension,
    unit: aggregate.unit,
    quantity: aggregate.quantity,
    eventCount: aggregate.eventCount,
  };
}

function serializeAppAttribution(app: AppMeteringAppAttribution): Record<string, unknown> {
  return {
    appKey: app.appKey,
    ...(app.publisher === null ? {} : { publisher: app.publisher }),
    dimensions: app.dimensions.map(serializeDimensionAggregate),
    currentSelectionCount: app.currentSelectionCount,
  };
}

function serializeCalculation(
  view: Pick<WorkspaceAppMeteringView, 'calculation'>,
): Record<string, unknown> {
  return {
    calculationVersion: view.calculation.calculationVersion,
    vocabularyVersion: view.calculation.vocabularyVersion,
    assumptions: view.calculation.assumptions,
    basis: view.calculation.basis,
    persistence: view.calculation.persistence,
  };
}

function serializeUnattributed(
  view: Pick<WorkspaceAppMeteringView, 'unattributedInvocations'>,
): Record<string, unknown> {
  return {
    count: view.unattributedInvocations.count,
    policy: view.unattributedInvocations.policy,
    reason: view.unattributedInvocations.reason,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAppMeteringRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  // -------------------------------------------------------------------------
  // GET /api/app-metering/workspaces/:workspaceId — the WORKSPACE
  // attribution view (the derived read model LIVE over the own tail).
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/app-metering/workspaces/:workspaceId',
    defineQueryRoute<{ workspaceId: string }, WorkspaceAppMeteringView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        // A malformed identifier is indistinguishable from an unknown one
        // (the profit-intelligence uniform-404 posture) BEFORE the
        // canonical ownership resolution runs.
        if (!UUID_PATTERN.test(ctx.params.workspaceId)) {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        // The uniform 404 for unknown/FOREIGN workspaces comes from the
        // canonical ownership resolution (requireWorkspaceAccess).
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.appMetering.getWorkspaceAppMetering(ctx.params.workspaceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          scope: ctx.result.scope,
          totals: ctx.result.totals.map(serializeDimensionAggregate),
          perApp: ctx.result.perApp.map(serializeAppAttribution),
          unattributedInvocations: serializeUnattributed(ctx.result),
          calculation: serializeCalculation(ctx.result),
          generatedAt: ctx.result.generatedAt,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/app-metering/agencies/:agencyId — the AGENCY attribution view
  // (the portfolio rollup: per app, per publisher, per period, totals).
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/app-metering/agencies/:agencyId',
    defineQueryRoute<{ agencyId: string }, AgencyAppMeteringView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMeteringAgency(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.appMetering.getAgencyAppMetering(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          scope: ctx.result.scope,
          totals: ctx.result.totals.map(serializeDimensionAggregate),
          perApp: ctx.result.perApp.map(serializeAppAttribution),
          perPublisher: ctx.result.perPublisher.map((row) => ({
            publisher: row.publisher,
            appKeys: row.appKeys,
            dimensions: row.dimensions.map(serializeDimensionAggregate),
          })),
          perPeriod: ctx.result.perPeriod.map((row) => ({
            periodStart: row.periodStart,
            dimensions: row.dimensions.map(serializeDimensionAggregate),
          })),
          unattributedInvocations: serializeUnattributed(ctx.result),
          calculation: serializeCalculation(ctx.result),
          generatedAt: ctx.result.generatedAt,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/app-metering/publishers/:userId — the PUBLISHER attribution
  // view (the commercial rollup of one platform developer's apps; NO
  // tenant identities surface).
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/app-metering/publishers/:userId',
    defineQueryRoute<{ userId: string }, PublisherAppMeteringView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMeteringPublisher(modules, ctx.principal, ctx.params.userId);
      },
      execute: async (ctx) => {
        return modules.appMetering.getPublisherAppMetering(`dev:${ctx.params.userId}`);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          scope: ctx.result.scope,
          totals: ctx.result.totals.map(serializeDimensionAggregate),
          perApp: ctx.result.perApp.map(serializeAppAttribution),
          perPeriod: ctx.result.perPeriod.map((row) => ({
            periodStart: row.periodStart,
            dimensions: row.dimensions.map(serializeDimensionAggregate),
          })),
          unattributedInvocations: serializeUnattributed(ctx.result),
          calculation: serializeCalculation(ctx.result),
          generatedAt: ctx.result.generatedAt,
        }),
    }),
  );
}
