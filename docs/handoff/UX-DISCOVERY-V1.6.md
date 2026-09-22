# MOS v1.6 UX Discovery + Major-Journey Simulation

Status: VERIFIED DISCOVERY INPUT FOR IMPLEMENTATION
Audit date: 2026-09-21
STATE REFRESH: 2026-09-22 (successor orchestrator reconciliation)

## 0. Discovery state refresh 2026-09-22 (supersedes the audit facts below)

Since the 2026-09-21 audit, the mission spine emerged on main
(10f51781f8d198cd07c19259f722c1aeab7ac8e6):

- ✅ UX-001 Outcome-first Home — the six primary outcome choices are live
  (station evidence: console/evidence/UX-001).
- ✅ UX-002 Reusable Mission Creation — progressive flow with truthful
  coming states (console/evidence/UX-002-station).
- ✅ UX-003 Mission Workspace — the seventeen-question composition, full
  lifecycle vocabulary, live client surfaces, operator 403, terminal states
  (console/evidence/UX-003-station, 12 screenshots + JOURNEY-RECORD.md).
- ✅ UX-004 Scientific Trace — the ten-link epistemic chain with three
  visually distinct registers (observed facts / derived claims / causal
  interpretations), both cross-links live, mobile zero-overflow
  (console/evidence/UX-004-station, 18 screenshots + JOURNEY-RECORD.md).
- Backend authorities merged but NOT yet discoverable as user journeys:
  MKT-062 research/content-intelligence (HTTP surfaces exist at
  src/api/research-routes.ts + content-intelligence-routes.ts; the
  Scientific Trace deliberately renders Research as a truthful coming
  state — the dedicated research UX is NOT shipped), MKT-065
  cross-platform distribution (read surfaces only in the workspace).
- Remaining UX: UX-005 Connections Center, UX-006 Content/Rights
  operational surface, UX-007 Platform Health, UX-008 Human treatment,
  UX-009 Commerce mission, UX-010 progressive-disclosure hardening,
  UX-011 visual polish, UX-012 complete browser acceptance battery.

The journey analyses and learnings below remain valid as direction; their
"NOT DISCOVERABLE" states are superseded where listed above.

## Method

This audit combines current main source, frozen v1.6 architecture/backlog, live production HTML, Vercel deployment metadata, recorded real E2E evidence, implementation runbooks and the ShareNet source/design reference.

A fresh click-by-click Chromium session was not available in this environment: the browser executable was absent and network/DNS prevented downloading one. This document therefore does not claim fresh interactive browser execution.

## First visit

Live production responds 200 and exposes real:
- Sign in
- Create account
- Demo accounts

The authenticated shell remains:
Command Center → Clients → Attention → Profit Intelligence → Human Work → Apps → Administration.

Conclusion: authentication is discoverable, but the first authenticated experience is still operations-first rather than outcome-first.

## Major journey simulation

### Creator growth
Desired:
Grow → connect accounts → research → evidence → hypothesis → experiment → rights → transform → publish → measure → learn → replan.

Current:
NOT DISCOVERABLE.

Reason:
MKT-053/054/055/056 exist, but MKT-057..061 concrete adapters and the mission-first console do not.

Learning:
“Grow an audience” must be a primary action. Users should not need to understand Growth Operator, Workflow, Execution or adapter terminology.

### Product marketing
Desired:
Product URL/source → product understanding → audience/channel/metric plan → execute → measure.

Current:
NOT DISCOVERABLE.

Reason:
MKT-069 exists; MKT-070 and its mission UI do not.

Learning:
“Market a product” must be a primary action with progressive product-context setup.

### Commerce discovery
Desired:
No product → research → candidate → demand test → viability → listing → traffic → order → margin → learning.

Current:
NOT DISCOVERABLE.

Reason:
MKT-071 exists; MKT-072 and its mission UI do not.

Learning:
Commerce must appear as an outcome lifecycle, not an integration settings surface.

### Rights / transformation / publication
Desired:
source → provenance → rights gate → transformation → destination capability → publish.

Current:
BACKEND READY, USER-INVISIBLE.

MKT-063 and MKT-064 are implemented and already contained in current production.

Learning:
Before publication, the mission must show source/evidence, rights state, ingredient lineage, transformation history, destination capability and publication state.

### Human amplification
Current Human Work is discoverable.

Target:
Human work becomes an optional experiment arm within the mission.

Learning:
No creator/UGC budget, no eligible creators, or declined/expired offers may silently block autonomous operation. Only a genuinely mandatory rights/policy/capability review may create a human blocker.

### Scientific trace
Existing Client Workspace already exposes:
Goals, Strategy, Deployments, Workflows, Evidence, Decisions, Learning and Memory.

Learning:
Reuse those authorities and compose a mission narrative:
Question → Research → Evidence → Hypothesis → Experiment → Publication → Measurement → Analysis → Decision → Learning.

Do not create a second analytics hierarchy.

### Platform health
Current:
not discoverable; MKT-066 is incomplete.

Target:
observable provider/account signals → descriptive state → evidence basis → uncertainty → compliant next action.

Never claim hidden moderation state not exposed by a provider.

### Existing operations
Keep the v1.5 operational surfaces.
Move them conceptually under Today / Operations / secondary navigation rather than deleting them.

## Existing browser evidence

Recorded E2E evidence already proves the v1.5 shell:
- signup 14/14
- owner/operator 28/28
- client 13/13 after Evidence rendering fix
- human-agent 11/11
- app-lifecycle 13/13
- tenant-isolation 23/23
- responsive 15/15

The responsive and client reruns include 390×844 and 1280×800 checks with zero overflow/page-error assertions after the recorded fixes.

New v1.6 journeys must exceed that evidence standard:
real API/auth, both viewport sizes, zero overflow, zero page/browser errors, no raw JSON and explicit loading/empty/error/blocked next actions.

## ShareNet-inspired design direction

Use:
- warm neutral/light surfaces
- graphite typography
- restrained teal/green healthy state
- amber warning/degraded state
- red only for true failure/block
- generous whitespace
- minimal border/card chrome
- progressive disclosure
- subtle state transitions
- strong focus/contrast
- diagnostics secondary
- one primary action per screen

Avoid:
- dense analytics-dashboard-first layouts
- architecture jargon on the first screen
- unexplained internal identifiers as the primary UI
- silent capability failures
