# Effective Implementation Backlog — MOS v1.7 Marketing Engineering Lab

Status: FROZEN
Architecture: 1.7
Maximum concurrent implementation workers: 3

v1.6 MKT-053..078 remains the prior architecture layer. v1.7 LAB items add the Marketing Engineering Lab.

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

## B. Social world

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
Acceptance: logging-policy disclosure, support/OOD diagnostics, baselines against retrieval-only and generation-only strategies.

### LAB-010 — Sequential Strategy RL
Dependencies: LAB-009.
Train sequential marketing policies in the simulator.
Acceptance: reward versioning, bounded action space, cost-aware reward, hard policy/rights rejection, reproducible training/evaluation.

## C. Agent engineering

### LAB-011 — Agent Body Runtime Contract
Dependencies: LAB-001, existing /ai-runtime.
Implement model-agnostic Agent Body execution with tools, memory, permissions, budgets and evaluation hooks.
Acceptance: at least two interchangeable model backends through the existing AI runtime; no second model router.

### LAB-012 — Agent Organization Search
Dependencies: LAB-011, LAB-010.
Search role sets, topology, delegation, memory sharing, critic structure, tools and model assignments.
Acceptance: single-agent baseline, hand-designed baseline, multiple generated organizations, reproducible scoring.

### LAB-013 — Capability Engine + Arena Adapter
Dependencies: LAB-001, LAB-011.
Formalize capability gaps, requests, providers, quality evaluation and verified capability versions.
Acceptance: missing capability can be discovered, requested, fulfilled, verified and inserted without creating a second marketplace authority; Arena remains behind an Integration/provider contract.

## D. Reality bridge

### LAB-014 — Lab → MOS Experiment Bridge
Dependencies: LAB-010, LAB-012, MKT-053, MKT-065, MKT-067.
Convert a selected lab candidate into a bounded real Growth Mission experiment.
Acceptance: execution only through existing MOS authorities; no direct provider publishing from Lab.

### LAB-015 — Online Calibration Loop
Dependencies: LAB-014, LAB-008.
Compare simulated predictions with real outcomes and generate append-only calibration versions.
Acceptance: prediction error, confidence updates, regime tracking, rollback to prior model versions.

### LAB-016 — Robust Marketing Benchmark
Dependencies: LAB-008, LAB-009, LAB-010, LAB-012, LAB-015.
Create benchmark suites across seeds, model ensembles, temporal windows and strategy baselines.
Acceptance: reproducible leaderboard without overall vendor/strategy ranking; deployment gate uses explicit thresholds and failure conditions.

### LAB-017 — Marketing Strategy Compiler / Social Automation Product Surface
Dependencies: LAB-012, LAB-013, LAB-014, MKT-074.
Expose niche + platform + goal → recommended strategy, organization, capabilities and experiment plan through MOS UX.
Acceptance: user need not understand RL, agent topology or simulator internals; every recommendation links to evidence/model/run context.

### LAB-018 — Closed-Loop Marketing Engineering Proof
Dependencies: LAB-015, LAB-016, LAB-017, MKT-075.
Prove:
reference corpus → idea search → simulation → organization search → capability acquisition when needed → real experiment → measurement → calibration → next strategy.
Acceptance: complete social automation proof on at least one platform+niche+goal, with zero-human path, bounded real-world execution and simulator update evidence.

## Parallelization map

Wave 0:
- Worker A: LAB-001, LAB-002
- Worker B: LAB-001 contract review + LAB-011
- Worker C: LAB-001 integration contracts + LAB-014 skeleton and v1.6 UX integration prep

Wave 1:
- Worker A: LAB-003, LAB-004, LAB-005
- Worker B: LAB-011 hardening, LAB-013
- Worker C: LAB-006 integration fixtures, UX/console foundations, LAB-014

Wave 2:
- Worker A: LAB-006, LAB-007, LAB-008
- Worker B: LAB-012
- Worker C: LAB-009 integration + LAB-017 UX

Wave 3:
- Worker A: LAB-009, LAB-010, LAB-015 calibration data contracts
- Worker B: LAB-012 hardening + model/organization benchmark support
- Worker C: LAB-014, LAB-017, v1.6 UX completion

Wave 4:
- Worker A: LAB-015
- Worker B: LAB-013/012 regression and capability benchmarks
- Worker C: LAB-016, LAB-018, browser/production proof

## Non-blocking v1.6 tail

The remaining v1.6 items remain on the critical path for v1.6:
MKT-060, MKT-061, MKT-066, MKT-070, MKT-072, MKT-073, MKT-074, MKT-075, UX-005..UX-012.

v1.7 Lab work may proceed in parallel only where dependencies are already satisfied. It must not bypass unfinished v1.6 authorities.
