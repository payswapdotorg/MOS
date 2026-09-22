/**
 * Composition root (spec/module-dependency-matrix.md: "Provider SDKs,
 * concrete queue/storage clients, sandbox drivers, browser drivers and
 * external integration adapters are wired at the composition root").
 *
 * This is the ONLY place in src/ where concrete adapters are imported.
 * API routes, workers and domain modules depend on the contracts in
 * src/platform/<concern>/contract.ts exclusively — enforced by the static
 * architecture checker (tools/arch-check).
 *
 * MKT-002 additions:
 *   - the /users, /auth and /agencies modules are constructed here with
 *     platform ports + the allowed module-to-module dependencies
 *     (/auth → /users; /agencies → /users);
 *   - the HTTP authenticator becomes a composite: user sessions (auth module)
 *     first, then the MKT-001 internal service token — both fail closed;
 *   - optional idempotent platform-administrator bootstrap from explicit
 *     configuration (never raw-material persistence: only the scrypt
 *     verifier lands in the auth-owned credential store).
 *
 * MKT-003 additions:
 *   - the /clients module is constructed here (dependency matrix:
 *     /clients ──→ /agencies, /auth) owning Client identity, Agency→Client
 *     ownership and canonical owner resolution.
 *
 * MKT-004 additions:
 *   - the /workspaces module is constructed here (dependency matrix:
 *     /workspaces ──→ /clients) owning Workspace identity, Client→Workspace
 *     ownership and canonical owner resolution THROUGH /clients.
 *
 * MKT-005 additions (issue #13 — extend existing authorities, never
 * duplicate them):
 *   - the object-store port gains the production S3-compatible adapter
 *     (SigV4 over fetch — no SDK) next to the existing memory/fs adapters;
 *     the MKT-001 ObjectStore contract is untouched;
 *   - the advisory cache/lock capabilities are wired: a real Redis adapter
 *     when MOS_REDIS_URL is configured, or the documented degenerate
 *     adapters otherwise (NoCache + fail-closed UnavailableLock). The
 *     durable queue authority REMAINS the PostgreSQL queue — Redis is never
 *     wired as a queue or workflow authority;
 *   - the secret backend (file-based SecretStore) is wired once and handed
 *     to the /credentials module — the only consumer of material;
 *   - the /credentials (CRED-001) and /audit (AUD-001) modules are
 *     constructed here with platform ports only.
 *
 * MKT-006 additions:
 *   - the /goals module is constructed here (dependency matrix:
 *     /goals ──→ /clients, /workspaces) owning Goal identity, measurable
 *     content, lifecycle and canonical owner resolution THROUGH /clients
 *     (and /workspaces for the optional scope).
 *
 * MKT-007 additions:
 *   - the /playbooks module is constructed here (dependency matrix:
 *     /playbooks ──→ /agencies, /clients, /goals) owning Playbook
 *     identity, the Agency-or-Client ownership relation, the optional
 *     Goal link, the versioned strategy artifact with its declarative
 *     deployment metadata and the frozen version lifecycle. NO
 *     workflow/deployment/execution engine is wired (architecture.md §8:
 *     Deployment references immutable Playbook Versions and does not
 *     mutate them — /deployments is a later Work Item).
 *
 * MKT-008 additions:
 *   - the /workflows module is constructed here (dependency matrix subset:
 *     /workflows ──→ /workspaces, /playbooks) owning the Workflow
 *     DEFINITION sub-authority (WF-001): Workspace-scoped Workflow
 *     identity with server-derived Client/Agency ownership, the versioned
 *     typed graph definitions with their schemas and declarative policy
 *     blocks, the exhaustive graph validation and the
 *     immutable-after-activation lifecycle. NO workflow-instance state
 *     machine, NO runtime, NO execution or deployment authority is wired
 *     (architecture.md §10/§11 — the instance machine is MKT-009,
 *     Executions are /executions MKT-010, deployment binding is
 *     /deployments MKT-040).
 *
 * MKT-009 additions:
 *   - the /workflows module's INSTANCE sub-authority
 *     (implementation-contract §5): the Workflow instance state machine —
 *     identity pinning one immutable ACTIVE definition version, the frozen
 *     DRAFT → READY → RUNNING lifecycle with CAS, idempotency-fenced
 *     transitions and append-only history.
 *
 * MKT-010 additions:
 *   - the /executions module is constructed here (dependency matrix:
 *     /executions ──→ /workspaces) owning the NORMALIZED EXECUTION MODEL
 *     (EXEC-001): one Execution identity and lifecycle for deterministic,
 *     AI, human and extension execution — the actual runtime attempt with
 *     its task linkage (reference data), the frozen
 *     CREATED → QUEUED → STARTING → RUNNING machine with UNKNOWN/
 *     RECONCILING reconciliation semantics, the §8 DB-fenced logical
 *     idempotency key, the §24 retry classification with the explicit
 *     retry gate, and the durable sandbox LEASE relationship. NO execution
 *     ENGINE is wired: no dispatch, no queue consumption, no workers, no
 *     sandbox lifecycle (MKT-011/MKT-012); /workflows does not call
 *     /executions yet (that arrives with the runtime engine).
 *
 * MKT-013 additions:
 *   - the /evidence module is constructed here (dependency matrix subset:
 *     /evidence ──→ /clients, /workspaces) owning the append-only,
 *     server-owned EVIDENCE LEDGER (EVID-001): the 8 frozen evidence
 *     classes with their two authority tiers (claims are never
 *     auto-promoted to authoritative classes — EVID-AC-03), the A..F
 *     quality taxonomy, server-derived provenance as a separate dimension
 *     from confidence, immutable rows with DB-backstopped append-only
 *     triggers, and the single-correction supersession graph.
 *
 * MKT-014 additions:
 *   - the /metrics module is constructed here (dependency matrix: /metrics
 *     ──→ /evidence, /integrations — /evidence is the merged authority
 *     consumed for evidence_ref validation; /integrations is MKT-023/024,
 *     and /metrics owns NO provider state either way) owning the
 *     append-only METRIC OBSERVATION LEDGER (METRIC-001): normalized
 *     source-tagged observations with source/timestamp/reference mapping
 *     (observed_at vs server-stamped retrieved_at), the closed 5-value
 *     data-quality posture set, server-derived provenance, DB-backstopped
 *     append-only triggers, optional workspace scope INSIDE the owning
 *     Client and optional same-Client /evidence linkage. The REQUIRED
 *     /clients + /workspaces canonical owner resolution arrives through
 *     /metrics' declared STRUCTURAL PORTS (the public-contract instances
 *     satisfy them structurally — no forbidden module import; the frozen
 *     matrix stays intact while ownership resolution stays server-side).

 * MKT-017 additions (AI task profile and model registry, AI-001):
 *   - the /ai-runtime module is constructed here with platform ports plus
 *     EXACTLY the frozen-matrix dependency /ai-runtime ──→ /executions (the
 *     /executions public API validates telemetry execution references);
 *     it owns the REGISTRY LAYER ONLY — provider-neutral TaskProfiles, the
 *     normalized model registry with append-only observations, and usage
 *     telemetry records. NO routing/cascade engine (MKT-018), NO
 *     evaluation framework (MKT-019), NO provider adapters/SDKs and NO
 *     model invocation are wired (the pooled runtime stays untouched).

 * MKT-020 additions (logical Agent/Capability contracts, AGENT-001):
 *   - the /agents module is constructed here with PLATFORM PORTS ONLY
 *     (db/clock/ids): the frozen matrix allows /agents ──→ /executions,
 *     /ai-runtime, /policies, but the logical capability contract needs
 *     NONE of them — the logical Agent owns no tenant data, no workflow
 *     state, no deployment state and no infrastructure (architecture.md
 *     §12). It owns the provider-neutral reusable capability declaration
 *     registry (platform/agency scope, register/list/read/retire, §8-style
 *     registration fences, append-only lifecycle history). NO execution
 *     engine, NO dispatch, NO invocation, NO human/field agents (MKT-025)
 *     and NO provider adapters are wired.
 *
 * MKT-025 additions (Human Agent foundation, FIELD-001 + HUMAN-001):
 *   - the /field-agents module is constructed here as the GENERIC Human
 *     Agent authority (module-dependency-v1.3: /human-agents is represented
 *     by the existing /field-agents authority generalized — a second
 *     human-execution module is FORBIDDEN). It owns the human_agents
 *     profile table (platform identity link, specializations as capability
 *     metadata, availability/territories, relationship-continuity and the
 *     authorization/contract state) with platform ports + the allowed
 *     /users dependency only; eligibility composition happens at the route
 *     layer (the frozen matrix does not allow /field-agents → /agencies).
 *     NO job/execution engine is wired (HUMAN-AC-02: the Job authority is
 *     /jobs, MKT-026).

 * MKT-026 additions (Job marketplace boundary, JOB-001):
 *   - the /jobs module is constructed here (frozen matrix: /jobs ──→
 *     /workflows, /executions, /field-agents, /clients, /evidence,
 *     /policies; this Work Item consumes exactly /workflows READ-ONLY +
 *     /field-agents + /evidence) owning governed Task projections,
 *     candidate-specific Offers with the exactly-one-winner acceptance
 *     claim and provenance-preserving outcome submission. Workflow
 *     authority is PRESERVED: /jobs consumes /workflows' public contract
 *     read-only and never mutates instance state. Agency membership/role
 *     authorization stays at the route layer (the matrix gives /jobs no
 *     /agencies module dependency). No dispatch/execution engine is wired
 *     (HUMAN-AC-02: /jobs is not a second workflow engine — no graph, no
 *     node/edge semantics, no downstream scheduling).
 *
 * MKT-021 additions (Execution policy engine, POL-001):
 *   - the /policies module is constructed here (frozen matrix:
 *     /policies ──→ /clients, /agencies — both consumed DIRECTLY for
 *     canonical scope resolution: agency/client ownership validation on
 *     administration writes and scope re-validation before every policy
 *     read) owning the append-oriented policy VERSION records, the
 *     FAIL-CLOSED decision engine and the append-only decision records.
 *     The CRED-001 reference lookup arrives through the module's declared
 *     REFERENCE-ONLY STRUCTURAL PORT: the concrete /credentials
 *     public-contract instance satisfies the port structurally (the
 *     /metrics ownership-port precedent — the frozen matrix allows
 *     /credentials ──→ /policies, not the reverse, so no /credentials
 *     import exists inside src/modules/policies); the engine evaluates
 *     access PROPOSALS and never sees secret material or handles. NO
 *     enforcement hooks are wired: consuming modules wire enforcement in
 *     later Work Items (this engine decides and records only).

 * MKT-027 additions (Field execution and evidence, JOB-001 field subset +
 * EVID-001 field subset):
 *   - NO new module and NO new dependency is wired: the field-execution
 *     surface (visit lifecycle, structured outcomes, evidence capture,
 *     follow-up, continuity) is composed INSIDE the same /jobs module
 *     from the SAME deps (db/clock/ids/workflows/fieldAgents/evidence) —
 *     the frozen matrix is untouched. The continuity policy checkpoint
 *     consumes the merged /field-agents profile relationship-continuity
 *     block through the existing /field-agents public contract (the
 *     declared swap point for the future /policies authority, MKT-021).
 *     The /api registration adds jobs-visits-routes.ts under the same
 *     /api/jobs prefix. Migration 024_field_execution.sql is reserved for
 *     this Work Item (019/022 belong to sibling workers).
 *
 * MKT-031 additions (Field Agent work queue, UI-002 — UI-AC-01..02):
 *   - NO new module and NO new dependency is wired: the work-queue API
 *     surface (MY QUEUE, territory/job discovery, queue
 *     acceptance/decline by offer id alone) is a THIN ROUTE-LAYER
 *     composition over the SAME /jobs + /field-agents public contracts —
 *     no queue engine, no state machine, no second matcher, no second
 *     authority. The /api registration adds jobs-queue-routes.ts under
 *     the same /api/jobs prefix (registered before the :jobId routes;
 *     the shared posture helpers and serializers are exported from
 *     jobs-routes.ts so both surfaces of the ONE /jobs authority answer
 *     identically).
 */
