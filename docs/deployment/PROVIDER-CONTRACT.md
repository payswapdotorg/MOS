# MOS Provider Contract — DEP-001

**Status:** Repository-owned environment contract (coordination artifact, not architectural authority)  
**Authoritative upstream contract:** `docs/handoff/DEPLOYMENT-MATRIX.md` (v1.5 environment roles, provider-selection rule, production acceptance criteria)  
**Downstream consumers:** DEP-002 (staging), DEP-003 (production wiring), DEP-004 (CI/CD + rollback), DEP-005 (observability/recovery)

This document records the verified providers and capability ports for each environment role, and the exact plan-level limitations the current production topology operates under. It exists so that every later deployment work item starts from recorded, verifiable facts instead of re-deriving them.

**Honesty labels used throughout this tree:**

- **CURRENT** — verified against the live topology from the deployment workspace (CLI-sourced deployment; see `DEPLOYMENT-PIPELINE.md` §2). The production deployment is NOT yet repository-driven.
- **TARGET** — the repository-driven end state required by `docs/handoff/DEPLOYMENT-MATRIX.md` production acceptance and `docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md`. TARGET items are contracts, not claims of completion.

## 1. Environment roles (from DEPLOYMENT-MATRIX v1.5)

| Role | MOS API source | Console source | PostgreSQL | Object storage | Redis | Secrets |
|---|---|---|---|---|---|---|
| Development / local | repository `src/` | repository `console/` after P0 recovery (CURRENT: external workspace) | provider adapter-backed dev DB | artifact storage only | transient coordination only | environment/credential boundary; never ordinary domain data |
| Preview / staging | repository `src/` (CURRENT: DEP-002 staging runtime on `:3010` from the workspace) | repository build (CURRENT: workspace build served on `:3000`) | staging database | staging bucket | optional staging instance | isolated credentials |
| Commercial production | repository bundle (CURRENT: CLI-deployed pre-built bundle) | CURRENT: CLI deployment, source not yet in repo | production tier | production bucket with backup/retention posture | optional paid tier (transient only) | production secrets in the deployment/credential boundary |

No infrastructure vendor identity is encoded into Deployment domain semantics (DEPLOYMENT-MATRIX "Commercial production" rule).

## 2. Verified providers (CURRENT — live production topology)

All facts below were verified during infrastructure provisioning and production acceptance (worklog Tasks 81/82, DEP-005b/007); re-verified read-only at DEP-001 time. Credential **values** live only in the operator workspace `/home/z/my-project/.env` (mode 600) — never in this repository.

### 2.1 Vercel — web hosting (console SPA + in-process MOS API)

| Field | Verified value |
|---|---|
| Project | `mos-product` |
| Project ID | `prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq` |
| Team | `team_4KOoA5CgtYaOF85yFXPeMXLt` |
| Plan | **Hobby** (no paid serverless; verified at provisioning) |
| Framework / runtime | Next.js, Node 24.x |
| Production alias | `https://mos-product.vercel.app` |
| Current production deployment | `dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA` — READY (re-verified via Vercel API at DEP-001 authoring time) |
| Source mode | **CLI** (deployed with `vercel deploy --prod` from the external workspace — the repository is not yet the deploy source; see `DEPLOYMENT-PIPELINE.md` §2) |
| Deployment protection | SSO protection disabled — public access (deliberate, so the product URL is reachable without Vercel SSO) |

Role: serves the console SPA and the same-origin API bridge / sign-up orchestrator / admin drain routes, with the real MOS platform booted **in-process** per serverless instance (bundle loaded from disk; `pg` resolved from `node_modules` at runtime).

### 2.2 Neon — PostgreSQL (sole authoritative durable store)

