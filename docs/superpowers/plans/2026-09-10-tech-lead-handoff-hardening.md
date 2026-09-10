# MarketingOS Tech Lead Handoff Hardening Implementation Plan

> **For agentic workers:** Use this plan only for repository-governance hardening. Product implementation continues through the frozen MKT-013..MKT-040 Work Items.

**Goal:** Make `payswapdotorg/MOS` self-describing and executable by a successor Tech Lead with up to three concurrent implementation workers, without changing the frozen architecture.

**Architecture:** Add a successor-agent coordination layer over the frozen v1.4 architecture. Keep `spec/` authoritative; put live execution status, scheduling policy and worker instructions under `docs/handoff/`.

**Tech Stack:** Markdown/JSON repository artifacts; GitHub PR workflow; existing TypeScript/PostgreSQL implementation and CI.

**Spec:** `spec/frozen-manifest-v1.4.json`, `spec/effective-backlog-v1.4.md`, `docs/handoff/ARCHITECT_HANDOFF.md`

## Global Constraints

- `spec/` frozen architecture documents remain unchanged unless an explicit Architecture Change Request is approved.
- PostgreSQL remains authoritative persistence.
- There is exactly one authority for workflow, execution, deployment, evidence, policy, credentials and AI routing.
- Client ownership is resolved before dependent traversal.
- External UNKNOWN outcomes are unresolved and require reconciliation.
- Provider-specific SDK/API logic remains behind adapters/extensions.
- Historical execution/evidence/learning records are never rewritten by redeploy/rollback.
- Maximum active implementation workers: **3**.
- Worker reports do not constitute Architect acceptance.

---

### Task 1: Align repository identity and frozen version references

**Files:**
- Modify: `README.md`

- [ ] Step 1: Change the stale current architecture declaration from v1.3 to v1.4 and identify v1.3 as the previous baseline.
- [ ] Step 2: State that the v1.4 frozen manifest defines override precedence.
- [ ] Step 3: Run a repository text search for current-version claims in non-frozen handoff/status files and correct stale operational references.
- [ ] Step 4: Verify no frozen `spec/` file was modified.
- [ ] Step 5: Commit with `chore: align repository identity with frozen v1.4`.

### Task 2: Add successor Tech Lead handoff

**Files:**
- Create: `docs/handoff/TECH_LEAD_HANDOFF.md`

- [ ] Step 1: Define the Tech Lead role as implementation orchestrator, not architecture editor.
- [ ] Step 2: Define mandatory takeover inspection of Git, PRs, dependencies, implementation artifacts and actual code.
- [ ] Step 3: Define maximum three-worker concurrency and dependency/file-surface conflict checks.
- [ ] Step 4: Define worker evidence, PR-base and independent acceptance requirements.
- [ ] Step 5: Define the final MKT-040 plus end-to-end completion gate.

### Task 3: Add implementation state ledger

**Files:**
- Create: `docs/handoff/IMPLEMENTATION-STATE.md`

- [ ] Step 1: Record MKT-001..MKT-012 as accepted/merged, MKT-009 correction as accepted/merged, MKT-013 as in-flight, and MKT-014..MKT-040 as pending pending live reconciliation.
- [ ] Step 2: Define state meanings including READY, IN_FLIGHT, REVIEW, ACCEPTED, MERGED, BLOCKED and RECONCILE.
- [ ] Step 3: State that Git/PR/code/evidence outrank this ledger.

### Task 4: Add three-worker dependency execution plan

**Files:**
- Create: `docs/handoff/EXECUTION-PLAN.md`

- [ ] Step 1: Encode the effective dependency graph for MKT-013..MKT-040.
- [ ] Step 2: Define the initial high-value frontier after MKT-013: MKT-014, MKT-017, MKT-025 where file-surface checks allow.
- [ ] Step 3: Require recomputation of the READY set after every accepted merge.
- [ ] Step 4: Define convergence and final MKT-034/MKT-039/MKT-040 ordering constraints.

### Task 5: Add bounded Worker contract

**Files:**
- Create: `docs/handoff/WORKER-CONTRACT.md`

- [ ] Step 1: Require repository-first inspection and exact effective-contract reading.
- [ ] Step 2: Prohibit architecture redesign, second authorities, cross-tenant access and provider leakage.
- [ ] Step 3: Require real PostgreSQL proof and negative security/concurrency tests for material invariants.
- [ ] Step 4: Require PRs against current `main` with exact evidence and limitations.

### Task 6: Final hardening verification

**Files:**
- Verify: all new `docs/handoff/*` artifacts and `README.md`

- [ ] Step 1: Check internal references resolve to existing files.
- [ ] Step 2: Check the v1.4 backlog count remains 40.
- [ ] Step 3: Confirm active PRs are reflected accurately.
- [ ] Step 4: Run lint/typecheck/static checks after any code-bearing change.
- [ ] Step 5: Commit the complete hardening package only when all artifacts are internally consistent.
