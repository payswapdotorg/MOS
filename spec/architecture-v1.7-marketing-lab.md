# MOS Architecture v1.7 — Marketing Engineering Lab

Version: 1.7
Status: FROZEN
Layered on: v1.6 Growth Autonomy
Canonical purpose: learn robust marketing strategies and agent organizations in simulation, then validate and calibrate them against real platform outcomes.

## 1. Product thesis

MOS v1.7 adds a Marketing Engineering Lab.

A Marketing Lab receives a declared:
- niche;
- target platform;
- business/social objective;
- optional product, source, audience and budget context.

It constructs a representative content/idea universe, a simulated social environment and a configurable population of agent bodies. It searches for marketing strategies and agent organizations that maximize the declared objective subject to cost, rights, policy, platform and operational constraints.

The lab is a decision-support and engineering environment. Real publication remains under v1.6 Growth Mission, Integration, Policy, Rights, Distribution and Execution authorities.

## 2. Core hypothesis

The Lab treats this as a falsifiable hypothesis, not an architectural assumption:

> For a sufficiently broad and temporally appropriate niche/platform corpus, strong candidate ideas and strategy primitives are often recoverable from existing observed content, and search/recombination can outperform unconstrained idea generation.

The system MUST measure corpus coverage/saturation and retain uncertainty. It must not claim that the globally best future idea is guaranteed to exist in the collected corpus.

## 3. Authority boundaries

Existing v1.6 authorities remain singular:
- Goal;
- Growth Mission;
- Growth Operator;
- Workflow;
- Task;
- Execution;
- Evidence;
- Experiment;
- Learning;
- Policy;
- Credential;
- Integration;
- Content Rights;
- Content Asset;
- Distribution;
- Commerce;
- AI runtime.

v1.7 introduces Lab-owned simulation artifacts only:
- Lab Scenario;
- Lab Run;
- World Model Version;
- Strategy Candidate;
- Agent Organization Candidate;
- Capability Candidate;
- Calibration Record.

A Lab Run is not a business Experiment and never replaces /experiments.
A Strategy Candidate is not a Decision and never rewrites the Decision Ledger.
A simulated publication is not a real Publication.
Historical replay is evidence-backed replay; counterfactual outcomes are model output and MUST be labeled as such.

## 4. Reference-first content universe

The durable canonical corpus representation is a Content Reference plus extracted feature data, not a permanent media archive.

Content Reference contains, where available:
- provider;
- provider_content_id;
- canonical URL;
- creator/account reference;
- publication time;
- observation time;
- rights/acquisition basis;
- collection method/version;
- metadata snapshot;
- metadata digest;
- media availability state;
- feature bundle version.

The system may retain temporary media bytes only when the acquisition path and rights/policy permit it.

Provider adapters MUST enforce provider-specific acquisition constraints.
The Lab MUST NOT assume that a public URL grants permission to download, cache, transform or redistribute media.

Media access is an adapter:

Reference → permitted media access → decode/stream → feature extraction → feature bundle

Feature extraction should persist useful derived representations so repeated simulation does not require repeated media access.

## 5. Multimodal Content Feature Bundle

Feature extraction may represent:
- raw/derived visual embeddings;
- audio embeddings;
- transcript/text embeddings;
- title/description/hashtag semantics;
- thumbnail representation;
- opening-frame representation;
- hook structure;
- topic/subtopic/entity;
- problem/claim;
- curiosity gap;
- narrative structure;
- pacing;
- duration;
- scene transitions;
- visual composition;
- speaking rate;
- emotional trajectory;
- information density;
- CTA structure;
- language;
- novelty/reuse risk;
- product references;
- creator baseline;
- age-normalized performance;
- performance velocity;
- engagement;
- retention/impression metrics where available.

The exact feature set is versioned. Feature extraction is reproducible where practical and records encoder/model identity.

## 6. Idea Graph

The Lab decomposes observed content into reusable conceptual primitives.

A video may map to:
- idea;
- problem;
- claim;
- hook;
- narrative;
- visual treatment;
- audio treatment;
- packaging;
- CTA;
- timing/context.

The Idea Graph supports:
- retrieval;
- clustering;
- novelty measurement;
- recombination;
- mutation;
- analogy;
- deliberate inversion;
- gap discovery.

The system MUST distinguish:
- observed source idea;
- derived abstraction;
- generated mutation;
- combined strategy.

No generated idea is treated as source evidence merely because it resembles an observed item.

## 7. Content generation is modality-agnostic

The strategy action space may include:
- reuse where permitted;
- clip;
- crop/reframe;
- remix;
- compilation;
- commentary/reaction;
- captions/subtitles;
- translation/dubbing;
- voiceover;
- audio-only;
- anime/stylization;
- synthetic/generated video;
- synthetic/generated audio;
- original generation;
- original human performance;
- creator collaboration;
- hybrid transformations.

