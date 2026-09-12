# MOS — Successor Tech Lead Handoff

Repository: `payswapdotorg/MOS`
Architecture: v1.5 FROZEN
Role: successor LLM Tech Lead / implementation orchestrator

## Mission

Complete the live v1.4 backlog and then implement the v1.5 Operating Graph, Decision Ledger, Profit Intelligence and App Ecosystem. At most 3 implementation workers may run concurrently.

## Repository-first rule

Actual Git history, open PRs, source, migrations, tests and CI outrank this document or any prior report. Reconcile before scheduling.

## Current observed main

Latest observed main: `c6f79ec929722e2c76b55614cff44a5c15955b63`.
No open PRs were observed at the architecture-upgrade review.

Observed accepted/merged: MKT-001..MKT-023, MKT-025..MKT-027, MKT-030, MKT-031, MKT-035, MKT-036, plus MKT-009 correction. Reconcile the live DAG before dispatching.

Remaining v1.4 work must be recomputed from the actual repository; do not trust the old ledger's grouped PENDING row.

## v1.5 architectural rules

- MOS core authorities remain singular: Client/Workspace, Goal, Playbook, Deployment, Workflow, Task, Execution, Evidence, Experiment, Learning, Policy, Credential and Job.
- Operating Graph is a derived coordination model over canonical IDs.
- Decision Ledger is append-oriented and never rewrites history.
- Profit Intelligence is derived analytics, not financial authority.
- Client Operating Memory is a governed projection, not a second tenant store.
- Apps are versioned packages over Extensions/capabilities/UI/connectors/bounded app state.
- First-party and community Apps may reproduce incumbent capabilities such as reporting, analytics, CRM and spreadsheet workflows.
- App-owned state must be explicitly bounded and cannot shadow core authorities.
- App permissions are least-privilege, policy-gated and server-derived.
- App versions are immutable; upgrade/rollback changes future version selection only.
- App UI is presentation only.
- Deployment validates required App/Extension capabilities but does not execute workflows or own app state.

## Worker scheduling

READY means dependencies are accepted on current main and the expected file/authority surfaces are safe to integrate. One Work Item per worker. Recompute the DAG after every merge. Do not fill three slots merely for parallelism.

## Acceptance

Inspect changed files, authority boundaries, security/isolation, concurrency, migrations, real integrations, production wiring, actual test commands/results and honest environment limitations. Never accept from a worker report alone.

## v1.5 completion

MKT-041..MKT-052 must prove operating-graph/decision/profit lineage plus a first-party/community-style App lifecycle: publish → install → authorize → invoke → observe → upgrade/rollback, with tenant isolation and historical App Version preservation.
