# E2E-RESULTS — VER-001 live verification record

**Recorded:** 2026-09-18 (UTC) · **Harness:** `tests/e2e/` on branch `ver/001-worker-delivery`
**Targets (both live, zero mocks — every step is a real HTTP call through the console's same-origin `/api/mos/*` bridge or a real agent-browser UI drive):**

| Target | URL | Evidence run id |
| --- | --- | --- |
| Production console | `https://mos-product.vercel.app` | `prod-2026-09-18-r2` |
| Repository-built preview | `https://mos-product-jj1kfiiih-ekonplacidegmailcoms-projects.vercel.app` | `preview-2026-09-18-r1` |

Both deployments report `{"status":"ok","env":"prod"}` from `/api/mos/platform/health` — the preview
serves the same production database, so demo-data assertions are expected to be identical across
targets (and are).

## Run matrix

| Journey | Production | Preview | Steps (prod / preview) |
| --- | --- | --- | --- |
| `signup` | **PASS** | **PASS** | 14/14 · 14/14 |
| `owner` (+ operator variant) | **PASS** | **PASS** | 28/28 · 28/28 |
| `client` | **FAIL** (product finding F-1) | **FAIL** (same finding) | 12/13 · 12/13 |
| `human-agent` | **PASS** | **PASS** | 11/11 · 11/11 |
| `app-lifecycle` | **PASS** | **PASS** | 13/13 · 13/13 |
| `tenant-isolation` | **PASS** | **PASS** | 23/23 · 23/23 |
| `responsive` | **FAIL** (product finding F-2) | **FAIL** (same finding) | 13/15 · 13/15 |

Per-step `[PASS]/[FAIL]` lines, API response snippets (redacted) and screenshots live under
`tests/e2e/evidence/<run-id>/<journey>/`; `run-summary.json` in each run directory is the machine
readable record. Exit code per journey invocation: 0 only on PASS.

**5 of 7 journeys PASS on both targets.** Both FAILs are honest PRODUCT findings reproduced
identically on both deployments (below) — not harness artifacts: every failing assertion was
manually reproduced and root-caused against the deployed console.

## Product findings (for the Tech Lead; console fixes are Worker A scope)

### F-1 — Client workspace Evidence tab renders observation content as raw JSON

- Assertion: `UI: Evidence tab renders formatted real data (no raw JSON, no error boundary)`
  (handoff §8 checklist: "Evidence/Decisions/Learning/Memory tabs render formatted real data (no
  raw JSON)").
- Observed: `preBlocks=3` — `document.querySelectorAll("main pre").length === 3` on the Helio
  Robotics Evidence tab, both targets. Root cause:
  `console/src/components/mos/client-workspace.tsx` renders each evidence record's content payload
  as `JSON.stringify(record.content, null, 2)` inside a `<pre>` block. Metadata (source, observedAt,
  quality badges) IS formatted; the content payload is a raw JSON dump.
- The neighbouring tabs pass the same bar: Decisions `preBlocks=0`, Learning `preBlocks=0`, Memory
  `preBlocks=0` — all render formatted real data (soft-checked individually; see harness audit).
- Evidence: `evidence/prod-2026-09-18-r2/client/06-workspace-tab-evidence.png` (+ preview twin).

### F-2 — Mobile (390×844) horizontal overflow on login AND command center

- Tolerance (README): a "overflow catastrophe" is document scroll width exceeding the viewport by
  more than 32px. Measured:
  - mobile login: **overflow=117px** (scrollWidth 507 / viewport 390) — both targets;
  - mobile command center (signed in): **overflow=191px** (scrollWidth 581 / viewport 390) — both
    targets;
  - desktop 1280×800: overflow=0px on both screens (PASS).
- Login-screen root cause (diagnosed live): the four Demo quick-login buttons measure 474px wide —
  the shadcn `Button` base class carries `whitespace-nowrap`, which defeats the intended
  `truncate` on the inner spans, so the grid column overflows the `max-w-md` card
  (`console/src/components/mos/login-screen.tsx`, DEMO_LOGINS panel).
- Mobile itself otherwise WORKS: sign-in reaches the app shell, Today renders attention+goals, the
  navigation drawer opens with all 7 destinations, Clients is reachable, and both viewports log
  zero page errors.
- Evidence: `evidence/prod-2026-09-18-r2/responsive/00-mobile-390x844-login.png`,
  `01-mobile-390x844-command-center.png` (+ preview twins; measurements recorded in the step log).

## Destructive claim proof (opt-in) — Sam's single seeded offer

Run id `prod-2026-09-18-offer-claim` (`MOS_E2E_ALLOW_DEMO_OFFER_CONSUMPTION=1`, action `accept`):

- The offer was still OPEN before the claim (journeys on both targets had just verified it).
- **The real claim contract PASSED live:** `POST /api/mos/jobs/queue/offers/:offerId/accept` →
  `200` with `{job: {status: "accepted"}, offer: {status: "accepted"}, replayed: false}`
  (`evidence/prod-2026-09-18-offer-claim/human-agent/08-offer-accept-claim.json`).
- Post-accept queue state (recorded): open offers `0`; the claimed job appears in `activeJobs`
  with `job.status === "accepted"` (`09-queue-after-claim.json`).
- The journey's post-accept assertion as-run FAILED for a HARNESS reason: it read
  `activeJobs[].jobId/status` at the top level, but the queue nests the descriptor under
  `activeJobs[].job.*`. The assertion is fixed in this delivery and verified against the recorded
  evidence (open=0, claimed=true ⇒ pass); a live end-to-end re-run of the destructive section
  requires the re-seed below (single consumer — the offer is now consumed).
- **The offer is CONSUMED in the shared production database.** Restore procedure (operator, from
  `tests/e2e/README.md`): run the production seed script (`console/scripts/seed-production.ts`
  with `MOS_SEED_BASE_URL=https://mos-product.vercel.app` and the deployed demo-admin credentials)
  — it is idempotent and handles every end state (it closes out an accepted fixture honestly
  through the outcome contract and projects a fresh open offer). The harness never runs the seed
  itself.
- The `decline` variant of the claim proof was NOT exercised (one offer, one consumer); it shares
  the same claim-route contract shape proven above.

## Harness audit — defects found and fixed in this delivery

The inherited scaffold was committed unrun. The audit (every file read; every browser-command and
API shape verified live against the deployed console before running) found and fixed:

1. **Compact snapshots strip content** (`lib/browser.mjs`): the scaffold defaulted to
   `agent-browser snapshot -c`, which in agent-browser 0.38.x omits StaticText content — every
   content assertion on paragraph/card text (offer titles, client names, marketplace labels,
   ledger rows) could never pass. Default is now the FULL tree.
2. **Phantom `tablist "Overview…"` assertion** (`journeys/owner-journey.mjs`): the deployed
   build's tablist is unnamed in the a11y tree; the scaffold's "verified live" comment no longer
   held for this CLI version. The workspace-open check now asserts the stable `tab "Overview"`
   tab role + client name.
3. **Transport-proof surface choice** (`journeys/owner-journey.mjs`): the proof navigated
   Clients → Profit Intelligence, but Today mounts `useProfitAgency` (plus command-center and
   attention queries), so Profit served the react-query cache and only 1 fresh `/api/` request
   was recorded (assertion needs ≥2). Now navigates Clients → Apps — surfaces Today never
   mounts — recording 3 fresh requests, all Bearer-only.
4. **View-transition race** (`lib/ui.mjs` + owner/client/human-agent journeys): a single
   `networkidle` wait can snapshot the pre-navigation DOM. Added bounded `waitForSnapshot`
   polling (≤12×1s) with the final tree recorded as evidence on exhaustion.
5. **Journey status ignored soft-failed steps** (`lib/journey.mjs`): `outcome()` derived status
   only from a thrown error; a recorded-but-failed step would have counted as PASS. Status is now
   FAIL whenever any step failed; added `checkSoft` for independent per-item sweeps (workspace
   tabs, intelligence tabs, overflow measurements) so one failure cannot hide the remaining
   items' results.
6. **Lint gate failed** (repo `eslint .`): unused `E2E_ROOT` + `fileURLToPath` import in
   `run.mjs`, unused `name` param in `journey.mjs`, and `fetch`/`AbortSignal` flagged `no-undef`
   in `http.mjs` (repo eslint config declares only `process`/`console` globals for `.mjs`).
   All fixed (scoped waivers commented in place); `bun run lint` now exits 0.
7. **Cross-process chunked runs** (`run.mjs`, `lib/throwaway.mjs`, `journeys/human-agent-journey.mjs`):
   `run-summary.json` was overwritten per invocation and the throwaway client/probe logic assumed
   one long-lived process. The summary now merges per-journey entries under a shared run id;
   `ensureThrowawayClient` discovers the tenant's existing client instead of creating a second
   one; the non-agent claim probe runs for env-provided throwaways too. Chunked and single-process
   runs are now equivalent (README documents the chunked protocol).
8. **Post-accept queue shape** (`journeys/human-agent-journey.mjs`): see the claim proof above —
   activeJobs entries are `{job, obligations, visits}`.

The first full-battery attempt (before fixes 1–4) failed 4 UI steps and was reaped mid-run by the
sandbox (documented deviation below); its evidence directory was discarded and superseded by the
complete re-runs recorded here.

## Honest deviations and disclosures

- **Chunked execution.** This sandbox reaps detached processes after ~60–90s, so each battery ran
  as seven foreground per-journey invocations sharing one run id and one throwaway (the README's
  documented chunked mode; equivalent by design after audit fix 7). One signup per target.
- **Screenshots show the throwaway email.** The account menu renders the signed-in email, so
  pixels of throwaway sessions contain the email address. The matching passwords exist only in
  the operator's final report — never in any repository file (verified by sweep: no
  `@ver-e2e.example`, no password patterns, no demo passwords, no tokens under `tests/e2e/`).