The Lab optimizes resulting content state and expected outcome, not production modality.

Every real output remains subject to the v1.6 Rights/Provenance and Policy gates.

## 8. Social World Model

The platform simulator is a configurable world model with:
- content universe;
- user population;
- user preferences/interests;
- user session state;
- fatigue/repetition response;
- candidate generation;
- ranking/exposure;
- recommendation behavior;
- creator competition;
- topic trends;
- temporal effects;
- freshness;
- novelty;
- account state;
- observable platform constraints;
- API/publishing constraints where relevant;
- business/product conversion behavior where relevant.

The simulator targets observable behavior, not reproduction of a platform's private implementation.

Hidden provider moderation/ranking details MUST NOT be invented as factual claims.

## 9. User and creator dynamics

The environment models interacting actors.

At minimum:
- viewers/consumers;
- the simulated MOS-operated account;
- competing creators/content sources;
- platform recommender/exposure system.

Optional domains can add:
- advertisers;
- buyers;
- product visitors;
- store/order dynamics.

The response of a user or market actor is stochastic and stateful. A simulator run MUST be able to reproduce a trajectory given a recorded seed/configuration, while supporting stochastic ensembles for uncertainty estimation.

## 10. Time Machine

The Lab supports three modes.

### Historical replay
Reconstruct the observable sequence of a historical period from retained evidence.

### Delayed-information replay
A run may specify an information lag in minutes.
At simulated time T, the agent only receives information that would have been available at or before T-lag.

### Counterfactual replay
The same historical state may branch into alternate actions.
Historical observations remain factual; counterfactual consequences are world-model estimates and MUST be labeled accordingly.

A run records:
- wall-clock/reference timestamps;
- simulated clock;
- observation cutoff;
- information lag;
- world-model version;
- random seeds.

## 11. Learning ladder

The Lab MUST NOT begin by assuming pure online RL is the correct first algorithm.

The learning stack is:

1. supervised response models from historical observations;
2. contextual bandits / off-policy evaluation;
3. offline policy learning;
4. sequential RL against the simulator;
5. model-based/counterfactual planning;
6. real-world bounded experiments;
7. simulator calibration from prediction error;
8. repeated search under updated world models.

The algorithm is replaceable. The evaluation contract is not.

## 12. Reward model

The reward is mission-specific and business-outcome-first.

A reward function may combine:
- declared target outcome;
- qualified reach;
- retention;
- audience growth;
- qualified traffic;
- conversions;
- revenue/contribution;
- downstream business events;
- content/AI/compute cost;
- API cost;
- storage/bandwidth cost;
- human/capability acquisition cost;
- policy/rights risk;
- repetition/fatigue;
- low-quality traffic;
- operational risk.

Vanity metrics MUST NOT silently replace the declared objective.

The reward definition is versioned and included in every reproducible run.

## 13. Uncertainty and simulator ensembles

A single learned simulator MUST NOT be treated as ground truth.

The Lab supports model ensembles and reports:
- expected outcome;
- uncertainty interval;
- simulator agreement/disagreement;
- out-of-distribution score;
- calibration status;
- novelty risk;
- regime-change risk.

Robust strategy selection should prefer candidates that perform acceptably across plausible world models instead of exploiting a single simulator artifact.

## 14. Agent Body

An Agent Body is MOS-owned executable structure that can be inhabited by any compatible model supplied through the existing AI runtime.

It defines:
- role contract;
- input/output contract;
- tools;
- permissions;
- memory interfaces;
- communication interface;
- action interface;
- capabilities;
- budget;
- latency limits;
- evaluation hooks;
- safety/policy constraints.

Conceptually:

Agent Body + selected LLM/model + permitted tools/capabilities = Agent Instance

The Lab MUST NOT create a second model-routing authority. Model selection is delegated to the existing AI runtime boundary.

## 15. Agent Organization

An Agent Organization is a graph of Agent Bodies and communication/delegation edges.

Search dimensions include:
- number of agents;
- role specialization;
- delegation structure;
- communication topology;
- shared versus private memory;
- critic/evaluator roles;
- tool allocation;
- model assignment;
- budget allocation;
- execution ordering;
- termination conditions.

A single generalist agent is a valid candidate and MUST be included as a baseline.

Organization search may use evolutionary search, tree search, black-box optimization, RL or combinations of these. The optimizer itself is replaceable.

## 16. Capability system

Capabilities are first-class executable contracts.

A Capability contains:
- input schema;
- output schema;
- constraints;
- quality evaluator;
- cost;
- latency;
- provenance;
- implementation/version;
- simulator implementation if available;
- real implementation if available;
- human/provider requirements.

The Lab can detect a capability gap when a candidate strategy requires an unavailable quality-preserving action.

Examples:
- a specific physical performance;
- a platform-specific action unsupported by APIs;
- an authentic human demonstration;
- a specialized visual/audio treatment.

## 17. Arena capability acquisition

