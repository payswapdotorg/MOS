/**
 * /reporting CLIENT DECISION ROOM API routes (MKT-030 — UI-001, UI-AC-01..02:
 * the authoritative read surface a client-facing decision-room frontend
 * consumes: WHAT HAPPENED, WHY, EVIDENCE QUALITY, EXPERIMENTS,
 * RECOMMENDATIONS and APPROVALS over authoritative backend state).
 *
 *   GET    /api/reporting/decision-room/:clientId    the Client Decision Room — the live-aggregated view
 *
 * Authority composition (the frozen boundary — this file is a THIN
 * delegation layer over the SAME /reporting module's public contract, the
 * jobs-visits-routes.ts precedent: one authority, multiple route families;
 * the agency-scoped Command Center family (MKT-029) will register its own
 * family against the same module):
 *
 *   - CLIENT-SCOPED, SERVER-DERIVED SCOPE: the route authorizes with the
 *     SAME durable-membership authority as every client-scoped surface
 *     (requireClientAccess — /api/authorize.ts; the decision room serves
 *     CLIENT-side users, so the client-scoped check — not an agency-scoped
 *     platform listing — is the composed posture). The canonical Client
 *     ownership (client row → owning agency) resolves from durable state
 *     BEFORE any dependent traversal; the caller's agency/client/workspace
 *     identifiers in HEADERS, BODIES or QUERY STRINGS are never trusted
 *     (§23: a caller-supplied identifier is never authorization — the path
 *     clientId only SELECTS which durable ownership chain gets resolved);
 *   - THE HARD TENANT BOUNDARY: a caller with no membership in the OWNING
 *     agency gets the UNIFORM 404 — a foreign Client identifier is
 *     indistinguishable from an unknown one (no existence/traversal
 *     oracle; the same posture as every other client-scoped read);
 *   - READ-ONLY BY CONSTRUCTION: the surface registers EXACTLY ONE route
 *     and it is a GET — no mutating verb is registered anywhere in this
 *     file (the router 405s POST/PUT/PATCH/DELETE on the path), the route
 *     reads NO request body, and no authority field (agency/client/
 *     workspace identifiers, statuses, provenance) can be supplied by the
 *     caller at all. UI-AC-02: a frontend bypass cannot change
 *     authorization or workflow outcomes — there is nothing to drive;
 *   - the workspace enumeration feeding the workflow recaps is
 *     SERVER-DERIVED at the route layer (modules.workspaces, resolved
 *     through canonical Client ownership) and handed to the /reporting
 *     module as aggregation input — the /reporting matrix line holds no
 *     /workspaces or /clients direction (the /agents and /domain-packs
 *     scope-as-data posture);
 *   - the response discloses the read-window bound honestly: the evidence
 *     quality posture tallies the /evidence authority's bounded public
 *     listing (its server-chosen newest-first window), never an
 *     authoritative recount of an unbounded ledger.
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { jsonResponse, defineQueryRoute } from '../platform/http/pipeline.ts';
import { NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { ApplicationModules } from './application.ts';
import { requireClientAccess } from './authorize.ts';
import type { ClientOwnerContext } from '../modules/clients/public.ts';
import type { ClientDecisionRoomView } from '../modules/reporting/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client-scoped decision-room posture: the canonical Client ownership
 * resolves from durable state BEFORE any dependent traversal. A malformed,
 * unknown or FOREIGN client identifier is the uniform 404 (no cross-client
 * oracle — the hard tenant boundary); a caller without an active membership
 * in the owning agency is equally a 404; a suspended membership or disabled
 * identity is the 403. Returns the canonical owner context the room is
 * scoped to.
 */
async function requireDecisionRoomClient(
  modules: ApplicationModules,
  principal: Principal,
  clientId: string,
): Promise<ClientOwnerContext> {
  if (!UUID_PATTERN.test(clientId)) {
    // A malformed identifier is indistinguishable from an unknown one.
    throw new NotFoundError('client', clientId);
  }
  return requireClientAccess(modules, principal, clientId);
}

// ---------------------------------------------------------------------------
// Serialization — the decision-room response vocabulary (presentation only)
// ---------------------------------------------------------------------------

