# MOS — Unified Tech Lead Execution Plan — v1.6 + v1.7

Architecture: v1.6 FROZEN + v1.7 Marketing Engineering Lab FROZEN
Maximum concurrent workers: 3
Canonical execution authority: this file

## 1. Repository truth

v1.7 architecture branch base: 10f51781f8d198cd07c19259f722c1aeab7ac8e6.
The architecture branch contains only specification/governance/handoff artifacts. No LAB Work Item is implemented yet.
Latest pre-branch source/test evidence is preserved in Git history and existing runbooks.

Green = objectively verified implementation on main. Specification files are not implementation evidence.

## 2. v1.6 state

✅ MKT-001..052
✅ MKT-053 ✅ MKT-054 ✅ MKT-055 ✅ MKT-056
✅ MKT-057 ✅ MKT-058 ✅ MKT-059 ✅ MKT-062
✅ MKT-063 ✅ MKT-064 ✅ MKT-065* ✅ MKT-067
✅ MKT-068 ✅ MKT-069 ✅ MKT-071
✅ UX-001 ✅ UX-002 ✅ UX-003 ✅ UX-004

✅ MKT-060 TikTok (Wave 0 harvest, PR #64)
✅ MKT-061 X (Wave 1 harvest, PR #67 — the fifth MKT-056 concrete adapter; unit 1267/arch 692/integ 1170+2-flake→21/21-isolated; migration-free; runbook + doubles + 17/17 conformance)
✅ MKT-066 Platform Health (Wave 0 harvest, PR #64)
✅ MKT-070 Product Marketing Mission Planner (Wave 1 harvest, PR #68 — /product-marketing + migration 060 + the spec promotion at harvest: §6 registration, live-matrix row, checker provision retired; unit 1281/arch 706/integ 1182+1-flake→3/3-isolated)
☐ MKT-072 Commerce Discovery
☐ MKT-073 Social-to-Commerce Attribution
☐ MKT-074 Growth Autopilot Console
☐ MKT-075 v1.6 End-to-End Autonomy Proof
✅ UX-005 (Wave 0 harvest, PR #64)
✅ UX-006 Content/Rights Operational Surface (Wave 1 harvest, PR #65)
✅ UX-007 Platform Health Console Surface (Wave 1 harvest, PR #66)
✅ UX-008 Human Treatment Console Surface (external worker delivery → TL station harvest PR #71 → main 352c68f; console-only delta, the never-blocks guarantee made VISIBLE + the ONE honest human blocker; the C-lane queued duplicate deleted BEFORE generation)
☐ UX-009..UX-012

Optional:
☐ MKT-076..078

* MKT-065's HTTP audit/dispatch defect is FIXED (Wave 0 harvest, PR #64):
  scalar outcomes serialization + route-level integration coverage.

## 3. v1.7 frozen Lab

✅ LAB-001 Contracts and Run Model (TL delivery: /lab module + migration 059 + registration; unblocks LAB-002/005/011/013/014 for Wave 2)
✅ LAB-002 Reference-First Niche Corpus (Worker-A delivery PR #69 → main 5534c70 + TL spec promotion; unblocks LAB-003)
☐ LAB-003 Multimodal Content Feature Bundle
☐ LAB-004 Idea Graph
☐ LAB-005 Social Simulator Kernel
☐ LAB-006 User/Creator/Competition Dynamics
☐ LAB-007 Time Machine
☐ LAB-008 World Model Ensemble
☐ LAB-009 Offline Evaluation / Contextual Bandit
☐ LAB-010 Sequential Strategy RL
✅ LAB-011 Agent Body Runtime Contract (external Worker delivery branch lab/011-worker-delivery → TL station harvest PR #70 → main f8d2fb0 + TL spec promotion; unblocks LAB-012/LAB-013)
☐ LAB-012 Agent Organization Search
☐ LAB-013 Capability Engine + Arena Adapter
☐ LAB-014 Lab → MOS Experiment Bridge
☐ LAB-015 Online Calibration Loop
☐ LAB-016 Robust Marketing Benchmark
☐ LAB-017 Marketing Strategy Compiler / Social Automation Surface
☐ LAB-018 Closed-Loop Marketing Engineering Proof

## 4. Frozen Lab architecture

niche + platform + goal
→ reference-first corpus
→ multimodal representation + Idea Graph
→ Social World Model
→ offline/counterfactual evaluation
→ sequential strategy learning
→ Agent Body / Organization search
→ capability acquisition when required
→ robust simulation
→ bounded real MOS experiment
→ real measurement
→ simulator calibration
→ repeat

Key invariants:
- corpus completeness is measured, never assumed;
- media is reference-first and provider/rights gated;
- historical and counterfactual outputs are distinct;
- time-machine lag prevents future leakage;
- business objective outranks vanity metrics;
- world-model uncertainty/OOD/robustness are first class;
- Agent Body uses interchangeable LLM occupants through /ai-runtime;
- Arena is a provider, not a new MOS marketplace;
- real posting goes through existing v1.6 authorities;
- prohibited strategies are invalid regardless of simulated reward.

## 5. Three workers

### Worker A — Social + Data/World Models
MKT-060, MKT-061, LAB-002..010, LAB-015.

### Worker B — Backend + Agent Engineering
MKT-066, MKT-070, MKT-072, MKT-073, MKT-065 defect fix, LAB-011..013.

### Worker C — UX + Integration + Proof
UX-005..012, MKT-074, MKT-075, LAB-014, LAB-016..018.

Only Worker C changes the shared frontend composition root.
Only TL resolves central schema/composition collisions.

## 6. Execution waves

### Wave 0 — parallel start
A:
- MKT-060
- LAB-002

B:
- MKT-065 HTTP defect
- MKT-066
- LAB-011 contract/runtime skeleton

C:
- UX-005 Connections Center
- Research discoverability UX
- LAB-014 integration contract skeleton

TL:
- merge architecture branch
- verify exact source baseline
- protect ownership boundaries

### Wave 1
A:
- MKT-061
- LAB-003
- LAB-004
- LAB-005

B:
- MKT-066 completion
- LAB-011 hardening
- LAB-013

C:
- UX-006
- UX-007
- UX-008
- MKT-074 foundations
- LAB-014

### Wave 2
A:
- LAB-006
- LAB-007
- LAB-008

B:
- MKT-070
- MKT-072
- LAB-012

C:
- UX-009
- UX-010
- LAB-017 initial product surface

### Wave 3
A:
- LAB-009
- LAB-010

B:
- MKT-073
- LAB-012 hardening
- capability/org evaluation support

C:
- MKT-074 completion
- LAB-014 real bridge
- LAB-016 benchmark
- UX-011

### Wave 4
A:
- LAB-015
- full simulator/model regression

B:
- MKT-066/070/072/073 regression
- LAB-013 capability regression
- agent organization regression

C:
- LAB-017
- LAB-018
- UX-012
- MKT-075
- production proof

## 7. Mandatory Lab benchmark

Every benchmark includes:
- generalist single-agent baseline;
- hand-designed multi-agent baseline;
- generation-only ideas;
- retrieval-only ideas;
- retrieval + transformation;
- retrieval + recombination/mutation;
- simulator-trained policy.

Evaluate:
- declared objective;
- cost;
- latency;
- uncertainty;
- ensemble robustness;
- seed robustness;
- OOD;
- rights/policy feasibility;
- capability dependencies.

Never treat simulator leaderboard ordering as real-world truth.

## 8. Mandatory Time Machine proof

Run:
1. historical replay;
2. delayed-information run with user-selected lag;
3. counterfactual branches.

At simulated time T, delayed mode exposes only information available by T-lag.
Counterfactual results show model version and uncertainty.

## 9. Mandatory real-world loop

Selected candidate:
Lab simulation
→ existing Growth Mission
→ existing Policy/Rights/Assets/Distribution/Integration/Workflow/Execution
→ real platform
→ Evidence/Metrics/Experiment
→ prediction error
→ calibration
→ next Lab run.

Lab never calls the provider directly.

## 10. Capability acquisition proof

When simulation detects an unavailable capability:
- formalize capability contract;
- estimate value;
- request through Arena/provider Integration;
- verify returned result;
- version capability;
- re-run simulation;
- optionally send through real experiment bridge.

No Arena dependency may block the zero-human path.

## 11. Media/corpus policy

Default durable corpus:
reference + metadata + provenance + feature bundle + observation history.

Temporary media only through provider/rights-gated acquisition.

Record coverage, freshness, duplication, accessibility and extraction success.

## 12. v1.6 known defect

MKT-065 HTTP dispatch can return audit 422 after durable dispatch state is recorded.
Fix this before MKT-075 and cover the actual HTTP route failure path with integration and browser/runtime evidence.

## 13. Browser acceptance

For every UI journey:
- real API/auth;
- 390x844;
- 1280x800;
- no raw JSON;
- no horizontal overflow;
- no page/browser errors;
- truthful loading/empty/error/blocked states;
- explicit next action.

Use the repository's agent-browser verification skill after starting a dev server.

## 14. Documentation/update rule

Do not create a second execution authority.
Update this file and IMPLEMENTATION-STATE when accepted milestones change.
The frozen architecture files define architecture; this file defines orchestration.

## 15. Final acceptance

v1.6 requires its existing end-to-end and production gates.

v1.7 requires the complete:
niche + platform + goal
→ corpus
→ idea search
→ simulator
→ strategy learning
→ agent organization search
→ capability acquisition where needed
→ robust selection
→ real bounded experiment
→ measurement
→ calibration
→ improved next run.

Source + tests + runtime + browser + deployment evidence must agree.
