# MarketingOS

Status: v1.6 implementation + v1.7 Marketing Engineering Lab implementation in progress
Current Architecture: v1.7 layered on v1.6; manifest revision 1.7.1 after CR-007
Repository: payswapdotorg/MOS

MarketingOS is a provider-independent, evidence-driven, multi-tenant Growth and Marketing Operating System.

## Repository source of truth

The repository is the unique implementation source of truth.

Read:
1. `AGENTS.md`
2. `spec/architecture-v1.7-marketing-lab.md`
3. `spec/content-studio-contract-v1.0.md`
4. `spec/architecture-lock-v1.7.md`
5. `spec/frozen-manifest-v1.7.json`
6. `spec/effective-backlog-v1.7.md`
7. `spec/module-dependency-matrix-v1.7.md`
8. `docs/handoff/IMPLEMENTATION-STATE.md`
9. `docs/handoff/EXECUTION-PLAN.md`
10. `docs/handoff/WORKER-CONTRACT.md`

Actual source/tests/migrations/runtime/browser/deployment evidence outrank summaries.

## Verified implementation state recorded in repo

v1.6 verified items include the completed MKT/UX foundation through the latest state record, including:
✅ MKT-053..059
✅ MKT-060
✅ MKT-061
✅ MKT-062..070
✅ MKT-071
✅ UX-001..008

v1.7:
✅ LAB-001 Lab Contracts + Run Model
✅ LAB-002 Reference-First Niche Corpus
✅ LAB-011 Agent Body Runtime Contract

All remaining items are pending unless `docs/handoff/IMPLEMENTATION-STATE.md` proves otherwise.

## Marketing Engineering Lab

Core loop:

niche + platform + goal
→ reference-first corpus
→ multimodal features + Idea Graph
→ transform/idea search
→ Social World Model
→ sequential strategy learning
→ Agent Body / Organization search
→ capability acquisition
→ production program
→ Content Studio / automated production
→ Lab evaluation/treatment
→ real MOS experiment
→ measurement
→ calibration
→ repeat.

The strategy space includes:
- no-op/repost;
- transform;
- recombination/mutation;
- generated content;
- human+AI production.

Production delay and human participation are explicit economic variables.

## Content Studio

Content Studio is the MOS-owned AI+Human production runtime for both:
- standalone user creation;
- Lab-initiated production.

Initial formats:
- reaction;
- audio podcast;
- video podcast.

It supports intent or explicit scripts/questions, adaptive interviewers, one-person podcasts, multi-account sessions and arbitrary compatible organizations.

Raw human recordings are intermediate production artifacts and can be passed through the selected organization for editing/composition before finalization.

## Architecture boundaries

- v1.6 Mission, Policy, Rights, Content Asset, Distribution, Integration, Workflow, Execution, Evidence, Experiment and AI runtime authorities remain singular.
- Lab and Studio never publish directly.
- Lab Run is not a real Experiment.
- Studio Session is not a Workflow/Execution engine.
- Transform Pawns use existing Agent Bodies.
- LLM routing remains under `/ai-runtime`.
- Public URLs do not grant media rights.
- Human contribution does not silently block autonomous paths.
- Expected value of delay may cause wait/substitute/retry/abandon.
- Every production treatment creates a new immutable linked artifact version.
- CopilotKit, OpenMuse and Code-OSS are excluded architectural dependencies.

## Canonical architecture change record

`spec/change-request-007-content-production-studio.md` records the approved CR-007 amendment; it is an audit trail, not a competing architecture authority.