import fs from 'node:fs';
import { loadConfig, describeConfig, type AppConfig } from './platform/config/config.ts';
import { SystemClock } from './platform/clock/clock.ts';
import { CryptoIdGenerator } from './platform/ids/ids.ts';
import { PgDb } from './platform/db/adapters/postgres/pg-db.ts';
import { runMigrations } from './platform/db/migrate.ts';
import { PgQueue } from './platform/queue/adapters/postgres/pg-queue.ts';
import { MemoryObjectStore } from './platform/objects/adapters/memory/memory-object-store.ts';
import { FsObjectStore } from './platform/objects/adapters/fs/fs-object-store.ts';
import { S3ObjectStore } from './platform/objects/adapters/s3/s3-object-store.ts';
import { RedisCache } from './platform/cache/adapters/redis/redis-cache.ts';
import { NoCache } from './platform/cache/adapters/none/no-cache.ts';
import { RedisLock } from './platform/locking/adapters/redis/redis-lock.ts';
import { UnavailableLock } from './platform/locking/adapters/none/unavailable-lock.ts';
import { FileSecretStore } from './platform/secrets/adapters/file/file-secret-store.ts';
import { ConsoleSink } from './platform/observability/adapters/console/console-sink.ts';
import { CompositeSink } from './platform/observability/adapters/composite/composite-sink.ts';
import { createLoggerFactory } from './platform/observability/logger.ts';
import { InMemoryMetrics } from './platform/observability/metrics.ts';
import { InternalTokenAuthenticator } from './platform/http/auth/adapters/internal-token/internal-token-authenticator.ts';
import { CompositeAuthenticator } from './platform/http/auth/adapters/composite/composite-authenticator.ts';
import { FetchHttpCall } from './platform/http/outbound-fetch.ts';
import { InProcessSandboxDriver } from './platform/sandboxes/adapters/in-process/in-process-sandbox-driver.ts';
// MKT-033 (DEPLOY-001): the AI Runtime provider adapter — wired HERE ONLY
// from the explicit MOS_AI_* configuration (the sanctioned composition-root
// adapter home the static checker and the AI-AC-03 boundary tests reserve
// for exactly this wiring). Behind the module boundary: no provider SDK is
// imported anywhere (the adapter rides the platform HttpCallPort).
import { OpenRouterAdapter } from './modules/ai-runtime/internal/adapters/openrouter-adapter.ts';
import type { ProviderAdapter } from './modules/ai-runtime/public.ts';
import { ConfigError } from './platform/errors/errors.ts';
import type { AppServices } from './platform/app-services.ts';
import type { ObservabilitySink } from './platform/observability/contract.ts';
import type { Logger } from './platform/observability/contract.ts';
import type { CachePort } from './platform/cache/contract.ts';
import type { LockPort } from './platform/locking/contract.ts';
import { createUsersModule } from './modules/users/public.ts';
import { createAuthModule } from './modules/auth/public.ts';
import { createAgenciesModule } from './modules/agencies/public.ts';
import { createClientsModule } from './modules/clients/public.ts';
import { createWorkspacesModule } from './modules/workspaces/public.ts';
import { createCredentialsModule } from './modules/credentials/public.ts';
import { createAuditModule } from './modules/audit/public.ts';
import { createGoalsModule } from './modules/goals/public.ts';
import { createPlaybooksModule } from './modules/playbooks/public.ts';
import { createWorkflowsModule } from './modules/workflows/public.ts';
import { createExecutionsModule } from './modules/executions/public.ts';
// MKT-013: /evidence module (EVID-001).
import { createEvidenceModule } from './modules/evidence/public.ts';
// MKT-014: /metrics module (METRIC-001).
import { createMetricsModule } from './modules/metrics/public.ts';
// MKT-015: /experiments module (EXP-001 — experiment design records).
import { createExperimentsModule } from './modules/experiments/public.ts';
// MKT-016: /learnings module (LEARN-001 — Learning records + the
// contradiction/supersession/retirement relationship history).
import { createLearningModule } from './modules/learnings/public.ts';
// MKT-042: /decisions module (the Decision Ledger — the append-oriented
// ledger for material recommendations and commercial decisions).
import { createDecisionsModule } from './modules/decisions/public.ts';
// MKT-043: /profit-intelligence module (Profit Intelligence — the DERIVED
// revenue/cost/capacity/scope/margin analytics read model over the
// canonical authorities' public contracts; live derivation, no owned
// durable state, zero mutation methods — architecture-lock-v1.5 #6).
import { createProfitIntelligenceModule } from './modules/profit-intelligence/public.ts';
// MKT-045: /ai-operator module (AI Operator / Attention Queue — the
// DERIVED ranked attention-queue read model over the canonical
// authorities' public contracts: blocked work, approvals, client risk,
// anomalies, scope leakage, margin pressure, capacity constraints and
// opportunities as governed action candidates; live derivation, no owned
// durable state, zero mutation methods — consequential actions continue
// through the existing policy/approval contracts, architecture-v1.5.md
// §7).
import { createAiOperatorModule } from './modules/ai-operator/public.ts';
// MKT-046: /sales-continuity module (Sales-to-Delivery Continuity — the
// §8 orchestrator carrying structured proposal scope/goals/outcomes/
// assumptions/economics into the Playbook/Deployment path through the
// EXISTING creation commands, with provenance + version identity on its
// own append-only continuity ledger).
import { createSalesContinuityModule } from './modules/sales-continuity/public.ts';
// MKT-044: /client-memory module (Client Operating Memory — the DERIVED
// governed client-context projection and retrieval surface over the
// canonical client, goal, playbook, deployment, evidence, experiment,
// outcome, decision and learning records; live derivation, no owned
// durable state, zero mutation methods — retrieval/index technology is
// non-authoritative and none exists: never a second tenant/data
// authority, PostgreSQL remains authoritative).
import { createClientMemoryModule } from './modules/client-memory/public.ts';