Arena is an external capability provider and is NOT introduced as another MOS marketplace authority.

Flow:

Capability gap → capability contract → value estimate → governed Arena request → human/provider result → verification → capability version → simulation → real test

Arena results enter MOS through an explicit Integration/provider contract.

If Arena work ultimately uses the existing Human Agent/Job/Task/Execution plane, those existing authorities remain canonical.

Human availability is never a prerequisite for ordinary autonomous growth.

A capability acquired from a human does not automatically grant rights to use the resulting artifact beyond the explicit contract.

## 18. Real-world Experiment Bridge

The Lab may produce a candidate strategy for a real Growth Mission.

The bridge MUST:
- bind to an existing mission;
- use existing Policies;
- use existing Rights/Provenance;
- use existing Content Assets;
- use existing Distribution;
- use existing Workflow/Execution;
- use existing Social Adapters;
- use existing Evidence/Metrics/Experiments.

The Lab never posts directly to providers outside those boundaries.

Real-world experiments are bounded and auditable.

## 19. Simulator calibration

Every real experiment can provide prediction-vs-observation data.

Calibration records:
- world-model version;
- strategy candidate;
- simulated prediction;
- uncertainty;
- real outcome;
- prediction error;
- environment state;
- observed regime;
- calibration update/version.

The Lab should be able to learn that a simulator is poorly calibrated for a specific niche/platform/time regime and lower confidence accordingly.

## 20. Evaluation

Every candidate receives both outcome and engineering metrics:
- business reward;
- uncertainty;
- cost;
- latency;
- robustness across model ensemble;
- robustness across seeds;
- out-of-distribution distance;
- safety/policy compliance;
- rights feasibility;
- capability dependencies;
- reproducibility.

Benchmarks MUST include:
- single-agent baseline;
- hand-designed organization baseline;
- retrieval-only idea strategy;
- generation-only idea strategy;
- retrieval+recombination strategy;
- simulator-trained policy;
- real-world held-out experiment set where available.

## 21. Anti-gaming constraints

The Lab MUST NOT optimize toward:
- fake engagement;
- coordinated inauthentic behavior;
- anti-abuse evasion;
- platform restriction bypass;
- impersonation;
- fabricated testimonials;
- deceptive attribution;
- rights circumvention.

A simulated strategy that wins by violating a real-world constraint is invalid.

The reward and evaluator must include hard rejection gates for disallowed behavior.

## 22. Multi-tenancy and data isolation

All Lab scenarios, corpora, feature bundles, model artifacts, runs and calibration records remain tenant/workspace scoped.

Connected social-account access, product/source access and commerce access remain separate grants.

Cross-tenant content may not be silently incorporated into a tenant's proprietary search space.

Public observations may be referenced only through their permitted acquisition/usage path.

## 23. Operational constraints

The Lab is compute-heavy and must support:
- queued runs;
- resumable runs;
- deterministic seeds;
- cancellation;
- budget caps;
- concurrency limits;
- retry/idempotency;
- artifact lineage;
- retained summaries;
- optional large intermediate artifacts in approved object storage.

Long-running simulation/training MUST run through the durable worker/runtime path, not synchronous web requests or Vercel Hobby Cron.

## 24. External tooling decision

The v1.7 architecture does NOT depend on:
- CopilotKit;
- OpenMuse;
- Code-OSS.

They are deliberately excluded from the architecture.

Agent Body, Lab runtime, simulation, organization search and control-plane interfaces are MOS-owned contracts. External libraries may be used only as bounded implementation dependencies when they do not become authorities or architectural constraints.

## 25. Productization

The first productized use case is social-channel automation:

Input:
- niche;
- platform;
- business/social goal;
- optional product/context.

Output:
- discovered content/idea opportunity;
- selected strategy;
- optimized agent organization;
- required capabilities;
- simulation evidence;
- real-world experiment plan;
- ongoing learning/replanning.

The long-term product can expose this as a company-facing social automation service, while the Lab remains the underlying marketing-engineering system.

## 26. v1.7 definition of done

The first v1.7 proof is complete only when:
1. reference-first niche ingestion works;
2. multimodal feature/idea representation works;
3. simulated platform/user dynamics run deterministically and stochastically;
4. delayed-information time-machine runs work;
5. counterfactual evaluation is explicitly separated from historical fact;
6. strategy policies can be trained/evaluated;
7. agent bodies can be inhabited by interchangeable models through the existing AI runtime;
8. agent organization search compares multiple topologies;
9. capability gaps can be formalized and verified;
10. Arena/provider acquisition can add a capability without creating a second marketplace authority;
11. selected strategies can be executed through real MOS authorities;
12. real outcomes update simulator calibration;
13. robust benchmark results are reproducible;
14. zero-human-budget paths work;
15. prohibited strategies are rejected by hard gates;
16. a complete niche+platform+goal social-automation loop is demonstrated end-to-end.
