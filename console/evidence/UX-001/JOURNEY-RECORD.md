# UX-001 — Browser journey evidence

Recorded at the integration station (Tech Lead) against the delivery branch
`ux/001-worker-delivery`, console dev server on :3001 bridged to the live
platform API on :3010 (embedded PostgreSQL, seeded Northwind demo data).

## Journey record (1280x800, then 390x844)

1. `GET /` renders the login screen (Sign in / Create account / Demo accounts).
2. Demo quick-login as **Casey — Agency Owner, Northwind**.
3. The FIRST authenticated screen is the outcome-first home:
   - heading "What would you like to do?"
   - the six exact outcome entries (Grow an audience / Market a product /
     Find a product to sell / Generate leads / Generate revenue /
     Continue a mission)
   - "Continue a mission" live section + "Today / Operations" entry.
4. Expanding "Grow an audience" shows the contract-compliant coming-next
   panel (what is coming / what you can do now) with an explicit working
   action ("Open Today / Operations").
5. Clicking the action navigates (SPA view switch) to the Command Center
   under its new "Today / Operations" framing — live data intact
   (attention items, portfolio goals, workflows).
6. "Continue a mission" renders the contract empty state after a
   SUCCESSFUL real API round trip
   (`GET /api/agencies/:agencyId/growth-missions` → `missions: []`):
   what is missing, why it matters, what to do next, plus the explicit
   action. No error state, no raw JSON, no internal module names.
7. Nav: Home (new first entry) + "Today / Operations" (re-labeled
   Command Center) + the unchanged remaining entries.

## Verification table (run at the integration station)

| step | command / probe | result |
|---|---|---|
| 1 | `cd console && bun install` | 433 packages installed |
| 2 | `cd console && bunx tsc --noEmit` | 0 errors |
| 3 | `cd console && bun run lint` | 0 problems |
| 4 | `cd console && bun run build` | compiled successfully (3 static pages, 3 API routes) |
| 5 | browser journeys | pass — see below |

- Page errors: **0** (both viewports).
- Console errors: **0** (dev-mode HMR/Fast Refresh info only).
- Horizontal overflow: **none** at 1280x800 (scrollWidth 1280 = clientWidth
  1280) and **none** at 390x844 (scrollWidth 390 = clientWidth 390).
- Screenshots: `home-desktop-1280x800.png`, `home-mobile-390x844.png`.

## Seams resolved at integration (worker's S1–S9)

- S1 store hook: `useMosStore` → `useMosSession` (one import + two
  selectors in `outcomes.ts`).
- S3 hooks path: `@/hooks` → `@/components/mos/hooks`.
- S7 mission detail: status lives at `mission.status` in the serialized
  detail (`{ mission, currentVersion, goalMappings, history,
  terminalDecisionBasis, vocabularyVersion }` — verified against
  `serializeDetail` in `src/api/growth-missions-routes.ts`).
- S2/S4/S5/S6 verified correct as delivered; S8 fallback panel kept;
  S9 checked — the persisted view maps to the new default on login/
  logout/agency-selection transitions.

Worker session: ux-001 (chat fefec658), collaborative mode (no shell in the
worker session — the worker authored; the Tech Lead executed the git
operations, gates, and browser journeys).
