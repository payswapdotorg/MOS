# UX-002 — Browser journey evidence

Recorded in-sandbox by the UX-002 worker (agent-browser over Chromium)
against the delivery branch `ux/002-worker-delivery`, console dev server on
:3011 bridged to the real MOS platform API on :3010 (embedded PostgreSQL 18,
migrations applied at boot, real sign-ups — no seeded demo data).

## The stack (all real, in-sandbox)

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | embedded server (`@embedded-postgres/linux-x64`, the repo's own integration-test harness binaries), port 5433 |
| MOS platform API | `node src/entrypoints/api.ts` on 127.0.0.1:3010, `MOS_DATABASE_URL` → the embedded PG, bootstrap platform admin armed |
| console | `next dev -p 3011`, dev-proxy bridge `/api/mos/*` → 127.0.0.1:3010 |

## Journeys (1280x800 first, then 390x844)

1. **Fresh sign-up** through the real `POST /api/mos-signup`
   (`ama@ux002.test` / agency "UX002 Verification Co") → first authenticated
   screen is the outcome-first home; the five start outcomes render; the
   missions empty state shows the new copy + "Start a mission" (unseeded
   entry) + "Today / Operations".
2. **Seeded creation (desktop, full)**: click "Market a product" → the flow
   opens with `Product marketing` PRE-SELECTED (the seed) → objective typed
   verbatim → validation checked (empty objective BLOCKS with the honest
   message; missing family BLOCKS) → two targets added (incl. the
   intermediate flag) → product + market context → connections (agency has
   no clients → the WORKER-CONTRACT empty state: what's missing / why it
   matters / what to do next + the working "Open Clients" action) → the four
   truthful steps (strategy / budget / autonomy / optional human help — no
   dead controls, nothing fake persisted) → review (objective verbatim in
   quotes, family, targets, context, the honest "born draft, never
   auto-activated" disclosure) → **Create mission** → real
   `POST /api/agencies/:agencyId/growth-missions` → 201 → the
   mission-created read-back (live `GET /api/growth-missions/:missionId`:
   draft chip, version 1, "1 recorded update so far") → Back to Home →
   **the new mission is listed under "Continue a mission"** (invalidated
   query refetches live; expanding the row shows the objective verbatim).
3. **With a client**: created client "Helio Robotics" through the real
   clients route → new flow from "Generate leads" (seeded
   `Lead generation`) → connections step lists the client (live) →
   selecting it performs the real `GET /api/clients/:clientId/social-accounts`
   (200 through the bridge) → "No connected channels on this client yet"
   empty state with the truthful next step.
4. **Unseeded entry**: second fresh sign-up (`kofi@ux002.test`) → the
   missions empty state's "Start a mission" → the flow opens with NO family
   pre-selected → both blockers verified → family picked manually →
   minimal mission (objective + family only — targets and context omitted)
   → 201 → created read-back → listed under "Continue a mission".
5. **Mobile (390x844), full flow**: seeded entry ("Grow an audience") →
   objective → one target → context (empty) → connections → the four
   truthful steps → review → create → 201 → created screen → home listing.
   Zero horizontal overflow at EVERY step (scrollWidth 390 = clientWidth
   390 at each), touch-sized controls, no layout breakage.
6. **Operator refusal (owner/operator permissions)**: created a real
   `agency_operator` membership for a second user (platform-admin route:
   `POST /api/users` + credential + `POST /api/agencies/:id/memberships`) →
   operator signs in (sees the agency's missions — read works for any
   active member) → runs the SAME flow → **Create mission** → the server's
   own `403 · FORBIDDEN — This operation requires a different agency role`
   rendered VERBATIM inline, with "Nothing was created — your draft is
   still here". No fabricated error text.
7. **No-agency blocked state**: platform-admin sign-in (no agency selected)
   → outcome click → the agency-needed panel (blocker / required action /
   resume path) → the resume path verified end-to-end: Administration →
   "Address an agency by id" → "Work in this agency" → home → outcome →
   the flow opens with the agency context.

## In-sandbox verification table

| step | command / probe | result |
|---|---|---|
| 1 | `cd console && bun install` | 433 packages installed |
| 2 | `cd console && bunx tsc --noEmit` | 0 errors |
| 3 | `cd console && bun run lint` | 0 problems |
| 4 | `cd console && bun run build` | succeeded (3 static pages, 3 API routes) |
| 5 | browser journeys (above) | all pass |

- Page errors: **0** (both viewports, all journeys).
- Console errors: **0** (dev-mode HMR info only).
- Horizontal overflow: **none** at 1280x800 and 390x844 at every step.
- Not verifiable in-sandbox: the connections step with LIVE connected
  channels (connecting a channel requires a provider OAuth round the
  console does not yet offer — the truthful empty state was verified
  instead); screenshots for that state will come from the integration
  station.

Screenshots: `*.png` in this directory (desktop 1280x800 + mobile 390x844
key steps, the operator refusal, and the agency-needed panel).
