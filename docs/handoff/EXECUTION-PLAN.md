# MOS — Unified Successor Tech Lead Execution Plan (v1.5 + v1.6, Re-audited 2026-09-21)

Architecture: v1.6 FROZEN
Maximum concurrent implementation workers: 3
Canonical execution authority: this file

## 1. Repository truth

- Current main HEAD: 575f56df363d64eefddef32ea4e7fbd8d18add8d
- Last source-audited implementation tree: 34cb2d4b78c2291f8602ec964b80c2b1a2acaa7b
- Accepted implementation baseline: 1ef58f86afa0220a7fd546ad03c84bfb82e4656b
- The post-baseline commits on main are documentation/handoff corrections only.
- Current production: dpl_7wEndfiEdUsC38e2ttam2sjmMFdg, commit c6a35db9709cf0b343221952f724bc52cd7ddd4f, READY.
- Direct ancestry audit proves the accepted implementation baseline is already contained in production.
- Vercel runtime-error query for the selected 24h window returned no runtime errors.
- Open PRs: none at audit time.

## 2. Verified v1.6 baseline

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
- ☐ MKT-057 YouTube Adapter
- ☐ MKT-058 Instagram Adapter
- ☐ MKT-059 Facebook Pages Adapter
- ☐ MKT-060 TikTok Adapter
- ☐ MKT-061 X Adapter
- ☐ MKT-062 Web Research / Content Intelligence
- ☐ MKT-065 Cross-Platform Distribution
- ☐ MKT-066 Platform Health / Distribution Anomaly Detection
- ☐ MKT-067 Experiment Analysis / Adaptive Allocation
- ☐ MKT-070 Product Marketing Mission Planner
- ☐ MKT-072 Commerce Discovery Mission
- ☐ MKT-073 Social-to-Commerce Attribution
- ☐ MKT-074 Growth Autopilot Console
- ☐ MKT-075 v1.6 End-to-End Autonomy Proof

Optional and never core-blocking:
- ☐ MKT-076 Human Growth Work Extensions
- ☐ MKT-077 UGC / Creator Offer Model
- ☐ MKT-078 Human Amplification Optimization

## 3. Non-negotiable architecture rules

1. Growth Operator is a persistent controller, never a second Workflow or Execution engine.
2. Existing Workflow, Task, Execution, Evidence, Experiment, Learning, Policy, Credential, Job, Client/Workspace, Commerce and Deployment authorities remain singular.
3. Social providers live behind the normalized MKT-056 adapter contract; capability parity is never assumed.
4. Rights uncertainty fails closed; a connection never grants redistribution rights.
5. Content Assets are immutable/versioned and retain source, ingredient and transformation lineage.
6. Platform Health describes only observable provider/account signals; never invent hidden moderation state.
7. Cross-platform adaptation is compliant strategy, never anti-abuse evasion or fake engagement.
8. Product source inspection is read-only unless separately authorized.
9. Attribution is linkage evidence, not causal proof.
10. Human UGC/creator work is optional acceleration. Zero human budget/capacity/offers remains a valid autonomous path.
11. No second human marketplace, commerce/order authority, workflow engine or execution engine.
12. Repository source/tests/runtime evidence outrank summaries, screenshots and PR descriptions.

## 4. Journey simulation — current result

### First visit
Live production returns 200 and exposes real Sign in, Create account and Demo accounts.
Authentication is discoverable.
After login, the current shell is still:
Command Center → Clients → Attention → Profit Intelligence → Human Work → Apps → Administration.
Learning: the first authenticated screen teaches MOS structure instead of the business outcome MOS can pursue.

### Creator growth
Desired:
Grow → connect accounts → research → evidence → hypothesis → experiment → rights → transform → publish → measure → learn → replan.
Current: NOT DISCOVERABLE.
MKT-053/054/055/056 exist, but 057..061 and the mission-first console are missing.
Learning: “Grow an audience” must be a primary action; internal operator/workflow/execution terms belong behind progressive disclosure.

### Product marketing
Desired:
Product URL/source → product understanding → channel/metric plan → execute → measure.
Current: NOT DISCOVERABLE.
MKT-069 exists, but MKT-070 and mission UI do not.
Learning: “Market a product” must be a primary action.

### Commerce discovery
Desired:
No product → research → candidate → demand test → viability → listing → traffic → order → margin → learning.
Current: NOT DISCOVERABLE.
MKT-071 exists, but MKT-072 and mission UI do not.
Learning: commerce must be an outcome lifecycle, not an integration settings page.

### Rights / transformation
MKT-063 and MKT-064 are implemented and are already in current production, but not visible as a mission-first user journey.
Learning: before publication, users must see source evidence, rights decision, lineage, transformation, destination capability and publication state.

