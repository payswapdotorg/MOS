/**
 * /ai-operator API routes (MKT-045 — AI Operator / Attention Queue).
 *
 *   GET    /api/ai-operator/:agencyId/attention-queue                              the Agency's ranked attention queue
 *   GET    /api/ai-operator/:agencyId/attention-queue/:itemId                      one attention item (deterministic id) in queue context
 *   GET    /api/ai-operator/:agencyId/clients/:clientId/attention-queue            the Client's attention queue slice
 *
 * Authority composition (the frozen boundary — this file is a THIN
 * delegation layer over the /ai-operator module's public contract, the
 * MKT-043 profit-intelligence precedent):
 *
 *   - AGENCY-SCOPED, SERVER-DERIVED SCOPE: the route authorizes the agency
 *     principal against the SAME durable-membership authority as every
 *     agency-scoped surface (users + agency memberships resolved FRESH from
 *     durable state — headers, body fields or client-side claims are never
 *     trusted). The agency existence and the caller's membership resolve
 *     from durable state BEFORE any dependent traversal; the path agencyId
 *     only SELECTS which durable agency scope gets resolved (§14: a
 *     caller-supplied identifier is never authorization);
 *   - THE HARD TENANT BOUNDARY: a caller with NO membership in the OWNING
 *     agency gets the UNIFORM 404 — a foreign agency identifier is
 *     indistinguishable from an unknown or malformed one (no
 *     existence/traversal oracle). A SUSPENDED membership or disabled
 *     identity is the 403 (an authenticated-but-intra-tenant failure, the
 *     house posture); anonymous calls are 401 (fail closed). The client
 *     detail selector resolves against the agency's OWN live-client
 *     listing — a foreign identifier is the SAME uniform 404; an attention
 *     item id is resolved by RE-DERIVING the agency queue (nothing is
 *     stored), so an item of ANOTHER agency is simply absent → the same
 *     uniform 404 (foreign ≡ unknown ≡ malformed);
 *   - SERVER-SIDE AGENCY SCOPING BEFORE TRAVERSAL: the aggregation scope
 *     (the agency's LIVE clients + the agency's ACTIVE human_agent
 *     membership users) is resolved from durable state at the route layer
 *     (/clients, /agencies public contracts) and handed to the module as
 *     SERVER-DERIVED aggregation inputs (the scope-as-data posture). A
 *     client identifier is never accepted from the caller beyond the path
 *     SELECTORS, which are re-validated against durable state;
 *   - READ-ONLY BY CONSTRUCTION (§7: "Consequential actions continue
 *     through the existing policy/approval contracts"): the surface
 *     registers EXACTLY THREE routes and all are GETs — no mutating verb
 *     is registered anywhere in this file (the router 405s
 *     POST/PUT/PATCH/DELETE on the paths), the routes read NO request
 *     body, validate NO DTO, read NO query parameter, and no authority
 *     field (agency/client identifiers, item ids, categories, scores,
 *     assumptions, rank version) can be supplied by the caller at all.
 *     The AI Operator ranks action candidates; every consequential action
 *     flows through the EXISTING policy/approval contracts on their own
 *     surfaces — there is no HTTP write path into any authority, so a
 *     frontend bypass has nothing to drive;
 *   - the response discloses the ranking honestly: every item carries its
 *     category, deterministic priority score, source references, structured
 *     rationale, the action-contract REFERENCE it would flow through and
 *     the assumption keys its score consumed; the full frozen assumption
 *     record ships in every response (no hidden constants).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { jsonResponse, defineQueryRoute } from '../platform/http/pipeline.ts';
import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { ApplicationModules } from './application.ts';
import { resolveContext } from './authorize.ts';
import type {
  AgencyAttentionQueueView,
  AttentionCategoryCounts,
  AttentionItem,
  AttentionItemDetailView,
  AttentionRationale,
  AttentionSourceRef,
  ClientAttentionQueueView,
  RankingDisclosure,
} from '../modules/ai-operator/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agency-scoped ai-operator posture (the profit-intelligence
 * posture): the durable agency row and the caller's membership in THAT
 * agency resolve from durable state BEFORE any dependent traversal. A
 * malformed, unknown or FOREIGN agency identifier is the uniform 404
 * (cross-agency data must 404, not 403-leak existence); a caller with an
 * ACTIVE membership passes (any agency role — the read posture of every
 * agency-scoped read surface); a suspended membership or a disabled
 * identity is the 403.
 */
