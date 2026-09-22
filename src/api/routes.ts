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
// MKT-029: the /reporting AGENCY COMMAND CENTER routes (UI-001 — the
// agency-scoped sibling of the decision room: PORTFOLIO GOALS, WORKFLOW
// STATE, EVIDENCE QUALITY, RISKS and PENDING APPROVALS across the agency's
// authorized client portfolio; UI-AC-01..02). READ-ONLY by construction —
// exactly one GET route, no body, no authority fields, the agency scope
// server-derived from durable agency/membership + client/workspace state
// (the decision-room precedent: one authority, multiple route families;
// cross-agency identifiers are the uniform 404 — no existence leak).
import { registerReportingCommandCenterRoutes } from './reporting-command-center-routes.ts';
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
// MKT-041: the /operating-graph routes (the Agency Operating Graph — the
// derived coordination model's READ-ONLY surface: the agency portfolio
// rollup + the client detail with version history; the rebuild is a
// module-level operation, never a route).
import { registerOperatingGraphRoutes } from './operating-graph-routes.ts';
// MKT-047: the /apps APP REGISTRY routes (the App Manifest and Packaging
// v1 surface: publish an immutable App Version through the frozen
// platform_developer role with the SERVER-DERIVED publisher identity,
// the manifest read by exact (app key, version), the version history by
// app key, and the compatibility query — NO update or delete routes:
// published App Versions are immutable).
import { registerAppsRoutes } from './apps-routes.ts';
// MKT-042: the /decisions routes (the Decision Ledger — record / list /
// read + the frozen disposition state machine (accept/reject/supersede
// with the successor forward-link), the one-shot observed outcome with
// its execution/deployment/learning references and the append-only
// event tail — NO update or delete routes: the ledger is append-oriented,
// corrections are NEW records and history is never rewritten).
import { registerDecisionsRoutes } from './decisions-routes.ts';
// MKT-048: the /app-installs routes (the App INSTALLATION surface: install
// one EXACT published App Version into a workspace with the
// server-derived granted scopes, the append-oriented upgrade/rollback
// selection changes, the workspace listing with current selections +
// full history, the one-row read and the agency rollup — every mutation
// is a POST with server-derived identity; NO update or delete routes: the
// selection ledger is append-only and the single sanctioned supersession
// transition happens inside the module's transaction, never through a
// caller-facing rewrite).
import { registerAppInstallsRoutes } from './app-installs-routes.ts';
// MKT-043: the /profit-intelligence routes (Profit Intelligence — the
// derived revenue/cost/capacity/utilization/scope-leakage/margin
// analytics surface: the agency portfolio rollup, the client view and the
// workspace slice, all GET-only with server-derived scope; every material
// figure carries source references, the frozen calculation version and
// the explicit assumption record — NO write path of any kind, the module
// can never mutate a financial authority).
import { registerProfitIntelligenceRoutes } from './profit-intelligence-routes.ts';
// MKT-045: the /ai-operator routes (AI Operator / Attention Queue — the
// derived ranked attention-queue surface: the agency attention queue, the
// deterministic item detail (re-derived queue, nothing stored) and the
// client-scoped slice, all GET-only with server-derived scope; every item
// carries its category, deterministic priority score, source references,
// structured rationale and the EXISTING consequential-action contract
// reference it would flow through — NO write path of any kind: the module
// ranks action candidates only, consequential actions continue through
// the existing policy/approval contracts).
import { registerAiOperatorRoutes } from './ai-operator-routes.ts';
// MKT-046: the /sales-continuity routes (Sales-to-Delivery Continuity —
// the proposal carry into the Playbook path + the optional deployment
// carry + the continuity/provenance round-trip views: POST
// /api/decisions/:decisionId/carry derives the structured payload from
// the accepted proposal and creates the playbook + version THROUGH the
// existing /playbooks commands; POST
// /api/sales-continuity/carries/:carryId/deployment publishes the carried
// version through the frozen lifecycle and configures the deployment
// THROUGH the existing /deployments command; the GET views read the
// durable linkage + live records. The carried payload is NEVER a request
// field — no manual re-entry anywhere).
import { registerSalesContinuityRoutes } from './sales-continuity-routes.ts';
// MKT-044: the /client-memory routes (Client Operating Memory — the
// governed client-context projection and retrieval surface: the client
// memory view + the workspace slice + the kind-filtered retrieval over
// the projected records, all GET-only with server-derived scope; every
// memory item cites canonical record ids and the frozen, versioned
// projection vocabulary (cm-proj-v1) ships in every response — NO write
// path of any kind, retrieval/index technology is non-authoritative and
// none exists: never a second tenant/data authority).
import { registerClientMemoryRoutes } from './client-memory-routes.ts';
// MKT-049: the /developer-portal APP DEVELOPER PORTAL routes (the App
// SDK and Developer Portal surface family over the SAME /apps registry
// authority — the MKT-032 extension-portal precedent: one authority,
// multiple route families, the portal owns NO state of its own): the
// developer catalog + version views, ONLINE validation through the REAL
// registry guard (pure), the delegated publish (the same
// publishAppVersion command — optional signature verified by the
// authority) and the documentation surface derived read-only from the
// frozen /apps public contract. NO update or delete routes: published
// App Versions are immutable (architecture-lock v1.5 #11) and the
// portal is never a second app authority.
import { registerDeveloperPortalRoutes } from './developer-portal-routes.ts';
// MKT-050: the /app-marketplace routes (the App Marketplace, Trust and
// Certification surface: the agency-scoped discovery family — listing
// with search/filters, the app detail with the append-only trust/review
// tails and the policy-eligibility read-side query — plus the
// platform-territory command family: the operator trust transition and
// the community review record; every mutation is a POST with
// server-derived identity/provenance; NO update or delete routes —
// trust events and reviews are append-only and the registry is never
// rewritten).
import { registerAppMarketplaceRoutes } from './app-marketplace-routes.ts';
// MKT-052: the /app-metering routes (the App Metering and Commercial
// Attribution surface: EXACTLY THREE GETs — the workspace attribution
// view, the agency portfolio rollup and the publisher commercial view
// (per app / per publisher / per period aggregates with the frozen
// calculation version + the disclosed assumption record in every
// response). READ-ONLY by construction: the metering collection, the
// usage-observation ingestion and the rollup recompute are MODULE-LEVEL
// operations for server-side callers (the operating-graph rebuild
// precedent) — NO POST/PUT/PATCH/DELETE route exists anywhere in this
// family, and the module exposes ZERO billing/charging methods —
// marketplace attribution stays separate from the core financial
// authority, so a frontend bypass has nothing to drive).
import { registerAppMeteringRoutes } from './app-metering-routes.ts';
// MKT-051: the /first-party-apps routes (the Incumbent Capability App
// Program surface: the pack catalog with LIVE registry + install state,
// the composed-surface invoke/read over the CURRENT install selection
// (422 undeclared surface, 403 missing granted scope, 404 not installed)
// and the bounded app-state family with the export/delete semantics.
// Thin delegation over the /first-party-apps module — the pack action
// menus only DECLARE existing authority command routes; the bounded
// app-state mutations touch app-owned state only (never an authority
// table — proven by direct SQL in the integration tests).
import { registerFirstPartyAppsRoutes } from './first-party-apps-routes.ts';
// MKT-053: the /growth-missions routes (the Growth Mission and Objective
// Model surface: the agency-scoped create + list family, the composed
// honest read-back with the version + history tails, the objective
// CORRECTION path (a NEW declared version — never an in-place rewrite),
// the frozen-lifecycle transitions with the REQUIRED reason, and the
// goal-mapping family including the honest recorded removal. GET/POST
// ONLY — no PUT/PATCH/DELETE exists anywhere in this family (asserted by
// the boundary tests); NO controller/scheduler/execution verb — MKT-054
// (the Growth Operator) composes the module commands server-side).
import { registerGrowthMissionsRoutes } from './growth-missions-routes.ts';
// MKT-055: the /social-accounts routes (the Social Account and OAuth
// Connection Model surface: the provider-neutral OAuth flow family —
// authorize-start, callback/complete, refresh, reauthorize, disconnect,
// external-revocation — plus the authorization reads: the client/workspace
// binding listings, the account detail, the grant tail with the VERBATIM
// scope records + capability tags (REFUSES 409 on dead connections) and
// the append-only history tail. NO usable-authorization route: the
// fail-closed consumer read is module-level for the MKT-056+ adapters;
// NO update route: recorded authorization facts are immutable; NO delete
// route: the death is the disconnect/revocation transition and the history
// is append-only).
import { registerSocialAccountsRoutes } from './social-accounts-routes.ts';
// MKT-069: the /product-contexts routes (the Product Intelligence surface:
// the agency-scoped create + list family, the composed honest read-back
// with the version/source-fact/derived-model/risk-flag/inspection-run
// tails, the declared-input CORRECTION path (a NEW version — never an
// in-place rewrite), the deterministic inspection POST (fetch/extract over
// the CURRENT declared inputs — GET-only public reads + READ-ONLY
// authorized reads through /integrations) and the derived-model/risk-flag
// recording POSTs. GET/POST ONLY — no PUT/PATCH/DELETE exists anywhere in
// this family (asserted by the boundary tests); NO mission-strategy verb
// — MKT-070 composes the read surface by reference; NO mutation toward
// any external source — boundary rule 7's write seam is documented, not
// built).
import { registerProductIntelligenceRoutes } from './product-intelligence-routes.ts';
// MKT-068: the /notification-delivery routes (the Notification Delivery
// Plane surface: the delivery command POST — occurrence claim + per-channel
// policy gates + append-only receipts, with the honest duplicate-skipped
// receipts on replay — plus the read surfaces: the in-app inbox view (the
// future console's read surface with the append-only read transition) and
// the notification detail with the full receipt tail. NO update route (§14
// facts are immutable at creation; corrections are NEW notifications), NO
// delete route (history is append-only — DB-trigger-fenced) and NO
// dispatch/retry route (a dispatch/retry worker plane is future Work Item
// territory; the receipt model already admits append-only retries).)
import { registerNotificationDeliveryRoutes } from './notification-delivery-routes.ts';
// MKT-063: the /content-rights routes (the Content Rights and Provenance
// surface: the rights-record registration POST + the reads, THE
// PUBLICATION-GATE evaluation POST — allow / review_required / blocked
// with reasons, never a publication — the state-transition POST whose
// human_clearance kind is the ONLY review → cleared path, the
// destination-platform permission-scope POST and the immutable
// ingredient-lineage family. Literal-segment routes (by-asset/gate/
// lineage) register BEFORE the :rightsRecordId patterns
// (first-match-wins, the jobs-queue precedent). NO update route
// (recorded facts are immutable — corrections are recorded transition
// events), NO delete route (rights history is append-only —
// DB-trigger-fenced) and NO publish/dispatch route of any kind
// (boundary rule 4: the gate blocks or refers to review; publishing is
// MKT-065's execution surface).)
import { registerContentRightsRoutes } from './content-rights-routes.ts';
// MKT-064: the /content-assets routes (the Content Asset and
// Transformation Authority surface: the versioned asset-record
// registration POST + the reads, the by-ref seam resolution, the
// materialization POST (draft → materialized, the single sanctioned
// state move), the append-only quality-observation POST and the
// transformation family: request (kind + EXPLICIT ingredient versions +
// parameters + output spec) and execute (the module runner through the
// /executions authority — the engine behind the port, output born
// derived WITH lineage). Literal-segment routes (by-ref,
// transformations) register BEFORE the :versionId patterns
// (first-match-wins). NO update route (version records are immutable —
// a correction is a NEW version), NO delete route (history is
// append-only — DB-trigger-fenced) and NO rights-mutating route of any
// kind (boundary rule 5: transforming an asset never checks or mutates
// rights — the /content-rights surfaces own the rights records and the
// publication gate).)
import { registerContentAssetsRoutes } from './content-assets-routes.ts';
// MKT-067: the /experiment-analysis routes (the Experiment Analysis and
// Adaptive Allocation surface: the deterministic two-sample analysis
// POST over the /metrics observation window + the reads + the sequential
// per-experiment tail, and the adaptive-allocation POST + the reads —
// each record carrying its FULL input snapshot + the canonical digest.
// Literal-segment routes (by-experiment) register BEFORE the
// :analysisId / :recommendationId patterns (first-match-wins). NO
// update route (analyses and recommendations are immutable — the
// migration 054 triggers reject it), NO delete route (both tails are
// append-only — a negative or inconclusive result is preserved, never
// erased) and NO route of any kind that mutates experiment exposure,
// platform state or workflow inputs (allocation results are
// recommendations recorded as DATA toward the mission/operator layer;
// the /experiments authority stays sole for experiment lifecycle).)
import { registerExperimentAnalysisRoutes } from './experiment-analysis-routes.ts';
// MKT-065: the /cross-platform-distribution surfaces — the distribution
// plans + THE fan-out dispatch (the fail-closed per-destination
// execution: the 063 rights gate composed before every attempt, the
// per-platform capability validation through the 056 adapter contract +
// the /integrations registry, the dispatch policy gate through
// /policies and the physical publish EXCLUSIVELY through the 056
// submitPublish idempotency ledger) + the §5 measurement tail. NO
// gate-skipping verb of any kind exists (fail-closed by construction);
// no route mutates a mission, re-evaluates rights or touches the 056
// ledger directly.
import { registerCrossPlatformDistributionRoutes } from './cross-platform-distribution-routes.ts';
// MKT-062: the /research-sessions surfaces — the agency-scoped research
// sessions (create/list under the agency), the composed honest read-back
// (+versions/facts/insights/runs tails), the version-correction POST, the
// deterministic research-pass POST and the insight-recording POST.
// GET/POST ONLY — no PUT/PATCH/DELETE exists anywhere in this family
// (asserted by the boundary tests); NO mutation toward any research
// source exists (§7 — the page-reader contract has no method field and
// the integrations port exposes executeRead ONLY).
import { registerResearchRoutes } from './research-routes.ts';
// MKT-062: the /content-intelligence surfaces — the observation-ingestion
// family (the READ-ONLY platform reads through /integrations, every
// normalized observation becoming ONE canonical /evidence record), the
// CLIENT-SCOPED candidate family (the §6 observed-feature set as data,
// evidence-linked, append-only) and the hypothesis family (the honest
// §6 non-causality framing; inputs to /experiments, never conclusions;
// the optional experiment reference validated READ-ONLY). GET/POST ONLY —
// no PUT/PATCH/DELETE exists anywhere in this family; candidates are
// append-only (a new observation is a NEW candidate) and hypothesis
// corrections are NEW superseding records.
import { registerContentIntelligenceRoutes } from './content-intelligence-routes.ts';
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
  // MKT-029: the agency-scoped Command Center family of the SAME /reporting
  // authority (registered after the decision-room family; the literal
  // 'command-center' segment cannot collide with 'decision-room').
  registerReportingCommandCenterRoutes(router, services, modules);

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
  // MKT-041: the /operating-graph surfaces — the Agency Operating Graph's
  // READ-ONLY views (the agency portfolio rollup + the client detail with
  // the append-oriented version history). NO write path of any kind: the
  // derived-edge rebuild is a module-level operation (background workers
  // and later v1.5 Work Items), so no POST/PUT/PATCH/DELETE can ever
  // appear in this family — a frontend bypass has nothing to drive.
  registerOperatingGraphRoutes(router, services, modules);

  // MKT-047: the /apps surfaces — the App registry (publish one immutable
  // App Version through the frozen platform_developer role; read the
  // manifest by exact (app key, semantic version); the version history
  // by app key; the compatibility query given runtime/extension
  // versions). NO update or delete routes: published App Versions are
  // immutable (architecture-lock v1.5 #11) and certification transitions
  // are the future MKT-050 platform marketplace/trust surface.
  registerAppsRoutes(router, services, modules);
  // MKT-042: the /decisions surfaces — the Decision Ledger (record +
  // reads + the frozen disposition transitions with the §8 replay
  // fences + the one-shot observed outcome + the append-only event
  // tail). NO update or delete routes: the proposal payload is
  // immutable, corrections are NEW records linked through the
  // predecessor/successor chain, and ledger history is never erased.
  registerDecisionsRoutes(router, services, modules);
  // MKT-048: the /app-installs surfaces — the App installation authority
  // (see the import block above).
  registerAppInstallsRoutes(router, services, modules);
  // MKT-043: the /profit-intelligence surfaces — Profit Intelligence
  // (the DERIVED revenue/cost/capacity/utilization/scope-leakage/margin
  // analytics over the canonical authorities: the agency portfolio
  // rollup, the client view and the workspace slice). READ-ONLY by
  // construction: exactly three GETs, no body, no DTO, no query
  // parameters — derived analytics, never a financial system of record
  // (architecture-lock-v1.5 #6); a frontend bypass has nothing to drive.
  registerProfitIntelligenceRoutes(router, services, modules);
  // MKT-045: the /ai-operator surfaces — the AI Operator attention queue
  // (the derived ranked attention items over the canonical authorities:
  // the agency queue, the item detail and the client slice). READ-ONLY by
  // construction: exactly three GETs, no body, no DTO, no query
  // parameters — the module ranks governed action candidates and never
  // executes or creates them (consequential actions continue through the
  // existing policy/approval contracts — architecture-v1.5.md §7); a
  // frontend bypass has nothing to drive.
  registerAiOperatorRoutes(router, services, modules);
  // MKT-046: the /sales-continuity surfaces — the carry family (proposal
  // → playbook → deployment through the EXISTING creation commands) + the
  // continuity views (proposal → carried records; the delivery side →
  // proposal round-trip). NO update or delete routes: the continuity
  // ledger is append-only with a forward-only completion ladder; NO
  // validate/activate/transition surface: the MKT-040 gate stays the
  // /deployments routes' alone.
  registerSalesContinuityRoutes(router, services, modules);
  // MKT-044: the /client-memory surfaces — Client Operating Memory (the
  // DERIVED governed projection over the canonical client, goal,
  // playbook, deployment, evidence, experiment, outcome, decision and
  // learning records: the client memory view, the workspace slice and the
  // kind-filtered retrieval over the projected records). READ-ONLY by
  // construction: exactly three GETs, no body, no DTO, no query
  // parameters — retrieval/index technology is non-authoritative
  // (spec/architecture-v1.5.md §6) and this delivery adds none at all;
  // never a second tenant/data authority, so a frontend bypass has
  // nothing to drive.
  registerClientMemoryRoutes(router, services, modules);
  // MKT-049: the /developer-portal surfaces — the App Developer Portal
  // (see the import block above). Thin delegation over the /apps
  // registry authority + its exported pure guards; registered after the
  // /api/apps family (no literal-segment collision — the portal's
  // 'catalog'/'docs'/'validate'/'publish'/'apps' segments live under
  // /api/developer-portal/*).
  registerDeveloperPortalRoutes(router, services, modules);
  // MKT-050: the /app-marketplace surfaces — the agency-scoped discovery
  // family (the listing with search/filters, the app detail, the
  // policy-eligibility read-side query) + the platform-territory trust
  // transition and community review commands. NO update or delete
  // routes: trust events and reviews are append-only (migration 042)
  // and the marketplace NEVER rewrites the /apps registry.
  registerAppMarketplaceRoutes(router, services, modules);
  // MKT-052: the /app-metering surfaces — the GET-only derived
  // attribution read models (the workspace view, the agency portfolio
  // rollup, the publisher commercial view; see the import block above).
  registerAppMeteringRoutes(router, services, modules);
  // MKT-051: the /first-party-apps surfaces — the pack catalog + the
  // composed-surface invoke/read + the bounded app-state family (see
  // the import block above).
  registerFirstPartyAppsRoutes(router, services, modules);
  // MKT-053: the /growth-missions surfaces — the durable mission record
  // family (see the import block above): create/list under the agency,
  // the composed honest read-back (+versions/history tails), the
  // version-correction POST, the frozen-lifecycle status POST (REQUIRED
  // reason) and the goal-mapping family with the honest recorded removal.
  registerGrowthMissionsRoutes(router, services, modules);
  // MKT-055: the /social-accounts surfaces — the provider-neutral OAuth
  // flow family + the authorization reads (see the import block above).
  registerSocialAccountsRoutes(router, services, modules);
  // MKT-069: the /product-contexts surfaces — the Product Intelligence
  // family (see the import block above): create/list under the agency, the
  // composed honest read-back (+versions/source-facts/derived-models/
  // risk-flags/inspection-runs tails), the version-correction POST, the
  // deterministic inspection POST and the derived-model/risk-flag
  // recording POSTs.
  registerProductIntelligenceRoutes(router, services, modules);
  // MKT-068: the /notification-delivery surfaces — the delivery command +
  // the in-app read surface + the notification/receipt reads (see the
  // import block above).
  registerNotificationDeliveryRoutes(router, services, modules);
  // MKT-063: the /content-rights surfaces — the rights records + the
  // publication gate (see the import block above).
  registerContentRightsRoutes(router, services, modules);
  // MKT-064: the /content-assets surfaces — the versioned asset records
  // + the observations + the transformation family (see the import
  // block above).
  registerContentAssetsRoutes(router, services, modules);
  // MKT-067: the /experiment-analysis surfaces — the analyses + the
  // allocation recommendations (see the import block above).
  registerExperimentAnalysisRoutes(router, services, modules);
  // MKT-065: the /cross-platform-distribution surfaces — the
  // distribution plans + the fan-out dispatch + the measurement tail
  // (see the import block above).
  registerCrossPlatformDistributionRoutes(router, services, modules);
  // MKT-062: the /research-sessions surfaces — the research sessions +
  // the deterministic research pass + the insight recording (see the
  // import block above).
  registerResearchRoutes(router, services, modules);
  // MKT-062: the /content-intelligence surfaces — the observation
  // ingestion + the candidate/hypothesis families (see the import block
  // above).
  registerContentIntelligenceRoutes(router, services, modules);
  return router;
}
