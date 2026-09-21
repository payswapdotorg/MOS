/**
 * Application-level module wiring contract (MKT-002, MKT-003, MKT-004,
 * MKT-005, MKT-006, MKT-007, MKT-008, MKT-009, MKT-010, MKT-013, MKT-014).
 *
 * src/api route builders receive the domain modules through this interface —
 * the concrete instances are created ONLY in the composition root (which is
 * not importable from src/api by the static architecture checker). Types come
 * from the frozen module public entries.
 *
 * MKT-005 additions: /credentials (credential references, CRED-001) and
 * /audit (append-only audit trail, AUD-001).
 *
 * MKT-006 additions: /goals (Goal lifecycle, GOAL-001).
 *
 * MKT-007 additions: /playbooks (Playbook versions, PLAY-001).
 *
 * MKT-008 additions: /workflows (Workflow definition graph model, WF-001).
 *
 * MKT-009 additions: /workflows (Workflow instance state machine,
 * implementation-contract §5).
 *
 * MKT-010 additions: /executions (normalized Execution model, EXEC-001).
 *
 * MKT-013 additions: /evidence (Evidence/provenance, EVID-001) — the
 * append-only, server-owned evidence ledger with provenance, quality and
 * the supersession graph.
 *
 * MKT-014 additions: /metrics (Metric normalization, METRIC-001) — the
 * append-only metric observation ledger with source/timestamp/reference
 * mapping, server-derived provenance and NO provider state.
 *
 * MKT-015 additions: /experiments (Experiment model, EXP-001) — the
 * experiment design authority: the full frozen §16 Experiment contract
 * (hypothesis, decision target, population/unit, treatment/comparison,
 * primary metric by name+dimensions, guardrails, assignment method,
 * analysis method/version, design type, expected direction, start/stop
 * criteria, minimum evidence requirement, declared uncertainty
 * representation), the frozen lifecycle state machine with append-only
 * transition history, the closed conclusion-type taxonomy with the
 * causal evidence standard, and uncertainty/analysis-metadata retention.
 *
 * MKT-016 additions: /learnings (Learning model, LEARN-001) — the
 * Learning authority: scoped, append-only Learning records (statement +
 * applicability conditions + supporting evidence/outcome references +
 * descriptive confidence) and the contradiction/supersession/retirement
 * relationship history from which the Learning state is DERIVED
 * (never a stored, mutable column — history is never erased).
 *
 * MKT-017 additions: /ai-runtime (AI task profile and model registry,
 * AI-001 — provider-neutral TaskProfiles, normalized model registry,
 * usage telemetry records).

 * MKT-025 additions: /field-agents (generic Human Agent profile authority,
 * FIELD-001 + HUMAN-001 — the generalized /field-agents authority of
 * spec/module-dependency-v1.3.md; no second human-execution module).

 * MKT-026 additions: /jobs (Human Job lifecycle authority, JOB-001 —
 * governed Task projections, candidate-specific Offers, the
 * concurrency-safe acceptance claim and provenance-preserving outcome
 * submission; Workflow authority preserved: the jobs module consumes
 * /workflows READ-ONLY).
 *
 * MKT-020 additions: /agents (logical Agent/Capability contracts,
 * AGENT-001 — provider-neutral reusable capability declarations with
 * platform/agency scope, register/list/read/retire and the append-only
 * lifecycle history).
 *
 * MKT-021 additions: /policies (execution policy engine, POL-001 —
 * append-oriented policy versions with platform/agency/client scope,
 * the fail-closed decision engine and the append-only decision ledger
 * with server-derived provenance; CRED-001 reference-only evaluation
 * posture).
 *
 * MKT-022 additions: /extensions (extension registry and manifest
 * contract, EXT-001 — the immutable versioned manifest registry, the
 * install/configure lifecycle with least-privilege granted scopes and
 * credential-reference secret bindings, the fail-closed invocation
 * policy gate and the short-lived invocation context with the
 * append-only invocation ledger).
 *
 * MKT-027 additions: /jobs field execution (JOB-001 field subset +
 * EVID-001 field subset, JOB-AC-03..04, EVID-AC-01..03 field subset —
 * the visit lifecycle, structured outcomes, evidence capture, follow-up
 * and the policy-gated continuity lookup ride the SAME /jobs module
 * contract: the JobsModuleApi interface is extended in place; NO new
 * module, NO new dependency).
 *
 * MKT-023 additions: /integrations (Provider integration boundary,
 * INT-001 — the generic integration ports + the first-party adapter
 * mechanism: connection/capability metadata, the adapter registry as
 * injected data, the fail-closed policy-gated provider execution
 * surface and the append-only webhook/event ingestion ledger; no
 * provider is a system of record for workflow/deployment/evidence/
 * policy/execution state).
 *
 * MKT-030 additions: /reporting (read-side reporting, UI-001 — the Client
 * Decision Room read model: a PURE LIVE AGGREGATION over the /goals,
 * /workflows, /evidence, /experiments and /learnings public contracts;
 * read-only by construction, no owned state, no projection tables).
 */


