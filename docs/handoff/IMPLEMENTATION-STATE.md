# MOS Implementation State — v1.6 + v1.7

Repository: payswapdotorg/MOS
v1.6: FROZEN implementation layer
v1.7: Marketing Engineering Lab implementation IN PROGRESS — LAB-001 + LAB-002 + LAB-011 delivered
Maximum active workers: 3

## Main baseline

10f51781f8d198cd07c19259f722c1aeab7ac8e6

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
☐ MKT-072 ☐ MKT-073 ☐ MKT-074 ☐ MKT-075
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
☐ UX-007..UX-012

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
☐ LAB-003..LAB-010, LAB-012..LAB-018

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