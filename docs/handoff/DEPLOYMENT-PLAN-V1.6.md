# MOS v1.6 Deployment Plan — Free-Tier-Aware, Production-Reproducible

Status: IMPLEMENTATION PLAN
Audit date: 2026-09-21

## 1. Current deployment truth

Vercel project: mos-product
Project id: prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq

Current production:
- deployment: dpl_8vG4jZrXaRNnMyAhdLc8J4JQJLaB
- alias: https://mos-product.vercel.app
- source: Git
- state: READY
- commit: 039743a6e31f792c44d0fc646d3dcb53843730b1

Current main:
- commit: 1ef58f86afa0220a7fd546ad03c84bfb82e4656b

Main is five commits ahead of production. The delta is the MKT-064 content-assets delivery plus reconciliation/runbook/worklog changes.

A separate MKT-064 preview deployment is READY and is not production.

## 2. Provider facts

Confirmed deployed provider:
- Vercel.

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

### DEP-006 — Repository deployment contract
Document console/API/worker packaging, Node 24, environment contract, migrations, health checks, rollback and provider capabilities.

### DEP-007 — Production PostgreSQL verification
Identify actual provider, plan, pooling/direct mode, backup/recovery, preview isolation, limits and upgrade triggers.

### DEP-008 — Object storage
Implement production adapter behind existing object-storage contract. Target Cloudflare R2. Preserve filesystem for tests.

### DEP-009 — Worker deployment
Deploy the Node worker outside Vercel request handling with durable pickup, bounded retries, graceful shutdown, lease/singleton semantics, health and restart proof.

### DEP-010 — Redis
Use Upstash only for actual ephemeral primitives. Never move mission/job/evidence authority out of PostgreSQL.

### DEP-011 — Research execution
When MKT-062 requires external extraction, use the Research boundary. Apify is a candidate, not a current dependency.

### DEP-012 — Cost/quota guard
Persist quota/spend/capacity constraints and fail closed.

### DEP-013 — Promotion pipeline
PR -> CI -> preview -> browser smoke -> migration check -> Tech Lead acceptance -> production -> health -> browser smoke -> rollback-ready.

### DEP-014 — Cost/retention hygiene
Monitor Vercel deployment storage and unnecessary preview retention.

### DEP-015 — Promote accepted main
After MKT-064 is accepted:
1. verify main CI;
2. deploy main;
3. run production health;
4. run browser smoke;
5. compare runtime-error baseline;
6. record deployed SHA;
7. retain rollback target.

## 6. Free-tier constraints affecting architecture

Vercel Hobby is $0, but Hobby Cron runs no more than once per day; the Growth Operator must not depend on Vercel Cron as its autonomous scheduler.

Upstash Free currently provides 256 MB, 10 GB monthly bandwidth and 500K commands/month.

Cloudflare R2 Free currently provides 10 GB-month standard storage, 1M Class A requests, 10M Class B requests and free egress.

Apify Free currently includes $5 of platform/store spend with metered compute.

Render Free can host background workers, but Render says free instances are for testing/hobby/preview rather than production.

## 7. Upgrade triggers

Upgrade the affected provider when:
- worker capacity becomes unreliable;
- database/object limits are approached;
- Redis limits are approached;
- research spend exceeds mission policy;
- autonomous scheduling needs more than Hobby Cron permits;
- uptime/recovery becomes business-critical.