import type { AgenciesModuleApi } from '../modules/agencies/public.ts';
// MKT-020: /agents module contract (logical Agent/Capability contracts).
import type { AgentsModuleApi } from '../modules/agents/public.ts';
import type { AiRuntimeModuleApi } from '../modules/ai-runtime/public.ts';
import type { AuditModuleApi } from '../modules/audit/public.ts';
import type { AuthModuleApi } from '../modules/auth/public.ts';
import type { ClientsModuleApi } from '../modules/clients/public.ts';
import type { CredentialsModuleApi } from '../modules/credentials/public.ts';
// MKT-023: /integrations module contract (provider integration boundary).
import type { IntegrationsModuleApi } from '../modules/integrations/public.ts';
// MKT-013: /evidence module contract.
import type { EvidenceModuleApi } from '../modules/evidence/public.ts';
import type { ExecutionsModuleApi } from '../modules/executions/public.ts';
import type { FieldAgentsModuleApi } from '../modules/field-agents/public.ts';
// MKT-026: /jobs module contract.
import type { JobsModuleApi } from '../modules/jobs/public.ts';
import type { GoalsModuleApi } from '../modules/goals/public.ts';
// MKT-014: /metrics module contract.
import type { MetricsModuleApi } from '../modules/metrics/public.ts';
// MKT-015: /experiments module contract (experiment design records).
import type { ExperimentsModuleApi } from '../modules/experiments/public.ts';
// MKT-016: /learnings module contract (Learning records + relationships).
import type { LearningsModuleApi } from '../modules/learnings/public.ts';
import type { PlaybooksModuleApi } from '../modules/playbooks/public.ts';
// MKT-021: /policies module contract (execution policy engine).
import type { PoliciesModuleApi } from '../modules/policies/public.ts';
// MKT-022: /extensions module contract (extension registry and manifest
// contract).
import type { ExtensionsModuleApi } from '../modules/extensions/public.ts';
// MKT-036: /domain-packs module contract (versioned Domain Pack
// framework — PACK-001).
import type { DomainPacksModuleApi } from '../modules/domain-packs/public.ts';
// MKT-037: the Creator Operations Domain Pack contract (CREATOR-001) —
// the first business pack composed through the framework, exposed through
// the same module public entry (pack service over the platform authorities
// via the structural ports wired at the composition root).
import type { CreatorOperationsPackApi } from '../modules/domain-packs/public.ts';
// MKT-030: /reporting module contract (read-side reporting — the Client
// Decision Room live aggregation over the composed authorities).
import type { ReportingModuleApi } from '../modules/reporting/public.ts';
// MKT-040: /deployments module contract (Marketing Cloud Deployment
// control plane — DEPLOY-002; the structural-port wiring happens at the
// composition root).
import type { DeploymentsModuleApi } from '../modules/deployments/public.ts';
// MKT-041: /operating-graph module contract (Agency Operating Graph — the
// derived coordination model over the canonical authorities; source
// references only, append-oriented versioned relations, read-only HTTP
// surface, the rebuild is module-level).
import type { OperatingGraphModuleApi } from '../modules/operating-graph/public.ts';
// MKT-047: /apps module contract (App registry — the App Manifest and
// Packaging v1 authority: versioned immutable App Version manifests over
// the /extensions registry through a structural port).
import type { AppsModuleApi } from '../modules/apps/public.ts';
import type { AppInstallsModuleApi } from '../modules/app-installs/public.ts';
// MKT-042: Decision Ledger authority (the append-oriented decision
// records authority).
import type { DecisionsModuleApi } from '../modules/decisions/public.ts';
// MKT-043: /profit-intelligence module contract (Profit Intelligence — the
// derived revenue/cost/capacity/scope/margin analytics read model over the
// canonical authorities' public contracts; live derivation, no owned
// state, read-only surface).
import type { ProfitIntelligenceModuleApi } from '../modules/profit-intelligence/public.ts';
// MKT-050: /app-marketplace module contract (App Marketplace, Trust and
// Certification — the discovery/trust/review surface over the /apps
// registry: the derived listing read model, the append-only trust
// transition ledger and the append-only review records).
import type { AppMarketplaceModuleApi } from '../modules/app-marketplace/public.ts';
// MKT-045: /ai-operator module contract (AI Operator / Attention Queue —
// the derived ranked attention-queue read model over the canonical
// authorities' public contracts: blocked work, approvals, client risk,
// anomalies, scope leakage, margin pressure, capacity constraints and
// opportunities as governed action candidates; live derivation, no owned
// state, read-only surface; consequential actions continue through the
// existing policy/approval contracts).
import type { AiOperatorModuleApi } from '../modules/ai-operator/public.ts';
// MKT-046: /sales-continuity module contract (Sales-to-Delivery
// Continuity — the orchestrator that carries structured proposal scope,
// goals, outcomes, assumptions and economics into the Playbook/Deployment
// path through the EXISTING creation commands, with the provenance +
// version identity retained on its own append-only continuity ledger).
import type { SalesContinuityModuleApi } from '../modules/sales-continuity/public.ts';
// MKT-044: /client-memory module contract (Client Operating Memory — the
// governed client-context projection and retrieval surface over the
// canonical client, goal, playbook, deployment, evidence, experiment,
// outcome, decision and learning records; live derivation, no owned
// state, read-only surface — never a second tenant/data authority).
import type { ClientMemoryModuleApi } from '../modules/client-memory/public.ts';
// MKT-052: /app-metering module contract (App Metering and Commercial
// Attribution — the append-only meter event tail over the REAL
// install/invocation/usage events consumed through the /apps,
// /app-installs and /extensions public contracts, the usage-observation
// ingestion command, the rebuildable rollup projection and the derived
// attribution read models; ZERO billing/charging methods — marketplace
// attribution stays separate from the core financial authority).
import type { AppMeteringModuleApi } from '../modules/app-metering/public.ts';
// MKT-051: /first-party-apps module contract (Incumbent Capability App
// Program — the four first-party capability packs: the typed App
// manifests that publish through the REAL /apps registry command plus
// the presentation-only surface composers over the incumbent
// authorities' public contracts, the declared action menus over EXISTING
// authority command routes, and the bounded in-memory app state with
// export/delete semantics and lineage; NO mutation verbs over ANY
// authority — composition, never a transfer of authority).
import type { FirstPartyAppsModuleApi } from '../modules/first-party-apps/public.ts';
// MKT-053: /growth-missions module contract (Growth Mission and Objective
// Model — the agency-scoped durable mission records: the declared objective
// VERBATIM with the frozen architecture-v1.6.md §3 objective-family
// vocabulary, the product/market context, the frozen §2 lifecycle state
// machine including every terminal state, the append-only version tail
// (immutable objective — corrections are NEW version records), the
// append-only history tail (state transitions with actor + provenance +
// reason; terminal transitions citing the declared-family decision basis)
// and the mission→goal mapping through the /goals public contract
// READ-ONLY; a durable orchestration LAYER over the existing Goals — never
// a replacement authority, and NO controller/scheduler/replanner: the
// Growth Operator is MKT-054 and composes these commands server-side).
import type { GrowthMissionsModuleApi } from '../modules/growth-missions/public.ts';
// MKT-054: /growth-operator module contract (Growth Operator — the
// persistent goal-pursuit controller over the MKT-053 mission model:
// restart-safe, idempotent replanning, blocked/paused/resume semantics,
// bounded next-experiment/action selection through the existing
// Workflow/Execution authorities, zero-human robustness; never a second
// execution engine).
import type { GrowthOperatorModuleApi } from '../modules/growth-operator/public.ts';
// MKT-055: /social-accounts module contract (the Social Account and OAuth
// Connection Model — the account identity bindings over EXISTING
// authorized integrations, the append-oriented OAuth authorization-grant
// lifecycle with verbatim scope records + platform-normalized capability
// tags, the append-only history tail and the fail-closed disconnect/
// revocation death semantics; tokens live in the /credentials vault by
// canonical reference — NEVER in the module's tables).
import type { SocialAccountsModuleApi } from '../modules/social-accounts/public.ts';
// MKT-069: /product-intelligence module contract (Product Intelligence —
// the durable product/market INSPECTION and MODEL records of
// architecture-v1.6.md §8: the agency-scoped Product Context records with
// their declared inputs and authorization states, the deterministic
// fetch/extract inspection pipeline (GET-only page reads + READ-ONLY
// authorized reads through the /integrations public contract), the
// retained source facts with FULL provenance, the derived model records
// with evidence links + AI-assistance disclosure + the server-computed
// verification state, and the append-only risk flags; NO mission-strategy
// logic — MKT-070 attaches the model records BY REFERENCE through the
// read surface; NO mutation toward any external source — boundary rule 7).
import type { ProductIntelligenceModuleApi } from '../modules/product-intelligence/public.ts';
// MKT-068: /notification-delivery module contract (the Notification
// Delivery Plane — the durable notification records carrying the full
// architecture-v1.6.md §14 field set, the dedup fence on event
// occurrences, the append-only delivery-attempt receipt tail, the
// in-app read-state projection and the platform-neutral
// DeliveryAdapter contract with the in-app + email MVP channels; the
// per-channel /policies gates fail closed into honest refused receipts,
// and the email provider credential resolves through the /credentials
// vault by reference — delivery facts only, NEVER task/action state:
// boundary rule 9).
import type { NotificationDeliveryModuleApi } from '../modules/notification-delivery/public.ts';
// MKT-063: /content-rights module contract (the Content Rights and
// Provenance authority — the asset-level rights records over the OPAQUE
// content-asset reference seam (the MKT-064 id-based integration), the
// frozen rights state model owned/license/platform_permitted/cleared/
// review/blocked + the explicit `unknown` initial state with transitions
// as append-only recorded events, the human clearance records as the
// ONLY review → cleared path, the immutable ingredient lineage links
// resolving composites as the CONJUNCTION of their ingredients, the
// destination-platform permission scope and THE fail-closed publication
// gate (allow / review_required / blocked with reasons; absent
// evaluation is blocked; unknown/review never auto-approve; the
// destination policy gate rides /policies) — boundary rule 4: it can
// block publication but can never silently approve unclear rights, and
// it holds NO publication authority).
import type { ContentRightsModuleApi } from '../modules/content-rights/public.ts';
// MKT-064: /content-assets module contract (the Content Asset and
// Transformation Authority — the immutable VERSIONED artifact records
// over the opaque 'ca:'-minted content-asset refs (the completed
// /content-rights seam), explicit versions with no floating pointers,
// content-addressed object-storage references, /evidence-anchored
// source provenance, the draft → materialized lifecycle with derived as
// the BIRTH state of transformation outputs, the append-only quality
// OBSERVATIONS (closed metric vocabulary — never fabricated scores),
// and the recorded TRANSFORMATIONS of the frozen family whose execution
// flows through the EXISTING /executions authority with the engine as a
// replaceable capability behind the TransformationEngine port (EMPTY in
// production by default) — boundary rule 5: it stores/derives artifact
// lineage and can never become a rights authority).
import type { ContentAssetsModuleApi } from '../modules/content-assets/public.ts';
import type { UsersModuleApi } from '../modules/users/public.ts';
import type { WorkflowsModuleApi } from '../modules/workflows/public.ts';
import type { WorkspacesModuleApi } from '../modules/workspaces/public.ts';

