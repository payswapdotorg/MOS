# MarketingOS

Status: v1.6 implementation in progress; v1.7 Marketing Engineering Lab architecture frozen
Current Architecture: 1.7 layered on 1.6
Repository: payswapdotorg/MOS

MarketingOS is a provider-independent, evidence-driven, multi-tenant Growth and Marketing Operating System.

## v1.6 verified on main @ 10f51781f8d198cd07c19259f722c1aeab7ac8e6

- ✅ MKT-001..052
- ✅ MKT-053 Growth Mission
- ✅ MKT-054 Growth Operator
- ✅ MKT-055 Social Account / OAuth
- ✅ MKT-056 Social Adapter Contract
- ✅ MKT-057 YouTube
- ✅ MKT-058 Instagram
- ✅ MKT-059 Facebook Pages
- ✅ MKT-062 Research / Content Intelligence
- ✅ MKT-063 Rights / Provenance
- ✅ MKT-064 Content Assets / Transformations
- ✅ MKT-065 Distribution authority (known HTTP audit correctness defect remains)
- ✅ MKT-067 Experiment Analysis / Adaptive Allocation
- ✅ MKT-068 Notifications
- ✅ MKT-069 Product Intelligence
- ✅ MKT-071 Commerce Catalog / Orders
- ✅ UX-001 Outcome-first Home
- ✅ UX-002 Mission Creation
- ✅ UX-003 Mission Workspace
- ✅ UX-004 Scientific Trace

Remaining v1.6 core:
- ☐ MKT-060 TikTok
- ☐ MKT-061 X
- ☐ MKT-066 Platform Health
- ☐ MKT-070 Product Marketing Mission Planner
- ☐ MKT-072 Commerce Discovery
- ☐ MKT-073 Social-to-Commerce Attribution
- ☐ MKT-074 Growth Autopilot Console
- ☐ MKT-075 v1.6 End-to-End Autonomy Proof
- ☐ UX-005..UX-012

Optional:
- ☐ MKT-076..078

## v1.7 Marketing Engineering Lab

Frozen architecture:
- spec/architecture-v1.7-marketing-lab.md
- spec/architecture-lock-v1.7.md
- spec/frozen-manifest-v1.7.json

Frozen execution:
- spec/effective-backlog-v1.7.md
- spec/module-dependency-matrix-v1.7.md
- docs/handoff/FINAL-TECH-LEAD-HANDOFF-V1.7-LAB.md

Core loop:

niche + platform + goal
→ reference-first corpus
→ multimodal features + Idea Graph
→ Social World Model
→ strategy learning/search
→ Agent Body / Organization search
→ capability acquisition if needed
→ robust simulation
→ real bounded experiment
→ calibration
→ repeat

First productized application: company social-media automation.

## Architecture boundaries

- Lab Runs are simulation artifacts, not business Experiments.
- Historical replay is evidence-backed; counterfactuals are labeled model output.
- Media access is provider/rights gated.
- Agent Body is MOS-owned; LLMs remain under /ai-runtime.
- Arena is an external capability provider through Integration.
- Zero-human-budget operation remains valid.
- Fake engagement, rights circumvention, impersonation and anti-abuse evasion are forbidden.
- CopilotKit, OpenMuse and Code-OSS are not architectural dependencies.

## Repository truth

Architecture branch base: 10f51781f8d198cd07c19259f722c1aeab7ac8e6

Production observed in the September 22 audit:
dpl_5MfdkKM631cTvDTw4V1NYNq2xyU3
commit 0cc7d51b0af5a4ee203f75157978e73fc9024fdf

Production promotion remains a separate acceptance gate.

## Canonical handoff

- docs/handoff/EXECUTION-PLAN.md
- docs/handoff/IMPLEMENTATION-STATE.md
- docs/handoff/WORKER-CONTRACT.md
- docs/handoff/FINAL-TECH-LEAD-HANDOFF-V1.7-LAB.md