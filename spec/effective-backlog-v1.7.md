# Effective Implementation Backlog — MOS v1.7 Marketing Engineering Lab

Status: FROZEN
Architecture: 1.7 (manifest revision 1.7.1 / CR-007)
Maximum concurrent implementation workers: 3
Canonical execution authority: `docs/handoff/EXECUTION-PLAN.md`

v1.6 MKT-053..078 remains the prior architecture layer. v1.7 LAB and STUDIO items add the Marketing Engineering Lab and its AI+Human Content Studio.

Implementation status is recorded only in `docs/handoff/IMPLEMENTATION-STATE.md`; this backlog is the frozen work definition and dependency contract.

## A. Lab foundation

### LAB-001 — Lab Contracts and Run Model
Dependencies: none beyond v1.6 architecture.
Build the Lab Scenario, Lab Run, Strategy Candidate, Organization Candidate, Capability Candidate and Calibration Record contracts.
Acceptance: versioned contracts, tenant isolation, deterministic seeds, lifecycle states, no shadowing of v1.6 authorities.

### LAB-002 — Reference-First Niche Corpus
Dependencies: LAB-001, MKT-062, MKT-056.
Build provider-neutral niche corpus ingestion using content references and metadata snapshots.
Acceptance: reference-first storage, provider-specific acquisition policy, provenance, deduplication, observation timestamps, coverage reporting, no unauthorized media retention.

### LAB-003 — Multimodal Content Feature Bundle
Dependencies: LAB-002.
Extract versioned text/audio/visual/metadata representations, with optional ephemeral media access.
Acceptance: reproducible feature identity/versioning, source linkage, batch extraction, failure states, tenant isolation.

### LAB-004 — Idea Graph
Dependencies: LAB-003.
Map content into idea/problem/claim/hook/narrative/visual/audio/packaging/CTA primitives.
Acceptance: observed vs derived separation, retrieval, clustering, novelty, recombination and lineage.

## B. Social world and learning

### LAB-005 — Social Simulator Kernel
Dependencies: LAB-001, LAB-003.
Build configurable platform state, candidate generation, exposure/ranking abstraction and content interaction loop.
Acceptance: deterministic seeded replay plus stochastic runs; no invented hidden provider state.

### LAB-006 — User/Creator/Competition Dynamics
Dependencies: LAB-005.
Model user preferences, sessions, fatigue, creator competition, trends and temporal effects.
Acceptance: calibrated response interfaces, reproducible seeds, measurable drift/regime parameters.

### LAB-007 — Time Machine
Dependencies: LAB-005, LAB-006, MKT-062.
Historical replay, delayed-information lag and counterfactual branching.
Acceptance: no future-information leakage; factual history separated from counterfactual model output.

### LAB-008 — World Model Ensemble
Dependencies: LAB-005, LAB-006, LAB-007.
Train/version multiple response/world models and aggregate uncertainty.
Acceptance: ensemble agreement metrics, OOD score, confidence, reproducible model versions.

### LAB-009 — Offline Evaluation / Contextual Bandit
Dependencies: LAB-008, MKT-067.
Implement historical/off-policy candidate evaluation and contextual bandit baselines.
Acceptance: logging-policy disclosure, support/OOD diagnostics, retrieval-only/generation-only/retrieval+transform/retrieval+recombination baselines.

### LAB-010 — Sequential Strategy RL
Dependencies: LAB-009.
Train sequential marketing policies in the simulator.
Acceptance: reward versioning, bounded action space, cost-aware reward, hard policy/rights rejection, reproducible training/evaluation.

## C. Agent engineering

### LAB-011 — Agent Body Runtime Contract
Dependencies: LAB-001, existing /ai-runtime.
Implement model-agnostic Agent Body execution with tools, memory, permissions, budgets and evaluation hooks.
Acceptance: interchangeable model occupancy through existing AI runtime; no second model router.

