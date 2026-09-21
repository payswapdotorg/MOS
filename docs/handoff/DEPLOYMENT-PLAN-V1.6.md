# MOS v1.6 Deployment Plan — Free-Tier-Aware, Production-Reproducible

Status: IMPLEMENTATION PLAN
Audit date: 2026-09-21

## 1. Current deployment truth

Vercel project: mos-product
Project id: prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq

Current production:
- deployment: dpl_7wEndfiEdUsC38e2ttam2sjmMFdg
- alias: https://mos-product.vercel.app
- source: Git
- state: READY
- commit: c6a35db9709cf0b343221952f724bc52cd7ddd4f

Accepted implementation baseline:
- commit: 1ef58f86afa0220a7fd546ad03c84bfb82e4656b
- production is 5 implementation commits behind this baseline

Current main handoff head:
- commit: 34cb2d4b78c2291f8602ec964b80c2b1a2acaa7b
- commits after the implementation baseline are documentation/handoff only

A separate MKT-064 preview deployment is READY and is not production.

## 2. Provider facts

Confirmed deployed provider:
- Vercel

Not proven from repository/deployment metadata:
- exact Vercel billing tier;
- production Postgres provider;
- Upstash;
- Cloudflare R2;
- Apify;
- Render.

The repository .env.example still describes generic PostgreSQL and local filesystem object storage.

Do not mark a provider as currently deployed until the Tech Lead verifies its production account, environment and billing state.

## 3. Free-tier target mode

For low-volume demo/staging:
- Vercel Hobby for console/API;
- Neon Free as a candidate managed Postgres target, only after production-account verification;
- Cloudflare R2 for content objects;
- Upstash Redis for bounded ephemeral coordination;
- Render Free worker for demo/staging only;
- Apify Free for tightly budgeted research;
- GitHub Actions for CI.

These are targets, not current production dependencies.

## 4. Deployment topology

Browser
  |
  v
Vercel / mos-product
  |
  +-- Next.js console
  +-- short-lived API request handling
  |
  +-- Managed PostgreSQL
  +-- Object storage
  +-- Optional Redis
  +-- social / commerce / research / notification providers

Async execution:
src/entrypoints/worker.ts must run outside synchronous Vercel request handling.

PostgreSQL remains MOS system of record. Redis/object storage remain infrastructure, never domain authorities.

## 5. Work orders

DEP-006 Repository deployment contract
DEP-007 Production PostgreSQL verification
DEP-008 Object storage adapter
DEP-009 Worker deployment
DEP-010 Redis capability
DEP-011 Research execution
DEP-012 Cost/quota guard
DEP-013 Production promotion pipeline
DEP-014 Cost/retention hygiene
DEP-015 Promote accepted main implementation baseline

DEP-015 must verify:
CI -> preview -> migration check -> browser smoke -> Tech Lead acceptance -> production -> health -> browser smoke -> rollback readiness.

## 6. Free-tier constraints

Vercel Hobby is $0, but Hobby Cron is once-per-day, so Growth Operator must not depend on Vercel Cron as its autonomous scheduler.

Neon Free currently provides a zero-cost Postgres option for early-stage/demo workloads, but exact current account limits must be verified when the provider is selected.

Upstash Free currently provides 256 MB, 10 GB monthly bandwidth and 500K commands/month.

Cloudflare R2 Free currently provides 10 GB-month standard storage, 1M Class A requests, 10M Class B requests and free egress.

Apify Free currently includes $5 of platform/store spend with metered compute.

Render Free can host background-worker workloads, but Render documents Free instances as testing/hobby/preview rather than production.

## 7. Upgrade triggers

Upgrade when worker capacity is unreliable, database/object/Redis limits are approached, research spend exceeds mission policy, autonomous scheduling requires more than Hobby Cron allows, or uptime/recovery becomes business-critical.
