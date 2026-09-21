# MOS v1.6 UX Discovery + Major-Journey Simulation

Status: VERIFIED DISCOVERY INPUT FOR IMPLEMENTATION
Date: 2026-09-21

## 1. Simulation method

This is a repository-grounded journey simulation using the current console source, the recorded live E2E evidence, current production deployment metadata, implemented v1.6 source/runbooks, and the ShareNet source reference.

The interactive browser binary was not available in this execution environment, so no new click-by-click browser run is represented as fresh live evidence. Claims below are limited to source-backed simulation and existing live E2E records.

## 2. Journey results

### A. First visit / sign-up

Path:
login -> create account -> real sign-in -> Command Center.

Result: GOOD for authentication, weak for first-run product discovery.

The existing live E2E records proved signup and owner/operator flows. The current console contains real sign-in, real account creation and demo quick-login personas.

Finding:
after authentication, MOS still presents itself primarily as an agency operations console. The v1.6 outcome-first experience is not yet the dominant entry.

Change:
make the authenticated home ask what outcome the user wants and make mission creation the primary action. Keep the v1.5 Command Center as a secondary Today / Operations destination.

### B. Creator growth

Expected:
mission -> social connections -> research -> hypothesis -> strategy -> experiment -> rights -> transform -> publish -> measure -> learn -> repeat.

Result: NOT DISCOVERABLE TODAY.

Reason:
the current navigation has no Growth Mission destination; MKT-053 exists in backend; MKT-055 exists in backend; MKT-054 is not implemented; the social adapters are not implemented.

Change:
primary action "Grow an audience", mission setup for target/platform/budget/autonomy, contextual social connections, mission progress, hypotheses, experiments, content, rights and platform health.

### C. Product marketing

Expected:
product URL -> product intelligence -> audience/problem hypotheses -> platform portfolio -> content experiments -> attribution -> conversion -> learning.

Result: NOT DISCOVERABLE TODAY.

Reason:
MKT-069 exists in backend, but there is no product-marketing mission surface and MKT-070 is not implemented.

Change:
primary action "Market a product", URL-first intake, optional authorized source repository, evidence-backed product understanding, platform mix, business metrics and conversion trace.

### D. Commerce discovery

Expected:
market discovery -> product candidate -> content hypothesis -> social experiment -> viability -> listing -> traffic -> orders -> economics -> learning.

Result: NOT DISCOVERABLE TODAY.

Reason:
MKT-071 exists in the integration boundary, but MKT-072 and the commerce mission UI are not implemented.

Change:
primary action "Find a product to sell", research-first mission workspace, candidate evidence/economics/risk, then listing -> traffic -> order -> margin -> learning.

### E. Human amplification

Result: PARTIALLY DISCOVERABLE.

The existing Human Work surface and human-agent journey are real and verified. However human amplification is not yet presented as an optional experiment arm inside a Growth Mission.

Change:
add "Add human treatment" inside a mission. Show availability, offer state, budget, rights/disclosure and outcomes. Never make human offer acceptance a dependency.

### F. Scientific trace

Result: GOOD for v1.5, missing at mission level.

The Client Workspace already exposes Goals, Strategy, Deployments, Workflows, Evidence, Decisions, Learning and Memory. Existing E2E evidence covers these surfaces.

Change:
reuse these authorities but present the mission trace as:
Question -> Research -> Evidence -> Hypothesis -> Experiment -> Publication -> Measurement -> Analysis -> Decision -> Learning.

### G. Platform health / blocker handling

Result: NOT DISCOVERABLE TODAY.

MKT-066 is not implemented and there is no mission-level platform health UI.

Change:
mission-level health chips, evidence basis, confidence, compliant next action, and explicit human-required action when needed.

### H. Rights / transformations / provenance

Result: NOT DISCOVERABLE TODAY.

MKT-063, MKT-064 and MKT-065 are not implemented and there is no content-rights surface.

Change:
every content candidate must show source, evidence, rights state, transformation lineage, destination capability and publication state.

### I. Existing v1.5 operations

Result: GOOD.

Current Command Center, Clients, Attention, Profit Intelligence, Human Work, Apps and Administration are discoverable and live. Existing E2E evidence covers owner/operator, client, human-agent, app lifecycle, tenant isolation and responsive behavior.

Change:
preserve these surfaces but move them behind a simpler outcome-first front door.

## 3. Global UX findings

1. Outcome-first discoverability is missing.
2. v1.5 agency operations and v1.6 autonomous growth currently feel like different products.
3. Internal architecture objects appear too early.
4. Social/product/store connections are infrastructure-shaped rather than contextual.
5. Human Work is detached from mission strategy.
6. The v1.6 product contract is ahead of the actual console.

## 4. ShareNet-inspired design direction

Use ShareNet as interaction inspiration, not as a copied implementation.

Adopt:

- calm warm-light surface;
- soft graphite text;
- restrained teal/green for healthy state;
- amber for warning/degraded state;
- red only for genuine failure/blocking;
- generous whitespace;
- minimal border/card chrome;
- one primary action per screen;
- progressive disclosure;
- readable state language;
- subtle motion only for state changes;
- accessible focus and contrast;
- diagnostics secondary to the user outcome.

The experience should feel like a calm operational instrument rather than a dense analytics dashboard.

## 5. Required UX verification

Every new major journey must be verified at:

- 390x844;
- 1280x800;
- owner role;
- operator role where applicable;
- empty real account;
- demo account;
- zero page/browser errors;
- zero horizontal overflow;
- no raw JSON in visible UI;
- explicit next action for empty, error and blocked states.