function serializeDecisionRoom(view: ClientDecisionRoomView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      clientId: view.scope.clientId,
      agencyId: view.scope.agencyId,
    },
    generatedAt: view.generatedAt,
    whatHappened: {
      goalStatusCounts: view.whatHappened.goalStatusCounts,
      instanceStatusCounts: view.whatHappened.instanceStatusCounts,
      goals: view.whatHappened.goals.map((goal) => ({
        goalId: goal.goalId,
        ...(goal.workspaceId === null ? {} : { workspaceId: goal.workspaceId }),
        objective: goal.objective,
        status: goal.status,
        successCriteria: goal.successCriteria,
        metrics: goal.metrics,
        constraints: goal.constraints,
        ...(goal.timeHorizon === null ? {} : { timeHorizon: goal.timeHorizon }),
      })),
      workflows: view.whatHappened.workflows.map((workflow) => ({
        workflowId: workflow.workflowId,
        workspaceId: workflow.workspaceId,
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
    },
    why: {
      learningStatusCounts: view.why.learningStatusCounts,
      learnings: view.why.learnings.map((learning) => ({
        learningId: learning.learningId,
        ...(learning.workspaceId === null ? {} : { workspaceId: learning.workspaceId }),
        statement: learning.statement,
        applicability: learning.applicability,
        status: learning.status,
        ...(learning.supersededBy === null ? {} : { supersededBy: learning.supersededBy }),
        ...(learning.confidence === null ? {} : { confidence: learning.confidence }),
        evidenceRefs: learning.evidenceRefs,
        experimentRefs: learning.experimentRefs,
      })),
    },
    evidenceQuality: {
      totalRecords: view.evidenceQuality.totalRecords,
      // Honest disclosure: the posture tallies the /evidence authority's
      // bounded public listing (newest-first window), never an unbounded
      // recount of the append-only ledger.
      window: 'evidence-authority-bounded-newest-first-listing',
      byClass: view.evidenceQuality.byClass.map((posture) => ({
        class: posture.class,
        total: posture.total,
        gradeCounts: posture.gradeCounts,
      })),
    },
    experiments: {
      experimentStatusCounts: view.experiments.experimentStatusCounts,
      experiments: view.experiments.experiments.map((experiment) => ({
        experimentId: experiment.experimentId,
        ...(experiment.workspaceId === null ? {} : { workspaceId: experiment.workspaceId }),
        hypothesis: experiment.hypothesis,
        decisionTarget: experiment.decisionTarget,
        status: experiment.status,
        designType: experiment.designType,
        analysisMethod: experiment.analysisMethod,
        ...(experiment.analysisMethodVersion === null
          ? {}
          : { analysisMethodVersion: experiment.analysisMethodVersion }),
        primaryMetricName: experiment.primaryMetricName,
        resultState: experiment.resultState,
        ...(experiment.resultingDecision === null
          ? {}
          : { resultingDecision: experiment.resultingDecision }),
        ...(experiment.concludedAt === null ? {} : { concludedAt: experiment.concludedAt }),
      })),
    },
    recommendations: {
      basis: view.recommendations.basis,
      items: view.recommendations.items.map((item) =>
        item.kind === 'applicable_learning'
          ? {
              kind: item.kind,
              learningId: item.learningId,
              statement: item.statement,
              applicability: item.applicability,
              ...(item.confidence === null ? {} : { confidence: item.confidence }),
            }
          : {
              kind: item.kind,
              experimentId: item.experimentId,
              decisionTarget: item.decisionTarget,
              resultingDecision: item.resultingDecision,
              designType: item.designType,
              analysisMethod: item.analysisMethod,
              ...(item.analysisMethodVersion === null
                ? {}
                : { analysisMethodVersion: item.analysisMethodVersion }),
              resultState: item.resultState,
            },
      ),
    },
    approvals: {
      items: view.approvals.items.map((item) =>
        item.kind === 'experiment_awaiting_decision'
          ? {
              kind: item.kind,
              experimentId: item.experimentId,
              status: item.status,
              decisionTarget: item.decisionTarget,
              hypothesis: item.hypothesis,
            }
          : {
              kind: item.kind,
              workflowInstanceId: item.workflowInstanceId,
              workflowId: item.workflowId,
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

export function registerReportingDecisionRoomRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  // -------------------------------------------------------------------------
  // GET /api/reporting/decision-room/:clientId — THE CLIENT DECISION ROOM
  // (UI-AC-01 — authoritative state): the live-aggregated view over the
  // composed authorities' public contracts. The ONLY route of this family:
  // the surface is READ-ONLY by construction (every other verb 405s at the
  // router; the route reads no body; the scope is server-derived from the
  // authenticated identity + durable ownership — UI-AC-02).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/reporting/decision-room/:clientId',
    defineQueryRoute<{ clientId: string }, ClientDecisionRoomView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireDecisionRoomClient(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) => {
        // Ownership is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline (the house
        // posture of the other read surfaces).
        const ownership = await requireDecisionRoomClient(
          modules,
          ctx.principal,
          ctx.params.clientId,
        );
        // SERVER-DERIVED aggregation input: the Client's workspace
        // enumeration resolved through canonical Client ownership (the
        // /workspaces public contract). A workspace identifier is never
        // accepted from the caller.
        const workspaces = await modules.workspaces.listWorkspacesForClient(
          ownership.client.clientId,
        );
        return modules.reporting.getClientDecisionRoom({
          clientId: ownership.client.clientId,
          agencyId: ownership.scope.agencyId,
          workspaceIds: workspaces.map((workspace) => workspace.workspaceId),
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDecisionRoom(ctx.result)),
    }),
  );
}
