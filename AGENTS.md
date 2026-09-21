# MarketingOS Implementation Rules

This repository is the architecture and implementation source of truth for MOS. It is not permission for implementation agents to redesign the frozen product.

## Before implementing any Work Item

1. README.md
2. spec/frozen-manifest-v1.6.json
3. spec/architecture-v1.6.md
4. spec/architecture-lock-v1.6.md
5. spec/change-request-006.md
6. spec/effective-backlog-v1.6.md
7. spec/module-dependency-matrix-v1.6.md
8. applicable v1.5 frozen documents and explicit supersessions
9. spec/effective-backlog-v1.5.md
10. applicable v1.5 dependency / traceability / security / module matrices
11. docs/architecture/IMPLEMENTATION-GOVERNANCE.md
12. docs/product/PRODUCT-CONSOLE-V1.6.md
13. docs/handoff/UX-DISCOVERY-V1.6.md
14. docs/handoff/DEPLOYMENT-PLAN-V1.6.md
15. docs/handoff/IMPLEMENTATION-STATE.md
16. docs/handoff/EXECUTION-PLAN.md
17. docs/handoff/WORKER-CONTRACT.md
18. docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md
19. the exact Work Item / task

Actual Git history, source, tests, migrations and provider verification outrank stale coordination documents.

## Unified implementation rules

- v1.5 MKT-001..MKT-052 are dependencies only after objective verification; do not trust accepted labels alone.
- v1.5 and v1.6 are one implementation program under docs/handoff/EXECUTION-PLAN.md, not two independent prompts.
- Growth Mission and Growth Operator may orchestrate, but never become a second workflow or execution engine.
- Social, product, commerce and transformation providers remain behind explicit capability boundaries.
- Optional human growth never becomes a required dependency for mission activation, core distribution, product marketing, commerce discovery or final autonomy proof.
- The old console-source P0 is resolved. Do not recreate that recovery work unless current Git/Vercel evidence contradicts this state.

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

## UX rules

- User-facing implementation is outcome-first: Grow, Market, Find a Product, Leads, Revenue, Continue Mission.
- Internal MOS objects appear through contextual progressive disclosure.
- Every empty/error/blocked state must expose an actionable next step.
- Mission UX must expose Now, Next, Why, evidence basis and learning.
- Human growth must appear as an optional treatment inside missions, not as a platform requirement.
- Presentation changes require real browser journey evidence at 390x844 and 1280x800.
- Never expose raw JSON as the default user-facing rendering.

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
- Human growth is an optional experiment treatment. It must never be required for a mission to start, continue, distribute content, market a product, discover commerce opportunities or pass the core autonomy proof.
- Zero human budget, no eligible creator, no accepted offer, offer expiry and offer decline are valid non-human states. The operator must continue, replan, pause, notify or terminate truthfully according to policy.
- A specific rights/policy/capability gate may require human approval, but that is represented explicitly as blocked_pending_human_action rather than hidden as a marketplace dependency.

## Product-console rules

- The complete user-facing console source must live in this repository.
- A Vercel deployment, compiled bundle, screenshot or external source workspace is not source authority.
- UI is presentation over authoritative APIs.
- Frontend checks never replace server-side authorization.
- AI/Growth Operator recommendations must expose source/rationale/action-contract context.
- UNKNOWN execution outcomes remain unresolved and visible as reconciliation states.
- Integrations are discovered contextually through existing Integration/App contracts.
- The visual direction is calm, warm-light, whitespace-forward and progressively disclosed, inspired by the interaction language of ShareNet without copying its implementation.

## Evidence rule

Never report an implementation as complete because an agent says it is complete. Verify acceptance criteria with objective evidence and record limitations honestly.

## Architecture-change rule

If implementation appears to require changing a frozen rule, stop and report an Architecture Change Request requirement. Do not modify frozen architecture opportunistically.

## Runtime rules

- Persistent sandboxes are Workspace-scoped and leased to Executions.
- execution_id is never Sandbox identity.
- UNKNOWN execution outcome is unresolved, never success, and requires reconciliation.
- Non-idempotent unknown side effects must not be blindly replayed.
- Candidate-specific Job Offers are concurrency-safe.

## App rules

- Published App Versions are immutable.
- Install is workspace-scoped and policy-gated.
- Granted permissions are server-derived and revocable.
- Historical invocations retain their original App Version.
- App UI cannot directly mutate MOS core tables.

## Expected implementation style

Prefer the smallest architecture-consistent implementation. Use database constraints, CAS/version checks, append-oriented records, durable queue/outbox mechanisms, and negative regression tests for security/concurrency invariants where applicable.