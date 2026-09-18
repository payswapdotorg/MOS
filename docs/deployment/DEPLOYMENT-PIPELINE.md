# MOS Deployment Pipeline — DEP-001

**Status:** Repository-owned deployment pipeline contract (docs only)  
**Upstream contracts:** `docs/handoff/DEPLOYMENT-MATRIX.md` (production acceptance criteria), `docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md` (P0 source gate)  
**Related:** `PROVIDER-CONTRACT.md` (providers + Hobby limits), `ENVIRONMENT-VARIABLES.md` (secrets boundary), `SEEDING.md` (demo data)

This document describes **how MOS production is deployed today** (CURRENT — honest, CLI-sourced from the deployment workspace) and **how it must be deployed once the program completes** (TARGET — repository-driven, wired by DEP-003/DEP-004). Every step is labeled CURRENT or TARGET. Nothing aspirational is presented as done.

## 1. Deployment topology (CURRENT, verified)

```
Browser
  └─ https://mos-product.vercel.app  (Vercel project mos-product, Hobby)
       ├─ Next.js console SPA (static + client routes)
       └─ serverless functions:
            /api/mos/[...path]      same-origin bridge → MOS in-process (60s max)
            /api/mos-signup         real sign-up orchestrator → MOS in-process (60s max)
            /api/mos-admin/drain    bounded queue drain (60s max, 45s budget)
                 └─ mos-bundle/mos.mjs  (real MOS platform, pg external)
                      ├─ Neon PostgreSQL 17.11  (sole authority, migrations at boot)
                      ├─ Cloudflare R2 mos-objects (ObjectStore port, zero-SDK SigV4)
                      └─ vercel.json cron: GET /api/mos-admin/drain @ 03:00 UTC daily
```

## 2. CURRENT pipeline (CLI from the deployment workspace)

The production deployment is **not repository-driven today** — this is the recorded source-of-truth blocker (DEPLOYMENT-MATRIX "Current Vercel deployment evidence"; CONSOLE-SOURCE-RECONCILIATION P0). The live topology was produced by this sequence:

1. **Platform source:** the pristine MOS read-only clone (`MOS-station`) at `2e071d0`. Current repository `main` (`f4a9f42`) adds only documentation commits on top of `2e071d0` — **zero `src/` files differ** (verified by `git diff --name-only 2e071d0..f4a9f42 -- src/` → empty), so the deployed platform source is identical to current `main`.
2. **Bundle build (workspace, `mos-build/entry.ts`):** re-export MOS's own composition root, API router, migration runner, §23 request-shaping pieces and the worker `--drain` composition; bundle with `bun build --target=node --external=pg` into `mos-bundle/mos.mjs` (single serverless-loadable ESM module, ~2.2 MB) plus `mos-bundle/migrations/`. `pg` stays external so node-postgres resolves from `node_modules` at runtime exactly as in every MOS integration test.
3. **Console application (workspace):** Next.js app with the console SPA and the three MOS-carrying server routes; `next.config.ts` `outputFileTracingIncludes` pins `./mos-bundle/**` to **every** route that loads the bundle in-process (`/api/mos/[...]`, `/api/mos-admin/drain`, `/api/mos-signup` — the third was a DEP-007 pre-deploy fix of the DEP-005b crash class: a bundle-loading route shipping without the bundle fails at cold boot).
4. **Host configuration:** `vercel.json` with the single daily cron (`GET /api/mos-admin/drain`, `0 3 * * *`); `.vercelignore`; project linked to `mos-product`.
5. **Secrets:** the 16 production variables (`ENVIRONMENT-VARIABLES.md` §7) set on the Vercel project as `sensitive` (write-only — values cannot be read back through the API or CLI; they were verified empirically by exercising the deployed routes, never by extraction).
6. **Deploy:** `bunx vercel deploy --prod --yes` from the workspace → new production deployment, alias moved to `https://mos-product.vercel.app`. Current artifact: **`dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA`** (READY; source mode `cli`).
7. **Post-deploy verification:** health (`GET /api/mos/platform/health` → `{"status":"ok","service":"marketingos-platform-api","env":"prod"}`), admin login, drain probe (`POST /api/mos-admin/drain` → migrations report + bundle path), seed run (`SEEDING.md`), browser smoke.
8. **Data:** demo seeding through the deployed API only (`scripts/seed-production.ts` — `SEEDING.md`); no direct database writes.

