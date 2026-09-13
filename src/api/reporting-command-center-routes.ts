/**
 * /reporting AGENCY COMMAND CENTER API routes (MKT-029 — UI-001,
 * UI-AC-01..02: the authoritative read surface an agency-side command-center
 * frontend consumes: PORTFOLIO GOALS, WORKFLOW STATE, EVIDENCE QUALITY,
 * RISKS and PENDING APPROVALS over authoritative backend state, across the
 * agency's authorized client portfolio).
 *
 *   GET    /api/reporting/command-center/:agencyId    the Agency Command Center — the live-aggregated view
 *
 * Authority composition (the frozen boundary — this file is a THIN
 * delegation layer over the SAME /reporting module's public contract, the
 * MKT-030 decision-room precedent: one authority, multiple route families;
 * the module is wired ONCE in the composition root and this family only
 * registers routes against it):
 *
 *   - AGENCY-SCOPED, SERVER-DERIVED SCOPE: the route authorizes the agency
 *     principal against the SAME durable-membership authority as every
 *     agency-scoped surface (users + agency memberships resolved FRESH from
 *     durable state — headers, body fields or client-side claims are never
 *     trusted). The agency existence and the caller's membership resolve
 *     from durable state BEFORE any dependent traversal; the path agencyId
 *     only SELECTS which durable agency scope gets resolved (§23: a
 *     caller-supplied identifier is never authorization);
 *   - THE HARD TENANT BOUNDARY (the work-item requirement: cross-agency
 *     data must 404, not 403-leak existence): a caller with NO membership
 *     in the OWNING agency gets the UNIFORM 404 — a foreign agency
 *     identifier is indistinguishable from an unknown or malformed one (no
 *     existence/traversal oracle; the requireAgentAccess posture for
 *     agency-scoped records). A SUSPENDED membership or disabled identity
 *     is the 403 (an authenticated-but-intra-tenant failure, the house
 *     posture); anonymous calls are 401 (fail closed);
 *   - SERVER-SIDE AGENCY SCOPING BEFORE TRAVERSAL: the aggregation scope
 *     (the agency's LIVE clients + each client's Workspaces) is resolved
 *     from durable state at the route layer (/clients + /workspaces public
 *     contracts — matrix directions the /reporting module does not hold)
 *     and handed to the /reporting module as SERVER-DERIVED aggregation
 *     inputs (the decision-room scope-as-data posture). A workspace or
 *     client identifier is never accepted from the caller, so cross-agency
 *     data is structurally unreachable inside the composed view;
 *   - READ-ONLY BY CONSTRUCTION: the surface registers EXACTLY ONE route
 *     and it is a GET — no mutating verb is registered anywhere in this
 *     file (the router 405s POST/PUT/PATCH/DELETE on the path), the route
 *     reads NO request body, validates NO DTO, and no authority field
 *     (agency/client/workspace identifiers, statuses, provenance) can be
 *     supplied by the caller at all. UI-AC-02: a frontend bypass cannot
 *     change authorization or workflow outcomes — there is nothing to
 *     drive;
 *   - the response discloses the read-window bound honestly: the evidence
 *     quality posture tallies the /evidence authority's bounded public
 *     listing (its server-chosen newest-first window) per client, never an
 *     authoritative recount of an unbounded ledger.
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { jsonResponse, defineQueryRoute } from '../platform/http/pipeline.ts';
import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { ApplicationModules } from './application.ts';
import { resolveContext } from './authorize.ts';
import type { AgencyCommandCenterView } from '../modules/reporting/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agency-scoped command-center posture: the durable agency row and the
 * caller's membership in THAT agency resolve from durable state BEFORE any
 * dependent traversal. A malformed, unknown or FOREIGN agency identifier is
 * the uniform 404 (cross-agency data must 404, not 403-leak existence — a
 * foreign principal learns nothing about whether the agency exists); a
 * caller with an ACTIVE membership passes (any agency role — the read
 * posture of every agency-scoped read surface); a suspended membership or
 * a disabled identity is the 403.
 */
