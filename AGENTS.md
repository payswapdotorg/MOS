# MarketingOS Implementation Rules

This repository is the architecture and implementation source of truth for MOS. It is not permission for implementation agents to redesign the frozen product.

## Before implementing any Work Item

Read, in this order:

1. `README.md`
2. `spec/frozen-manifest-v1.5.json`
3. `spec/architecture-v1.5.md`
4. `spec/architecture-lock-v1.5.md`
5. `spec/change-request-005.md`
6. `spec/mos-app-ecosystem-v1.5.md`
7. `spec/operating-graph-v1.5.md`
8. applicable v1.1/v1.2/v1.3/v1.4 frozen documents and explicit supersessions
9. `spec/effective-backlog-v1.5.md`
10. applicable dependency, traceability, security and module matrices
11. `docs/architecture/IMPLEMENTATION-GOVERNANCE.md`
12. `docs/product/PRODUCT-CONSOLE-V1.5.md`
13. `docs/handoff/IMPLEMENTATION-STATE.md`
14. `docs/handoff/EXECUTION-PLAN.md`
15. `docs/handoff/WORKER-CONTRACT.md`
16. `docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md`
17. the exact Work Item / task being implemented

Actual Git history, source, tests, migrations and PRs outrank stale coordination documents.

## Authority rules

- Workflow state belongs only to `/workflows`.
- Execution identity/lifecycle belongs only to `/executions`.
- Deployment intent/lifecycle belongs only to `/deployments`.
- Evidence/provenance belongs only to `/evidence`.
- AI routing belongs only to `/ai-runtime`.
- Client isolation is enforced server-side before dependent traversal or external access.
- No provider SDK may leak into domain/application modules.
- No extension, app, human, model, worker, Domain Pack or frontend may become an alternate authority.
- Human Agents use the existing Job/Task/Execution authorities.
- Domain Packs use core authorities and may not create parallel engines.
- Apps use server capabilities and may own only explicitly bounded app-domain state.
- Deployment may request execution but may not mutate Workflow/Execution lifecycle directly.

## v1.5 product-console rules

- The complete user-facing console source must live in this repository.
- A Vercel deployment, compiled bundle, screenshot or external source workspace is not source authority.
- UI is presentation over authoritative APIs.
- Frontend checks never replace server-side authorization.
- The Operating Graph is contextual trace/coordination, not a replacement authority.
- Profit Intelligence is consumed as returned; UI does not recompute economics.
- AI Operator recommendations must expose source/rationale/action-contract context.
- UNKNOWN execution outcomes remain unresolved and visible as reconciliation states.
- Client portal and incumbent-capability experiences are App surfaces, not new core authorities.
- Integrations are discovered contextually through existing Integration/App contracts.

## Evidence rule

Never report an implementation as complete because an agent says it is complete. Verify acceptance criteria with objective evidence and record limitations honestly.

## Architecture-change rule

If implementation appears to require changing a frozen rule, stop and report an Architecture Change Request requirement. Do not modify frozen architecture opportunistically.

## Runtime rules

- Persistent sandboxes are Workspace-scoped and leased to Executions.
- `execution_id` is never Sandbox identity.
- UNKNOWN execution outcome is unresolved, never success, and requires reconciliation.
- Non-idempotent unknown side effects must not be blindly replayed.
- Candidate-specific Job Offers are concurrency-safe claims.

## App rules

- Published App Versions are immutable.
- Install is workspace-scoped and policy-gated.
- Granted permissions are server-derived and revocable.
- Historical invocations retain their original App Version.
- App UI cannot directly mutate MOS core tables.

## Expected implementation style

Prefer the smallest architecture-consistent implementation. Use database constraints, CAS/version checks, append-oriented records, durable queue/outbox mechanisms, and negative regression tests for security/concurrency invariants where applicable.
