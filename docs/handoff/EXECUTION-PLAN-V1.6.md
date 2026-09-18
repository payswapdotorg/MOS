# MOS — Successor Tech Lead Execution Plan v1.6

Architecture: v1.6 FROZEN
Maximum concurrent implementation workers: 3

## Mandatory reading

Read the v1.5 governance/handoff documents first, then:
1. spec/change-request-006.md
2. spec/frozen-manifest-v1.6.json
3. spec/architecture-v1.6.md
4. spec/architecture-lock-v1.6.md
5. spec/effective-backlog-v1.6.md
6. spec/module-dependency-matrix-v1.6.md
7. docs/product/PRODUCT-CONSOLE-V1.6.md
8. the exact Work Item / Work Order.

Actual Git history/source/tests outrank coordination notes.

## Worker A — Social capability plane

Owns MKT-055 through MKT-061 and adapter-specific integration suites.

No provider-specific imports outside sanctioned adapter subtrees/composition root.

## Worker B — Intelligence / content / science

Owns MKT-062 through MKT-067 including research, content intelligence, rights, transformations, platform health and experiment analysis.

Provider-neutral fixtures are allowed, but fake external-provider success may not be reported as production capability.

## Worker C — Mission / product / commerce / UX

Owns MKT-053, MKT-054 and MKT-068 through MKT-075.

Safe early work:
- MKT-053 can start independently of social adapter implementation;
- MKT-068 can start independently of social adapters;
- MKT-069 can start with read-only product/source fixtures;
- MKT-071 can extend the existing commerce boundary independently;
- MKT-074 begins only when repository-owned console source is recovered and necessary APIs exist;
- MKT-075 is final integration proof.

## Critical path

MKT-055 → MKT-056 → MKT-057..061 → MKT-062/063/064 → MKT-065 → MKT-067 → MKT-054 → MKT-070/072/073 → MKT-074 → MKT-075

## Parallelization

Immediately parallel: MKT-053, MKT-055, MKT-068, MKT-069, MKT-071.

After MKT-056, the five social adapters are independently implementable and can be partitioned across future worker waves without exceeding three active workers.

## Required architecture proofs

Every work item must prove no alternate authority, provider isolation, tenant isolation, fail-closed policy behavior, idempotency/concurrency, immutable historical identity where applicable, and truthful limitation disclosure.

## Scientific proof

Competitor/platform observation → hypothesis; own-channel measurement → observation; statistical estimate → analysis; causal conclusion → only when design/evidence standard permits; learning → durable scoped conclusion retaining contradictions.

## Social-platform proof

For every MVP adapter, the runbook must state supported account types, OAuth scopes, supported publish/discovery/analytics capabilities, approval/audit requirements, quotas/rate limits, media constraints, known limitations and actually observable restriction signals.

## Commerce proof

Unknown niche → research → candidate product → content experiments → viable product decision → product listing → social distribution → attributable visits → real order events → economic outcome → learning.

## Platform-health proof

Use an explicit anomaly detector. It may identify suspected distribution or automation issues and recommend compliant responses, but it must not claim knowledge of hidden moderation state.

## Final end-to-end proofs

1. creator growth on one platform;
2. creator growth using a multi-platform portfolio;
3. cross-platform redistribution with verified rights;
4. product marketing from product URL;
5. product marketing from product URL plus authorized source repository;
6. commerce discovery from an unknown niche;
7. blocker → notification → human resolution → resume;
8. restriction on one network → compliant reallocation to another network;
9. target achieved → autonomous mission stops cleanly.

## Human-growth implementation wave

After the baseline human/job contracts are verified:
- MKT-076 extends the existing Human Agent + Job surfaces;
- MKT-077 composes offer terms with Content Rights/Assets/Distribution;
- MKT-078 connects human work to Experiment Analysis and Growth Operator allocation.

Worker C owns MKT-076..MKT-078 alongside mission/commerce work. Worker B verifies rights/provenance and human-created asset lineage. Worker A validates platform-specific creator-ad capability declarations inside the social adapter matrix.