### LAB-012 — Agent Organization Search
Dependencies: LAB-011, LAB-010.
Search role sets, topology, delegation, memory sharing, critic structure, tools and model assignments.
Acceptance: single-agent baseline, hand-designed baseline, multiple generated organizations, reproducible scoring.

### LAB-013 — Capability Engine + Arena Adapter
Dependencies: LAB-001, LAB-011.
Formalize capability gaps, requests, providers, quality evaluation and verified capability versions.
Acceptance: missing capability can be discovered, requested, fulfilled, verified and inserted without creating a second marketplace authority; Arena remains behind Integration/provider contracts.

## D. Transform discovery and production search

### LAB-019 — Transform Definitions + Transform Graph
Dependencies: LAB-003, LAB-004.
Build the versioned transform contract and searchable transform graph, including first-class no-op/repost.
Acceptance:
- no-op/repost is a valid candidate;
- atomic and composed transforms are representable;
- transform inputs/outputs/parameters/lineage/rights/cost/latency/evaluator are explicit;
- discovered transforms are versioned and provenance-linked;
- clip/reframe/reaction/podcast/stylization and generated-content strategies can be represented without hard-coding the list as exhaustive.

### LAB-020 — Transform Pawn Agents
Dependencies: LAB-011, LAB-019.
Implement specialized pawn-agent bodies/instances that execute transform operations using the existing Agent Body runtime.
Acceptance: at least clipping, reaction composition, podcast/interviewer support, editing/composition and quality-critic roles can be executed through explicit contracts; raw human captures are accepted as intermediate inputs.

### LAB-021 — Human Production Task Packages
Dependencies: LAB-019, LAB-020, LAB-013.
Formalize a human contribution as a versioned production task package.
Acceptance:
- script/question set and intent can be represented;
- source/brief/capture/output requirements are explicit;
- consent/rights requirements are explicit;
- project owner, authorized collaborator and Arena/provider fulfillment are supported;
- task contains deadline, estimated value of waiting and acceptable substitutions;
- human output enters production as a raw/intermediate artifact.

### LAB-024 — Production Bottleneck + Expected Delay Economics
Dependencies: LAB-010, LAB-013, LAB-021.
Make production delay a decision variable.
Acceptance:
- branch records expected incremental value, wait, delay cost, acquisition cost, success probability and quality impact;
- Lab can wait, retry, substitute, switch organization, switch transform, reduce scope or abandon;
- abandonment is auditable and learnable;
- human waiting cannot block an acceptable autonomous path.

## E. Content Studio

### STUDIO-001 — Content Studio Runtime
Dependencies: LAB-011, v1.6 Content Asset/Rights boundaries.
Build the MOS-owned AI+Human production session runtime used standalone or by the Lab.
Acceptance: tenant-scoped versioned production sessions, asynchronous/durable processing, guarded lifecycle, no publishing/experiment authority.

### STUDIO-002 — Pluggable Format Framework
Dependencies: STUDIO-001.
Build the format contract and registry.
Acceptance: formats declare input, participant, capture, interviewer, organization, output, provenance and evaluation contracts; new formats do not require another Studio runtime.

### STUDIO-003 — Intent → Script / Question Graph
Dependencies: STUDIO-001, LAB-011.
Support user-provided scripts/questions and intent-driven generation.
Acceptance: versioned scripts/question graphs, explicit human-review option, adaptive branching hooks, provenance of generated material.

### STUDIO-004 — Adaptive Interviewer
Dependencies: STUDIO-003, LAB-020.
Support one-person podcast interviewer representations.
Acceptance: voice, voice+text, avatar, prerecorded, generated and hybrid interviewer modes; adaptive follow-ups; provenance and human/synthetic distinction preserved.

### STUDIO-005 — Single-Person Podcast Production
Dependencies: STUDIO-004, STUDIO-007, STUDIO-008.
Deliver audio/video podcast production for one participant.
Acceptance: intent or questions → interview → capture → organization treatment → final Artifact Package; re-recording and review paths work.

