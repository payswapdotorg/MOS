# Marketing Engineering Lab — Research and Design Basis

This document records research precedents used to shape v1.7. These are design references, not architectural dependencies.

## Recommender / environment simulation

- Google Research — RecSim: configurable simulation platform for recommender systems
  https://research.google/pubs/recsim-a-configurable-simulation-platform-for-recommender-systems/
- Google Research — RecSim NG: flexible, scalable, differentiable simulation of recommender systems
  https://research.google/blog/flexible-scalable-differentiable-simulation-of-recommender-systems-with-recsim-ng/
- Google Research — SlateQ / slate-based recommender reinforcement learning
  https://research.google/pubs/reinforcement-learning-for-slate-based-recommender-systems-a-tractable-decomposition-and-practical-methodology/

Design implications for MOS:
- model users as stateful/stochastic actors;
- model exposure/ranking as part of the environment;
- evaluate sequential rather than one-step outcomes;
- separate simulator behavior from real platform internals.

## Offline / counterfactual evaluation

- Open Bandit Dataset / off-policy evaluation benchmark
  https://arxiv.org/abs/2008.07146
- Criteo Uplift Modeling Dataset
  https://ailab.criteo.com/criteo-uplift-prediction-dataset/

Design implications:
- historical logs do not automatically identify counterfactual outcomes;
- disclose logging-policy support and OOD risk;
- use controlled experiments to close the simulation-to-reality gap.

## Agent roles / organization search

- ROMA: Learning Latent Roles for Cooperative Multi-Agent Reinforcement Learning
  https://proceedings.mlr.press/v119/wang20f.html
- R3DM: role discovery linked to multi-agent dynamics
  https://proceedings.mlr.press/v267/goel25a.html
- AFlow: Automating Agentic Workflow Generation
  https://arxiv.org/abs/2410.10762
- EvoAgentX: evolutionary optimization of agentic workflows
  https://arxiv.org/abs/2504.07828

Design implications:
- roles need not be permanently hand-authored;
- topology, delegation and communication can be search dimensions;
- generalist and hand-designed organizations remain required baselines;
- the optimizer can be evolutionary/tree-search/black-box before it is pure RL.

## Program / strategy search

- Google DeepMind — AlphaEvolve
  https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/

Design implication:
- retain executable candidates plus evaluator outputs;
- search over strategy/program structure can be a first-class optimization loop.

## World models

- World-model based reinforcement learning literature provides the general pattern of learning a compact environment model from experience and planning inside that model.
- MOS must additionally maintain explicit OOD detection, uncertainty, calibration and real-world validation because social platforms are non-stationary and partially observed.

## MOS-specific synthesis

The v1.7 architecture therefore uses:

historical observations
→ multimodal content representation
→ response/world models
→ offline evaluation
→ simulator policy learning
→ agent-organization search
→ robust simulation
→ bounded real experiment
→ prediction-error calibration
→ repeat

The research references do not override MOS's frozen authority, rights, policy, tenancy or provider-boundary rules.
