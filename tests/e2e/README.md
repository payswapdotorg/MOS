# MOS E2E Verification Harness (VER-001)

Repo-owned, live-API-backed end-to-end verification for the MOS product
console. This tree is the harness contract: how to run it, what it proves, and
what it honestly does not.

- **Live only, never mocked.** Every API step is a real HTTP call against the
  selected target through the console's own same-origin bridge
  (`/api/mos/*`), and every UI step drives the real deployed console. There
  are no mock APIs and no alternate implementations anywhere in this tree.
- **Zero external-workspace dependencies.** The harness needs only
  Node >= 18 (stdlib `fetch`) and the `agent-browser` CLI for headless browser
  automation. It runs from this repository alone.
- **No secrets in the repo.** All credentials come from the environment. The
  throwaway account is generated in-memory per run (`.example` email — never
  `.demo`, which is the demo badge heuristic); its credentials are never
  printed, logged or written inside the repository (record them in the
  operator worklog only). `--throwaway-credentials-file=<path>` optionally
  exports them to an operator-chosen file OUTSIDE the repo (mode 0600) so the
  operator can record them in the worklog; that file must never be committed.

## Running

From the repository root:

```bash
# all journeys (production by default)
MOS_E2E_OWNER_EMAIL=… MOS_E2E_OWNER_PASSWORD=… MOS_E2E_AGENT_EMAIL=… MOS_E2E_AGENT_PASSWORD=… \
  node tests/e2e/run.mjs

# one journey
node tests/e2e/run.mjs --journey=tenant-isolation

# journey inventory
node tests/e2e/run.mjs --list

# API-only smoke (skip UI steps; recorded as a deviation in the results)
node tests/e2e/run.mjs --api-only        # sets MOS_E2E_SKIP_UI=1

# export the generated throwaway credentials to an operator file OUTSIDE the
# repo (for the operator worklog record; never commit that file)
node tests/e2e/run.mjs --throwaway-credentials-file=/tmp/mos-e2e-throwaway.json
```

Constrained sandboxes (where a long-lived harness process is reaped) can run
the battery as per-journey invocations sharing ONE run id and ONE throwaway:

```bash
node tests/e2e/run.mjs --journey=signup --throwaway-credentials-file=/tmp/t.json   # creates the tenant
TH=$(cat /tmp/t.json)   # then for every remaining journey:
MOS_E2E_RUN_ID=<same-run-id> MOS_E2E_THROWAWAY_EMAIL=… MOS_E2E_THROWAWAY_PASSWORD=… \
  node tests/e2e/run.mjs --journey=owner        # (client, human-agent, app-lifecycle, …)
```

`run-summary.json` accumulates per-journey entries under the shared run id
(each invocation replaces only its own journeys), and `ensureThrowawayClient`
discovers the tenant's existing client instead of creating a second one, so
chunked and single-process runs are equivalent.

Exit code is `0` only when every selected journey passes. Each journey prints
per-step `[PASS]/[FAIL]` lines; a failing step fails the journey loudly.

Browser steps need generous timeouts (production cold starts): per-command
default is 60s, adjustable via `MOS_E2E_BROWSER_TIMEOUT_MS`.

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `MOS_E2E_BASE_URL` | Target console (same-origin bridge + UI) | `https://mos-product.vercel.app` (production) |
| `MOS_E2E_OWNER_EMAIL` / `MOS_E2E_OWNER_PASSWORD` | Demo agency owner persona (Casey) — read-only use | none, required by owner/client/tenant-isolation/responsive |
| `MOS_E2E_OPERATOR_EMAIL` / `MOS_E2E_OPERATOR_PASSWORD` | Demo operator persona (Jordan) — optional owner-journey variant | none, optional |
| `MOS_E2E_AGENT_EMAIL` / `MOS_E2E_AGENT_PASSWORD` | Demo human-agent persona (Sam) — queue journey | none, required by human-agent |
| `MOS_E2E_THROWAWAY_EMAIL` / `MOS_E2E_THROWAWAY_PASSWORD` / `MOS_E2E_THROWAWAY_AGENCY_NAME` | Reuse a pre-created REAL account instead of generating one | generated in-memory |
| `MOS_E2E_ALLOW_DEMO_OFFER_CONSUMPTION` | `1` = allow the human-agent journey to consume the seeded demo offer through the real claim contract (destructive; see below) | off |
| `MOS_E2E_DEMO_OFFER_ACTION` | `accept` \| `decline` for the destructive claim proof | `accept` |
| `MOS_E2E_SKIP_UI` | `1` = API-only smoke | off |
| `MOS_E2E_RUN_ID` | Evidence directory label | `run-<timestamp>` |
| `MOS_E2E_BROWSER_TIMEOUT_MS` | Per browser-command timeout | `60000` |

The seeded demo persona credentials are the ones displayed on the console
login screen's "Demo accounts" panel. The harness deliberately signs in
through the real email/password form (not the demo quick-login buttons) so
each journey exercises the production credential contract.

## Journey inventory (handoff §8 verification checklist)

