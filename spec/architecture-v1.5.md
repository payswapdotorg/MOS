# MOS Architecture

Version: 1.5
Status: FROZEN
Supersedes: 1.4

MOS is a provider-independent, evidence-driven, multi-tenant Marketing Operating System for agencies. It connects commercial intent, governed marketing work, deterministic execution, AI, human participants, extensions/apps, evidence, outcomes, economics and learning.

## 1. Core operating model

```text
Prospect → Client → Goal → Strategy/Hypothesis → Playbook Version
→ Deployment → Workflow → Task → Human / AI / App / Extension
→ Execution → Evidence → Outcome → Revenue / Cost / Margin
→ Decision → Learning → next action / deployment
```

MOS maintains the authoritative Workflow Graph and Evidence/Knowledge Graph. The v1.5 Operating Graph is a derived coordination projection over these authorities plus commercial/economic records.

## 2. Singular authorities

PostgreSQL-backed MOS modules remain authoritative for Client/Workspace, Goal, Playbook, Deployment, Workflow, Task, Execution, Evidence, Experiment, Learning, Policy, Credential and Job state. AI models, providers, Human Agents, Domain Packs, Extensions and Apps cannot become alternate authorities.

## 3. Operating Graph

The Operating Graph connects canonical IDs across commercial intent, delivery, execution, evidence, outcomes and economics. It stores source references and versions rather than shadowing canonical state. Derived edges may be recomputed. Traversal must enforce Client/Workspace isolation before dependent data access.

## 4. Decision Ledger

Material AI/human/app recommendations and commercial decisions may be recorded with objective, evidence, context, hypothesis, expected impact/cost, uncertainty, disposition, execution/deployment reference, outcome and learning reference. Records are append-oriented; corrections never rewrite history.

## 5. Profit Intelligence

Revenue, delivery cost, human capacity cost, AI/provider cost, utilization, scope leakage and margin are derived analytics with source references, calculation version and assumptions. Profit Intelligence can recommend but cannot mutate financial/accounting authority.

## 6. Client Operating Memory

Client memory is a governed projection over canonical client, goal, playbook, deployment, evidence, experiment, outcome, decision and learning records. Retrieval/index technology is non-authoritative.

## 7. AI Operator

Command Center may rank attention items: blocked work, approvals, client risk, anomalies, scope leakage, margin pressure, capacity constraints and opportunities. Consequential actions continue through the existing policy/approval contracts.

## 8. Sales-to-delivery continuity

Proposal data may carry structured scope, goals, outcomes, assumptions and economics into the Playbook/Deployment path without manual re-entry. Provenance and version identity are retained.

## 9. Extensions and Apps

Extensions are versioned permissioned capabilities. An App is a distributable package composed of one or more Extensions plus capability contracts, optional UI surfaces, connectors/adapters, event subscriptions, bounded app-owned state, configuration and certification metadata.

Apps may be first-party or community published. An App may reproduce all or part of external products such as reporting/analytics, CRM, spreadsheet workflows, dashboards, attribution, automation or client portals. This is a composition strategy, not a transfer of authority.

Apps may own bounded app-domain state and artifacts when outside MOS core authority. They must declare their authority scope, lineage, export/delete behavior and dependencies. Apps cannot directly mutate MOS core tables.

Every App Version declares its key, publisher, immutable semantic version, compatibility, capabilities, input/output schemas, data/mutation scopes, network/runtime permissions, events, UI surfaces, configuration, required credential names, app-owned namespaces, dependencies and trust level.

Install is workspace-scoped and policy-gated. Granted scopes are server-derived and revocable. Published versions are immutable. Upgrade/rollback changes future version selection only; historical invocations retain their original App Version.

Trust levels: UNVERIFIED, COMMUNITY_VERIFIED, MOS_CERTIFIED. Trust is policy metadata and never grants authority.

## 10. Deployment

Deployment remains the sole deployment lifecycle authority. In v1.5 it may validate a deployment's required App/Extension capabilities and exact versions in addition to existing runtime, credential, policy, trigger and compatibility checks. Deployment still cannot own Workflow/Execution state or become a second retry engine.

## 11. Workflow and Execution

Workflow owns graph state and legal transitions. Task is the governed unit of work. Execution is the concrete operation identity and runtime lease holder. UNKNOWN remains unresolved and non-idempotent effects are never blindly replayed.

## 12. Evidence, experiments and learning

Evidence is append-oriented and server-owned. Experiments preserve causal distinction and declared uncertainty. Learning retains supporting evidence and contradictory history. No App or graph projection can rewrite these records.

## 13. Provider independence

Business logic never depends on a model, SaaS provider, spreadsheet engine, CRM vendor, reporting vendor or cloud product. Providers are adapters/apps/extensions behind stable capability contracts.

## 14. Security

Authorization is evaluated before dependent traversal or external access. Credentials are reference-only to consumers. App input cannot supply tenant identity, authority, provenance or secret material. Cross-client access is fail-closed. Invocations are auditable and correlation-linked.

## 15. UI

Primary surfaces include Agency Command Center, Client Decision Room, Goal/Strategy/Playbook workspace, Deployment Center, Workflow/Execution timeline, Evidence Explorer, Experiment Lab, Human Agent queue, Extension/App Developer Portal and App Marketplace. All UI remains presentation over authoritative APIs.

## 16. Infrastructure

MOS remains a modular monolith first with background workers, durable PostgreSQL state, Redis for transient coordination and object storage for large artifacts. Runtime fabric remains replaceable.

## 17. Architectural non-goals

v1.5 does not mandate a particular CRM, spreadsheet engine, analytics provider, reporting vendor, AI provider, cloud vendor or app runtime. Those are replaceable implementations behind MOS contracts.
