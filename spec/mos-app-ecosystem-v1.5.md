# MOS App Ecosystem — v1.5

MOS remains the system of record for core marketing-operations state. Apps are the extensibility and product-composition layer.

## App definition

An App is a versioned distributable package that can contain one or more Extensions, capability definitions, UI surfaces, configuration contracts, event subscriptions, adapters/connectors, bounded app state, migrations within its own storage boundary, and optional playbook/domain composition.

Apps may be first-party, verified community, or uncertified community packages.

## What Apps can do

Apps may contribute:

- capabilities callable by Workflows and AI tasks;
- read models and analytics views;
- commands that invoke existing MOS authorities;
- connectors to external SaaS/data sources;
- import/export and migration tools;
- dashboards, reports, widgets and workspace panels;
- domain-specific templates and playbooks;
- app-owned documents/artifacts such as spreadsheet files or report definitions;
- event subscriptions and idempotent handlers;
- optional human-facing approval/operations surfaces.

## Examples

A first-party or community App may provide some or all of:

- AgencyAnalytics-style reporting and client portals;
- Databox-style semantic analytics, dashboards and analytic agents;
- HubSpot-style CRM, pipeline and marketing automation;
- Excel/Sheets-style spreadsheet editing, formulas, import/export and analysis;
- SEO, paid-media, email, social, CMS and commerce connectors.

These are capabilities, not competing MOS authorities. Core Goals, Playbooks, Deployments, Workflows, Tasks, Executions, Evidence, Experiments, Learnings, Policies and tenant isolation remain in MOS authorities.

## Manifest

Each published App Version declares:

- app key and publisher identity;
- immutable semantic version and compatibility range;
- capabilities and capability versions;
- input/output schemas;
- requested data scopes;
- requested mutation scopes;
- network destinations;
- runtime class;
- event subscriptions;
- UI surfaces and routes;
- configuration schema;
- credential references required by name only;
- app-owned state namespaces;
- migration version;
- dependency Apps/Extensions;
- certification state;
- declared support level;
- metering dimensions.

No secret material, tenant identity, provenance or lifecycle authority is supplied by the caller in the manifest.

## Install and invoke

Install is workspace-scoped and policy-gated. Authorization derives the final granted scopes server-side. Invocation uses the existing short-lived Extension invocation context and immutable App Version identity.

An App capability may call MOS authorities only through approved application/module contracts. Direct database writes to MOS core tables are forbidden.

## Bounded app state

Apps may own data whose semantics are app-specific. Such state must declare an authority scope and may not shadow a MOS core object. An app-owned spreadsheet document is valid; an app-owned competing Workflow state machine is not.

App state must expose export/delete semantics and retain lineage to canonical MOS records where it references them.

## UI and developer model

Apps may contribute command-center cards, client-room panels, workspace tabs, report pages, editor panes and action menus. UI is presentation only and invokes server capabilities for mutations.

The Developer Portal publishes, validates, certifies, versions, tests and documents Apps. Community developers receive SDKs generated from stable capability contracts.

## Trust levels

UNVERIFIED → COMMUNITY_VERIFIED → MOS_CERTIFIED.

Trust level is metadata and a policy input. It never grants authority by itself.

## Upgrade and rollback

Published App Versions are immutable. An installation selects one exact version. Upgrade selects a new version for future invocations; historical invocation records retain their original App Version. Rollback reselects an existing approved version without rewriting history.

## Security

Authorization is evaluated before dependent traversal or external access. Cross-client access is fail-closed. Credential values remain inside the credentials authority. Network and runtime permissions are explicit. Every material invocation is auditable.

## Economics

MOS may meter installations, invocation count, compute/runtime, data volume and premium capabilities. Marketplace attribution is separate from the core financial authority.

## Non-goals

The App Ecosystem is not a license to create alternate workflow engines, CRM authorities, reporting truth, tenant stores, retry engines, evidence stores or policy engines.
