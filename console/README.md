# MOS Product Console (`console/`)

The user-facing **MOS Marketing Operating System console**: a Next.js 16 (App
Router, React 19, Tailwind v4, shadcn/ui-style components) presentation layer
over the **real MOS platform API**.

This is the recovered ORIGINAL source of the live product (Vercel project
`mos-product`, production alias `https://mos-product.vercel.app`), committed
into the repository as the source of truth (**Work Item P0-SRC / UI-001** —
see `docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md`). It was recovered from
the deployment-era source workspace verbatim, curated to the real dependency
closure; no compiled `/_next/static` bundle was reverse-engineered.

**Posture (PRODUCT-CONSOLE-V1.5):** presentation only. The SPA holds zero
authority state — every rendered datum comes from a MOS API response, every
mutation goes through an existing MOS route, 401 clears the session, and
403/404 errors are surfaced verbatim (the server's own words). Client-side
state never grants anything.

---

## 1. Architecture in one page

```
browser SPA (src/components/mos/*)
   │  same-origin, relative fetches only — never absolute URLs, never :3010
   ▼
Next.js API bridge  src/app/api/mos/[...path]/route.ts        (transport only)
   │
   ├── PRODUCTION (MOS_DATABASE_URL set): serves the request IN-PROCESS
   │     through the REAL MOS platform bundled into this deployment —
   │     mos-bundle/mos.mjs (bun build of THIS repo's ../src backend,
   │     pg external) booted per serverless instance by
   │     src/lib/mos-runtime.ts (bootstrapApplication → migrations →
   │     buildApiRouter) and served via src/lib/mos-request.ts.
   │
   └── DEVELOPMENT (no MOS_DATABASE_URL): proxies server-side to the
         staging MOS runtime at MOS_UPSTREAM_ORIGIN (default
                 http://127.0.0.1:3010), preserving method, JSON body,
         Authorization + Content-Type and only the browser-set query params.

auxiliary routes:
   POST /api/mos-signup        real account creation orchestrator (see §3)
   GET/POST /api/mos-admin/drain   bounded on-demand queue drain (see §6)
```

The console is a sub-package of the MOS repository: the backend it bundles
and talks to is the repository's own frozen v1.5 tree at `../src` — nothing
at runtime depends on files outside this repository.

## 2. API base URL contract

- The browser SPA **always** calls the same-origin bridge `/api/mos/<subpath>`
  (`MOS_BRIDGE_BASE = "/api/mos"` in `src/lib/mos-api.ts`). It never addresses
  a host/port directly — no absolute URLs, no `XTransformPort` (deleted in
  DEP-003b). MOS's strict query validation therefore cannot 422 on transport
  params.
- `/api/mos/<subpath>` maps 1:1 to the MOS platform route `/api/<subpath>`.
- Mode selection (bridge and `src/lib/mos-transport.ts` agree, read them
  before changing): **in-process when `MOS_DATABASE_URL` is set and
  `MOS_BRIDGE_FORCE_PROXY != "1"`; otherwise dev proxy to
  `MOS_UPSTREAM_ORIGIN`** (default `http://127.0.0.1:3010`).
- Responses return upstream status + body verbatim with an
  `x-mos-upstream-status` debug header. 204/205/304 carry a null body (WHATWG
  parity — DEP-005b/DEP-006 fix).

## 3. Authentication contract

- **Sign in:** the login screen POSTs through the bridge to the platform's
  real `POST /api/auth/login` `{email, password}` → `200 {token, ...}`;
  the SPA stores the Bearer token (zustand session store, validated on boot
  via `GET /api/auth/authorization-context`; a 401 clears back to the login
  screen). Bad credentials are the platform's uniform 401 — never a hint
  about which field was wrong.
- **Bearer sessions:** every subsequent call sends
  `Authorization: Bearer <token>`; TTL is `MOS_AUTH_SESSION_TTL_MS` on the
  platform. The SPA holds the token presentation-side only — it grants
  nothing the server doesn't enforce.
- **Real sign-up (zero simulation):** `POST /api/mos-signup` with
  `{displayName, email, agencyName, password}` (validation mirrors the
  platform: displayName/agencyName 1–100, password 12–256, honest 400s;
  best-effort 5-per-10-min-per-IP in-memory rate limit → 429). The route is a
  server-side orchestrator over MOS's own admin contracts via the dual-mode
  transport (`src/lib/mos-transport.ts`): admin login (env credentials,
  server-only) → `POST /api/users` (duplicate email ⇒ honest
  `409 EMAIL_ALREADY_REGISTERED`, never a credential reset) →
  `POST /api/users/:id/credential {password}` → `POST /api/agencies
  {name, ownerUserId}` (owner membership auto-created) → `201 {ok, email,
  agencyName, userId}` — nothing else is created: real accounts start
  genuinely empty (honest empty states everywhere).
- **Demo quick-login panel:** the login screen also offers the four seeded
  demo personas (§8) for exploration; sessions whose email ends in `.demo`
  get a presentation-only "Demo — pre-seeded data" badge. The badge is a
  hint, never a gate — every permission stays server-enforced.

## 4. Environment variables

`MOS_*` variables are the platform contract (`../src/platform/config/config.ts`
— validated once at boot, fail-fast). Console-only variables are marked (C).

### Required in production (in-process mode)

| Variable | Meaning |
| --- | --- |
| `MOS_DATABASE_URL` | PostgreSQL connection string (system of record — Neon in the live deployment). Arming in-process mode is the presence of this var. |
| `MOS_ENV` | `dev` / `test` / `prod` (the live deployment logs `env: prod`). |
| `MOS_OBJECT_STORE` | `memory` / `fs` / `s3`. Production uses `s3`. |
| `MOS_S3_ENDPOINT` | S3-compatible endpoint (Cloudflare R2 in the live deployment). Required together with the rest of the S3 set when `MOS_OBJECT_STORE=s3` (complete-or-absent, fail fast). |
| `MOS_S3_REGION` | S3 region. |
| `MOS_S3_BUCKET` | Bucket name (`mos-objects` live). |
| `MOS_S3_ACCESS_KEY_ID` | S3 access key. |
| `MOS_S3_SECRET_ACCESS_KEY` | S3 secret key. |
| `MOS_S3_PATH_STYLE` | `true` for R2-style path addressing. |
| `MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL` | Platform admin bootstrapped at startup (start-time config; only the scrypt verifier is persisted). |
| `MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD` | Its initial password (≥ 12 chars). Also the sign-up orchestrator's fallback admin credential. |

### Optional / defaults

| Variable | Meaning |
| --- | --- |
| `MOS_SECRETS_DIR` | File-backed secret store root; serverless default documented as `/tmp/mos-secrets` (ephemeral per instance — `src/lib/mos-runtime.ts` creates it). |
| `MOS_INTERNAL_API_TOKEN` | Internal service principal bearer (drain route authorization; empty = authenticated routes fail closed). |
| `MOS_SIGNUP_ADMIN_EMAIL` / `MOS_SIGNUP_ADMIN_PASSWORD` | (C) explicit admin credential for the sign-up orchestrator; falls back to `MOS_BOOTSTRAP_PLATFORM_ADMIN_*`. Server-only, never logged, never shipped to the browser bundle. |
| `MOS_AUTH_SESSION_TTL_MS` | Bearer session lifetime. |
| `MOS_LOG_LEVEL` | `debug` / `info` / `warn` / `error`. |
| `MOS_REDIS_URL` / `MOS_REDIS_TIMEOUT_MS` | Optional advisory cache/lock backend (empty = documented degenerate adapters; absent in the live deployment). |
| `MOS_HTTP_*`, `MOS_WORKER_*`, `MOS_JOB_*`, `MOS_QUEUE_STALE_CLAIM_MS`, `MOS_OBJECT_STORE_DIR`, `MOS_AI_*` | Standalone-process / worker / AI-adapter knobs — unused in-process except where the composition root reads them; see `../src/platform/config/config.ts`. |

### Console/dev-only

| Variable | Meaning |
| --- | --- |
| `MOS_UPSTREAM_ORIGIN` | (C) dev-mode bridge/transport proxy target (default `http://127.0.0.1:3010` — the DEP-002 staging runtime). |
| `MOS_BRIDGE_FORCE_PROXY` | (C) set `1` to force the dev proxy even when `MOS_DATABASE_URL` is present. |
| `MOS_BUNDLE_PATH` | (C) explicit bundle location for `src/lib/mos-runtime.ts` (default: `console/mos-bundle/mos.mjs` via cwd candidates). |
| `CRON_SECRET` | (C) Vercel cron bearer for the GET form of the drain route. |
| `MOS_SEED_BASE_URL`, `MOS_SEED_ADMIN_EMAIL`, `MOS_SEED_ADMIN_PASSWORD` | (C) `scripts/seed-production.ts` inputs (the deployed base URL + platform admin; internal token comes from `MOS_INTERNAL_API_TOKEN`). |

Secrets are never committed. `.vercel/project.json` (projectId + orgId of
`mos-product` only — no secret material) IS committed so any checkout can
deploy previews with `--token`.

## 5. Install / build / verify (deterministic)

Package manager: **Bun** (`bun.lock`; Bun ≥ 1.2 — also the bundler for the
serverless bundle, matching the production toolchain). Node ≥ 20 for `next`.

```bash
cd console
bun install            # deterministic install from bun.lock
bun run lint           # eslint over the console source (src/)
bun run typecheck      # tsc --noEmit over the console app (src/)
bun run build:bundle   # bun mos-build/build-bundle.mjs → mos-bundle/mos.mjs
                       #   + migrations, rebuilt from THIS repo's ../src
bun run build          # build:bundle FIRST, then next build
bun run dev            # next dev -p 3000 (needs a MOS upstream — §6)
```

`next build` never runs without the fresh bundle: the `build` script runs
`build:bundle` first, and `vercel.json` wires the same
`bun run build:bundle && next build` into the Vercel build command. The
generated `mos-bundle/` artifacts are gitignored (see `mos-bundle/README.md`).
The traced serverless functions ship the bundle (`next.config.ts`
`outputFileTracingIncludes`) **and its externalized `pg` dependency**: the
`src/lib/mos-pg-trace.ts` import pin keeps `node_modules/pg` (with its full
transitive closure) inside the trace — the file tracer cannot see inside the
prebuilt `mos.mjs`, and without the pin the function loses `pg` and hits the
§10 outage class.

### Bundle reproducibility rule

`mos-bundle/mos.mjs` is ALWAYS built from the repository's own backend
(`../src`, the frozen v1.5 tree) via `mos-build/entry.ts`
(`bun build --target=node --external=pg`) — the exact DEP-005b recipe that
produced the live deployment. Never hand-edit the bundle; rerun
`bun run build:bundle`. Sanity checks: `bun mos-build/smoke.mjs` (exports),
`bun mos-build/prod-boot.mjs` (boots the bundle against production infra —
requires the production env), `bun mos-build/verify-app-lifecycle.ts` /
`bun mos-build/verify-cross-tenant.ts` (journey checks against a deployed
base URL — see the file headers for their env inputs).

## 6. Running locally

**Dev against the staging runtime** (the DEP-002 shape): start a MOS
backend (e.g. the repository API entrypoint `node ../src/entrypoints/api.ts`,
or the staging runtime) listening on `127.0.0.1:3010`, then:

```bash
cd console && bun run dev      # http://localhost:3000
```

With no `MOS_DATABASE_URL`, the bridge proxies `/api/mos/*` to
`MOS_UPSTREAM_ORIGIN`. `.env` (gitignored) may set `MOS_UPSTREAM_ORIGIN`.

**Production shape locally** (MOS in-process over a real PostgreSQL):
set the §4 production env vars (at minimum `MOS_DATABASE_URL`,
`MOS_ENV=prod`, `MOS_SECRETS_DIR`, bootstrap admin) in `.env`, then
`bun run build && bun run start` — the bridge boots the bundled MOS platform
per instance and serves the full API in-process (this is the exact deployed
shape; `bun mos-build/prod-boot.mjs` proves the bundle against the same env).

## 7. Deploying

The Vercel project is **`mos-product`** (`prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq`,
team `team_4KOoA5CgtYaOF85yFXPeMXLt`); `.vercel/project.json` is committed.

**Preview deployment from a repository checkout (the proven CLI recipe —
build locally, deploy prebuilt):**

```bash
set -a; . ../.env; set +a                 # VERCEL_TOKEN (never printed)
bunx vercel build                         # bun install + build:bundle (mos.mjs
                                           #   + migrations compiled from THIS
                                           #   repo's ../src) + next build
bunx vercel deploy --prebuilt --yes       # PREVIEW deployment of that build
bun run deploy:preview                    # = the two commands above
```

A plain `bunx vercel deploy` from `console/` fails by design and must not be
used: the CLI uploads `console/` only, so the repository's `../src` backend is
absent on Vercel's build machine and the remote `build:bundle` step of
`vercel.json`'s buildCommand fails (`missing input: /vercel/src/composition-
root.ts` — verified). `vercel build` runs locally where the full checkout
(including `../src`) exists, and `deploy --prebuilt` ships exactly that
repository-derived build. Production from the CLI is the same shape with
`--prod` (alias update — owner decision, DEP-003/004). A Git-connected
deployment (project Root Directory `console/`) uploads the whole repository,
so the same `vercel.json` buildCommand runs remotely unchanged — wiring that
connection is DEP-003/004 scope, not this package's.

The CLI upload honors `.vercelignore` (no `.env*`, no `node_modules`, no
`scripts/`; the gitignored generated `mos-bundle/` artifacts are NOT excluded —
the prebuilt flow's traced functions ship them) and `vercel.json`: build
command `bun run build:bundle && next build`, plus the daily 03:00 UTC cron
on `/api/mos-admin/drain`. **Preview deployments of this project talk to
the same authoritative Neon database as production** (the project env vars)
— treat them as production-adjacent; the production alias is never touched
by preview deploys.

The admin-gated drain (`POST /api/mos-admin/drain`, bearer =
`MOS_INTERNAL_API_TOKEN` or a platform-admin session; GET form additionally
accepts `CRON_SECRET` for the cron) is the honest Hobby-plan substitute for a
continuous worker: one bounded relay→drain→recover pass set, ≤ 45 s budget.

## 8. Demo identities (seeded, exploration only)

Created by `scripts/seed-production.ts` (idempotent — every datum through the
real deployed API; re-running makes no changes):

| Email | Password | Role / what it shows |
| --- | --- | --- |
| `admin@mos.demo` | `DemoAdmin-2026` | Platform administrator (bootstrap identity). |
| `casey@northwind.demo` | `Northwind-Owner-2026` | Agency owner — rich demo data: 2 clients (Helio Robotics, Atlas Freight Systems), goals, running workflows, attention queue, profit intelligence, 4 installed first-party apps. |
| `jordan@northwind.demo` | `Northwind-Ops-2026` | Agency operator. |
| `sam@northwind.demo` | `Northwind-Agent-2026` | Human agent — the open human-work offer with Accept/Decline. |

`bun scripts/seed-production.ts` requires `MOS_SEED_BASE_URL` (the deployed
URL), `MOS_SEED_ADMIN_PASSWORD` (bootstrap admin) and
`MOS_INTERNAL_API_TOKEN`. Demo data is presentation-only enrichment — real
accounts never see it (isolation is server-enforced).

## 9. Testing

No component tests exist in the recovered source (honest state; P0 is source
recovery, no tests invented). The verification surface today: `bun run lint`
+ `bun run typecheck` + the deterministic build, the `mos-build/verify-*`
journey runners, the seed's idempotency proof, and browser verification of
the deployed console (login/journeys — see the worklog records DEP-005b,
DEP-006/006b, DEP-007). Component/E2E tests from the repository are the
follow-up scope (gate item 7 of CONSOLE-SOURCE-RECONCILIATION).

## 10. Historical rollback warning (do not reintroduce)

An older Vercel deployment emitted:

```
Cannot find package 'pg' imported from /var/task/mos-bundle/mos.mjs
```

(Tech Lead handoff §10 / CONSOLE-SOURCE-RECONCILIATION "Known live runtime
evidence"). Cause: a deployment where the externally-imported `pg` was not
resolvable from the serverless function. `pg` therefore remains a **runtime
dependency of this package** even though no console source file imports it
statically — `mos-bundle/mos.mjs` resolves it from `node_modules` at runtime
(`--external=pg` in the bundle build). The structural fix in this package:
`src/lib/mos-pg-trace.ts` pins `pg` into the Next.js server trace (§5), so
every bundle-loading route's function ships `node_modules/pg`. A rollback to
an old artifact without `pg` installed would reintroduce the outage. No
runtime errors have been observed on the live deployment since
2026-09-14T21:00:Z.

## 11. Source provenance

Recovered from the deployment-era source workspace (the workspace that
produced the Vercel CLI deployments dpl_Ggjek4tr…/dpl_GqfVZDtL…) by direct
file copy, then curated: sandbox-only trees (replay-stack API routes,
Prisma/SQLite leftovers, unused shadcn components, inert Tailwind v3 config,
marketing/dependency cruft) were removed, `package.json` was pruned to the
real import closure, and the bundle entry/seed imports were re-pathed to this
repository's layout. Adaptations are marked with `P0-SRC` comments; everything
else is the original source, byte-for-byte.
