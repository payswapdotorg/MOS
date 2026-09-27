# UX-005 — Connections Center: browser journey evidence

Recorded in-sandbox by the UX-005 worker (agent-browser over Chromium)
against the delivery branch `ux/005-worker-delivery` — **embedded
PostgreSQL 18** (a persistent cluster at a fixed port, the repo's own
integration-test harness binaries, fresh database `ux005_journey`, 51
migrations at boot, latest `057_content_intelligence.sql`), real sign-up
through the console's `/api/mos-signup` orchestrator — no seeded demo
data, no DB writes outside the platform's own contracts.

## The stack (all real, in-sandbox)

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | persistent embedded cluster (the repo's `embedded-postgres` harness + `ensureIcu60`), fixed port, fresh database `ux005_journey` |
| The STANDALONE MOS platform API | `node src/entrypoints/api.ts` on 127.0.0.1:**3010** — the production composition (NO OAuth flows, NO seam adapters — the pure deployment posture) |
| The SEAM API | `bootstrapApplication` + `buildApiRouter` + `createHttpServer` on 127.0.0.1:**3012** with the repo's OWN integration-test seams (`createLocalOAuthFlow` × 2 under the adapter keys `reference-social` / `reference-social-2`, `createReferenceIntegrationStub` × 2, `createReferenceSocialAdapter` × 2) — the UX-004 disclosed pattern, sharing the SAME database |
| The local OAuth provider double | the repo's `tests/integration/helpers/oauth-provider.ts` (a loopback HTTP server standing in for the provider: the token endpoint, the revocation endpoint, the resource-owner fixture that mints authorization codes) |
| console | `bun run dev` on :3011, the dev-proxy bridge `/api/mos/*` → the chosen upstream (:3010 for Phase A, :3012 for Phases B1–B3 — `MOS_BRIDGE_FORCE_PROXY=1`, no `MOS_DATABASE_URL`, so the bridge is ALWAYS the pure proxy, never the in-process mode) |
| driver control server | 127.0.0.1:3099 — every endpoint drives REAL HTTP routes only (login, credential-reference provisioning, agency policy allowances, the provider callback → the real complete route, the notification delivery command) |

## The two OAuth paths (disclosed exactly, per the work order)

1. **Phase A — the pure standalone deployment (bridge → :3010):** the
   Connect action runs the REAL authorize-start round against the
   production composition, which registers NO OAuth flow — the platform
   answers the fail-closed **409** and the console renders the server's
   own words verbatim (screenshot 07). NEVER a fake success.
2. **Phases B1–B3 — the seam path (bridge → :3012):** the same console
   code against the seam API where the repo's own integration-test seams
   register the OAuth flow + reference adapters. authorize-start returns
   the authorizationId + state + authorizeUrl (201, the round IS
   recorded); the provider's callback is driven by the journey driver
   exactly as production's redirect-back would arrive (the provider double
   mints the authorization code; the driver POSTs the REAL
   `/social-accounts/complete` route with the owner's session and the
   state+code) — then the console's "Check for the completed connection"
   re-reads the real state and the binding + grant + card render live.

## Fixtures — through the platform's OWN real routes, with the owner's session

Everything below went over real HTTP against the seam or standalone API
(the owner's Bearer token from a real `/api/auth/login`; never DB
seeding, never fabricated client-side):

- the sign-up (`ama@ux005.test`, agency "UX005 Connections Verify Co")
  through the real `POST /api/mos-signup` orchestrator;
- the client "Verdant Bloom Tea" created through the real console
  surface (`POST /api/agencies/:agencyId/clients` via the UI form);
- the **credential reference** (`POST /api/agencies/:agencyId/credentials`
  with the opaque handle of material provisioned in the deployment's
  secret backend — the deployment provisioning step; creating a
  credential reference has no console surface and the console never sees
  material);
- the **agency-scoped network + secrets policy allowances**
  (`POST /api/agencies/:agencyId/policies` — the same allowances the
  integration tests use for the happy path);
- the CRM integration connection registered + the connect probe run
  **through the console UI** (the register dialog + the Connect probe);
- the reference-social / reference-social-2 integration pipes registered
  + probed **through the console UI**;
- the two notification deliveries (`POST /api/clients/:clientId/notifications`)
  — the platform produces notifications as work runs; the driver emitted
  two exactly as the platform would.

## The journey (screenshots 01–30, desktop 1280×800 + mobile 390×844)