export interface ApplicationModules {
  readonly users: UsersModuleApi;
  readonly auth: AuthModuleApi;
  readonly agencies: AgenciesModuleApi;
  readonly clients: ClientsModuleApi;
  readonly workspaces: WorkspacesModuleApi;
  readonly credentials: CredentialsModuleApi;
  readonly audit: AuditModuleApi;
  readonly goals: GoalsModuleApi;
  readonly playbooks: PlaybooksModuleApi;
  readonly workflows: WorkflowsModuleApi;
  readonly executions: ExecutionsModuleApi;
  // MKT-013: evidence/provenance authority (EVID-001).
  readonly evidence: EvidenceModuleApi;
  // MKT-014: metric normalization authority (METRIC-001).
  readonly metrics: MetricsModuleApi;
  // MKT-015: experiment model authority (EXP-001).
  readonly experiments: ExperimentsModuleApi;
  // MKT-016: Learning model authority (LEARN-001).
  readonly learnings: LearningsModuleApi;
  // MKT-017: AI runtime registry authority (AI-001).
  readonly aiRuntime: AiRuntimeModuleApi;

  // MKT-025: the generic Human Agent profile authority (platform identity,
  // specializations as capability metadata, eligibility data).
  readonly fieldAgents: FieldAgentsModuleApi;

