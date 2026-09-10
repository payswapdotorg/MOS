# MarketingOS — Successor Tech Lead Handoff

**Repository:** `payswapdotorg/MOS`
**Architecture:** v1.4 FROZEN
**Role:** Successor LLM Tech Lead / implementation orchestrator

## Mission

Take the repository from its current accepted implementation state to complete implementation of the frozen v1.4 MarketingOS architecture. The Tech Lead may dispatch at most **3 implementation workers concurrently**.

The Tech Lead is an orchestrator, not an architecture editor. Workers implement bounded Work Items. The Architect/reviewer independently verifies evidence and accepts or rejects the resulting PR.

## Current state at handoff

- The repository is now `payswapdotorg/MOS`.
- `main` is the authoritative integration branch.
- MKT-001..MKT-012 are accepted and merged in the inherited baseline.
- MKT-009 history-ledger consistency correction is accepted and merged in the inherited baseline.
- The source repository previously had an MKT-013 Evidence/provenance PR, but the destination repository currently has **no open PR** and only the `main` branch; therefore MKT-013 is explicitly `RECONCILE`, not accepted or in-flight.
- Effective frozen backlog ends at MKT-040.

Never infer completion from this document alone. Reconcile it with `main`, open PRs, implementation docs, and actual code/tests at takeover.

## Authority

Read first:

1. `AGENTS.md`
2. `spec/frozen-manifest.json`
3. `spec/frozen-manifest-v1.4.json`
4. `spec/architecture.md`
5. `spec/architecture-lock.md`
6. `spec/architecture-lock-v1.4.md`
7. `spec/change-request-004.md`
8. `spec/preflight-v1.4.md`
9. applicable v1.2/v1.3 addenda and corrections
10. `spec/requirements.md`
11. `spec/requirements-v1.3.md`
12. `spec/requirements-v1.4.md`
13. `spec/implementation-contract.md` plus later explicit overrides
14. `spec/state-machines.md` plus applicable corrections
15. `spec/effective-backlog-v1.4.md`
16. applicable dependency, traceability, security and work-item matrices
17. `docs/architecture/IMPLEMENTATION-GOVERNANCE.md`
18. `docs/handoff/IMPLEMENTATION-STATE.md`
19. `docs/handoff/EXECUTION-PLAN.md`
20. `docs/handoff/WORKER-CONTRACT.md`
21. the exact Work Item being implemented

Later frozen documents supersede earlier clauses only where they explicitly say so. Do not locally redesign ambiguous architecture.

## Mandatory takeover procedure

1. Inspect git status, `main`, open PRs and recent commits.
2. Confirm the effective frozen version is v1.4.
3. Reconcile `IMPLEMENTATION-STATE.md` against actual repository state.
4. Resolve the MKT-013 `RECONCILE` state before dispatching downstream evidence-dependent work.
5. Compute the READY set from `EXECUTION-PLAN.md` and the effective dependency graph.
6. Dispatch no more than three non-conflicting Workers.
7. Each Worker implements exactly one Work Item unless the Architect explicitly authorizes a corrective split.
8. Review worker evidence against actual code before accepting the PR into the integration sequence.
9. Merge only accepted work onto current `main`; stale-base PRs must be rebased/reissued before merge.
10. After every merge, recompute the dependency graph rather than assuming the next item.
11. Keep `IMPLEMENTATION-STATE.md` accurate after every accepted/merged item.
12. When all Work Items are merged, run the final system-level proof and repository audit.

## Worker scheduling rules

A Work Item is READY only when every dependency is actually accepted on `main`.

A Worker slot is released only when its PR is accepted/merged or the worker is explicitly stopped.

Never dispatch two Workers whose changes are likely to modify the same authority boundary, migration sequence, composition root, shared route registry, or foundational test harness unless their file-level independence is demonstrated first.

Prefer parallelism across independently owned modules. Avoid speculative parallel work that creates integration conflicts merely to fill the three slots.

When a blocker affects multiple ready items, do not dispatch downstream work that will be invalidated by the blocker.

## Worker contract

Every Worker must:

- inspect the actual current repository before coding;
- read the exact effective requirement and Work Item contract;
- preserve all frozen architecture rules;
- use existing authorities instead of creating parallel ones;
- enforce Client isolation before dependent traversal;
- keep provider SDKs behind provider adapters/extensions;
- use PostgreSQL as authoritative persistence;
- add negative security/concurrency regressions for material invariants;
- provide exact commands and actual outputs for verification;
- disclose environment limitations;
- open a PR against the current `main` base;
- never mark another Work Item complete based only on its own report.

## Acceptance rules

The Tech Lead must not treat green tests as sufficient by themselves. Reviewers must inspect:

- changed files and architecture boundaries;
- requirement/acceptance mapping;
- actual test commands and exit status;
- integration/E2E proof where required;
- tenant/security proof;
- concurrency/crash-window proof where relevant;
- production wiring rather than mock-only paths;
- migration ordering and database backstops;
- honest disclosures.

Serious blockers include second authorities, cross-tenant traversal, caller-controlled provenance, secret persistence, provider leakage, unsafe unknown replay, competing Job winners, extension permission bypass, deployment becoming a second execution engine, and historical record rewriting.

## Finish condition

Implementation is complete only when MKT-001..MKT-040 are actually accepted/merged or explicitly classified as not applicable by an approved architecture decision, and the final E2E proof demonstrates the frozen operating loop without bypassing authority boundaries.

Final target:

```text
Goal
 → Evidence
 → Hypothesis
 → Playbook Version
 → Deployment
 → Workflow
 → Task
 → Execution
 → Outcome
 → Learning
 → next decision/deployment
```

AI remains a replaceable reasoning layer, not a system-of-record authority.
