# UX-010 — Progressive-disclosure hardening: browser journey evidence

Recorded in-sandbox by the UX-010 worker (agent-browser over Chromium)
against the delivery branch `ux/010-worker-delivery` (base `2a4aa84` —
frozen main — plus the console-only UX-010 delta) — **embedded PostgreSQL
18** (the repo's own integration-test harness binaries + ICU provisioning,
fresh database `mosjourney`), the REAL API entrypoint as a detached
subprocess, real sign-up through the console's `/api/mos-signup`
orchestrator — no seeded demo data, no DB writes outside the platform's
own contracts.

## The stack (all real, in-sandbox)

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | embedded server (the repo's `tests/integration/helpers/pg.ts` harness discipline — ICU-60 provisioning, ephemeral-era boot on `127.0.0.1:5546`, fresh database `mosjourney`), migrations applied by the platform's own composition root at API boot |
| The API | the repo's own `src/entrypoints/api.ts` as a real detached subprocess on `127.0.0.1:3010` (`MOS_ENV=dev`, `MOS_OBJECT_STORE=fs`, file-backed secret store, bootstrap platform-admin configured) — every module, route and migration fully REAL |
| console | `next dev -p 3100`, the dev-proxy bridge `/api/mos/*` → the API (`MOS_UPSTREAM_ORIGIN=http://127.0.0.1:3010`, no `MOS_DATABASE_URL` — the bridge is the pure dev proxy) |
| driver | agent-browser (headless Chromium, viewports set programmatically to 1280×800 and 390×844) for the UI; REAL HTTP routes with the owner's Bearer session for the driver-side fixtures |

The stack processes were daemonized with a detached-spawn launcher
(`spawn(detached: true)` + `unref()`, new session, stdio to files) — this
sandbox reaps naively-backgrounded children between commands, and the
launcher is the minimal pattern that survives; the launcher and PG boot
script live OUTSIDE the delivery (sandbox-only files, never committed).

## Fixtures — through the platform's OWN real routes, with the owner's session

Everything below went over real HTTP or the console UI (the owner's Bearer
token from a real `/api/auth/login`; never DB seeding, never fabricated
client-side):

- the sign-up (`ux010.worker@journey.test`, agency "UX-010 Journey
  Agency") **through the console UI** (the real `POST /api/mos-signup`
  orchestrator — screenshot 02);
- the client "Helio Robotics" created **through the console UI**
  (`POST /api/agencies/:agencyId/clients` via the form — screenshot 04);
- the research session "Widget niche trends" declared **through the
  console UI** (the Research family's confirm-gated create dialog —
  screenshots 12–13) and the research pass run **through the console UI**
  (the card's expanded primary + its confirm gate — screenshots 15–16);
  the pass over `https://example.test/…` recorded its honest failed
  outcome server-side (`research.pass.completed … status: "failed",
  facts_retained: 0`) and the card renders "No facts retained yet";
- the integration connection "Generic analytics platform" registered
  **through the console UI** (the Product & store pipes family's
  confirm-gated register dialog, over a credential reference created
  through the real `POST /api/agencies/:agencyId/credentials` after
  provisioning the file-backed secret handle — screenshots 19);
- the connect probe run **through the console UI** (the card's secondary
  Connect action): the platform refused it fail-closed
  (`POLICY_DENIED — dimension 'network', reason 'no-active-policy'`) and
  the card renders the refusal VERBATIM in the RouteRefusalNote —
  screenshot 21 (an honest blocked state + the retry affordance, exactly
  the no-silent-capability-failure rule);
- the experiment (controlled_comparison, "Question-led hooks lift early
  retention for this niche") declared through the real
  `POST /api/clients/:clientId/experiments` with the owner's session
  (the console has no experiment-declaration surface — the UX-008
  disclosed driver-side pattern);
- the mission (audience_growth, "Grow the Helio Robotics audience with
  question-led short videos") declared through the real
  `POST /api/agencies/:agencyId/growth-missions` with the owner's
  session, then opened through the console UI (Home → Continue a mission
  → Open the mission workspace — screenshots 24–26).

## The journey (screenshots 01–36, desktop 1280×800 + mobile 390×844)

| # | step | the hardening verified | result |
| --- | --- | --- | --- |
| 01 | The sign-in/sign-up screen at 1280×800 | — (unchanged surface) | ✓ |
| 02 | Fresh sign-up → the outcome-first home | the empty Missions section carries ONE primary ("Start a mission") — "Today / Operations" demoted to the secondary register | ✓ |
| 03 | Clients empty state | — (unchanged surface) | ✓ |
| 04 | Client created → the Client Workspace **Overview first view** | calm and summary-level: the live "Where this client stands" count strip, the actionable Awaiting-approval card (when present), the six decision-room cards behind ONE collapsed "The full picture" disclosure, the route source line moved into the collapsed Sources disclosure; the workspace header no longer leads with the mono clientId | ✓ |
| 05 | Overview → "The full picture" expanded | every block renders its own honest empty state (no goals / workflows / learnings / evidence / experiments / recommendations) | ✓ |
| 06 | Overview → Sources & composition expanded | the decision-room route + generated-at stamp render inside the disclosure layer | ✓ |
| 07 | **Connections first view** | ONE primary action ("Connect a channel") + three collapsed section summaries with LIVE one-line state ("no channels connected yet" / "none registered yet" / "nothing delivered yet") + the collapsed Sources disclosure — no cards, no route names, no ids on first paint | ✓ |
| 08 | The primary clicked | it opens + scrolls to the Channels section (the disclosure sequencing) | ✓ |
| 09 | Product & store pipes expanded | the honest empty state + the single register action + product-language copy (no "adapter/registry/pipe/OAuth round" jargon at the summary level) | ✓ |
| 10 | Notifications expanded | the honest no-action empty state | ✓ |
| 11 | **Content first view** | ONE primary action ("Start a research session") + four collapsed family summaries with LIVE state + the collapsed Sources disclosure | ✓ |
| 12 | The primary clicked → Research family opens | the disclosure sequencing for the pipeline's entry point | ✓ |
| 13 | Research session created through the confirm gate | the card's summary speaks product language ("Research session · declaration v1 · created/updated …", "Expand to see the topic…") — the mono session id no longer the title; the section summary line flips to "1 session recorded" | ✓ |
| 14 | The session card expanded | the run action now lives INSIDE the expanded detail (the card's single primary) with the session id at the detail's edge | ✓ |
| 15–16 | The research pass run through its confirm gate | the honest per-source outcome block ("RESEARCH RUNS (1) — THE HONEST PER-SOURCE OUTCOMES", "No facts retained yet") — the failed fetch renders as recorded, nothing invented | ✓ |
| 17 | **Health first view** (no accounts) | the standing observability disclosure keeps its on-every-view position with the PRODUCT-LANGUAGE label ("What this health picture can and cannot see"); the empty state keeps its single teal next action ("Open the Connections Center"); route names moved into the collapsed Sources disclosure | ✓ |
| 18 | **Treatments first view** (no experiments) | the honest no-experiments empty state with its single teal next action; the mission-states section; the collapsed "Sources, composition & the honest gap" disclosure | ✓ |
| 19 | The integration connection registered through the UI | the card's summary is product language ("Generic analytics platform · not live — run the connect probe · registered · unknown · never checked yet") — adapterKey/connectionId/credential ids live only in the expanded Connection record; the `registered · unknown` chip renders in the NEW amber warning tone (undetermined health is no longer neutral) | ✓ |
| 20–21 | The connect probe run → honest policy refusal | the verbatim POLICY_DENIED refusal renders in the RouteRefusalNote (no silent capability failure); the probe failure is retried via the still-wired secondary Connect action | ✓ |
| 22 | The Treatments tab with the experiment | the collapsed card row is the product language (status chip + hypothesis + treatment vs comparison + measures) — the mono experiment id no longer the row lead | ✓ |
| 23 | The experiment card expanded | the declared design + the allocation/analysis tails load on expand (expand→fetch) with their honest empty states ("honestly unknown", "honestly no outcome to show") + the experiment id in the expanded footer | ✓ |
| 24 | Home → the mission row listed | — (unchanged surface, still calm) | ✓ |
| 25–26 | The mission workspace opened | the workspace keeps its seventeen-question collapsed sections; the closing route SourceLine now lives in the collapsed Sources & composition disclosure | ✓ |
| 27 | Mobile 390×844 — home | 0px horizontal overflow, 0 page errors | ✓ |
| 28 | Mobile — client Overview first view | 0px overflow (the count strip + collapsed disclosures reflow) | ✓ |
| 29 | Mobile — **Connections first view** | 0px overflow (the primary + three summary rows stack) | ✓ |
| 30 | Mobile — **Content first view** | 0px overflow | ✓ |
| 31 | Mobile — **Health first view** | 0px overflow | ✓ |
| 32 | Mobile — **Treatments first view** | 0px overflow | ✓ |
| 33–34 | Mobile — Connections pipes section expanded with the live connection card | 0px overflow with the card + chips + refusal note reflowed | ✓ |
| 35 | Mobile — the mission workspace | 0px overflow | ✓ |
| 36 | Desktop — the Scientific trace tab (unchanged surface, regression check) | renders clean at 1280×800 (1280 scrollWidth, 0 errors) | ✓ |

## The one-primary-action audit (verified per screen state)

| screen state | the ONE primary | everything else |
| --- | --- | --- |
| Home (no missions) | "Start a mission" (teal) | "Today / Operations" — secondary (plain) |
| Client Overview | none at rest (the disclosures are the affordances); "Open the client workspace" from the mission banner stays teal (the workspace entry) | the full-picture + sources toggles (disclosure controls) |
| Connections (any state) | "Connect a channel" (teal, opens the Channels section) | per-card Reauthorize/Refresh/Health (plain), Disconnect/Suspend (amber confirm-gated), Register another connection (plain) |
| Connections — pipes empty | "Register a connection" (teal, the section's single create entry) | — |
| Content (any state) | "Start a research session" (teal, opens the Research family) | per-card actions render plain at summary level; the card's own primary (Run pass / Evaluate gate / Materialize) lives INSIDE the expanded detail |
| Health — no accounts | "Open the Connections Center" (teal) | — |
| Health — accounts present | none at the collapsed first view; the per-account Run action lives in the expanded card detail as that record's primary (teal) | "See the connection" (ghost cross-link) in the expanded detail |
| Treatments — no experiments | "Open the Scientific trace" (teal) | — |
| Treatments — populated | none at rest (an observational surface); the per-mission "Open the mission workspace" lives in the expanded row (plain) | — |
| Dialogs (confirm gates) | the dialog's own confirm button (teal/red by gate tone) | Cancel (plain) — one primary per dialog focus scope |

## Error accounting

- Page errors: **0** at every probe (after-signup, every hardened surface,
  expanded disclosures, populated states, mobile, final — the
  agent-browser page-error report was empty across the whole journey,
  both viewports).
- Console errors: **0** (nothing at error level in the browser console
  across the journey; the Next dev server log holds only the pre-existing
  two-lockfile workspace-root warning, an environment artifact, not a
  page error).
- Horizontal overflow: **0px** — `document.documentElement.scrollWidth`
  measured 390 at 390×844 and 1280 at 1280×800 on every hardened surface
  (home, client overview, Connections, Content, Health, Treatments, the
  expanded Connections pipes with the live card, the mission workspace).
- API log: the only warn/error lines are the journey's own honest events
  (the deliberate 404 probe, the research pass's recorded failed outcome,
  the two POLICY_DENIED connect refusals rendered verbatim in the UI, and
  the driver's two 422s while learning the frozen experiment vocabulary).

## Honest notes (sandbox limitations + judgment calls, disclosed)

1. **The Health surface's populated per-account state was verified at the
   UX-007 delivery** (its own evidence pack) and is NOT re-driven here:
   completing a social OAuth round needs a provider double this dev stack
   does not register (the registry holds the six product/store adapters;
   the reference social adapter is a test-double, not a deployment
   adapter). The hardening's Health changes (Run + permission notes +
   cross-link moved into the expanded card detail; the glance-icon tone
   fix; the product-language disclosure label; de-mono'd chips) were
   verified against the no-accounts state, the unchanged detail-body
   composition, and the type/lint/build gates. The per-account expanded
   Run action is wired exactly as before (same hook, same route, same
   permission gating) — moved, not changed.
2. **The connect probe's POLICY_DENIED outcome is the environment's own
   honest state** (a dev deployment with no active network policy) — it
   was kept as journey evidence precisely because it exercises the
   no-silent-capability-failure rule end-to-end: the refusal renders
   verbatim with the retry affordance, and the new amber
   `registered · unknown` chip keeps the undetermined-health state
   visible instead of neutral.
3. **Driver-side fixtures follow the UX-007/UX-008 disclosed pattern**:
   sign-up, the client, the research session + pass, the connection
   registration + probe went through the console UI; the credential
   reference, the experiment and the mission went through the identical
   real HTTP routes with the owner's session (the console has no surface
   for those operator/API actions — out of UX-010's scope).
4. **Viewport widths were set programmatically** (`agent-browser set
   viewport 1280 800` / `390 844`) and overflow measured via
   `document.documentElement.scrollWidth`.
5. **The stack daemons and the PG boot script are sandbox-only files**
   (`.ux010-boot-pg.mjs`, `.ux010-daemon.mjs`, `.test-deps/`) — excluded
   from the delivery commit; the delivery is the console delta + this
   evidence pack.
