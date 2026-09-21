# MOS — Unified Successor Tech Lead Execution Plan (v1.5 + v1.6)

Architecture: v1.6 FROZEN
Maximum concurrent implementation workers: 3
Canonical handoff: this file

## 1. Current verified baseline

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

Not yet implemented:
MKT-057..062, MKT-065..067, MKT-070, MKT-072..075

Optional:
MKT-076..078

## 2. Truth-first rule

Before any new Work Item:
1. inspect current main;
2. inspect actual source, migrations and tests;
3. inspect merged delivery evidence;
4. classify VERIFIED / INCOMPLETE / BROKEN / BLOCKED / N/A;
5. only VERIFIED satisfies dependencies.

Do not rebuild MKT-054, MKT-056, MKT-063 or MKT-064.

## 3. Worker ownership

### Worker A — Social platform capability plane
Own MKT-057..MKT-061, provider runbooks, conformance, account/capability evidence, connection UX contracts and provider E2E.

### Worker B — Intelligence / optimization plane
Own MKT-062 and MKT-065..MKT-067, mission-trace data contracts, and optional MKT-076..MKT-078.

### Worker C — Mission / console / commerce / deployment
Own MKT-070, MKT-072..MKT-075, UX-001..UX-012 and DEP-006..DEP-015.

Only Worker C owns the shared frontend composition root.

## 4. UX work orders from the simulation

### UX-001 — Outcome-first Home
Authenticated entry choices:
Grow an audience
Market a product
Find a product to sell
Generate leads
Generate revenue
Continue a mission

Existing Command Center becomes Today / Operations.

### UX-002 — Reusable Mission Creation
Progressive flow:
outcome -> target -> product/source/store context -> social accounts -> platform strategy -> budget -> autonomy -> optional human treatment.

### UX-003 — Mission Workspace
One primary screen for:
Target, Progress, Now, Next, Why, Hypothesis, Experiment, Platforms, Health, Content, Rights, Transformation, Measurement, Decision, Learning, Blockers.

### UX-004 — Scientific Trace
Question -> Research -> Evidence -> Hypothesis -> Experiment -> Publication -> Measurement -> Analysis -> Decision -> Learning.

### UX-005 — Connections Center
Social, product/source, store and notification connections with capabilities, permissions, expiry/revocation and limitations.

### UX-006 — Content + Rights
Source, evidence, rights, transformation lineage, destination capability and publication state before publish.

### UX-007 — Platform Health
Descriptive observable states plus evidence basis and compliant next action. No invented hidden moderation state.

### UX-008 — Human Treatment
UGC/creator/review work appears as an optional experiment arm. Human absence never silently becomes failure.

### UX-009 — Commerce Mission
Market -> Candidate -> Test -> Viability -> Listing -> Traffic -> Order -> Margin -> Learning.

### UX-010 — Progressive Disclosure
Goals, Playbooks, Deployments, Workflows, Evidence, Experiments, Decisions, Learning, Jobs and Apps remain drill-downs.

### UX-011 — ShareNet-inspired design
Warm neutral/light surfaces, graphite type, restrained teal/green healthy state, amber warning, red failure, whitespace, minimal chrome, progressive disclosure.

### UX-012 — Browser proof
Every new journey uses real APIs, real authorization, 390x844 and 1280x800 checks, 0px overflow, zero page errors, no raw JSON and explicit empty/error/blocked next actions.

## 5. Dependency graph

v1.5 ✅
 |
 +--> MKT-053 ✅ --> MKT-054 ✅
 |
 +--> MKT-055 ✅ --> MKT-056 ✅
                         |
                         +--> MKT-057 ☐
                         +--> MKT-058 ☐
                         +--> MKT-059 ☐
                         +--> MKT-060 ☐
                         +--> MKT-061 ☐
                               |
                               +--> MKT-062 ☐
                                      |
                                      +--> MKT-065 ☐
                                             |
                                             +--> MKT-066 ☐
                                             +--> MKT-067 ☐
                                                    |
                                                    +--> MKT-070 ☐
                                                    +--> MKT-072 ☐
                                                    +--> MKT-073 ☐
                                                          |
                                                          +--> UX-001..UX-012 ☐
                                                                 |
                                                                 +--> MKT-074 ☐
                                                                        |
                                                                        +--> MKT-075 ☐

Parallel satisfied foundations:
MKT-063 ✅
MKT-064 ✅
MKT-068 ✅
MKT-069 ✅
MKT-071 ✅

Optional:
MKT-076 ☐ -> MKT-077 ☐ -> MKT-078 ☐

## 6. Parallel schedule

### Wave 0
Worker A: verify MKT-056 and start MKT-057/MKT-058.
Worker B: start MKT-062; consume MKT-063/MKT-064.
Worker C: start UX-001/UX-002 over real MKT-053/MKT-055 APIs; start MKT-070 preparation; start DEP-015.

### Wave 1
Worker A: MKT-057..061.
Worker B: MKT-062 and then MKT-065.
Worker C: MKT-070; UX-003/004/005; DEP-006..010.

### Wave 2
Worker A: provider hardening/evidence.
Worker B: MKT-066/067; optional human branch; mission-trace contracts.
Worker C: MKT-072/073; UX-006..011; DEP-011..014.

### Wave 3
Worker C: MKT-074.
All workers: complete browser journey battery and security regression.
Tech Lead: MKT-075 and DEP-015 final acceptance.

## 7. Mandatory journeys

1. signup -> mission launcher
2. creator growth -> single platform
3. creator growth -> multiple platforms
4. research -> evidence -> hypothesis
5. content -> rights -> transformation -> publish
6. measure -> analysis -> decision -> learning
7. platform anomaly -> compliant adaptation
8. human-required blocker -> notification -> resume
9. zero human budget -> autonomous continuation/replan
10. product marketing from URL
11. product marketing with authorized source
12. commerce discovery without a known product
13. viability -> listing -> traffic -> order -> margin
14. optional human treatment -> same experiment/evidence/learning loop
15. existing Client / Human Work / Apps / Admin
16. mobile + desktop

## 8. Deployment gate

Current production is READY but 5 commits behind main.

DEP-015 must promote only an accepted main SHA after:
CI -> preview -> browser smoke -> migration check -> Tech Lead acceptance -> production -> health -> browser smoke -> rollback readiness.

## 9. Final completion

All required v1.5 verified; MKT-057..075 verified; UX-001..012 verified; zero-human-budget autonomy proven; five adapters evidenced; rights/distribution/health/analysis proven; product marketing and commerce discovery proven; async worker restart/recovery proven; production runs the accepted main SHA; provider/account/billing state recorded; MKT-076..078 remain optional.
