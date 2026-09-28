# UX-007 — Platform Health console surface: browser journey evidence

Recorded in-sandbox by the UX-007 worker (agent-browser over Chromium)
against the delivery branch `ux/007-worker-delivery` (main `8e4e774` + the
console-only UX-007 delta) — **embedded PostgreSQL 18** (the repo's own
integration-test harness binaries, fresh database `ux007_journey`, 53
migrations at boot, latest `059_lab_contracts.sql` — the LAB-001 baseline
this wave's main carries), real sign-up through the console's
`/api/mos-signup` orchestrator — no seeded demo data, no DB writes outside
the platform's own contracts.

## The stack (all real, in-sandbox)

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | embedded server (the repo's `tests/integration/helpers/pg.ts` harness + `ensureIcu60`), ephemeral port, fresh database `ux007_journey`, 53 migrations |
| The SEAM API | `bootstrapApplication` + `buildApiRouter` + `createHttpServer` on 127.0.0.1:**3012** with the repo's OWN integration-test seams (`createLocalOAuthFlow` × 2 under the adapter keys `reference-social` / `reference-readonly`, `createReferenceIntegrationStub` × 2, `createReferenceSocialAdapter` × 2) — the UX-005 disclosed pattern; the platform-health module, routes and migrations fully REAL (the disclosed reference in-memory double exists at the provider boundary ONLY) |
| The local OAuth provider double | the repo's `tests/integration/helpers/oauth-provider.ts` (a loopback HTTP server standing in for the provider: the token endpoint, the revocation endpoint, the resource-owner fixture that mints authorization codes) |
| console | `bun run dev` on :3011, the dev-proxy bridge `/api/mos/*` → 127.0.0.1:3012 (`MOS_UPSTREAM_ORIGIN` + `MOS_BRIDGE_FORCE_PROXY=1`, no `MOS_DATABASE_URL` — the bridge is ALWAYS the pure proxy) |
| driver control server | 127.0.0.1:3099 — every endpoint drives REAL HTTP routes only (login, the credential-reference provisioning, the policy allowances, the provider callback → the real complete route, the /metrics observation appends, the 056 restricted submit through the module seam, the operator membership) |

## Fixtures — through the platform's OWN real routes, with the owner's session

Everything below went over real HTTP against the seam API (the owner's
Bearer token from a real `/api/auth/login`; never DB seeding, never
fabricated client-side):

- the sign-up (`owner@ux007.test`, agency "UX007 Health Verify Co")
  through the real `POST /api/mos-signup` orchestrator — the CONSOLE UI;
- the client "Verdant Bloom Tea" created **through the console UI**
  (`POST /api/agencies/:agencyId/clients` via the form);
- the **credential references** (`POST /api/agencies/:agencyId/credentials`
  with the opaque handle of material provisioned in the deployment's
  secret backend — the deployment provisioning step; creating a credential
  reference has no console surface and the console never sees material)
  — the first through the driver, the second through the same real route
  when the third pipe needed its own (the platform's duplicate-connection
  guard refuses a second pipe on the same credential — the honest 409);
- the **agency-scoped network + secrets policy allowances**
  (`POST /api/agencies/:agencyId/policies` — the same allowances the
  integration tests use for the happy path);
- the reference-social / reference-readonly integration pipes 1 and 2
  registered + probed **through the console UI** (the register dialog +
  the Connect probe); pipe 3 (a second reference-social binding for the
  cold-start path) registered through the SAME real route driver-side
  after the reopened dialog form hit a 422 (disclosed below);
- the three OAuth rounds run **through the console UI** (authorize-start
  201 → the honest pending panel); the provider's callback driven by the
  journey driver exactly as production's redirect-back would arrive (the
  provider double mints the authorization code; the driver POSTs the REAL
  `/social-accounts/complete` route with the owner's session and the
  round's state) — then the console's "Check for the completed
  connection" re-reads the real state and the cards render live;
- the `social.reach` metric observations appended through the REAL
  `POST /api/clients/:clientId/metrics` route (the social-analytics
  normalizer seam): the main account's own history (1000, 1100, 950 →
  collapse 120, 90 — the sustained deviation) + the stable cross-platform
  control series (800, 850, 780, 820, 810) + the cold-start account's
  thin two-point history (900, 920), with the /evidence anchor record
  created through the real `POST /api/clients/:clientId/evidence` route;
- the 056 restricted publish attempt (the provider-exposed
  `REFERENCE_ELIGIBILITY_HOLD` restriction signal — the
  platform-CONFIRMED record) submitted through the module seam exactly as
  the integration test does it (`setNextSubmitState('restricted')` +
  `submitPublish`);
- the agency OPERATOR membership (`operator@ux007.test`) created through
  the real routes (the bootstrap admin creates the identity + credential;
  the OWNER adds the membership) for the permission-state verification.

**Every evaluation in the journey ran through the REAL POST route from
the console UI** (`POST /api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations`,
empty body, the owner's session — four evaluations total, confirmed in
the DB: `healthy/low`, `suspected_distribution_anomaly/medium`,
`restricted/high`, `healthy/low`).

## The journey (screenshots 01–28, desktop 1280×800 + mobile 390×844)

| # | step | the API evidence composed | result |
| --- | --- | --- | --- |
| 01 | Fresh sign-up → the outcome-first home | real `POST /api/mos-signup` | ✓ |
| 02 | Client created through the console surface → the workspace tab bar carries **Health** (5th tab, HeartPulse icon, after Content) | real `POST /api/agencies/:agencyId/clients` | ✓ |
| 03 | The Health tab with no accounts: the honest empty state ("nothing to evaluate yet, and nothing is invented here") + the "Open the Connections Center" action + the authority's standing disclosure rendered verbatim from the API response | `GET /api/clients/:id/platform-health` + `GET /api/clients/:id/social-accounts` (empty) | ✓ |
| 04 | The Connections Center (the connect path) | `GET /api/clients/:id/connections` + `GET /api/integrations/adapters` | ✓ |
| 05 | The reference-social pipe registered through the console's register dialog | real `POST /api/clients/:id/connections` | ✓ |
| 06 | The connect probe → connected · healthy | real `POST …/connections/:id/connect` | ✓ |
| 07 | The Connect gate (requested scopes + the consequence text) | — | ✓ |
| 08 | **The REAL authorize-start round (201)**: the honest pending panel — completing it needs the provider's callback, never a connected state before that | real `POST …/social-accounts/authorize-start` → 201 | ✓ |
| 09 | The provider callback lands (driver = the redirect-back, through the REAL complete route) → "Check for the completed connection" → the live account card | real `POST …/social-accounts/complete` | ✓ |
| 10 | The second platform (reference-readonly) composes the same card generically — pipe → probe → OAuth round → callback → live | the same real routes, different adapterKey | ✓ |
| 11 | The Health tab with both accounts + zero evaluations: the tab-level honest empty state + both per-account "No evaluations yet — run the first evaluation" states with the run action and the "See the connection" reverse link | `GET /api/clients/:id/platform-health` (empty evaluations) | ✓ |
| 12 | **The first REAL evaluation** (the empty-observable posture): `healthy` · confidence low · the uncertainty verbatim ("no observable records in the composed window — the state reflects the absence of negative signals only") | real `POST …/platform-health/accounts/:id/evaluations` → 201 | ✓ |
| 13 | The first evaluation's drill-down: the reason codes ("no observable records"), the honest no-maneuver state, the account-record evidence basis, the FK-anchored citations (fetched live — all honest `none (0)`), the baseline disclosure, the signals-considered rows, the provenance + ph-vocab-v1/ph-baseline-v1 versions | the record + `GET /api/platform-health/evaluations/:id` (on expand) | ✓ |
| 14 | The metric history appended (the social-analytics seam) → **"Run evaluation again" → `suspected distribution anomaly` · confidence medium** with the SUSPECTED qualifier ("an anomaly signal without a platform-confirmed restriction, never a shadow-ban claim") and the uncertainty carrying the baseline numbers + the control verdict | real `POST /metrics` × 10 (driver) + the REAL POST evaluation route | ✓ |
| 15 | The anomaly drill-down: reason codes (`observed metric deviation below baseline`, `cross platform control divergence`), the §11 maneuvers AS DATA (change content mix / adjust transformations / shift to another connected platform / preserve goal change route — each with description + rationale), the metric-observation evidence basis | the record + the citation detail read | ✓ |
| 16 | The FK-anchored citations of the anomaly verdict: 1 evidence anchor + 5 metric observations (SourceRefList pills) + the baseline summaries (the account series flagged below baseline · median 1000 · recent 120, 90 — and the unflagged cross-platform control · median 800) + the append-only tail | `GET /api/platform-health/evaluations/:id` | ✓ |
| 17 | The 056 restricted submit → **"Run evaluation again" → `restricted` · confidence high** with the DISTINCT platform-confirmed qualifier ("the provider's own restriction record, not an inference") | the 056 module seam + the REAL POST evaluation route | ✓ |
| 18 | The restricted drill-down: reason codes (`platform confirmed restriction signal`, `restricted publish outcome observed`), the §11 maneuvers (pause risky strategy / platform appeal or review / request human interaction / preserve goal change route), the restriction-signal + publish-attempt evidence basis, the 056 citation link | the record + the citation detail read | ✓ |
| 19 | The control account evaluated: `healthy` · confidence high (its own stable series — no negative signals) | the REAL POST evaluation route | ✓ |
| 20 | **The Connections→Health cross-link**: the "Health" action on the account card lands on the Health tab with THAT account's card focused — drill-down open, scrolled into view, the ring highlight | — (the SPA navigation composing the same authority) | ✓ |
| 21 | **The owner|admin permission state**: signed in as the agency OPERATOR — both run buttons disabled with the honest note ("Running evaluations is reserved to the agency owner and admins — your role here: agency operator. The recorded evaluation history stays fully readable") and the full evaluation picture still readable | the server-derived authorization context + `GET …/platform-health` (member reads open) | ✓ |
| 22 | Mobile 390×844: the Health tab (operator session) — the stacked cards, 0px overflow | — | ✓ |
| 23 | Mobile 390×844: the card drill-down open — reflowed, usable, 0px overflow through the full open picture | — | ✓ |
| 24 | The full Health tab, desktop 1280×800 (full-page, two cards at that point) | — | ✓ |
| 25 | The cold-start path: a third account (a second reference-social binding) with a thin two-point metric history → **"Run the first evaluation" → `healthy` · confidence low · the honest `insufficient baseline` uncertainty** ("fewer than 3 prior observations per series — no anomaly verdict is produced") | the real connect path + the real /metrics route + the REAL POST evaluation route | ✓ |
| 26 | The cold-start drill-down: reason codes (`no negative observable signals`, `insufficient baseline`), the honest no-maneuver state, the account-record basis | the record + the citation detail read | ✓ |
| 27 | The full Health tab with all three account cards, desktop 1280×800 (full-page): restricted (platform-confirmed, high) · healthy (control, high) · healthy (cold-start, low) | `GET /api/clients/:id/platform-health` grouped per account | ✓ |
| 28 | Mobile 390×844: the three-card Health tab — 0px overflow | — | ✓ |

## Error accounting

- Page errors: **0** at every step (the agent-browser page-error log is
  empty across the whole journey, both viewports).
- Console errors: **0 on every clean load and in-place navigation**. ONE
  hydration warning ("a tree hydrated but some attributes of the server
  rendered HTML didn't match") appeared ONCE, during the dev-mode
  hot-reload cycle while the worker was mid-edit on
  `connections-atoms.tsx` (adding the `detailLabel` prop) — the
  pre-existing dev-mode hydration-warning class the UX-005 record
  disclosed ("2–4 per page load, on every console page in `next dev`").
  Every subsequent clean load (home, workspace Overview, the Health tab,
  in-place tab navigations, fresh reloads at both viewports) produced
  zero console errors/warnings.
- Horizontal overflow: **0px** — the probe measures
  `scrollWidth − clientWidth` at every 700px scroll position through the
  fully-open Health tab (three cards, one drill-down fully expanded) at
  1280×800 AND at 390×844 (`max-overflow=0px` recorded per phase).
- Viewport verified programmatically (`window.innerWidth × innerHeight`):
  1280×800 for the desktop phases, 390×844 for the mobile phase.

## Honest notes (sandbox limitations + judgment calls, disclosed)

1. **The evaluation path is the seam path** (exactly which path each
   screenshot shows): every screenshot ran against the seam API (:3012 —
   the repo's own integration-test seams: the local OAuth provider double
   + the reference integration/social adapters). The console CODE is the
   production code; the standalone deployment posture (no registered
   OAuth flows — the honest 409 the UX-005 journey captured) was not
   re-verified here (it is UX-005's recorded evidence, unchanged by this
   delta — the Health surface composes whatever the accounts surface
   serves).
2. **The provider callback is driver-driven** (the UX-005 disclosed
   pattern): the local OAuth provider double has no browser login page.
   The journey drives the redirect-back exactly as production would: the
   provider mints the authorization code, the driver POSTs the real
   complete route with the owner's session and the round's state (read
   from the pending grant row — the driver-side DB plumbing seam; the
   browser only ever sees real routes). The console's honest pending
   panel (screenshot 08) shows what the operator sees before that
   callback lands — never a fake success.
3. **Pipe 3's registration went driver-side** (through the same real
   `POST /api/clients/:id/connections` route the console's register
   dialog composes): the reopened dialog form hit a 422 after several
   open/close toggles following the honest 409 duplicate-connection
   refusal (a third pipe needs its own credential reference — the
   platform's own guard). Pipes 1 and 2 were registered through the
   console UI, proving the dialog path; pipe 3's registration is
   disclosed as driver-side provisioning through the identical route.
   The cold-start account's OAuth round, its metric history and its
   evaluation ALL ran through the console UI / real routes.
4. **The metric observations are driver-appended through the REAL
   /metrics route** (the social-analytics normalizer seam — the platform
   produces these as connected platforms report; the driver emitted the
   fixture series exactly as the platform's own integration test does).
   The /evidence anchor likewise through the real /evidence route.
5. **The 056 restricted submit is the module seam** (`submitPublish`,
   exactly the integration-test fixture — the 056 idempotency ledger is
   the only physical publish path and the cross-platform-distribution
   dispatch would route through it; no distribution plan was created in
   this journey). The provider-exposed `REFERENCE_ELIGIBILITY_HOLD`
   signal rides the attempt record as the platform-confirmed restriction.
6. **Four of the frozen nine states verified in the browser**:
   healthy (the empty-observable posture AND the insufficient-baseline
   cold start), suspected_distribution_anomaly (with the cross-platform
   control divergence sharpening it to medium), restricted
   (platform-confirmed, high). The remaining five states (degraded,
   suspected_automation_risk, authorization_blocked, publishing_blocked,
   quota_limited, human_review_required) are produced by the same
   rendering path (the same state chip map, the same drill-down blocks —
   only the vocabulary differs) and are covered by the authority's own
   unit + integration batteries; they were not separately staged in this
   browser journey.
7. **The run-evaluation action is not confirm-gated**: an evaluation is
   an append-only read-and-record composition (a NEW record; no state is
   mutated, nothing is destroyed) — the UX-005 confirm gates are reserved
   for destructive transitions. The button names what it does and the
   result renders honestly.
8. **The mobile viewport steps navigate at desktop width, then reflow
   the live surface to 390×844** (the UX-005 disclosed pattern — the
   vaul navigation drawer's touch surface intercepts pointer automation).
   The reflow exercises the identical responsive layout (screenshots
   22/23/28); the overflow probe confirms 0px at 390×844.

## Files (this directory)

- `01`–`10`: the connect path — sign-up, the client workspace with the
  Health tab, the honest no-accounts empty state, the Connections
  Center, the pipe register + probe, the connect gate, the honest
  pending round, the live card, the second platform.
- `11`–`13`: the Health tab with accounts but no evaluations (the honest
  empty states) + the first REAL evaluation (healthy/low, the
  empty-observable posture) + its drill-down.
- `14`–`16`: the anomaly path — the metric history, the
  suspected_distribution_anomaly verdict (medium, the SUSPECTED
  qualifier, never a shadow-ban claim), the §11 maneuvers as data, the
  FK-anchored citations, the baseline summaries, the append-only tail.
- `17`–`19`: the restricted path (platform-confirmed, high — the
  distinct qualifier) + its drill-down + the control account's healthy
  verdict.
- `20`–`21`: the two entry points composing — the Connections→Health
  cross-link landing (focused, drill-down open) and the operator's
  honest permission state (run disabled, reads fully open).
- `22`–`24`: mobile 390×844 (the tab, the open drill-down) + the full
  desktop tab.
- `25`–`28`: the cold-start path (the honest insufficient-baseline
  disclosure) + its drill-down + the full three-card tab at both
  viewports.
