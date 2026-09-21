# MarketingOS

Status: v1.6 architecture frozen; unified implementation in progress
Current Architecture Version: 1.6
Repository: payswapdotorg/MOS

MarketingOS is a provider-independent, evidence-driven, multi-tenant Growth and Marketing Operating System.

## Current implementation

v1.5:
- ✅ MKT-001..MKT-052

v1.6 on current main:
- ✅ MKT-053 Growth Mission
- ✅ MKT-054 Growth Operator
- ✅ MKT-055 Social Account / OAuth
- ✅ MKT-056 Social Adapter Contract
- ✅ MKT-063 Content Rights
- ✅ MKT-064 Content Assets / Transformations
- ✅ MKT-068 Notifications
- ✅ MKT-069 Product Intelligence
- ✅ MKT-071 Commerce Catalog / Orders

See docs/handoff/IMPLEMENTATION-STATE.md and docs/handoff/EXECUTION-PLAN.md.

## Product experience

Outcome-first:
Grow -> Market -> Find a Product -> Leads/Revenue -> Mission -> Learn -> Repeat

Existing operations:
Today -> Clients -> Work -> Apps -> Admin

## Deployment

Production:
Vercel / mos-product
https://mos-product.vercel.app

Production deployment:
dpl_7wEndfiEdUsC38e2ttam2sjmMFdg
commit c6a35db9709cf0b343221952f724bc52cd7ddd4f
READY

Accepted implementation baseline:
1ef58f86afa0220a7fd546ad03c84bfb82e4656b

Current main source-audit head:
34cb2d4b78c2291f8602ec964b80c2b1a2acaa7b

Final handoff documentation commit:
981f5d3dffbb7b3262efd91872785f1b50a6fd99

Production:
c6a35db9709cf0b343221952f724bc52cd7ddd4f (dpl_7wEndfiEdUsC38e2ttam2sjmMFdg)

Production is five implementation commits behind the accepted implementation baseline; later main commits are documentation/handoff only. MKT-064 has a READY preview but still requires production promotion.

Free-tier planning:
docs/handoff/DEPLOYMENT-PLAN-V1.6.md

Provider/billing assumptions are not current facts until verified.

## Architecture authority

The spec/ tree is authoritative.
Read AGENTS.md before implementation.

## Architectural rule

AI is a replaceable reasoning layer. Durable state, evidence, policy, workflow/execution lifecycle, experiments, deterministic computation and deployment remain authoritative outside the model.
