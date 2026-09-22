# UX-003 — Station browser journey evidence (Tech Lead re-verification)

Re-verified at the integration station (MOS-station, harvest branch
`harvest/ux-003` = ux/003-worker-delivery baa9e4cf merged over main 0cc7d51)
with agent-browser over the REAL stack:

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | embedded server (the repo's own integration-test harness binaries), ephemeral port 37375, database `ux003station` |
| MOS platform API | `node src/entrypoints/api.ts` on 127.0.0.1:3010, migrations verified at boot (49 applied, latest 055_cross_platform_distribution.sql), bootstrap platform admin armed |
| console | `next dev -p 3001` (the harvest tree), same-origin bridge → :3010 (dev proxy mode) |

## Journeys

1. **Fresh sign-up** through the real `POST /api/mos-signup`
   (`ama@ux003station.test`, agency "UX003 Station Verification Co") → the
   outcome-first home renders (six outcomes + Continue a mission + Today /
   Operations).
2. **Mission creation (desktop 1280x800)**: "Market a product" → flow opens
   with **Product marketing PRE-SELECTED** → objective typed verbatim → target
   (`winter_bundle_sales` >= 200 units) → product/market context → connections
   (no clients → the WORKER-CONTRACT empty state: what's missing / why it
   matters / what to do next + the working "Open Clients" action) → the
   truthful steps → review (objective verbatim in a blockquote, the honest
   draft + deliberate-activation disclosure) → **Create mission** → real POST
   → **201** → mission-created read-back (Mission 01a0c759…, version 1, Draft,
   "1 recorded update so far") with the **"Open the mission workspace"**
   button.
3. **Workspace open + young-mission state**: the workspace renders the
   seventeen-question composition — WHY (objective verbatim + terminal-decision
   basis sentence), LIFECYCLE (transition form: reason required, the honest
   ≥1-mapped-goal activation gate with "the server enforces the same rule"),
   all 15 collapsible sections in their truthful "Waiting for a client context
   (map a goal first)" empty states; TARGET/PROGRESS/NOW·NEXT default-open.
4. **Fixtures through the platform's own real routes** (owner's session token,
   never DB seeding): client `Radiant Skin Studio`
   (POST /api/agencies/:id/clients → 201) + goal "Sell 200 winter skincare
   bundles to returning customers" (POST /api/clients/:id/goals → 201).
5. **Goal mapping through the UI's real POST surface**: PROGRESS → "Map a
   goal" → client combobox + goal radio → "Record the mapping" → the mission's
   PROGRESS goes live ("1 mapped goal, live status from the Goals authority"),
   NOW·NEXT shows "2 recorded updates · latest: goal mapped", and EVERY
   client-scoped section flips from the waiting state to its per-client truth
   ("No evidence recorded on this client yet", …) — the composition discipline
   verified live.
6. **Lifecycle through the real POST /api/growth-missions/:id/status**:
   Activate (confirm-gated "Yes — record it (Active)", reason recorded) →
   **Active**; Pause (new reason) → **Paused**; Resume (new reason) →
   **Active**. The history section records every event.
7. **Operator refusal rendered verbatim**: a second real user
   (`opal@ux003station.test`) created through the platform's real routes
   (POST /api/users + credential + membership as `agency_operator`), signed
   in, opened the same workspace, attempted a pause → the server refused →
   **"403 · FORBIDDEN — This operation requires a different agency role"**
   rendered with "Nothing changed — the mission is exactly as it was." —
   mission stayed Active.
8. **Terminal state**: owner signed back in, Stop with a reason →
   **"Stopped by user"** → the honest terminal disclosure ("Terminal states
   have no path back — that is deliberate. … No transition can be recorded
   here."), the transition form removed.
9. **MKT-067 live composition**: experiment fixture
   (POST /api/clients/:id/experiments → 201) + analysis
   (POST …/experiment-analysis/analyses → recorded) + allocation
   (POST …/experiment-analysis/allocations with two arms → recorded) — the
   workspace's HYPOTHESIS·EXPERIMENT section flips to "1 experiment declared
   on the mission's client", the experiment row expands to the DECLARED
   DESIGN description list, **EXPERIMENT ANALYSES (MKT-067)** and **ALLOCATION
   RECOMMENDATIONS** render the deterministic allocator output verbatim
   ("bundle_first:57.33% single_product:42.67% … no human-treatment arm was
   declared … a valid non-human state, never an error").
10. **Home row entry point**: "Continue a mission" row expands to the
    objective verbatim + "5 recorded updates so far." + **"Open the mission
    workspace →"** — and it opens the workspace.
11. **Mobile (390x844)**: home + workspace open from the row; scrollWidth 390
    = clientWidth 390 at every scroll position through the whole workspace;
    the mission row shows the live terminal state ("Stopped by user").

## Screenshots (this directory)

- `mission-created-ux003-desktop.png`, `workspace-top-ux003-desktop.png`,
  `map-goal-ux003-desktop.png`, `progress-mapped-ux003-desktop.png`,
  `workspace-active-ux003-desktop.png`,
  `workspace-resumed-ux003-desktop.png`,
  `home-row-open-ux003-desktop.png`,
  `operator-refused-ux003-desktop.png`,
  `terminal-stopped-ux003-desktop.png`,
  `experiment-mkt067-ux003-desktop.png`,
  `workspace-mobile-ux003-390.png`, `home-mobile-ux003-390.png`.

## Error accounting

- Page errors: **0** (both viewports, all journeys).
- Console errors: **0** (only benign dev-mode noise: Fast Refresh, HMR
  connects, the React DevTools banner).
- Zero horizontal overflow at both viewports, checked programmatically at
  every step and through six workspace scroll positions on mobile.
