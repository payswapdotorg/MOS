# MarketingOS

Status: v1.6 architecture frozen; unified implementation in progress
Current Architecture Version: 1.6
Repository: payswapdotorg/MOS

MarketingOS (MOS) is a provider-independent, evidence-driven, multi-tenant Growth and Marketing Operating System. It connects commercial intent, governed marketing work, deterministic execution, AI, human participants, extensions/apps, evidence, outcomes, economics and learning.

## Current implementation

v1.5 MKT-001..MKT-052 are merged on main.

Verified v1.6 deliveries currently on main:
- ✅ MKT-053 Growth Mission and Objective Model
- ✅ MKT-055 Social Account and OAuth Connection Model
- ✅ MKT-068 Notification Delivery Plane
- ✅ MKT-069 Product Intelligence
- ✅ MKT-071 Commerce Catalog and Order Capabilities

See docs/handoff/IMPLEMENTATION-STATE.md and docs/handoff/EXECUTION-PLAN.md for the complete roadmap.

## Product experience

v1.6 becomes outcome-first:

Grow -> Market -> Find a Product -> Leads/Revenue -> Mission -> Learn -> Repeat

Existing v1.5 operations remain available as:

Today -> Clients -> Work -> Apps -> Admin

The UX contract is docs/product/PRODUCT-CONSOLE-V1.6.md.

## Deployment

Current production:
- Vercel project: mos-product
- Production alias: https://mos-product.vercel.app
- Inspected deployment: dpl_BwaJi8ho6QDaVq1RUjghezULAXn8
- Inspected main commit: c2c67e31ae814ceba09137348fb8b92d205d638c

The console source is repository-owned under console/ and production is Git-deployed.

Free-tier-aware deployment planning:
docs/handoff/DEPLOYMENT-PLAN-V1.6.md

Provider plans are not considered current deployment facts until the Tech Lead verifies the actual production account, environment and billing state.

## Architecture authority

The spec/ tree is authoritative.

Read AGENTS.md before implementation.

## Architectural rule

AI is a replaceable reasoning layer. The system of record, evidence, policy, workflow state, experiments, deterministic computation, and deployment lifecycle remain authoritative outside the model.