| # | step | the API evidence composed | result |
| --- | --- | --- | --- |
| 01 | Fresh sign-up → the outcome-first home | real `POST /api/mos-signup` | ✓ |
| 02 | Client created through the console surface → the workspace tab bar carries **Connections** (3rd tab, plug icon) | real `POST /api/agencies/:agencyId/clients` | ✓ |
| 03 | The Connections tab renders the honest empty state (all three families) + the adapter registry platform list | `GET /api/clients/:id/social-accounts` (empty), `GET /api/integrations/adapters` | ✓ |
| 04 | The CRM pipe registered through the console's register dialog (adapter pick + credential reference pick + provider base URL) | real `POST /api/clients/:id/connections` | ✓ |
| 05 | The connect probe → connected · healthy (the CRM adapter's real probe against the provider double's /v1/ping) | real `POST …/connections/:id/connect` | ✓ |
| 06 | The Connect gate: requested-scopes intent + the consequence text | — (the confirm gate before the OAuth round) | ✓ |
| 07 | **The standalone 409, verbatim**: "no OAuth flow implementation is registered for platform 'crm' in this deployment (the adapter contract arrives with MKT-056+)" | real `POST …/social-accounts/authorize-start` → 409 | ✓ |
| 08 | The seam registry composes generically: `reference-social` + `reference-social-2` rows appear from the registry (no hardcoded provider lists) | `GET /api/integrations/adapters` (8 adapters) | ✓ |
| 09 | The reference-social pipe registered + probed through the UI → connected · healthy | real `POST /api/clients/:id/connections` + `/connect` | ✓ |
| 10 | The Connect gate with the requested scopes `account:read content:read analytics:read` | — | ✓ |
| 11 | **The REAL authorize-start round (201)**: the honest pending state — the authorizationId, the authorizeUrl, "completing it needs the provider's callback — never a connected state before that" | real `POST …/social-accounts/authorize-start` → 201 { authorizationId, state, authorizeUrl } | ✓ |
| 12 | The provider callback lands (the driver = the redirect-back, through the REAL complete route) → "Check for the completed connection" → **the card renders live**: `@verdantbloomtea` · connected · authorized · the 4-second expiry the provider reported | real `POST …/social-accounts/complete` {state, code} → the binding + grant + scope facts | ✓ |
| 13 | The grant drill-down: the verbatim scope facts (granted vs requested chips), the capability tags, the grant record, the event tail, the capability surface from the registry | real `GET …/grants` + `GET …/grants/:grantId` + `GET …/events` | ✓ |
| 14 | The short-lived token expires (the provider-reported expiry passes) → a tab away and back re-reads the real state → the card shows the expired signal + the **Reauthorize** action | the lazy-expiry comparison on the grant's own `expiresAt` | ✓ |
| 15 | The reauthorize round (the recovery path of an expired authorization): a fresh pending round pre-bound to the account | real `POST …/:accountId/reauthorize` → 201 | ✓ |
| 16 | The recovery callback → the card re-authorized with the 45-day expiry | real `POST …/complete` | ✓ |
| 17 | The grant history after recovery: the expired-era grants visibly historical | real `GET …/grants` | ✓ |
| 18 | The Refresh round → the successor grant appends; the old grant becomes `refreshed · history` with the successor link | real `POST …/:accountId/refresh` → 200 | ✓ |
| 19 | The Disconnect confirm gate (the destructive action): consequence text + the reason input | — | ✓ |
| 20 | The disconnected card: the terminal state + the honest note ("a dead binding is never reactivated in place; a fresh Connect round re-binds") | real `POST …/:accountId/disconnect` | ✓ |
| 21 | The dead connection: the grants read **refuses 409 verbatim** ("every read of a disconnected/revoked connection's grant refuses (fail-closed)") while the event tail stays readable (audit) — `authorization revoked` + `account disconnected` events with the recorded reason | real `GET …/grants` → 409 + `GET …/events` → 200 | ✓ |
| 22 | The recovery of a dead binding: the platform's own rule — a FRESH authorize-start round on the connection | real `POST …/authorize-start` → 201 | ✓ |
| 23 | The fresh binding renders live; **the dead binding stays as visible history** (two cards, same identity) | real `POST …/complete` + the accounts list | ✓ |
| 24 | A second platform (`reference-social-2`) composes the same card generically: register → probe → OAuth round → callback → live card | the same real routes, different adapterKey | ✓ |
| 25 | The notification family: channel health from the inbox's own facts + the append-only channel receipts (`in_app` · `delivered`, the provider message id, the policy decision) on expand | real `GET /api/clients/:id/notifications` + `GET …/notifications/:notificationId` | ✓ |
| 26 | The mission-creation connections step (UX-002) shows the client's real connections + the **"Manage connections →"** link | `GET /api/clients/:id/social-accounts` | ✓ |
| 27 | The link lands in the Connections Center (the second entry point) | — | ✓ |
| 28 | Mobile 390×844: the wrapped tab bar + the stacked center (see Honest notes #5) | — | ✓ |
| 29 | Mobile 390×844: the card drill-down open — reflowed, usable | — | ✓ |
| 30 | The full center, desktop 1280×800 (full-page) | — | ✓ |

## Error accounting

- Page errors: **0** at every phase (both viewports — the agent-browser
  page-error log is empty; the bare marker line agent-browser prints when
  there are none was classified correctly).
- Console errors: **0** at every phase. The only console entries are the
  pre-existing dev-mode React **hydration warnings** (2–4 per page load,
  on every console page in `next dev`, unrelated to UX-005) plus
  dev-tools info logs.
- Horizontal overflow: **0px** — the probe measures
  `scrollWidth − clientWidth` at every 700px scroll position through the
  fully-open center at 1280×800 AND at 390×844 (`max-overflow=0px`
  recorded per phase in the logs).
- Viewport verified programmatically (`window.innerWidth × innerHeight`):
  1280×800 for the desktop phases, 390×844 for the mobile phase.

## Honest notes (sandbox limitations + judgment calls, disclosed)

1. **The two OAuth paths** (exactly which path each screenshot shows):
   screenshots 01–07 ran against the pure **standalone deployment**
   (:3010 — the production composition with no registered OAuth flows);
   screenshots 08–30 ran against the **seam API** (:3012 — the repo's own
   integration-test seams: the local OAuth provider double + the
   reference integration/social adapters). The console CODE is identical
   in both phases; only the bridge's upstream differs. The standalone
   409 (screenshot 07) is the honest production posture until platform
   flows register.
2. **The provider callback is driver-driven**: the local OAuth provider
   double has no browser login page (it is a JSON API — the resource-owner
   fixture endpoint). The journey drives the redirect-back exactly as
   production would: the provider mints the authorization code, the
   driver POSTs the real complete route with the owner's session and the
   round's state. The console's honest pending panel (screenshot 11)
   shows what the operator sees before that callback lands — never a
   fake success.
3. **Driver-side provisioning through real routes** (disclosed above):
   the credential reference, the policy allowances, and the notification
   emissions. The console owns the register/connect/suspend of
   integration connections and every OAuth round; credential-reference
   creation is the deployment provisioning step (outside UX-005's scope —
   no console surface exists).
4. **The Refresh round runs in the same process as its callback** — the
   provider double's token store is per-process (a fresh double per
   station boot does not know a previous process's refresh tokens). The
   journey sequences the refresh accordingly; at the integration station
   (a long-lived provider) this constraint disappears.
5. **The mobile viewport step navigates at desktop width, then reflows
   the live center to 390×844** — the vaul navigation drawer's touch
   surface intercepted pointer automation (the drawer swallowed the
   Clients click). The reflow exercises the identical responsive layout
   (the wrapped tab bar and the stacked center are visible in screenshots
   28–29); the overflow probe confirms 0px at 390×844.
6. **The `expiresAt`-passed display comparison**: the card marks a grant
   expired when the platform-reported expiry has passed — the same
   lazy-expiry rule the platform itself applies on usable-authorization
   reads; the comparison runs on the grant's own datum (never an invented
   state). The recorded grant state stays what the record says.
