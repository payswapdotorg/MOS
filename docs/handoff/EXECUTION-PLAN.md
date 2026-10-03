# MOS — Unified Tech Lead Execution Plan — v1.6 + v1.7

Architecture: v1.6 FROZEN + v1.7 Marketing Engineering Lab FROZEN (manifest revision 1.7.1 / CR-007)
Maximum concurrent workers: 3
Canonical execution authority: this file
Architecture authority: `spec/architecture-v1.7-marketing-lab.md`

## 1. Repository truth and takeover rule

The repository is the unique source of truth for implementation.

At takeover the Tech Lead MUST:
1. inspect current `main` HEAD;
2. read the canonical architecture, lock, manifest, backlog and dependency matrix;
3. inspect actual source/migrations/tests for every claimed completed Work Item;
4. reconcile `IMPLEMENTATION-STATE.md` against source/test/runtime evidence;
5. derive the next executable wave from the frozen dependency graph, not from stale worker plans.

Historical SHAs in this document are evidence anchors only; they are not a substitute for verifying current main.

Canonical read order:
AGENTS.md
→ change-request-007-content-production-studio.md
→ architecture-v1.6 + lock + manifest
→ architecture-v1.7-marketing-lab.md
→ content-studio-contract-v1.0.md
→ architecture-lock-v1.7.md
→ frozen-manifest-v1.7.json
→ effective-backlog-v1.7.md
→ module-dependency-matrix-v1.7.md
→ IMPLEMENTATION-STATE.md
→ WORKER-CONTRACT.md
→ this file
→ FINAL-TECH-LEAD-HANDOFF-V1.7-LAB.md
→ exact Work Item.

Specification text never counts as implementation evidence by itself.

## 2. Current verified implementation state

The latest repository state records these v1.7 items as delivered:
- ✅ LAB-001
- ✅ LAB-002
- ✅ LAB-011
- ✅ STUDIO-001

Current v1.6 state, UX state and exact verification are maintained in `docs/handoff/IMPLEMENTATION-STATE.md`. Do not copy status into this file manually when it changes; update the state file from evidence during each harvest.

New CR-007 work is specification-only until source/tests/runtime evidence is present.

## 3. v1.7 system shape

niche + platform + goal
→ reference-first corpus
→ multimodal features + Idea Graph
→ idea/transform search
→ Social World Model + Time Machine
→ strategy learning/search
→ Agent Body / Organization search
→ capability discovery/acquisition
→ production program
→ Content Studio / automated production
→ Lab output evaluation/treatment
→ robust simulation
→ bounded real MOS experiment
→ measurement
→ calibration
→ repeat.

The production program is part of the candidate strategy. It can include:
- no-op/repost;
- transforms;
- composed/discovered transforms;
- Transform Pawn Agents;
- Studio format/configuration;
- organization;
- human tasks;
- capability acquisitions;
- budget;
- delay/stopping decisions.

## 4. Worker graph

### Worker A — Social + Data/World Models
Owns:
MKT-060, MKT-061,
LAB-002..010,
LAB-015,
LAB-019.

Scope:
provider adapters, corpus, feature/idea representation, simulator/world-model/time-machine/learning, transform definitions/discovery.

### Worker B — Backend + Agent Engineering
Owns:
MKT-065 defect,
MKT-066, MKT-070, MKT-072, MKT-073,
LAB-011/012/013/020/021/024.

Scope:
Agent Body, organization search, capabilities, Transform Pawns, human task packages, bottleneck economics, v1.6 backend tail.

### Worker C — Content Studio + UX + Real-World Integration
Owns:
STUDIO-001..014,
LAB-014/016/017/018/022/023,
MKT-074/075,
UX-005..012.

Scope:
Studio runtime/format/session/artifact contracts, Lab↔Studio bridge, Studio output evaluation/treatment, social automation product surface, browser/production proof.

Only Worker C owns shared console composition.
Only TL owns frozen manifest/architecture/central schema/migration/registration collision resolution.

## 5. Current executable waves

Completed prerequisites already on main are not re-run as work items.

### Wave N — immediately executable

Worker A:
- LAB-003
- LAB-004
- LAB-005

Worker B:
- LAB-012
- LAB-013
- MKT-072
- MKT-073

