# MarketingOS Implementation Rules

This repository is the architecture and implementation source of truth for MOS. It is not permission for implementation agents to redesign the frozen product.

## Before implementing any Work Item

Read, in this order:

1. README.md
2. spec/frozen-manifest-v1.6.json
3. spec/architecture-v1.6.md
4. spec/architecture-lock-v1.6.md
5. spec/change-request-006.md
6. spec/effective-backlog-v1.6.md
7. spec/module-dependency-matrix-v1.6.md
8. the applicable v1.5 frozen documents and explicit supersessions
9. docs/architecture/IMPLEMENTATION-GOVERNANCE.md
10. docs/product/PRODUCT-CONSOLE-V1.6.md
11. docs/handoff/IMPLEMENTATION-STATE-V1.6.md
12. docs/handoff/EXECUTION-PLAN-V1.6.md
13. docs/handoff/WORKER-CONTRACT.md
14. docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md
15. the exact Work Item / task being implemented

Actual Git history, source, tests, migrations and provider verification outrank stale coordination documents.

## Authority rules

- Workflow state belongs only to /workflows.
- Execution identity/lifecycle belongs only to /executions.
- Deployment intent/lifecycle belongs only to /deployments.
- Evidence/provenance belongs only to /evidence.
- AI routing belongs only to /ai-runtime.
- Client isolation is enforced server-side before dependent traversal or external access.
- No provider SDK may leak into domain/application modules.
- No extension, app, human, model, worker, Domain Pack or frontend may become an alternate authority.
- Human Agents use the existing Job/Task/Execution authorities.
- Domain Packs use core authorities and may not create parallel engines.
- Apps use server capabilities and may own only explicitly bounded app-domain state.
- Growth Mission and Growth Operator may orchestrate, but never become a second workflow or execution engine.
- Social, product, commerce and transformation providers remain behind explicit capability boundaries.

## v1.6 growth-autonomy rules

- Every social platform has its own adapter and declared capability matrix.
- Cross-platform redistribution requires explicit rights/provenance clearance for the source asset and destination-policy compatibility.
- Rights uncertainty fails closed for autonomous publication.
- Fair-use reasoning is evidence for review, not an automatic legal guarantee.
- Platform-health output describes observable signals; hidden moderation state must never be invented.
- Shadow-ban language is reserved for platform-confirmed restrictions. Otherwise use suspected_distribution_anomaly.
- Platform blocker adaptation may change compliant strategy, pause publishing, shift platforms, request human action or use platform-provided appeals; it may not evade anti-abuse controls, fake engagement or impersonate humans.
- Product/source/store credentials are separate least-privilege grants.
- Commerce orders/inventory remain provider authority accessed through /integrations.
- Attribution is distinct from causal inference.
- Transformation engines must preserve source/ingredient lineage and may be first-party capabilities or Extensions/Apps.
- Content used for padding, compilations or composites must carry its own rights/provenance.
- Business objectives outrank vanity metrics when the mission declares a business outcome.

## v1.6 human-growth rules

- Human amplification uses the existing /field-agents + /jobs + /workflows + /executions authorities; never create a second human marketplace or execution engine.
- UGC, creator-post and creator-ad offers must preserve explicit deliverables, compensation terms, disclosure requirements and content-rights/usage terms.
- Human-created content enters the same Content Asset / Rights / Provenance pipeline as automated content.
- Human work must represent authentic activity; fake engagement, fabricated testimonials and anti-abuse bypasses are forbidden.
- Compensation terms are not payment authority; settlement remains a composed external capability or future financial authority.

## Product-console rules

- The complete user-facing console source must live in this repository.
- A Vercel deployment, compiled bundle, screenshot or external source workspace is not source authority.
- UI is presentation over authoritative APIs.
- Frontend checks never replace server-side authorization.
- AI/Growth Operator recommendations must expose source/rationale/action-contract context.
- UNKNOWN execution outcomes remain unresolved and visible as reconciliation states.
- Integrations are discovered contextually through existing Integration/App contracts.

## Evidence rule

Never report an implementation as complete because an agent says it is complete. Verify acceptance criteria with objective evidence and record limitations honestly.

## Architecture-change rule

If implementation appears to require changing a frozen rule, stop and report an Architecture Change Request requirement. Do not modify frozen architecture opportunistically.

## Runtime rules

- Persistent sandboxes are Workspace-scoped and leased to Executions.
- execution_id is never Sandbox identity.
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