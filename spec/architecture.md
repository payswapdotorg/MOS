# MarketingOS Architecture

**Version:** 1.4
**Status:** FROZEN

MarketingOS is a provider-independent, evidence-driven, multi-tenant Marketing Operating System for agencies. It organizes customer-acquisition and audience-operations work around Goals and executes that work through deterministic software, AI capabilities, Human Agents, and third-party extensions.

## 1. Core product model

MarketingOS is the deployment and operating layer for governed marketing operations: connect systems, define a Goal, deploy a versioned Playbook into a Client Workspace, execute a Workflow Graph, observe outcomes, measure evidence, learn, and iterate.

The platform maintains two complementary graphs: Workflow Graph for governed work movement and Evidence/Knowledge Graph for claims, entities, experiments, sources, observations, outcomes, and learnings.

Core lifecycle:

```text
Goal → Context + Evidence → Hypothesis / Strategy → Playbook Version
→ Marketing Deployment → Workflow Version / Graph → Task(s) → Execution(s)
→ Measurement / Outcome → Evidence → Learning → next Goal / Strategy iteration
```

## 2. Architectural principles

### 2.1 System of record
PostgreSQL is authoritative for application state, workflow state, policy state, relationships, experiments, evidence metadata, deployment records, and audit state. Large artifacts may live in object storage but are referenced durably from PostgreSQL.

### 2.2 Evidence over claims
Agent/model/human statements are claims unless backed by authoritative evidence. Important recommendations must preserve evidence references, provenance, timestamps, and applicability scope.

### 2.3 Deterministic workflow authority
Workflow state transitions live in one workflow authority. AI, Human Agents, extensions, workers, and frontend code may propose or report results but cannot own workflow state transitions.

### 2.4 Provider independence
Business logic does not depend on a model, hosting provider, SaaS integration, or specific scraping vendor. Providers are adapters/extensions.

### 2.5 Smallest useful graph
A workflow uses the smallest decomposition that materially improves quality, parallelism, recoverability, or governance. More agents do not imply better results.

### 2.6 Scientific separation
Observation, prediction, attribution, association, and causal inference are distinct. The UI and APIs must preserve those distinctions.

### 2.7 Modular monolith first
Initial implementation is a TypeScript modular monolith with background workers. Runtime sandboxes and heavy workers may be separately deployed, but domain boundaries remain explicit.

### 2.8 Deployment abstraction
MarketingOS exposes a Vercel-like deployment experience without making a Vercel-class platform the mandatory runtime substrate. The product control plane is authoritative for deployment lifecycle; the runtime fabric is replaceable infrastructure.

## 3. System context

```text
Agency / Client / Human Agent / Developer
                 │
                 ▼
        MarketingOS Control Plane
                 │
       ┌─────────┼──────────┐
       ▼         ▼          ▼
  Deployments Workflow   AI Runtime
       │         │          │
       └─────────┼──────────┘
                 ▼
           Runtime Fabric
      workers / jobs / sandboxes
                 │
                 ▼
        External providers
                 │
                 ▼
        Evidence + Outcomes
                 │
                 ▼
              Learning
```

## 4. Tenant hierarchy

```text
Platform
└── Agency
    ├── Users / Human Agents
    ├── Agency Policies
    ├── Agency Playbooks / reusable artifacts
    ├── Agency Extensions
    └── Clients
        ├── Client Users / Collaborators
        ├── Client Policy
        ├── Client Data
        ├── Goals
        ├── Experiments
        └── Workspaces
            ├── Deployments
            ├── Playbooks
            ├── Workflows
            ├── Memory / Context
            ├── Artifacts
            └── Executions
```

Agency is the commercial tenant. Client is the hard security/data boundary. Workspace is inside Client and cannot weaken Client isolation.

## 5. Roles

At minimum: Platform Administrator, Agency Owner, Agency Admin, Agency Operator/Strategist, Client Collaborator, Human Agent, Field Agent specialization, Chatter/Creator Manager/Content Manager/Growth Manager/Account Manager/Reviewer/Sales Agent specializations, and Platform Developer/Extension Publisher.

Role assignment is orthogonal to tenant ownership. Human Agents are platform identities that can participate in work for multiple agencies according to Job authorization.

## 6. Core domain modules