  // MKT-026: the Human Job lifecycle authority (Task projections,
  // candidate-specific offers, concurrency-safe acceptance, outcome
  // submission with server-derived provenance).
  // MKT-027: the SAME /jobs authority now also exposes the field-execution
  // surface (visits, structured outcomes, evidence capture, follow-up,
  // continuity) through this same contract — one authority, one type.
  readonly jobs: JobsModuleApi;

  // MKT-020: logical Agent/Capability contracts authority (AGENT-001).
  readonly agents: AgentsModuleApi;

  // MKT-021: execution policy engine authority (POL-001 — the declared
  // policy boundaries, the fail-closed decision engine and the
  // append-only decision records).
  readonly policies: PoliciesModuleApi;

  // MKT-023: the provider integration boundary authority (INT-001 — the
  // generic integration ports, the first-party adapter registry as
  // injected data, connection/capability metadata and the append-only
  // webhook/event ingestion ledger).
  readonly integrations: IntegrationsModuleApi;
  // MKT-022: extension registry and manifest contract authority
  // (EXT-001 — the immutable versioned manifest registry, the
  // install/configure lifecycle, the short-lived invocation context
  // and the append-only invocation ledger).
  readonly extensions: ExtensionsModuleApi;

  // MKT-036: Domain Pack registry/composition authority (PACK-001 — the
  // immutable versioned pack registry, the installed-version records
  // against the authorized Workspace/Client context, and the artifact
  // scope records with the §5 explicit Client/Agency-reusable
  // distinction).
  readonly domainPacks: DomainPacksModuleApi;

