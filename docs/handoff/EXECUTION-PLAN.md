# MarketingOS — Successor Tech Lead Execution Plan

**Architecture:** v1.4 frozen
**Maximum concurrent implementation workers:** 3
**Final Work Item:** MKT-040

## Scheduling algorithm

The Tech Lead must derive readiness from the effective dependency graph after every accepted merge. A Work Item is eligible only when all dependencies are accepted on the current `main`.

Before concurrent dispatch, inspect expected changed-file surfaces. Do not dispatch two items together when they are likely to conflict in the same module, migration sequence, composition root, route registry, or foundational test harness.

## Immediate repository state

- MKT-001..MKT-012: accepted/merged.
- MKT-009 corrective history backstop: accepted/merged.
- MKT-013: in-flight; review actual PR state before treating its dependency as complete.

## Dependency graph for MKT-013..MKT-040

```text
MKT-013 ← MKT-004, MKT-005
MKT-014 ← MKT-013
MKT-015 ← MKT-013, MKT-014
MKT-016 ← MKT-015

MKT-017 ← MKT-005, MKT-010
MKT-018 ← MKT-017, MKT-013
MKT-019 ← MKT-017, MKT-013
MKT-020 ← MKT-010, MKT-018
MKT-021 ← MKT-003, MKT-005, MKT-020
MKT-022 ← MKT-021, MKT-010
MKT-023 ← MKT-013, MKT-021
MKT-024 ← MKT-023

MKT-025 ← MKT-003
MKT-026 ← MKT-009, MKT-010, MKT-025
MKT-027 ← MKT-026, MKT-013
MKT-028 ← MKT-006, MKT-009, MKT-015, MKT-027

MKT-029 ← MKT-006, MKT-009, MKT-013
MKT-030 ← MKT-013, MKT-015, MKT-016
MKT-031 ← MKT-026, MKT-027
MKT-032 ← MKT-022
MKT-033 ← MKT-005, MKT-011, MKT-012, MKT-018

MKT-034 ← MKT-024, MKT-028, MKT-030, MKT-032, MKT-033

MKT-035 ← MKT-026
MKT-036 ← MKT-007, MKT-008, MKT-022
MKT-037 ← MKT-035, MKT-036, MKT-013, MKT-017, MKT-021
MKT-038 ← MKT-023, MKT-024, MKT-037
MKT-039 ← MKT-030, MKT-031, MKT-037, MKT-038

MKT-040 ← MKT-007, MKT-008, MKT-013, MKT-017, MKT-022, MKT-023, MKT-024
```

## Recommended worker waves

These are scheduling hints, not permission to ignore the live DAG.

### Frontier A — after MKT-013 is accepted

Prefer:

- Worker 1: MKT-014 — Metric normalization.
- Worker 2: MKT-017 — AI task profile and model registry.
- Worker 3: MKT-025 — Human Agent foundation / Field Agent specialization.

If MKT-013 is not yet merged, MKT-017 and MKT-025 can still be considered independently because their dependencies do not include MKT-013; however the Tech Lead must inspect actual file overlap before dispatching them together with any other ready item.

### Frontier B — after the next merges

Typical candidates include MKT-015, MKT-018, MKT-019, and MKT-026. Choose the three whose dependencies are complete and whose expected file surfaces are independent.

### Convergence

The graph naturally converges through:

- evidence → metrics → experiments → learning;
- AI runtime → policy → extensions/integrations;
- Human Agent → Job → field execution;
- product UI surfaces;
- creator Domain Pack and provider proof;
- final deployment control plane.

Do not implement downstream convergence work against speculative upstream interfaces. Consume only accepted public contracts.

## Priority guidance

When several items are ready, prefer the set that unlocks the most downstream work while minimizing shared-file conflicts. Avoid making the scheduler optimize merely for having three active workers.

## Final convergence

MKT-034 is the v1.2/v1.3 end-to-end acquisition operating loop. MKT-039 is the v1.3 Creator Operations experience. MKT-040 is the v1.4 Marketing Cloud Deployment control plane.

MKT-040 must remain a control-plane authority. It may request execution but must not mutate Workflow/Execution state directly or introduce a second retry/orchestration engine.

## End-of-implementation gate

After the final Work Item is accepted/merged:

1. run lint and typecheck;
2. run static architecture checks;
3. run the complete unit suite;
4. run the complete architecture suite;
5. run real PostgreSQL integration/E2E suites;
6. verify concurrency/security regressions;
7. verify deployment/runtime wiring with explicit environment limitations;
8. trace the final Goal → Evidence → Hypothesis → Playbook → Deployment → Workflow → Task → Execution → Outcome → Learning loop;
9. audit for second authorities, cross-tenant traversal, provider leakage, secret persistence, history rewriting and unsafe UNKNOWN handling;
10. update implementation-state only after objective verification.