```text
/auth
/users
/agencies
/clients
/workspaces
/goals
/playbooks
/deployments
/workflows
/executions
/agents
/field-agents
/jobs
/evidence
/experiments
/learnings
/metrics
/integrations
/extensions
/domain-packs
/ai-runtime
/policies
/credentials
/audit
/notifications
/reporting
/operating-graph
/decisions
/app-installs
/profit-intelligence
/sales-continuity
/client-memory
/ai-operator
/app-marketplace
/app-metering
/first-party-apps
/growth-missions
/social-accounts
/product-intelligence
/notification-delivery
/growth-operator
/content-rights
/content-assets
```

`/deployments` is the sole Deployment lifecycle authority. `/reporting` is read-side only. `/operating-graph` is the v1.5 derived coordination model: read-only composition over the canonical authorities, source references only (spec/architecture-v1.5.md §3). `/decisions` is the v1.5 append-oriented Decision Ledger authority (spec/architecture-v1.5.md §4; spec/change-request-005.md change #2 — registered here per the v1.4 promotion precedent). `/app-installs` is the v1.5 App installation authority: workspace-scoped install/upgrade/rollback of EXACT published App Versions with server-derived grants over the `/apps` registry (spec/mos-app-ecosystem-v1.5.md "Install and invoke", "Bounded app state", "Upgrade and rollback" — registered here per the v1.4 promotion precedent). `/profit-intelligence` is the v1.5 derived Profit Intelligence read model: live derivation of revenue/cost/capacity/utilization/scope-leakage/margin analytics over the canonical authorities with source references, calculation version and assumptions; read-only composition, no owned state (spec/architecture-v1.5.md §5 — registered here per the v1.4 promotion precedent). `/sales-continuity` is the v1.5 Sales-to-Delivery Continuity orchestrator: carries structured proposal scope, goals, outcomes, assumptions and economics into the Playbook/Deployment path through the existing creation commands with provenance and version identity retained on its own append-only continuity ledger, orchestrating and never duplicating the composed authorities (spec/architecture-v1.5.md §8 — registered here per the v1.4 promotion precedent). `/client-memory` is the v1.5 Client Operating Memory derived read model: the governed client-context projection and retrieval surface over the canonical client, goal, playbook, deployment, evidence, experiment, outcome, decision and learning records with source references, the frozen projection vocabulary and selection rules; read-only composition, no owned state, retrieval/index technology non-authoritative (spec/architecture-v1.5.md §6 — registered here per the v1.4 promotion precedent). `/ai-operator` is the v1.5 AI Operator attention-queue read model: live-derived ranked attention items (blocked work, approvals, client risk, anomalies, scope leakage, margin pressure, capacity constraints, opportunities) over the canonical authorities' public contracts with a frozen rank calculation version; it recommends action candidates only — consequential actions continue through the existing policy/approval contracts; read-only composition, no owned state (spec/architecture-v1.5.md §7 — registered here per the v1.4 promotion precedent). `/app-marketplace` is the v1.5 App marketplace, trust and certification surface: the discovery/review read model plus the operator trust-transition ledger over the `/apps` registry (append-only trust events, never registry rewrites; trust is metadata and a policy input — never authority by itself; marketplace attribution stays separate from the core financial authority; spec/mos-app-ecosystem-v1.5.md "Trust levels" + "Economics" — registered here per the v1.4 promotion precedent). `/app-metering` is the v1.5 App metering and commercial attribution authority: the append-only meter event tail over the real installation/invocation/usage events consumed through the `/apps`, `/app-installs` and `/extensions` public contracts, the runtime-host usage-observation ingestion, the rebuildable rollup projection and the derived attribution read models (per app / per publisher / per workspace / per period with source references, calculation version and disclosed assumptions); marketplace attribution stays separate from the core financial authority — the module exposes zero billing/charging methods (spec/mos-app-ecosystem-v1.5.md "Economics" — registered here per the v1.4 promotion precedent). `/first-party-apps` is the v1.5 Incumbent Capability App Program composition home: the first-party capability packs (reporting/analytics, CRM/pipeline, spreadsheet workflows, client portals) whose App Version manifests publish through the `/apps` registry and whose pack code is PRESENTATION-ONLY composition over the incumbent authorities' public contracts (mos-app-ecosystem-v1.5.md "What Apps can do" / "Non-goals" — apps reproduce incumbent capability surfaces over the SAME core authorities and never become alternate workflow engines, CRM authorities, reporting truth, tenant stores, retry engines, evidence stores or policy engines); read-only composition plus declared action surfaces that invoke existing authority commands, bounded in-memory app state with export/delete semantics and lineage, no owned durable state (registered here per the v1.4 promotion precedent). `/social-accounts` is the v1.6 Social Account and OAuth Connection Model authority (spec/architecture-v1.6.md §4; spec/effective-backlog-v1.6.md MKT-055): external account identities attached to a Client/Workspace through an EXISTING authorized integration (the canonical integration reference read-only, the platform identity the adapter key carried as data — no platform-specific knowledge in the module), with the append-oriented OAuth authorization-grant lifecycle (pending → authorized → expired/revoked/refreshed/superseded — refresh and reauthorize are new records/history events, never in-place rewrites), the EXACT granted scope list recorded verbatim plus platform-normalized capability tags (a faithful record, never an assumption of parity — architecture-lock-v1.6 rule 19), secrets exclusively through the `/credentials` vault by canonical reference as the grant's own least-privilege reference (rule 28 — it confers no product/source/store access), one connection binding one platform identity with idempotent reconnect and fail-closed conflicting-binding rejection, and fail-closed disconnect/revocation (operator-initiated and externally-signalled) that leaves the connection unusable with no zombie grants (registered here per the v1.4 promotion precedent). `/product-intelligence` is the v1.6 Product Intelligence authority (spec/architecture-v1.6.md §8; spec/effective-backlog-v1.6.md MKT-069): the mission-optional Product Context records carrying the declared inputs (public product/site URL(s), product-document references, source-code repository URL(s), connected source-workspace references, catalog/inventory references, current-analytics references — each with its public vs explicitly-authorized state) as IMMUTABLE versioned declarations; the deterministic fetch/extract inspection pipeline over public product/site pages plus authorized repository/workspace/catalog/analytics reads through the `/integrations` public contract READ-ONLY, with every material source fact retained with full provenance (source reference, fetched-at, extractor identity, content hash, extraction notes — extracted observations, never conclusions); the derived model records of the §8 derivation set, each carrying its evidence references, its ai-runtime assistance disclosure and a server-computed verification state (a derived record without backing evidence is unverified and can never be presented as established — model output is a claim unless backed by evidence); explicit append-only risk flags (compliance/privacy/toxicity/commercial/operational with severity); read-only source-code/product inspection unless a separately granted write capability (boundary rule 7 — the write seam is documented, not built); the model records are attachable by reference from missions later with NO mission-strategy logic in the module (registered here per the v1.4 promotion precedent).
`/notification-delivery` is the v1.6 Notification Delivery Plane authority (spec/effective-backlog-v1.6.md MKT-068; spec/architecture-v1.6.md §14; spec/module-dependency-matrix-v1.6.md boundary rule 9): the durable notification records carrying the full §14 field set (event type, urgency, human-readable explanation, source/mission reference, required action, deep link, delivery status), the event-occurrence dedup fence, the append-only per-channel delivery-attempt receipts and the in-app read-state projection, delivered through a platform-neutral DeliveryAdapter contract (in-app + email MVP; WhatsApp/Telegram/SMS/Signal declared-pluggable-but-unimplemented) with per-channel fail-closed policy gates — it delivers messages only and never becomes canonical task/action state (registered here per the v1.4 promotion precedent).
`/growth-operator` is the v1.6 Growth Operator authority (spec/effective-backlog-v1.6.md MKT-054; spec/architecture-v1.6.md §13; spec/architecture-lock-v1.6.md rule 17): the persistent per-mission goal-pursuit CONTROLLER — a frozen controller state machine (running / paused / blocked_pending_human_action for genuine rights/policy/capability gates only / terminal achieved / exhausted / terminated_by_policy, with resume semantics and the full append-only transition audit trail), deterministic idempotent replanning over a bounded versioned strategy space (the same mission state + evidence snapshot → the same plan; replans are append-only decision records, never silent rewrites), budget/quota-aware bounded delegation that DELEGATES ALL PHYSICAL WORK to the existing /workflows and /executions authorities (the delegated experiment through /experiments, the strategic decision in the /decisions ledger, the observation through /evidence) and remains fully functional at ZERO human-amplification budget/capacity (the optional human arm is considered-and-recorded, never a dependency; blocked_pending_human_action is the only truthful human blocker) — it is never a second workflow or execution engine (registered here per the v1.4 promotion precedent).
`/content-rights` is the v1.6 Content Rights and Provenance authority (spec/effective-backlog-v1.6.md MKT-063; spec/architecture-v1.6.md §9; spec/frozen-manifest-v1.6.json hardPublicationRules; spec/module-dependency-matrix-v1.6.md boundary rule 4): the asset-level rights records binding an explicit rights state (owned / license / platform_permitted / cleared / review / blocked plus the explicit `unknown` initial state) to an opaque content-asset reference (the id-based /content-assets integration seam — MKT-064), with source provenance, licence evidence and expiry/revocation semantics, state transitions as append-only recorded events (the human clearance record with actor identity + rationale being the ONLY review → cleared path — fair-use reasoning rides as review evidence, never an auto-clear), the immutable ingredient lineage links resolving composites as the conjunction of their ingredients (any unclear ingredient blocks the composite; a composite without lineage is blocked outright), the destination-platform permission scope (what the source's licence permits on which destinations), and the fail-closed publication gate (allow / review_required / blocked with reasons; an absent evaluation is blocked, never allowed; unknown/review never auto-approve — review_required is the one honest surface rights become a blocked_pending_human_action source; the destination policy gate rides /policies on every evaluation) — it can block publication but can never silently approve unclear rights and holds no publication authority (registered here per the v1.4 promotion precedent).
`/content-assets` is the v1.6 Content Asset and Transformation Authority (spec/effective-backlog-v1.6.md MKT-064; spec/architecture-v1.6.md §10 "Transformation system"; spec/architecture-lock-v1.6.md rules 23/24; spec/module-dependency-matrix-v1.6.md boundary rule 5): the immutable VERSIONED artifact records (explicit versions, no floating pointers — a correction is a NEW version, which is a NEW reference; the opaque content-asset refs minted 'ca:' + canonical version id, the id-based seam /content-rights already speaks — the mutual registration is COMPLETE), media/kind metadata, content-addressed object-storage references (the MKT-001 ObjectStore platform port), /evidence-anchored source provenance (required for source versions; a derived version's provenance IS the recorded transformation), the CHECK-fenced lifecycle (draft → materialized; derived is the BIRTH state of transformation outputs — outputs are born WITH their objects and their lineage), the append-only quality OBSERVATIONS (measurable facts from the closed metric vocabulary — never fabricated scores), and the recorded TRANSFORMATIONS of the frozen family (crop/reframe/padding/compilation/clip/caption/voice/translation/format) whose execution flows through the EXISTING /executions authority (no second engine) with the engine as a replaceable capability behind the TransformationEngine port (first-party or Extension/App engines registered as module data, EMPTY in production by default), every derived asset retaining ingredient + transformation lineage (the module records the /content-rights lineage links through the 063 public contract when it derives) — it stores/derives artifact lineage and can never become a rights authority (registered here per the v1.4 promotion precedent).
## 7. Goal

Goal is the top-level unit of business intent. It contains objective, target scope, success metrics, resource constraints, time horizon, risk constraints, evidence standard where applicable, owner, and lifecycle status.

Goal is not a workflow. A Goal may produce one or more Strategies/Plans and Deployments.

## 8. Playbooks

A Playbook is a versioned, reusable set of strategy/workflow templates. A published Playbook Version is immutable. Deployment references the exact Playbook Version and does not mutate it.

## 9. Marketing Deployment

A Marketing Deployment binds an immutable Playbook Version to an authorized Client Workspace under a policy snapshot and declares Workflow versions, dependencies, runtime requirements and triggers.

Deployment is the control-plane equivalent of application deployment: Configure → Validate → Deploy → Observe → Pause/Resume → Redeploy/Rollback.

Deployment owns deployment intent, dependency resolution, activation state and deployment history. It may request workflow execution but never owns workflow state, task state, execution state, evidence state or retry orchestration.

Activation must validate authorization, version compatibility, Domain Pack compatibility, Integration/Extension capability availability, credential references, policies, runtime requirements and triggers before becoming ACTIVE.

Redeploy or rollback selects immutable approved versions for future executions. Existing Executions, Outcomes, Evidence and Learnings retain their original version references and are never rewritten.

## 10. Workflow Graph

Workflow is a typed directed graph. Supported node classes include deterministic function, AI task, extension capability, API action, browser/sandbox task, human task, approval, experiment, conditional branch, join/merge, loop, and terminal/outcome recorder.

The workflow engine owns execution state, retries, idempotency, compensation where defined, and legal transitions. Graph cycles require an explicit bounded loop contract.

## 11. Task and Execution

A Task is a governed unit of work produced by a Workflow Node. An Execution is one concrete operation identity for a Task according to the frozen execution semantics. A logical Task must not be duplicated by retries.

Execution contains execution identity, deployment/workflow/node/version references, client/workspace, participant/capability, policy snapshot, runtime class, input/output references, lifecycle state, evidence references, telemetry and audit correlation.

Execution is the unit that acquires runtime resources.

## 12. Agent

Agent is a logical reusable capability. It does not own tenant data, workflow state, deployment state or infrastructure.

## 13. Human Agents and Jobs

Human Agent is the generic human execution participant. Field Agent and other operational roles are capability specializations. Jobs are governed projections of Tasks using candidate-specific Offers and the existing concurrency-safe acceptance contract.

Human Agents may be agency staff or platform-pool participants. Every Job/Execution is scoped to exactly one commissioning Agency and Client.

## 14. Runtime and sandbox

The default runtime uses pooled workers. Sandboxes are allocated only where execution requires process/filesystem/browser persistence or isolation.

```text
Workflow → Task → Execution → Runtime Class → Worker or Sandbox Lease
```

Persistent sandboxes are Workspace-scoped environments. Executions lease them; `execution_id` is never Sandbox identity.

## 15. Evidence graph

Evidence records source facts and their provenance and relates them to claims, hypotheses, experiments, outcomes and learnings. Evidence is append-oriented and server-owned.

## 16. Measurement and experiments

Metrics are observations. Experiments are explicit causal/decision structures with declared hypothesis, unit/population, treatment/control or comparison, primary/guardrail outcomes, analysis method, start/stop conditions, design, uncertainty and decision.

Attribution, prediction and causal effect estimates are separate types. Causal conclusions require an appropriate causal design.

## 17. Learning

Learning is a durable conclusion linked to supporting evidence/outcomes and applicability. Learning never erases contradictory history and does not bypass current validation when required.

## 18. AI Runtime

The AI Runtime is provider-neutral and receives a TaskProfile rather than a raw provider request. The router performs hard eligibility before performance/cost/latency selection, supports cheap-first cascades and escalation, and records routing/evaluation telemetry.

OpenRouter may be used as a provider gateway but is never the MarketingOS routing authority.

## 19. Extensions and Domain Packs

Extensions are versioned permissioned capabilities. Domain Packs are versioned composition layers that specialize MarketingOS without creating alternate authorities. Creator Operations is a Domain Pack. Provider-specific creator APIs/SDKs/browser automation/scraping remain behind Integration/Extension boundaries.

## 20. Integrations

External providers are normalized behind adapters/extensions. No provider is the system of record for MarketingOS workflow, deployment, evidence, policy or execution state.

## 21. Data architecture

```text
                PostgreSQL
        ┌──────────┼────────────┐
        │          │            │
     Domain     Workflow    Deployments
        │          │            │
        └──────────┼────────────┘
                   │
                  Redis
          queues / locks / cache
                   │
             Object Storage
                   │
             Analytics/Warehouse
```

Analytics is read/analytics infrastructure and cannot become an alternate authority.

## 22. Security architecture

Authentication, tenant/client authorization, policy authorization, credential scope, runtime isolation, network controls, evidence/audit and provider-specific controls are layered. Authorization must be evaluated before dependent traversal or external access.

## 23. API and eventing

Mutations are server-authoritative and long-running operations are asynchronous. External events are validated, durably persisted, queued and handled idempotently through deterministic authorities.

## 24. Observability

Deployments, Executions and material workflow operations have correlation IDs. AI usage records model/provider, request class, tokens/compute where available, cost, latency, evaluator outcome and escalation count when authoritative.

## 25. UI

The frontend consumes authoritative backend state. Primary surfaces include Agency Command Center, Client Decision Room, Goal/Strategy/Playbook workspace, Deployment Center, Workflow/Execution timeline, Evidence Explorer, Experiment Lab, Human Agent work queue, Extension Developer Portal and AI Runtime console.

The frontend owns presentation only, not workflow, deployment or authorization authority.

## 26. Infrastructure model

```text
Vercel-class web experience / edge
              │
              ▼
      MarketingOS Control Plane
              │
      ┌───────┼──────────┬──────────┐
      ▼       ▼          ▼          ▼
   workers  queues     AI Runtime  sandbox service
      │                              │
      └──────────────┬───────────────┘
                     ▼
                data / storage
```

AWS is the preferred class of substrate for runtime/data/control infrastructure. Vercel-class infrastructure is preferred for web experience and rapid frontend delivery, not as the entire runtime substrate. Exact AWS service choices remain implementation detail.
