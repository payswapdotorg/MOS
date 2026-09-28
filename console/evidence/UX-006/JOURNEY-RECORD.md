# UX-006 — Content/Rights operational surface: browser journey evidence

Recorded in-sandbox by the UX-006 worker (agent-browser over Chromium)
against the delivery branch `ux/006-worker-delivery` — **embedded
PostgreSQL 18** (the repo's own integration-test harness + `ensureIcu60`,
a persistent cluster at a fixed port, fresh database `ux006_journey`, 53
migrations at boot, latest `059_lab_contracts.sql`), real sign-up through
the console's `/api/mos-signup` orchestrator — no seeded demo data, no DB
writes outside the platform's own contracts.

## The stack (all real, in-sandbox)

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | persistent embedded cluster (the repo's `embedded-postgres` harness), fixed port, fresh database `ux006_journey` |
| The STANDALONE MOS platform API | `node src/entrypoints/api.ts` on 127.0.0.1:**3010** — the production composition (`bootstrapApplication` defaults; bootstrap platform admin configured; **shared FS object store** `MOS_OBJECT_STORE=fs`) |
| The SEAM API | `bootstrapApplication({ contentTransformationEngines: [...] })` + `buildApiRouter` + `createHttpServer` on 127.0.0.1:**3012** — the repo's OWN public transformation-engine doubles (`createPassthroughTransformationEngine`, `createFormatTransformationEngine`, `createCropTransformationEngine` from `src/modules/content-assets/public.ts`), sharing the SAME database and object store |
| The web-source double | a loopback HTTP server on 127.0.0.1:**3098** standing in for the public web (`/report` and `/guide`, rich meta) — the research pass fetched them over REAL HTTP through the platform's real `ResearchHttpPageReader`; only the web source itself is a double |
| console | `bunx next dev -p 3011`, the dev-proxy bridge `/api/mos/*` → the chosen upstream (:3010 for the standalone phases, :3012 for the transformation phases — `MOS_BRIDGE_FORCE_PROXY=1`, never the in-process mode) |
| driver-side provisioning | through the platform's REAL routes only: the agency network policy allowance (`POST /api/agencies/:id/policies` — the integration-test pattern) and one client goal (`POST /api/clients/:id/goals` — the Goals tab has no SPA creation path, disclosed on the surface itself) |

## The two API paths (disclosed exactly)

1. **The standalone phases** (screenshots 01–28, 43–44): the pure
   production composition on :3010. The research pass, the evidence
   promotion, the rights family (register → determination → permission →
   THE GATE) all ran against it. The transformation REQUEST against it
   answers the honest **409** — "no registered transformation engine
   serves kind 'format' — the engine registry is module data (EMPTY in
   production by default); register an engine at the composition root
   before requesting this kind" — screenshot 19, the server's own words
   verbatim. NEVER a fake success.
2. **The seam phases** (screenshots 29–35): the same console code against
   the seam API (:3012) where the repo's own public engine doubles are
   registered through the `AppOptions.contentTransformationEngines` seam
   (the integration-test posture). The transformation request → execute →
   derived output → lineage drill-down ran there. The engines are the
   repo's own disclosed doubles (`first-party:passthrough` etc. — their
   `declaredEffects` disclose the simulation; the format double is "NOT a
   real transcoder — disclosed", per their own source).

## Fixtures — through the platform's OWN real routes

- the sign-up (`operator@ux006.test`, agency "UX006 Content Verify Co")
  through the real `POST /api/mos-signup` orchestrator (the bootstrap
  platform admin is a deployment env pair — `MOS_BOOTSTRAP_PLATFORM_ADMIN_*`;
  the honest fail-closed **503** before it was configured is preserved as
  screenshot 43, the demo-login 401 as 44);
- the client "Ember & Oak Coffee" created through the console surface
  (`POST /api/agencies/:agencyId/clients` via the UI form);
- the research session declared through the console UI (topic + focus +
  2 sources `http://127.0.0.1:3098/report` and `/guide`) — `POST
  /api/agencies/:agencyId/research-sessions` **201**; the deterministic
  research pass — `POST /api/research-sessions/:id/runs` **200** —
  really fetched both pages over HTTP: **2 source(s) inspected · 20
  fact(s) retained**, every fact with its extractor
  (`research-html-extract-v1`) and content hash;
- 4 retained facts promoted into the client's evidence ledger through the
  console's confirm-gated action — `POST /api/clients/:id/evidence`
  **201** ×4 (class `source_fact`, the fact's own fields verbatim);
- the rights record, its determination transition, its destination
  permission and every gate evaluation — all through the console UI forms
  (`POST …/content-rights` 201, `POST …/transitions` 201, `POST
  …/permissions` 201, `POST …/gate` ×5);
- the agency network policy allowance and the one goal — driver-side
  through the REAL routes (disclosed above; both are the integration
  tests' own provisioning pattern);
- the asset versions (v1 direct, v2 "next version of" through the
  picker), the materialization (the operator's own 64 KB file through the
  real file input → base64 → `POST …/materialize` 200), the
  transformation request + execute — all through the console UI.

## The journey (screenshots 01–44, desktop 1280×800 + mobile 390×844)

| # | step | the API evidence composed | result |
| --- | --- | --- | --- |
| 01 | Fresh sign-up → the outcome-first home | real `POST /api/mos-signup` 201 + login 200 | ✓ |
| 02 | Client created through the console surface → the workspace tab bar carries **Content** (4th tab, shapes icon) | real `POST /api/agencies/:agencyId/clients` 201 | ✓ |
| 03 | The Content tab renders the honest empty states — all four families (Research / Content candidates / Rights gates / Assets & transformations) | GET research-sessions, candidates, hypotheses, evidence, content-rights, content-assets, transformations — all 200 (empty) | ✓ |
| 04 | The bottom disclosure block: "This surface composes the platform's existing authorities — it holds no content, rights, research or asset state of its own…" + the route-family SourceLine | — | ✓ |
| 05 | The research create gate: topic + focus + two declared sources (kind/URL/authorization) + the consequence text | — (the gate before the real POST) | ✓ |
| 06 | The session recorded: "Research session 01a0e6e5… · declaration version 1" | real `POST …/research-sessions` 201 | ✓ |
| 07 | The run-pass confirm gate: "…every outcome — extracted facts, empty pages, HTTP errors, transport refusals — is recorded honestly on the run. Nothing is invented and nothing is retried silently." | — | ✓ |
| 08 | The pass ran: the drill-down renders the declaration verbatim, both sources with "10 fact(s) retained" each, the run row "completed · 2 source(s) inspected · 20 fact(s) retained" with per-source outcome chips | real `POST …/runs` 200 + `GET …/research-sessions/:id` 200 | ✓ |
| 09 | The retained facts with FULL provenance (fact-kind chips, source refs, extractor + hash lines, extraction notes verbatim) | the composed read-back | ✓ |
| 10 | The fact-promotion CONFIRM GATE (delivered build): "Record as client evidence" + the consequence ("appends an immutable /evidence record of class source_fact carrying this fact's own fields…") | — | ✓ |
| 11 | The promoted fact in the client's Evidence tab: chip `source_fact`, quality C, `research:http://127.0.0.1:3098/report`, the fact's own content fields | real `POST …/evidence` 201 (×4 during the journey) | ✓ |
| 12 | The candidate create gate, filled (topic entity, niche, format, the evidence picker) | — | ✓ |
| 12b | **The honest server refusal, verbatim**: the candidate POST → **422** "evidenceIds: forbidden authority field; this value is derived server-side and must not be supplied" — the console renders the server's own words; see Honest note 1 | real `POST …/content-intelligence/candidates` → 422 | ✓ (honest blocked) |
| 13 | The candidates family's honest empty state after the server 422 (the record action stays available; nothing is faked) | GET …/candidates 200 (empty) | ✓ |
| 16 | The asset register gate: display name, media kind, content type, the evidence anchor (the client's real records), output spec | — | ✓ |
| 17 | The asset version registered: v1 · `ca:01a0e6f8…` · the minted ref on the card | real `POST …/content-assets` 201 | ✓ |
| 18 | Materialized with the operator's own file (the state chip + the object size) | real `POST …/:versionId/materialize` 200 | ✓ |
| 19 | **The honest production 409, verbatim**: "no registered transformation engine serves kind 'format' — the engine registry is module data (EMPTY in production by default)…" | real `POST …/transformations` → 409 | ✓ (honest blocked) |
| 20 | The asset version drill-down (version history + lifecycle events + quality observations) | real `GET …/content-assets/:versionId` 200 | ✓ |
| 21 | The rights register gate: the minted asset ref, kind `source`, the source-evidence picker, licence label CC-BY-4.0, licence evidence, the born-'unknown' consequence text | — | ✓ |
| 22 | The rights record card, born **unknown** — the honest undetermined state | real `POST …/content-rights` 201 | ✓ |
| 23 | **THE GATE, blocked**: `rights_state_unknown` ("…is UNKNOWN (undetermined) — autonomous publication fails closed; a human determination or review is required") + `policy_denied` (the fresh-agency no-policy battery) — every reason in the gate's own words + the next action | real `POST …/content-rights/gate` → blocked | ✓ |
| 24 | The determination transition gate (event kind determination → license, the reason citing the licence evidence) | — | ✓ |
| 25 | **THE GATE, review_required**: `destination_permission_unspecified` ("…carries NO row for the destination 'youtube' — the scope is unspecified, which fails closed to human review") | real gate evaluation → review_required | ✓ |
| 26 | The destination-permission gate (platform key youtube, permitted, the evidence ref) | — | ✓ |
| 27 | **THE GATE, allow**: `allowed_license_scope` + "The recorded rights and destination policy permit autonomous publication to this destination. Publishing itself is the distribution authority's move (MKT-065) — this gate only evaluated it." — the full honest arc blocked → review_required → allow | real gate evaluation → allow | ✓ |
| 28 | The rights record drill-down: the transition history, the permission rows, the event tail | real `GET …/content-rights/:id` 200 | ✓ |
| 29 | (seam phase) The transformation request gate: kind format, the v2 ingredient, `target_format` parameter, output spec — the consequence discloses the executions authority and the engine registry | — | ✓ |
| 30 | The v2 asset register gate ("next version of: Compact espresso grinder demo — source cut (currently v1)") | real `POST …/content-assets` 201 | ✓ |
| 31 | The v2 materialized card (the operator's second file; the shared FS object store — see Honest note 3) | real materialize 200 | ✓ |
| 32 | The v2 transformation request gate (filled) | real `POST …/transformations` 201 | ✓ |
| 33 | **The executed transformation's lineage drill-down — the lineage-mandatory rule made visible**: the frozen ingredient tail (#1 `ca:01a0e715…` v2, immutable, position-ordered), the output version **born derived** ("a derived version carries NO evidence anchor; the recorded transformation IS the provenance"), the **063 rights lineage links** recorded during execution (composite `ca:01a0e718…` → ingredient `ca:01a0e715…`), the requested parameters and output spec verbatim | real `POST …/transformations/:id/execute` 200 + `GET …/transformations/:id` 200 + `GET …/content-rights/lineage/:compositeAssetRef` 200 | ✓ |
| 34 | The composite rights register (asset kind composite) | real register 201 | ✓ |
| 35 | **The composite gate, blocked with the per-ingredient breakdown**: `ingredient_no_rights_record` — "ingredient 'ca:01a0e715…' … an absent rights evaluation is BLOCKED, never allowed" + the PER-INGREDIENT EVALUATIONS row (the conjunction, fail-closed) | real gate evaluation → blocked | ✓ |
| 36 | The mission workspace's CONTENT section, live after the goal mapping: the 3 real asset versions + **"Open the Content surface →"** (the UX-006 mission-context discoverability cross-link) | real `GET …/content-assets` + the mission's goal mapping | ✓ |
| 37 | The cross-link lands in the client workspace's Content tab (the second entry point, proven) | — (app-state navigation) | ✓ |
| 38 | **The Scientific trace's Research link (link 2), now composing the REAL MKT-062 surface** (UX-006): "1 research session — sources declared up front, every pass outcome recorded", registers observed + derived; the expanded session row → the declaration verbatim, the 2 sources, the honest run outcomes, the insight-claims block (honest zero), the "Open the Content surface →" cross-link | real `GET /api/agencies/:agencyId/research-sessions` + `GET /api/research-sessions/:id` | ✓ |
| 39 | Mobile 390×844: the Content tab reflowed | — | ✓ |
| 40 | Mobile 390×844: the rights card drill-down open — reflowed, usable | — | ✓ |
| 41 | Mobile 390×844: the gate outcome panel (evaluate → allow, live on mobile) | real gate evaluation | ✓ |
| 42 | The full Content surface, desktop 1280×800 (full page — the delivered build, post-fix) | — | ✓ |
| 43 | (preserved) The honest fail-closed signup **503** before the bootstrap admin was configured (the server's own words verbatim) | real 503 | ✓ |
| 44 | (preserved) The demo-login honest **401** on the fresh database | real 401 | ✓ |

## Error accounting

- Page errors: after the mid-journey fixes, **0 new entries** across every
  clean interaction (tab switches, drill-downs, gate evaluations, mobile
  reflow, reloads — the buffer count stayed at the historical 6). The six
  historical entries are `MosApiError` **unhandled-rejection logs from the
  intentionally-exercised server refusals** (the candidate/hypothesis 422
  defect, the production engine-registry 409, the object-store 409) —
  captured BEFORE the unguarded-rejection fix; the fix (a `.catch` on
  every `void mutateAsync`) landed mid-journey and the post-fix
  verification produced zero new entries. Disclosed, not hidden.
- Console errors: **0** in the delivered build (verified on a fresh load
  after the fix). Mid-journey the browser caught a real React DOM nesting
  error (`li` nested in `li` — the record cards' wrapper structure); it
  was FIXED during the journey (the wrapper `<li>`s removed, the gates
  moved inside the cards) and the post-fix fresh load shows a clean
  console. The only remaining console entries are React dev/HMR noise
  (devtools banner, Fast Refresh) — expected in `next dev`.
- Horizontal overflow: **0px** at 1280×800 (Content tab, drill-downs
  open, the gate panel, full page) AND at 390×844 (the reflowed tab, a
  card drill-down open, the gate panel) — the probe measured
  `scrollWidth − clientWidth` at every phase.
- Viewport verified programmatically (`window.innerWidth × innerHeight`):
  1280×800 for the desktop phases, 390×844 for the mobile phase.

## Honest notes (sandbox limitations + judgment calls, disclosed)

1. **The content-intelligence creation routes are UNSATISFIABLE (a
   backend defect, frozen territory — disclosed for the Tech Lead to
   route)**: `POST /api/clients/:id/content-intelligence/candidates` and
   `…/hypotheses` declare `evidenceIds`/`metricObservationIds` (and
   `candidateIds`/`researchInsightIds`) as BOTH forbidden authority
   fields (`CANDIDATE_AUTHORITY_FIELDS` / `HYPOTHESIS_AUTHORITY_FIELDS`)
   AND required spec fields (`arrayField` is `required: true`). Empirical
   proof, in-sandbox: WITHOUT the fields → 422 "evidenceIds: required" /
   "metricObservationIds: required"; WITH them → 422 "…forbidden
   authority field; this value is derived server-side and must not be
   supplied". The integration tests never POST a valid candidate over
   HTTP (they create candidates through the module API directly), so the
   route defect was never caught. The console surface submits the REAL
   route and renders the server's 422 words verbatim (screenshots
   12/12b/13) — never a fake success. The candidate CARD composition
   (the evidence/hypothesis separation, the per-candidate rights join
   with its four honest cases) is implemented and typechecked but could
   not be exercised against the live backend for this reason. Suggested
   fix for the owning worker: drop the link fields from the forbidden
   lists (they are request inputs on these routes, not server-derived)
   — a one-line DTO correction in `src/api/content-intelligence-routes.ts`
   (NOT this worker's territory: `src/api/**` is frozen).
2. **The production engine registry is empty by design**: the standalone
   deployment registers no transformation engines (the fail-closed 409,
   screenshot 19, the server's own explanatory words). The full
   transformation + lineage flow ran against the SEAM composition with
   the repo's own public engine doubles (the integration-test posture) —
   screenshots 29–33. The engines' own source discloses the simulation
   ("NOT a real transcoder — disclosed").
3. **The object store is memory-kind in dev by default**: the v1 asset's
   bytes lived in the :3010 process's memory, so the seam process's
   execute honestly refused ("object … absent from the object store —
   fail-closed"). The station was re-booted with a shared FS object store
   (`MOS_OBJECT_STORE=fs`) and a v2 asset materialized into it before the
   seam-phase transformation — the refusal itself was an honest
   fail-closed outcome, kept in the log.
4. **Driver-side provisioning through real routes** (disclosed in the
   stack table): the agency network policy allowance (the gate's
   `policy_denied` reason in screenshot 23 was REAL until the allowance
   landed — the fresh-agency no-policy battery, exactly as the
   integration tests stage it) and one client goal (no SPA creation path
   exists — the surface itself says so).
5. **Mid-journey console fixes (all included in this delivery)**: (a) the
   fact-promotion confirm gate was missing and was added (screenshot 10
   shows the delivered gate); (b) the dev bridge double-encoded
   percent-escaped path segments (Next 16 preserves the escapes in
   `nextUrl.pathname`; the `ca:` asset refs arrived at the upstream as
   `%253A` — the lineage read 404'd) — fixed in
   `console/src/app/api/mos/[...path]/route.ts` (decode-once, encode-once
   normalization); (c) the record-card wrapper `<li>`s nested `li` in
   `li` (a real React DOM console error, caught by this journey) — the
   wrappers were removed and the gates moved inside the cards; (d) every
   `void mutateAsync` now carries a `.catch` (the unhandled-rejection
   page-error entries). The post-fix state was re-verified: console clean,
   page errors stable, all gates re-run green.
6. **The web source is a loopback double**: the research pass REALLY
   fetched `http://127.0.0.1:3098/report` and `/guide` over HTTP through
   the platform's real `ResearchHttpPageReader` (the run's source
   outcomes, the fetched-at times, the extractor + content hashes are the
   platform's own records); only the pages themselves are the station's
   doubles (disclosed per the work order's live-provider rule).
