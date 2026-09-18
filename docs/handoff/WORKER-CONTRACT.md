# MOS Worker Contract — v1.5 Product Console Completion

Workers operate under the Tech Lead. They do not own architecture or acceptance.

## Non-negotiable

- MOS v1.5 is frozen.
- MKT-001..MKT-052 are accepted/merged; do not reopen them for convenience.
- The console is presentation-only.
- The repository must become the sole source of truth for console source, tests and deployment configuration.
- PostgreSQL/MOS APIs remain authoritative.
- No frontend state may become tenant, workflow, execution, evidence, decision, profit, deployment, app-registry or AI-routing authority.
- Server-side authorization remains authoritative.
- No provider SDK leakage into core domain/application modules.

## Before coding

1. Inspect current `main`, open PRs and the exact task's changed-file surface.
2. Read the v1.5 frozen documents and `docs/product/PRODUCT-CONSOLE-V1.5.md`.
3. Confirm dependencies are accepted on current main.
4. Confirm ownership boundaries with other active workers.
5. If the task is UI work, verify the console source is already in the repository.
6. Stop and escalate only for a genuine frozen-architecture contradiction.

## Frontend-specific

- Use existing API contracts; do not invent mock-only authority endpoints.
- Never recompute Profit Intelligence figures in the browser.
- Never infer authorization from client-side state.
- Show source/rationale/action-contract context for AI Operator items.
- Keep UNKNOWN execution outcomes unresolved.
- Preserve App Version identity in app UI and history.
- Treat Client Portal and incumbent-capability surfaces as Apps, not new core modules.
- Keep integrations contextual rather than exposing infrastructure internals as ordinary product navigation.

## Verification

Report exact commands, exit status, screenshots/browser observations where appropriate, API responses where required, and environment limitations.

A green UI test without a production-backed API or a clean build is not sufficient evidence of completion.

## Pull request

Every implementation PR must:

- target current `main`;
- name the Work Item;
- list changed files;
- map requirements/acceptance;
- show exact verification commands;
- disclose external/environmental limitations;
- avoid unrelated refactors.

The Tech Lead and Architect independently decide acceptance.