// MKT-017: /ai-runtime registry layer (TaskProfiles, model registry,
// usage telemetry — AI-001).
import { createAiRuntimeModule } from './modules/ai-runtime/public.ts';
import { createFieldAgentsModule } from './modules/field-agents/public.ts';
// MKT-026: /jobs module (JOB-001).
import { createJobsModule } from './modules/jobs/public.ts';
// MKT-020: /agents — logical Agent/Capability contracts (AGENT-001).
import { createAgentsModule } from './modules/agents/public.ts';
// MKT-021: /policies — the execution policy engine (POL-001).
import { createPoliciesModule } from './modules/policies/public.ts';
// MKT-023: /integrations module (the provider integration boundary).
import { createIntegrationsModule } from './modules/integrations/public.ts';
// MKT-056: the /integrations adapter PORT type — the AppOptions seam that
// appends test/conformance integration adapters to the registry (the
// socialAccountFlows composition precedent).
import type { IntegrationAdapter } from './modules/integrations/public.ts';
// MKT-024: the FIRST-PARTY CONNECTORS (Meta, Google Ads, generic
// analytics, CRM, commerce/CMS) — concrete adapter implementations under
// the sanctioned internal/adapters/** home, imported HERE ONLY (the
// composition root is the sole sanctioned importer per the static
// architecture checker; CONCRETE_ADAPTER_ACCESS). All provider egress
// flows through the platform HttpCallPort (fetch-based — zero provider
// SDKs in src/); endpoints arrive as non-secret connection providerConfig
// data (sandbox/loopback overrides), credential material resolves
// in-process through /credentials after fail-closed /policies allows.
import { MetaAdsAdapter } from './modules/integrations/internal/adapters/meta/meta-adapter.ts';
import { GoogleAdsAdapter } from './modules/integrations/internal/adapters/google-ads/google-ads-adapter.ts';
import { GenericAnalyticsAdapter } from './modules/integrations/internal/adapters/analytics/analytics-adapter.ts';
import { CrmAdapter } from './modules/integrations/internal/adapters/crm/crm-adapter.ts';
import { CommerceCmsAdapter } from './modules/integrations/internal/adapters/commerce/commerce-adapter.ts';
// MKT-038: the CREATOR-PLATFORM CONNECTOR — the Creator Operations provider
// integration proof (CREATOR-AC-05 + E2E-AC-02). The same first-party pattern
// as the MKT-024 five: a concrete adapter under the sanctioned
// internal/adapters/** home, imported HERE ONLY (CONCRETE_ADAPTER_ACCESS),
// constructed on the platform HttpCallPort, injected as DATA below. The
// adapter exposes the seven normalized creator capabilities the MKT-037
// pack declared as §6 integration-bindings (the pack carries the
// provider-neutral labels; the provider shapes live only in the adapter
// subtree); its two mutation capabilities are the provider halves of the
// pack's CREATOR-AC-06 approval-gated side effects and are themselves
// fail-closed policy-gated by the /integrations module on every invocation.
// Sandboxed/loopback endpoints arrive as non-secret providerConfig data
// exactly like the MKT-024 connectors.
import { CreatorPlatformAdapter } from './modules/integrations/internal/adapters/creator-platform/creator-platform-adapter.ts';
// MKT-022: /extensions — the extension registry and manifest contract
// (EXT-001).
import { createExtensionsModule } from './modules/extensions/public.ts';
// MKT-036: /domain-packs — the versioned Domain Pack framework
// (PACK-001).
import { createDomainPacksModule } from './modules/domain-packs/public.ts';
// MKT-037: the Creator Operations Domain Pack (CREATOR-001) — composed
// through the /domain-packs public entry (the pack's structural ports are
// satisfied by the concrete module public-contract instances here).
import { createCreatorOperationsPack } from './modules/domain-packs/public.ts';
// MKT-030: /reporting — read-side reporting (UI-001 — the Client Decision
// Room live aggregation over the composed authorities' public contracts).
import { createReportingModule } from './modules/reporting/public.ts';
// MKT-040: /deployments — the Marketing Cloud Deployment control plane
// (DEPLOY-002). Constructed with STRUCTURAL PORTS ONLY (the frozen
// module-dependency-matrix grants /deployments no direct module imports —
// the /integrations MKT-023 precedent extended to the whole dependency
// surface): the concrete /workspaces, /playbooks, /workflows,
// /domain-packs, /extensions, /integrations, /policies, /credentials and
// /executions public-contract instances satisfy the narrow port types
// structurally (TypeScript structural typing) and are wired HERE, so the
// resolution/authorization/request-execution still executes server-side
// THROUGH those public contracts while the frozen import matrix stays
// intact (no cross-module import exists inside src/modules/deployments —
// verified by tools/arch-check and the boundary tests).
import { createDeploymentsModule } from './modules/deployments/public.ts';
// MKT-041: /operating-graph — the Agency Operating Graph (the derived
// coordination model over the canonical authorities: the canonical-record
// registry + the append-oriented versioned relation ledger, the converging
// rebuild and the read-only views; composed READ-ONLY over the /clients,
// /workspaces, /goals, /playbooks, /workflows, /executions, /deployments,
// /evidence, /experiments and /learnings public contracts — the frozen
// matrix line added for this Work Item).
import { createOperatingGraphModule } from './modules/operating-graph/public.ts';
// MKT-047: /apps — the App registry (App Manifest and Packaging v1).
// Constructed with a STRUCTURAL PORT ONLY (the /deployments posture:
// the module holds an EMPTY dependency-matrix allowance): the concrete
// /extensions public-contract instance satisfies the narrow READ-ONLY
// AppsExtensionsPort structurally (TypeScript structural typing) and is
// wired HERE, so dependency validation composes over the /extensions
// authority server-side while the frozen import matrix stays intact (no
// cross-module import exists inside src/modules/apps — verified by
// tools/arch-check and the apps-boundary architecture tests). The App
// registry adds NO mutation surface over extensions (composition, not
// authority transfer — architecture-lock v1.5 #7).
import { createAppsModule } from './modules/apps/public.ts';
// MKT-048: /app-installs — the App installation authority (the
// workspace-scoped app lifecycle: install/upgrade/rollback over the
// /apps registry through its public contract, the /policies install-time
// gate, and the /workspaces + /extensions ownership/availability ports —
// the frozen matrix row added by this Work Item).
import { createAppInstallsModule } from './modules/app-installs/public.ts';
// MKT-050: /app-marketplace — the App Marketplace, Trust and
// Certification surface (the discovery/review read model over the /apps
// registry through its public contract + the append-only trust_events
// governance ledger and app_reviews display-metadata records of
// migration 042; the policy-eligibility read-side query — the frozen
// matrix row added by this Work Item).
import { createAppMarketplaceModule } from './modules/app-marketplace/public.ts';
// MKT-052: /app-metering — the App Metering and Commercial Attribution
// authority (the append-only meter event tail over the real install /
// invocation / usage events, the usage-observation ingestion command, the
// rebuildable rollup projection and the derived attribution read models).
import { createAppMeteringModule } from './modules/app-metering/public.ts';
// MKT-051: /first-party-apps — the Incumbent Capability App Program
// composition home (the four first-party capability packs: the typed
// manifests that publish through the REAL /apps registry command plus
// the presentation-only surface composers over the incumbent
// authorities' public contracts). Composition is the frozen-matrix row
// added by this Work Item: /apps (the pinned immutable manifest of the
// current selection's EXACT App Version) and /app-installs (the
// workspace's CURRENT selections with their SERVER-DERIVED granted
// scopes) are consumed READ-ONLY; the incumbent authorities (/reporting,
// /profit-intelligence, /clients, /workspaces, /decisions, /evidence,
// /metrics, /integrations) are consumed READ-ONLY through the
// /reporting + /profit-intelligence live-aggregation precedent. The
// module holds NO database dependency and takes NO migration (the
// bounded app state is in-memory with export/delete semantics — the
// MKT-051 required preference, disclosed in the runbook).
import { createFirstPartyAppsModule } from './modules/first-party-apps/public.ts';
// MKT-053: /growth-missions — the Growth Mission and Objective Model
// authority (spec/effective-backlog-v1.6.md section A; spec/
// architecture-v1.6.md §1/§2/§3; spec/architecture-lock-v1.6.md rules
// 16/17/41): the agency-scoped durable mission records (the declared
// objective VERBATIM + the frozen §3 objective-family vocabulary + the
// product/market context + the lifecycle state), the append-only version
// tail (immutable objective — corrections are NEW version records), the
// append-only history tail (state transitions with actor + provenance +
// reason, terminal transitions citing the declared-family decision basis)
// and the mission→goal mapping rows (canonical goal references through the
// /goals public contract, READ-ONLY). A durable orchestration LAYER over
// the existing Goals — never a replacement authority, never a second
// workflow/execution engine, and NO controller/scheduler/replanner (the
// Growth Operator is MKT-054, a later Work Item that composes these
// module commands server-side).
import { createGrowthMissionsModule } from './modules/growth-missions/public.ts';
// MKT-054: /growth-operator — the Growth Operator authority (the
// persistent goal-pursuit controller over the MKT-053 mission model:
// restart-safe, idempotent replanning, blocked/paused/resume semantics,
// bounded next-experiment/action selection through the existing
// Workflow/Execution authorities, zero-human robustness — never a second
// workflow or execution engine; see the wiring point below for the
// structural-port posture).
import { createGrowthOperatorModule } from './modules/growth-operator/public.ts';
import type { GrowthOperatorDelegationGatePort } from './modules/growth-operator/public.ts';
// MKT-055: /social-accounts — the Social Account and OAuth Connection
// Model authority (the account identity bindings over EXISTING authorized
// integrations, the append-oriented OAuth authorization-grant lifecycle
// with verbatim scope records + capability tags, the append-only history
// tail and the fail-closed disconnect/revocation death semantics).
// MKT-056 extends the module with the NORMALIZED SOCIAL PLATFORM ADAPTER
// CONTRACT: the capability-matrix registry, the normalized
// account/content/analytics/publish/restriction-signal operations and
// the publish idempotency ledger (migration 050).
// MKT-057 registers the FIRST CONCRETE PLATFORM ADAPTER (YouTube) as
// production DATA below (the CONCRETE_ADAPTER_ACCESS allowance — the
// MetaAdsAdapter precedent: constructed on the platform HttpCallPort,
// fetch-based, zero provider SDKs; the remaining MVP platforms arrive
// with MKT-058..061 through the same first-party pattern or the
// disclosed AppOptions.socialPlatformAdapters seam).
// MKT-058 registers the SECOND CONCRETE PLATFORM ADAPTER (Instagram —
// the documented Instagram Graph API surface for Professional
// accounts) through the SAME first-party pattern.
import { createSocialAccountsModule } from './modules/social-accounts/public.ts';
import type {
  SocialAccountFlowImplementation,
  SocialPlatformAdapter,
} from './modules/social-accounts/public.ts';
// MKT-057: the concrete YouTube platform adapter — imported HERE ONLY
// (CONCRETE_ADAPTER_ACCESS: concrete adapters are importable only by the
// composition root, where they become module DATA; no adapter imports
// another adapter). The wiring is INERT without an authorized YouTube
// integration connection + OAuth grant: the fail-closed host chain
// (account lookup → adapter registry → capability matrix → usable
// authorization → scope pre-check → /policies gates → §21 material
// resolution) precedes every provider call, so the registered adapter
// alone performs ZERO provider traffic.
import {
  createYouTubeSocialAdapter,
  YOUTUBE_SOCIAL_ADAPTER_KEY,
} from './modules/social-accounts/internal/adapters/youtube/adapter.ts';
// MKT-058: the concrete Instagram platform adapter — imported HERE ONLY
// (CONCRETE_ADAPTER_ACCESS, the MKT-057 precedent: concrete adapters are
// importable only by the composition root, where they become module
// DATA; no adapter imports another adapter). The wiring is INERT
// without an authorized Instagram integration connection + OAuth grant:
// the fail-closed host chain (account lookup → adapter registry →
// capability matrix → usable authorization → scope pre-check →
// /policies gates → §21 material resolution) precedes every provider
// call, so the registered adapter alone performs ZERO provider traffic.
import {
  createInstagramSocialAdapter,
  INSTAGRAM_SOCIAL_ADAPTER_KEY,
} from './modules/social-accounts/internal/adapters/instagram/adapter.ts';
// MKT-069: /product-intelligence — the Product Intelligence authority
// (the durable product/market inspection and model records of
// spec/architecture-v1.6.md §8). Composition is the frozen-matrix row
// registered by this Work Item (the currently-satisfiable subset of the
// frozen v1.6 row: /evidence, /integrations, /ai-runtime — /research
// joins at MKT-062 time): the /integrations public contract arrives
// through the module's declared narrow READ-ONLY STRUCTURAL PORT
// (getConnection + executeRead ONLY — executeMutation is structurally
// absent, so the read-only guarantee of boundary rule 7 is a compile-time
// property of the wiring), the /ai-runtime registry through the model-
// identity port (AI-assistance disclosure validation), and the ONE
// /evidence import (the shared §21 material-key guard) lives inside the
// module's store. The REAL page reader (the bounded GET-only public-page
// read over the platform HttpCallPort — fetch-based, zero SDKs) is the
// module-internal adapter imported HERE ONLY (the CONCRETE_ADAPTER_ACCESS
// allowance); the test suites supply the disclosed in-repo test double
// through the same port instead (NO live network in the test suite).
import { createProductIntelligenceModule } from './modules/product-intelligence/public.ts';
import { HttpPageReader } from './modules/product-intelligence/internal/adapters/http-page-reader.ts';
import type { ProductPageReader } from './modules/product-intelligence/public.ts';
// MKT-068: /notification-delivery — the Notification Delivery Plane
// authority (the durable notification records with the §14 field set,
// the event-occurrence dedup fence, the append-only per-channel
// delivery-attempt receipts, the in-app read-state projection and the
// pluggable DeliveryAdapter contract). The EMAIL adapter is imported
// from the module's sanctioned provider-seam subtree
// (modules/notification-delivery/internal/adapters/ — the OpenRouterAdapter
// composition precedent: concrete adapters are wired HERE only) and
// registered as module DATA; the in-app channel is module-internal.
import { createNotificationDeliveryModule } from './modules/notification-delivery/public.ts';
import type {
  EmailTransportPort,
  NotificationRecipientCandidate,
} from './modules/notification-delivery/public.ts';
import { createEmailNotificationAdapter } from './modules/notification-delivery/internal/adapters/email-adapter.ts';
// MKT-063: /content-rights — the Content Rights and Provenance authority
// (the asset-level rights records over the OPAQUE content-asset
// reference seam — the MKT-064 id-based integration, NOT an import of a
// nonexistent module; the frozen rights state model with transitions as
// append-only recorded events; the human clearance records as the ONLY
// review → cleared path; the immutable ingredient lineage links resolving
// composites as the CONJUNCTION of their ingredients; the
// destination-platform permission scope; THE fail-closed publication gate
// — absent evaluation blocked, unknown/review never auto-approve, the
// destination policy gate through /policies). Composition is the
// currently-satisfiable subset of the frozen v1.6 matrix row
// (the /product-intelligence MKT-069 disclosed-registration precedent):
// /evidence (canonical resolution of every evidence link) + /policies
// (the destination gate of every publication-gate evaluation);
// /content-assets joins the row at MKT-064 time. NO publication verb
// exists anywhere in the module (boundary rule 4).
import { createContentRightsModule } from './modules/content-rights/public.ts';
// MKT-064: /content-assets — the Content Asset and Transformation
// authority (the immutable versioned artifact records over the
// opaque 'ca:'-minted refs — the OTHER side of the 063 seam, now
// completed; explicit versions, no floating pointers;
// content-addressed object references through the MKT-001 ObjectStore
// platform port; /evidence-anchored source provenance as the id-based
// seam (the /app-metering route-layer precedent); the append-only
// quality OBSERVATIONS; and the recorded TRANSFORMATIONS of the frozen
// family whose EXECUTION flows through the EXISTING /executions
// authority — no second engine — with the engine as a replaceable
// capability behind the TransformationEngine port registered as module
// DATA, EMPTY in production by default). The derivation records the
// /content-rights ingredient lineage links through the 063 public
// contract; transforming an asset NEVER checks or mutates rights
// (boundary rule 5).
import { createContentAssetsModule } from './modules/content-assets/public.ts';
import type { TransformationEngine } from './modules/content-assets/public.ts';
// MKT-067: /experiment-analysis — the Experiment Analysis and Adaptive
// Allocation authority (the v1.6 §12 analysis layer over the existing
// /experiments authority — never a second experiment engine; the
// deterministic two-sample statistics core + the bounded adaptive
// allocator, all recorded as append-only DATA with full input snapshots
// and canonical digests; allocation results are recommendations toward
// the mission/operator layer, never exposure mutations).
import { createExperimentAnalysisModule } from './modules/experiment-analysis/public.ts';
// MKT-065: /cross-platform-distribution — the Cross-Platform Distribution
// authority (the frozen v1.6 §5 module; consumed through its public
// contract ONLY: growth-missions, social-accounts, content-assets,
// content-rights, integrations, policies).
import { createCrossPlatformDistributionModule } from './modules/cross-platform-distribution/public.ts';
// MKT-062: /research — the Web Research authority (the frozen v1.6 §7
// module: the agency-scoped research sessions with their IMMUTABLE
// versioned declared sources, the deterministic GET-only fetch/extract
// research pipeline behind the replaceable page-reader port, the retained
// source facts with FULL provenance in the module's OWN migration-056
// tables, and the append-only research insight claims with the /ai-runtime
// model-identity disclosure + the server-computed verification state).
// Composition is the frozen v1.6 matrix row registered by this Work Item
// (/research ──→ /integrations, /evidence, /ai-runtime — verbatim): the
// /integrations public contract arrives through the module's declared
// narrow READ-ONLY STRUCTURAL PORT (getConnection + executeRead ONLY —
// executeMutation is structurally absent, so NO mutation can be expressed
// toward any research source), the /ai-runtime registry through the
// model-identity port (AI-assistance disclosure validation) and the ONE
// /evidence import (the shared §21 material-key guard) lives inside the
// module's store. The REAL page reader (the bounded GET-only public-page
// read over the platform HttpCallPort — fetch-based, zero SDKs) is the
// module-internal adapter imported HERE ONLY (the CONCRETE_ADAPTER_ACCESS
// allowance); the test suites supply the disclosed in-repo test double
// through the same port instead (NO live network in the test suite).
import { createResearchModule } from './modules/research/public.ts';
import { ResearchHttpPageReader } from './modules/research/internal/adapters/http-page-reader.ts';
import type { ResearchPageReader } from './modules/research/public.ts';
// MKT-062: /content-intelligence — the Content Intelligence authority
// (the frozen v1.6 §6 module: platform observations normalized into
// canonical /evidence records through the /evidence public contract +
// CLIENT-SCOPED append-only CANDIDATE records with the §6 observed-feature
// set as data + append-only HYPOTHESES with the honest non-causality
// framing + the deterministic niche clustering and candidate ranking as
// reproducible pure functions). Composition is the frozen v1.6 matrix row
// registered by this Work Item (/content-intelligence ──→ /evidence,
// /metrics, /experiments, /integrations, /research — verbatim, all five
// consumed through their public contracts: /evidence as the SOLE evidence
// authority, /metrics + /experiments + /research READ-ONLY for the
// observed-performance anchor / the hypothesis experiment-reference / the
// same-agency research-insight citations, and /integrations through the
// declared narrow READ-ONLY STRUCTURAL PORT).
import { createContentIntelligenceModule } from './modules/content-intelligence/public.ts';

