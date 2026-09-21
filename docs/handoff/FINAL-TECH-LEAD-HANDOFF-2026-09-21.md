# MOS — Final Tech Lead Handoff — 2026-09-21

## Repository truth

Current main audit SHA:
1ef58f86afa0220a7fd546ad03c84bfb82e4656b

Verified v1.6 on main:
- MKT-053
- MKT-054
- MKT-055
- MKT-056
- MKT-063
- MKT-064
- MKT-068
- MKT-069
- MKT-071

Remaining core:
- MKT-057..062
- MKT-065..067
- MKT-070
- MKT-072..075

Optional:
- MKT-076..078

## Deployment truth

Current production:
dpl_8vG4jZrXaRNnMyAhdLc8J4JQJLaB
039743a6e31f792c44d0fc646d3dcb53843730b1
READY
https://mos-product.vercel.app

Production is five commits behind main. MKT-064 is on main and has a READY preview but is not production.

Confirmed provider: Vercel.
Unproven: exact billing tier, production Postgres provider, R2, Upstash, Apify, Render.

## Worker A

Implement:
MKT-057 YouTube
MKT-058 Instagram
MKT-059 Facebook Pages
MKT-060 TikTok
MKT-061 X

Deliver provider-specific capability evidence, OAuth/account constraints, limits, policy/rate-limit behavior, provider runbooks and conformance/E2E suites.

## Worker B

Implement:
MKT-062 Research / Content Intelligence
MKT-065 Cross-Platform Distribution
MKT-066 Platform Health / Distribution Anomaly
MKT-067 Experiment Analysis / Adaptive Allocation

Use MKT-063 and MKT-064 as existing authorities.

Optional branch:
MKT-076 -> MKT-077 -> MKT-078

## Worker C

Implement:
MKT-070 Product Marketing
MKT-072 Commerce Discovery
MKT-073 Social-Commerce Attribution
MKT-074 Growth Autopilot Console
MKT-075 Final Autonomy Proof

Also:
UX-001..UX-012
DEP-006..DEP-015

Worker C owns the shared frontend composition root.

## First UX change

After authentication, stop presenting the system as an architecture dashboard.

Primary choices:
Grow an audience
Market a product
Find a product to sell
Generate leads
Generate revenue
Continue a mission

Existing v1.5 operations become Today / Operations.

## Mission screen

Every mission must answer:
- target;
- progress;
- what MOS is doing now;
- what happens next;
- why;
- evidence;
- current experiment;
- platform health;
- content/rights;
- decision;
- learning;
- blocker/action if any.

## Acceptance journeys

1. signup -> mission launcher
2. creator growth single platform
3. creator growth multi-platform
4. research -> evidence -> hypothesis
5. rights -> transformation -> publish
6. measure -> analyze -> decision -> learning
7. platform anomaly -> compliant adaptation
8. human-required blocker -> notification -> resume
9. zero human budget -> autonomous continuation
10. product URL -> product marketing mission
11. authorized repository -> product marketing mission
12. unknown niche -> commerce discovery
13. viable product -> listing -> traffic -> order -> margin
14. optional human treatment -> experiment/evidence/learning
15. legacy Client / Human Work / Apps / Admin
16. mobile + desktop

## Deployment

Use docs/handoff/DEPLOYMENT-PLAN-V1.6.md.

Before promotion:
CI -> preview -> browser smoke -> migration check -> Tech Lead acceptance -> production -> health -> browser smoke -> rollback readiness.

The async worker must run outside the synchronous Vercel request path.

Do not claim a free-tier provider as current until production account/environment/billing evidence exists.

## Non-negotiables

- no second workflow engine;
- no second execution engine;
- no second human marketplace;
- no second commerce/order authority;
- no fake engagement;
- no anti-abuse bypass;
- no unsupported hidden moderation claims;
- rights uncertainty fails closed;
- zero human budget remains a valid autonomous state;
- repository remains source of truth.