### Human amplification
Human Work exists and is discoverable.
Learning: human work belongs inside the mission as an optional experiment treatment. Lack of creators/funding/offers must not silently block autonomous operation.

### Scientific trace
The existing Client Workspace exposes Goals, Strategy, Deployments, Workflows, Evidence, Decisions, Learning and Memory.
Learning: compose a mission narrative over these authorities rather than inventing a second analytics hierarchy.

### Platform health
Current mission-level health is absent.
Learning: show observable state, evidence basis, uncertainty and the next compliant action; never claim hidden moderation.

### Existing operations
Preserve Command Center/Today, Clients, Human Work, Apps and Administration as secondary operational surfaces.

A fresh click-by-click Chromium session was unavailable in this audit environment because the browser executable was missing and could not be downloaded. This audit therefore does not claim fresh interactive browser results; it uses live production HTML, source, architecture/backlog, recorded E2E evidence, deployment metadata and runbooks.

## 5. UX work orders

### UX-001 — Outcome-first Home
Primary choices:
- Grow an audience
- Market a product
- Find a product to sell
- Generate leads
- Generate revenue
- Continue a mission

Existing Command Center becomes Today / Operations.

### UX-002 — Reusable Mission Creation
Progressive flow:
outcome → target → product/source/store context → connections → strategy → budget/quota → autonomy → optional human treatment.
No dead controls; unavailable capabilities must show a truthful state and next action.

### UX-003 — Mission Workspace
One screen answers:
target, progress, now, next, why, evidence, hypothesis, experiment, platforms, health, content, rights, transformation, measurement, decision, learning and blockers.

### UX-004 — Scientific Trace
Question → Research → Evidence → Hypothesis → Experiment → Publication → Measurement → Analysis → Decision → Learning.
Observed facts, derived claims/hypotheses and causal interpretations are visually distinct.

### UX-005 — Connections Center
Social, product/source, store and notification connections show capabilities, scopes/permissions, expiry, revocation, authorization health and provider limitations.

### UX-006 — Content + Rights
Show:
source asset → provenance evidence → rights state → ingredient lineage → transformations → destination capability → publication state.

### UX-007 — Platform Health
Show descriptive state, evidence basis, confidence/uncertainty and next compliant action.

### UX-008 — Human Treatment
Show UGC/creator/review as an optional experiment arm alongside non-human treatments. Human absence is never an implicit failure.

### UX-009 — Commerce Mission
Market → Candidate → Test → Viability → Listing → Traffic → Order → Margin → Learning.

### UX-010 — Progressive Disclosure
Goals, Playbooks, Deployments, Workflows, Evidence, Experiments, Decisions, Learning, Jobs and Apps remain drill-down operational objects.

### UX-011 — ShareNet-inspired visual direction
Warm neutral/light surfaces, graphite type, restrained teal/green healthy state, amber warning/degraded, red only for true failure/block, generous whitespace, minimal chrome, progressive disclosure, subtle transitions and strong focus/contrast.

### UX-012 — Browser proof
Every new journey must use real APIs and real authorization and pass:
390×844 + 1280×800; zero horizontal overflow; zero page/browser errors; no raw JSON; honest loading/empty/error/blocked states; one clear next action.

## 6. Three-worker ownership

### Worker A — Social platform capability plane
Own MKT-057..061, provider capability matrices, OAuth/scope constraints, rate/quota behavior, provider limitations, conformance suites, provider sandbox/double evidence, provider E2E and connection capability contract data.
Worker A does not own the shared frontend composition root.

### Worker B — Intelligence / distribution / science
Own MKT-062, MKT-065, MKT-066, MKT-067 plus mission scientific-trace contracts.
Important parallelism:
- MKT-067 can start immediately because its frozen dependencies are already satisfied.
- MKT-065 can start immediately because 054,056,063,064 are verified.
- MKT-062 can start its provider-independent source/provenance core now, but is not accepted until 057..061 are verified.
- MKT-066 remains gated on concrete provider adapters.
MKT-076..078 are optional side work only if they cannot delay core work.

### Worker C — Mission / console / commerce / deployment
Own MKT-070, MKT-072, MKT-073, MKT-074, MKT-075, UX-001..012, DEP-006..015 and final browser/E2E orchestration.
Only Worker C changes the shared frontend composition root.

## 7. Revised execution waves

### Wave 0 — start immediately
Worker A: start all five provider adapter lanes and current capability evidence.
Worker B: MKT-067 end-to-end; MKT-065 distribution core + rights/authorization tests; MKT-062 provider-independent research/provenance core; define mission scientific trace.
Worker C: UX-001/002 using only real existing APIs; MKT-070/072/073 preparation; DEP-006 deployment contract; DEP-007 actual database verification; DEP-008 object-store adapter design.

