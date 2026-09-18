# MOS Deployment Matrix — v1.5

This document records the intended environment contract for the remaining product-console program. It is a coordination artifact, not an architectural authority.

## Current Vercel deployment evidence

| Field | Verified value |
|---|---|
| Vercel project | `mos-product` |
| Project ID | `prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq` |
| Latest inspected deployment | `dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA` |
| State | READY |
| Framework | Next.js |
| Source mode | CLI |
| Production alias | `https://mos-product.vercel.app` |

The source mode is CLI and the frontend source is not currently in the MOS repository. This remains the source-of-truth blocker.

## Environment roles

### Development / local

- MOS API: repository source.
- Console: repository source after P0 recovery.
- PostgreSQL: provider adapter backed development database.
- Redis: transient coordination/cache only.
- Object storage: artifact storage only.
- Secrets: environment/credential boundary; never ordinary domain data.

### Preview / staging

- Vercel preview deployment built from the repository.
- Neon/PostgreSQL staging database.
- Redis staging instance for transient coordination.
- Object storage staging bucket.
- Isolated credentials and callback URLs.
- Seeded demo identities only where explicitly documented.

### Commercial production

- Vercel production plan appropriate for commercial workloads.
- Production PostgreSQL tier sized for the tenant/workload profile.
- Redis paid tier only for transient coordination/cache/rate control.
- Object storage provider with production backup/retention posture.
- Production secrets in the deployment/credential boundary.
- No infrastructure vendor identity encoded into Deployment domain semantics.

## Provider-selection rule

Provider choice is implementation configuration. Core/domain/application modules must consume stable capability ports rather than provider SDKs.

The product may use Vercel, Neon, Redis and object storage providers, but MOS architecture remains provider-independent.

## Production acceptance

Before production is declared reproducible:

1. Clean repository checkout installs successfully.
2. Backend and console builds succeed from repository source.
3. Database migrations apply from the repository.
4. Secrets/configuration are documented without revealing values.
5. Health checks pass.
6. Browser smoke suite passes against the repository-built deployment.
7. Client isolation and frontend-bypass tests pass.
8. Rollback is exercised against a known-good deployment artifact.
9. Runtime logs show no unexpected errors in the verification window.
10. Any environmental test limitation is disclosed with exact scope.

## Historical warning

An older MOS production deployment emitted:

`Cannot find package 'pg' imported from /var/task/mos-bundle/mos.mjs`.

A later verification window beginning 2026-09-14T21:00:00Z showed no runtime errors. Keep the failed artifact out of the default rollback set until repository-driven builds have been proven.
