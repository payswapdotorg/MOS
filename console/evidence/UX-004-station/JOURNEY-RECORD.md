# UX-004 — Scientific Trace: STATION re-verification journey record

Recorded at the integration station (Tech Lead) on 2026-09-22 over the merged
tree `harvest/ux-004` (main `d5f3124` + the console-only UX-004 delta
`ux/004-worker-delivery` @ `6f24044`) — agent-browser over Chromium,
console dev server on :3011 bridged to the real MOS platform API on :3010,
**embedded PostgreSQL 18** (the repo's own integration-test harness binaries,
fresh database `ux004station`, 51 migrations at boot, latest
`057_content_intelligence.sql` — the MKT-062/059 merged state).

The station re-verification follows the UX-003 station precedent: the worker's
own journey evidence (in `console/evidence/UX-004/`) verified the delivery
branch in-sandbox; this record verifies the MERGED tree on the station's own
real stack.

## The stack (all real, at the station)

| layer | what ran |
| --- | --- |
| PostgreSQL 18 | embedded server (the repo's `tests/integration/helpers/pg.ts`), ephemeral port, fresh database `ux004station` |
| MOS platform API | `node src/entrypoints/api.ts` on 127.0.0.1:3010, `MOS_DATABASE_URL` → the embedded PG, bootstrap platform admin armed (station-boot-ux004.ts, detached) |
| console | `next dev -p 3011`, dev-proxy bridge `/api/mos/*` → 127.0.0.1:3010, bootstrap-admin env for the `/api/mos-signup` orchestrator |
| in-process seam | the repo's OWN integration-test seams (`bootstrapApplication` with `createLocalOAuthFlow` + `createReferenceSocialAdapter` + `createReferenceIntegrationStub`) — used ONLY where the standalone deployment cannot produce the datum: the connected social account and the fan-out dispatch (the standalone API registers no OAuth flows/platform adapters). The worker's exact disclosed pattern. |

## Fixtures — through the platform's OWN real routes, with the owner's session token

Fresh sign-up through the real `POST /api/mos-signup`
(`verify@ux004station.test`, agency "UX004 Station Verify Co") → client
"Verdant Bloom Tea" created through the real console surface (POST
`/api/agencies/:agencyId/clients` via the UI form) → then, with the owner's
token harvested from a real login through the bridge: the goal + mission + the
goal-mapping (the Question link's live composition); 3 evidence records
including an explicit supersede (the lineage chain); 80 metric observations
(40 per arm inside the analysis window, `engagement_rate_ac1`); the experiment
(declared hypothesis + design) walked through its frozen lifecycle to
`concluded` (mark_ready → start → begin_analysis → conclude, result
`causal_supported`); the MKT-067 analysis (server-computed outcome
**`effect_positive`** — treatment mean 3.097 / comparison mean 1.049 / effect
2.049 ± 0.0147 / samples 40/40) + the allocation recommendation; the decision
(accepted + observed outcome recorded); the learnings with an explicit
supersedes relationship; network + secrets dimension policy allowances;
content asset (register → materialize) + rights determined `owned` (the seam
process — same database); the connected social account + the MKT-065
distribution plan (two destination variants) + the fan-out dispatch (both
publications `published` with provider refs, through the seam); two
measurement references through the real
`POST …/cross-platform-distribution/plans/:planId/measurements` route.

Fixture disclosure (station-side, honest): the FIRST supersedes relationship
was posted direction-inverted by the station fixture script
(`POST /api/learnings/:A/relationships {kind:'supersedes', toLearningId:B}`
means A is superseded BY B — the station initially read it as A supersedes B).
The corrected relationship was appended; because learning history is
append-only and a superseded learning is TERMINAL, the inverted pair remains
as two historical records, and a fresh successor learning carries the active
conclusion (3 learnings total: 1 active + 2 superseded-kept-as-history). The
trace rendered every state truthfully throughout — the error was in the
fixture, never in the surface.

## The journeys (screenshots 01–18, desktop 1280x800 + mobile 390x844)

1. **Fresh sign-up** through the real `POST /api/mos-signup` → the
   outcome-first home renders (six outcomes + Continue a mission) — 01.
2. **Client created through the real console surface** ("Verdant Bloom Tea")
   → the client workspace opens with the tab bar carrying **"Scientific
   trace"** (second position, Microscope icon) — 02.
3. **The Scientific trace tab** renders: the intro, the collapsible
   three-register legend (default open, plain-language explanations), the
   numbered ten-link chain top-to-bottom with chain connectors, and the
   sources footer ("this trace composes the platform's existing authorities —
   it holds no data of its own") — 03.
4. **Question (link 1)**: the truthful coming state (research module in
   flight, dependency disclosed plainly) + the observable now — the agency
   mission row expands to the objective VERBATIM ("Grow Verdant Bloom Tea
   new-account activation through a tested onboarding sequence"), the goal
   mapping with the "this client" chip, and the real "Open the mission
   workspace" action — 04.
5. **Research (link 2)**: the truthful coming state; the chain continues from
   the evidence that IS recorded.
6. **Evidence (link 3, OBSERVED)**: 3 records; the supersede chain renders as
   lineage — the correction carries "replaces …" and the superseded record
   carries "superseded by … — kept in full as history, never deleted";
   provenance (source / quality / recordedBy / recordedVia / correlation /
   recordedAt) visible on every record — 05.
7. **Hypothesis (link 4, DERIVED)**: the hypothesis VERBATIM in the dashed
   amber frame marked "Hypothesis — declared, unproven"; the cross-link "Open
   the experiment that tests it →" was CLICKED live: the Experiment section
   expanded and the page scrolled to it — 06/07.
8. **Experiment (link 5, DECLARED)**: the declared design vocabulary
   (designType randomized, populationUnit, assignment, primaryMetric
   engagement_rate_ac1, guardrails, analysisMethod two_sample_means_v1 +
   version, uncertaintyRepresentation interval, resultState causal_supported,
   concludedAt); "Open its analysis →" was CLICKED live: the Analysis section
   expanded and scrolled — 07/08.
9. **Publication (link 6, OBSERVED)**: the plan row (state `dispatched`)
   expands to the declared plan (sourceAssetRef, transformation, mission
   anchor, inputDigest), the two destinations **both `published`** with their
   publication ledger records (provider publish refs + provider content refs
   + idempotency keys + recorded provenance); the read-surface disclosure (no
   dispatch controls; the platform API owns dispatch; none faked) — 09/10.
10. **Measurement (link 7, OBSERVED)**: 80 metric observations with source +
    quality + provenance on each + the plan's two measurement references
    (loaded from the plan's lineage tail on expand; the `metrics:engagement:`
    and `metrics:reach:` keyed references render as "Observed fact —
    measurement reference" with lineage positions) — 11/12.
11. **Analysis (link 8, DERIVED)**: the MKT-067 analysis — outcome chip
    **effect positive**, treatment/comparison means, effect ± SE, samples
    40/40, the method/version/window disclosure, the uncertainty interval,
    and the allocation recommendation ("recommended next allocation: shift
    toward treatment") — 08.
12. **Decision (link 9, INTERPRETATION)**: the thick-left graphite frame;
    "Show the full basis (single-decision read)" fetches
    `GET /api/decisions/:decisionId` live and renders the basis (proposer,
    evidence refs, expected impact, alternatives, expected cost) + the
    observed outcome (summary/asExpected/notes) + the real "Open the decision
    ledger →" link — 13.
13. **Learning (link 10, INTERPRETATION)**: 1 active learning with its basis
    (evidence/experiment relatives, applicability) + 2 superseded learnings
    visibly historical ("superseded by … — kept in full as history, never
    deleted"); the relationship chain loads on expand — 14/15.
14. **Mobile (390x844)**: the same live session resized; the trace reflows
    (wrapped tab bar, stacked sections); the full chain open; the
    scroll-position overflow probe reports **0px at every position** (7
    positions across 4697px of scroll height); screenshots captured —
    16/17.
15. **Full-open desktop chain** (1280x800, full-page) — 18.

## Error accounting

- Page errors: **0** at both viewports, all journeys (`agent-browser errors`
  empty).
- Horizontal overflow: **0px** at 1280x800 and at 390x844 (probed
  programmatically at every 700px scroll position through the fully-open
  chain).
- Console: one dev-mode React hydration ATTRIBUTE warning (the generic
  date-formatting-in-user-locale class on the SSR'd timestamps — the dates
  re-render client-side; warning-level, zero functional impact, disclosed).
  Compile noise otherwise.
- Viewport verified programmatically: 1280x800 and 390x844.

## Honest notes (station)

1. **The dispatch route defect (the worker's backend finding on main, carried
   verbatim — NOT fixed in this console-only merge)**: `POST
   /api/clients/:clientId/cross-platform-distribution/plans/:planId/dispatch`
   returns 422 "audit event rejected by the append guard" because the route's
   audit emit passes an ARRAY (outcomes) in the audit details; the module's
   dispatch commits durably BEFORE the audit emit. The station's dispatch went
   through the module API (the repo's own seam), exactly as the worker's did;
   the HTTP-route defect remains a one-line backend follow-up for the Tech
   Lead (serialize outcomes to a string in the route's audit emit).
2. **The connected social account + the dispatch were produced through the
   repo's own integration-test seams** (the worker's exact disclosed pattern);
   the plan, the measurement references, and every console read went through
   the real HTTP routes.
3. **MKT-062 research surfaces do not exist on this main yet as an HTTP
   surface** (the modules merged backend-only; the Question/Research links
   render the truthful coming state — verified live).