- **Superseded partial evidence removed.** The inherited `evidence/prod-2026-09-18/` directory was
  an interrupted session's fragment (signup+owner only, no run summary, no results record); it was
  removed and superseded by the complete runs above.
- **Throwaway tenants remain in the production database** (3 in total: the interrupted session's,
  the production run's, the preview run's — plus their clients/workspaces/one app-install ledger
  each). They are isolated `.example`-domain verification tenants, created through the real
  contracts; deleting them is a routine cleanup for the operator if desired.
- **Rate limit headroom used:** 3 valid signups + 1 duplicate-email probe across the session
  (deployed route limit: 5 / 10 min / instance / IP) — no 429 was hit.

## Known limits — verified as documented

- **Vercel Hobby 60s function cap:** every harness request stayed well under it (slowest observed
  bridge call ≈ tens of seconds on cold start; all journeys completed; no function timeout
  surfaced). Long-running platform work (queue drain) is NOT exercised by the harness — by design.
- **On-demand worker drain:** queue items settle only after a drain. Consistent with this: Sam's
  freshly accepted job shows up in `activeJobs` with outcome obligations (outcome due), and the
  accepted fixture is closed out by the seed's outcome contract on re-seed. The harness uses only
  synchronous command routes.
- **Single-consumer open offer:** consumed by the opt-in claim proof (above); restoration is the
  documented idempotent seed procedure.

