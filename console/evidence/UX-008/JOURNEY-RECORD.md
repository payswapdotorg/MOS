# UX-008 — Human Treatment console surface: browser journey evidence

Recorded in-sandbox by the UX-008 worker (agent-browser over Chromium,
named session) against the delivery branch `ux/008-worker-delivery` (base
`f4c842bc` + the console-only UX-008 delta) — **embedded PostgreSQL 18**
(the repo's own integration-test harness binaries, fresh database
`ux008_journey`, 55 migrations at boot, latest `061_lab_corpus.sql`), the
REAL API entrypoint as a subprocess, real sign-up through the console's
`/api/mos-signup` orchestrator — no seeded demo data, no DB writes outside
the platform's own contracts.

## The stack (all real, in-sandbox)

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | embedded server (the repo's `tests/integration/helpers/pg.ts` harness + ICU provisioning), ephemeral port, fresh database `ux008_journey`, 55 migrations |
| The API | the repo's own `src/entrypoints/api.ts` as a real subprocess on an ephemeral port (`MOS_HTTP_PORT=0`), with the bootstrap platform-admin credentials the console's signup orchestrator composes — every module, route and migration fully REAL (no seam doubles were needed for this surface: the treatments tab composes the experiments, experiment-analysis and growth-missions authorities, none of which touch a provider boundary) |
| console | `next dev -p 3011`, the dev-proxy bridge `/api/mos/*` → the API (`MOS_UPSTREAM_ORIGIN` + `MOS_BRIDGE_FORCE_PROXY=1`, no `MOS_DATABASE_URL` — the bridge is ALWAYS the pure proxy) |
| driver | the journey driver (one long-running process — the sandbox reaps background processes, so stack boot, browser journey, fixtures and teardown ran inside a single invocation) driving agent-browser for the UI and REAL HTTP routes for the fixtures |

## Fixtures — through the platform's OWN real routes, with the owner's session

Everything below went over real HTTP (the owner's Bearer token from a real
`/api/auth/login`; never DB seeding, never fabricated client-side):

- the sign-up (`owner@ux008.test`, agency "UX008 Human Treatment Co")
  **through the console UI** (the real `POST /api/mos-signup` orchestrator
  — screenshot 01);
- the client "Verdant Bloom Tea" created **through the console UI**
  (`POST /api/agencies/:agencyId/clients` via the form — screenshot 02);
- the goal (`POST /api/clients/:clientId/goals`) — the mission↔client
  linkage anchor for the mission-states section;
- **mission 1** (creator_growth) through the real routes: create → map the
  goal (`POST /api/growth-missions/:id/goal-mappings`) → activate →
  **`blocked_pending_human_action`** with the recorded reason "Mandatory
  rights review: the licensed soundtrack inside the UGC pack needs human
  clearance before any publication — a genuine rights gate the system
  cannot decide itself." (the ONE honest human blocker);
- **mission 2** (audience_growth) through the same real routes → activate
  → **`paused`** with the recorded reason "Human arm unfunded this cycle
  — the operator paused the creator partnership line while budget is
  renewed; the automated arms keep their record readable." (the
  change-request-006 rule 21 pause verb);
- **experiment A** (the human arm ELIGIBLE): declared through
  `POST /api/clients/:clientId/experiments`; 60 metric observations
  through the REAL `POST /api/clients/:clientId/metrics` route (30 per
  arm, treatment ≈ 4.1 / comparison ≈ 1.9 over the January 2026 window);
  one `/evidence` anchor record; one REAL analysis through
  `POST …/experiment-analysis/analyses` (the deterministic two-sample
  computation ran server-side — outcome `effect_positive`); one REAL
  allocation through `POST …/experiment-analysis/allocations` declaring
  three arms including `human_creators` kind `human_treatment`
  **capacity 8** (the bounded budget);
- **experiment B** (the human arm UNFUNDED): declared + one allocation
  whose `human_creator_partnerships` arm declares **capacity 0** — the
  allocator excludes it and records its reason while the non-human arms
  proceed (the never-blocks guarantee, exactly as the authority records
  it);
- **experiment C** (NO human arm): declared + one allocation over two
  automated arms only (absent by declaration).

Driver-side fixture provisioning is the UX-007 disclosed pattern: the
console CODE is the production code; the console has no surface for
declaring experiments/analyses/allocations (they are operator/API
surfaces), so the driver created them through the identical real routes
the mission workspace and trace tab compose. One honest note: the
allocations HTTP route rejects a caller-supplied `analysisId` (a §23
forbidden authority field), so the recommendation honestly records "no
analysis linked" — the card renders that state verbatim.

## The journey (screenshots 01–13, desktop 1280×800 + mobile 390×844)

