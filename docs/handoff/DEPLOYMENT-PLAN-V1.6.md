# MOS v1.6 Deployment Plan — Free-Tier-Aware, Production-Reproducible

Status: IMPLEMENTATION PLAN
Date: 2026-09-21

## 1. Confirmed current deployment

- Vercel project: mos-product
- Project id: prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq
- Current inspected production deployment: dpl_BwaJi8ho6QDaVq1RUjghezULAXn8
- Production alias: https://mos-product.vercel.app
- Deployment source: Git
- Current inspected production commit: c2c67e31ae814ceba09137348fb8b92d205d638c
- Deployment status: READY
- A recent 24-hour production query returned no HTTP 5xx runtime logs.

## 2. What is not yet proven

The current repository and available deployment metadata do not prove that production currently uses:

- Neon
- Upstash
- Cloudflare R2
- Apify
- Render

The repository environment example still uses a generic PostgreSQL URL and local filesystem object storage.

Therefore the handoff must distinguish:
confirmed deployment facts
from
recommended provider targets.

## 3. Free-tier-aware topology

Primary production target:

Browser
  |
  v
Vercel - mos-product
  |
  +-- Next.js console
  +-- API bridge / short-lived request handling
  |
  +-- managed PostgreSQL
  +-- object storage
  +-- optional Redis/queue infrastructure
  +-- social / commerce / research / notification providers

The current PostgreSQL abstraction remains the MOS system of record.

Object storage and Redis must remain infrastructure behind existing ports, never new domain authorities.

## 4. Provider facts relevant to the plan

Vercel Hobby is a zero-dollar tier. Hobby Cron is currently limited to once-per-day schedules, so the autonomous Growth Operator must not depend on Vercel Cron frequency.

Upstash Redis Free is zero dollars with 256 MB data, 10 GB monthly bandwidth and 500K monthly commands.

Cloudflare R2 Free currently includes 10 GB-month storage, 1 million Class A requests, 10 million Class B requests and free egress.

Cloudflare Workers Free currently allows 100,000 requests/day but only 10 ms CPU time per invocation, so it is suitable for lightweight control-plane work rather than moving the current Node worker wholesale.

Apify Free currently gives 5 dollars of platform/store spend and metered Actor compute, so research workloads need hard mission/provider budgets.

Render offers free compute and background-worker-capable services, but its documentation explicitly says Free instances are for testing/hobby/preview and not production applications.

GitHub Actions standard runners are free for public repositories and have an included monthly allowance for private Free accounts.

## 5. Deployment work orders

### DEP-006 — Repository deployment contract

Create one repository-owned deployment manifest for:

- console build;
- API packaging;
- worker packaging;
- Node 24 runtime;
- environment variables;
- migration command;
- health checks;
- rollback target;
- provider capability requirements.

### DEP-007 — Managed PostgreSQL

Verify the existing production provider first.

Document:

- provider;
- account plan;
- pooled/direct connection;
- migration process;
- backups/recovery;
- staging/preview separation;
- connection limits;
- free-tier limits;
- upgrade trigger.

Only then standardize the provider.

### DEP-008 — Production object storage

Implement a real adapter behind the existing object-storage port.

Preferred target: Cloudflare R2.

Requirements:

- content-addressed keys;
- immutable Content Asset objects;
- private/signed access where required;
- retention/revocation metadata;
- storage/egress observation;
- filesystem implementation retained for tests.

### DEP-009 — Asynchronous worker deployment

Deploy src/entrypoints/worker.ts outside the Vercel request path.

Acceptance:

- durable work pickup;
- restart-safe processing;
- bounded retries;
- graceful shutdown;
- lease/singleton semantics;
- health/metrics;
- no Vercel-Cron dependency for autonomous operation.

### DEP-010 — Redis capability

Use Upstash only for bounded ephemeral concerns where the implementation actually benefits from it:

- distributed locks;
- rate-limit counters;
- short-lived coordination;
- optional transient queue support.

Canonical mission/job/evidence state stays in PostgreSQL.

### DEP-011 — Research execution

If MKT-062 uses an external extraction provider, implement the adapter behind the Research boundary.

Target candidate: Apify.

Acceptance:

- source provenance;
- actor/runtime timeout;
- retries;
- per-mission quota;
- hard spend budget;
- no silent conversion of unverified results into evidence-backed claims.

### DEP-012 — Free-tier budget guard

Track provider quota/budget observations.

Fail closed when:

- quota exhausted;
- provider unavailable;
- spend exceeds mission/provider cap;
- worker capacity exhausted.

Surface an honest capacity/budget-constrained state.

### DEP-013 — Production promotion

PR
 -> CI
 -> preview
 -> browser smoke
 -> migration check
 -> Tech Lead acceptance
 -> production deploy
 -> health check
 -> browser smoke
 -> rollback-ready

Persist deployment Git SHA, migration state, provider capability versions and health result.

### DEP-014 — Deployment retention/cost hygiene

Monitor Vercel deployment storage and remove unnecessary duplicate previews/artifacts. Current Vercel Hobby retention behavior reduces old deployment retention and can block deployment storage when the account exceeds its allowance.

## 6. Free-tier demo/staging mode

A practical low-volume mode is:

- Vercel Hobby for console/API;
- Render Free background worker for demo/staging only;
- Cloudflare R2 Free for object storage;
- Upstash Free for bounded ephemeral coordination;
- Apify Free for tightly budgeted research;
- GitHub Actions for CI and maintenance.

The Tech Lead must label this environment demo/staging, not silently call it production-grade.

## 7. Production upgrade triggers

Upgrade the affected provider when:

- worker requires uninterrupted capacity;
- database limits are approached;
- object storage/request limits are approached;
- Redis limits are approached;
- research spend exceeds policy;
- Vercel Cron frequency is insufficient;
- uptime/recovery becomes business-critical.