## Gate battery (on the delivery tree, merged with origin/main @ 56cf3cd)

| Gate | Result |
| --- | --- |
| `bun run lint` (repo `eslint .`) | 0 errors |
| `bun run typecheck` (`tsc --noEmit`) | 0 errors |
| `bun run arch:check` | 0 violations — 470 files, 37 frozen modules |
| `node --test --test-concurrency=1 tests/unit/**` | 964/964 pass |
| `node --test --test-concurrency=1 tests/architecture/**` | 548/548 pass |
| `node --test --test-concurrency=1 tests/integration/**` | 931/931 pass (~410s; MinIO provisioned via the GitHub-release fallback) |

`tests/e2e/` is covered by the lint gate (`.mjs` files, repo-wide `eslint .`); the node test
suites' globs do not execute anything under `tests/e2e/`.

## How to re-run

See `tests/e2e/README.md` (single-process and chunked modes, environment contract, evidence
redaction rules, operator procedures).

---

# Re-run 2026-09-19 (console/e2e-fixes, local target)

**Recorded:** 2026-09-19 (UTC) · **Branch:** `console/e2e-fixes` (base `1bf699b`; code fix commit
`eab3cce` — every commit after it only appends/refreshes this record and the run evidence, no
source changes)
· **Scope:** the two product findings F-1 and F-2 only — both affected journeys re-run against
the FIXED console after the fixes landed (the other five journeys are untouched by the diff and
are not re-run here; their 2026-09-18 production/preview PASS records stand).