| # | step | the API evidence composed | result |
| --- | --- | --- | --- |
| 01 | Fresh sign-up → the outcome-first home | real `POST /api/mos-signup` through the console UI | ✓ |
| 02 | Client created through the console surface → the workspace tab bar carries **Treatments** (6th tab, Users icon, after Health) + the Human treatment heading + the honest no-experiments empty state + the "Open the Scientific trace" next action | real `POST /api/agencies/:agencyId/clients` | ✓ |
| 03 | The empty state scrolled: the no-experiments card, the no-missions-yet state and the composition disclosure | `GET /api/clients/:id/experiments` (empty) + `GET /api/agencies/:id/growth-missions` (empty) | ✓ |
| 04 | Experiment A expanded — **the human arm in play**: the "human arm in play · capacity 8" chip, the exploration floor (10.0%, declared_input), the allocator's consideration note VERBATIM ("…considered and is eligible with observable capacity; it competes on its recorded signal like every other arm"), the declared arms with the bounded budget (capacity / observations / mean / variance per arm) | `GET …/experiment-analysis/allocations/by-experiment/:experimentId` (on expand — the expand→fetch house pattern) | ✓ |
| 05 | The outcome attribution (scrolled): the frozen `effect positive` outcome chip, the recommended next allocation, the observation window, the computed means/effect/samples, the practical threshold, the uncertainty + sequential-state disclosures | `GET …/experiment-analysis/analyses/by-experiment/:experimentId` (on expand) | ✓ |
| 06 | Experiment B expanded — **the unfunded human arm**: the "human arm unfunded — zero capacity" chip, the "zero capacity — excluded" arm row, the recorded exclusion reason VERBATIM ("…excluded from allocation; allocation continues over the remaining arms…"), and the non-human arms' computed shares proceeding | the same by-experiment allocation route | ✓ |
| 07 | Experiment C expanded — **no human arm declared**: the "no human arm declared" chip + the allocator's absent-by-declaration note + the two automated arms allocated | the same by-experiment allocation route | ✓ |
| 08 | The mission-level states: the **Blocked pending human action** card (red) with the mandatory-rights-review reason recorded verbatim + the one-human-blocker explanation, and the **Paused** mission with its recorded reason — the rule-21 vocabulary | `GET /api/agencies/:agencyId/growth-missions` + `GET /api/growth-missions/:missionId` per mission (the client's missions through their goal mappings) | ✓ |
| 09 | The composition disclosure card: what the surface composes, the honest per-client OFFER-outcomes gap ("no client-scoped read surface yet… so they cannot be shown here without inventing them") and the Human Work cross-link | — (the surface's own disclosure) | ✓ |
| 10 | The Human Work cross-link lands on the caller-scoped surface (the queue, discovery and marketplace tabs; the owner has no Human Agent profile → the honest 403-free empty rendering of that surface's own gates) | the SPA navigation composing the /jobs queue surface | ✓ |
| 11 | Mobile 390×844: the Treatments tab — the stacked cards, 0px overflow | — | ✓ |
| 12 | Mobile 390×844: the human-arm card drill-down open — "human arm in play · capacity 8" + the consideration note reflowed, 0px overflow | the same allocation route | ✓ |
| 13 | The full Treatments tab at 1280×800 (full-page, experiment A open): all three experiment cards, the mission states and the disclosure in one picture | all the above composed | ✓ |

## Error accounting

- Page errors: **0** at every probe (after-signup, empty-state,
  populated, after-crosslink, mobile, final — the agent-browser page-error
  report was empty across the whole journey, both viewports).
- Console errors/warnings: **0** — the console log holds four benign
  dev-mode entries (the React DevTools download hint, HMR connected, and
  two Fast Refresh log lines) and nothing at error/warn level (cleaner
  than the UX-005/007 disclosed dev-mode hydration-warning class — no
  hydration warning appeared on any load of this surface).
- Horizontal overflow: **0px** — the probe measures
  `scrollWidth − clientWidth` at every 700px scroll position through the
  populated surface (three cards, one drill-down fully expanded) at
  1280×800 AND at 390×844 (`max-overflow=0px` recorded per phase:
  empty-state-desktop, populated-desktop, mobile-390x844, final-desktop).
- Viewport verified programmatically (`window.innerWidth × innerHeight`):
  1280×800 for the desktop phases, 390×844 for the mobile phase.

## Honest notes (sandbox limitations + judgment calls, disclosed)

1. **Everything ran inside one long-running driver process**: this
   sandbox reaps background processes when a command exits, so the
   embedded PostgreSQL, the API subprocess, the console dev server, the
   browser session, the fixtures and the screenshots all lived inside a
   single journey invocation (boot → journey → teardown). The journey
   driver itself lives OUTSIDE the repository (`/home/z/ux008-journey/`)
   and is not part of the delivery — the delivery is the console delta +
   this evidence pack.
2. **The fixtures are driver-side through the REAL routes** (the UX-007
   disclosed pattern): sign-up and the client went through the console
   UI; the goal, the two missions and their lifecycle transitions, the
   three experiments, the 60 metric observations, the evidence record,
   the analysis and the three allocations went through the identical real
   HTTP routes with the owner's session (the console has no surface for
   those operator/API actions — they are not part of UX-008's scope).
3. **The analysis/allocation link gap is the platform's own**: the
   allocations HTTP route rejects a caller-supplied `analysisId` as a
   §23 forbidden authority field, so the recorded recommendation carries
   no analysis link and the card renders "no analysis linked" honestly.
   The outcome attribution is therefore shown from the ANALYSIS tail
   (which the same card renders), not from the recommendation row.
4. **The mobile steps navigate at desktop width, then reflow the live
   surface to 390×844** (the UX-005/007 disclosed pattern — the vaul
   navigation drawer's touch surface intercepts pointer automation). The
   reflow exercises the identical responsive layout (screenshots 11/12);
   the overflow probe confirms 0px at 390×844.
5. **Three of the human-arm availability states verified in the
   browser** (eligible with capacity / unfunded with zero capacity /
   absent by declaration — screenshots 04, 06, 07) plus the
   blocked-pending-human-action exception and the paused verb
   (screenshot 08). The declined/expired OFFER states are held by the
   jobs authority but have no client-scoped read surface yet — disclosed
   on the surface itself (screenshot 09) rather than invented.
6. **The screens' waits are case-insensitive DOM-text waits** — the
   house headings render with CSS `text-transform: uppercase`, so a
   naive case-sensitive text wait would never match them (a journey
   tooling detail, disclosed for reproducibility).