### STUDIO-006 — Multi-Account Production Sessions
Dependencies: STUDIO-001, STUDIO-007.
Allow multiple authorized MOS accounts/devices to participate in one production.
Acceptance: explicit invitations/grants, per-participant credential/identity boundary, synchronized or timestamped contributions, consent/withdrawal handling and shared production output rights metadata.

### STUDIO-007 — Audio/Video Capture
Dependencies: STUDIO-001.
Implement approved audio/video capture and durable artifact persistence through platform storage/access ports.
Acceptance: raw takes, alternates and participant/source provenance are preserved; no long-running synchronous HTTP processing.

### STUDIO-008 — AI Editing / Composition
Dependencies: STUDIO-007, LAB-020.
Apply selected Transform Pawn organizations to raw and intermediate media.
Acceptance: reaction layouts (PIP, source-first, alternating or learned equivalent), clipping, composition, captions and finalization are contract-driven and lineage-preserving.

### STUDIO-009 — Organization Loader / Compatibility Contract
Dependencies: STUDIO-001, LAB-011.
Allow Studio to load any explicitly submitted compatible organization.
Acceptance: Lab-discovered and user-supplied organization versions are accepted through the same contract; compatibility failure is explicit; Studio never silently swaps requested organization.

### STUDIO-010 — Studio Artifact Package / Provenance
Dependencies: STUDIO-005, STUDIO-006, STUDIO-008, STUDIO-009.
Return a complete immutable/versioned Artifact Package.
Acceptance: raw/final media references, transcript, Q/A graph, participant contributions, edit/transform graph, provenance/consent, quality metadata, costs/durations and lineage are preserved.

### STUDIO-011 — Reaction Format
Dependencies: STUDIO-002, STUDIO-007, STUDIO-008.
Implement the first production format for reaction content.
Acceptance: source + raw human reaction can flow through a submitted organization and produce learned/configurable composition output.

### STUDIO-012 — Podcast Format
Dependencies: STUDIO-002, STUDIO-003, STUDIO-004.
Implement common podcast format contract shared by audio/video variants.
Acceptance: single-person and multi-person flows use the same format contract; one-person interviewer representations remain pluggable.

### STUDIO-013 — Audio Podcast Variant
Dependencies: STUDIO-005, STUDIO-012.
Implement audio-only podcast finalization.
Acceptance: recorded answers + interviewer + organization treatment produce a final audio Artifact Package with chapters/transcript where available.

### STUDIO-014 — Video Podcast Variant
Dependencies: STUDIO-005, STUDIO-012.
Implement video podcast finalization.
Acceptance: video capture + interviewer + organization treatment produce a final video Artifact Package with transcript/captions where available.

## F. Lab ↔ Studio bridge and iterative treatment

### LAB-022 — Lab → Studio Production Bridge
Dependencies: LAB-019, LAB-020, LAB-021, LAB-024, STUDIO-009, STUDIO-010, STUDIO-011, STUDIO-012.
Send a discovered production program into the Studio.
Acceptance: request includes strategy, transform graph, Studio format, organization version, human tasks, acceptance criteria, budget and stopping policy; Studio returns auditable production artifacts, status, cost, delay and provenance.

### LAB-023 — Studio Output Evaluation / Treatment Loop
Dependencies: LAB-008, LAB-009, LAB-022.
Allow Lab to govern acceptance of Studio outputs and request better treatment.
Acceptance:
- accept/reject is structured;
- retry may require no human, human action, alternate transform or alternate organization;
- every treatment produces an immutable linked output;
- rejected output remains auditable;
- Studio policy/rights rejection remains distinct from Lab quality/strategy rejection.

### LAB-014 — Lab → MOS Experiment Bridge
Dependencies: LAB-010, LAB-012, LAB-022, LAB-023, MKT-053, MKT-065, MKT-067.
Convert a selected candidate into a bounded real Growth Mission experiment.
Acceptance: execution only through existing MOS authorities; no direct provider publishing from Lab/Studio.

