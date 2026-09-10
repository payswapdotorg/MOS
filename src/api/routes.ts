/**
 * API router assembly (MKT-001 platform + MKT-002 identity routes + MKT-003
 * Client tenancy routes + MKT-004 Workspace boundary routes + MKT-005
 * credential-reference routes + MKT-006 Goal domain routes + MKT-007
 * Playbook domain routes + MKT-008 Workflow definition routes + MKT-009
 * Workflow instance state machine routes + MKT-010 Execution lifecycle
 * routes + MKT-012 Sandbox lifecycle routes + MKT-013 Evidence/provenance
 * routes + MKT-014 Metric normalization routes + MKT-017 AI runtime
 * registry routes — TaskProfiles, model registry, usage telemetry).
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
// MKT-017: /ai-runtime registry routes (TaskProfiles, model registry,
// usage telemetry — AI-001).
import { registerAiRuntimeRoutes } from './ai-runtime-routes.ts';

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
  // MKT-017: AI runtime registry surfaces.
  registerAiRuntimeRoutes(router, services, modules);
  return router;
}