  // MKT-037: the Creator Operations Domain Pack (CREATOR-001 — the
  // pack-owned Client-scoped subject surface, the observation mapping
  // into the common evidence/metric ledgers, the approval-gated outbound
  // side effects, the AI TaskProfile declarations and the frozen pack
  // manifest publication through the framework above).
  readonly creatorOperations: CreatorOperationsPackApi;

  // MKT-030 + MKT-029: read-side reporting authority (UI-001 — the Client
  // Decision Room live aggregation + the agency-scoped Agency Command
  // Center family of the SAME authority). READ-ONLY by construction.
  readonly reporting: ReportingModuleApi;

  // MKT-040: the Marketing Cloud Deployment control-plane authority
  // (DEPLOY-002 — deployment intent/lifecycle: the immutable
  // Playbook/Workflow version binding to authorized Client Workspaces,
  // the activation gate, pause/resume/redeploy/rollback and the
  // append-only deployment history; request-execution through the
  // /executions public contract only — never a second workflow/execution
  // engine).
  readonly deployments: DeploymentsModuleApi;

  // MKT-041: the Agency Operating Graph authority (the derived
  // coordination model over the canonical authorities — canonical source
  // references, CHECK-fenced kinds/relations/epistemic vocabulary,
  // append-oriented versioned relations, the converging rebuild and the
  // agency-scoped READ-ONLY route surface; never a second authority for
  // any composed module).
  readonly operatingGraph: OperatingGraphModuleApi;

