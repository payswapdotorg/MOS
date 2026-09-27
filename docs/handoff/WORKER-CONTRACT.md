# MOS Unified Worker Contract — v1.6 + v1.7

Workers operate under the Tech Lead.

## Mandatory reading

- AGENTS.md
- spec/architecture-v1.6.md
- spec/architecture-lock-v1.6.md
- spec/frozen-manifest-v1.6.json
- spec/effective-backlog-v1.6.md
- spec/architecture-v1.7-marketing-lab.md
- spec/architecture-lock-v1.7.md
- spec/frozen-manifest-v1.7.json
- spec/effective-backlog-v1.7.md
- spec/module-dependency-matrix-v1.7.md
- docs/handoff/EXECUTION-PLAN.md
- docs/handoff/IMPLEMENTATION-STATE.md
- docs/handoff/FINAL-TECH-LEAD-HANDOFF-V1.7-LAB.md
- exact assigned Work Item

## Universal rules

Architecture is frozen. Repository is source of truth. Workers implement assigned contracts and do not redesign them.

No provider SDK leakage into authorities.
No alternate workflow, execution, experiment, evidence, AI-routing or marketplace authority.
No hidden worker dependency.
Keep changes inside the assigned subtree.
TL resolves shared composition-root/schema/manifest conflicts.

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

### Agent engineering
- Agent Body is MOS-owned.
- LLMs are occupants selected through existing /ai-runtime.
- Generalist baseline is mandatory.
- Organization search can vary roles/topology/tools/memory/model assignment.
- Capabilities have explicit contract, evaluation, provenance, cost and latency.
- Arena is provider integration, not a MOS marketplace.

### Real execution
- Lab never publishes directly.
- Real experiments use existing Mission/Policy/Rights/Asset/Distribution/Integration/Workflow/Execution.
- Real observations use existing Evidence/Metrics/Experiment.
- Calibration never rewrites history.

### Safety
Reject fake engagement, impersonation, rights circumvention, anti-abuse evasion and policy-violating simulator strategies.

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
- includes browser evidence for UI changes;
- discloses provider/environment limitations;
- does not claim downstream completion from upstream artifacts.

## Excluded architecture dependencies

Do not add CopilotKit, OpenMuse or Code-OSS as v1.7 architectural dependencies.