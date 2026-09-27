# MOS v1.7 Module Dependency / Ownership Matrix

| Work | Authority / scope | Depends on | Worker |
|---|---|---|---|
| LAB-001 | frozen Lab contracts/run model | v1.6 frozen architecture | TL |
| MKT-060 | TikTok adapter | MKT-056 | A |
| MKT-061 | X adapter | MKT-056 | A |
| LAB-002 | niche corpus | LAB-001, MKT-062, MKT-056 | A |
| LAB-003 | multimodal features | LAB-002 | A |
| LAB-004 | Idea Graph | LAB-003 | A |
| LAB-005 | simulator kernel | LAB-001, LAB-003 | A |
| LAB-006 | user/creator dynamics | LAB-005 | A |
| LAB-007 | Time Machine | LAB-005, LAB-006, MKT-062 | A |
| LAB-008 | world-model ensemble | LAB-005,006,007 | A |
| LAB-009 | offline evaluation/bandits | LAB-008, MKT-067 | A |
| LAB-010 | sequential strategy RL | LAB-009 | A |
| LAB-015 | simulator calibration | LAB-008, LAB-014 | A |
| MKT-066 | platform health | concrete adapters + baseline metrics | B |
| MKT-070 | product marketing planner | MKT-053,062,066,067,069 | B |
| MKT-072 | commerce discovery | MKT-053,062,063,065,067,071 | B |
| MKT-073 | social-commerce attribution | MKT-065,071,072,052 | B |
| LAB-011 | Agent Body | LAB-001, /ai-runtime | B |
| LAB-012 | organization search | LAB-010, LAB-011 | B |
| LAB-013 | capability engine/Arena | LAB-001, LAB-011 | B |
| MKT-065 defect fix | HTTP dispatch/audit correctness | existing MKT-065 | B |
| UX-005..012 | console/user journeys | v1.6 authorities as they become available | C |
| MKT-074 | Growth Autopilot Console | v1.6 capability set + console APIs | C |
| MKT-075 | v1.6 autonomy proof | 054,065,067,068,070,072,073,074 | C+TL |
| LAB-014 | Lab → real MOS experiment | LAB-010, LAB-012, MKT-053,065,067 | C |
| LAB-016 | robust benchmark | LAB-008,009,010,012,015 | C |
| LAB-017 | strategy compiler/social automation surface | LAB-012,013,014, MKT-074 | C |
| LAB-018 | closed-loop Lab proof | LAB-015,016,017, MKT-075 | C+TL |

## Ownership boundaries

### Worker A — Social capability + Data/World Models
Own MKT-060/061 and LAB-002..010, LAB-015.

Worker A owns the provider adapter subtrees for TikTok/X and all Lab corpus/simulation/world-model code. It must not own shared console composition.

### Worker B — Growth Backend + Agent Engineering
Own MKT-066/070/072/073, MKT-065 defect fix, LAB-011/012/013.

Worker B owns backend/domain contracts and Agent Body/capability code. It uses /ai-runtime and existing Integration/Job authorities.

### Worker C — UX + Real-World Integration + Proof
Own UX-005..012, MKT-074/075, LAB-014/016/017/018.

Worker C owns the shared console composition root.

### Tech Lead only
TL owns:
- frozen architecture/manifest edits;
- dependency conflict resolution;
- central schema conflicts;
- composition-root registration when multiple workers collide;
- final acceptance and merge ordering.

## Forbidden dependency directions

- Lab simulator → direct social provider
- Lab → direct publication
- Agent Body → direct secret/credential store
- Agent Organization → Workflow/Execution replacement
- Capability provider → second MOS marketplace
- Strategy Candidate → Decision Ledger replacement
- Console → direct domain-table mutation
- LLM/provider → domain authority
