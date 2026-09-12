/**
 * API router assembly (MKT-001 platform + MKT-002 identity routes + MKT-003
 * Client tenancy routes + MKT-004 Workspace boundary routes + MKT-005
 * credential-reference routes + MKT-006 Goal domain routes + MKT-007
 * Playbook domain routes + MKT-008 Workflow definition routes + MKT-009
 * Workflow instance state machine routes + MKT-010 Execution lifecycle
 * routes + MKT-012 Sandbox lifecycle routes + MKT-013 Evidence/provenance
 * routes + MKT-014 Metric normalization routes + MKT-015 Experiment model
 * routes + MKT-016 Learning model routes + MKT-017 AI runtime
 * registry routes — TaskProfiles, model registry, usage telemetry,
 * MKT-012 Sandbox lifecycle routes, MKT-025 Human Agent profile routes,
 * MKT-026 Job marketplace boundary routes + MKT-020 logical Agent/
 * Capability contract routes + MKT-021 execution policy engine routes
 * + MKT-022 extension registry and manifest contract routes
 * + MKT-031 Field Agent work-queue routes).
 *
 * One Router instance serves every module surface; each register* function
 * owns its /api/<module>/* prefix. The composition root builds the services
 * and modules; the entrypoint calls this builder.
 *
 * The /audit module intentionally registers NO route: the audit trail is
 * append-only, server-owned and has no public mutation or read surface in
 * MKT-005 (asserted by architecture tests).
 */

import type { AppServices } from '../platform/app-services.ts';
import { Router } from '../platform/http/router.ts';
import type { ApplicationModules } from './application.ts';
import { registerPlatformRoutes } from './platform-routes.ts';
import { registerAuthRoutes } from './auth-routes.ts';
import { registerUsersRoutes } from './users-routes.ts';
import { registerAgenciesRoutes } from './agencies-routes.ts';
import { registerClientsRoutes } from './clients-routes.ts';
import { registerWorkspacesRoutes } from './workspaces-routes.ts';
import { registerCredentialsRoutes } from './credentials-routes.ts';
import { registerGoalsRoutes } from './goals-routes.ts';
import { registerPlaybooksRoutes } from './playbooks-routes.ts';
import { registerWorkflowsRoutes } from './workflows-routes.ts';
import { registerExecutionsRoutes } from './executions-routes.ts';
import { registerSandboxRoutes } from './sandbox-routes.ts';
// MKT-013: evidence/provenance routes (EVID-001).
import { registerEvidenceRoutes } from './evidence-routes.ts';
// MKT-014: metric normalization routes (METRIC-001).
import { registerMetricsRoutes } from './metrics-routes.ts';
// MKT-015: experiment model routes (EXP-001 — declaration, reads and the
// frozen lifecycle transitions with the conclusion payload).
import { registerExperimentsRoutes } from './experiments-routes.ts';
// MKT-016: Learning model routes (LEARN-001 — appends, reads, the
// contradiction/supersession/retirement relationships and the
// append-only relationship history).
import { registerLearningsRoutes } from './learnings-routes.ts';
// MKT-017: /ai-runtime registry routes (TaskProfiles, model registry,
// usage telemetry — AI-001).
import { registerAiRuntimeRoutes } from './ai-runtime-routes.ts';
// MKT-020: /agents routes (logical Agent/Capability contracts — AGENT-001:
// platform + agency scoped registration, catalog reads, the single
// retire edge and the append-only lifecycle history surface).
import { registerAgentsRoutes } from './agents-routes.ts';

// MKT-025: the generic Human Agent profile routes (FIELD-001 + HUMAN-001).
import { registerFieldAgentsRoutes } from './field-agents-routes.ts';

// MKT-026: the Job marketplace boundary routes (JOB-001 — governed Task
// projections, candidate-specific offers, the concurrency-safe acceptance
// claim, outcome submission with server-derived provenance).
import { registerJobsRoutes } from './jobs-routes.ts';

