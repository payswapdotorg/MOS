# MOS v1.6 Deployment Plan — Free-Tier-Aware, Production-Reproducible

Status: IMPLEMENTATION PLAN
Audit date: 2026-09-21

## 1. Verified current deployment

- Vercel project: mos-product
- Project id: prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq
- Team: ekonplacidegmailcoms-projects
- Production deployment: dpl_7wEndfiEdUsC38e2ttam2sjmMFdg
- Production URL: https://mos-product.vercel.app
- Source: Git
- State: READY
- Production commit: c6a35db9709cf0b343221952f724bc52cd7ddd4f
- Selected 24h Vercel runtime-error query: no runtime errors.

The accepted implementation baseline 1ef58f86afa0220a7fd546ad03c84bfb82e4656b is an ancestor of current production. Production therefore already contains the accepted v1.6 implementation baseline.

## 2. Provider/account truth

Confirmed current production provider:
- Vercel

Not established from available account/repository metadata:
- exact Vercel billing plan;
- production Postgres provider/account;
- production object-storage provider;
- production Redis provider;
- production research provider.

The repository .env.example still describes generic PostgreSQL plus filesystem object storage. Never infer a managed provider from variable names.

## 3. Free-tier answer

YES: the confirmed production provider, Vercel, offers a free $0 Hobby plan.

NOT VERIFIED: MOS's actual Vercel billing tier. Project/deployment metadata available here does not expose that account billing state.

Also, Vercel describes Hobby as intended for personal/non-commercial use. The Tech Lead must verify that eligibility before treating Hobby as a production/commercial target.

Neon Free, Cloudflare R2, Upstash Free, Apify Free and Render Free are NOT current MOS production dependencies based on repository/deployment evidence. They are candidates for an explicitly labeled demo/staging topology.

## 4. Recommended demo/staging topology

Browser
  |
  v
Vercel Hobby (console + short-lived API bridge, only if eligible)
  |
  +--> Neon Free Postgres
  +--> Cloudflare R2 Free object storage
  +--> Upstash Free Redis
  +--> Render Free worker
  +--> Apify Free research capacity
  +--> social / commerce / notification providers
  |
  +--> GitHub Actions CI

Rules:
- PostgreSQL is the MOS system of record.
- R2 stores immutable/content-addressed media artifacts only.
- Redis is ephemeral coordination/rate limiting/locks only.
- Apify is a research execution provider, never a domain authority.
- src/entrypoints/worker.ts runs outside Vercel request handling.
- Every provider operation remains tenant-scoped, policy-gated, budgeted and idempotent where required.
- Render Free is demo/staging only; do not depend on it for business-critical production.

## 5. Current free-tier reference points

Verify again in the actual accounts before deployment because provider limits can change:

- Vercel Hobby: $0/month; Hobby has a once-per-day Cron limitation and is intended for personal/non-commercial use.
- Neon Free: current free plan exists; use the account's live quota view as the authority.
- Cloudflare R2 Free: 10 GB-month standard storage, 1M Class A requests/month, 10M Class B requests/month, free egress.
- Upstash Redis Free: 256 MB data, 10 GB monthly bandwidth, 500K commands/month.
- Apify Free: $5 monthly platform/store spend; compute is metered.
- Render Free: suitable for testing/hobby/preview, not production.

## 6. Work orders

### DEP-006 — Deployment contract
Document console/API/worker processes, Node 24, env contract, health/readiness, migration command, startup ordering and rollback.

### DEP-007 — Actual production Postgres
Verify the real account/provider first; record plan/region, direct migration vs pooled app connectivity, backups/restore and staging isolation.

### DEP-008 — Object storage
Implement content-addressed immutable objects, signed/private access, lifecycle/retention and deterministic metadata. Candidate: Cloudflare R2.

### DEP-009 — Async worker
Run src/entrypoints/worker.ts on a persistent/restartable worker service. Prove startup ordering, durable pickup, lease/claim behavior, bounded retries, restart convergence and graceful shutdown.

### DEP-010 — Redis
Candidate Upstash for transient locks, rate limits and ephemeral coordination only. Never move canonical mission/execution/evidence/experiment/commerce state into Redis.

### DEP-011 — Research execution
Provider-neutral research port; candidate Apify. Every material source fact must preserve provenance, policy/budget status, retry/idempotency and partial/blocked state.

### DEP-012 — Budget/quota
Guard social API quotas, research spend, AI/compute, storage/bandwidth, paid media, commerce tests and human-review capacity. Fail closed with truthful capacity/budget state.

### DEP-013 — Promotion
CI → preview → migration verification → browser smoke → Tech Lead acceptance → production → health query → browser smoke → rollback-ready.

### DEP-014 — Retention/cost
Set retention for deployments, evidence/events, objects, research artifacts and transient queues. Alert before free-tier limits become outages.

### DEP-015 — Every new implementation baseline
Verify ancestry, CI, preview, migrations, browser journeys, production SHA, provider state and rollback candidate before promotion.

## 7. Scheduling constraint

Do not use Vercel Hobby Cron as the Growth Operator scheduler. Its cadence is too sparse for the persistent mission controller. Use the external worker/runtime path.

## 8. Upgrade triggers

Move off demo/free tiers when worker uptime/recovery is business-critical, database/object/Redis limits are approached, research credits are routinely consumed, social API tiers become paid requirements, or commercial use makes Hobby ineligible.
