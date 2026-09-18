# MarketingOS

**Status:** Architecture package FROZEN; v1.5 backend/platform roadmap complete  
**Current Architecture Version:** 1.5  
**Previous Baseline:** 1.4

MarketingOS (MOS) is a provider-independent, evidence-driven, multi-tenant Marketing Operating System for agencies. It connects commercial intent, governed marketing work, deterministic execution, AI, human participants, extensions/apps, evidence, outcomes, economics and learning.

## Core operating model

```text
Prospect → Client → Goal → Strategy/Hypothesis → Playbook Version
→ Deployment → Workflow → Task → Human / AI / App / Extension
→ Execution → Evidence → Outcome → Revenue / Cost / Margin
→ Decision → Learning → next action / deployment
```

## v1.5 capabilities

- Agency Operating Graph as a derived coordination projection.
- Append-oriented Decision Ledger.
- Derived Profit Intelligence with source references and calculation assumptions.
- Client Operating Memory.
- AI Operator / Attention Queue.
- Sales-to-Delivery Continuity.
- Versioned App Ecosystem with first-party and community capabilities.
- App marketplace, trust/certification, developer portal, install/upgrade/rollback and metering.
- Deployment validation of required App/Extension capability versions.

## Current implementation state

MKT-001..MKT-052 are accepted/merged on `main`. See `docs/handoff/IMPLEMENTATION-STATE.md` for the current verification ledger.

The user-facing MOS console is a separate Vercel `mos-product` deployment today. Its source is **not yet present in this repository**. The console source reconciliation is therefore a P0 handoff gate documented in `docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md`.

The repository is not considered product-complete until the console source is committed here and the production deployment is reproducible from the repository.

## Product experience

The console should organize the agency experience around:

**Today → Clients → Work → Apps → Admin**

Deeper architecture objects remain contextual:

- Client Decision Room.
- Goals / Strategy / Playbooks.
- Deployment Center.
- Workflow / Execution timeline.
- Evidence Explorer.
- Experiment Lab.
- Human Agent queue.
- App Marketplace / Developer Portal.
- Decision and learning trace.

The UX contract lives in `docs/product/PRODUCT-CONSOLE-V1.5.md`.

## Architecture authority

The `spec/` tree is authoritative. v1.5 supersedes v1.4 only where the v1.5 frozen documents explicitly add or alter behavior.

Read `AGENTS.md` before implementation work.

## Architectural rule

> **AI is a replaceable reasoning layer. The system of record, evidence, policy, workflow state, experiments, deterministic computation, and deployment lifecycle remain authoritative outside the model.**

Apps are presentation/composition capabilities, not alternate MOS authorities. PostgreSQL remains authoritative for durable MOS state.
