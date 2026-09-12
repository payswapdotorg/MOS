# Effective Implementation Backlog — MOS v1.5

Status: FROZEN

MKT-001..MKT-040 remain the v1.4 implementation baseline. The following v1.5 items extend the product without reopening accepted work.

## Operating Graph and intelligence

### MKT-041 — Agency Operating Graph
Objective: authoritative projections/relations across Prospect, Client, Goal, Strategy, Playbook, Deployment, Workflow, Task, Execution, Evidence, Outcome and economics using canonical IDs.
Dependencies: MKT-013, MKT-015, MKT-016, MKT-023, MKT-024.

### MKT-042 — Decision Ledger
Objective: append-oriented decision records linking objective, evidence, hypothesis, expected impact/cost, disposition, execution, outcome and learning.
Dependencies: MKT-013, MKT-015, MKT-016, MKT-021.

### MKT-043 — Profit Intelligence
Objective: derived revenue/cost/capacity/scope/margin analytics with source references, assumptions and calculation version.
Dependencies: MKT-014, MKT-016, MKT-023, MKT-034.

### MKT-044 — Client Operating Memory
Objective: governed client context projection and retrieval over canonical records; no second tenant/data authority.
Dependencies: MKT-013, MKT-016, MKT-023.

### MKT-045 — AI Operator / Attention Queue
Objective: rank blocked work, approvals, risks, anomalies, scope leakage, margin pressure, capacity and opportunities as governed action candidates.
Dependencies: MKT-016, MKT-018, MKT-021, MKT-041, MKT-042, MKT-043.

### MKT-046 — Sales-to-Delivery Continuity
Objective: carry structured proposal scope, goals, outcomes and economics into Playbook/Deployment without manual re-entry and with provenance.
Dependencies: MKT-007, MKT-013, MKT-023, MKT-041, MKT-043.

## App Ecosystem

### MKT-047 — App Manifest and Packaging v1
Objective: expand EXT-001 into immutable App Version manifests covering capabilities, schemas, permissions, UI surfaces, events, dependencies, app-owned state and certification metadata.
Dependencies: MKT-022, MKT-036.

### MKT-048 — App Installation, Upgrade and Rollback
Objective: workspace-scoped app lifecycle with server-derived grants, exact-version historical identity and future-selection upgrade/rollback semantics.
Dependencies: MKT-022, MKT-023, MKT-047.

### MKT-049 — App SDK and Developer Portal
Objective: community developer workflow for scaffolding, local validation, capability contracts, UI surfaces, manifests, tests, signing/publishing and documentation.
Dependencies: MKT-032, MKT-047, MKT-048.

### MKT-050 — App Marketplace, Trust and Certification
Objective: discoverable first-party/community Apps with UNVERIFIED, COMMUNITY_VERIFIED and MOS_CERTIFIED trust levels, review metadata and policy eligibility.
Dependencies: MKT-047, MKT-049.

### MKT-051 — Incumbent Capability App Program
Objective: prove the App model with first-party capability packs covering reporting/analytics, CRM/pipeline, spreadsheet workflows and client portals; integrations remain behind the App/Integration contracts.
Dependencies: MKT-047, MKT-048, MKT-049, MKT-050.

### MKT-052 — App Metering and Commercial Attribution
Objective: meter installations, invocations, runtime/data usage and premium capability usage without moving financial authority into Apps.
Dependencies: MKT-047, MKT-048, MKT-050.

## v1.5 deployment amendment

MKT-040 is amended so Deployment validation can declare and validate required App/Extension capabilities, versions, permissions and compatibility before activation. Deployment still does not execute workflows or own app state.

## Final v1.5 completion target

MOS is complete when MKT-001..MKT-052 are accepted/merged or explicitly classified N/A by approved architecture decision, and the final proof demonstrates:

Goal → Evidence → Hypothesis → Playbook → Deployment → Workflow → Task → Execution → Outcome → Decision → Learning → next action/deployment.

The final proof must include first-party and community-style App capability invocation, tenant isolation, versioned upgrade/rollback, real provider integration boundaries, profit/decision lineage, AI and human participation, and no alternate authorities.
