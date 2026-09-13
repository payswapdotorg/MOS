# Architecture Change Request 005 — MOS v1.5

Status: APPROVED
New architecture version: 1.5
Product name: MOS — Marketing Operating System

## Purpose
Upgrade MOS so it can become the primary operating workspace for agencies while keeping all existing core authorities singular.

## Approved changes

1. Add an Agency Operating Graph connecting commercial intent, delivery, execution, evidence, outcomes, economics and learning using canonical IDs from existing authorities.
2. Add an append-oriented Decision Ledger for material recommendations and commercial decisions; it never rewrites historical evidence, executions or learnings.
3. Add derived Profit Intelligence for revenue, delivery cost, capacity, AI/provider cost, scope utilization and margin with explicit source references and assumptions.
4. Expand the existing Extension Registry into an App Ecosystem. An App is a distributable package of versioned extensions, capability contracts, UI surfaces, adapters, event subscriptions and bounded app-owned state.
5. Permit first-party and community Apps to reproduce all or part of incumbent capabilities such as reporting, analytics, CRM, spreadsheet workflows, dashboards, attribution, automation, imports and exports.
6. Permit bounded app-domain state and artifacts only when outside MOS core authority; each app declares its authority scope and relationship to canonical MOS records.
7. Add app lifecycle, permissions, certification/trust metadata, upgrade semantics, metering and marketplace/discovery contracts.
8. Extend Deployment so an immutable deployment version can declare and validate its required App/Extension capability set.

## Unchanged authorities
Client/Workspace isolation, Goals, Playbooks, Deployments, Workflows, Tasks, Executions, Evidence, Experiments, Learnings, AI routing, Policies, Credentials and Jobs remain authoritative in their existing modules.

Apps, Domain Packs, Human Agents and external providers remain participants/composition layers and cannot become alternate authorities.

## Implementation
MKT-001..MKT-040 remain valid. v1.5 adds MKT-041..MKT-052 and updates MKT-040 only where needed to validate deployed App/Extension capability requirements.

Existing accepted Work Items are not reopened merely because v1.5 adds new composition capability. Corrective gaps use bounded corrective Work Items.

Approval basis: explicit Product Owner instruction requesting this MOS architecture upgrade.