async function requireCommandCenterAgency(
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

// ---------------------------------------------------------------------------
// Serialization — the command-center response vocabulary (presentation only)
// ---------------------------------------------------------------------------

function serializeCommandCenter(view: AgencyCommandCenterView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientCount: view.scope.clientCount,
    },
    generatedAt: view.generatedAt,
    portfolioGoals: {
      goalStatusCounts: view.portfolioGoals.goalStatusCounts,
      goals: view.portfolioGoals.goals.map((goal) => ({
        goalId: goal.goalId,
        clientId: goal.clientId,
        ...(goal.workspaceId === null ? {} : { workspaceId: goal.workspaceId }),
        objective: goal.objective,
        status: goal.status,
        successCriteria: goal.successCriteria,
        metrics: goal.metrics,
        constraints: goal.constraints,
        ...(goal.timeHorizon === null ? {} : { timeHorizon: goal.timeHorizon }),
      })),
      perClient: view.portfolioGoals.perClient.map((tally) => ({
        clientId: tally.clientId,
        total: tally.total,
        goalStatusCounts: tally.goalStatusCounts,
      })),
    },
    workflowState: {
      instanceStatusCounts: view.workflowState.instanceStatusCounts,
      workflows: view.workflowState.workflows.map((workflow) => ({
        workflowId: workflow.workflowId,
        workspaceId: workflow.workspaceId,
        clientId: workflow.clientId,
        name: workflow.name,
        description: workflow.description,
        instanceCounts: workflow.instanceCounts,
        instances: workflow.instances.map((instance) => ({
          workflowInstanceId: instance.workflowInstanceId,
          workflowId: instance.workflowId,
          status: instance.status,
          createdAt: instance.createdAt,
          updatedAt: instance.updatedAt,
        })),
      })),
      perClient: view.workflowState.perClient.map((tally) => ({
        clientId: tally.clientId,
        total: tally.total,
        instanceStatusCounts: tally.instanceStatusCounts,
      })),
    },
    evidenceQuality: {
      totalRecords: view.evidenceQuality.totalRecords,
      lowGradeRecords: view.evidenceQuality.lowGradeRecords,
      // Honest disclosure: the posture tallies the /evidence authority's
      // bounded public listings (newest-first window per client), never an
      // unbounded recount of the append-only ledger.
      window: 'evidence-authority-bounded-newest-first-listing-per-client',
      byClass: view.evidenceQuality.byClass.map((posture) => ({
        class: posture.class,
        total: posture.total,
        gradeCounts: posture.gradeCounts,
      })),
      perClient: view.evidenceQuality.perClient.map((posture) => ({
        clientId: posture.clientId,
        totalRecords: posture.totalRecords,
        lowGradeRecords: posture.lowGradeRecords,
      })),
    },
    risks: {
      basis: view.risks.basis,
      summary: view.risks.summary,
      items: view.risks.items.map((item) => {
        if (item.kind === 'goal_risk_constraint') {
          return {
            kind: item.kind,
            goalId: item.goalId,
            clientId: item.clientId,
            description: item.description,
          };
        }
        if (item.kind === 'execution_failed') {
          return {
            kind: item.kind,
            executionId: item.executionId,
            clientId: item.clientId,
            workspaceId: item.workspaceId,
            updatedAt: item.updatedAt,
          };
        }
        return {
          kind: item.kind,
          executionId: item.executionId,
          clientId: item.clientId,
          workspaceId: item.workspaceId,
          status: item.status,
          updatedAt: item.updatedAt,
        };
      }),
    },
    pendingApprovals: {
      items: view.pendingApprovals.items.map((item) =>
        item.kind === 'experiment_awaiting_decision'
          ? {
              kind: item.kind,
              experimentId: item.experimentId,
              clientId: item.clientId,
              status: item.status,
              decisionTarget: item.decisionTarget,
              hypothesis: item.hypothesis,
            }
          : {
              kind: item.kind,
              workflowInstanceId: item.workflowInstanceId,
              workflowId: item.workflowId,
              clientId: item.clientId,
              instanceStatus: item.instanceStatus,
              updatedAt: item.updatedAt,
            },
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerReportingCommandCenterRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  // -------------------------------------------------------------------------
  // GET /api/reporting/command-center/:agencyId — THE AGENCY COMMAND CENTER
  // (UI-AC-01 — authoritative state): the live-aggregated view over the
  // composed authorities' public contracts. The ONLY route of this family:
  // the surface is READ-ONLY by construction (every other verb 405s at the
  // router; the route reads no body; the scope is server-derived from the
  // authenticated identity + durable agency/membership state — UI-AC-02).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/reporting/command-center/:agencyId',
    defineQueryRoute<{ agencyId: string }, AgencyCommandCenterView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireCommandCenterAgency(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline (the house
        // posture of the other read surfaces).
        await requireCommandCenterAgency(modules, ctx.principal, ctx.params.agencyId);

        // SERVER-DERIVED aggregation scope: the agency's LIVE clients (the
        // /clients public contract — tombstones excluded by the authority)
        // and each client's Workspace enumeration (the /workspaces public
        // contract). A client or workspace identifier is never accepted
        // from the caller; cross-agency data is structurally unreachable
        // because the listing itself is scoped to the authorized agency.
        const clients = await modules.clients.listClientsForAgency(ctx.params.agencyId);
        const clientScopes = [] as Array<{ clientId: string; workspaceIds: string[] }>;
        for (const client of clients) {
          const workspaces = await modules.workspaces.listWorkspacesForClient(client.clientId);
          clientScopes.push({
            clientId: client.clientId,
            workspaceIds: workspaces.map((workspace) => workspace.workspaceId),
          });
        }
        return modules.reporting.getAgencyCommandCenter({
          agencyId: ctx.params.agencyId,
          clients: clientScopes,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeCommandCenter(ctx.result)),
    }),
  );
}
