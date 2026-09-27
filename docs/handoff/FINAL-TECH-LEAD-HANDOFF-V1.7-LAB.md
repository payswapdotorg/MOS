# Final Tech Lead Handoff — MOS Marketing Engineering Lab v1.7

## Current base

Repository: payswapdotorg/MOS
v1.7 architecture base: 10f51781f8d198cd07c19259f722c1aeab7ac8e6
v1.7 implementation status: 0 LAB items complete
Maximum workers: 3

## Read in order

1. AGENTS.md
2. spec/architecture-v1.6.md
3. spec/architecture-lock-v1.6.md
4. spec/frozen-manifest-v1.6.json
5. spec/effective-backlog-v1.6.md
6. spec/architecture-v1.7-marketing-lab.md
7. spec/architecture-lock-v1.7.md
8. spec/frozen-manifest-v1.7.json
9. spec/effective-backlog-v1.7.md
10. spec/module-dependency-matrix-v1.7.md
11. docs/handoff/EXECUTION-PLAN.md
12. docs/handoff/IMPLEMENTATION-STATE.md
13. docs/handoff/WORKER-CONTRACT.md
14. docs/research/MARKETING-LAB-DESIGN-BASIS.md

## Mission

Build a marketing-engineering system that can take:
niche + platform + goal

and discover:
- strong ideas from a broad reference-first niche corpus;
- a robust content/marketing strategy;
- the Agent Body organization best suited to the task;
- model assignments;
- required capabilities;
- when a human/provider capability is worth acquiring;
- a candidate worth testing on the real platform.

Then learn from the real result and improve the simulator.

## Non-negotiable architecture

- v1.6 remains frozen and authoritative.
- Lab simulation is not real Experiment/Execution.
- Lab never publishes directly.
- Social provider calls go through existing adapters.
- Business experiments go through Mission/Policy/Rights/Distribution/Workflow/Execution.
- Evidence/Experiment/Learning remain canonical for real outcomes.
- Media corpus is reference-first and rights/provider gated.
- Historical facts and counterfactual predictions are visibly distinct.
- Time Machine must enforce the information cutoff.
- Reward is versioned and business-outcome-first.
- World-model uncertainty/OOD/robustness are first-class.
- Agent Body is MOS-owned; LLMs are interchangeable occupants through /ai-runtime.
- Generalist single-agent baseline is mandatory.
- Agent Organization is a searchable graph, not a workflow engine.
- Capabilities are explicit, evaluated contracts.
- Arena is an external provider behind Integration.
- Zero human budget must remain a valid path.
- Fake engagement, anti-abuse evasion, impersonation and rights circumvention are invalid.
- CopilotKit, OpenMuse and Code-OSS are excluded.

## Worker A

MKT-060/061 + LAB-002..010 + LAB-015.

Own social adapters and the entire corpus/simulation/world-model pipeline.

## Worker B

MKT-065 defect + MKT-066/070/072/073 + LAB-011/012/013.

Own growth backend completion plus Agent Body, organization search and capabilities.

## Worker C

UX-005..012 + MKT-074/075 + LAB-014/016/017/018.

Own the shared console composition root, real-world bridge, marketing automation UX and final proof.

## Parallelization rules

Workers stay inside assigned subtrees.
Do not concurrently modify the same central schema/migration/composition files.
Workers submit module-local contracts first when a shared surface is unavoidable.
TL performs the final integration of shared surfaces.

Independent work may start as soon as frozen dependencies are satisfied; do not wait for unrelated sequential work.

## Lab workflow

Historical corpus
→ feature extraction
→ Idea Graph
→ Social World Model
→ offline evaluation
→ RL/policy search
→ Agent Organization search
→ capability gap detection
→ Arena/provider acquisition if needed
→ robust simulation
→ real MOS experiment
→ measurement
→ calibration
→ repeat.

## Strategy-space requirement

Always compare:
- generate from scratch;
- retrieve;
- retrieve + transform;
- retrieve + recombine;
- retrieve + mutate;
- hybrid approaches.

Do not hard-code the belief that the next best idea must already exist in the corpus. Measure coverage and test that hypothesis.

## Media requirement

Store references/features by default.
Do not promise universal redownloadability of social URLs.
Use temporary streaming/access only when the provider and rights permit it.

## Agent requirement

A body is independent of the model inhabiting it.

Agent Body:
role + tools + permissions + memory + communication + evaluation + budget + capabilities.

Then:
Agent Body + LLM = Agent Instance.

Organization search can alter:
number of agents, roles, graph topology, memory sharing, delegation, tool allocation and model assignment.

## Time Machine requirement

Support:
- historical replay;
- delayed-information replay with user-selected lag;
- counterfactual branching.

Future leakage is a hard failure.

## Real-world learning requirement

Every selected real experiment records the simulated prediction and uncertainty, then the actual outcome.
The simulator must be versioned/calibrated from prediction error.
A later run must be able to use the calibrated state.

## Capability requirement

The system must be able to say:
"This strategy requires capability X."
Then:
"X is unavailable."
Then:
"Acquire X through Arena/provider."
Then verify, version, simulate and potentially use it.

A capability acquired through a human/provider does not grant unspecified content rights.

## Mandatory proof

At least one complete niche+platform+goal scenario must demonstrate:
- reference-first corpus;
- Idea Graph;
- simulator;
- delayed Time Machine;
- counterfactual;
- policy learning;
- organization search;
- interchangeable LLM occupancy;
- capability gap;
- optional Arena path;
- robust evaluation;
- real bounded post;
- measured outcome;
- calibration;
- second improved run;
- zero-human path;
- rejection of a prohibited strategy.

## Existing v1.6 blocker

MKT-065 HTTP dispatch/audit route correctness must be fixed before MKT-075 final acceptance.

## Definition of done

The system is not done because an RL trainer or simulator runs.

It is done when the full closed loop is demonstrated and the real-world experiment changes the subsequent simulator/strategy state with auditable provenance.