import type { ApplicationModules } from './api/application.ts';

export interface AppOptions {
  /** Additional observability sinks (e.g., test collectors). */
  readonly extraSinks?: ReadonlyArray<ObservabilitySink> | undefined;
  /** Override the primary sink (tests capture records without console noise). */
  readonly primarySink?: ObservabilitySink | undefined;
  /**
   * MKT-055: additional provider-neutral OAuth flow implementations for
   * the /social-accounts module (the extraSinks composition precedent).
   * EMPTY by default — the production composition registers NO flow
   * until the MKT-056+ adapter deliveries wire real platform flows (a
   * flow step against a platform with no registered flow is refused
   * fail-closed). Integration tests supply the DISCLOSED LOCAL provider
   * double through this seam (a test double at the provider boundary
   * ONLY — the connection model under test is fully real).
   */
  readonly socialAccountFlows?: ReadonlyArray<SocialAccountFlowImplementation> | undefined;
  /**
   * MKT-064: additional TRANSFORMATION ENGINES for the /content-assets
   * module (the first-party/extension capability seam — the
   * socialAccountFlows composition precedent). EMPTY by default: the
   * production composition registers NO engine (the MKT-056 discipline —
   * a transformation kind with no registered engine fails closed at
   * request time, never a silent fallback). Integration tests supply
   * the DISCLOSED first-party doubles through this seam (the passthrough
   * no-op + the format/crop doubles, re-exported from the module's
   * public entry); real media-processing capabilities and
   * Extension/App engine bridges arrive as future registered engines.
   */
  readonly contentTransformationEngines?: ReadonlyArray<TransformationEngine> | undefined;
  /**
   * MKT-056: additional SOCIAL PLATFORM ADAPTER instances for the
   * /social-accounts module's normalized capability plane (the
   * socialAccountFlows composition precedent). The production
   * composition registers the FIRST-PARTY platform adapters as DATA
   * (MKT-057 wires YouTube; MKT-058 wires Instagram; MKT-059..061
   * follow) — an operation against a platform with NO registered
   * adapter is still refused fail-closed.
   * A seam-supplied adapter of an already-registered first-party
   * adapter key OVERRIDES the first-party instance (the disclosed
   * MKT-057 test-seam override — the conformance-suite platform
   * doubles register under their platform key against their own
   * provider doubles; a test double at the provider boundary ONLY —
   * the contract host under test is fully real).
   */
  readonly socialPlatformAdapters?: ReadonlyArray<SocialPlatformAdapter> | undefined;
  /**
   * MKT-056: additional INTEGRATION ADAPTER instances appended to the
   * /integrations registry (the socialAccountFlows composition
   * precedent). EMPTY by default — the production adapter set is the
   * first-party list below. The social-adapter conformance suite
   * supplies the disclosed stub integration adapter of the reference
   * platform through this seam (the connection pipe of the platform
   * under test); future platform deliveries reuse the seam for their
   * platform's integration pipe during conformance runs before their
   * production wiring lands.
   */
  readonly integrationAdapters?: ReadonlyArray<IntegrationAdapter> | undefined;
  /**
   * MKT-069: an override ProductPageReader for the /product-intelligence
   * module (the socialAccountFlows composition precedent). UNSET by
   * default — the production composition wires the REAL bounded GET-only
   * HttpPageReader over the platform HttpCallPort. Integration tests
   * supply the DISCLOSED in-repo test double through this seam (a test
   * double at the fetch boundary ONLY — the inspection pipeline under
   * test is fully real; NO live network in the test suite).
   */
  readonly productPageReader?: ProductPageReader | undefined;
  /**
   * MKT-062: an override ResearchPageReader for the /research module
   * (the productPageReader composition precedent). UNSET by default — the
   * production composition wires the REAL bounded GET-only
   * ResearchHttpPageReader over the platform HttpCallPort. Integration
   * tests supply the DISCLOSED in-repo test double through this seam (a
   * test double at the fetch boundary ONLY — the research pipeline under
   * test is fully real; NO live network in the test suite).
   */
  readonly researchPageReader?: ResearchPageReader | undefined;
  /**
   * MKT-068: the EMAIL provider transport — the deterministic provider
   * seam of the /notification-delivery email channel (the
   * socialAccountFlows composition precedent). A real provider transport
   * (SMTP/API egress over the platform HTTP port — no SDK) is future
   * composition-root wiring; until one is supplied the email channel is
   * simply ABSENT (the in-app channel always delivers — fail-closed). The
   * integration tests supply the DETERMINISTIC IN-REPO test double (no
   * network) through this seam.
   */
  readonly notificationEmailTransport?: EmailTransportPort | undefined;
  /**
   * MKT-068: the explicit email provider configuration (the vault
   * REFERENCE id of the provider credential + the sender address).
   * Required together with notificationEmailTransport to wire the email
   * channel; the vault reference is agency-scoped (a notification whose
   * agency has no resolvable reference fails email honestly — the
   * in-app channel still delivers; the material resolves ONLY in-process
   * at delivery time through the /credentials vault). Production env
   * wiring arrives with the real provider transport Work Item (the
   * MOS_AI_* config precedent); today this seam serves the explicit
   * composition callers (tests) — DISCLOSED.
   */
  readonly notificationEmailProvider?: {
    readonly credentialReferenceId: string;
    readonly fromAddress: string;
  } | undefined;
  /**
   * MKT-054: an override delegation gate for the /growth-operator module
   * (the productPageReader composition precedent). UNSET by default — the
   * production composition wires the /policies-composed gate (dimension
   * 'tools', operation 'growth-operator.delegate'). Integration tests
   * supply the DISCLOSED rights-gate double through this seam (a test
   * double at the gate boundary ONLY — the controller under test is fully
   * real; the real /content-rights authority composes this same port when
   * MKT-063 lands).
   */
  readonly growthOperatorGate?: GrowthOperatorDelegationGatePort | undefined;
}

/**
 * Runtime wiring surfaced on the bootstrap result (MKT-033, DEPLOY-001):
 * the composition-root-wired capability adapters that route-time callers
 * consume. The AI provider adapter is the OpenRouterAdapter instance
 * constructed from the EXPLICIT MOS_AI_* configuration (null when the
 * documented default MOS_AI_PROVIDER=none applies). It stays BEHIND the
 * module boundary (the ProviderAdapter contract) — callers supply it to
 * /ai-runtime routeTask exactly as the MKT-018 route contract documents
 * ("the composition root wires the OpenRouter adapter; the integration
 * test supplies a fake").
 */
export interface RuntimeWiring {
  readonly aiProvider: ProviderAdapter | null;
}

interface Core {
  readonly services: AppServices;
  readonly modules: ApplicationModules;
  readonly runtime: RuntimeWiring;
}

