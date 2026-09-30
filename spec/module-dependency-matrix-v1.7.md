# MOS v1.7 Module Dependency / Ownership Matrix

Status: FROZEN
Architecture: 1.7 / manifest revision 1.7.1

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
| LAB-008 | world-model ensemble | LAB-005, LAB-006, LAB-007 | A |
| LAB-009 | offline evaluation/bandits | LAB-008, MKT-067 | A |
| LAB-010 | sequential strategy RL | LAB-009 | A |
| LAB-015 | simulator calibration | LAB-008, LAB-014 | A |
| LAB-019 | transform definitions + transform graph/discovery | LAB-003, LAB-004 | A |
| MKT-066 | platform health | concrete adapters + baseline metrics | B |
| MKT-070 | product marketing planner | MKT-053, MKT-062, MKT-066, MKT-067, MKT-069 | B |
| MKT-072 | commerce discovery | MKT-053, MKT-062, MKT-063, MKT-065, MKT-067, MKT-071 | B |
| MKT-073 | social-commerce attribution | MKT-065, MKT-071, MKT-072, MKT-052 | B |
| LAB-011 | Agent Body runtime | LAB-001, /ai-runtime | B |
| LAB-012 | Agent Organization search | LAB-010, LAB-011 | B |
| LAB-013 | capability engine/Arena | LAB-001, LAB-011 | B |
| LAB-020 | Transform Pawn Agents | LAB-011, LAB-019 | B |
| LAB-021 | human production task packages | LAB-019, LAB-020, LAB-013 | B |
| LAB-024 | production bottleneck / expected-delay economics | LAB-010, LAB-013, LAB-021 | B |
| MKT-065 defect | HTTP dispatch/audit correctness | existing MKT-065 | B |
| STUDIO-001 | Content Studio runtime | LAB-011, v1.6 Content Asset/Rights boundaries | C |
| STUDIO-002 | pluggable format framework | STUDIO-001 | C |
| STUDIO-003 | intent → script/question graph | STUDIO-001, LAB-011 | C |
| STUDIO-004 | adaptive interviewer | STUDIO-003, LAB-020 | C |
| STUDIO-005 | single-person podcast production | STUDIO-004, STUDIO-007, STUDIO-008 | C |
| STUDIO-006 | multi-account production sessions | STUDIO-001, STUDIO-007 | C |
| STUDIO-007 | audio/video capture | STUDIO-001 | C |
| STUDIO-008 | AI editing/composition | STUDIO-007, LAB-020 | C |
| STUDIO-009 | organization loader/compatibility | STUDIO-001, LAB-011 | C |
| STUDIO-010 | artifact package/provenance | STUDIO-005, STUDIO-006, STUDIO-008, STUDIO-009 | C |
| STUDIO-011 | Reaction format | STUDIO-002, STUDIO-007, STUDIO-008 | C |
| STUDIO-012 | Podcast format | STUDIO-002, STUDIO-003, STUDIO-004 | C |
| STUDIO-013 | Audio podcast variant | STUDIO-005, STUDIO-012 | C |
| STUDIO-014 | Video podcast variant | STUDIO-005, STUDIO-012 | C |
| LAB-022 | Lab → Studio production bridge | LAB-019, LAB-020, LAB-021, LAB-024, STUDIO-009, STUDIO-010, STUDIO-011, STUDIO-012 | C |
| LAB-023 | Studio output evaluation/treatment | LAB-008, LAB-009, LAB-022 | C |
| LAB-014 | Lab → MOS real experiment | LAB-010, LAB-012, LAB-022, LAB-023, MKT-053, MKT-065, MKT-067 | C |
| LAB-016 | robust marketing benchmark | LAB-008, LAB-009, LAB-010, LAB-012, LAB-015, LAB-019, LAB-020, LAB-023 | C |
| LAB-017 | strategy compiler/social automation surface | LAB-012, LAB-013, LAB-014, LAB-022, LAB-023, MKT-074 | C |
| LAB-018 | closed-loop Marketing Engineering proof | LAB-015, LAB-016, LAB-017, MKT-075, STUDIO-011, STUDIO-013, STUDIO-014 | C |
| UX-005..012 | console/user journeys | v1.6 authorities + applicable Lab/Studio contracts | C |
| MKT-074 | Growth Autopilot Console | v1.6 capability set + console APIs | C |
| MKT-075 | v1.6 autonomy proof | MKT-054, MKT-065, MKT-067, MKT-068, MKT-070, MKT-072, MKT-073, MKT-074 | C+TL |

## Ownership boundaries

### Worker A — Social capability + Data/World Models
Own MKT-060/061 and LAB-002..010, LAB-015, LAB-019.

Worker A owns provider adapter subtrees for TikTok/X and the corpus/simulation/world-model/transform-discovery pipeline. It does not own shared console composition or Studio runtime code.

### Worker B — Growth Backend + Agent Engineering
Own MKT-065 defect, MKT-066/070/072/073, LAB-011/012/013/020/021/024.

Worker B owns Agent Body, organization search, capability/pawn execution, human task packages and bottleneck economics. It uses /ai-runtime and existing Integration/Job authorities. It does not own Studio runtime files.

### Worker C — Content Studio + UX + Real-World Integration
Own STUDIO-001..014, UX-005..012, MKT-074/075, LAB-014/016/017/018/022/023.

Worker C owns the shared frontend composition root and all Studio production/runtime/bridge/proof code.

### Tech Lead only
TL owns:
- frozen architecture/manifest edits;
- change-request promotion;
- dependency conflict resolution;
- central schema/migration conflicts;
- composition-root registration when multiple workers collide;
- final source/test/runtime/browser/deployment acceptance.

## Forbidden dependency directions

- Lab simulator → direct social provider
- Lab → direct publication
- Studio → direct provider publication
- Studio → second Workflow/Execution authority
- Studio → second Rights/Policy authority
- Studio → second Experiment/Evidence authority
- Agent Body → direct secret/credential store
- Agent Organization → Workflow/Execution replacement
- Transform Pawn → second agent runtime
- Capability provider → second MOS marketplace
- Strategy Candidate → Decision Ledger replacement
- Console → direct domain-table mutation
- LLM/provider → domain authority
- Human production task → implicit rights grant
- Public URL → implied media rights

## Central-file collision rule

Workers must not concurrently modify:
- shared composition-root registration;
- central application module maps;
- central architecture/module registration files;
- migration-number manifests/checker sets;
- frozen manifest/architecture/lock files.

A worker needing one of these files submits a module-local change plus an explicit TL integration note. TL performs the central promotion once per integrated milestone.
