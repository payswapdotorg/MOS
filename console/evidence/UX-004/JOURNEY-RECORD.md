# UX-004 — Scientific Trace: browser journey evidence

Recorded in-sandbox by the UX-004 worker (agent-browser over Chromium)
against the delivery branch `ux/004-worker-delivery`, console dev server on
:3011 bridged to the real MOS platform API on :3010 — **embedded PostgreSQL
18** (the repo's own integration-test harness binaries, fresh database),
migrations applied at boot (49, latest `055_cross_platform_distribution.sql`),
real sign-up — no seeded demo data, no DB writes outside the platform's own
contracts.

## The stack (all real, in-sandbox)

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | embedded server (`@embedded-postgres/linux-x64`, the repo's `tests/integration/helpers/pg.ts`), ephemeral port, fresh database `ux004_journey` |
| MOS platform API | `node src/entrypoints/api.ts` on 127.0.0.1:3010, `MOS_DATABASE_URL` → the embedded PG, bootstrap platform admin armed |
| console | `next dev -p 3011`, dev-proxy bridge `/api/mos/*` → 127.0.0.1:3010, bootstrap-admin env for the `/api/mos-signup` orchestrator |
| in-process seam | the repo's OWN integration-test seams (`bootstrapApplication` with `createLocalOAuthFlow` + `createReferenceSocialAdapter` + `createReferenceIntegrationStub` from `tests/integration/helpers/`) — used ONLY where the standalone sandbox deployment cannot produce the datum: the connected social account (a provider OAuth round needs a flow implementation; the standalone API registers none) and the fan-out dispatch (the reference adapter registry lives only in the seam process). Both are disclosed in §Honest notes below. |

## Fixtures — through the platform's OWN real routes, with the owner's session token

Everything below went over real HTTP against the API (the owner's Bearer
token harvested from the browser session; never DB seeding, never fabricated
client-side): goal `01a0c7a1-4ea0…`; mission + goal-mapping (the Question
link's live composition); 3 evidence records **including an explicit
supersede correction** (the lineage chain); 80 metric observations (40 per
arm inside the analysis window); the experiment (declared hypothesis +
design) walked through its frozen lifecycle to `concluded`
(mark_ready → start → begin_analysis → conclude, result
`causal_supported`); the MKT-067 analysis (server-computed outcome
**`effect_positive`**) + allocation recommendation; a decision (disposition
`accept` + observed outcome); two learnings + an explicit `supersedes`
relationship (the superseded one stays visible as history); network + secrets
dimension policy allowances; a content asset (register → materialize) + a
rights record determined `owned`; the MKT-065 distribution plan (two
destination variants) + two measurement references through the real
`POST …/measurements` route.

## The journeys

1. **Fresh sign-up** through the real `POST /api/mos-signup`
   (`ama@ux004.test`, agency "UX004 Trace Verification Co") → the
   outcome-first home renders (six outcomes + Continue a mission).
2. **Client created through the real console surface**: Clients → "Create
   your first client" → "Verdant Bloom Tea" → real
   `POST /api/agencies/:agencyId/clients` → the client workspace opens.
3. **The Scientific trace tab** (second tab, microscope icon) renders: the
   intro, the collapsible three-register legend (default open), and the
   ten-link chain top-to-bottom with chain connectors.
4. **Question (link 1)**: the truthful coming state (MKT-062 in flight,
   dependency disclosed plainly) + the observable now — the agency mission
   row expands to the objective verbatim, the goal mapping with the "this
   client" chip, and the real "Open the mission workspace" action.
5. **Research (link 2)**: the truthful coming state; the chain continues
   from the evidence that IS recorded.
6. **Evidence (link 3, OBSERVED)**: 3 records; the supersede chain renders
   as lineage — the correction carries "replaces …" and the superseded
   record carries "superseded by … — kept in full as history, never
   deleted"; provenance + quality + confidence visible on every record.
7. **Hypothesis (link 4, DERIVED)**: the hypothesis VERBATIM in a dashed
   amber frame marked "Hypothesis — declared, unproven"; the cross-link
   "Open the experiment that tests it →" opens link 5, expands that
   experiment's row and scrolls to it (verified live).
8. **Experiment (link 5, DECLARED)**: the declared design vocabulary (design
   type, population unit, assignment, primary metric, guardrails, analysis
   method, result state, concludedAt); "Open its analysis →" opens link 8,
   expands that experiment's analysis sub-row and scrolls to it (verified
   live).
9. **Publication (link 6, OBSERVED)**: the real MKT-065 surface — the plan
   row (state `dispatched`) expands to the declared plan, the two
   destinations **both `published`** with their publication ledger records
   (provider publish refs visible, `duplicate: false`), and the append-only
   lineage tail; the read-surface disclosure (no dispatch controls; the
   platform API owns dispatch).
10. **Measurement (link 7, OBSERVED)**: 80 metric observations (source +
    quality + provenance on each) + the plan's measurement references
    (loaded from the plan's lineage tail on expand; the `evidence:`-keyed
    reference renders).
11. **Analysis (link 8, DERIVED)**: the MKT-067 analysis — outcome chip
    **effect positive**, treatment/comparison means, effect ± SE, samples
    40/40, and the method/version/window disclosure (dashed amber frame);
    the allocation recommendation with shares, floor and rationale.
12. **Decision (link 9, INTERPRETATION)**: the thick-left graphite frame;
    "Show the full basis (single-decision read)" fetches
    `GET /api/decisions/:decisionId` live and renders the basis (proposer,
    evidence refs, expected impact, alternatives, uncertainty interval) +
    the observed outcome + the real "Open the decision ledger →" link.
13. **Learning (link 10, INTERPRETATION)**: two learnings — the superseded
    one visibly historical ("superseded by … — kept in full as history,
    never deleted") and the active one with its basis; the relationship
    chain loads on expand.
14. **Mobile (390x844)**: the same live session resized; the trace reflows
    (wrapped tab bar, stacked sections); every chain link toggled; the
    scroll-position overflow probe reports **0px at every position**;
    screenshots captured.

## Error accounting

- Page errors: **0** (both viewports, all journeys — `agent-browser errors`
  empty).
- Horizontal overflow: **0px** at 1280x800 and at 390x844 — the mobile check
  probes `scrollWidth − clientWidth` at every 700px scroll position through
  the fully-open chain.
- Console errors: none (dev-mode compile noise only).
- Viewport verified programmatically: `window.innerWidth + 'x' +
  window.innerHeight` = `1280x800` at the desktop phase.

## Honest notes (sandbox limitations + a backend finding, disclosed)

1. **The dispatch route defect (a real backend finding on main, NOT fixed —
   I own console/** only)**: `POST
   /api/clients/:clientId/cross-platform-distribution/plans/:planId/dispatch`
   returns **422 "audit event rejected by the append guard"** because its
   `emit` block passes an ARRAY (`outcomes`) in the audit `details`, and the
   audit append guard requires scalar values. The module's dispatch itself
   commits durably BEFORE the audit emit, so the plan is left `dispatched`
   even though the caller sees a 422. The integration tests dispatch through
   the module API, so this HTTP-route defect is unexercised by them. The
   trace (a read surface) is unaffected. Recommended backend fix (one line):
   serialize `outcomes` to a string in the route's audit emit.
2. **The connected social account + the dispatch were produced through the
   repo's own integration-test seams** (in-process module calls with the
   local OAuth provider double + the reference social adapter): the
   standalone API entrypoint registers NO OAuth flows and NO platform
   adapters, so a real provider round is impossible in this sandbox. The
   plan, the measurement references, and EVERY console read went through
   the real HTTP routes. At the integration station (real adapters) the
   same surfaces work end-to-end.
3. **Not verifiable in-sandbox**: a real provider publication (the 056
   submit went to the disclosed reference adapter double, which answered
   `published` with provider refs); MKT-062 research surfaces (do not exist
   yet — the truthful coming state is rendered); the Facebook Pages adapter
   (MKT-059, in flight by a sibling worker).

## Screenshots (this directory)

- `01`–`03`: sign-up, home, client created (desktop 1280x800).
- `04`–`05`: the trace top (legend + Question) and the mission row expanded
  (objective verbatim + "this client" mapping + workspace link).
- `06`: Research — the truthful coming state.
- `07`: Evidence — the observed facts + the supersede lineage.
- `08`: Hypothesis — the declared, unproven claim (dashed amber).
- `09`–`10`: the cross-links (hypothesis → its experiment; experiment → its
  analysis).
- `11`: Publication — the plan detail with both destinations `published`.
- `12`: Measurement — observations + the plan measurement references.
- `13`: Decision — the interpretation frame + the full basis.
- `14`: Learning — the interpreted conclusions + superseded history.
- `15`: the full chain open (full-page).
- `16`–`17`: mobile 390x844 — the trace top and the chain open.