  // MKT-047: the App registry authority (App Manifest and Packaging v1 —
  // the immutable versioned App Version manifests: capabilities,
  // schemas, scopes, UI surfaces, events, dependencies, app-owned state
  // namespaces and certification metadata; the compatibility query).
  // Composes OVER the /extensions authority via its structural port —
  // no mutation surface over extensions (composition, not authority
  // transfer).
  readonly apps: AppsModuleApi;
  // MKT-048: the App INSTALLATION authority (workspace-scoped app
  // lifecycle: install/upgrade/rollback of EXACT published App Versions
  // with server-derived granted scopes, the append-only selection ledger
  // and the single sanctioned supersession transition; composes OVER the
  // /apps registry, /policies install gate and the /workspaces +
  // /extensions ownership/availability ports — no mutation surface over
  // any of them).
  readonly appInstalls: AppInstallsModuleApi;
  // MKT-042: the Decision Ledger authority (the append-oriented ledger
  // for material recommendations and commercial decisions — proposal
  // vocabulary, the frozen disposition state machine, the one-shot
  // observed outcome with its execution/deployment/learning references,
  // and the append-only event tail; never rewriting any other
  // authority).
  readonly decisions: DecisionsModuleApi;

  // MKT-043: the Profit Intelligence derived-analytics authority (the
  // live revenue/cost/capacity/utilization/scope-leakage/margin read
  // model over the canonical authorities — every material figure carries
  // source references, the frozen calculation version and the explicit
  // assumption set; ZERO mutation methods: derived analytics, never a
  // financial system of record — architecture-lock-v1.5 #6).
  readonly profitIntelligence: ProfitIntelligenceModuleApi;

  // MKT-050: the App Marketplace, Trust and Certification authority (the
  // discovery/review read model over the /apps registry + the append-only
  // trust transition ledger and review records; the policy-eligibility
  // read-side query whose trust vocabulary the MKT-048 install gate
  // consumes through the disclosed structural-port wiring; trust is
  // metadata and a policy input — never authority by itself).
  readonly appMarketplace: AppMarketplaceModuleApi;
  // MKT-045: the AI Operator attention-queue derived read model (the
  // live-derived ranked attention items over the canonical authorities —
  // every item carries its category, deterministic priority score, source
  // references, structured rationale and the EXISTING consequential-action
  // contract reference it would flow through; ZERO mutation methods: the
  // module ranks action candidates only, never executes or creates them —
  // architecture-v1.5.md §7).
  readonly aiOperator: AiOperatorModuleApi;
  // MKT-046: the Sales-to-Delivery Continuity orchestrator (carries the
  // structured proposal scope/goals/outcomes/assumptions/economics of an
  // accepted Decision Ledger proposal into the Playbook/Deployment path
  // THROUGH the existing /playbooks and /deployments creation commands —
  // orchestrates, never duplicates their authority; the provenance +
  // version identity live on its own append-only continuity ledger).
  readonly salesContinuity: SalesContinuityModuleApi;

  // MKT-044: the Client Operating Memory derived projection authority
  // (the governed client-context projection and retrieval surface over
  // the canonical client, goal, playbook, deployment, evidence,
  // experiment, outcome, decision and learning records — every memory
  // item cites canonical record ids under the frozen, versioned
  // projection vocabulary (cm-proj-v1); ZERO mutation methods and ZERO
  // owned state: retrieval/index technology is non-authoritative,
  // PostgreSQL remains authoritative — never a second tenant/data
  // authority).
  readonly clientMemory: ClientMemoryModuleApi;

  // MKT-052: the App Metering and Commercial Attribution authority (the
  // append-only meter event tail over the real install/invocation/usage
  // events — collection through the /app-installs + /extensions public
  // contracts, usage-observation ingestion with validated canonical
  // source references, the rebuildable rollup projection and the derived
  // attribution read models under the frozen am-meter-v1/am-attrib-v1
  // vocabularies; the module-level collection/ingestion/recompute
  // commands are server-side operations, the HTTP surface is the
  // GET-only attribution family; ZERO billing/charging methods —
  // marketplace attribution stays separate from the core financial
  // authority, mos-app-ecosystem-v1.5.md "Economics").
  readonly appMetering: AppMeteringModuleApi;
  // MKT-051: /first-party-apps — the four first-party capability packs'
  // invoke/read surface over the CURRENT install selection (the pack
  // catalog, the composed surfaces, the bounded app state with
  // export/delete semantics). Read-only composition over the incumbent
  // authorities; the app-state mutations touch app-owned bounded state
  // only — never an authority table.
  readonly firstPartyApps: FirstPartyAppsModuleApi;

