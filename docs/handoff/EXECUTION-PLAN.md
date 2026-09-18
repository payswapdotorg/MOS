# MOS — Unified Successor Tech Lead Execution Plan (v1.5 + v1.6)

**Architecture:** v1.6 FROZEN; v1.5 remains the implementation baseline  
**Program:** implement and verify the complete v1.5 platform + v1.6 Growth Autonomy program as one coherent delivery  
**Maximum concurrent implementation workers:** 3  
**Canonical handoff:** this file  
**Rule:** do not run a separate v1.5 prompt and then a separate v1.6 prompt

## 1. Mission of the Tech Lead

The Tech Lead owns orchestration, dependency scheduling, acceptance and repository truth.

The objective is not merely to land MKT-001..MKT-078. The objective is a single production-grade MOS in which:

- the v1.5 platform authorities are real, tested and deployable;
- v1.6 Growth Missions and Growth Operator compose those authorities without creating alternate engines;
- social, research, content, product-marketing and commerce capabilities are pluggable and evidence-driven;
- human/UGC/creator amplification is an optional experiment treatment, never a prerequisite for autonomous growth;
- the console and deployment are repository-owned and reproducible.

Actual source, migrations, tests, Git history, provider verification, runtime evidence and deployment state outrank all handoff/status claims.

## 2. First gate: truth audit, not implementation assumptions

The v1.5 documents report MKT-001..MKT-052 as accepted/merged. That is a coordination claim, not permission to assume they are implemented correctly.

Before scheduling v1.6 implementation, the Tech Lead must inspect the current repository and classify every v1.5 Work Item as:

- **VERIFIED** — source + tests + acceptance evidence prove it;
- **INCOMPLETE** — implementation is missing or materially below acceptance;
- **BROKEN** — implementation exists but objective verification fails;
- **BLOCKED** — dependency/environment/source-recovery blocker is proven;
- **N/A** — only when an explicit architecture decision documents why.

Only VERIFIED items satisfy downstream dependencies.

If a reported v1.5 item is not VERIFIED, the Tech Lead reopens its implementation work using the frozen v1.5 backlog. Do not create a parallel v1.5 implementation.

## 3. Mandatory reading order

Every worker must read:

1. `AGENTS.md`
2. `spec/frozen-manifest-v1.6.json`
3. `spec/architecture-v1.6.md`
4. `spec/architecture-lock-v1.6.md`
5. `spec/change-request-006.md`
6. `spec/effective-backlog-v1.6.md`
7. `spec/module-dependency-matrix-v1.6.md`
8. applicable v1.5 frozen documents and explicit supersessions
9. `spec/effective-backlog-v1.5.md`
10. applicable v1.5 dependency / traceability / security / module matrices
11. `docs/architecture/IMPLEMENTATION-GOVERNANCE.md`
12. `docs/product/PRODUCT-CONSOLE-V1.6.md`
13. `docs/handoff/IMPLEMENTATION-STATE.md`
14. `docs/handoff/EXECUTION-PLAN.md`
15. `docs/handoff/WORKER-CONTRACT.md`
16. `docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md`
17. the exact Work Item / task

The `*-V1.6.md` handoff files are compatibility aliases only; this unified handoff is canonical.

## 4. Three-worker ownership model

Ownership is by domain surface, not by calendar. The Tech Lead may reassign a lane after a worker finishes its ready queue, but two workers must never modify the same composition root, route registry, migration set or deployment manifest concurrently.

### Worker A — Platform + provider capability plane

Primary ownership:

- v1.5 foundational platform / integrations / credentials / policy / workflow / execution surfaces required by the v1.5 dependency graph;
- unresolved v1.5 core Work Items that are prerequisites for external capabilities;
- MKT-055..MKT-061: Social Account + OAuth and the five MVP social adapters;
- adapter-specific conformance, provider runbooks and integration fixtures.

Rules:

- provider SDK imports stay inside sanctioned adapters/composition roots;
- no provider-specific assumptions enter domain/application modules;
- each provider declares actual capability subsets, account constraints, authorization scopes, limits and observable restriction signals;
- adapter completion requires objective provider evidence, not mocked success alone.

### Worker B — Intelligence + content + scientific optimization plane

Primary ownership:

- v1.5 operating/intelligence/app/human platform items that are ready under the v1.5 dependency graph;
- MKT-062..MKT-067: research/content intelligence, rights, content assets/transformation, platform health and experiment analysis;
- rights/provenance verification for all human-created assets;
- MKT-076..MKT-078 as an **optional acceleration track**, after the baseline Human Agent + Job contracts are VERIFIED.

Rules:

- research observations and model claims remain distinguishable;
- causal language requires the applicable experimental evidence standard;
- rights uncertainty fails closed for autonomous publication;
- human-created content uses the same rights/provenance/lineage pipeline as automated content;
- MKT-076..MKT-078 must never be made dependencies of core mission execution.

### Worker C — Mission + console + commerce + deployment plane

Primary ownership:

- v1.5 console source recovery, console completion and deployment reproducibility;
- unresolved v1.5 product/UX/deployment work;
- MKT-053..MKT-054: Growth Mission + Growth Operator;
- MKT-068..MKT-075: notifications, product intelligence, product marketing, commerce, attribution, console and final v1.6 proof.

Rules:

- Growth Operator orchestrates but does not become a Workflow/Execution engine;
- console is presentation-only over server authorities;
- commerce order/inventory remains external provider authority;
- no UI work begins before the repository-owned console source gate is satisfied.

## 5. Scheduling model

Use the frozen dependency graph as the scheduler. Do not require a whole version to finish before starting the next version where dependencies permit.

### Wave 0 — repository truth

All workers may participate in verification, but only one worker owns each changed surface.