// MKT-021: the execution policy engine routes (POL-001 — policy version
// administration (platform/agency/client scope) + the fail-closed
// evaluation endpoint + the append-only decision ledger).
import { registerPoliciesRoutes } from './policies-routes.ts';
// MKT-022: the /extensions routes (EXT-001 — extension registry and
// manifest contract: versioned immutable manifests, the install/configure
// lifecycle, the short-lived invocation context and the append-only
// invocation ledger).
import { registerExtensionsRoutes } from './extensions-routes.ts';
// MKT-027: the /jobs FIELD EXECUTION routes (visit lifecycle, structured
// outcomes, evidence capture, follow-up and the policy-gated continuity
// lookup — JOB-001 field subset + EVID-001 field subset, JOB-AC-03..04).
// Same /api/jobs surface prefix, same authorization composition (the
// shared posture helpers are exported from jobs-routes.ts).
import { registerJobsVisitsRoutes } from './jobs-visits-routes.ts';
// MKT-031: the /jobs FIELD AGENT WORK QUEUE routes (UI-002 — MY QUEUE,
// territory/job discovery, queue acceptance/decline by offer id alone;
// UI-AC-01..02). Thin delegation over the SAME /jobs + /field-agents
// public contracts; registered BEFORE the :jobId-parameterized routes
// because the literal 'queue' segment sits in the :jobId position.
import { registerJobsQueueRoutes } from './jobs-queue-routes.ts';
export function buildApiRouter(services: AppServices, modules: ApplicationModules): Router {
  const router = new Router();
  registerPlatformRoutes(router, services, modules);
  registerAuthRoutes(router, services, modules);
  registerUsersRoutes(router, services, modules);
  registerAgenciesRoutes(router, services, modules);
  registerClientsRoutes(router, services, modules);
  registerWorkspacesRoutes(router, services, modules);
  registerCredentialsRoutes(router, services, modules);
  registerGoalsRoutes(router, services, modules);
  registerPlaybooksRoutes(router, services, modules);
  registerWorkflowsRoutes(router, services, modules);
  registerExecutionsRoutes(router, services, modules);
  registerSandboxRoutes(router, services, modules);
  // MKT-013: evidence/provenance surface (append / read / list / supersede
  // — NO update or delete routes: evidence is append-only, EVID-AC-02).
  registerEvidenceRoutes(router, services, modules);
  // MKT-014: metrics surface (append / read / list — NO update or delete
  // routes: observations are append-only, METRIC-001; corrections are new
  // rows).
  registerMetricsRoutes(router, services, modules);
  // MKT-015: experiments surface (declare / read / list + the explicit
  // lifecycle transitions and the append-only history — NO update or
  // delete routes: the declared design is immutable and lifecycle moves
  // only through the frozen state machine, EXP-001).
  registerExperimentsRoutes(router, services, modules);
  // MKT-016: learnings surface (append / read / list + the explicit
  // contradiction/supersession/retirement relationships and the
  // append-only relationship history — NO update or delete routes:
  // Learning rows are fully immutable and state changes are NEW
  // relationship rows, LEARN-001/LEARN-AC-02).
  registerLearningsRoutes(router, services, modules);
  // MKT-017: AI runtime registry surfaces.
  registerAiRuntimeRoutes(router, services, modules);

  // MKT-025: Human Agent profiles + availability/territory declaration +
  // job-eligibility lookup (profile data only — no Client data routes).
  registerFieldAgentsRoutes(router, services, modules);

  // MKT-031: the Field Agent work-queue surface — MY QUEUE (open offers +
  // accepted jobs with live status and derived evidence/outcome
  // obligations), territory/job discovery (declared service areas + the
  // eligibility-gated marketplace descriptors) and the queue claim
  // surfaces (accept/decline by offer id alone, converging exactly with
  // the direct /jobs surface). Registered BEFORE the /api/jobs/:jobId
  // routes: the literal 'queue' segment sits in the :jobId position and
  // the router resolves first-match-wins (exactly like marketplace and
  // offers — /api/jobs/queue and /api/jobs/queue/offers/:offerId/accept
  // must never be captured by the :jobId patterns).
  registerJobsQueueRoutes(router, services, modules);

  // MKT-026: the Job marketplace boundary — Task projections (POST under
  // the workflow-instance path), the eligibility-gated marketplace listing
  // (descriptors to ELIGIBLE agents only — no Client data), candidate
  // offers + accept/decline (the concurrency-safe claim), outcome
  // submission (server-derived provenance) and outcome reads.
  registerJobsRoutes(router, services, modules);

  // MKT-027: the field-execution surface of the SAME /jobs authority —
  // visit open/start/cancel/complete with the structured outcome,
  // evidence capture from the field (through the /evidence public
  // contract), the append-only transition history and the DERIVED
  // policy-gated continuity lookup (JOB-AC-04). Registered AFTER the
  // jobs marketplace routes: all paths are deeper than the literal
  // /api/jobs/marketplace and /api/jobs/offers segments, so no shadowing
  // is possible either way.
  registerJobsVisitsRoutes(router, services, modules);

  // MKT-020: logical Agent/Capability surfaces (register / list / read /
  // retire / lifecycle history — the provider-neutral capability contract,
  // AGENT-001).
  registerAgentsRoutes(router, services, modules);

  // MKT-021: the execution policy engine surfaces — policy version
  // administration (declare/supersede/list/read — NO update or delete
  // routes: policy history is append-oriented) + the FAIL-CLOSED
  // evaluation endpoints (agency/client-scoped POST, decisions recorded
  // append-only) + the decision-ledger audit reads.
  registerPoliciesRoutes(router, services, modules);

  // MKT-022: the /extensions surfaces — the immutable versioned manifest
  // registry (publish/list/read), the install/configure lifecycle (the
  // frozen install state machine, least-privilege granted scopes,
  // config-contract validation, secret bindings as credential
  // references), the FAIL-CLOSED invocation endpoints (the short-lived
  // context derived from the execution's canonical owner + policy
  // posture) and the append-only invocation ledger (Observe). NO update
  // or delete routes: registry versions and invocation history are
  // immutable.
  registerExtensionsRoutes(router, services, modules);
  return router;
}
