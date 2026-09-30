# Final Tech Lead Handoff — MOS Marketing Engineering Lab v1.7 + Content Studio

## Current repository posture

Repository: payswapdotorg/MOS
Architecture: v1.7 Marketing Engineering Lab, frozen with CR-007 content-production amendment
Manifest revision: 1.7.1
Maximum workers: 3

The repository is the unique source of truth. Historical worker reports, chat context, PR descriptions and screenshots are evidence only.

## Read in order

1. AGENTS.md
2. spec/change-request-007-content-production-studio.md
3. spec/architecture-v1.6.md
4. spec/architecture-lock-v1.6.md
5. spec/frozen-manifest-v1.6.json
6. spec/effective-backlog-v1.6.md
7. spec/architecture-v1.7-marketing-lab.md
8. spec/content-studio-contract-v1.0.md
9. spec/architecture-lock-v1.7.md
10. spec/frozen-manifest-v1.7.json
11. spec/effective-backlog-v1.7.md
12. spec/module-dependency-matrix-v1.7.md
13. docs/handoff/IMPLEMENTATION-STATE.md
14. docs/handoff/WORKER-CONTRACT.md
15. docs/handoff/EXECUTION-PLAN.md
16. exact Work Item.

## Current delivered v1.7 items

✅ LAB-001
✅ LAB-002
✅ LAB-011

The exact current v1.6/UX verification state is in IMPLEMENTATION-STATE and must be reconciled against main before dispatch.

## Mission

Given:
niche + platform + business/social goal

MOS must be able to discover a complete marketing production program, not just a post idea:
- idea/source;
- no-op/repost or transformation;
- transform graph;
- Transform Pawn Agents;
- Agent Organization;
- model assignments through /ai-runtime;
- capabilities;
- human contribution requirements;
- Studio format/configuration;
- production acceptance criteria;
- waiting/stopping economics.

It then simulates/evaluates the program, invokes production where needed, runs a bounded real experiment through existing MOS authorities, measures the result and calibrates the simulator.

## Non-negotiable boundaries

- v1.6 authorities remain singular.
- Lab Run is not a real Experiment.
- Studio Session is not a Workflow/Execution engine.
- Studio is not a publishing, Rights, Policy, Evidence, Experiment, AI-router or marketplace authority.
- Lab and Studio never publish directly.
- Transform Pawn Agents use the existing Agent Body runtime.
- LLM selection remains under /ai-runtime.
- Public URLs do not imply media rights.
- Human output rights are explicit; recording does not create unrestricted reuse rights.
- Human participation is optional and economically bounded.
- Waiting can be abandoned when delay is not worth expected value.
- Prohibited strategies are invalid regardless of simulated reward.
- CopilotKit, OpenMuse and Code-OSS remain excluded architectural dependencies.

## Production architecture

Lab
→ Production Strategy
→ {idea/source, transform graph, organization, pawns, capabilities, human tasks, Studio format, budget/delay policy}
→ Studio/Arena/automated capability
→ raw/intermediate artifacts
→ selected organization
→ final Artifact Package
→ Lab acceptance/treatment
→ existing MOS real-experiment authorities
→ evidence/experiment
→ calibration
→ next Lab run.

## Content Studio

Content Studio is one shared runtime with two entry modes:
- standalone user creation;
- Lab-initiated production.

Initial formats:
- reaction;
- audio podcast;
- video podcast.

Standalone user flow:
intent or script/questions
→ format
→ organization
→ interview/capture
→ processing
→ review/re-take
→ final Artifact Package.

Lab flow:
discovered Production Request
→ Studio
→ organization execution
→ Artifact Package
→ Lab evaluation.

## Podcast requirements

One-person:
- AI/synthetic/prerecorded/voice/text/avatar/hybrid interviewer;
- adaptive follow-up;
- provenance of interviewer representation.

Multi-person:
- multiple authorized accounts/devices;
- participation grants;
- per-participant identity/credential boundaries;
- consent/withdrawal handling;
- contribution provenance.

## Reaction requirements

Raw user capture can be passed to an organization that composes it with the source using a learned/layout-configurable strategy such as:
- bottom-left PIP;
- source-first then reaction;
- alternating;
- clipped source then response.

The exact composition is data/organization output, not a hard-coded universal rule.

## Human task requirements

A Lab-discovered human contribution produces:
script/questions + source material + capture brief + target format + output contract + consent/rights + quality criteria + deadline + delay economics + substitutions.

The result re-enters the organization as an intermediate artifact.

## Verification and harvest

A Work Item is green only after source/tests/runtime and applicable browser/deployment evidence agree.

For Studio work, record:
- Production Request version;
- Studio Session version;
- format version;
- organization version;
- transform graph version;
- capability versions;
- human task version;
- artifact/treatment lineage;
- costs/durations;
- acceptance/rejection/treatment result.

The Tech Lead must reject "complete" claims that omit real runtime evidence or hide doubles/placeholders as production implementations.

## Mandatory end-to-end proof

At least one complete scenario must show:
1. broad niche corpus;
2. Idea Graph;
3. transform search including no-op;
4. Transform Pawn execution;
5. organization search;
6. one-person podcast;
7. multi-person podcast;
8. human reaction recording;
9. organization treatment of raw human output;
10. Lab rejection and treatment;
11. delay-based abandonment;
12. zero-human alternative;
13. real MOS experiment;
14. real measurement;
15. calibration;
16. second improved run.

