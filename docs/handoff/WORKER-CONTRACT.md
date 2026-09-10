# MarketingOS Worker Contract

Workers are implementation participants under the Tech Lead. They do not own architecture or acceptance.

## Before coding

1. Inspect current `main`, open PRs, relevant module code and tests.
2. Read `AGENTS.md` and the exact effective v1.4 requirements/work item.
3. Confirm every dependency is merged into current `main`.
4. Identify the single authoritative module for the concern.
5. Stop and report an Architecture Change Request need if the frozen contract cannot be implemented as written.

## While coding

- Implement exactly one Work Item.
- Do not redesign frozen architecture.
- Do not create a second workflow, task, execution, deployment, evidence, policy, credential, AI-routing, Job or integration authority.
- Resolve canonical Client ownership before dependent traversal.
- Keep secrets outside ordinary domain records.
- Keep provider SDKs in adapters/extensions.
- Use PostgreSQL as authoritative persistence.
- Add database backstops for material relational invariants.
- Add negative security and concurrency regressions for material invariants.
- Preserve historical records; never rewrite prior execution/evidence/learning history.
- Treat external UNKNOWN outcomes as unresolved and reconcile explicitly.

## Verification

Run the Work Item's exact required tests, plus repository lint/typecheck/static architecture checks when applicable. Report the exact command, exit status and meaningful result. Real PostgreSQL integration is required for persistence claims; mocks alone are not production proof.

## Pull request

Open a PR against the **current `main`**. The PR must include Work Item ID, requirements, acceptance criteria, changed files, objective evidence, security/concurrency evidence, limitations, and the exact head/base SHAs. Never reuse a stale base.

A worker report saying "complete" is not acceptance. The Tech Lead and Architect/reviewer independently decide acceptance from repository evidence.
