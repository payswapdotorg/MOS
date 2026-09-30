# Architecture Change Request 007 — Content Production, Transform Discovery and Content Studio

Status: APPROVED / INCORPORATED INTO FROZEN v1.7
Date: 2026-09-30
Scope: MOS v1.7 Marketing Engineering Lab

## Purpose

Extend the frozen v1.7 Lab architecture so the Lab can discover and optimize the complete production program for a marketing outcome, including content transforms, specialized Transform Pawn Agents, human-generated contributions, Content Studio sessions, Studio organization selection, iterative output treatment, and economic decisions about production delay.

## Approved architectural changes

1. Transform search includes a first-class no-op/repost option.
2. The Lab can discover atomic and composed transforms such as clipping, reactions, stylization/anime conversion, podcasting and other modality-agnostic transformations.
3. Transform Pawn Agents are specialized Agent Instances that inhabit existing MOS Agent Bodies.
4. Human contributions are represented as explicit production task packages and can be fulfilled by the project owner, authorized collaborators, or governed Arena/provider paths.
5. Human-generated raw media is an intermediate artifact that enters the selected organization for editing/composition before finalization.
6. The Lab can evaluate Studio outputs, accept them, reject them with structured treatment, retry through a different organization/transform, request human action, or abandon the branch.
7. Production delay has explicit economic value and the Lab may wait, substitute, or abandon based on expected value of delay.
8. Content Studio is a MOS-owned AI+Human production runtime that works standalone and as a Lab actuator.
9. Studio initially supports reaction content, audio podcasts and video podcasts through a pluggable format framework.
10. One-person podcasts may use voice, text, avatar, prerecorded, generated, or hybrid interviewer representations with provenance.
11. Multi-person podcast sessions may span multiple authorized MOS accounts while preserving identity, consent and provenance.
12. Studios can load any organization satisfying the Studio compatibility contract, whether Lab-discovered or user-supplied.
13. Lab requests carry the selected organization, transform graph, human tasks, acceptance criteria, budget and stopping policy into the Studio.
14. Studio outputs are versioned artifact packages; each treatment creates a new immutable version.

## Canonical source

The normative architecture is recorded in:

- `spec/architecture-v1.7-marketing-lab.md`
- `spec/architecture-lock-v1.7.md`
- `spec/frozen-manifest-v1.7.json`
- `spec/effective-backlog-v1.7.md`
- `spec/module-dependency-matrix-v1.7.md`
- `spec/content-studio-contract-v1.0.md`

This change request is the audit trail. It is not a second architecture authority.

## Supersession

The updated v1.7 architecture text supersedes any earlier wording that treated content transformation as only a fixed action list, treated human participation as a simple capability gap, or treated the Lab as the only producer of finished content.

v1.6 Rights, Policy, Distribution, Workflow, Execution, Evidence and Experiment authorities remain unchanged and authoritative.