async function requireAiOperatorAgency(
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
    // Hard boundary: not a member of the OWNING agency → the same 404 as
    // for an unknown agency (uniform, no cross-agency existence oracle).
    throw new NotFoundError('agency', agencyId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in this agency required');
  }
}

/**
 * The client-detail selector posture: the path clientId must be one of the
 * OWNING agency's live Clients (resolved FRESH from durable state) — a
 * foreign, unknown or malformed Client identifier is the uniform 404.
 */
async function requireClientInAgency(
  modules: ApplicationModules,
  agencyId: string,
  clientId: string,
): Promise<void> {
  if (!UUID_PATTERN.test(clientId)) {
    // A malformed identifier is indistinguishable from an unknown one.
    throw new NotFoundError('client', clientId);
  }
  const clients = await modules.clients.listClientsForAgency(agencyId);
  const match = clients.find((client) => client.clientId === clientId);
  if (match === undefined) {
    // Hard boundary: the Client belongs to another agency (or is unknown) —
    // the same 404 as an unknown client (no cross-agency existence oracle).
    throw new NotFoundError('client', clientId);
  }
}

/**
 * Resolves the server-derived agency aggregation scope: the agency's LIVE
 * clients and ACTIVE human_agent membership users (the capacity pool +
 * the jobs enumeration window) from durable state. A client or human
 * identifier is never accepted from the caller; cross-agency data is
 * structurally unreachable because both listings are scoped to the
 * authorized agency.
 */
async function resolveAgencyScope(modules: ApplicationModules, agencyId: string): Promise<{
  readonly clients: ReadonlyArray<{ readonly clientId: string }>;
  readonly humanAgentUserIds: readonly string[];
}> {
  const clients = await modules.clients.listClientsForAgency(agencyId);
  const memberships = await modules.agencies.listMemberships(agencyId);
  const humanAgentUserIds = memberships
    .filter(
      (membership) => membership.role === 'human_agent' && membership.status === 'active',
    )
    .map((membership) => membership.userId);
  return { clients: clients.map((client) => ({ clientId: client.clientId })), humanAgentUserIds };
}

// ---------------------------------------------------------------------------
// Serialization — the ai-operator response vocabulary (presentation only;
// every field of the derived view ships, nothing invented)
// ---------------------------------------------------------------------------

function serializeSourceRef(ref: AttentionSourceRef): Record<string, unknown> {
  return { kind: ref.kind, id: ref.id };
}

function serializeRationale(rationale: AttentionRationale): Record<string, unknown> {
  return {
    headline: rationale.headline,
    factors: rationale.factors.map((entry) => ({ key: entry.key, value: entry.value })),
  };
}

function serializeItem(item: AttentionItem): Record<string, unknown> {
  return {
    itemId: item.itemId,
    category: item.category,
    scope: {
      agencyId: item.scope.agencyId,
      clientId: item.scope.clientId,
      workspaceId: item.scope.workspaceId,
    },
    priorityScore: item.priorityScore,
    rank: item.rank,
    sourceRefs: item.sourceRefs.map(serializeSourceRef),
    rationale: serializeRationale(item.rationale),
    actionContract: {
      kind: item.actionContract.kind,
      surface: item.actionContract.surface,
      policyDimension: item.actionContract.policyDimension,
      policyScopeKind: item.actionContract.policyScopeKind,
      targetRef: serializeSourceRef(item.actionContract.targetRef),
      note: item.actionContract.note,
    },
    scoreAssumptionKeys: [...item.scoreAssumptionKeys],
  };
}

function serializeRanking(ranking: RankingDisclosure): Record<string, unknown> {
  return {
    rankVersion: ranking.rankVersion,
    categoryVocabularyVersion: ranking.categoryVocabularyVersion,
    assumptions: ranking.assumptions,
    sortRule: ranking.sortRule,
    basis: ranking.basis,
    persistence: ranking.persistence,
    consumedProfitIntelligenceVersion: ranking.consumedProfitIntelligenceVersion,
  };
}

function serializeCounts(counts: AttentionCategoryCounts): Record<string, unknown> {
  return { ...counts };
}

