# MOS Environment Variables — DEP-001

**Status:** Repository-owned environment variable contract (docs only)  
**Authoritative sources:** `src/platform/config/config.ts` (MOS platform config — single validated source of every `MOS_*` variable), plus the deployment-phase console/bridge sources that will land in this repository with the P0 console recovery.  
**Secret rule:** this document records **keys, purposes, defaults, validation and example SHAPES only**. Real values never appear in this repository. Production values are set in the Vercel project (type `sensitive`, write-only) and are not recoverable through the API; operator-side provider credentials live only in the workspace `.env` (never committed).

## 1. Conventions

- `MOS_*` variables are consumed by MOS's own `loadConfig(process.env)` (validated once at startup; the process fails fast on invalid values; security-relevant settings fail closed).
- "Both-or-neither" pairs abort startup when only one side is set (no half-configured production adapters).
- Defaults below are the documented platform defaults from `config.ts`; a variable marked *required in prod* must be explicitly set in that environment.
- `dev` = local development; `staging` = DEP-002 staging runtime / preview; `prod` = the deployed production topology.

## 2. Platform core (MOS source — `src/platform/config/config.ts`)

| Key | Purpose | dev | staging | prod | Example shape / default |
|---|---|---|---|---|---|
| `MOS_DATABASE_URL` | PostgreSQL connection string — the system of record | required | required | required | `postgres://user:pass@host/db` (must be `postgres://` or `postgresql://`) |
| `MOS_ENV` | Environment label | optional (`dev`) | `test`\* | `prod` | one of `dev` \| `test` \| `prod` |
| `MOS_LOG_LEVEL` | Minimum structured log level | optional | optional | set | `debug` \| `info` \| `warn` \| `error` (default `info`) |
| `MOS_OBJECT_STORE` | Object store kind | `memory`/`fs` | `fs` | `s3` | `memory` \| `fs` \| `s3` |
| `MOS_OBJECT_STORE_DIR` | fs object-store root | optional | set | — | `./var/objects` |
| `MOS_S3_ENDPOINT` | S3-compatible endpoint URL | — | — | required when `MOS_OBJECT_STORE=s3` | `https://<account>.r2.cloudflarestorage.com` |
| `MOS_S3_REGION` | signing region | — | — | required (defaults `us-east-1` if blank) | `us-east-1`, `auto` |
| `MOS_S3_BUCKET` | bucket name | — | — | required when s3 | `mos-objects` |
| `MOS_S3_ACCESS_KEY_ID` | object-store access key | — | — | required when s3 | R2 access key id (32 chars) |
| `MOS_S3_SECRET_ACCESS_KEY` | object-store signing key | — | — | required when s3 | R2 secret (64 chars) |
| `MOS_S3_PATH_STYLE` | path-style addressing | — | — | `true` | `true` \| `false` (default `true`; R2 uses path-style) |
| `MOS_S3_TIMEOUT_MS` | request timeout | — | — | optional | integer 100–300000 (default `10000`) |
| `MOS_REDIS_URL` | OPTIONAL advisory cache/lock backend | unset | unset | unset (CURRENT) | `redis://:pass@host:6379` — empty/absent wires degenerate adapters |
| `MOS_REDIS_TIMEOUT_MS` | per-command Redis timeout | — | — | — | default `2000` |
| `MOS_SECRETS_DIR` | file-backed secret store root | `./var/secrets` | set | `/tmp/mos-secrets` (ephemeral per serverless instance) | any writable dir |
| `MOS_INTERNAL_API_TOKEN` | bearer token for platform-internal routes (queue drain, service principal) | optional | set | set | long random string; empty = fail closed |
| `MOS_AUTH_SESSION_TTL_MS` | user session lifetime | optional | optional | set | integer 60000–2592000000 (default 12 h) |
| `MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL` | bootstrap platform admin identity (see §5) | both-or-neither | both-or-neither | both-or-neither | `admin@mos.demo` |
| `MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD` | bootstrap admin initial password (see §5) | both-or-neither | both-or-neither | both-or-neither | ≥12 chars; never persisted raw |
| `MOS_HTTP_HOST` / `MOS_HTTP_PORT` | HTTP listener (standalone api entrypoint) | optional | `127.0.0.1` / set | — (serverless) | defaults `127.0.0.1` / `8080` |
| `MOS_HTTP_MAX_BODY_BYTES` | max accepted request body | optional | optional | — | default 1 048 576 (1 MiB) |
| `MOS_WORKER_ID` / `MOS_WORKER_POLL_INTERVAL_MS` / `MOS_WORKER_BATCH_SIZE` | worker identity/polling | optional | set | — (drain composes its own) | default generated / `500` / `5` |
| `MOS_JOB_MAX_ATTEMPTS` / `MOS_JOB_RETRY_BACKOFF_BASE_MS` / `MOS_QUEUE_STALE_CLAIM_MS` | queue retry/reclaim policy | optional | optional | defaults | `5` / `1000` / `300000` |
| `MOS_AI_PROVIDER` | AI runtime provider adapter | `none` | `none` | `none` (CURRENT) | `none` \| `openrouter` — complete-or-absent |
| `MOS_AI_OPENROUTNER_ENDPOINT` / `MOS_AI_OPENROUTNER_API_KEY` / `MOS_AI_OPENROUTNER_TIMEOUT_MS` | AI provider settings (both required together when provider is `openrouter`) | — | — | — | `https://…` / key / default `30000` |