function buildCore(config: AppConfig, options: AppOptions): Core {
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();

  const db = new PgDb(config.databaseUrl);
  const queue = new PgQueue(db, () => ids.newId(), config.queueStaleClaimMs);

  // Object store: the MKT-001 port, now with the production S3-compatible
  // adapter behind the SAME contract (wired here only — consumers unchanged).
  const objects =
    config.objectStore === 's3'
      ? new S3ObjectStore({
          endpoint: config.s3!.endpoint,
          region: config.s3!.region,
          bucket: config.s3!.bucket,
          accessKeyId: config.s3!.accessKeyId,
          secretAccessKey: config.s3!.secretAccessKey,
          pathStyle: config.s3!.pathStyle,
          requestTimeoutMs: config.s3!.requestTimeoutMs,
        })
      : config.objectStore === 'fs'
        ? new FsObjectStore(config.objectStoreDir)
        : new MemoryObjectStore();

  // Advisory cache/lock capabilities (MKT-005): a real Redis backend when
  // configured; otherwise the documented degenerate adapters. PostgreSQL
  // remains the authoritative system of record and durable queue authority
  // — Redis is wired ONLY for advisory cache and advisory locks.
  let cache: CachePort;
  let locks: LockPort;
  if (config.redis !== null) {
    const redis = config.redis;
    const shared = {
      host: redis.host,
      port: redis.port,
      username: redis.username === '' ? undefined : redis.username,
      password: redis.password === '' ? undefined : redis.password,
      secure: redis.secure,
      timeoutMs: config.redisTimeoutMs,
    };
    cache = new RedisCache({ ...shared, keyPrefix: 'mos:cache:' });
    locks = new RedisLock({ ...shared, keyPrefix: 'mos:lock:' });
  } else {
    cache = new NoCache();
    locks = new UnavailableLock();
  }

  // Secret backend: resolution-only file store (mounted-secret model).
  // Fail fast when the backend directory is absent: a half-configured
  // secret backend must abort startup, not silently fail at first resolve.
  if (!fs.existsSync(config.secretsDir) || !fs.statSync(config.secretsDir).isDirectory()) {
    throw new ConfigError('Secret backend directory does not exist', [
      `MOS_SECRETS_DIR=${config.secretsDir}: create the directory and mount secret files as <handle>.secret`,
    ]);
  }
  const secrets = new FileSecretStore({ dir: config.secretsDir });

  // Bounded provider-neutral outbound HTTP (MKT-011): the fetch transport
  // wired here only — task runners depend on the HttpCallPort contract.
  const httpCalls = new FetchHttpCall();

  // The sandbox environment driver (MKT-012): the default in-process
  // SIMULATED substrate wired here only — the /executions sandbox lifecycle
  // depends on the SandboxDriver contract, never on a concrete substrate
  // (real isolation substrates are later composition-root adapters).
  const sandboxDriver = new InProcessSandboxDriver();

  // MKT-033 (DEPLOY-001): the AI Runtime provider adapter wired from the
  // EXPLICIT MOS_AI_* configuration — complete-or-absent (config validation
  // aborts startup on a half-configured provider; the documented default
  // 'none' wires no adapter). The adapter rides the platform HttpCallPort
  // (fetch — zero provider SDKs) and is consumed through the
  // /ai-runtime ProviderAdapter contract only.
  const aiProvider: ProviderAdapter | null =
    config.aiRuntime === null
      ? null
      : new OpenRouterAdapter({
          http: httpCalls,
          endpoint: config.aiRuntime.endpoint,
          apiKey: config.aiRuntime.apiKey,
          timeoutMs: config.aiRuntime.timeoutMs,
        });

  const primarySink = options.primarySink ?? new ConsoleSink();
  const sink =
    options.extraSinks === undefined || options.extraSinks.length === 0
      ? primarySink
      : new CompositeSink([primarySink, ...options.extraSinks]);

  const loggerFactory = createLoggerFactory({ sink, clock, minLevel: config.logLevel });
  const metrics = new InMemoryMetrics();

  // Module wiring (dependency matrix: /auth → /users; /agencies → /users;
  // /clients → /agencies, /auth; /workspaces → /clients; /credentials and
  // /audit import no other module — they take platform ports + plain data;
  // /goals → /clients, /workspaces; /playbooks → /agencies, /clients,
  // /goals; /workflows → /workspaces, /playbooks — the MKT-008 definition
  // sub-authority plus the MKT-009 instance sub-authority: the Workspace
  // ownership chain resolves server-side and the Playbook provenance link
  // pins explicit playbook version ids; /executions → /workspaces — the
  // MKT-010 normalized execution model: workspace-scoped runtime attempts
  // whose canonical owner chain resolves server-side).
  const users = createUsersModule({ db, clock, ids });
  const auth = createAuthModule({
    db,
    clock,
    ids,
    users,
    sessionTtlMs: config.authSessionTtlMs,
  });
  const agencies = createAgenciesModule({ db, clock, ids, users });
  const clients = createClientsModule({ db, clock, ids, agencies });
  const workspaces = createWorkspacesModule({ db, clock, ids, clients });
  const credentials = createCredentialsModule({ db, clock, ids, secrets });
  const audit = createAuditModule({ db, clock, ids });
  const goals = createGoalsModule({ db, clock, ids, clients, workspaces });
  const playbooks = createPlaybooksModule({ db, clock, ids, agencies, clients, goals });
  const workflows = createWorkflowsModule({ db, clock, ids, workspaces, playbooks });
  const executions = createExecutionsModule({ db, clock, ids, workspaces, sandboxDriver });
  // MKT-013: /evidence — platform ports + the allowed /clients +
  // /workspaces canonical-ownership dependencies (frozen matrix:
  // /evidence ──→ /clients, /workspaces, /executions; this Work Item uses
  // the /clients + /workspaces subset — /executions references evidence,
  // not the other way around, architecture.md §11).
  const evidence = createEvidenceModule({ db, clock, ids, clients, workspaces });
  // MKT-014: /metrics — platform ports + the allowed /evidence dependency
  // (frozen matrix: /metrics ──→ /evidence, /integrations; /integrations is
  // MKT-023/024 — provider data ARRIVES as normalized observations, so
  // /metrics owns NO provider state) + the /clients and /workspaces
  // canonical-ownership authorities injected through /metrics' declared
  // STRUCTURAL PORTS: the real public-contract instances satisfy the port
  // types structurally (TypeScript structural typing), so ownership
  // resolution still executes THROUGH the exact /clients + /workspaces
  // public-contract methods, server-side, with no forbidden module import.
  // (Named metricsModule to stay distinct from the platform observability
  // InMemoryMetrics instance also wired below.)
  const metricsModule = createMetricsModule({ db, clock, ids, evidence, clients, workspaces });

  // MKT-015: /experiments — platform ports + the allowed /evidence
  // dependency (frozen matrix: /experiments ──→ /evidence, /metrics,
  // /goals; /evidence is the merged authority this Work Item consumes for
  // conclusion evidence-citation validation — /metrics and /goals stay
  // unused allowed directions: the frozen Experiment contract identifies
  // metrics BY NAME + DIMENSIONS and needs no goal linkage) + the /clients
  // and /workspaces canonical-ownership authorities injected through
  // /experiments' declared STRUCTURAL PORTS: the real public-contract
  // instances satisfy the port types structurally (TypeScript structural
  // typing), so ownership resolution still executes THROUGH the exact
  // /clients + /workspaces public-contract methods, server-side, with no
  // forbidden module import.
  const experiments = createExperimentsModule({ db, clock, ids, evidence, clients, workspaces });

  // MKT-016: /learnings — platform ports + the allowed /evidence and
  // /experiments dependencies (frozen matrix: /learnings ──→ /evidence,
  // /experiments, /goals; the two merged authorities this Work Item
  // consumes for supporting-reference validation — /evidence for the
  // evidence citations + the shared §21 material-key backstop,
  // /experiments for the CONCLUDED outcome references; /goals stays an
  // unused allowed direction) + the /clients and /workspaces
  // canonical-ownership authorities injected through /learnings'
  // declared STRUCTURAL PORTS: the real public-contract instances satisfy
  // the port types structurally (TypeScript structural typing), so
  // ownership resolution still executes THROUGH the exact /clients +
  // /workspaces public-contract methods, server-side, with no forbidden
  // module import.
  const learnings = createLearningModule({
    db,
    clock,
    ids,
    evidence,
    experiments,
    clients,
    workspaces,
  });

  // MKT-017: /ai-runtime — the REGISTRY LAYER of the AI Runtime authority
  // (dependency matrix: /ai-runtime ──→ /executions — used exactly for
  // telemetry execution-reference validation; nothing else is imported:
  // workspace scope arrives as server-derived data resolved by the routes
  // and DB-backstopped by the migration-016 scope-chain triggers).
  // MKT-019 (AI evaluation framework) composes the ONE additional
  // matrix-sanctioned dependency — the /evidence public API — for
  // evaluation citation validation (AI-AC-08: /metrics and /experiments
  // are never imported).
  const aiRuntime = createAiRuntimeModule({ db, clock, ids, executions, evidence });

  // MKT-025 (Human Agent foundation): the generalized /field-agents authority.
  // Platform ports + the /users identity dependency only (frozen matrix:
  // /field-agents ──→ /users, /clients, /policies; the /clients and /policies
  // allowances belong to the Work Items that own them). No tenant linkage is
  // wired here — agency linkage is the existing /agencies membership
  // authority, composed at the route layer.
  const fieldAgents = createFieldAgentsModule({ db, clock, ids, users });

  // MKT-026 (Job marketplace boundary): the /jobs authority — governed Task
  // projections, candidate-specific offers, the concurrency-safe acceptance
  // claim and outcome submission with server-derived provenance. Frozen
  // matrix dependencies wired: /workflows (READ-ONLY Task-reference +
  // ownership resolution), /field-agents (candidate profiles + the pure
  // eligibility matcher), /evidence (outcome evidence-reference validation).
  // No /agencies dependency (route-layer composition, exactly like
  // /field-agents); no execution dispatch (the runtime is MKT-011+); /jobs
  // never mutates workflow state.
  const jobs = createJobsModule({ db, clock, ids, workflows, fieldAgents, evidence });

  // MKT-027: the field-execution surface (visits, structured outcomes,
  // evidence capture, follow-up, continuity) is composed inside the SAME
  // createJobsModule call — same deps, same lock ordering, same authority;
  // nothing further to wire here (see modules/jobs/internal/visit-module.ts).

  // MKT-020: /agents — the logical Agent/Capability contracts authority
  // (AGENT-001). PLATFORM PORTS ONLY: the frozen matrix allows
  // /agents ──→ /executions, /ai-runtime, /policies, but the reusable
  // capability declaration composes none of them (architecture.md §12:
  // the logical Agent owns no tenant data, workflow state, deployment
  // state or infrastructure). The ownership scope arrives as server-
  // derived data resolved by the routes from canonical agency ownership
  // state; the migration-022 fences, scope immutability and FK are the
  // backstops.
  const agents = createAgentsModule({ db, clock, ids });

  // MKT-021: /policies — the execution policy engine (POL-001). Frozen
  // matrix dependencies wired: /agencies + /clients (canonical scope
  // resolution — agency/client ownership validation on administration
  // writes; scope re-validation before every policy read). The CRED-001
  // reference lookup arrives through the module's REFERENCE-ONLY
  // structural port: the concrete /credentials public-contract instance
  // (getCredentialReference returns reference records WITHOUT material)
  // satisfies the port structurally — the engine evaluates access
  // proposals, never material. No enforcement hooks (later Work Items).
  const policies = createPoliciesModule({ db, clock, ids, agencies, clients, credentialReferences: credentials });

  // MKT-023: /integrations — the provider integration boundary (INT-001:
  // the generic integration ports + the first-party adapter mechanism).
  // Frozen matrix dependencies wired DIRECTLY: /policies (the fail-closed
  // decision engine consulted before every provider-touching action) and
  // /credentials (credential REFERENCE validation on registration;
  // MATERIAL resolution in the authorized-execution scope after a policy
  // allow — in-process only). The REQUIRED canonical Client ownership
  // resolution (implementation-contract §2) and the /evidence append flow
  // for verified webhook events arrive through the module's declared
  // STRUCTURAL PORTS: the concrete /clients and /evidence public-contract
  // instances satisfy the narrow port types structurally (TypeScript
  // structural typing — the metrics MKT-014 precedent), so ownership
  // resolution and evidence appends still execute server-side THROUGH
  // those public contracts while the frozen import matrix stays intact
  // (no /clients or /evidence import exists inside src/modules/
  // integrations — verified by tools/arch-check). The ADAPTER SET is
  // injected DATA: MKT-024 registers the FIRST-PARTY CONNECTORS — Meta
  // (Marketing API), Google Ads, generic analytics, CRM (with the
  // contact-sync mutation) and commerce/CMS — and MKT-038 appends the
  // CREATOR-PLATFORM CONNECTOR (the creator-operations provider seam the
  // MKT-037 pack's §6 integration-bindings bind to) — all constructed on
  // the platform HttpCallPort (httpCalls, fetch-based, NO provider SDK).
  // The registry is validated at construction and contains no provider
  // branches; later Work Items add connectors by appending DATA here
  // (MKT-022 extension-registry integrations).
  const integrations = createIntegrationsModule({
    db,
    clock,
    ids,
    policies,
    credentials,
    clientOwnership: clients,
    evidenceSink: evidence,
    adapters: [
      new MetaAdsAdapter({ http: httpCalls }),
      new GoogleAdsAdapter({ http: httpCalls }),
      new GenericAnalyticsAdapter({ http: httpCalls }),
      new CrmAdapter({ http: httpCalls }),
      // MKT-071: the commerce/CMS connector is constructed with the
      // deployment's provider-granted capability profile
      // (MOS_COMMERCE_GRANTED_CAPABILITIES — the capability-subset
      // declaration; a read-only grant yields a read-only commerce
      // adapter, and an unknown key fails startup loudly inside the
      // adapter's closed-vocabulary validation).
      new CommerceCmsAdapter({
        http: httpCalls,
        ...(config.commerceGrantedCapabilities === null
          ? {}
          : { grantedCapabilityKeys: config.commerceGrantedCapabilities }),
      }),
      // MKT-056: the disclosed composition seam — additional integration
      // adapters arrive as DATA (the conformance-suite stub pipe of the
      // platform under test; future platform deliveries during their
      // conformance runs). EMPTY in the production default.
      ...(options.integrationAdapters ?? []),
      new CreatorPlatformAdapter({ http: httpCalls }),
    ],
  });

  // MKT-022: /extensions — the extension registry and manifest contract
  // (EXT-001). Frozen matrix dependencies wired: /executions (canonical
  // execution ownership resolution for the invocation contract — the
  // scope of every invocation context is the execution's canonical
  // owner), /policies (the fail-closed extension-dimension 'install' and
  // 'invoke' gates — only an explicit recorded 'allow' proceeds) and
  // /credentials (configure-time secret-binding REFERENCE resolution —
  // references only, never material). The module holds NO /workflows and
  // NO /evidence dependency: workflow state and evidence provenance are
  // structurally unreachable from /extensions (EXT-AC-03/EXT-AC-04).
  const extensions = createExtensionsModule({ db, clock, ids, executions, policies, credentials });

  // MKT-036: /domain-packs — the versioned Domain Pack framework
  // (PACK-001). The frozen matrix allows /domain-packs sixteen module
  // dependencies, but the FRAMEWORK composes NONE at module level (the
  // /agents precedent of deliberately-unused allowances): the install
  // scope arrives as SERVER-DERIVED data from the routes (canonical
  // /workspaces owner resolution, exactly the /extensions scope-as-data
  // posture), and pack workflow-template conformance is validated
  // through the PURE /workflows §4 definition validator imported inside
  // the module's store (the ONLY cross-module import — matrix-allowed).
  // Runtime composition with the Execution, Evidence, AI Router,
  // Credential, Policy and Audit authorities happens when pack workflows
  // EXECUTE through /workflows + /executions (MKT-008/MKT-010/MKT-017/
  // MKT-005/MKT-021/MKT-006), never inside the framework: the module has
  // NO execution path of its own (PACK-AC-02 — asserted by the static
  // architecture tests).
  const domainPacks = createDomainPacksModule({ db, clock, ids });

  // MKT-037: the Creator Operations Domain Pack (CREATOR-001) — the first
  // business pack composed through the framework. The pack service composes
  // the platform authorities through the NARROW STRUCTURAL PORTS of its
  // contract (the /metrics ownership-port precedent): canonical /clients
  // ownership resolution before every write, the /evidence + /metrics append
  // surfaces for the §7 observation mapping (the pack owns the mapping, not a
  // parallel store), the /policies fail-closed evaluation surface for the
  // CREATOR-AC-06 conversation-send/content-publish approval gates, the
  // /ai-runtime TaskProfile creation surface for the §5 AI task classes
  // (consumed through the platform AI Router, never provider model calls)
  // and the SAME-MODULE /domain-packs framework authority for the frozen
  // pack-manifest publication. The wiring here is the type-level proof that
  // the real public-contract instances satisfy the ports. The pack-owned
  // subject rows live in migration 031 (the number reserved for
  // this Work Item); no second tenant/authority table is created anywhere.
  const creatorOperations = createCreatorOperationsPack({
    db,
    clock,
    ids,
    domainPacks,
    clients,
    evidence,
    metrics: metricsModule,
    policies,
    aiRuntime,
  });

  // MKT-030 + MKT-029: /reporting — the read-side Client Decision Room and
  // Agency Command Center (UI-001). A PURE LIVE AGGREGATION over the
  // composed authorities' public contracts: platform clock + the
  // frozen-matrix-allowed /goals, /workflows, /executions, /evidence,
  // /experiments and /learnings dependencies (/metrics stays an unused
  // allowed direction). MKT-029 adds the /executions direction of the same
  // frozen matrix line — the failed/unresolved executions are the canonical
  // operational-risk signals the Command Center's risk posture presents.
  // The module owns NO durable state: no projection tables, nothing to
  // migrate or rebuild (migration 032 stays RESERVED for a future Work Item
  // — 031 is the Creator Operations pack schema of MKT-037), and no
  // db/ids are wired because there is no write path of any kind. The
  // agency/Client/Workspace scopes arrive as SERVER-DERIVED data resolved
  // by the route layers (durable agency/membership state + the /clients
  // live-client listing + the /workspaces enumeration — matrix directions
  // /reporting does not hold; the /agents and /domain-packs scope-as-data
  // posture).
  const reporting = createReportingModule({
    clock,
    goals,
    workflows,
    executions,
    evidence,
    experiments,
    learnings,
  });

  // MKT-040: /deployments — the Marketing Cloud Deployment control plane
  // (DEPLOY-002). The structural ports are satisfied by the REAL
  // public-contract instances constructed above (the type-level proof
  // that the ports compose the authorities without importing them):
  // workspace ownership via /workspaces, immutable version resolution via
  // /playbooks + /workflows (read-only), pack/extension/integration
  // availability via their registries and installs (read-only), the
  // fail-closed deployment-dimension policy gate via /policies,
  // credential REFERENCES via /credentials (reference-only), and the
  // REQUEST-EXECUTION surface via /executions createExecution (the ONLY
  // sanctioned interaction with the execution authority — the module has
  // no dispatch/retry/orchestration path of its own, DEPLOY-AC-07). The
  // createExecution input is deliberately narrowed to the deployment's
  // request shape (external-request task link, deterministic kind, the
  // deployment's DECLARED runtime class — DEPLOY-AC-09 runtime
  // neutrality) so the port itself cannot express execution-lifecycle
  // mutation.
  const deployments = createDeploymentsModule({
    db,
    clock,
    ids,
    workspaceOwnership: workspaces,
    playbooks,
    workflows: {
      getWorkflowDefinition: (definitionId) => workflows.getWorkflowDefinition(definitionId),
      getWorkflow: (workflowId) => workflows.getWorkflow(workflowId),
    },
    domainPacks: {
      listDomainPackInstalls: (workspaceId) => domainPacks.listDomainPackInstalls(workspaceId),
      getDomainPackVersion: async (packId) => {
        const pack = await domainPacks.getDomainPackVersion(packId);
        return pack === null
          ? null
          : { packId: pack.packId, packKey: pack.manifest.packKey, version: pack.manifest.version };
      },
    },
    extensions: {
      listExtensionInstalls: (workspaceId) => extensions.listExtensionInstalls(workspaceId),
      getExtensionVersion: async (extensionId) => {
        const extension = await extensions.getExtensionVersion(extensionId);
        return extension === null
          ? null
          : {
              extensionId: extension.extensionId,
              extensionKey: extension.manifest.extensionKey,
              version: extension.manifest.version,
            };
      },
    },
    integrations: {
      listRegisteredAdapters: () =>
        integrations.listRegisteredAdapters().map((adapter) => ({
          adapterKey: adapter.descriptor.adapterKey,
        })),
      listConnectionsForClient: (clientId) => integrations.listConnectionsForClient(clientId),
    },
    policies,
    credentials,
    executions: {
      createExecution: async (input) => {
        const outcome = await executions.createExecution({
          workspaceId: input.workspaceId,
          taskLink: input.taskLink,
          retryOfExecutionId: null,
          executionKind: 'deterministic',
          runtimeClass: input.runtimeClass as 'pooled-worker',
          idempotencyKey: input.idempotencyKey,
          actorId: null,
        });
        return {
          executionId: outcome.execution.executionId,
          runtimeClass: outcome.execution.runtimeClass,
          replayed: outcome.replayed,
        };
      },
    },
  });

  // MKT-041: /operating-graph — the Agency Operating Graph (the DERIVED
  // COORDINATION MODEL over the canonical authorities — never a second
  // authority, architecture-lock-v1.5 #4). Composed READ-ONLY over the
  // real public-contract instances constructed above (the frozen matrix
  // line added for this Work Item): canonical Client/Workspace ownership
  // resolution (/clients, /workspaces), the authority listings (/goals,
  // /playbooks, /workflows, /executions, /deployments, /evidence,
  // /experiments, /learnings) and the individual reference resolutions
  // those listings do not carry. The module writes ONLY its own two
  // derived structures (migration 035 — the canonical-record registry +
  // the append-oriented versioned relation ledger); the HTTP surface is
  // read-only (the rebuild is the module-level operation for background
  // workers and later v1.5 Work Items).
  const operatingGraph = createOperatingGraphModule({
    db,
    clock,
    ids,
    clients,
    workspaces,
    goals,
    playbooks,
    workflows,
    executions,
    deployments,
    evidence,
    experiments,
    learnings,
  });

  // MKT-047: /apps — the App registry (App Manifest and Packaging v1 —
  // the immutable versioned App Version manifests, the app-key ownership
  // lineages, dependency validation through the /extensions structural
  // port and the compatibility query). The REAL /extensions module
  // public-contract instance satisfies the READ-ONLY
  // AppsExtensionsPort structurally (getExtensionVersion /
  // listExtensionVersions — the narrow AppExtensionView: extensionId +
  // manifest { extensionKey, publisher, version }); no cross-module
  // import exists inside src/modules/apps.
  const apps = createAppsModule({ db, clock, ids, extensions });

  // MKT-048: /app-installs — the App INSTALLATION authority (the
  // workspace-scoped app lifecycle: install, upgrade and rollback of EXACT
  // published App Versions with SERVER-DERIVED granted scopes, the
  // append-only selection ledger with the single sanctioned supersession
  // transition and the append-only lifecycle event tail). Composition is
  // the frozen-matrix row added by this Work Item: the /apps registry and
  // the /policies engine are consumed through their PUBLIC contracts
  // (READ-ONLY over /apps — the exact-version resolution + the MKT-047
  // compatibility query; fail-closed evaluations over /policies, every
  // decision recorded by the engine); the /workspaces canonical-ownership
  // port is satisfied STRUCTURALLY by the real WorkspacesModuleApi
  // instance; the /extensions availability port is ADAPTER-WIRED (the
  // flat extension-version view of the nested manifest record — the
  // /deployments capability-check precedent). No mutation surface over
  // any composed authority (composition, not authority transfer).
  //
  // MKT-050 (the DISCLOSED additive trust-state wiring): the OPTIONAL
  // trustState structural port is satisfied STRUCTURALLY by the
  // /app-marketplace module instance below — the install/upgrade/
  // rollback gate action's certificationState attribute then carries the
  // marketplace-DERIVED current trust state instead of the frozen
  // registry birth state (trust is metadata and a policy input; the
  // fail-closed /policies evaluation stays the sole install authority —
  // the /policies-credentials port precedent, deliberately off-matrix
  // and disclosed in the runbook + the matrix note).
  //
  // (The marketplace instance is created FIRST — the appInstalls wiring
  // below consumes it structurally; both are pure in-process object
  // constructions, no lifecycle ordering beyond that reference.)
  const appMarketplace = createAppMarketplaceModule({
    db,
    clock,
    ids,
    apps,
  });

  const appInstalls = createAppInstallsModule({
    db,
    clock,
    ids,
    apps,
    policies,
    workspaceOwnership: workspaces,
    extensions: {
      listExtensionInstalls: (workspaceId) => extensions.listExtensionInstalls(workspaceId),
      getExtensionVersion: async (extensionId) => {
        const record = await extensions.getExtensionVersion(extensionId);
        return record === null
          ? null
          : {
              extensionId: record.extensionId,
              extensionKey: record.manifest.extensionKey,
              publisher: record.manifest.publisher,
              version: record.manifest.version,
            };
      },
    },
    trustState: appMarketplace,
  });

  // MKT-052: /app-metering — the App METERING authority (the App Metering
  // and Commercial Attribution surface: the append-only meter event tail
  // over the REAL events — install/upgrade/rollback selections consumed
  // from the MKT-048 ledger, invocations from the MKT-022 invocation
  // ledger, runtime-host usage observations ingested through the
  // module-level command with validated canonical source references —
  // plus the rebuildable rollup projection and the derived attribution
  // read models). Composition is the frozen-matrix row added by this Work
  // Item: the /apps registry (exact App Version resolution for the
  // ingestion guards + the lineage listings for the publisher view), the
  // /app-installs ledger (the COLLECTION SOURCE + the current-selection
  // contexts) and the /extensions invocation ledger (the invocation
  // COLLECTION SOURCE + the ingestion provenance validation) are consumed
  // READ-ONLY through their PUBLIC contracts; the /workspaces
  // canonical-ownership port is satisfied STRUCTURALLY by the real
  // WorkspacesModuleApi instance (the /app-installs precedent). The
  // collection, ingestion and recompute commands are MODULE-LEVEL
  // operations (the operating-graph rebuild precedent — background
  // workers and later v1.5 Work Items); the HTTP surface is the GET-only
  // attribution family. ZERO billing/charging methods anywhere (the
  // Economics rule: marketplace attribution stays separate from the core
  // financial authority).
  const appMetering = createAppMeteringModule({
    db,
    clock,
    ids,
    apps,
    appInstalls,
    extensions,
    workspaceOwnership: workspaces,
  });

  // MKT-055: /social-accounts — the Social Account and OAuth Connection
  // Model authority (the account identity bindings attached to a
  // Client/Workspace through an EXISTING authorized integration — the
  // canonical connection reference consumed READ-ONLY through the
  // /integrations public contract, which also owns the client ownership
  // chain; the OAuth grant lifecycle records with their OWN
  // least-privilege /credentials vault references — kind
  // 'social_account_oauth', never shared with product/source/store
  // credentials, architecture-lock-v1.6 rule 28; the /policies
  // fail-closed gates run before every provider-touching flow step; the
  // /workspaces ownership port narrows the optional attachment).
  // The provider-neutral flow registry is EMPTY here — real platform
  // flows arrive with the MKT-056+ adapter deliveries (fail-closed until
  // then; the disclosed composition seam is AppOptions.socialAccountFlows).
  // MKT-057: the FIRST-PARTY YouTube platform adapter registers as
  // production DATA (the MetaAdsAdapter precedent — constructed on the
  // platform HttpCallPort, fetch-based, zero provider SDKs). The
  // registration is INERT without an authorized YouTube integration
  // connection + OAuth grant (the fail-closed chain precedes every
  // provider call). A seam-supplied adapter of the SAME adapter key
  // (the conformance-suite platform doubles) OVERRIDES the first-party
  // instance — the disclosed test-seam override of AppOptions
  // .socialPlatformAdapters; the remaining MVP platforms arrive with
  // MKT-058..061.
  // MKT-058: the SECOND-PARTY Instagram platform adapter registers as
  // production DATA through the same first-party pattern (the documented
  // Instagram Graph API surface for Professional accounts — the honest
  // 4-of-5 capability matrix; the restriction-signals family is honestly
  // undeclared, so an undeclared operation against the platform refuses
  // fail-closed with zero provider traffic). Same inertness and same
  // seam-override semantics as the YouTube registration.
  const seamSocialAdapters = options.socialPlatformAdapters ?? [];
  const seamSocialAdapterKeys = new Set(
    seamSocialAdapters.map((adapter) => adapter.descriptor.adapterKey),
  );
  const socialAccounts = createSocialAccountsModule({
    db,
    clock,
    ids,
    integrations,
    credentials,
    policies,
    workspaceOwnership: workspaces,
    flows: options.socialAccountFlows ?? [],
    socialAdapters: [
      ...(seamSocialAdapterKeys.has(YOUTUBE_SOCIAL_ADAPTER_KEY)
        ? []
        : [createYouTubeSocialAdapter({ http: httpCalls })]),
      ...(seamSocialAdapterKeys.has(INSTAGRAM_SOCIAL_ADAPTER_KEY)
        ? []
        : [createInstagramSocialAdapter({ http: httpCalls })]),
      ...seamSocialAdapters,
    ],
  });

  // MKT-068: /notification-delivery — the Notification Delivery Plane
  // authority. Composition is the frozen-matrix row added by this Work
  // Item: the /policies public contract is consumed directly for the
  // fail-closed per-channel gates (notification.channel.<key> — every
  // decision recorded in the policy engine's own ledger), the served
  // /notifications boundary is the MKT-001 frozen identity (consumed
  // READ-ONLY inside the module), and the /credentials vault is consumed
  // READ-ONLY by the EMAIL adapter (provider credential by vault REFERENCE
  // id, resolved in the notification's authorized-execution scope — never
  // material in any module table). The RECIPIENT resolution port is
  // satisfied structurally here from the /agencies membership + /users
  // identity authorities (the disclosed off-matrix structural-port
  // precedent — recipients resolve from the notification's own scope
  // chain, never from a request body, never guessed). The email adapter
  // is registered as module DATA through the sanctioned provider-seam
  // subtree; the in-app channel is constructed inside the module.
  const notificationRecipientResolution = {
    resolveRecipientCandidates: async (agencyId: string): Promise<readonly NotificationRecipientCandidate[]> => {
      const memberships = await agencies.listMemberships(agencyId);
      const candidates: NotificationRecipientCandidate[] = [];
      for (const membership of memberships) {
        const user = await users.getUser(membership.userId);
        if (user === null) continue;
        candidates.push({
          email: user.email,
          membershipStatus: membership.status,
          role: membership.role,
          userStatus: user.status,
        });
      }
      return candidates;
    },
  };
  const notificationEmailAdapter =
    options.notificationEmailTransport !== undefined && options.notificationEmailProvider !== undefined
      ? createEmailNotificationAdapter({
          transport: options.notificationEmailTransport,
          recipientResolution: notificationRecipientResolution,
          credentials,
          credentialReferenceId: options.notificationEmailProvider.credentialReferenceId,
          fromAddress: options.notificationEmailProvider.fromAddress,
        })
      : null;
  const notificationDelivery = createNotificationDeliveryModule({
    db,
    clock,
    ids,
    policies,
    adapters: notificationEmailAdapter === null ? [] : [notificationEmailAdapter],
  });

  // MKT-063: /content-rights — the Content Rights and Provenance
  // authority. Composition is the frozen-matrix row's
  // currently-satisfiable subset registered by this Work Item (the
  // MKT-069 disclosed-registration pattern): the /evidence public
  // contract is consumed READ-ONLY for the canonical resolution of
  // every source-provenance/licence/permission/clearance evidence link
  // (uniform 404 on unknown/foreign; the migration-051 same-Client
  // triggers are the backstop), and the /policies public contract is
  // consumed for the fail-closed destination gate of EVERY
  // publication-gate evaluation (the policy key
  // content.rights.publication.<platform> — every decision recorded in
  // the policy engine's own append-only ledger; a non-allow BLOCKS).
  // /content-assets (the frozen v1.6 row's third direction) arrives
  // with MKT-064 — the content-asset relationship is the opaque
  // id-based reference seam the module already speaks, never an
  // import here. The module holds NO publication authority (boundary
  // rule 4): MKT-065 will call evaluatePublicationGate before
  // publishing.
  const contentRights = createContentRightsModule({
    db,
    clock,
    ids,
    evidence,
    policies,
  });

  // MKT-064: /content-assets — the Content Asset and Transformation
  // authority. The frozen-matrix row's module-importable subset is
  // consumed exactly: /executions for the transformation EXECUTION flow
  // (createExecution + transitionExecution through the public contract —
  // NO second engine) and /content-rights for the derivation seam
  // (recordLineageLink when the module derives composites — the 063
  // conjunction grammar, never a rights mutation); the /object-storage
  // direction rides as the platform ObjectStore port (the same `objects`
  // service the composition already wires — fs for tests, memory for
  // unit doubles, S3-class in production); the /evidence-anchored source
  // provenance rides as the id-based reference seam (the migration-053
  // FK + same-Client triggers are the DB backstop; the route layer
  // resolves evidence canonically first — the /app-metering precedent).
  // The engine registry is module DATA: the options seam registers
  // engines for tests and future Work Items; production registers NONE
  // by default (the MKT-056 discipline).
  const contentAssets = createContentAssetsModule({
    db,
    clock,
    ids,
    objects,
    executions,
    contentRights,
    engines: options.contentTransformationEngines ?? [],
  });

  // MKT-067: /experiment-analysis — the Experiment Analysis and Adaptive
  // Allocation authority. The frozen-matrix row is consumed exactly, all
  // four READ-ONLY through their public contracts: /experiments for the
  // experiment identity/design anchor (resolveExperimentOwnership — the
  // sole experiment authority stays sole), /metrics for the observation
  // ledger the window consumes (listMetricObservationsForClient — the
  // bounded house read), /evidence for the canonical same-Client
  // resolution of cited evidence links, /learnings for the confounder/
  // outcome context of learnings citing the analyzed experiment. The
  // canonical /clients + /workspaces ownership resolutions ride the
  // structural ports declared in the module's public contract (the
  // metrics/experiments posture — no forbidden module import exists).
  // The statistics core is fully deterministic (the row lists NO
  // /ai-runtime dependency and none is used).
  const experimentAnalysis = createExperimentAnalysisModule({
    db,
    clock,
    ids,
    experiments,
    metrics: metricsModule,
    evidence,
    learnings,
    clients,
    workspaces,
  });

  // MKT-042: /decisions — the Decision Ledger authority (the
  // append-oriented ledger for material recommendations and commercial
  // decisions, architecture-v1.5 §4 / operating-graph-v1.5 "Decision
  // Ledger"). Platform ports + the reference-validation authorities of
  // the frozen vocabulary consumed READ-ONLY through their public
  // contracts (/evidence citations + the shared §21 material-key
  // backstop, /experiments hypothesis links, /learnings derived-learning
  // references, /executions + /deployments implementation references) +
  // the /clients and /workspaces canonical-ownership authorities
  // injected through /decisions' declared STRUCTURAL PORTS (the real
  // public-contract instances satisfy the port types structurally — the
  // experiments/learnings precedent). The /policies allowance of the
  // MKT-042 registration row stays a deliberately-unused reserved
  // direction (the /agents precedent): recording a decision is
  // unconditional (architecture-v1.5 §7 — consequential ACTIONS, not
  // records, flow through the policy/approval contracts; the MKT-045
  // attention queue consumes that direction later).
  const decisions = createDecisionsModule({
    db,
    clock,
    ids,
    evidence,
    experiments,
    learnings,
    executions,
    deployments,
    clients,
    workspaces,
  });

  // MKT-043: /profit-intelligence — Profit Intelligence (the DERIVED
  // revenue/cost/capacity/scope/margin analytics over the canonical
  // authorities — architecture-v1.5 §5; architecture-lock-v1.5 #6: derived
  // analytics, never a financial system of record). Composed READ-ONLY
  // over the real public-contract instances constructed above (the frozen
  // matrix line added for this Work Item): canonical Client/Workspace
  // ownership resolution, the authority listings (/goals, /playbooks,
  // /workflows, /executions, /deployments, /evidence, /metrics,
  // /integrations), the AI/provider telemetry (/ai-runtime), the jobs
  // enumeration surface (/jobs) and the human capacity pool
  // (/field-agents). The module owns NO durable state (NO migration — the
  // /reporting live-aggregation precedent) and its HTTP surface is
  // read-only by construction.
  const profitIntelligence = createProfitIntelligenceModule({
    clock,
    clients,
    workspaces,
    goals,
    playbooks,
    workflows,
    executions,
    deployments,
    evidence,
    metrics: metricsModule,
    jobs,
    fieldAgents,
    aiRuntime,
    integrations,
  });

  // MKT-051: /first-party-apps — the Incumbent Capability App Program
  // composition home (see the import block above). NO database
  // dependency: the packs are registry data + presentation code over
  // existing authorities, and the bounded app state is in-memory
  // (process-local presentation state with export/delete semantics —
  // no migration, per the MKT-051 required preference). Wired after the
  // decisions module: every consumed public-contract instance (apps,
  // appInstalls, reporting, profitIntelligence, clients, workspaces,
  // decisions, evidence, metrics, integrations) is constructed above
  // (pure in-process object constructions, no lifecycle ordering
  // beyond reference availability).
  const firstPartyApps = createFirstPartyAppsModule({
    clock,
    apps,
    appInstalls,
    reporting,
    profitIntelligence,
    clients,
    workspaces,
    decisions,
    evidence,
    metrics: metricsModule,
    integrations,
  });

  // MKT-045: /ai-operator — the AI Operator attention queue (the DERIVED
  // ranked attention items over the canonical authorities —
  // architecture-v1.5.md §7: ranked action candidates only; consequential
  // actions continue through the existing policy/approval contracts).
  // Composed READ-ONLY over the real public-contract instances constructed
  // above (the frozen matrix line added for this Work Item): canonical
  // Client/Workspace ownership resolution, the delivery-surface listings
  // (/workflows, /executions, /deployments), the jobs enumeration surface
  // (/jobs), the approval ledger (/policies), the evidence/experiment/
  // learning listings, the human capacity pool (/field-agents) and the
  // /profit-intelligence public views (scope-leakage + margin-pressure
  // items CONSUME its figures — never recomputed). The module owns NO
  // durable state (NO migration — the /profit-intelligence precedent) and
  // its HTTP surface is read-only by construction.
  const aiOperator = createAiOperatorModule({
    clock,
    clients,
    workspaces,
    workflows,
    executions,
    deployments,
    jobs,
    policies,
    evidence,
    experiments,
    learnings,
    fieldAgents,
    profitIntelligence,
  });
  // MKT-053: /growth-missions — the Growth Mission and Objective Model
  // authority (see the import block above). Composition is the frozen-matrix
  // row added by this Work Item: the /agencies agency-row authority and the
  // /goals Goal authority are consumed READ-ONLY through the module's
  // declared narrow STRUCTURAL PORTS (the /experiments canonical-ownership
  // port precedent — the real AgenciesModuleApi/GoalsModuleApi instances
  // satisfy the port types structurally at this wiring point; zero
  // cross-module imports exist inside src/modules/growth-missions, proven
  // by tools/arch-check and the boundary tests). The Goal authority stays
  // the sole measurable business-intent authority — the mission layer maps
  // INTO existing goals and never re-states, re-computes or owns goal
  // progress (architecture-lock-v1.6.md rule 16).
  const growthMissions = createGrowthMissionsModule({
    db,
    clock,
    ids,
    agencies,
    goals,
  });

  // MKT-065: /cross-platform-distribution — the Cross-Platform
  // Distribution authority (the frozen v1.6 §5 row, all six directions
  // consumed READ-ONLY except the 056 publish submit):
  // /growth-missions for the optional mission anchor (ownership
  // resolution — the mission authority stays sole, never mutated);
  // /social-accounts for the destination account resolution, the REAL
  // capability matrix (resolveAccountCapabilityMatrix — capability
  // parity never assumed) and THE 056 PUBLISH SUBMIT (submitPublish —
  // the idempotency ledger; the ONLY physical publish path, no parallel
  // engine); /content-assets for the explicit versioned records behind
  // every opaque 'ca:' ref (never floating pointers); /content-rights
  // for THE publication gate (evaluatePublicationGate — composed
  // fail-closed before every attempt, only allow publishes, the verdicts
  // recorded never re-evaluated); /integrations for the adapter registry
  // (listRegisteredAdapters — the 056 normalized adapter contract's
  // platform pipe must be registered); /policies for the dispatch gate
  // (evaluateAction — the network-dimension action
  // 'content.distribution.dispatch'; decisions ride the policy engine's
  // own append-only ledger). The module is fully deterministic (the row
  // lists NO /ai-runtime dependency and none is used).
  const crossPlatformDistribution = createCrossPlatformDistributionModule({
    db,
    clock,
    ids,
    growthMissions,
    socialAccounts,
    contentAssets,
    contentRights,
    integrations,
    policies,
  });

  // MKT-062: /research — the Web Research authority (see the import block
  // above). The REAL ResearchHttpPageReader (GET-only, over the platform
  // HttpCallPort) and the REAL /integrations + /ai-runtime
  // public-contract instances satisfy the module's structural ports at
  // this wiring point — zero cross-module imports exist inside
  // src/modules/research beyond the ONE /evidence §21-guard import in its
  // store (proven by tools/arch-check and the boundary tests). The agency
  // row is NOT resolvable from the module (/agencies is not a frozen
  // allowance of its dependency row — the /app-metering precedent):
  // agency-scope authorization is resolved at the route layer and the
  // migration-056 FK anchor is the backstop.
  const research = createResearchModule({
    db,
    clock,
    ids,
    pageReader: options.researchPageReader ?? new ResearchHttpPageReader(httpCalls),
    integrations,
    aiRuntime,
  });

  // MKT-062: /content-intelligence — the Content Intelligence authority
  // (see the import block above). The REAL /evidence, /metrics,
  // /experiments and /research public-contract instances satisfy the
  // module's declared dependencies structurally at this wiring point —
  // zero cross-module imports exist inside
  // src/modules/content-intelligence beyond its public-contract imports
  // + the ONE /evidence §21-guard import in its store (proven by
  // tools/arch-check and the boundary tests). The /integrations direction
  // arrives through the declared narrow READ-ONLY STRUCTURAL PORT
  // (getConnection + executeRead ONLY — the read-only guarantee is a
  // compile-time property of the wiring). The client row is NOT
  // resolvable from the module (/clients is not an allowance of its
  // dependency row): client-scope authorization is resolved at the route
  // layer (requireClientAccess) and the migration-057 FK anchor is the
  // backstop.
  const contentIntelligence = createContentIntelligenceModule({
    db,
    clock,
    ids,
    evidence,
    metrics: metricsModule,
    experiments,
    integrations,
    research,
  });

  // MKT-069: /product-intelligence — the Product Intelligence authority
  // (see the import block above). The REAL HttpPageReader (GET-only, over
  // the platform HttpCallPort) and the REAL /integrations + /ai-runtime
  // public-contract instances satisfy the module's structural ports at
  // this wiring point — zero cross-module imports exist inside
  // src/modules/product-intelligence beyond the ONE /evidence §21-guard
  // import in its store (proven by tools/arch-check and the boundary
  // tests). The agency row is NOT resolvable from the module
  // (/agencies is not a frozen allowance of its dependency row — the
  // /app-metering precedent): agency-scope authorization is resolved at
  // the route layer and the migration-048 FK anchor is the backstop.
  const productIntelligence = createProductIntelligenceModule({
    db,
    clock,
    ids,
    pageReader: options.productPageReader ?? new HttpPageReader(httpCalls),
    integrations,
    aiRuntime,
  });

  // MKT-054: /growth-operator — the Growth Operator authority (see the
  // import block above). The persistent per-mission goal-pursuit
  // CONTROLLER over the MKT-053 mission model: every consumed public
  // contract arrives through the module's declared narrow STRUCTURAL
  // PORTS (the /growth-missions precedent — zero cross-module imports
  // exist inside src/modules/growth-operator, proven by tools/arch-check
  // and the boundary tests; the real module instances satisfy the port
  // types structurally at this wiring point). The /workspaces structural
  // port is the DISCLOSED off-matrix wiring (the /notification-delivery
  // MKT-068 precedent — the canonical pursuit-scope resolution, READ-ONLY);
  // the /executions port deliberately exposes NO transition method so the
  // operator structurally cannot own execution lifecycle (the runtime
  // plane drives executions); the delegation gate defaults to the
  // /policies-composed implementation (integration tests supply the
  // disclosed rights-gate double through AppOptions.growthOperatorGate).
  // The controller advances mission state ONLY through the mission
  // authority's own public command; all physical work flows through the
  // EXISTING /workflows + /executions authorities (never a second
  // execution engine — architecture-lock-v1.6.md rule 17).
  const growthOperatorPursuitScope = {
    // The off-matrix structural port (the MKT-068 recipient-resolution
    // precedent): a READ-ONLY wrapper over the canonical /workspaces
    // ownership resolution — the pursuit-scope chain (workspace → client →
    // agency) the controller validates against the mission's agency.
    resolveWorkspace: async (workspaceId: string) => {
      const ownership = await workspaces.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) return null;
      return {
        workspaceId: ownership.scope.workspaceId,
        clientId: ownership.scope.clientId,
        agencyId: ownership.scope.agencyId,
        status: ownership.workspace.status,
      };
    },
  };
  const growthOperator = createGrowthOperatorModule({
    db,
    clock,
    ids,
    missions: growthMissions,
    goals,
    workspaces: growthOperatorPursuitScope,
    workflows,
    executions,
    experiments,
    evidence,
    decisions,
    learnings,
    policies,
    delegationGate: options.growthOperatorGate,
  });

  // MKT-046: /sales-continuity — Sales-to-Delivery Continuity (the §8
  // orchestrator). The proposal surface is the Decision Ledger READ-ONLY
  // (resolveDecisionOwnership + getDecision); the playbook and
  // deployment paths compose through their EXISTING public
  // creation/status commands (the frozen matrix line added for this Work
  // Item: /sales-continuity ──→ /decisions, /playbooks, /deployments,
  // /clients, /workspaces); /clients and /workspaces are consumed
  // through the module's declared STRUCTURAL PORTS (the /decisions
  // precedent — the real public-contract instances satisfy the port
  // types structurally). The module owns exactly the append-only
  // continuity ledger (migration 040 — the disclosed AC-6 persistence
  // choice: the existing creation commands expose no provenance-carrying
  // surface); it never writes any other module's tables.
  const salesContinuity = createSalesContinuityModule({
    db,
    clock,
    ids,
    decisions,
    playbooks,
    deployments,
    clients,
    workspaces,
  });

  // MKT-044: /client-memory — Client Operating Memory (the DERIVED
  // governed projection over the canonical authorities — architecture
  // v1.5 §6; the no-second-tenant/data-authority lock posture). Composed
  // READ-ONLY over the real public-contract instances constructed above
  // (the frozen matrix line added for this Work Item): canonical
  // Client/Workspace ownership resolution, the authority listings
  // (/goals, /playbooks, /deployments, /evidence, /experiments,
  // /decisions, /learnings). The module owns NO durable state (NO
  // migration — the /reporting + /profit-intelligence live-derivation
  // precedent), adds NO retrieval index or cache (§6: retrieval/index
  // technology is non-authoritative) and its HTTP surface is read-only
  // by construction.
  const clientMemory = createClientMemoryModule({
    clock,
    clients,
    workspaces,
    goals,
    playbooks,
    deployments,
    evidence,
    experiments,
    decisions,
    learnings,
  });
  // Authentication order: user sessions first, then the internal service
  // token. Every path fails closed (CompositeAuthenticator).
  const authenticator = new CompositeAuthenticator([
    auth.requestAuthenticator,
    new InternalTokenAuthenticator(config.internalApiToken),
  ]);

  return {
    services: {
      config,
      clock,
      ids,
      db,
      queue,
      objects,
      cache,
      locks,
      secrets,
      httpCalls,
      auth: authenticator,
      observability: {
        sink,
        loggerFactory,
        metrics,
      },
    },
    modules: { users, auth, agencies, clients, workspaces, credentials, audit, goals, playbooks, workflows, executions, evidence, metrics: metricsModule, experiments, learnings, aiRuntime, fieldAgents, jobs, agents, policies, integrations, extensions, domainPacks, creatorOperations, reporting, deployments, operatingGraph, decisions, apps, appInstalls, profitIntelligence, salesContinuity, aiOperator, clientMemory, appMarketplace, appMetering, firstPartyApps, growthMissions, socialAccounts, notificationDelivery, productIntelligence, growthOperator, contentRights, contentAssets, experimentAnalysis, crossPlatformDistribution, research, contentIntelligence },
    runtime: { aiProvider },
  };
}

