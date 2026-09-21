# MOS — Unified Successor Tech Lead Execution Plan (v1.5 + v1.6)

Architecture: v1.6 FROZEN
Maximum concurrent implementation workers: 3
Canonical handoff: this file

## 1. Current baseline

MKT-001..MKT-052 remain the v1.5 baseline.

Verified v1.6 deliveries on current main:

- MKT-053 Growth Mission and Objective Model
- MKT-055 Social Account and OAuth Connection Model
- MKT-068 Notification Delivery Plane
- MKT-069 Product Intelligence
- MKT-071 Commerce Catalog and Order Capabilities

Remaining v1.6 implementation is not complete.

The previous console-source P0 is resolved. Do not recreate it.

## 2. Truth-first rule

Before any implementation:

1. inspect current main;
2. inspect source, migrations, tests, implementation report and merged PR;
3. classify VERIFIED / INCOMPLETE / BROKEN / BLOCKED / N/A;
4. only VERIFIED satisfies dependency edges;
5. never trust a completion message without objective evidence.

## 3. Worker ownership

### Worker A — platform capability plane

Own:

- unresolved v1.5 provider/platform gaps;
- MKT-056..MKT-061;
- social account UX contracts and provider runbooks;
- provider integration fixtures and conformance tests.

### Worker B — intelligence/content/science plane

Own:

- MKT-062..MKT-067;
- research;
- rights/provenance;
- transformations;
- platform health;
- experiment analysis;
- optional MKT-076..MKT-078;
- mission-trace data contracts.

### Worker C — mission/console/commerce/deployment plane

Own:

- MKT-054;
- MKT-070, MKT-072, MKT-073, MKT-074, MKT-075;
- UX-001..UX-012;
- DEP-006..DEP-014;
- final E2E orchestration.

Only Worker C owns the frontend composition root at a time.

## 4. New UX implementation work orders from the simulation

### UX-001 — Outcome-first Home

Replace the current operations-only first screen with:

- Grow an audience
- Market a product
- Find a product to sell
- Generate leads
- Generate revenue
- Continue a mission

Keep the existing Command Center as Today / Operations.

### UX-002 — Reusable mission creation

Progressively collect:

1. outcome;
2. target metric/value;
3. product/source/store context;
4. connected social accounts;
5. fixed portfolio or Choose for me;
6. content/source preferences;
7. budget/quota;
8. autonomy mode;
9. optional human-treatment budget.

Do not expose module names as prerequisites.

### UX-003 — Mission workspace

Expose:

Target / Progress / Now / Next / Why / Hypothesis / Experiment / Platforms / Health / Content / Rights / Transformation / Measurement / Decision / Learning / Blockers.

### UX-004 — Unified scientific trace

Question -> Research -> Evidence -> Hypothesis -> Experiment -> Publication -> Measurement -> Analysis -> Decision -> Learning.

Distinguish observed, inferred and causal states.

### UX-005 — Connections Center

Expose social, product/source, store and notification connections. Show capabilities, permissions, expiry/revocation and limitations.

### UX-006 — Content & Rights surface

Expose source, evidence basis, rights, transformation lineage, destination capability and publication status.

### UX-007 — Platform Health

Expose descriptive health state, evidence basis, confidence and compliant next action.

### UX-008 — Human treatment

Offer optional UGC/creator/review treatments inside a mission. Clearly show unavailable/unfunded as optional capacity, not failure.

### UX-009 — Commerce mission

Expose Market -> Candidate -> Test -> Viability -> Listing -> Traffic -> Order -> Margin -> Learning.

### UX-010 — Progressive disclosure

Internal architecture objects remain accessible but contextual.

### UX-011 — ShareNet-inspired visual language

Use warm-light surfaces, graphite text, restrained teal/green healthy state, amber warning, red failure, whitespace, minimal chrome and progressive disclosure.

Avoid dashboard density, gradients, glassmorphism and raw JSON.

### UX-012 — Responsive journey proof

Verify every new path at 390x844 and 1280x800 with zero page errors, zero overflow and explicit empty/error/blocked next actions.

## 5. Core implementation graph

v1.5 verified
  |
  +--> MKT-053 [done] --> MKT-054
  |
  +--> MKT-055 [done] --> MKT-056
                              |
                              +--> MKT-057
                              +--> MKT-058
                              +--> MKT-059
                              +--> MKT-060
                              +--> MKT-061
                                     |
                                     +--> MKT-062
                                            |
                                            +--> MKT-063
                                            +--> MKT-064
                                                   |
                                                   +--> MKT-065
                                                          |
                                                          +--> MKT-067
                                                                 |
                                                                 +--> MKT-070
                                                                 +--> MKT-072
                                                                 +--> MKT-073
                                                                        |
                                                                        +--> UX-001..UX-012
                                                                               |
                                                                               +--> MKT-074
                                                                                      |
                                                                                      +--> MKT-075

Independent verified:
MKT-068 [done]
MKT-069 [done]
MKT-071 [done]

Optional:
MKT-076 -> MKT-077 -> MKT-078

## 6. Scheduling waves

### Wave 0

Worker A:
- verify v1.5 provider/integration surfaces;
- start MKT-056.

Worker B:
- prepare MKT-062..064 contracts/fixtures;
- start MKT-063/064 implementation where their dependencies allow.

Worker C:
- start UX-001/UX-002;
- start MKT-054 preparation;
- start DEP-006/DEP-007 provider verification.

### Wave 1

Worker A:
MKT-056 -> MKT-057..061 in independently verified provider waves.

Worker B:
MKT-062 -> MKT-063/064.

Worker C:
MKT-054 + UX-003/004/005 + DEP-008/009.

### Wave 2

Worker A:
adapter hardening and provider evidence.

Worker B:
MKT-066/067 + UX data contracts + optional MKT-076..078.

Worker C:
MKT-070/072/073 + UX-006..011 + DEP-010..012.

### Wave 3

Worker C:
MKT-074 + MKT-075 orchestration.

All workers:
full browser journeys and security regressions.

## 7. Mandatory acceptance journeys

1. new user -> creator mission;
2. connect one platform;
3. connect multiple platforms;
4. research -> evidence -> hypothesis;
5. content candidate -> rights -> transformation -> publish;
6. measure -> analysis -> decision -> learning;
7. platform anomaly -> compliant adaptation;
8. human-required blocker -> notification -> resume;
9. zero human budget -> autonomous progress/replan;
10. product marketing from URL;
11. product marketing with authorized repository;
12. commerce discovery from unknown niche;
13. viable product -> listing -> traffic -> order -> margin;
14. optional human treatment enters experiment loop;
15. existing Client / Human Work / Apps / Admin journeys;
16. mobile + desktop.

## 8. Deployment

Use docs/handoff/DEPLOYMENT-PLAN-V1.6.md.

Do not document a provider as current until the Tech Lead verifies provider account, environment and billing state.

## 9. Final completion

The program is complete only when:

- all required v1.5 items remain VERIFIED;
- MKT-054..MKT-075 are VERIFIED;
- UX-001..UX-012 are VERIFIED;
- autonomous operation works with zero human budget;
- all five MVP social adapters have provider evidence;
- rights/distribution/health/experimentation are proven;
- product marketing and commerce discovery pass;
- production deployment is repository-reproducible;
- deployment and cost limits are monitored;
- optional human-growth work, if implemented, remains non-blocking.