  // MKT-053: the Growth Mission and Objective Model authority (the
  // agency-scoped durable mission records: the declared objective VERBATIM
  // with the frozen §3 objective-family vocabulary, the product/market
  // context, the frozen §2 lifecycle state machine including every terminal
  // state — achieved; stopped by user; blocked pending human action; blocked
  // by unavailable capability; budget/quota exhausted; policy-constrained;
  // failed after bounded recovery — the append-only version tail (immutable
  // objective — corrections are NEW version records, never in-place
  // rewrites), the append-only history tail (state transitions with actor +
  // provenance + reason; the record never silently converts a block into
  // success) and the mission→goal mapping through the /goals public
  // contract READ-ONLY (the Goal authority stays the sole measurable
  // business-intent authority — goal progress is never re-stated or
  // re-computed; architecture-lock-v1.6.md rules 16/17/41). NO controller,
  // scheduler or replanner exists on this contract — the Growth Operator
  // (MKT-054) is a later Work Item.
  readonly growthMissions: GrowthMissionsModuleApi;
  // MKT-055: the Social Account and OAuth Connection Model authority (the
  // account identity bindings attached to a Client/Workspace through an
  // EXISTING authorized integration — canonical reference READ-ONLY; the
  // OAuth connect-flow grant lifecycle pending → authorized →
  // expired/revoked/refreshed/superseded as append-only records with the
  // EXACT granted scope list recorded verbatim plus the
  // platform-normalized capability tags; the provider-neutral OAuth flow
  // port — empty until the MKT-056+ adapter deliveries wire real flows;
  // the fail-closed disconnect/revocation death semantics with the vault
  // references disabled — no zombie grants).
  readonly socialAccounts: SocialAccountsModuleApi;
  // MKT-069: the Product Intelligence authority (the durable product/market
  // inspection and model records — the agency-scoped Product Context with
  // its IMMUTABLE versioned declared inputs, the deterministic inspection
  // runs over public product/site pages and explicitly authorized
  // repository/workspace/catalog/analytics reads through the /integrations
  // public contract READ-ONLY, the retained source facts with FULL
  // provenance, the derived model records whose verification state is
  // SERVER-COMPUTED from their own evidence set, and the append-only risk
  // flags; the model records are attachable BY REFERENCE from missions
  // later — NO mission-strategy logic lives here, and NO mutation toward
  // any external source exists — the read-only capability seam is
  // documented, not built).
  readonly productIntelligence: ProductIntelligenceModuleApi;
  // MKT-068: the Notification Delivery Plane authority (the durable
  // notification records with the §14 field set, the event-occurrence
  // dedup fence, the append-only per-channel delivery-attempt receipts,
  // the in-app read-state projection and the pluggable DeliveryAdapter
  // contract — in-app + email MVP; delivery facts only, never
  // task/action state: boundary rule 9).
  readonly notificationDelivery: NotificationDeliveryModuleApi;
  // MKT-054: the Growth Operator authority (the persistent per-mission
  // goal-pursuit CONTROLLER — the frozen controller state machine with
  // resume semantics and the append-only transition audit trail, the
  // deterministic idempotent replanning over a bounded versioned strategy
  // space, the budget/quota-aware bounded delegation that DELEGATES ALL
  // PHYSICAL WORK to the existing /workflows + /executions authorities,
  // and the zero-human robustness: fully functional at zero
  // human-amplification budget/capacity, the optional human arm
  // considered-and-recorded, never a dependency; never a second workflow
  // or execution engine — no task pickup, no execution lifecycle, no
  // sandbox leasing, no dispatch/queue submit live on this contract).
  readonly growthOperator: GrowthOperatorModuleApi;
  // MKT-063: the Content Rights and Provenance authority (the asset-level
  // rights records over the opaque content-asset reference seam, the
  // frozen rights state model with transitions as append-only recorded
  // events and the human clearance records as the ONLY review → cleared
  // path, the immutable ingredient lineage links resolving composites as
  // the conjunction of their ingredients, the destination-platform
  // permission scope and the fail-closed publication gate — allow /
  // review_required / blocked with reasons; NO publication authority:
  // boundary rule 4).
  readonly contentRights: ContentRightsModuleApi;
  // MKT-064: /content-assets — the Content Asset and Transformation
  // Authority (the versioned asset records, the quality observations,
  // the transformation family vocabulary, the execution delegation
  // through /executions and the derivation seam into /content-rights
  // lineage — NO rights authority of its own: boundary rule 5).
  readonly contentAssets: ContentAssetsModuleApi;
}
