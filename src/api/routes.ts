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
 * + MKT-031 Field Agent work-queue routes + MKT-032 Extension Developer
 * Portal routes).
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
// MKT-023: the /integrations routes (INT-001 — the provider integration
// boundary: the adapter registry data view, connection registration and
// reads, the policy-gated connect probe + administrative suspend, the
// normalized read/mutation execution surface through the adapter port,
// and the append-only webhook/event ingestion surface + reads).
import { registerIntegrationsRoutes } from './integrations-routes.ts';
// MKT-022: the /extensions routes (EXT-001 — extension registry and
// manifest contract: versioned immutable manifests, the install/configure
// lifecycle, the short-lived invocation context and the append-only
// invocation ledger).
import { registerExtensionsRoutes } from './extensions-routes.ts';
// MKT-036: the /domain-packs routes (PACK-001 — versioned Domain Pack
// framework: the immutable versioned pack registry, the installed-version
// records against the authorized Workspace/Client context, and the
// artifact scope surface with the §5 explicit Client/Agency-reusable
// distinction).
import { registerDomainPacksRoutes } from './domain-packs-routes.ts';
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
// MKT-030: the /reporting CLIENT DECISION ROOM routes (UI-001 — the
// client-scoped read surface of the /reporting authority: WHAT HAPPENED,
// WHY, EVIDENCE QUALITY, EXPERIMENTS, RECOMMENDATIONS and APPROVALS over
// authoritative backend state; UI-AC-01..02). READ-ONLY by construction —
// exactly one GET route, no body, no authority fields, scope server-derived
// (the jobs-visits-routes.ts precedent: one authority, multiple route
// families — the agency-scoped Command Center family arrives with MKT-029).
import { registerReportingDecisionRoomRoutes } from './reporting-decision-room-routes.ts';
// MKT-032: the EXTENSION DEVELOPER PORTAL routes (UI-003 — the developer/
// reviewer/installer surface family over the SAME /extensions authority
// (MKT-022) composed with the /policies permission-approval authority:
// publication, version history/compatibility, the testing hook (the
// authority's invocation path), permission review (delegated
// extension-dimension policy declarations), the workspace install family
// and version management (pinning structural, explicit upgrades). Thin
// delegation only — the jobs-queue-routes.ts precedent: one authority,
// multiple route families; the portal owns NO state of its own).
import { registerExtensionPortalRoutes } from './extension-portal-routes.ts';
// MKT-037: the CREATOR OPERATIONS DOMAIN PACK routes (CREATOR-001 — the
// pack-owned Client-scoped subject surface, the approval-gated outbound
// conversation sends and content publication, the human approval records,
// the observation mapping into the common evidence/metric ledgers, the
// TaskProfile provisioning through the /ai-runtime authority and the
// frozen pack-manifest publication through the /domain-packs framework —
// CREATOR-AC-01..06). Thin delegation over the SAME composition-root-wired
// pack service; every mutation resolves the canonical owner from durable
// pack-owned rows BEFORE authorize/validate/execute.
import { registerCreatorOperationsRoutes } from './creator-operations-routes.ts';
// MKT-040: the Marketing Cloud Deployment control-plane routes (DEPLOY-002
// — the operator loop Configure → Validate → Deploy → Observe →
// Pause/Resume → Redeploy/Rollback over /api/workspaces/:id/deployments*).
import { registerDeploymentsRoutes } from './deployments-routes.ts';
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

  // MKT-023: the provider integration boundary surfaces — the adapter
  // REGISTRY as data (capability discovery; no tenant data), connection
  // registration + reads (uniform 404 for foreign identifiers), the
  // policy-gated connect probe and administrative suspend (CAS
  // transitions), the normalized read/mutation execution surface through
  // the generic adapter port (fail-closed /policies gates inside the
  // module; outcomes are data), the webhook/event ingestion relay surface
  // (adapter-verified, append-only, server-derived provenance) and the
  // ingested-event reads. NO delete route: the connection lifecycle has
  // no terminal state.
  registerIntegrationsRoutes(router, services, modules);
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

  // MKT-036: the /domain-packs surfaces — the immutable versioned pack
  // registry (publish/list/read with §4 workflow-template conformance at
  // publication), the install lifecycle (installed ⇄ disabled + terminal
  // uninstall, scope server-derived from the canonical workspace
  // ownership, dependency checks, idempotent install convergence) and the
  // artifact scope surface (workspace listing, the agency-reusable-only
  // agency listing, and the boundary-checked by-id read). NO update or
  // delete routes: registry versions, install history and artifact scope
  // records are immutable/append-only.
  registerDomainPacksRoutes(router, services, modules);

  // MKT-030: the CLIENT DECISION ROOM surface of the /reporting authority
  // — one GET route presenting the live-aggregated authoritative state
  // (goals, learnings, evidence quality, experiments + decisions,
  // approvals) for a client-scoped caller. Every mutating verb 405s at
  // the router; the route reads no body; NO update/delete/POST routes can
  // ever appear in this family (the decision room is a read surface, not
  // a write authority — UI-AC-02).
  registerReportingDecisionRoomRoutes(router, services, modules);

  // MKT-032: the EXTENSION DEVELOPER PORTAL surface family over the
  // /extensions authority (MKT-022) + the /policies permission-approval
  // authority — publication (the frozen platform_developer role), the
  // developer catalog/version history/compatibility records, the TESTING
  // hook (a thin pass-through to beginExtensionInvocation — never a
  // second execution engine), the permission-review view + reviewer
  // actions (delegated extension-dimension policy declarations; the
  // surface never evaluates permissions), the workspace install/configure/
  // authorize/disable/uninstall family (converging with the direct
  // MKT-022 surface) and version management (structural pinning + the
  // explicit, disclosed-as-non-atomic upgrade orchestration). NO update
  // or delete routes: registry versions, review history and invocation
  // history are immutable/append-only at the authorities.
  registerExtensionPortalRoutes(router, services, modules);
  // MKT-037: the Creator Operations pack surface (thin delegation — see
  // the import block above).
  registerCreatorOperationsRoutes(router, services, modules);
  // MKT-040: the /deployments surfaces — the deployment control plane
  // (configure + reads + the append-only history ledger + the compound
  // validate leg + the frozen lifecycle transitions + the
  // request-execution surface). NO delete route: deployment history is
  // append-only and the frozen lifecycle has exactly two terminal
  // states; NO dispatch/retry surface: requesting execution through the
  // /executions public contract is the only sanctioned interaction.
  registerDeploymentsRoutes(router, services, modules);
  return router;
}