1. Tech Lead computes the VERIFIED/INCOMPLETE/BROKEN/BLOCKED map for MKT-001..MKT-052.
2. Confirm current `main` head, open PRs and deployment state.
3. Establish the three worker ownership locks.
4. Recover the console source gate as P0 for UI work.

### Wave 1 — parallel v1.5 recovery/completion

Dispatch the ready items from the v1.5 dependency graph across Workers A/B/C.

At the same time, C may work on console-source reconciliation and deployment tasks that are independent of backend modules.

The Tech Lead must not create synthetic dependencies merely to serialize workers.

### Wave 2 — v1.6 foundations

As soon as their prerequisites are VERIFIED:

- Worker C: MKT-053 Growth Mission;
- Worker A: MKT-055 Social Account/OAuth;
- Worker C: MKT-068 Notifications;
- Worker C/B: MKT-069 Product Intelligence;
- Worker C/B: MKT-071 Commerce capabilities.

Then:

- Worker A: MKT-056 adapter contract → MKT-057..061 platform adapters in waves;
- Worker B: MKT-062..064 as their actual upstream capabilities become available;
- Worker C: MKT-054 Growth Operator after MKT-053 and required v1.5 authorities are VERIFIED.

### Wave 3 — autonomous growth backbone

Critical sequence:

`v1.5 authoritative foundations`
→ `MKT-053`
→ `MKT-055`
→ `MKT-056`
→ `MKT-057..061`
→ `MKT-062..064`
→ `MKT-065`
→ `MKT-067`
→ `MKT-054`
→ `MKT-070 / MKT-072 / MKT-073`
→ `MKT-074`
→ `MKT-075`

This is the core autonomous path.

### Wave 4 — optional human amplification

`MKT-076 → MKT-077 → MKT-078` is a **side branch**, not a core critical-path dependency.

It may be implemented concurrently when its prerequisites are ready, but:

- MKT-075 does not wait for MKT-076..078;
- creator/UGC offer availability does not gate Growth Mission activation;
- accepted human offers do not gate automated publishing/distribution;
- human budget may be zero;
- zero eligible humans, no accepted offers, offer expiry, or insufficient human budget are normal evidence states, not architectural failures;
- the Growth Operator must fall back to other valid treatments, reallocate to owned/automated channels, pause, notify, or terminate according to the mission's configured terminal conditions.

The only exception is a genuinely mandatory human approval required by a rights, policy or capability gate. That state is represented honestly as `blocked_pending_human_action`; it is not treated as successful autonomous execution.

## 6. Human amplification contract

Human growth is a measurable option, not the foundation of growth.

The Tech Lead must verify that every mission can be modeled without any human participation:

`mission → research → hypothesis → strategy → experiment → rights/policy → content/action → publish/execute → measure → analyze → learn → replan`

Human amplification is an additional treatment:

`... → candidate human treatment → offer → accepted Job → authentic UGC/creator distribution → rights/disclosure → publish → measure → analyze → learn`

The operator must be able to compare:

- owned-account / automated treatment;
- platform-native distribution;
- transformation/repurposing treatment;
- paid media or other configured external treatments where supported;
- human UGC/creator treatment when eligible and funded.

No mission may be designed so that human offer fill-rate, creator availability or creator budget is its only path to progress.

## 7. Product journeys the final system must support

The final proof must include:

1. creator growth on one platform;
2. creator growth using a multi-platform portfolio;
3. cross-platform redistribution with verified rights;
4. product marketing from product URL;
5. product marketing from product URL plus authorized source repository/workspace;
6. commerce discovery from an unknown niche;
7. platform restriction/anomaly → compliant reallocation or blocker handling;
8. blocker requiring human action → notification → human resolution → resume;
9. target achieved → autonomous mission stops cleanly;
10. human-growth treatment unavailable or unfunded → automated strategy continues/replans without false dependency;
11. human-growth treatment available → accepted offer joins the same experiment/evidence/learning loop.

## 8. Console and deployment gates

The v1.5 console source-recovery gate remains mandatory before repository-owned UI implementation.

The repository must contain:

- console source;
- deterministic install/build/test commands;
- required environment/auth contracts;
- repository-backed browser/E2E tests;
- reproducible preview/staging/production deployment configuration.

No compiled Vercel bundle, screenshot or external workspace is source authority.

## 9. Verification contract

Every Work Item requires objective acceptance evidence:

- exact changed files;
- exact test/lint/typecheck/architecture commands and exit status;
- database migration evidence where applicable;
- tenant-isolation and authorization negative tests;
- idempotency/concurrency evidence where applicable;
- provider capability evidence where applicable;
- runtime/deployment evidence for externally dependent behavior;
- disclosed limitations;
- no completion claim based only on another agent's report.

The Tech Lead performs the final acceptance; workers provide evidence.

## 10. Final program completion

The unified program is complete only when:

1. every required v1.5 Work Item is VERIFIED or explicitly N/A by approved architecture decision;
2. MKT-053..MKT-075 are VERIFIED or explicitly N/A by approved architecture decision;
3. the autonomous mission path works without any human-agent offer or human-growth budget;
4. all five MVP social adapters have objective capability evidence;
5. rights/provenance and cross-platform lineage are proven;
6. platform-health anomaly handling is proven without unsupported hidden-moderation claims;
7. product-marketing and commerce-discovery golden paths pass;
8. repository-owned console journeys pass;
9. preview/staging/production deployment is reproducible from the repository;
10. production health and rollback/recovery behavior are verified;
11. human-growth Work Items 076..078, when implemented, pass their own evidence gates but do **not** become prerequisites for autonomous mission completion.

Final handoff must record the exact accepted SHA, verification commands/results, deployment identifiers and remaining limitations.
