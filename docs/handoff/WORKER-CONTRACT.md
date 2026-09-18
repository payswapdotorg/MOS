# MOS Unified Worker Contract — v1.5 + v1.6

Workers operate under the Tech Lead. Workers do not own architecture, dependency scheduling or final acceptance.

## Non-negotiable

- v1.6 architecture is frozen; v1.5 remains frozen except for explicit v1.6 supersessions.
- The repository is the implementation source of truth.
- Reported completion is not evidence; verify source, tests, migrations, Git history and runtime behavior.
- PostgreSQL/MOS APIs remain authoritative.
- No frontend, App, Extension, human agent, model, worker or provider becomes an alternate MOS authority.
- Server-side authorization remains authoritative.
- No provider SDK leakage into core domain/application modules.
- No second Workflow/Execution engine.
- No second human marketplace or payment authority.
- Human amplification is optional and non-blocking.

## Before coding

1. Inspect the current branch/main, open PRs and exact changed-file surface.
2. Read the unified `docs/handoff/EXECUTION-PLAN.md`.
3. Read the unified `docs/handoff/IMPLEMENTATION-STATE.md`.
4. Read this contract.
5. Read the exact frozen architecture/backlog/dependency documents for the Work Item.
6. Verify all upstream dependencies are VERIFIED, not merely documented as complete.
7. Confirm ownership with the other two active workers.

## Worker selection rule

The Tech Lead dispatches the highest-value READY work item whose dependencies are VERIFIED and whose changed-file surface does not conflict with active workers.

Do not wait for an entire version to complete when an independent item is ready.

## v1.6 human-growth rules

Human UGC/creator work can improve distribution but is not a required execution path.

A worker must not:

- make Growth Mission activation depend on a human agent;
- make creator-offer acceptance a prerequisite for automated distribution;
- assume human budget exists;
- treat lack of offers/agents as a system failure;
- introduce fake engagement, fabricated testimonials, impersonation or anti-abuse bypass;
- turn compensation terms into payment settlement authority.

When human work is unavailable, the system must remain capable of selecting non-human treatments, reallocation, pause, notification or a truthful terminal state.

Human work becomes a hard blocker only when the mission explicitly reaches a policy/rights/capability gate that genuinely requires a human approval. Represent that state explicitly.

## Frontend-specific

- Use authoritative API contracts; do not invent mock-only authority endpoints.
- Never recompute derived Profit Intelligence figures in the browser.
- Never infer authorization from client state.
- Preserve exact App Version and execution identities in history.
- Keep UNKNOWN execution outcomes unresolved.
- Show source/rationale/action-contract context for AI/Growth Operator recommendations.
- UI is presentation only.

## Verification

Report exact commands, exit status, screenshots/browser observations where appropriate, API responses where required, database migration evidence and environment limitations.

A green unit/UI test without production-backed authority behavior is not sufficient evidence of completion.

## Pull request

Every implementation PR must:

- target current `main`;
- name the Work Item(s);
- list changed files;
- map acceptance criteria to evidence;
- show exact verification commands/results;
- disclose external/provider/environment limits;
- avoid unrelated refactors;
- state whether the work affects the core autonomous path or the optional human-amplification branch.

The Tech Lead and Architect independently decide acceptance.