\* The DEP-002 staging runtime runs `MOS_ENV=dev` today (documented in the staging record); the role table in `PROVIDER-CONTRACT.md` §1 remains the contract.

## 3. Deployment-phase console/bridge variables (land with P0 console recovery)

These are read by the console's server routes (currently in the deployment workspace; TARGET: `console/` in this repository). They are transport configuration only.

| Key | Purpose | dev | staging | prod | Example shape / default |
|---|---|---|---|---|---|
| `MOS_DATABASE_URL` | **mode switch** for the dual-mode bridge/transport: set ⇒ serve MOS **in-process**; unset ⇒ forward to the staging runtime | unset | unset (staging URL lives in the mini-service env) | set | same value as §2 |
| `MOS_UPSTREAM_ORIGIN` | dev/staging forward target of the same-origin bridge and sign-up transport | `http://127.0.0.1:3010` | set | unused | `http://127.0.0.1:3010` |
| `MOS_BRIDGE_FORCE_PROXY` | force the forwarding mode even when `MOS_DATABASE_URL` is set (diagnostics) | — | optional | — | `1` |
| `MOS_BUNDLE_PATH` | explicit MOS bundle location (defaults walk `./mos-bundle/mos.mjs` and parents) | — | — | optional | `/var/task/mos-bundle/mos.mjs` |
| `MOS_SIGNUP_ADMIN_EMAIL` / `MOS_SIGNUP_ADMIN_PASSWORD` | admin credential for the sign-up orchestrator on staging (fallback chain in §5) | — | both-or-neither | unset (falls back) | `admin@mos.demo` / ≥12 chars |
| `CRON_SECRET` | bearer accepted by `GET /api/mos-admin/drain` for the daily Vercel cron | — | — | set | long random string |

## 4. Seed runner variables (see `SEEDING.md`)

| Key | Purpose | Where used |
|---|---|---|
| `MOS_SEED_BASE_URL` | base URL of the MOS API to seed (staging runtime URL or deployed production URL) | both seeds |
| `MOS_SEED_ADMIN_EMAIL` / `MOS_SEED_ADMIN_PASSWORD` | platform-admin login the seed uses to orchestrate (default email `admin@mos.demo`) | both seeds |
| `MOS_INTERNAL_API_TOKEN` | service principal for direct internal calls during seeding | production seed |

## 5. Bootstrap and fallback semantics

**`MOS_BOOTSTRAP_PLATFORM_ADMIN_*` — idempotent platform bootstrap (MOS source, MKT-002).**
- Email and password are **both-or-neither**; password must be ≥12 characters, else startup fails.
- The bootstrap is **start-time configuration only**: it creates the platform administrator if absent (idempotent); only the scrypt verifier lands in the auth-owned credential store — the raw password is never persisted.
- It runs on every MOS boot, including every serverless cold boot of the production deployment.

**`MOS_SIGNUP_ADMIN_*` — staging fallback chain (console source, DEP-006).**
The sign-up orchestrator resolves its admin credential as:

```
MOS_SIGNUP_ADMIN_EMAIL    ?? MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL
MOS_SIGNUP_ADMIN_PASSWORD ?? MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD
```

- Production (Vercel): `MOS_SIGNUP_ADMIN_*` is unset ⇒ falls back to the bootstrap admin.
- Staging: `MOS_SIGNUP_ADMIN_*` may hold the staging admin.
- The resolved credential is **server-only**: never returned, never logged, never shipped to the browser bundle. If it is absent or login fails, the route answers an honest 503 "sign-up temporarily unavailable" — it never degrades into simulation.

## 6. Local development contract (dual-mode bridge)

The console's server routes (API bridge, sign-up) implement one mode selection:

- **Development (`MOS_DATABASE_URL` unset on the console process):** every browser call to `/api/mos/<subpath>` is forwarded server-side to the staging runtime MOS API at `MOS_UPSTREAM_ORIGIN` (default `http://127.0.0.1:3010`). The browser holds no absolute URLs and no port knowledge.
- **Production (`MOS_DATABASE_URL` set, `MOS_BRIDGE_FORCE_PROXY` unset):** the same routes serve MOS **in-process** — the pre-built platform bundle is booted once per serverless instance (migrations + idempotent admin bootstrap), and requests go through MOS's own API router. This is the same shape in staging-vs-prod terms: mode is derived from configuration, not code.

`MOS_BRIDGE_FORCE_PROXY=1` forces forwarding mode for diagnostics even when the database URL is present.

## 7. Variables currently set on the Vercel production project (CURRENT — 16 keys, names only)

Verified via the Vercel API (values are `sensitive`/write-only and were never read):

1. `MOS_DATABASE_URL`
2. `MOS_ENV`
3. `MOS_LOG_LEVEL`
4. `MOS_OBJECT_STORE`
5. `MOS_S3_ENDPOINT`
6. `MOS_S3_REGION`
7. `MOS_S3_BUCKET`
8. `MOS_S3_ACCESS_KEY_ID`
9. `MOS_S3_SECRET_ACCESS_KEY`
10. `MOS_S3_PATH_STYLE`
11. `MOS_SECRETS_DIR`
12. `MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL`
13. `MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD`
14. `MOS_INTERNAL_API_TOKEN`
15. `MOS_AUTH_SESSION_TTL_MS`
16. `CRON_SECRET`

Mapping to the tables above: keys 1–15 are platform-core variables (§2); key 16 is the cron bearer (§3). Notably NOT set in production (by design, CURRENT): `MOS_REDIS_URL` (absent Redis), any `MOS_AI_*` (no provider), `MOS_SIGNUP_ADMIN_*` (bootstrap fallback is used), `MOS_OBJECT_STORE_DIR` (s3 store selected), `MOS_UPSTREAM_ORIGIN`/`MOS_BRIDGE_FORCE_PROXY` (in-process mode).

## 8. Operator/workspace credentials (NOT product variables)

These live only in the deployment workspace `.env` (mode 600) and are used to operate providers — they are **never** MOS runtime configuration and must never be committed, echoed or logged:

`VERCEL_TOKEN`, `GITHUB_TOKEN`, `NEON_API_KEY`, `NEON_PROJECT_ID`, `NEON_DATABASE_URL` (operator copy of the prod connection string), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_S3_ENDPOINT` (workspace mirrors used to set the production `MOS_S3_*` values).

The boundary rule: **product env = `MOS_*` + `CRON_SECRET` set on the host; operator env = provider credentials in the workspace.** A deployment work item that requires an operator credential to run is a pipeline step (`DEPLOYMENT-PIPELINE.md`), not a runtime dependency.

## 9. Fact provenance

- Platform defaults/validation: `src/platform/config/config.ts` (read directly; single `loadConfig(process.env)` call sites in `src/composition-root.ts`).
- Console/bridge variables: the deployment-phase sources (bridge route, sign-up route, drain route, transport lib) in the workspace — cited as CURRENT, to be re-cited from `console/` after P0 recovery.
- Production key set: Vercel API read at DEP-001 authoring time (16 production-scoped keys, all type `sensitive`).
