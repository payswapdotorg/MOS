# UX-003 — Mission Workspace: browser journey evidence

Recorded in-sandbox by the UX-003 worker (agent-browser over Chromium)
against the delivery branch `ux/003-worker-delivery`, console dev server on
:3011 bridged to the real MOS platform API on :3010 (embedded PostgreSQL 18,
migrations applied at boot, real sign-ups — no seeded demo data).

## The stack (all real, in-sandbox)

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | embedded server (`@embedded-postgres/linux-x64`, the repo's own integration-test harness binaries), ephemeral port |
| MOS platform API | `node src/entrypoints/api.ts` on 127.0.0.1:3010, `MOS_DATABASE_URL` → the embedded PG, bootstrap platform admin armed |
| console | `next dev -p 3011`, dev-proxy bridge `/api/mos/*` → 127.0.0.1:3010, bootstrap-admin env for the `/api/mos-signup` orchestrator |

Goal/experiment/analysis fixtures (needed because the console has no
goal-creation surface yet — the map-goal flow requires an EXISTING goal) were
created through the platform's OWN real routes (POST
`/api/clients/:clientId/goals`, `/evidence`, `/metrics`, `/experiments`,
`/experiment-analysis/analyses`, `/experiment-analysis/allocations`) with the
owner's real session token — never seeded into the database directly, never
fabricated client-side.

## The journeys

1. **Fresh sign-up** through the real `POST /api/mos-signup`
   (`ama@ux003.test` / agency "UX003 Verification Co") → outcome-first home.
2. **Mission created through the full UX-002 flow** ("Market a product",
   objective verbatim, one target metric incl. unit, product + market
   context, connections empty state, the truthful steps, review) → real
   `POST /api/agencies/:agencyId/growth-missions` → 201 → the
   mission-created read-back now shows the new **"Open the mission
   workspace"** primary action (the UX-003 entry point).
3. **Workspace opened from the mission-created screen** → the header
   (objective verbatim as the "Why", family, version, status chip), the
   honest no-client-context banner, and the Lifecycle panel with the frozen
   draft transitions ("Activate" / "Stop"), reason required.
4. **The young-mission state**: all 15 sections rendered with truthful
   empty states — TARGET (objective + the 1 declared target), PROGRESS (no
   goals mapped + the "Map a goal" action), NOW · NEXT (1 recorded update),
   the nine client-scoped sections "Waiting for a client context (map a
   goal first)", BLOCKERS ("No blockers recorded"). Zero client-scoped API
   calls fired (queries disabled at null input).
5. **Entry point from Home verified**: Home → "Continue a mission" → row
   expanded → **"Open the mission workspace →"** (the retired "arriving
   next" note replaced by the real OPEN action).
6. **Goal mapped through the real POST surface**: the Progress empty
   state's "Map a goal" → client picker (live agency clients) → goal picker
   (live client goals) → real `POST /api/growth-missions/:missionId/goal-mappings`
   → 200 → PROGRESS shows "1 mapped goal, live status from the Goals
   authority", the client-context banner resolves ("Composing Helio
   Robotics's working surfaces"), and the nine client-scoped sections
   switch to live data.
7. **Live composition verified with real records**: EVIDENCE (1 record —
   the statement + metric figure formatted, source line), MEASUREMENT (24
   observations, dimension chips), HYPOTHESIS · EXPERIMENT (the experiment
   row with hypothesis verbatim; expanding it mounts the NEW MKT-067
   by-experiment queries: the analysis — outcome chip "inconclusive",
   treatment mean 5.5, comparison mean 3.5, effect 2 ± 1.08, uncertainty +
   sequential state as formatted labeled rows — and the allocation —
   shares 61.6%/38.4%, floor 10% (module_default_v1), rationale verbatim).
8. **Activation (the golden path)**: reason typed → "Record the
   transition" → explicit confirm ("Yes — record it (Active)") → real
   `POST /api/growth-missions/:missionId/status` with the LIVE version
   (CAS) → 200 → status chip "Active", history "3 recorded updates ·
   latest: active" with the reason verbatim, the Growth Operator
   disclosure in NOW · NEXT, and the active-state transition set offered
   (pause / achieve / stop / the honest terminal recordings).
9. **Pause and resume**: paused with a reason (amber chip, "4 recorded
   updates"), then resumed — both through the real route; the frozen
   transition table mirrored exactly (paused offers only Resume / Stop).
10. **Operator refusal (owner/operator permissions)**: a real
    `agency_operator` membership (platform-admin routes) → operator opens
    the same workspace (READ works — any active member) → attempts resume
    with a reason → the server's own `403 · FORBIDDEN — This operation
    requires a different agency role` rendered VERBATIM inline, "Nothing
    changed — the mission is exactly as it was", status still Paused.
11. **Terminal state**: a second mission created and stopped through the
    real routes → the workspace renders "stopped by user — terminal"
    (Lifecycle: "no path back… a successor mission can carry the objective
    forward"), the terminal history event with its reason and the cited
    family ("Terminal decision evaluated against the declared commerce
    discovery objective."), the frozen goal-mapping note, and the BLOCKERS
    empty state.
12. **Mobile (390x844)**: home → row expand → open workspace → sections →
    evidence expanded → history ("Show all 4 events") → **resume executed
    on mobile** (touch-sized controls; "5 recorded updates · latest:
    active"). Zero horizontal overflow at EVERY step (scrollWidth 390 =
    clientWidth 390), zero page errors.

## In-sandbox verification table

| step | command / probe | result |
|---|---|---|
| 1 | `cd console && bun install` | 442 installs, no changes |
| 2 | `cd console && bunx tsc --noEmit` | 0 errors (exit 0) |
| 3 | `cd console && bun run lint` | 0 problems (exit 0) |
| 4 | `cd console && bun run build` | succeeded (3 static pages, 3 API routes) |
| 5 | browser journeys (above) | all pass at 1280x800 and 390x844 |

- Page errors: **0** (both viewports, all journeys).
- Console errors: **0** (dev-mode HMR/telemetry info only).
- Horizontal overflow: **none** at 1280x800 and 390x844 at every step
  (documented above, checked programmatically after each phase).
- Not verifiable in-sandbox: PLATFORMS with a LIVE connected channel
  (connecting requires a provider OAuth round the console does not offer —
  the truthful empty state and the health "observable now" logic render
  instead); the Growth Operator's own plan surface (no public read surface
  exists yet — the honest disclosure renders). Both will be exercised at
  the integration station when their surfaces exist.

Screenshots: `*.png` in this directory (desktop 1280x800 + mobile 390x844 at
the key steps, the map-goal panel, the MKT-067 composition, the operator
refusal, and the terminal state).
