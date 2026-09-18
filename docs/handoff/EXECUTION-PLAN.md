# MOS — Successor Tech Lead Execution Plan v1.5

**Architecture:** v1.5 FROZEN  
**Backend/platform state:** MKT-001..MKT-052 ACCEPTED/MERGED  
**Maximum concurrent workers:** 3  
**Primary remaining program:** Product Console + Deployment Reproducibility + Final E2E

## Mandatory scheduling rule

Read `AGENTS.md`, `docs/product/PRODUCT-CONSOLE-V1.5.md`, `docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md`, and the current `IMPLEMENTATION-STATE.md` first.

A console Work Item is not READY until its source tree exists in `payswapdotorg/MOS`.

Recompute readiness after every accepted merge.

## Work graph

```text
P0 Console Source Recovery
        │
        ├── UI-002 Shell
        │      ├── UI-003 Today
        │      ├── UI-004 Client Workspace
        │      └── UI-005 Work / Deployment / Experiment
        │               └── UI-006 Sales / Human / Apps
        │
        └── UX-E2E harness adaptation

DEP-001 Provider/Environment Contract
        ├── DEP-002 Staging
        └── DEP-003 Production
                ├── DEP-004 CI/CD + migrations + rollback
                └── DEP-005 Observability + recovery

UI-003 + UI-004 + UI-005 + UI-006 + DEP-003
        └── UX-E2E final proof
```

## Worker lanes

### Worker A — Console ownership

**First assignment:** P0 Console Source Recovery.

After source recovery is accepted:

1. UI-002 Shell.
2. UI-003 Today.
3. UI-004 Client Workspace.
4. UI-005 Work/Deployment/Experiment.
5. UI-006 Sales/Human/Apps.

Worker A owns recovered frontend source and user journey presentation. It must never create backend authority.

### Worker B — Deployment ownership

Start only on surfaces independent of the missing source:

1. DEP-001 provider/environment contract.
2. DEP-002 staging and preview reproducibility.
3. DEP-003 production wiring.
4. DEP-004 CI/CD and rollback.
5. DEP-005 observability/cost/recovery.

All cloud vendor choices remain behind existing provider capability boundaries.

### Worker C — Verification ownership

While source recovery is underway:

1. Build the browser/E2E harness contract.
2. Establish API-backed smoke journeys against the current live console.
3. Define tenant-isolation/bypass checks.
4. Once source exists, bind the harness to the repository-built preview.
5. Execute UX-E2E owner/client/human/sales/app journeys.

Worker C does not create a second application implementation to work around missing frontend source.

## Parallelism guard

Safe concurrency is based on ownership, not calendar sequencing.

- Worker A and B may proceed concurrently once A is performing source recovery and B is touching deployment configuration outside A's source root.
- Worker C may proceed concurrently with API/browser harness work that does not modify A's frontend source.
- UI-002 and downstream UI work must not start before P0 source recovery.
- Do not allow multiple workers to modify composition roots, shared route registries or deployment manifests simultaneously.

## Final proof

The Tech Lead must independently verify:

1. `npm run lint` for the backend and the console's actual lint command.
2. `npm run typecheck` for the backend and the console's actual typecheck command.
3. `npm run arch:check`.
4. Complete unit/architecture/integration suites for the backend.
5. Console unit/component/browser suites.
6. Goal → Evidence → Hypothesis → Playbook → Deployment → Workflow → Task → Execution → Outcome → Decision → Learning.
7. Incumbent App lifecycle: discover → install → invoke → upgrade → rollback.
8. Client isolation and frontend bypass.
9. Preview/staging/production deployment reproducibility.
10. Runtime errors/health in the final production window.