## Target

Locally served, repository-derived target (no Vercel deployment — post-merge redeployment is the
Tech Lead's step, no Vercel credentials in this sandbox):

- MOS API: this repository's own `src/entrypoints/api.ts` (Node 24) on `127.0.0.1:3010`, against
  a real embedded PostgreSQL 18 (the integration-test harness binaries, `MOS_DATABASE_URL`), env
  `dev`, object store `fs`, bootstrap platform admin `admin@mos.demo`.
- Console: `console/` served by `next dev` in proxy mode (`MOS_UPSTREAM_ORIGIN=http://127.0.0.1:3010`,
  no `MOS_DATABASE_URL` ⇒ same-origin `/api/mos/*` bridge proxies to the local API) — with two
  sandbox deviations, disclosed: **port 3100 instead of 3000** (the sandbox's unrelated default
  dev server occupies 3000; `MOS_E2E_BASE_URL=http://127.0.0.1:3100` selects the target per the
  harness contract) and **`--webpack`** (Next 16.1.3 turbopack dev fails to externalize the
  `pg` trace pin — `Cannot find package 'pg-…'` from the turbopack runtime; production `next
  build` is unaffected and the repo is not modified for this).
- Demo data: `console/scripts/seed-production.ts` run against the local target through the bridge
  (the documented real-API-only seed, idempotent; first run 35 creations + 30 reused after the
  queue was settled by `src/entrypoints/worker.ts` — the local stand-in for the production
  drain-kick, since the console drain route requires the built in-process bundle).

## Baseline reproduction (before the fixes, same local target)

Both findings reproduced exactly as recorded on 2026-09-18 against production/preview:

- F-1: Helio Robotics Evidence tab `document.querySelectorAll("main pre").length === 3`
  (evidence: `evidence/baseline-local-2026-09-19/diagnosis/01-evidence-tab-baseline.png`).
- F-2 mobile login: overflow=117px (scrollWidth 507 / viewport 390); the four Demo quick-login
  buttons measured 474px wide, inner spans 440px (never truncated).
- F-2 mobile command center: overflow=191px (scrollWidth 581 / viewport 390). Root cause
  diagnosed live at 390×844 (per-element widths): the Risks card renders
  `view.risks.basis` = `declared_goal_risk_constraints_and_operational_and_evidence_quality_signals`
  — a 75-char snake_case server vocabulary token with no CSS break opportunities — in a
  `font-mono` span measuring **540px**, which the implicit auto track of the `lg:grid-cols-2`
  grid sized the whole card to (evidence:
  `evidence/baseline-local-2026-09-19/diagnosis/00-mobile-command-center-baseline.png`).

## Fixes under test (console/ presentation tree only)

- F-1 (`console/src/components/mos/client-workspace.tsx`): the Evidence tab's
  `JSON.stringify(record.content, null, 2)` `<pre>` dump replaced by a typed per-shape renderer —
  metric observation figure for `{metric, value, unit?}`, statement prose for claim shapes, and
  the `AssumptionDisclosure` labeled key/value list (the same formatted style the neighbouring
  tabs pass with) as the graceful fallback for unknown/future shapes.
- F-2 (`console/src/components/mos/login-screen.tsx`): the Demo quick-login grid gets
  `grid-cols-1` (`repeat(1, minmax(0, 1fr))`) so the track can shrink below the buttons'
  `whitespace-nowrap` max-content and the intended `min-w-0` + `truncate` spans actually truncate.
- F-2 (`console/src/components/mos/command-center.tsx`): `break-all` on the two server-vocabulary
  token spans (`risks.basis`, `evidenceQuality.window`) and `grid-cols-1` minmax(0, 1fr) tracks
  on every below-breakpoint grid on the screen.

## Run matrix

| Journey | Result | Steps | Key assertions |
| --- | --- | --- | --- |
| `client` | **PASS** | 13/13 | Evidence tab `preBlocks=0` (panelChars=3068, no error boundary); Decisions/Learning/Memory `preBlocks=0` unchanged; decision detail rationale+provenance; zero page errors |
| `responsive` | **PASS** | 15/15 | mobile 390×844 login overflow=**0px** (was 117px); mobile command center overflow=**0px** (was 191px); desktop 1280×800 overflow=0px on both screens (unchanged); drawer with all 7 destinations; Clients reachable; zero page errors |

Commands (repository root):

```bash
MOS_E2E_RUN_ID=local-2026-09-19-fixes MOS_E2E_BASE_URL=http://127.0.0.1:3100 \
  MOS_E2E_OWNER_EMAIL=casey@northwind.demo MOS_E2E_OWNER_PASSWORD=<per SEEDING.md> \
  node tests/e2e/run.mjs --journey=client      # exit 0
MOS_E2E_RUN_ID=local-2026-09-19-fixes MOS_E2E_BASE_URL=http://127.0.0.1:3100 \
  MOS_E2E_OWNER_EMAIL=casey@northwind.demo MOS_E2E_OWNER_PASSWORD=<per SEEDING.md> \
  node tests/e2e/run.mjs --journey=responsive  # exit 0
```

Console gates on the delivery tree: `cd console && bun run lint` → 0 errors; `bun run typecheck`
→ 0 errors. Repo `eslint .` → 0 errors (harness untouched).

## Evidence

- Run artifacts: `evidence/local-2026-09-19-fixes/` — `run-summary.json` (machine record),
  `client/06-workspace-tab-evidence.png` (the formatted Evidence tab),
  `responsive/00-mobile-390x844-login.png`, `responsive/01-mobile-390x844-command-center.png`
  (both overflow-free), `responsive/00-desktop-1280x800-login.png`,
  `responsive/01-desktop-1280x800-command-center.png`, drawer/clients navigation shots, API
  captures (redacted; demo persona only — no throwaway tenant was created by this run).
- Baseline (pre-fix) diagnosis shots: `evidence/baseline-local-2026-09-19/diagnosis/`.

## Honest deviations and disclosures

- **Local target, not production/preview.** No Vercel credentials exist in this sandbox
  (deployment is the Tech Lead's post-merge step). The local target is fully
  repository-derived (repo API + repo console + repo seed); the two failing assertions were
  reproduced against it before the fix and verified after, on the exact harness journeys.
- **Port 3100 + `--webpack`** (see Target above) — the only functional deviations from the
  documented serve recipe; both are sandbox-environment workarounds, neither modifies the repo.
- **The other five journeys were not re-run** — the diff touches only the three console
  components behind F-1/F-2; the 2026-09-18 production PASS records for signup/owner/
  human-agent/app-lifecycle/tenant-isolation remain the standing evidence. The Tech Lead's
  independent re-run (station clone, production shape) is the acceptance bar.
- **Sandbox process reaping** (as disclosed on 2026-09-18): long-lived processes are reaped
  when their spawning shell exits; the local API/console/worker were kept alive via immediate
  orphaning to the container init (double-fork). No effect on the harness itself (per-journey
  foreground invocations, as before).

---

# Re-run 2026-09-19 22:55 UTC (console/e2e-fixes resume re-verification, local target)

**Recorded:** 2026-09-19 22:55–22:56 UTC · **Branch:** `console/e2e-fixes` (head `9c01f99` at run
time — the resumed worker session re-verified the pushed fixes before completing the delivery;
no source changed for this record) · **Scope:** independent re-run of the exact combined
invocation `--journey=client,responsive` against a fresh locally served target, confirming the
2026-09-19 fixes hold on a clean environment rebuild.

## Target

Same local target shape as the 2026-09-19 record, rebuilt from scratch in the resume session:
repository API (`src/entrypoints/api.ts`, Node 24) on `127.0.0.1:3010` over a fresh embedded
PostgreSQL 18 instance (integration-harness binaries, fresh `mos` database), `MOS_ENV=dev`,
object store `fs`, bootstrap admin `admin@mos.demo`, continuous `src/entrypoints/worker.ts`
running so queued executions settle (the console drain route still requires the built
in-process bundle — the worker is the local stand-in, as disclosed above); console on
`http://127.0.0.1:3100` in proxy mode (`MOS_UPSTREAM_ORIGIN=http://127.0.0.1:3010`,
`--webpack`, port 3100 — same two sandbox deviations as the earlier 2026-09-19 run).
Demo data: one uninterrupted `console/scripts/seed-production.ts` pass through the bridge
(70 creations, 0 reused — the seed requires `MOS_INTERNAL_API_TOKEN` to be set on BOTH the API
and the seed invocation for the first-party app publishes; a first attempt without it failed at
the publish step and the database was reset for the clean single pass recorded here).

## Run matrix

| Journey | Result | Steps | Key assertions |
| --- | --- | --- | --- |
| `client` | **PASS** | 13/13 | Evidence tab `preBlocks=0` (panelChars=3068, no error boundary); Decisions/Learning/Memory `preBlocks=0`; decision detail rationale+provenance; decision room read model; zero page errors |
| `responsive` | **PASS** | 15/15 | mobile 390×844 login overflow=**0px** (scrollWidth 390 / viewport 390); mobile command center overflow=**0px** (scrollWidth 390 / viewport 390); desktop 1280×800 overflow=0px on both screens; drawer with all 7 destinations; Clients reachable; zero page errors |

Command (repository root, single combined invocation):

```bash
MOS_E2E_RUN_ID=local-2026-09-19-fixes-r2 MOS_E2E_BASE_URL=http://127.0.0.1:3100 \
  MOS_E2E_OWNER_EMAIL=casey@northwind.demo MOS_E2E_OWNER_PASSWORD=<per SEEDING.md> \
  node tests/e2e/run.mjs --journey=client,responsive   # exit 0, ALL PASS
```

Console gates re-run in the same session: `cd console && bun run lint` → 0 errors;
`bun run typecheck` → 0 errors. Repo `eslint .` → 0 errors.

## Evidence

- Run artifacts: `evidence/local-2026-09-19-fixes-r2/` — `run-summary.json` (machine record),
  `client/06-workspace-tab-evidence.png` (formatted Evidence tab — an independent vision-model
  inspection of this screenshot confirmed formatted UI rendering: metric figures with units,
  no monospaced JSON block anywhere), `responsive/00-mobile-390x844-login.png` and
  `responsive/01-mobile-390x844-command-center.png` (both overflow-free — the same vision-model
  inspection confirmed no clipped content at the right edge and clean ellipsis truncation on the
  demo login buttons), desktop 1280×800 twins, drawer/clients navigation shots, API captures
  (redacted; demo persona only — no throwaway tenant was created by this run; secret sweep over
  the evidence directory found no credentials).
- The 2026-09-18 sections and the earlier 2026-09-19 record above are unchanged (append-only).