### Wave 1 — first integration
Worker A: complete all adapters, conformance and E2E.
Worker B: complete 062 after adapters verify; complete 065 provider integration; implement 066; harden/reproduce 067 zero-human allocation.
Worker C: UX-003/004/005; MKT-070 as soon as 062/066/067 verify; DEP-009 worker; DEP-010 Redis; begin UX-006/007.

### Wave 2 — mission completion
Worker A: provider regression matrix after distribution wiring.
Worker B: harden 065/066/067; optional 076..078 only if non-blocking; publish mission trace/evidence read contracts.
Worker C: MKT-072, MKT-073; UX-006..011; DEP-011 research provider; DEP-012 quota/budget; DEP-013 promotion; DEP-014 retention/cost.

### Wave 3 — product proof
Worker C: MKT-074 + UX-012 and complete all outcome-first journeys.
Tech Lead: independent cross-worker audit, MKT-075, production parity and rollback acceptance.

## 8. Frozen dependency graph

The frozen backlog remains authoritative. This schedule only changes when work begins.

v1.5
└── ✅ MKT-001..052
    ├── ✅ MKT-053 → ✅ MKT-054
    ├── ✅ MKT-055 → ✅ MKT-056 → ☐ MKT-057..061
    │                       └── ☐ MKT-062
    ├── ✅ MKT-063 → ✅ MKT-064 → ☐ MKT-065
    ├── ✅ MKT-068
    ├── ✅ MKT-069
    └── ✅ MKT-071

Parallel-ready now:
- ☐ MKT-067 (all frozen dependencies already satisfied)
- ☐ MKT-065 (all frozen dependencies already satisfied)

Next joins:
- ☐ MKT-070 ← 053 + 062 + 066 + 067 + 069
- ☐ MKT-072 ← 053 + 062 + 063 + 065 + 067 + 071
- ☐ MKT-073 ← 065 + 071 + 072 + 052
- ☐ MKT-074 ← v1.6 capability set + verified console APIs
- ☐ MKT-075 ← 054 + 065 + 067 + 068 + 070 + 072 + 073 + 074

Optional side branch:
☐ MKT-076 → ☐ MKT-077 → ☐ MKT-078
Never blocks the core graph.

## 9. Mandatory journey battery

1. signup → outcome-first launcher
2. creator growth → single platform
3. creator growth → multiple platforms
4. research → evidence → hypothesis
5. rights → transformation → publish
6. measure → analysis → decision → learning
7. platform anomaly → compliant adaptation
8. human-required blocker → notification → action
9. zero human budget → autonomous continuation/replan
10. product URL → product-marketing mission
11. authorized source repository/workspace → product-marketing mission
12. no known product → commerce discovery
13. viable product → listing → traffic → order → margin
14. optional human treatment → same experiment/evidence/learning loop
15. existing Client / Human Work / Apps / Admin
16. mobile 390×844 + desktop 1280×800

For every journey record SHA, tenant/persona, route, capability prerequisites, authority chain, observed result, screenshots/logs/API evidence, errors and next action.

## 10. Deployment work orders

DEP-006 — exact console/API/worker processes, Node 24, environment contract, health/readiness, migrations and rollback.

DEP-007 — identify actual production Postgres account/provider, plan, region, backups, restore and staging isolation. Do not infer from env names.

DEP-008 — production object storage with immutable/content-addressed objects, signed/private access, retention and no bytes in domain tables. Candidate: Cloudflare R2.

DEP-009 — run src/entrypoints/worker.ts outside synchronous Vercel requests; prove durable pickup, restart convergence, leases, retries and graceful shutdown.

DEP-010 — candidate Upstash for transient locks/rate limits/coordination only; no canonical domain state in Redis.

DEP-011 — provider-neutral research execution; candidate Apify; provenance, budget, retry/idempotency and source policy.

DEP-012 — budget/quota guard across social APIs, research, AI/compute, storage/bandwidth, paid media, commerce tests and human review.

DEP-013 — CI → preview → migration check → browser smoke → Tech Lead acceptance → production → health → browser smoke → rollback-ready.

DEP-014 — deployment/evidence/object/queue/research retention and free-tier threshold monitoring.

DEP-015 — whenever a NEW implementation baseline is accepted, verify ancestry + CI + preview + migrations + browser + production SHA + rollback candidate.

Important: Vercel Hobby Cron is not a suitable autonomous scheduler for MOS; the controller must use the external worker/runtime path.

## 11. Final acceptance

v1.6 is complete only when MKT-057..075 are source/test/runtime verified; UX-001..012 pass browser proof; five adapters expose documented real capability limits; rights/distribution/health/analysis are visible in mission UX; product marketing and commerce are end-to-end; zero-human-budget autonomy is demonstrated; worker restart/recovery is demonstrated; production parity and provider/account/billing state are recorded; optional 076..078 remain non-blocking.
