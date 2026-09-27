# MarketingOS Implementation Rules

This repository is the architecture and implementation source of truth for MOS. It is not permission for implementation agents to redesign frozen architecture.

## Before implementing any Work Item

1. README.md
2. spec/frozen-manifest-v1.6.json
3. spec/architecture-v1.6.md
4. spec/architecture-lock-v1.6.md
5. spec/change-request-006.md
6. spec/effective-backlog-v1.6.md
7. spec/module-dependency-matrix-v1.6.md
8. spec/frozen-manifest-v1.7.json
9. spec/architecture-v1.7-marketing-lab.md
10. spec/architecture-lock-v1.7.md
11. spec/effective-backlog-v1.7.md
12. spec/module-dependency-matrix-v1.7.md
13. applicable v1.5 frozen documents and explicit supersessions
14. applicable v1.5 dependency / traceability / security / module matrices
15. docs/architecture/IMPLEMENTATION-GOVERNANCE.md
16. docs/product/PRODUCT-CONSOLE-V1.6.md
17. docs/handoff/IMPLEMENTATION-STATE.md
18. docs/handoff/EXECUTION-PLAN.md
19. docs/handoff/WORKER-CONTRACT.md
20. docs/handoff/UX-DISCOVERY-V1.6.md
21. docs/handoff/DEPLOYMENT-PLAN-V1.6.md
22. docs/handoff/FINAL-TECH-LEAD-HANDOFF-V1.7-LAB.md
23. the exact Work Item / task

Actual Git history, source, tests, migrations and provider verification outrank summaries, screenshots, PR descriptions and stale coordination documents.

## Unified rules

- v1.5, v1.6 and v1.7 are one implementation program under the canonical execution plan.
- v1.7 is additive to frozen v1.6; changing frozen rules requires an Architecture Change Request.
- Growth Mission/Growth Operator never become a second workflow or execution engine.
- Existing Workflow, Task, Execution, Evidence, Experiment, Learning, Policy, Credential, Job, Integration and Client/Workspace authorities remain singular.
- No provider SDK leaks into domain/application authorities.
- Optional human growth never becomes a prerequisite for autonomous growth.
- No Lab, model, agent organization, extension, app or frontend may become an alternate core authority.

## v1.6 rules

- Social platforms use explicit MKT-056 adapters with declared capability matrices.
- Rights uncertainty fails closed for autonomous publication.
- Content lineage is mandatory for derived assets.
- Platform Health describes observable signals only.
- Shadow-ban language requires provider-confirmed restriction.
- Platform adaptation is compliant only; no fake engagement, impersonation or anti-abuse evasion.
- Product/source/store credentials remain separate least-privilege grants.
- Attribution is distinct from causality.
- Business outcomes outrank vanity metrics.

## v1.7 Marketing Engineering Lab rules

- The Lab receives niche + platform + goal and searches a representative strategy space.
- "The best idea is in the corpus" is a falsifiable hypothesis, never a guarantee.
- Durable corpus is reference-first; media retention/access is provider/rights gated.
- Public URLs and social connections do not grant media rights.
- Multimodal feature bundles and Idea Graph abstractions are versioned and source-linked.
- Historical replay is evidence-backed; counterfactual output is model output.
- Time-machine lag prevents future information leakage.
- Learning is staged: response modeling/off-policy evaluation before online RL.
- Reward functions are versioned and business-outcome-first.
- Ensemble, OOD and robustness checks precede real deployment of a candidate.
- Agent Body is MOS-owned; model selection remains under /ai-runtime.
- Agent Organization is a graph of Agent Bodies, not a workflow engine.
- Generalist single-agent baseline is mandatory.
- Capabilities are explicit contracts with evaluation, cost, latency and provenance.
- Arena is an external capability provider behind Integration, not a MOS marketplace authority.
- Real execution always uses existing MOS Mission/Policy/Rights/Assets/Distribution/Integration/Workflow/Execution authorities.
- Simulator calibration cannot rewrite historical observations.
- Strategies that violate rights, policy or anti-gaming constraints are invalid regardless of simulated reward.
- CopilotKit, OpenMuse and Code-OSS are excluded architecture dependencies.
- Long-running simulation/training uses durable worker infrastructure, not synchronous requests or Vercel Hobby Cron.

## UX / evidence

- Outcome-first entry: Grow, Market, Find a Product, Leads, Revenue, Continue Mission.
- Every empty/error/blocked state explains what is missing and what to do next.
- UI is presentation over authoritative APIs.
- Presentation changes require real browser evidence at 390x844 and 1280x800.
- Never make raw JSON the default UI.
- Never mark work complete from an agent report alone; source, tests, runtime and relevant browser/deployment evidence must agree.

## Implementation style

Prefer the smallest architecture-consistent implementation. Use database constraints, CAS/version checks, append-oriented records, durable queues/outboxes, deterministic seeds and negative security/concurrency/anti-gaming tests.