function serializeAgencyView(view: AgencyAttentionQueueView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientCount: view.scope.clientCount,
      humanAgentCount: view.scope.humanAgentCount,
    },
    items: view.items.map(serializeItem),
    counts: serializeCounts(view.counts),
    ranking: serializeRanking(view.ranking),
    generatedAt: view.generatedAt,
  };
}

function serializeClientView(view: ClientAttentionQueueView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientId: view.scope.clientId,
      workspaceCount: view.scope.workspaceCount,
    },
    items: view.items.map(serializeItem),
    counts: serializeCounts(view.counts),
    scopeExclusions: view.scopeExclusions.map((entry) => ({
      category: entry.category,
      reason: entry.reason,
    })),
    ranking: serializeRanking(view.ranking),
    generatedAt: view.generatedAt,
  };
}

function serializeDetailView(view: AttentionItemDetailView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
    },
    item: serializeItem(view.item),
    totalItemCount: view.totalItemCount,
    categoryCounts: serializeCounts(view.categoryCounts),
    ranking: serializeRanking(view.ranking),
    generatedAt: view.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAiOperatorRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  // -------------------------------------------------------------------------
  // GET /api/ai-operator/:agencyId/attention-queue — THE AGENCY'S RANKED
  // ATTENTION QUEUE (every live-derived item across the agency's LIVE
  // clients: blocked work, approvals, client risk, anomalies, scope
  // leakage, margin pressure, the agency capacity constraint and
  // opportunities, ranked by the frozen ao-rank-v1 rules). READ-ONLY by
  // construction: the scope is server-derived from the authenticated
  // identity + durable agency/membership + live-client state.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/ai-operator/:agencyId/attention-queue',
    defineQueryRoute<{ agencyId: string }, AgencyAttentionQueueView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAiOperatorAgency(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline (the house
        // posture of the other read surfaces).
        await requireAiOperatorAgency(modules, ctx.principal, ctx.params.agencyId);

        const { clients, humanAgentUserIds } = await resolveAgencyScope(
          modules,
          ctx.params.agencyId,
        );
        return modules.aiOperator.getAgencyAttentionQueue({
          agencyId: ctx.params.agencyId,
          clients,
          humanAgentUserIds,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeAgencyView(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/ai-operator/:agencyId/attention-queue/:itemId — ONE ATTENTION
  // ITEM in its queue context. The item id is DETERMINISTIC
  // (ao:<category>:<kind>:<id>…) and resolves by RE-DERIVING the agency
  // queue (nothing is stored): an unknown, malformed or FOREIGN item id
  // (an item of another agency's queue) is simply absent → the SAME
  // uniform 404 (no existence oracle). No item field is ever caller input.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/ai-operator/:agencyId/attention-queue/:itemId',
    defineQueryRoute<{ agencyId: string; itemId: string }, AttentionItemDetailView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAiOperatorAgency(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        await requireAiOperatorAgency(modules, ctx.principal, ctx.params.agencyId);

        const { clients, humanAgentUserIds } = await resolveAgencyScope(
          modules,
          ctx.params.agencyId,
        );
        return modules.aiOperator.getAttentionItem({
          agencyId: ctx.params.agencyId,
          itemId: ctx.params.itemId,
          clients,
          humanAgentUserIds,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetailView(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/ai-operator/:agencyId/clients/:clientId/attention-queue — THE
  // CLIENT'S ATTENTION QUEUE (the client-scoped slice: this Client's
  // blocked work, its client-scoped approvals, risk, anomalies, leakage,
  // margin and opportunities; the agency-pool capacity-constraint item is
  // excluded with a disclosed reason). The path Client is validated
  // against the agency's OWN live clients: a Client of another agency is
  // the SAME uniform 404 (no cross-agency existence oracle), and the
  // module re-resolves canonical ownership before any dependent traversal.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/ai-operator/:agencyId/clients/:clientId/attention-queue',
    defineQueryRoute<{ agencyId: string; clientId: string }, ClientAttentionQueueView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAiOperatorAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        await requireAiOperatorAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);

        const memberships = await modules.agencies.listMemberships(ctx.params.agencyId);
        const humanAgentUserIds = memberships
          .filter(
            (membership) => membership.role === 'human_agent' && membership.status === 'active',
          )
          .map((membership) => membership.userId);
        return modules.aiOperator.getClientAttentionQueue({
          clientId: ctx.params.clientId,
          humanAgentUserIds,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeClientView(ctx.result)),
    }),
  );
}