| Journey | §8 checklist items | What it proves |
| --- | --- | --- |
| `signup` | Sales-to-delivery journey; demo/real separation | Real zero-simulation sign-up through the console → honest empty states everywhere (command center, clients, attention, profit, human-work 403) → first client created through the empty-state affordance → persistence across sign-out/sign-in → isolation from the demo tenant |
| `owner` | Owner/operator journey; Command Center hierarchy; Client Operating Workspace | Casey signs in → Today renders attention + goals + profit; transport proof (the console sends only Bearer + no authority fields); a client workspace opens with all nine tabs rendering real data; sign out. Optional Jordan (operator) variant |
| `client` | Client journey; Decision Ledger at client context | Evidence/Decisions/Learning/Memory tabs render formatted real data (no raw JSON); decision detail preserves rationale + provenance |
| `human-agent` | Human-agent journey | Sam's queue shows the seeded open offer as a formatted card with working Accept/Decline affordances; marketplace + candidate offers through the real API; claim-route security posture (401/403/404). Destructive claim proof is opt-in (see below) |
| `app-lifecycle` | App install/upgrade/rollback journey | Marketplace lists 4 MOS_CERTIFIED first-party packs; install → upgrade → rollback ledger on the throwaway tenant's own workspace through the real selection contracts; duplicate install 409; re-upgrade to a previously installed version 422 (MKT-048 rule); the console renders the 3-row ledger |
| `tenant-isolation` | Cross-client isolation; Frontend-bypass security | Direct API calls with/without tokens: unauthenticated 401, cross-tenant 404 (existence hidden) / 403 (membership required), human-work profile gate 403, foreign offer claim 404; sign-up duplicate 409 + invalid 400; login bad-credentials 401 (no enumeration); authority-field injection 422 |
| `responsive` | Responsive/mobile checks | 390×844 vs 1280×800: login + Today render, navigation drawer usable, horizontal overflow measured with a documented tolerance |

Journey run order (default) creates the shared throwaway tenant once
(`signup` first); each journey opens its own fresh sessions and browser
sessions are isolated per journey.

## Evidence

Every run writes to `tests/e2e/evidence/<run-id>/`:

- `<journey>/*.json` — API responses (status + body) and structured captures,
  **redacted** (two layers): any key matching
  `/token|password|secret|authorization|credential|bearer/i` is replaced with
  `[REDACTED]` before writing, and the throwaway identity's exact email and
  password values are replaced wherever they appear in serialized text (the
  account menu renders the signed-in email). Request headers are never
  recorded (the transport proof records header *key names* only).
- `<journey>/*.png` — screenshots of the UI steps.
- `<journey>/*.txt` — accessibility-tree snapshots and console output.
- `run-summary.json` — per-journey PASS/FAIL + failed step.

The first live production run's evidence is committed with this harness
(`E2E-RESULTS.md` is its record). Later runs are free to discard or commit
their evidence as the program needs.

## Honest limits and operator procedures

- **Sam's single seeded open offer (single consumer).** The human-agent
  journey is non-destructive by default. With
  `MOS_E2E_ALLOW_DEMO_OFFER_CONSUMPTION=1` it claims the seeded offer through
  the real contract and verifies the honest post-claim state — the offer is
  then **consumed**. Restoration is the documented operator procedure (the
  production seed is idempotent and handles every end state: it closes out an
  accepted fixture honestly through the outcome contract and projects a fresh
  open offer): run the production seed script
  (`scripts/seed-production.ts` in the console source workspace, run with
  `MOS_SEED_BASE_URL=https://mos-product.vercel.app` and the demo admin
  credentials; it is Worker A's recovery scope — do not edit it). The harness
  never runs the seed itself: it lives outside this repository.
- **Vercel Hobby 60s function cap.** All harness requests are short-lived;
  long-running platform work (queue drain) is not exercised here. The
  on-demand drain pattern (admin drain + daily cron) is a deployment fact,
  not a harness fact.
- **On-demand queue worker.** Queue items settle only after a drain; the
  harness only uses synchronous command routes, so no drain-wait is needed.
- **Rate-limited sign-up.** The deployed sign-up route is best-effort
  rate-limited (5 valid sign-ups / 10 min / instance / IP). A default full
  run performs exactly one sign-up; rapid repeated runs or standalone journey
  runs each add one. If a run hits 429, wait or provide a pre-created
  throwaway via `MOS_E2E_THROWAWAY_*`.
- **Responsive tolerance.** "Overflow catastrophe" is defined as document
  scroll width exceeding the viewport by more than 32px. Smaller measured
  overflow is recorded honestly in the results rather than failing the check.
- **Benign hydration warning.** A known, unreproducible React hydration
  console warning may appear (documented at DEP-007; zero functional impact).
  The harness fails on *page errors*, and records console output as evidence.

## Scope boundaries

- This tree never touches `console/` (Worker A) or `src/` (backend): it is a
  NEW tree under `tests/e2e/`.
- No mock APIs, no fabricated data: every datum the harness creates (the
  throwaway agency, its client, workspace, app-install ledger) went through
  real MOS contracts and lives in the throwaway tenant only.
- Demo data is addressed read-only, with one documented exception: the
  opt-in consumption of Sam's seeded offer (restoration procedure above).
