# MOS Implementation State — v1.6 + v1.7

Repository: payswapdotorg/MOS
v1.6: FROZEN implementation layer
v1.7: Marketing Engineering Lab + Content Studio implementation IN PROGRESS — LAB-001 + LAB-002 + LAB-003 + LAB-004 + LAB-005 + LAB-011 + LAB-013 + STUDIO-001 + STUDIO-002 + STUDIO-003 + MKT-072 + UX-010 delivered; CR-007 Content Studio architecture frozen
Maximum active workers: 3

## Historical architecture base

10f51781f8d198cd07c19259f722c1aeab7ac8e6

This SHA is the historical base of the v1.7 architecture branch, not the current main HEAD. Always verify current main at takeover.

## v1.6

✅ MKT-001..052
✅ MKT-053 ✅ MKT-054 ✅ MKT-055 ✅ MKT-056
✅ MKT-057 ✅ MKT-058 ✅ MKT-059 ✅ MKT-062
✅ MKT-063 ✅ MKT-064 ✅ MKT-065 ✅ MKT-067
✅ MKT-068 ✅ MKT-069 ✅ MKT-071
✅ UX-001 ✅ UX-002 ✅ UX-003 ✅ UX-004

Remaining:
✅ MKT-060 (Wave 0 harvest, PR #64) ✅ MKT-061 (Wave 1 harvest, PR #67)
✅ MKT-066 (Wave 0 harvest, PR #64) ✅ MKT-070 (Wave 1 harvest, PR #68 + spec promotion)
✅ MKT-072 ☐ MKT-073 ☐ MKT-074 ☐ MKT-075
✅ UX-005 (Wave 0 harvest, PR #64)
✅ UX-007 Platform Health Console Surface (Wave 1 harvest, PR #66 —
   worker delivery 40c4c4cf: console/** only, HealthTab + AccountHealthCard
   + health-atoms with the frozen NINE states, 5 hooks, Connections→Health
   cross-link, 28-piece evidence pack; station battery: typecheck 0 / lint 0
   / arch:check 0 (50 modules, 612 files) / unit EXIT=0 / architecture
   EXIT=0 / integration EXIT=0 / console gates EXIT=0; TL follow-up: the
   UX-003 mission HealthSection stale "planned surface" note updated)
✅ UX-006 Content/Rights Operational Surface (Wave 1 harvest, PR #65 —
   worker delivery 54846a3: console/** only, ContentTab + five sections,
   44-piece both-viewport journey evidence pack + JOURNEY-RECORD.md;
   station battery re-run: typecheck 0 / lint 0 / arch:check 0
   (50 modules) / unit 1255 / architecture 692 / integration re-run EXIT=0
   after one environmental postgres-termination flake / console tsc 0 +
   lint 0 + build OK)
☐ UX-009, UX-011..UX-012
✅ UX-008 Human Treatment Console Surface (external worker delivery, PR #71 —
   worker delivery d53b0ff: console/** only, TreatmentsTab +
   HumanTreatmentExperimentCard + treatments-atoms with the frozen
   presentation vocabularies, session-store/client-workspace wiring, the
   never-blocks guarantee made VISIBLE, the ONE honest human blocker
   (blocked_pending_human_action with the genuine rights-gate reason),
   13-screenshot browser journey evidence on the real embedded-PG + real-
   API stack; station battery on tl/harvest-ux008: typecheck 0 / lint 0 /
   arch:check 0 / unit 1307 / architecture 713 / integration 1212+1
   load-timing flake isolated-green / console gates EXIT=0; the C-lane
   queued duplicate chat deleted BEFORE generation — zero wasted
   execution, the LAB-002 precedent)


Optional:
☐ MKT-076..078

* MKT-065's HTTP dispatch/audit defect was fixed in the Wave 0 harvest
  (PR #64, delivery commit b5331f0): the route audit emit serializes
  outcomes as the deterministic comma-joined string and the route failure
  path is covered by integration tests
  (tests/integration/cross-platform-distribution-dispatch-route.test.ts).

## v1.7 LAB

✅ LAB-001 — Lab Contracts and Run Model (TL delivery, direct to main):
the `/lab` module (src/modules/lab/ — public.ts + internal/validation.ts
+ lab-store.ts + lab-module.ts), migration `059_lab_contracts.sql` (six
artifact tables + the run event tail + the two evaluation tails with the
CHECK-fenced vocabularies, guarded immutable/append-only triggers, the
frozen run transition-pair fence and the cross-client scope fences), the
composition-root + ApplicationModules registration, the spec/architecture.md
§6 registration paragraph (module 49), the arch-check frozen-set/canonical-
migration-list/sibling-re-pin updates, 13 unit tests + 10 integration tests
(lab-contracts). Verification: tsc 0 / lint 0 / arch:check 50 modules 610
files 0 violations / unit 1255 / architecture 692 / integration incl. the
new battery. Runbook: docs/runbooks/LAB-001.md. The /lab row allows NO
cross-module dependency (platform ports only) — LAB-002..018 consume the
contracts BY REFERENCE.

All remaining implementation items pending:
☐ LAB-003
☐ LAB-004
☐ LAB-005
☐ LAB-006
☐ LAB-007
☐ LAB-008
☐ LAB-009
☐ LAB-010
☐ LAB-012
☐ LAB-013
☐ LAB-014
☐ LAB-015
☐ LAB-016
☐ LAB-017
☐ LAB-018
☐ LAB-019
☐ LAB-020
☐ LAB-021
☐ LAB-022
☐ LAB-023
☐ LAB-024
☐ STUDIO-002..STUDIO-014

✅ LAB-002 — Reference-First Niche Corpus (Worker-A delivery, PR #69
merged as 5534c70 + the TL spec promotion): the `/lab-corpus` module
(src/modules/lab-corpus/ — public.ts + internal/validation.ts +
corpus-store.ts + corpus-module.ts), migration `061_lab_corpus.sql`
(lab_corpus_versions / lab_corpus_references / lab_corpus_observations
with CHECK-fenced vocabularies, the UNIQUE (client, provider,
provider_content_id) dedup fence with re-ingestion as an appended
observation, guard + no-delete + scope-consistency triggers, NO binary
column anywhere), the composition-root + ApplicationModules registration,
13 unit tests + 13 integration tests (lab-corpus, real embedded
PostgreSQL). Worker verification (delivery commit 5f9876b): tsc 0 /
lint clean / arch:check 52 modules 631 files 0 violations / unit 1294 /
architecture 706 / integration 1196. TL spec promotion (the /lab
registration precedent): spec/architecture.md §6 line + the
/lab-corpus registration paragraph; the checker provision RETIRED
(back to the single /apps entry); spec-parsed set 50 → 51; count
assertions re-pinned (arch-check / apps-boundary / cross-platform-
distribution / developer-portal / product-marketing boundary tests).

✅ LAB-011 — Agent Body Runtime Contract (external Worker delivery,
PR #70 merged as f8d2fb0 + the TL spec promotion): the `/lab-agent-body`
module (src/modules/lab-agent-body/ — public.ts 779 + internal/
validation.ts 537 + agent-body-store.ts 675 + agent-instance.ts 521 +
agent-body-module.ts 332), migration `063_lab_agent_body.sql` (062
reserved for the parallel MKT-072 worker — four own tables with
CHECK-fenced closed vocabularies, the guard/append-only triggers — body
identity immutable, no-delete version history, runs born running with
the single terminal advance + terminal-freeze, events append-only
outright, memory upsert-only current state; NO binary column, NO
authority table, NO /ai-runtime table), the composition-root wiring
with the REAL aiRuntime instance as the structural port (getModel +
appendModelObservation only — no second model router: zero routing
vocabulary, zero cross-module imports), 13 unit + 17 integration tests
(the ACCEPTANCE: two interchangeable model backends through the real
/ai-runtime registry — same body + same input, one runtime path,
contract-identical outputs with different content; the full 8-label
failure taxonomy; the tool loop; memory persistence + capacity
refusal; tenant isolation; DB backstops) + 7 boundary tests, 19 sibling
re-pins. TL station harvest (tl/harvest-lab011 2b103cb): typecheck 0 /
lint 0 / arch:check 0 violations (53 enforced — 51 spec-parsed + /apps
+ the disclosed provision) / unit 1307/1307 / architecture 713/713 /
integration 1213/1213 exit 0 (the worker-disclosed environmental
postgres flake did not reproduce) / console tsc+lint+build green. TL
spec promotion (the /lab registration precedent): spec/architecture.md
§6 line + the /lab-agent-body registration paragraph; the checker
provision RETIRED (back to the single /apps entry); spec-parsed set
51 → 52; count assertions re-pinned (arch-check / apps-boundary /
product-marketing / developer-portal boundary tests; enforced total
stays 53 — 52 spec-parsed + the single /apps provision).

Architecture/coordination artifacts are frozen and present:
- spec/architecture-v1.7-marketing-lab.md
- spec/architecture-lock-v1.7.md
- spec/frozen-manifest-v1.7.json
- spec/effective-backlog-v1.7.md
- spec/module-dependency-matrix-v1.7.md
- docs/handoff/FINAL-TECH-LEAD-HANDOFF-V1.7-LAB.md
- spec/change-request-007-content-production-studio.md
- spec/content-studio-contract-v1.0.md

## v1.7 CR-007 frozen production layer

Architecture amendment is now incorporated into the repo:
- no-op/repost is a first-class strategy candidate;
- Transform Definitions/Graphs can be atomic, composed or newly discovered;
- Transform Pawn Agents use the existing Agent Body runtime;
- human production is explicit, versioned and economically bounded by expected value of delay;
- Content Studio is standalone and Lab-invoked;
- initial formats: reaction, audio podcast, video podcast;
- single-person podcasts support pluggable AI/synthetic/prerecorded interviewer representations;
- multi-account sessions preserve separate participant authorization, identity, consent and provenance;
- Studio can load any compatible submitted organization;
- raw human media can be treated by the loaded organization;
- Lab can accept/reject Studio outputs and issue immutable treatment/retry requests;
- organization/transform substitution and branch abandonment are explicit;
- Studio does not become a publishing, workflow, rights/policy, experiment, evidence, model-router or marketplace authority.

✅ STUDIO-001 — Content Studio Runtime (external Worker delivery, PR #73
merged as 79eb931 + the TL spec promotion): the `/content-studio` module
(src/modules/content-studio/ — public.ts 904 + internal/
content-studio-module.ts 1010 + content-studio-store.ts 812 +
validation.ts 638), migration `064_content_studio_runtime.sql` (the
module's own tables, CHECK-fenced closed vocabularies, append/immutable
guard triggers — applied cleanly as migration 57 of the chain; 062
remains reserved for the parallel MKT-072 worker), the pluggable format
seam (ContentStudioFormatDeclaration; initial reaction / audio-podcast /
video-podcast as minimal declared DATA; pluggability proven by unit test
with a custom format), organization loading through the NARROW
/lab-agent-body structural port (versioned declarations citing OPAQUE
body-version references, compatibility resolution READ-ONLY over the
REAL instance — the disclosed off-matrix wrapper precedent), guarded
lifecycle with the frozen transition table + explicit failure listing
(never silent replacement), composition-root wiring + application.ts
entry, zero cross-module imports inside the module (the strictest EMPTY
dependency-matrix allowance; structural ports only). 20 unit + 7
boundary/architecture + 16 integration tests. Station battery on
tl/harvest-studio001: tsc/lint/arch:check clean / unit 1327 /
architecture 720 / integration 1227 + 2 load-timing flakes isolated-green
27/27 (the UX-008 flake family — MKT-056 teardown race, unrelated to the
delivery). TL spec promotion (the /lab registration precedent):
spec/architecture.md §6 line + the /content-studio registration
paragraph; the checker provision RETIRED (back to the single /apps
entry); spec-parsed set 52 → 53; count assertions re-pinned (arch-check
+ content-studio-boundary AC-4 updated to the promoted state).

✅ LAB-003 — Multimodal Content Feature Bundle (external Worker delivery,
PR #74 merged + the TL station integration (delivery commit d4bcf56)): the `/lab-features` module
(src/modules/lab-features/ — public.ts + internal/validation.ts +
feature-store.ts + feature-module.ts), migration `065_lab_features.sql`
(after the merged STUDIO-001 064; 062 remains reserved for the parallel
MKT-072 worker), the versioned feature-set definition (27 §5 feature
keys, per-modality grouping, encoder/model identity, explicit
unavailable states), reproducible deterministic bundle identity
(sha256 over canonical JSON of reference identity + feature-set version
+ extractor identity + input digest), source linkage by citation (never
a join), the optional ephemeral media-access grant (available_permitted
+ reference_gated ONLY; fail-closed otherwise; in-memory handle; no
binary column), batch extraction (1-100, closed outcome vocabulary,
SQL-computed summary counts), the /lab-corpus feature_bundle_version
advance left as /lab-corpus's own guarded seam. Worker battery (its
worklog): tsc 0 / lint 0 / arch:check 0 / unit / architecture /
integration green on the pushed tree. TL station battery on
tl/harvest-lab003 (the merged tree with STUDIO-001): typecheck 0 /
lint 0 / unit 1340 / architecture 728 / integration 1241/1241 clean
(zero flakes this run). The granted worker spec
append (the MKT-066 platform-health precedent — NO checker provision;
the provision mechanism is structurally for spec-pending modules only):
spec/architecture.md §6 line + the /lab-features registration paragraph.

✅ MKT-072 — Commerce Discovery Mission (external Worker delivery, PR #75
merged + the TL station integration): the `/commerce-discovery` module,
migration `062_commerce_discovery.sql` (the pre-assigned mid-chain slot —
the merged-tree truth: 061 → 062 → 063 → 064 → 065), the granted worker
spec registration (the MKT-070 promoted-spec precedent — §6 line, the
registration paragraph, the live matrix row VERBATIM:
/commerce-discovery ──→ /growth-missions, /product-intelligence,
/content-intelligence, /experiment-analysis, /integrations,
/platform-health). Discovery missions ride the /growth-missions spine
READ-ONLY (family gate 'commerce_discovery' — never a second mission
authority); the deterministic selection core (cd-plan-v1); candidates
with FK-anchored provenance; demand tests that ARE /experiments records
through the disclosed off-matrix structural port (the MKT-070 /research
precedent); the learning loop from REAL commerce order/metric
observations (never simulated); guardrail evaluations vs declared
bounded-spend budgets (breach → honest guardrail_blocked with an
explicit resolution path); NO listing/mutation verb, NO order/inventory
authority (lock rules 32/33). Station battery on tl/harvest-mkt072 (the
triple-merged tree): typecheck 0 / lint 0 / unit 1354 / architecture
742 / integration 1246+2 load-timing flakes isolated-green 27/27 (the
MKT-056 teardown race — same family as the STUDIO-001 battery). 22-file multi-worker conflict
resolution to the merged truth (55 spec-parsed / 56 enforced with the
single /apps provision).

✅ UX-010 — Progressive-Disclosure Console Hardening (external Worker
delivery, PR #76 merged): console/** ONLY (59 files, +1736/-951).
Every surface's first view is now the calm stack of LIVE section
summary rows (SurfaceSection, collapsed by default, loading/empty/
error summaries included); records, forms, diagnostics and route
SourceLines render only on expand; composition + route disclosures
demoted to a collapsed SourcesDisclosure footer. One primary action
per screen state (Connect a channel / Start a research session); the
Avoid list fixed (no route/authority/MKT-xxx names on first screens;
no mono internal identifiers as primary UI). Zero new authorities,
zero route changes — composition only. Real browser journey evidence
(console/evidence/UX-010/: JOURNEY-RECORD.md + screenshots, desktop
1280×800 + mobile 390×844) on the REAL stack: embedded PostgreSQL 18,
the repo's own API entrypoint as a detached subprocess, real sign-up
through the console orchestrator — no seeded data. Station battery on
tl/harvest-ux010: repo tsc 0 / lint 0 / unit 1354 / architecture 742 /
integration 1245+3 MKT-056 teardown-race flakes isolated-green 35/35;
console tsc 0 / lint 0 / build EXIT=0. The worker's turn-died-mid-
delivery saga: brief re-delivered after the un-started-turn diagnosis;
completion achieved via continuation nudges (the mid-turn-death
recovery pattern).

✅ LAB-013 — Capability Engine + Arena Adapter (external Worker
delivery, PR #77 merged, main e53c22e): the /lab-capabilities module
(src/modules/lab-capabilities/** + migration 067_lab_capabilities.sql,
1440 lines, NINE §17 flow-stage tables — gaps, contracts,
value_estimates, requests, results, verifications, versions,
simulations, real_tests — with CHECK-fenced closed vocabularies, the
actor split on every stage record, guarded lifecycles, append-only/
no-delete triggers, scope-consistency triggers, the
unverified-never-presented citation trigger, tenant-only + same-module
FK anchors). The full §16 declared field set as one-level-schema DATA;
the LAB-011 draft → active → retired lifecycle discipline with
append-only version corrections and immutable chain identity. NO
SECOND MARKETPLACE AUTHORITY (the core acceptance, structural): zero
marketplace vocabulary in the public surface, zero provider-selection
logic (caller-declared provider-target data), the Arena dispatch
through the DECLARED NARROW STRUCTURAL PORT (listRegisteredAdapters +
executeMutation ONLY — the LAB-011 /ai-runtime port precedent)
satisfied structurally by the REAL /integrations instance at the
composition root, so the fail-closed policy/credential/capability
gates stay in /integrations. Human-plane boundary: opaque citations
(never re-modeled); human availability never a prerequisite.
Contract-rights discipline: granted-rights as recorded data, null =
nothing granted. Verification discipline: the declared quality
evaluator runs against the delivered artifact; a capability version
may cite ONLY a passing verification (DB citation-trigger fence) —
verified state is linked evidence, never an asserted boolean. Granted
spec §6 registration append (the /lab-capabilities module list line +
the registration paragraph; the empty-allowance /lab family posture,
no matrix row). 29 new tests (11 unit + 9 architecture boundary + 9
integration) + the LAB-013 runbook (docs/runbooks/LAB-013.md) + the
sibling test re-pins. Station battery on tl/harvest-lab013 (clean
merge onto eec1eee, zero conflicts): typecheck 0 / lint 0 / unit
1365/1365 / architecture 751/751 / integration 1257 tests (1255 pass
+ 2 known MKT-056 teardown-race flakes, isolated re-run 27/27 green).
The harvest proceeded on branch-push + workspace-worklog evidence per
the mid-turn-death doctrine (the worker's chat transcript content
never persisted server-side after its final turn died; the delivery
branch faf7614 and the final-report-style worklog disclosures are the
attestation).

✅ STUDIO-002 — Pluggable Format Framework (external Worker
delivery, PR #78 merged, main ca885e1): the /content-studio
extension (public.ts +614 — the nine §2 declaration surfaces with
their closed vocabularies + the format-framework contract identity
'content-studio-format-v1' + the versioned FORMAT REGISTRY surface
registerFormat/activateFormat/retireFormat/getFormat/listFormats —
pluggability without runtime/composition change), migration
068_studio_format_framework.sql (489 lines, 36 fences — born-draft +
lifecycle guard + activation capability-consistency + chain-scope +
no-delete triggers, CHECK-fenced closed vocabularies over the declared
jsonb through IMMUTABLE SQL helpers, the format-capability link
records as OPAQUE references — NO /lab-capabilities table referenced),
the three initial formats promoted to full declarations over the
STUDIO-001 runtime (additive — the runtime version remains
STUDIO-001's), module/store/validation extensions, the 161-line
runbook, +792 test lines (integration 510 / unit 282). Station
battery on tl/harvest-studio002 (the double-appended tree with
LAB-013's 067): typecheck 0 / lint 0 / unit 1367 / architecture 753
(after the stacked-shift re-pin resolution — both LAB-013 and
STUDIO-002 made textually-identical +1 tail re-pins that git
auto-merged; the merged tree needs +2; 366 position pins
re-resolved across 20 sibling boundary files) / integration
1263/1263 zero flakes. The worker's mid-turn-death recovery:
nudge sent after the near-end death (worklog survived at 5600B with
the 20/20 fence battery done); the resumed turn completed
verification, pushed studio/002-worker-delivery (2409cac) and
posted the completion report.

✅ LAB-004 — Idea Graph (external Worker delivery, PR #79 merged,
main c9ab7be): the /lab-ideas module — the v1.7 §6 conceptual-
primitive LAYER over the cited /lab-features feature bundles: the
CLOSED, versioned primitive vocabulary (contract identity
'lab-ideas-contract-v1' + idea-set version 'lab-ideaset-v1', the ten
§6 primitive kinds, the closed 8-relation edge vocabulary, the closed
4-value origin-class vocabulary); THE OBSERVED-DERIVED-GENERATED-
COMBINED SEPARATION structural at the DB (origin class fenced to the
creation path; a decomposition of one cited bundle produces
observed_source nodes ONLY with the deterministic identity digest as
the idempotence fence; derive/recombine/mutate/analogy/invert/
fill_gap operations produce the derived/generated/combined nodes each
carrying recorded lineage + creation-time novelty); deterministic
bounded cursor-paginated SQL retrieval with the MANDATORY explicit
origin-class filter; versioned deterministic clustering (frozen
'lab-idea-clustering-v1', kind-partitioned connected components at
Jaccard>=0.5); frozen novelty version ('lab-idea-novelty-v1' — Jaccard
max vs observed same-kind, never against generated); lineage bounded
at 64 steps; the replaceable decomposer + generator ports with honest
first-party implementations (structural only; open-ended generation
ships the honest pending refusal). Migration 066 (7 tables, the
066-MID-CHAIN merge: 065→066→067→068), 13 unit + 8 architecture + 17
integration tests, the runbook, the registration seams. 27-file
multi-worker merge resolution (both /lab-ideas AND /lab-capabilities
registrations — 57 spec-parsed / 58 enforced; 22 sibling files
normalized against the true 62-migration list; count + adjacency
ladder). Station battery: typecheck 0 / lint 0 / unit 1380 /
architecture 759 / integration 1280 (1278 + 2 lab-agent-body
latency-deadline timing flakes isolated-green 17/17). Recovery saga:
turn died twice; the EXECUTE NOW nudge ran the implementation; the
push token lost to worker context compaction was re-supplied by the
TL (used once, never stored).

✅ LAB-005 — Social Simulator Kernel (external Worker delivery, PR #80
merged, main f3eb7ef): the /lab-simulator module — the v1.7 §8/§9
configurable platform world model: the WORLD-MODEL CONFIGURATION
records (versioned, immutable once instantiated: the declared
population size/distributions, the preference/topic space shape, the
fatigue parameters, the ranking exposure curve parameters, the
trend/temporal parameters — every knob DECLARED DATA with its
version, never ambient globals, CHECK-fenced closed vocabularies);
DETERMINISTIC SEEDED REPLAY (the core acceptance, structural): the
simulator core is a PURE function of (seed, configuration, the
interaction history) — the same inputs always produce the same
trajectory; the RNG is the declared seeded generator (identity +
version recorded); the reproducibility test proves a replay run
reproduces the original trajectory step-for-step; STOCHASTIC
ENSEMBLES for uncertainty estimation (the §13 discipline: sampled
seeds/configurations over the space, agreement/disagreement recorded
across the ensemble — a single run is never ground truth); the
INTERACTION LOOP (candidate generation from opaque-cited content →
the configurable exposure/ranking abstraction → the stochastic
stateful user-interaction sampling (view/skip/engage/share with
fatigue/preference dynamics) → the observable feedback per step,
bounded by the run's declared step budget); the OBSERVABLE/HIDDEN
SPLIT (the core acceptance): only observable state is exposed; hidden
provider moderation/ranking internals are NEVER materialized as
factual claims — every ranking-behavior parameter is a DECLARED
world-model assumption, labeled as such. Migration 071 (071_
lab_simulator.sql — extends the 068 tail; 069/070 held by the
in-flight MKT-073/STUDIO-003 workers), 14 unit + 8 architecture + 9
integration tests, the runbook, the registration seams (57→58
spec-parsed / 58→59 enforced). Station battery (the first
zero-conflict merge — the worker based on the fully-reconciled main
87ee744): typecheck 0 / lint 0 / unit 1394/1394 / architecture
767/767 / integration 1289/1289 ZERO flakes.

✅ STUDIO-003 — Intent → Script / Question Graph (external Worker
delivery, PR #81 merged, main e515894): the /content-studio
intent-to-script extension — the §8 record surfaces over the
STUDIO-001 runtime + the STUDIO-002 framework: the four request paths
(a supplied complete script → the versioned script record; a supplied
podcast question list → the versioned declared question/branch graph;
intent-only / intent+source → the generation path with the selected
organization version generating the script/question graph); the
generated records carry FULL PROVENANCE (the generator identity —
organization version + model/capability references as opaque recorded
data — and the intent lineage; no generated material is ever
presented without its provenance record); the HUMAN-REVIEW option
(the closed review vocabulary pending/approved/rejected/superseded
with the reviewer actor and the honest autonomous/human split; the
format-requires-explicit-user-confirmation flag honored STRUCTURALLY
— a production request against a format that requires confirmation
can cite ONLY an approved generated script/graph); the
ADAPTIVE-BRANCHING hooks (the declared question/branch graph — nodes
are questions with closed modality hints, edges are declared branch
conditions; the chosen-edge/conversation-graph append surface
preserving the resulting conversation graph as data — the STUDIO-004
interviewer's structural home). Migration 070 (070_studio_script_
question_graph.sql — slots between 068 and 071; 069 held by the
in-flight MKT-073 worker), +821 integration / +213 unit test lines,
the runbook. Station battery (the second consecutive zero-conflict
merge — based on the fully-reconciled main 3d5de78): typecheck 0 /
lint 0 / unit 1403/1403 / architecture 773/773 / integration
1298/1298 ZERO flakes. Recovery saga: the original session hit the
un-started-turn plague (nudges staged in DOM but never committed
server-side); voided + re-dispatched fresh per the waiting-costs-hours
doctrine — the r2 session delivered in ONE pass.

New frozen Work Items:
☐ LAB-019 Transform Definitions + Transform Graph
☐ LAB-020 Transform Pawn Agents
☐ LAB-021 Human Production Task Packages
☐ LAB-024 Production Bottleneck + Expected Delay Economics
☐ STUDIO-002..014 Content Studio
☐ LAB-022 Lab → Studio Production Bridge
☐ LAB-023 Studio Output Evaluation / Treatment Loop

## Frozen v1.7 decisions

- reference-first niche corpus;
- provider/rights-gated media access;
- multimodal feature bundle and Idea Graph;
- Social World Model;
- historical/delayed/counterfactual Time Machine;
- staged learning ladder;
- world-model ensemble/OOD/robustness;
- Agent Body + interchangeable LLM occupancy through /ai-runtime;
- searchable Agent Organization;
- explicit capability contracts;
- Arena as external provider through Integration;
- bounded Lab→MOS real experiment bridge;
- simulator calibration;
- transform discovery and no-op/repost;
- Transform Pawn Agents;
- Content Studio and Lab↔Studio production bridge;
- human production task packages and expected-delay economics;
- Studio output evaluation/treatment;
- business-outcome-first reward;
- hard rights/policy/anti-gaming gates;
- no CopilotKit/OpenMuse/Code-OSS dependency.

## Verification baseline

Latest main baseline recorded in the September 22 reconciliation:
Post-Wave-0-harvest baseline (PR #64, station-re-run on merge commit):
- tsc 0
- lint clean
- arch:check 0 violations (49 modules, 606 files)
- unit 1242/1242
- architecture 692/692
- serialized integration 1144/1144
- console: tsc 0, lint 0, build OK

These numbers do not imply LAB implementation is complete.

## Production

Observed production at the previous audit:
dpl_5MfdkKM631cTvDTw4V1NYNq2xyU3
commit 0cc7d51b0af5a4ee203f75157978e73fc9024fdf

Production promotion is separate from repository completion.

## Source-of-truth rule

Source + tests + migrations + runtime + browser + deployment evidence outrank status labels, worker summaries, screenshots and PR descriptions.