Worker C:
- STUDIO-001
- STUDIO-002
- STUDIO-003
- STUDIO-007
- STUDIO-009
- UX-009
- UX-010
- MKT-074 foundation

LAB-019 begins once LAB-003/004 are both satisfied.

### Wave N+1 — production and transform execution

Worker A:
- LAB-006
- LAB-007
- LAB-008
- LAB-019
- LAB-009 preparation

Worker B:
- LAB-020
- LAB-021
- LAB-024
- LAB-012 hardening
- LAB-013 hardening

Worker C:
- STUDIO-004
- STUDIO-005
- STUDIO-006
- STUDIO-008
- STUDIO-010
- STUDIO-011
- STUDIO-012
- LAB-022 skeleton
- UX-009/010 completion

### Wave N+2 — learning and Lab/Studio feedback

Worker A:
- LAB-009
- LAB-010
- LAB-015

Worker B:
- capability/organization regression
- remaining v1.6 backend tail
- LAB-024 regression

Worker C:
- STUDIO-013
- STUDIO-014
- LAB-022
- LAB-023
- LAB-014
- MKT-074 completion
- UX-011

### Wave N+3 — productization and proof

Worker A:
- full simulator/world-model regression
- transform discovery benchmark support

Worker B:
- MKT-072/073 regression
- Agent Organization / Transform Pawn / capability regression

Worker C:
- LAB-016
- LAB-017
- LAB-018
- MKT-075
- UX-012
- final browser/deployment proof

## 6. Studio production protocol

Lab-issued Production Request:
strategy + source/idea + transform graph + Studio format + organization version + capability requirements + human tasks + acceptance criteria + budget + delay/stopping policy
→ Studio
→ production session
→ raw/intermediate artifacts
→ selected organization
→ transformations/composition
→ Artifact Package
→ Lab evaluation.

The Studio can also be entered directly by a user:
intent/script → format → organization → interview/capture → processing → review → final output.

Studio does not publish directly.

## 7. Human participation protocol

Human involvement is a variable in the strategy search.

The Lab can create a Human Production Task Package and route it to:
- project owner;
- authorized collaborator;
- Arena/provider.

A human branch records expected value, delay and alternatives.

Lab decisions:
wait | retry | substitute | switch organization | switch transform | reduce scope | proceed without human | abandon.

Abandonment is auditable and is not a failure of the system when the expected value of waiting is negative.

## 8. Studio review/treatment protocol

The Lab may:
- accept output;
- reject quality/strategy;
- request structured treatment;
- require human action;
- select alternate organization;
- select alternate transform;
- abandon branch.

Every retry/treatment is a new immutable linked artifact version.

## 9. Proof requirements

The complete v1.7 proof must demonstrate:
- broad reference-first corpus;
- Idea Graph;
- no-op/repost search;
- at least one learned transform;
- at least one Transform Pawn;
- Time Machine historical/delayed/counterfactual behavior;
- world-model ensemble/OOD/robustness;
- organization search;
- interchangeable model occupancy through /ai-runtime;
- capability gap + governed acquisition path;
- one-person podcast with non-human interviewer representation;
- multi-account podcast;
- reaction content with raw human capture entering an organization;
- Lab rejection → treatment → accepted/new output;
- production branch abandoned because of delay economics;
- zero-human path;
- real bounded platform experiment;
- real measurement;
- calibration;
- second improved strategy/run;
- hard rejection of prohibited strategies.

## 10. Verification discipline

A Work Item becomes green only when evidence agrees across:
source;
tests;
database/migrations where applicable;
runtime/API;
browser for presentation changes;
deployment for production gates.

Workers must disclose environmental limitations, doubles, unsupported provider operations and flaky infrastructure rather than converting them into green claims.

## 11. Central-file conflict rule

Workers do not concurrently edit:
- frozen architecture/manifest/lock;
- effective backlog/dependency matrix;
- central application module maps;
- composition root;
- migration-count/checker central assertions.

They implement module-local seams and give TL the exact promotion/re-pin notes.

## 12. Final acceptance

v1.6 and v1.7 are separate but layered acceptance programs.

v1.7 is complete only after the full Lab → production → real-world → calibration loop is demonstrated, including the Content Studio paths above.

Production promotion is a separate gate from repository completion.