**Honest limitations of CURRENT (all structural consequences of the CLI source mode):**

- The deploy source is an external workspace, so a clean repository checkout does **not** yet reproduce the deployment (DEPLOYMENT-MATRIX acceptance #1/#2 unmet).
- Rollback can only target previously CLI-deployed artifacts (§7).
- The workspace bundle build is a manual step, not a checked-in, CI-executable command.

## 3. TARGET pipeline (repository-driven — wired by DEP-003/DEP-004)

Contract for the end state; each numbered step maps to a later work item.

1. **Console clean-checkout build (P0 → DEP-002/003):** console source committed under `console/` (Worker A P0 recovery) with deterministic install/build/test commands; `npm ci && npm run build` (repo's actual commands once recovered) succeeds from a clean checkout.
2. **Bundle build from repository `src/`:** the `mos-build` entry + bundle step checked into the repository (tooling path to be fixed by DEP-003; the export surface is the one in §2.2), so `mos-bundle/` is produced from repository source, not from a workspace clone.
3. **Preview deployments from PRs (DEP-002):** every PR to `main` produces a Vercel preview with isolated staging credentials; preview URLs host the repo-built console over the repo-built bundle.
4. **Production from `main` (DEP-003):** production deploys are triggered by repository `main` (Vercel Git integration or an explicitly documented CI deploy path) — satisfying CONSOLE-SOURCE-RECONCILIATION acceptance gate 8.
5. **CI gates before deploy (DEP-004):** backend + console lint/typecheck, `arch:check`, unit/architecture/integration suites, console build, then deploy. Migration safety and rollback automation are exercised, not assumed.
6. **Secrets boundary (unchanged from CURRENT):** values only in the host's environment (`ENVIRONMENT-VARIABLES.md`); the repository documents keys, shapes and defaults — never values.
7. **Observability/recovery (DEP-005):** verification window + log review after each production deploy, within Hobby limits.

## 4. Migrations

- **Source:** MOS's own runner (`src/platform/db/migrate.ts`) and the SQL tree `src/platform/db/migrations/` (38 files, numbered `001`…`044` with gaps).
- **Execution model:** migrations apply **at boot** of every MOS instance — including every serverless cold boot — then re-run once post-boot to surface the applied list for evidence. The runner is idempotent and checksummed; re-runs make no changes.
- **Verified production state:** **38 migrations applied, latest `044_app_metering.sql`** (drain report and Tech-Lead acceptance, Task 82 / DEP-007).
- **Schema authority:** only MOS's runner writes schema. Seeds and workers never issue DDL. No manual migration path exists or is permitted.
- TARGET (DEP-004): the same runner wired into the CI pipeline so a deploy can never ship migrations that fail from clean checkouts; migration-drift check between repo `migrations/` and the production database.

## 5. Worker / queue drain pattern (CURRENT — forced by Hobby)

Vercel Hobby hosts no continuous process, so MOS's job queue (PostgreSQL-authoritative) is drained on demand:

- **Route:** `/api/mos-admin/drain` — accepts `POST` (admin session or internal service token) and `GET` (additionally the `CRON_SECRET` bearer, because Vercel crons issue GETs). Authorization is fail-closed and verified through the real MOS authorization-context route — no second authority.
- **Semantics:** one bounded drain = relay recorded dispatches → drain the queue → recover (terminalize dead-job executions, re-arm deferred-paused dispatches, release stale sandbox leases), repeated only while a pass re-arms work; max 10 passes; hard internal budget 45 000 ms under the 60 s function limit; graceful `host.stop()` on deadline. The report surfaces `passes`, `pendingAfter`, `stoppedByDeadline`, migrations and bundle path.
- **Schedule:** daily 03:00 UTC via `vercel.json` cron (Hobby allows exactly one cron per day).
- **Honest consequence:** queue latency is human-scale (jobs settle on drain, not continuously). The staging runtime keeps a continuous worker; production does not, by documented limitation.

## 6. Secrets boundary

- Product secrets (§5 of `ENVIRONMENT-VARIABLES.md`): 16 keys on the Vercel project, type `sensitive`, write-only. They are never committed, never logged, never returned by any route; the drain/health surfaces only booleans (e.g. `migrations.appliedCount`, not connection strings).
- Operator credentials (Vercel/Neon/Cloudflare/GitHub tokens): workspace `.env` only — used to run the pipeline, never shipped to the product.
- Bootstrap admin: env-provided, idempotent, scrypt-verified (never persisted raw) — see `ENVIRONMENT-VARIABLES.md` §5.
- Any new secret a future work item needs must be added to `ENVIRONMENT-VARIABLES.md` (key + purpose + shape) before it is set on the host.

## 7. Rollback

- **Known-good production artifact (CURRENT):** `dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA` — READY, verified by the Tech Lead (health, logins, journeys, app lifecycle, cross-tenant isolation, drain, migrations 38/latest `044_app_metering.sql`).
- **Rollback procedure (CURRENT):** `vercel rollback <deployment-id>` (or redeploy the known-good artifact) from the linked workspace; then re-verify: health JSON, admin login, drain probe, browser smoke of the primary navigation. Database migrations are forward-only in practice — rollback redeploys code, not schema; the migration runner's idempotence makes re-application safe.
- **Historical warning (must stay documented — TECH_LEAD_HANDOFF §10, DEPLOYMENT-MATRIX "Historical warning"):** an older deployment failed with

  ```
  Cannot find package 'pg' imported from /var/task/mos-bundle/mos.mjs
  ```

  That failed artifact stays **out of the default rollback set** until repository-driven builds are proven (TARGET §3). A later inspection window beginning 2026-09-14T21:00:00Z showed no runtime errors; the current known-good artifact boots with `pg` resolved externally from `node_modules`.
- TARGET (DEP-004): one-command rollback with automated post-rollback verification, and a maintained known-good list as deployments become repository-driven.

## 8. DEPLOYMENT-MATRIX production acceptance — status ledger

| # | Criterion (DEPLOYMENT-MATRIX) | Status |
|---|---|---|
| 1 | Clean repository checkout installs successfully | **TARGET** (console source not yet in repo — P0) |
| 2 | Backend and console builds succeed from repository source | **TARGET** (backend builds from repo; console source pending P0) |
| 3 | Database migrations apply from the repository | **CURRENT-MET** (bundle ships the repo migration tree; 38 applied, latest `044_app_metering.sql`) |
| 4 | Secrets/configuration documented without revealing values | **CURRENT-MET** (this tree; `ENVIRONMENT-VARIABLES.md`) |
| 5 | Health checks pass | **CURRENT-MET** (live production health JSON) |
| 6 | Browser smoke suite passes against the repository-built deployment | **TARGET** (smoke passes against the CLI-built deployment today; repository-built pending DEP-002/003) |
| 7 | Client isolation and frontend-bypass tests pass | **CURRENT-MET on live production** (cross-tenant 404/403 verified); harness binding to repo build is TARGET (Worker C) |
| 8 | Rollback exercised against a known-good deployment artifact | **PARTIAL** (known-good artifact recorded; automated exercise is DEP-004 TARGET) |
| 9 | Runtime logs show no unexpected errors in the verification window | **CURRENT-MET** (Task 82 acceptance window; one benign unreproducible hydration console warning documented, no functional impact) |
| 10 | Any environmental test limitation disclosed with exact scope | **CURRENT-MET** (Hobby limits, on-demand queue, ephemeral secrets dir, absent Redis, no AI provider — all recorded in `PROVIDER-CONTRACT.md` §4) |

Production is **deployed and accepted as live**, but is **not yet reproducible from the repository** — exactly the state DEPLOY-002/003/004 exist to close.

## 9. Fact provenance

- CURRENT steps: workspace deployment sources (`next.config.ts`, `vercel.json`, `mos-build/entry.ts`, `src/lib/mos-runtime.ts`, bridge/drain/signup routes) and worklog Tasks 81/82 + DEP-005b/DEP-007.
- Deployment id/state/source: Vercel API read at DEP-001 authoring time (`dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA`, READY, `cli`, target production).
- Migrations: `src/platform/db/migrations/` (38 files) + production drain reports (appliedCount 38, latest `044_app_metering.sql`).
- Platform-source identity between the deployed bundle and current `main`: `git diff --name-only 2e071d0..f4a9f42 -- src/` → empty.
