# MOS — Final Tech Lead Handoff — 2026-09-21

## Repository truth

Implementation baseline:
1ef58f86afa0220a7fd546ad03c84bfb82e4656b

Final main handoff head:
bd089a752a309790d9cb148e700204ba302265ef

The final handoff head contains documentation/handoff updates after the implementation baseline; do not treat those documentation-only commits as additional Work Item implementations.

Verified v1.6 on the implementation baseline:
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

Production is five implementation commits behind the accepted implementation baseline. MKT-064 is on the baseline and has a READY preview but is not production.

Confirmed provider: Vercel.
Unproven: exact billing tier, production Postgres provider, R2, Upstash, Apify, Render.

## Worker A

Implement MKT-057 YouTube, MKT-058 Instagram, MKT-059 Facebook Pages, MKT-060 TikTok, MKT-061 X.

Deliver provider-specific capability evidence, OAuth/account constraints, limits, policy/rate-limit behavior, provider runbooks and conformance/E2E suites.

## Worker B

Implement MKT-062 Research / Content Intelligence, MKT-065 Cross-Platform Distribution, MKT-066 Platform Health / Distribution Anomaly, MKT-067 Experiment Analysis / Adaptive Allocation.

Consume MKT-063 and MKT-064 as existing authorities.

Optional side branch:
MKT-076 -> MKT-077 -> MKT-078.

## Worker C

Implement MKT-070 Product Marketing, MKT-072 Commerce Discovery, MKT-073 Social-Commerce Attribution, MKT-074 Growth Autopilot Console and MKT-075 Final Autonomy Proof.

Also own UX-001..UX-012 and DEP-006..DEP-015.

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
target; progress; what MOS is doing now; what happens next; why; evidence; current experiment; platform health; content/rights; transformation; decision; learning; blocker/action.

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
CI -> preview -> migration check -> browser smoke -> Tech Lead acceptance -> production -> health -> browser smoke -> rollback readiness.

Async worker must run outside synchronous Vercel request handling.

Do not call a provider a current production dependency until account/environment/billing evidence exists.

## Non-negotiables

No second workflow engine.
No second execution engine.
No second human marketplace.
No second commerce/order authority.
No fake engagement.
No anti-abuse bypass.
No unsupported hidden moderation claims.
Rights uncertainty fails closed.
Zero human budget remains a valid autonomous state.
Repository remains source of truth.
