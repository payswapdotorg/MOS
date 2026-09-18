# MOS — Final Successor Tech Lead Handoff

**Repository:** `payswapdotorg/MOS`  
**Architecture:** **v1.5 FROZEN**  
**Canonical main at final audit baseline:** `2e071d0c313b5dc9fa634fc90ade894bcd2754f0`  
**Open PRs at audit:** none  
**Maximum concurrent implementation workers:** 3

## Mission

Take MOS from **v1.5 backend/platform complete** to **product-console and deployment complete**.

Do not redesign the frozen architecture. MKT-001..MKT-052 are accepted/merged. The remaining implementation work is presentation, repository/source reconciliation, reproducible deployment and final E2E proof.

## 1. Repository-first truth

The repository is the source of truth.

Do not trust:

- prior handoffs;
- worker reports;
- screenshots;
- stale test counts;
- Vercel deployment state as source code;
- compiled Next.js bundles as frontend source;
- external local workspaces.

At takeover, inspect:

```bash
git status
git log --oneline --decorate -30
git branch -a
```

Then reconcile:

- `README.md`
- `AGENTS.md`
- `spec/frozen-manifest-v1.5.json`
- `spec/architecture-v1.5.md`
- `spec/architecture-lock-v1.5.md`
- `spec/change-request-005.md`
- `spec/mos-app-ecosystem-v1.5.md`
- `spec/operating-graph-v1.5.md`
- `spec/effective-backlog-v1.5.md`
- `docs/product/PRODUCT-CONSOLE-V1.5.md`
- `docs/handoff/IMPLEMENTATION-STATE.md`
- `docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md`
- `docs/handoff/EXECUTION-PLAN.md`
- `docs/handoff/WORKER-CONTRACT.md`

Also inspect source, migrations, tests, CI, PRs and deployment configuration directly.

## 2. Verified v1.5 backend/platform state

MKT-001..MKT-052 are accepted/merged on `main`.

v1.5 includes:

- Agency Operating Graph.
- Decision Ledger.
- Profit Intelligence.
- Client Operating Memory.
- AI Operator / Attention Queue.
- Sales-to-Delivery Continuity.
- Versioned App Ecosystem.
- App install/upgrade/rollback.
- Developer Portal.
- Marketplace/trust/certification.
- First-party incumbent-capability packs.
- App metering/attribution.
- MKT-040 deployment capability-version validation amendment.

Do not dispatch a Worker to reimplement any of these authorities.

## 3. Critical takeover finding — console source

There is a real user-facing Next.js MOS console deployed as Vercel project:

- Project: `mos-product`
- Project ID: `prj_0OE49bIy6w1MAU1FWOHr6XeQ6xYq`
- Latest inspected production deployment: `dpl_Ggjek4trEkcAMa9WN2AB2DVwBSAA`
- Deployment status: READY
- Production alias: `https://mos-product.vercel.app`
- Vercel source mode: CLI

GitHub inspection found no matching console frontend source in `payswapdotorg/MOS`.

This is a **P0 source-of-truth defect**.

### Required resolution

Recover the original source workspace that produced the CLI deployment and commit the real console source into this repository.

Do **not** reconstruct the source from minified/static `/_next/static` bundles.

Do **not** mark product completion until:

- source is committed;
- source has deterministic build/test commands;
- console builds from clean main;
- preview deployment is generated from repo source;
- production deployment is connected to that repository source path or an explicitly documented repository-driven CI path.

The detailed gate is `docs/handoff/CONSOLE-SOURCE-RECONCILIATION.md`.

## 4. Product UX target

Primary navigation:

**Today → Clients → Work → Apps → Admin**

This is intentional. Architecture objects remain contextual rather than becoming nine or fifteen primary nav items.

### Today

Answer:

> What needs attention, what can create/save money, and what should I do next?

Use:

- AI Operator.
- Profit Intelligence.
- client risks.
- blocked work.
- approvals.
- experiments needing decisions.
- revenue opportunities.

### Client

Use progressive disclosure:

**Today**
→ What happened / What matters / What MOS recommends

**Operating**
→ Goals / Strategy / Workflows / Deployments

**Intelligence**
→ Evidence / Experiments / Decisions / Learning / Memory

**Trace**
→ Goal → Evidence → Hypothesis → Playbook → Workflow → Execution → Outcome → Decision → Learning

### Work

Human Work should feel like a queue.

Workflow/Execution should feel like a timeline.

Deployment should feel like:

**Configure → Validate → Deploy → Observe → Pause/Resume → Redeploy/Rollback**

Experimentation becomes an explicit **Experiment Lab**.

### Apps

**Installed / Marketplace / First-party / Developer Portal**

App Version, trust, permission, upgrade and rollback state must be visible.

### Admin

Keep platform/agency administration away from the ordinary daily operating flow.

## 5. UX principles

Keep the existing Geist/shadcn foundation and move toward a calm professional operating environment:

- restrained surfaces/borders;
- clear active states;
- one obvious primary action;
- progressive disclosure;
- responsive desktop/mobile;
- status color only when meaningful.

Avoid:

- architecture diagrams as primary UX;
- giant metric-card dashboards;
- glassmorphism/gradient-heavy presentation;
- database-object navigation;
- technical identifiers in normal agency copy.

## 6. Three-worker orchestration

### Worker A — Console

First:

**P0 Console Source Recovery**

Then, after source reconciliation:

**UI-002 → UI-003 → UI-004 → UI-005 → UI-006**

Worker A owns frontend source and presentation journeys.

### Worker B — Deployment

Can work independently where safe:

**DEP-001 → DEP-002 → DEP-003 → DEP-004 → DEP-005**

Worker B owns reproducible environment/deployment wiring.

### Worker C — Verification

While A recovers source:

- browser/E2E harness;
- live API-backed smoke journeys;
- client-isolation/bypass checks.

After A has repository-owned source:

- bind browser tests to repository-built preview;
- execute owner/client/human/sales/app journeys;
- final regression/security/responsive checks.

## 7. Dependency rules

- Do not start UI implementation before console source exists in MOS.
- Do not create alternate API/mocks just to unblock UI.
- Do not let two Workers modify the same deployment manifest, composition root, route registry or frontend shell simultaneously.
- Recompute readiness after every merge.
- A Worker slot is free only after accepted/merged or explicitly stopped.
- Do not fill all three slots merely for parallelism.

## 8. Non-negotiable architectural invariants

- PostgreSQL is authoritative for durable MOS state.
- Client isolation is enforced server-side before dependent traversal.
- Workflow is the only workflow authority.
- Execution is the only execution authority.
- Deployment is the only deployment lifecycle authority.
- Evidence/provenance remains server-owned.
- Profit Intelligence is derived and read-only.
- Decision Ledger is append-oriented and never rewrites history.
- Operating Graph is derived/contextual and not a replacement authority.
- AI Operator ranks attention; consequential actions use existing policy/approval contracts.
- Apps are composition packages; they cannot become CRM/reporting/workflow/tenant authorities.
- App UI is presentation-only.
- Published App Versions are immutable.
- Upgrade/rollback affects future selection only.
- UNKNOWN execution outcomes are unresolved and are never treated as success.
- Provider SDKs remain behind provider adapters/capability contracts.

## 9. Definition of done

Do not declare the product complete until all are true:

### Source of truth
- [ ] Console source is present in MOS.
- [ ] Console builds from clean repo.
- [ ] Console tests run from repo.
- [ ] Vercel deployment is repository-driven.

### Core UX
- [ ] Today / Clients / Work / Apps / Admin.
- [ ] Command Center next-action hierarchy.
- [ ] Client Operating Workspace.
- [ ] Operating Graph trace.
- [ ] Decision Ledger visible at agency/client context.
- [ ] Profit Intelligence actionable.
- [ ] Experiment Lab.
- [ ] Workflow/Execution timeline.
- [ ] Deployment Center.
- [ ] Human Work queue.
- [ ] Sales → Delivery continuity.
- [ ] App Marketplace/Installed/Developer Portal.
- [ ] Client Portal contextual entry.

### Verification
- [ ] Owner/operator journey.
- [ ] Client journey.
- [ ] Human-agent journey.
- [ ] Sales-to-delivery journey.
- [ ] App install/upgrade/rollback journey.
- [ ] Cross-client isolation.
- [ ] Frontend-bypass security tests.
- [ ] Responsive/mobile checks.
- [ ] Backend lint/typecheck/arch/unit/architecture/integration gates.
- [ ] Console lint/typecheck/build/component/browser gates.
- [ ] Production health verification.
- [ ] Exact limitations disclosed.

## 10. Known production note

An older Vercel deployment emitted:

`Cannot find package 'pg' imported from /var/task/mos-bundle/mos.mjs`.

No runtime errors were found in the separately inspected window beginning 2026-09-14T21:00:00Z through the audit time.

Keep the historical failure documented because a future rollback to that old artifact could reintroduce it.

## 11. Immediate takeover action

The Tech Lead's first report must contain only:

1. actual current main SHA;
2. open PRs;
3. confirmation MKT-001..MKT-052 are still present on current main;
4. console source location (or explicit P0 recovery status);
5. deployment/config source location;
6. current READY set;
7. Worker A/B/C assignments;
8. blockers.

Do not redesign the architecture and do not reopen completed Work Items.

## 12. Final completion proof

The end state must demonstrate:

```
Prospect
 → Client
 → Goal
 → Strategy/Hypothesis
 → Playbook
 → Deployment
 → Workflow
 → Task
 → Human / AI / App
 → Execution
 → Evidence
 → Outcome
 → Revenue / Cost / Margin
 → Decision
 → Learning
 → next action / deployment
```

The frontend is the human presentation layer over this chain. It is not another system of record.
