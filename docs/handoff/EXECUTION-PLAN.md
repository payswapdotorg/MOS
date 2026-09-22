# MOS — Unified Successor Tech Lead Execution Plan (v1.5 + v1.6)

Architecture: v1.6 FROZEN
Maximum concurrent implementation workers: 3
Canonical execution authority: this file
Reconciled with repository main: 2026-09-22 (successor orchestrator)

## 1. Repository truth

- Current main HEAD: 10f51781f8d198cd07c19259f722c1aeab7ac8e6 (verified by ls-remote)
- Current production deployment: dpl_5MfdkKM631cTvDTw4V1NYNq2xyU3
- Current production commit: 0cc7d51b0af5a4ee203f75157978e73fc9024fdf (MKT-058/Instagram)
- Production state verification: recorded from the 2026-09-22 Tech-Lead handoff; the
  operating environment's Vercel token is scope-forbidden for the project team, so
  production was not re-queried at reconciliation time. §10 remains the promotion gate.
- Main is ahead of production by: UX-003 (PR #59), MKT-062 (PR #60), MKT-059 (PR #61),
  UX-004 (PR #62 + evidence 10f5178).
- Green in this plan means merged/verified on repository main — NOT production-live.

## 2. Verified v1.6 implementation state (main @ 10f5178)

- ✅ MKT-053 Growth Mission
- ✅ MKT-054 Growth Operator
- ✅ MKT-055 Social Account / OAuth
- ✅ MKT-056 Social Adapter Contract
- ✅ MKT-057 YouTube Adapter
- ✅ MKT-058 Instagram Adapter (in production)
- ✅ MKT-059 Facebook Pages Adapter
- ✅ MKT-062 Web Research / Content Intelligence (with HTTP surfaces; console UX pending)
- ✅ MKT-063 Content Rights / Provenance
- ✅ MKT-064 Content Assets / Transformations
- ✅ MKT-065 Cross-Platform Distribution (with known defect — §12)
- ✅ MKT-067 Experiment Analysis / Adaptive Allocation
- ✅ MKT-068 Notifications
- ✅ MKT-069 Product Intelligence
- ✅ MKT-071 Commerce Catalog / Orders
- ✅ UX-001 Outcome-first Home
- ✅ UX-002 Reusable Mission Creation
- ✅ UX-003 Mission Workspace
- ✅ UX-004 Scientific Trace

Remaining core:
- ☐ MKT-060 TikTok Adapter
- ☐ MKT-061 X Adapter
- ☐ MKT-066 Platform Health / Distribution Anomaly Detection
- ☐ MKT-070 Product Marketing Mission Planner
- ☐ MKT-072 Commerce Discovery Mission
- ☐ MKT-073 Social-to-Commerce Attribution
- ☐ MKT-074 Growth Autopilot Console
- ☐ MKT-075 v1.6 End-to-End Autonomy Proof
- ☐ UX-005..UX-012

Optional and never core-blocking:
- ☐ MKT-076 Human Growth Work Extensions
- ☐ MKT-077 UGC / Creator Offer Model
- ☐ MKT-078 Human Amplification Optimization

Station-verified baseline at this head: tsc 0 · lint 0 · arch:check 48 modules /
594 files / 0 violations · unit 1204/1204 · architecture 679/679 · serialized
integration 99 files 1116/1116 · migration tail 057_content_intelligence.sql.

## 3. Non-negotiable architecture rules

1. Growth Operator is a persistent controller/decision/replanning layer — never a second Workflow or Execution engine. Correct relationship: Mission → Operator decisions → existing Workflow/Execution authorities.
2. Existing Workflow, Task, Execution, Evidence, Experiment, Learning, Policy, Credential, Job, Client/Workspace, Commerce and Deployment authorities remain singular. No second workflow engine, execution engine, mission state machine, evidence authority, analytics hierarchy, commerce/order authority, human marketplace or payment authority.
3. Social providers live behind the normalized MKT-056 adapter contract; capability parity is never assumed — a provider may truthfully expose fewer than the frozen five capability families.
4. Rights uncertainty fails closed; a connection never grants redistribution rights. Cross-platform publishing requires source asset → rights/provenance → transformation lineage → destination capability → publication. No autonomous publication on ambiguous rights.
5. Content Assets are immutable/versioned and retain source, ingredient, transformation and destination lineage.
6. Platform Health describes only observable provider/account signals; never invent hidden moderation state, shadow bans or unsupported provider diagnostics. Use `suspected_distribution_anomaly` where only observable anomaly evidence exists.
7. Cross-platform adaptation is compliant strategy, never anti-abuse evasion or fake engagement.
8. Product source inspection is read-only unless separately authorized.
9. Attribution is linkage evidence, not causal proof — be explicit about evidence versus causality.
10. Human UGC/creator work is optional acceleration. Zero human budget/capacity/offers remains a valid autonomous path; human absence must never silently become a blocker. Only genuine rights/policy/capability approval requirements may create `blocked_pending_human_action`.
11. Repository source/tests/runtime evidence outrank summaries, screenshots and PR descriptions. When artifacts disagree, stop and investigate the disagreement.

## 4. Journey simulation — current result (2026-09-22)

### First visit / progressive disclosure
Outcome-first Home is live (UX-001): Grow an audience / Market a product / Find a
product to sell / Generate leads / Generate revenue / Continue a mission. Internal
operator/workflow/execution vocabulary stays behind drill-down (UX-010 hardening pending).

### Journey A — creator growth (partially emerged)
Grow → define target → connect account → research → evidence → hypothesis →
experiment → rights → transform → publish → measure → analyze → decide → learn → replan.
Present: outcome-first creation, mission workspace with lifecycle, scientific trace
with the ten-link chain, three adapters, research backend authority.
Remaining gaps: Connections onboarding UX (UX-005), research UX discoverability,
TikTok/X adapters (MKT-060/061), rights/action operational UX (UX-006), platform
health (MKT-066 + UX-007).

### Journey B — product marketing (backend emerged, journey pending)
MKT-069 exists; MKT-070 and the user-facing journey remain. "Market a product"
pre-selection exists in mission creation (UX-002/003 evidence); the full planning
mission is not yet end-to-end.

### Journey C — commerce discovery (backend emerged, journey pending)
MKT-071 exists; MKT-072/073 and the mission UX remain. Must feel like:
market → candidate → test → viability → listing → traffic → order → margin → learning.

### Journey D — scientific learning (strongly emerged)
Evidence → Hypothesis → Experiment → Measurement → Analysis → Decision → Learning
rendered live through Mission Workspace + Scientific Trace with three explicit
epistemic registers (observed facts / derived claims / causal interpretations).

### Journey E — cross-platform distribution (backend authority exists)
Asset → rights → lineage → transformation → destination capability → publish →
measurement. Backend + HTTP surface merged; remaining work is operational
visibility/actionability (UX-006) plus the §12 defect fix.

### Journey F — zero human budget (to be proven explicitly)
Mission → human treatment unavailable → non-human treatment remains → allocation
continues → operator replans. A missing creator or rejected UGC offer must not
kill the mission.

### Journey G — genuine human blocker (to be proven explicitly)
Required rights/policy approval → blocked_pending_human_action → notification →
human action → mission resumes. Never manufacture blockers.

## 5. UX work orders

### UX-005 — Connections Center
Social, product/source, store and notification connections show: provider,
connected account, capability, required permissions/scopes, permission health,
expiration/revocation, provider limitations, and a clear connect/reconnect action.
Backed by the MKT-055 surface (authorize-start/complete/refresh/reauthorize/
disconnect/external-revocation + grants + events).

### UX-006 — Content + Rights
Show and operate: source asset → provenance evidence → rights state → ingredient
lineage → transformations → destination capability → publication state.
Read visibility is not executable capability — make the workflow operational.

### UX-007 — Platform Health
Show descriptive state, evidence basis, confidence/uncertainty and the next
compliant action. MKT-066 is the interpretation authority.

### UX-008 — Human Treatment
Show UGC/creator/review as an optional experiment arm alongside non-human
treatments. Human absence is never an implicit failure.

### UX-009 — Commerce Mission
Market → Candidate → Test → Viability → Listing → Traffic → Order → Margin →
Learning. Not an integration/settings screen.

### UX-010 — Progressive Disclosure
Goals, Playbooks, Deployments, Workflows, Evidence, Experiments, Decisions,
Learning, Jobs and Apps remain drill-down operational objects.

### UX-011 — ShareNet-inspired visual direction
Warm neutral/light surfaces, graphite type, restrained teal/green healthy state,
amber warning/degraded, red only for true failure/block, generous whitespace,
minimal chrome, progressive disclosure, subtle transitions, strong focus/contrast.
Avoid: dense dashboard-first UI, gradients, glassmorphism, jargon-heavy onboarding,
diagnostic panels dominating the primary workflow.

### UX-012 — Browser proof
Every new journey uses real APIs and real authorization and passes 390×844 +
1280×800; zero horizontal overflow; zero page/browser errors; no raw JSON; honest
loading/empty/error/blocked states; one clear next action. A successful TypeScript
build is not UI evidence; a successful API test is not user-journey evidence.

## 6. Three-worker ownership (successor model)

### Worker A — Social capability plane
Owns MKT-060, MKT-061, provider capability matrices, OAuth/scopes, account
restrictions, rate/quota semantics, provider doubles, provider conformance,
provider E2E, adapter regression across MKT-057..061 once distribution/mission UX
consumes their capability data. Must NOT own the shared console composition root.

### Worker B — Intelligence / growth backend
Owns MKT-066 Platform Health / anomaly detection, MKT-070 Product Marketing
Mission Planner, MKT-072 Commerce Discovery Mission, MKT-073 Social-to-Commerce
Attribution, hardening of MKT-062/065/067 where integration exposes defects.
Owns backend/domain contracts and APIs. MUST fix the §12 MKT-065 dispatch defect
before final autonomy acceptance (Wave 0 scope).

### Worker C — Console / user journeys / deployment proof
Owns UX-005..UX-012, MKT-074 Growth Autopilot Console, final browser journey
orchestration, deployment verification/promotion. Worker C is the ONLY worker
allowed to own the shared frontend composition root.

## 7. Execution waves (successor model)

### Wave 0 — immediate (all three concurrent)
- Worker A: MKT-060 TikTok; then MKT-061 X.
- Worker B: MKT-066; audit/fix the MKT-065 §12 defect; prepare MKT-070/072/073.
- Worker C: refresh console against actual current main; UX-005 Connections
  Center; expose the existing research authority through a real discoverable UX
  path (the research surface must not remain hidden merely because the backend
  was implemented first); begin UX-006.

### Wave 1 — capability integration
- Worker A: finish remaining adapters; complete 057..061 capability regression.
- Worker B: finish MKT-066; integrate research + health + experimentation into
  product-marketing planning; finish MKT-070; continue MKT-072.
- Worker C: UX-006, UX-007, UX-008, MKT-074 foundations; browser verification
  for every completed journey.

### Wave 2 — commerce + mission completion
- Worker A: regression against all distribution destinations.
- Worker B: MKT-072, MKT-073, attribution evidence and limitations, zero-human
  treatment validation.
- Worker C: UX-009, UX-010, UX-011, MKT-074 completion.

### Wave 3 — final proof
Tech Lead + Worker C: UX-012, MKT-075, complete journey battery, production
parity, deployment promotion, rollback validation, final
source/test/runtime/browser audit. Optional MKT-076..078 must not delay this wave.

## 8. Current dependency graph

v1.5
└── ✅ MKT-001..052
    ├── ✅ MKT-053 → ✅ MKT-054
    ├── ✅ MKT-055 → ✅ MKT-056 → ✅ MKT-057 ✅ MKT-058 ✅ MKT-059
    │                              ├── ☐ MKT-060
    │                              └── ☐ MKT-061
    ├── ✅ MKT-062 (core; full acceptance held until 057..061 verify)
    ├── ✅ MKT-063 → ✅ MKT-064 → ✅ MKT-065 (defect §12 pending)
    ├── ☐ MKT-066 (deps: adapters + MKT-014/016)
    ├── ✅ MKT-067
    ├── ✅ MKT-068
    ├── ✅ MKT-069 → ☐ MKT-070 (deps: 053+062+066+067+069)
    └── ✅ MKT-071 → ☐ MKT-072 (deps: 053+062+063+065+067+071)
                   └── ☐ MKT-073 (deps: 065+071+072+052)

                              ↓

                       ☐ MKT-074 (v1.6 capability set + verified console APIs)
                              ↓
                       ☐ MKT-075 (054+065+067+068+070+072+073+074)

Optional side branch (never blocks the core graph):
☐ MKT-076 → ☐ MKT-077 → ☐ MKT-078

UX overlays this graph; it never creates duplicate authorities.

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

For every journey record SHA, tenant/persona, route, capability prerequisites,
authority chain, observed result, screenshots/logs/API evidence, errors and next action.

## 10. Deployment gate

Production promotion requires, in order:
1. current main deployed;
2. migrations verified;
3. real environment/provider configuration verified;
4. browser smoke passes against production;
5. production SHA recorded;
6. rollback candidate recorded;
7. production runtime errors checked;
8. major journeys pass on production, not only local/dev.

Do not assume Neon, R2, Upstash, Apify or another provider is production
infrastructure without environment/account evidence. Do not call the project
production-complete while production is behind main.

DEP-006..DEP-015 remain the deployment work orders (process contract, database,
object store, worker runtime, transient coordination, research provider,
budget/quota, promotion pipeline, retention, baseline re-acceptance). Vercel
Hobby Cron is not a suitable autonomous scheduler; the controller uses the
external worker/runtime path.

## 11. Verification contracts

Every accepted Work Item requires agreement between:
source + schema/migrations + architecture checks + unit tests + integration
tests + runtime behavior + relevant browser journey + deployment behavior.

No worker may claim completion from documentation alone, PR descriptions,
test-count claims without rerunning, mocks replacing provider boundaries,
seeded fixtures without exercising real authorities, or UI screenshots without
live API calls.

Every UI worker uses the agent-browser verification flow after starting the dev
server: 1280×800 and 390×844, real APIs, real auth/authorization, meaningful
rendered content, no raw JSON, no console/page errors, no horizontal overflow,
correct loading/empty/blocked states, explicit next action, screenshots + journey
record.

## 12. MKT-065 defect gate (before MKT-075)

The station verification exposed a dispatch-route 422/audit-array defect: the
HTTP dispatch route's audit emit passes the `outcomes` array where the append
guard requires a scalar; the module commits the dispatch durably BEFORE the
audit emit, so the plan is recorded dispatched despite the 422. The repo's
integration tests dispatch through the module API, so the HTTP-route defect is
unexercised.

Required final behavior:
dispatch failure → publication state remains truthful; audit failure cannot
create false success; retry/idempotency remains deterministic.

Then rerun: distribution unit tests, architecture tests, integration tests, a
real browser dispatch journey, and failure-path browser/runtime evidence.
Owner: Worker B (Wave 0). This defect must not survive into MKT-075.

## 13. Final acceptance

v1.6 is complete only when MKT-057..075 are source/test/runtime verified;
UX-001..012 pass browser proof; all five social adapters expose honest documented
capabilities; Connections are operationally discoverable; Research is
user-discoverable and executable; Content/Rights/Transformation/Distribution form
one visible workflow; Platform Health is observable and compliant; Product
Marketing is end-to-end; Commerce Discovery is end-to-end; Attribution is explicit
about evidence versus causality; Autopilot is visible as the controller, not
another execution engine; zero-human-budget autonomy is proven; genuine
human-required blockers are proven; worker restart/recovery is proven; production
deployment matches accepted main; rollback is demonstrated.

Optional MKT-076..078 may remain incomplete without preventing v1.6 completion.

## 14. Orchestrator operating rule

The primary responsibility is not maximizing merged PR count. The responsibility
is to make this statement objectively true:

> A new user can state a growth/business outcome, understand what MOS needs from
> them, execute the resulting mission across the capabilities that actually
> exist, see the evidence behind decisions, understand blockers and uncertainty,
> and watch the system learn and replan without discovering that the
> "completed" architecture is only backend scaffolding.

When source, tests, browser behavior, runtime behavior and deployment state
disagree, stop and investigate the disagreement rather than choosing whichever
artifact reports completion. The repository is the authority.