7. **Two `notification delivery` vocabulary levels** (kept honest): the
   record's `deliveryStatus` is the adapter-plane dispatch lifecycle
   (`pending | dispatched` — shown as-is on the row); the per-channel
   truth is the receipt outcomes (`delivered | failed | refused |
   duplicate-skipped` — shown as the receipts). The channel-health chips
   derive ONLY from the inbox view's own facts (deliveredAt / readAt).
8. **The second platform composes generically because the card reads the
   registry** — the platform list is `GET /api/integrations/adapters`
   mapped, not a hardcoded provider list; sibling adapters (TikTok et
   al.) will appear when they register, with zero console changes.

## Files (this directory)

- `01`–`07`: Phase A — the standalone deployment: sign-up, home, the
  client workspace with the Connections tab, the honest empty state, the
  CRM pipe register + probe, the connect gate, **the 409 verbatim**.
- `08`–`18`: Phase B1 — the seam path: the generic registry, the pipe,
  the connect gate, the pending round, the live card, the scope facts,
  the expiry → reauthorize recovery, the grant history, the refresh
  successor.
- `19`–`23`: Phase B2 — the disconnect confirm gate, the dead card, the
  409 + events, the fresh-connect recovery, the dead-kept-as-history.
- `24`–`27`: Phase B3 — the second platform, the notification receipts,
  the UX-002 "Manage connections →" link and its landing.
- `28`–`30`: mobile 390×844 (center + drill-down) and the full center.