| Field | Verified value |
|---|---|
| Project | `rough-pond-82110592` ("mos-production") |
| Organization | `org-shy-shadow-21570034` |
| Region | `aws-us-east-1` |
| PostgreSQL version | 17.11 (verified with MOS's own `pg` client at provisioning) |
| Branch | `br-holy-sky-av91wkly` |
| Endpoint | `ep-steep-scene-avfn8tei.c-11.us-east-1.aws.neon.tech` |
| Database | `neondb` |

Role: **the only authoritative store for durable MOS state** — workflows, executions, deployments, evidence, decisions, apps, metering, the job queue, session/auth state. Migrations apply from MOS's own runner at boot (38 migrations applied, latest `044_app_metering.sql`; see `DEPLOYMENT-PIPELINE.md` §4). Cross-region locality was chosen to sit next to the R2 bucket (below).

### 2.3 Cloudflare R2 — object storage (artifacts only)

| Field | Verified value |
|---|---|
| Bucket | `mos-objects` (locationHint `enam`, near Neon's us-east-1) |
| Access path | MOS's own zero-SDK SigV4 `S3ObjectStore` (`src/platform/objects/adapters/s3/s3-object-store.ts`, path-style) |
| Proof | PUT+GET roundtrip with identical bytes and preserved content type, executed with the production adapter code at provisioning |

Role: artifact/object storage behind the `ObjectStore` port — never an authority. The adapter performs SigV4 signing with MOS's own crypto module (`src/platform/sigv4.ts`); **no AWS SDK is imported anywhere in MOS source** (verified: the S3 adapter's only imports are MOS-internal modules).

### 2.4 Redis — ABSENT by design (documented limitation, not a gap)

- No Upstash (or any Redis) credentials exist; `MOS_REDIS_URL` is unset everywhere.
- MOS's Redis capability port is **advisory-only** (cache/locks). An empty `MOS_REDIS_URL` wires the documented degenerate adapters — transient coordination stays in PostgreSQL (queue authority is `postgresql` per `src/platform/config/config.ts` `describeConfig`).
- Consequence: no cross-instance rate limiting or lock coordination; the sign-up route's rate limit is per-instance/best-effort. This is recorded as a **known limitation** in the production acceptance record. Filling it is optional (a TARGET upgrade), not owed by any acceptance criterion.

### 2.5 AI provider — none configured (provider-neutral runtime ready)

`MOS_AI_PROVIDER` defaults to `none`: no AI provider adapter is wired in production. The AI runtime port is complete-or-absent exactly like S3. Documented so no later worker mistakes "no AI answers" for a defect.

## 3. Capability ports and why each provider satisfies the provider-selection rule

**Rule (DEPLOYMENT-MATRIX / AGENTS.md):** provider choice is implementation configuration; core/domain/application modules consume stable capability ports, never provider SDKs.

| Capability port | MOS port contract | Current provider | Why the rule holds |
|---|---|---|---|
| PostgreSQL (authoritative) | `src/platform/db` adapter boundary | Neon | `pg` is imported in exactly one platform adapter file (`src/platform/db/adapters/postgres/pg-db.ts`); domain/application modules see MOS's own port. The serverless bundle keeps `pg` external so behavior matches every integration test. |
| Object storage (artifacts) | `ObjectStore` port (`src/platform/objects/contract.ts`) | Cloudflare R2 | The S3 adapter is zero-SDK (own SigV4 signing); R2 is selected purely by `MOS_S3_*` configuration. Swapping to any S3-compatible provider is an env change. |
| Redis (OPTIONAL, transient) | advisory cache/lock adapters | absent → degenerate adapters | `MOS_REDIS_URL` empty is a first-class configuration, not an error; no code path can become Redis-dependent for correctness. |
| Web hosting / compute | none — hosting is outside domain modules | Vercel | The console bridge, sign-up orchestrator and drain route are transport/orchestration only; no authority logic lives on the host side. |
| AI runtime | provider adapter behind `ai-runtime` | none | Complete-or-absent config; tenant-scoped credentials stay under the `/credentials` authority. |

S3 configuration is **complete-or-absent** (choosing `MOS_OBJECT_STORE=s3` without every required setting fails startup), so a mis-configured production adapter cannot boot half-wired.

## 4. Hobby-plan limitations and the compensating patterns (CURRENT)

The Vercel **Hobby** plan imposes two hard limits that shape the production topology:

1. **Serverless function limit: 60 seconds.**
   - Every MOS-carrying route sets `maxDuration = 60` (bridge, sign-up, drain) and keeps its own work bounded: the drain route caps its internal budget at **45 000 ms** (hard constant `DRAIN_BUDGET_MS`) so a full drain pass plus cold boot stays inside the limit.
2. **Cron: once per day.**
   - `vercel.json` (workspace, to be mirrored into the repo pipeline) schedules exactly one cron: `GET /api/mos-admin/drain` daily at **03:00 UTC** with the `CRON_SECRET` bearer.
   - Because Hobby hosts no continuous worker process, the MOS job queue is drained **on demand**: any platform administrator can `POST /api/mos-admin/drain` (or the internal service token / cron secret can GET it). The drain is the serverless twin of `src/entrypoints/worker.ts --drain`, composed from the same worker pieces (WorkerHost, platform handlers, MKT-011 pooled runtime: relay → drain → recover, ≤10 passes, never past the budget).

**Documented consequences (honest):**

- Queue latency is human-scale, not continuous: jobs settle when someone drains (or at 03:00 UTC).
- `MOS_SECRETS_DIR=/tmp` is ephemeral per serverless instance (chosen serverless location); the file-backed secret store is re-created per instance. No durable secret material depends on it.
- No paid plan features (durable functions, more crons) may be assumed by any work item while the plan is Hobby.
- `dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA` is the current known-good production artifact; rollback constraints are in `DEPLOYMENT-PIPELINE.md` §7.

## 5. Provider boundary for later work items (TARGET)

- **DEP-002 (staging):** reproduce this provider set in an isolated staging shape (separate database/branch, separate bucket or prefix, isolated credentials, preview deployments built from the repository).
- **DEP-003 (production wiring):** move the production deployment from CLI-source to repository-source (preview from PRs, production from `main`) per `CONSOLE-SOURCE-RECONCILIATION.md` acceptance gate 8.
- **DEP-004 (CI/CD + rollback):** automate the pipeline in `DEPLOYMENT-PIPELINE.md` §3 and make rollback a one-command, known-good-artifact operation.
- **DEP-005 (observability/recovery):** verification window, log review, recovery drills — within Hobby limits.

A provider change (e.g. Neon → another PostgreSQL, R2 → another S3-compatible store, Vercel → another host, adding Redis) is **configuration work behind the existing ports**, not an architecture change. If a work item appears to require a provider SDK in a domain module, stop and escalate per `AGENTS.md`.

## 6. Fact provenance

- Provider identities/limits: worklog Tasks 81 (provisioning) and 82 (production acceptance); Vercel project/deployment/env-var facts re-verified read-only through the Vercel API at DEP-001 authoring time (deployment `dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA` READY, source `cli`; 16 production env-var **names** listed, values are write-only).
- Redis absence: Task 81 (no Upstash credentials provided; documented as limitation).
- Zero-SDK S3 and pg isolation: verified by direct source inspection of `src/platform/objects/adapters/s3/s3-object-store.ts` and `src/platform/db/adapters/postgres/pg-db.ts`.
- Hobby limits and drain design: production acceptance (Task 82) and the drain route implementation in the deployment workspace.