### LAB-015 — Online Calibration Loop
Dependencies: LAB-014, LAB-008.
Compare simulated predictions with real outcomes and generate append-only calibration versions.
Acceptance: prediction error, confidence updates, regime tracking, rollback to prior model versions.

### LAB-016 — Robust Marketing Benchmark
Dependencies: LAB-008, LAB-009, LAB-010, LAB-012, LAB-015, LAB-019, LAB-020, LAB-023.
Benchmark ideas, transforms, organizations and production programs across seeds/models/temporal windows.
Acceptance: reproducible benchmark with explicit thresholds, uncertainty, OOD, cost/delay and rights/policy feasibility.

### LAB-017 — Marketing Strategy Compiler / Social Automation Surface
Dependencies: LAB-012, LAB-013, LAB-014, LAB-022, LAB-023, MKT-074.
Expose niche + platform + goal → discovered strategy + production program + organization + capabilities + Studio request through MOS UX.
Acceptance: user need not understand RL/agent internals; recommendation carries evidence/model/run context and production requirements.

### LAB-018 — Closed-Loop Marketing Engineering Proof
Dependencies: LAB-015, LAB-016, LAB-017, MKT-075, STUDIO-011, STUDIO-013, STUDIO-014.
Prove:
reference corpus → idea search → transform search → simulation → organization search → capability acquisition when needed → Studio production → Lab evaluation/treatment → real experiment → measurement → calibration → next strategy.
Acceptance: complete social automation proof with:
- no-op/repost branch;
- at least one transformed branch;
- human contribution branch;
- branch abandoned due to delay economics;
- Studio-produced reaction;
- Studio-produced audio or video podcast;
- accepted and rejected Studio outputs;
- organization substitution;
- zero-human path;
- measurable simulator update.

## Parallelization map

### Already integrated prerequisites
- LAB-001 ✅
- LAB-002 ✅
- LAB-011 ✅

### Next executable wave
Worker A:
- LAB-003
- LAB-004
- LAB-005

Worker B:
- LAB-012
- LAB-013
- LAB-020 once LAB-019 is ready
- LAB-021
- LAB-024
- MKT-073 where v1.6 prerequisites are satisfied

Worker C:
- STUDIO-001
- STUDIO-002
- STUDIO-003
- STUDIO-007
- STUDIO-009
- UX-009
- UX-010
- MKT-074 foundations

### Wave after simulator foundations
Worker A:
- LAB-006
- LAB-007
- LAB-008
- LAB-019
- LAB-015 preparation

Worker B:
- LAB-012 continuation/hardening
- LAB-013
- LAB-020
- LAB-021
- LAB-024

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

### Learning/bridge wave
Worker A:
- LAB-009
- LAB-010
- LAB-015

Worker B:
- MKT-072
- MKT-073
- LAB-013/020/024 regressions

Worker C:
- STUDIO-013
- STUDIO-014
- LAB-022
- LAB-023
- LAB-014
- MKT-074
- UX-011

### Final proof wave
Worker A:
- simulator/world-model full regression
- LAB-016 evaluation support

Worker B:
- capability/org regression
- delay-economics regression
- remaining v1.6 backend tail

Worker C:
- LAB-016
- LAB-017
- LAB-018
- MKT-075
- UX-012
- production/browser proof

Tech Lead:
- owns frozen-spec promotion/manifest updates;
- resolves shared schema/migration/composition conflicts;
- performs source/test/runtime/browser/deployment acceptance;
- prevents two workers from editing the same central files concurrently.

## Non-negotiable cross-lane ownership

Worker A owns corpus/simulation/world-model and Transform Definition/Discovery code.

Worker B owns Agent Body/Organization/Capability/Pawn/Human Task/Bottleneck domain code.

Worker C owns Content Studio, Lab↔Studio integration, console composition, real-world proof and browser acceptance.

Only Worker C owns the shared frontend composition root.
Only TL resolves cross-worker central schema/migration/composition collisions.

No downstream work may mark an upstream item complete by inference.