export async function buildAppServices(config: AppConfig, options: AppOptions = {}): Promise<AppServices> {
  return buildCore(config, options).services;
}

/**
 * Idempotent platform-administrator bootstrap. Runs only when explicitly
 * configured (both-or-neither enforced by config validation). If the email
 * is already registered, nothing changes — bootstrap never resets passwords.
 */
async function ensureBootstrapAdministrator(
  config: AppConfig,
  modules: ApplicationModules,
  logger: Logger,
): Promise<void> {
  if (config.bootstrapAdminEmail === '') return;

  const existing = await modules.users.getUserByEmail(config.bootstrapAdminEmail);
  if (existing !== null) {
    logger.info('identity.bootstrap.skipped', undefined, {
      email: config.bootstrapAdminEmail,
      reason: 'user already exists',
    });
    return;
  }

  const user = await modules.users.createUser({
    email: config.bootstrapAdminEmail,
    displayName: 'Platform Administrator',
  });
  await modules.users.grantPlatformRole({ userId: user.userId, role: 'platform_administrator' });
  await modules.auth.issueCredential({
    userId: user.userId,
    password: config.bootstrapAdminPassword,
  });
  logger.info('identity.bootstrap.created', undefined, { email: user.email });
}

/** Loads config from the environment and builds wired services. */
export async function bootstrapApp(options: AppOptions = {}): Promise<AppServices> {
  const config = loadConfig(process.env);
  const services = await buildAppServices(config, options);
  await runMigrations(services.db);
  return services;
}

