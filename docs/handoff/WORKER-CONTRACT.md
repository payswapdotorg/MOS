# MOS Unified Worker Contract — v1.6 + v1.7

Workers operate under the Tech Lead.

## Mandatory reading

1. AGENTS.md
2. spec/change-request-007-content-production-studio.md
3. spec/architecture-v1.6.md
4. spec/architecture-lock-v1.6.md
5. spec/frozen-manifest-v1.6.json
6. spec/effective-backlog-v1.6.md
7. spec/architecture-v1.7-marketing-lab.md
8. spec/content-studio-contract-v1.0.md (for Studio work)
9. spec/architecture-lock-v1.7.md
10. spec/frozen-manifest-v1.7.json
11. spec/effective-backlog-v1.7.md
12. spec/module-dependency-matrix-v1.7.md
13. docs/handoff/EXECUTION-PLAN.md
14. docs/handoff/IMPLEMENTATION-STATE.md
15. docs/handoff/FINAL-TECH-LEAD-HANDOFF-V1.7-LAB.md
16. exact assigned Work Item

## Universal rules

Architecture is frozen. Repository is source of truth. Workers implement assigned contracts and do not redesign them.

Actual source, tests, migrations, runtime behavior and relevant browser/deployment evidence outrank reports, PR descriptions and screenshots.

No provider SDK leakage into authorities.
No alternate workflow, execution, experiment, evidence, AI-routing, rights/policy or marketplace authority.
No hidden worker dependency.
Keep changes inside the assigned subtree.
TL resolves shared composition-root/schema/manifest/migration conflicts.
A downstream worker MUST NOT declare an upstream Work Item complete by inference.

## v1.7 Lab rules

### Data/simulation
- Reference-first corpus.
- Media access is provider/rights gated.
- Features preserve source linkage.
- Idea Graph separates observed facts from derived/generated abstractions.
- Simulator state is versioned and reproducible.
- Time-machine lag prevents future leakage.
- Counterfactuals disclose model/version/uncertainty.
- Offline/off-policy evaluation precedes online RL.
- Ensemble/OOD/robustness are required.
- Simulator cannot be treated as ground truth.
- Reward is business-outcome-first and versioned.

### Production strategy
- The strategy space includes no-op/repost.
- Transform definitions are contracts with inputs, outputs, parameters, lineage, rights, cost, latency and evaluators.
- Transform graphs may compose existing transforms or represent newly discovered transforms.
- A newly discovered transform must be versioned and evaluated before reusable promotion.
- Transform Pawn Agents use the existing Agent Body runtime.
- Organizations can contain transformation/editor/composition pawns.
- Human contributions are explicit capability/production tasks, never implicit blockers.
- Expected value of delay controls wait/substitute/retry/abandon decisions.
- Abandoned production branches remain auditable.

### Content Studio
- Content Studio is MOS-owned and supports standalone and Lab-initiated sessions.
- Initial formats are reaction, audio podcast and video podcast.
- Format support is pluggable; no second Studio runtime for new formats.
- Studio can load any submitted organization that satisfies the Studio compatibility contract.
- Standalone users can provide a script/question list or only an intent.
- A single-person podcast may use voice, text, avatar, prerecorded, generated or hybrid interviewer representations.
- Adaptive interviewer follow-ups preserve the question/answer graph.
- Multi-person sessions may span multiple authorized MOS accounts/devices with explicit participation grants.
- Participant credentials are never merged; identity, consent and provenance stay scoped.
- Raw human captures are intermediate artifacts and may be transformed/composed by the loaded organization.
- Studio output is immutable/versioned; treatment creates a new linked output.
- Lab acceptance/rejection is distinct from Rights/Policy rejection.
- Studio never publishes directly and never replaces Workflow/Execution/Experiment/Evidence/Policy/Rights.

### Real execution
- Lab never publishes directly.
- Real experiments use existing Mission/Policy/Rights/Asset/Distribution/Integration/Workflow/Execution.
- Real observations use existing Evidence/Metrics/Experiment.
- Calibration never rewrites history.
- Studio-originating real publication uses the same v1.6 authority path as all other content.

## Safety

Reject fake engagement, impersonation, fabricated testimonials, rights circumvention, anti-abuse evasion, deceptive attribution and policy-violating strategies.

## Browser contract

Every presentation change verifies 390x844 and 1280x800, real APIs/auth, meaningful content, no raw JSON, no horizontal overflow, no page/browser errors, truthful empty/error/blocked states and a clear next action.

Use the repository's agent-browser verification workflow after starting the dev server.

## PR contract

Every PR:
- targets current main;
- names exact Work Items;
- lists changed files;
- maps acceptance criteria to evidence;
- records exact tests/runtime evidence;
- records Lab seed/model/world/reward versions when applicable;
- records Studio request/session/organization/format versions when applicable;
- records production delay/cost/stopping decisions when applicable;
- includes browser evidence for UI changes;
- discloses provider/environment limitations;
- does not claim downstream completion from upstream artifacts.

## Excluded architecture dependencies

Do not add CopilotKit, OpenMuse or Code-OSS as v1.7 architectural dependencies.

## Central-file rule

Do not concurrently modify shared architecture/manifest/central application registration/migration-checker/composition files. Deliver module-local code first; TL performs canonical promotion and re-pins.
