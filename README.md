# MarketingOS

Status: v1.6 architecture frozen; unified implementation in progress
Current Architecture Version: 1.6
Repository: payswapdotorg/MOS

MarketingOS is a provider-independent, evidence-driven, multi-tenant Growth and Marketing Operating System.

## Current implementation

v1.5:
- ✅ MKT-001..MKT-052

Verified v1.6:
- ✅ MKT-053 Growth Mission
- ✅ MKT-054 Growth Operator
- ✅ MKT-055 Social Account / OAuth
- ✅ MKT-056 Social Adapter Contract
- ✅ MKT-063 Content Rights / Provenance
- ✅ MKT-064 Content Assets / Transformations
- ✅ MKT-068 Notifications
- ✅ MKT-069 Product Intelligence
- ✅ MKT-071 Commerce Catalog / Orders

Remaining core:
- ☐ MKT-057..062
- ☐ MKT-065..067
- ☐ MKT-070
- ☐ MKT-072..075

Optional:
- ☐ MKT-076..078

## Product experience

Target outcome-first entry:
Grow an audience · Market a product · Find a product to sell · Generate leads · Generate revenue · Continue a mission

Current production still presents the v1.5 operations shell first:
Command Center → Clients → Attention → Profit Intelligence → Human Work → Apps → Administration

## Repository / deployment truth

Current main HEAD:
575f56df363d64eefddef32ea4e7fbd8d18add8d

Accepted implementation baseline:
1ef58f86afa0220a7fd546ad03c84bfb82e4656b

Production:
- Vercel / mos-product
- https://mos-product.vercel.app
- deployment dpl_7wEndfiEdUsC38e2ttam2sjmMFdg
- commit c6a35db9709cf0b343221952f724bc52cd7ddd4f
- READY
- selected 24h runtime-error query: no runtime errors

The accepted implementation baseline is already contained in production by verified ancestry. Post-baseline main commits are documentation/handoff corrections only.

Confirmed production provider:
- Vercel

Not verified:
- exact Vercel billing tier
- production Postgres/object storage/Redis/research providers

Vercel has a free Hobby plan, but do not treat MOS as being on Hobby until account billing/eligibility is verified.

## Architecture authority

The spec/ tree is authoritative.
Read AGENTS.md before implementation.

## Canonical handoff

- docs/handoff/EXECUTION-PLAN.md
- docs/handoff/IMPLEMENTATION-STATE.md
- docs/handoff/UX-DISCOVERY-V1.6.md
- docs/handoff/DEPLOYMENT-PLAN-V1.6.md
- docs/handoff/FINAL-TECH-LEAD-HANDOFF-2026-09-21.md
- docs/handoff/WORKER-CONTRACT.md
- docs/product/PRODUCT-CONSOLE-V1.6.md

## Architectural rule

AI is a replaceable reasoning layer. Durable state, evidence, policy, workflow/execution lifecycle, experiments, deterministic computation and deployment remain authoritative outside the model.
