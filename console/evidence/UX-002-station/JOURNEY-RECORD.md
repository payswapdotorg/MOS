# UX-002 — Station browser journey evidence (Tech Lead re-verification)

Re-verified at the integration station (MOS-station, harvest branch
`harvest/ux-002` = ux/002-worker-delivery cc40057 merged over main 5668969)
with agent-browser over the REAL stack:

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | embedded server (the repo's own integration-test harness binaries), ephemeral port, database `ux002station` |
| MOS platform API | `node src/entrypoints/api.ts` on 127.0.0.1:3010, migrations verified at boot (48 applied, latest 054_experiment_analysis.sql), bootstrap platform admin armed |
| console | `next dev -p 3001` (the harvest tree), same-origin bridge → :3010 |

## Journeys

1. **Fresh sign-up** through the real `POST /api/mos-signup`
   (`ama@ux002station.test`, agency "UX002 Station Verification Co") → the
   first authenticated screen is the outcome-first home (six outcomes +
   Continue a mission + Today / Operations).
2. **Seeded creation (desktop 1280x800)**: "Market a product" → the flow
   opens with **Product marketing PRE-SELECTED** (the seed verified) →
   objective typed verbatim → one target added (metric `workshop_signups`,
   `>=` 120, unit, **intermediate flag checked**) → product + market context
   → connections (agency has no clients → the WORKER-CONTRACT empty state:
   what's missing / why it matters / what to do next + the working "Open
   Clients" action) → the four truthful steps (strategy composed for you /
   budget arrives in a planned update / autonomy decided per step / human
   help optional-never-required with the invariant copy) → review (objective
   verbatim in a blockquote, family, targets, context) → **Create mission**
   → real `POST /api/mos/agencies/:agencyId/growth-missions` → **201** →
   mission-created read-back (`GET /api/growth-missions/:missionId` → 200,
   "Draft", "1 recorded update so far") → Back to Home → the mission listed
   under **Continue a mission** with the objective verbatim on expand.
3. **Mobile (390x844) full flow**: "Generate leads" → **Lead generation
   PRE-SELECTED** → objective → steps walked → review → create → **201**
   (second mission) → home lists **two missions**, both Draft.
   Zero horizontal overflow at EVERY step (scrollWidth 390 = clientWidth
   390 measured after each advance).

## Screenshots (this directory)

- `home-mission-listed-desktop.png` / `home-mission-expanded-desktop.png` /
  `home-mission-detail-desktop.png` — the 1280x800 golden path ends
- `home-mobile-390.png` / `flow-review-mobile-390.png` /
  `mission-created-mobile-390.png` / `home-two-missions-mobile-390.png` —
  the 390x844 pass

## Error accounting

- Page errors: **0** (both viewports, all journeys).
- Console errors: **one transient React hydration attribute warning**,
  observed once after the create → home transition reload; **not
  reproducible** on repeated reloads (three clean reloads checked). Zero
  other console errors. (The worker's in-sandbox run reported zero — the
  station reproduces it only as a one-time attribute mismatch during the
  authenticated-transition reload; disclosed, not hidden.)
