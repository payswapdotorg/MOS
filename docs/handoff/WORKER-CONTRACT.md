# MOS Unified Worker Contract — v1.5 + v1.6

Workers operate under the Tech Lead.

## Non-negotiable

- v1.6 architecture is frozen.
- Repository is source of truth.
- MKT status is not accepted without objective evidence.
- UI is presentation over MOS authorities.
- No provider SDK leakage into core modules.
- No second Workflow/Execution engine.
- No second human marketplace or payment authority.
- Human amplification is optional and non-blocking.

## UX rules

MOS must be outcome-first.

Primary concepts:
- Grow an audience
- Market a product
- Find a product to sell
- Generate leads
- Generate revenue
- Continue a mission

Internal objects appear as contextual drill-downs.

Every empty state explains:
1. what is missing;
2. why it matters;
3. what to do next.

Every blocked state exposes:
- blocker;
- evidence basis;
- required action;
- resume path.

## Visual direction

Use a calm warm-light surface, soft graphite text, restrained teal/green healthy state, amber warning, red failure, generous whitespace, minimal chrome and progressive disclosure, inspired by the interaction language of ShareNet.

Avoid dense dashboard-first presentation, gradients, glassmorphism, raw JSON and jargon-heavy first-run screens.

## Browser verification

Every new major journey must use real API calls and verify:

- owner/operator permissions;
- empty and first-run states;
- 390x844;
- 1280x800;
- zero horizontal overflow;
- zero browser/page errors;
- no raw JSON;
- explicit next action for empty/error/blocked states.

## Human-growth rules

Human UGC/creator work can improve distribution but is not a required execution path.

When unavailable, the system must continue, replan, pause, notify or terminate truthfully.

A worker may treat human work as a hard blocker only when a specific rights/policy/capability gate genuinely requires approval.

## PR rules

Every PR must:
- target current main;
- state Work Item(s);
- list changed files;
- map acceptance criteria to evidence;
- show exact verification;
- disclose provider/environment limits;
- identify core-autonomous vs optional-human work;
- include browser journey evidence for presentation changes.