/**
 * Full application bootstrap shared by EVERY entrypoint (control plane and
 * workers — DEPLOY-AC-01's single auditable configuration surface):
 * explicit config → wired services + modules → migrations → optional
 * bootstrap administrator.
 *
 * Startup ordering (MKT-033, DEPLOY-001):
 *   1. loadConfig — the explicit, validated configuration (fail-fast
 *      ConfigError; missing/ambiguous config never falls back silently);
 *   2. buildCore — every capability (db, queue, object storage, sandbox
 *      driver, AI provider adapter, secrets, advisory Redis) constructed
 *      from that config;
 *   3. the REDACTED effective-configuration report logged once
 *      ('config.effective') — the auditable record of what actually
 *      started, with no secret material;
 *   4. runMigrations — startup verifies the migration state (applies
 *      missing migrations, fails on checksum drift of applied ones), then
 *      logs 'platform.migrations.verified' with the applied count;
 *   5. ensureBootstrapAdministrator (optional, idempotent).
 */
export async function bootstrapApplication(
  options: AppOptions = {},
): Promise<{ services: AppServices; modules: ApplicationModules; runtime: RuntimeWiring }> {
  const config = loadConfig(process.env);
  const core = buildCore(config, options);
  const startupLogger = core.services.observability.loggerFactory.forModule('platform.startup');
  startupLogger.info('config.effective', undefined, { config: describeConfig(config) });
  const applied = await runMigrations(core.services.db);
  startupLogger.info('platform.migrations.verified', undefined, {
    applied_count: applied.length,
    latest: applied.length === 0 ? null : applied[applied.length - 1]!.name,
  });
  const logger = core.services.observability.loggerFactory.forModule('identity.bootstrap');
  await ensureBootstrapAdministrator(config, core.modules, logger);
  return core;
}

export { loadConfig };
