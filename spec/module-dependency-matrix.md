# MarketingOS Module Dependency Matrix

**Architecture Version:** 1.1
**Status:** FROZEN

The arrows below are allowed dependency directions. A module may depend on a declared public contract of a downstream module only where listed. Direct imports of another module's `internal/` implementation are forbidden.

```text
/auth ──→ /users
/agencies ──→ /users, /auth
/clients ──→ /agencies, /auth
/workspaces ──→ /clients
/goals ──→ /clients, /workspaces
/playbooks ──→ /agencies, /clients, /goals
/workflows ──→ /workspaces, /goals, /playbooks, /executions, /policies, /audit
/executions ──→ /workspaces, /policies, /credentials, /audit
/agents ──→ /executions, /ai-runtime, /policies
/field-agents ──→ /users, /clients, /policies
/jobs ──→ /workflows, /executions, /field-agents, /clients, /evidence, /policies
/evidence ──→ /clients, /workspaces, /executions
/metrics ──→ /evidence, /integrations
/experiments ──→ /evidence, /metrics, /goals
/learnings ──→ /evidence, /experiments, /goals
/integrations ──→ /credentials, /policies
/extensions ──→ /executions, /policies, /credentials, /audit
/ai-runtime ──→ /executions, /policies, /credentials, /evidence
/policies ──→ /clients, /agencies
/credentials ──→ /auth, /policies
/audit ──→ /auth
/notifications ──→ /auth, /audit
/reporting ──→ /goals, /workflows, /executions, /evidence, /experiments, /metrics, /learnings
/operating-graph ──→ /clients, /workspaces, /goals, /playbooks, /workflows, /executions, /deployments, /evidence, /experiments, /learnings
/decisions ──→ /evidence, /experiments, /learnings, /executions, /deployments, /policies, /clients, /workspaces
/app-installs ──→ /apps, /policies, /workspaces, /extensions
/profit-intelligence ──→ /clients, /workspaces, /goals, /playbooks, /workflows, /executions, /deployments, /evidence, /metrics, /jobs, /field-agents, /ai-runtime, /integrations
/app-marketplace ──→ /apps
```

## Forbidden dependency directions

- `/ai-runtime` must not import a concrete provider SDK outside its adapter implementation.
- `/workflows` must not depend on a model/provider implementation.
- `/executions` must not select a business strategy or decide business success.
- `/evidence` must not mutate workflow/execution state.
- `/reporting` must never mutate authoritative domain state.
- `/operating-graph` is a derived coordination model over canonical authorities (read-only composition): it must never mutate authoritative domain state, must store only source references (canonical ids, kinds, versions and the scope chain — never shadowed authoritative shape), and must never become a second authority for any composed module.
- `/decisions` is the v1.5 append-oriented Decision Ledger authority (spec/architecture-v1.5.md §4; spec/change-request-005.md change #2). It consumes the listed public contracts READ-ONLY for write-time reference validation and canonical ownership resolution; `/policies` is the reserved direction for the MKT-045 consequential-action flow (deliberately unused by the ledger itself — recording a decision is unconditional, architecture-v1.5.md §7). The ledger never mutates historical execution, evidence, outcome or learning records (architecture-lock-v1.5.md rule #5).
- `/app-installs` is the v1.5 App installation authority (spec/mos-app-ecosystem-v1.5.md "Install and invoke", "Bounded app state", "Upgrade and rollback"; architecture-lock-v1.5.md rules #10/#11). It consumes the `/apps` registry public contract READ-ONLY (exact App Version resolution + the MKT-047 compatibility query — the registry is never mutated from here) and the `/policies` public contract for the fail-closed install/upgrade/rollback gate and the per-scope server-derived grant evaluations (every evaluation recorded by the engine); `/workspaces` and `/extensions` arrive through declared STRUCTURAL PORTS wired at the composition root (canonical workspace ownership; the workspace's authorized extension versions as the compatibility inputs). Installation is workspace-scoped and policy-gated; granted scopes are always SERVER-DERIVED (never caller-supplied); the install ledger is append-only with the single sanctioned selection-supersession transition — historical invocation records retain their original exact App Version identity (architecture-lock-v1.5.md rules #10/#11).
- `/profit-intelligence` is the v1.5 derived Profit Intelligence read model (spec/architecture-v1.5.md §5; architecture-lock-v1.5.md rule #6). It consumes the listed public contracts READ-ONLY through the /reporting live-aggregation precedent: every material figure is computed at read time with source references, the frozen calculation version and the explicit assumption set, and the module owns NO durable state (no profit_intelligence_* tables, no persisted projection). It can recommend but must never mutate contracts, billing or any financial/accounting authority — no mutation method over any authority may exist on its contract.
- `/extensions` must not mutate `/workflows` except through an authorized workflow command/port.
- `/app-marketplace` is the v1.5 App marketplace, trust and certification surface (spec/mos-app-ecosystem-v1.5.md "Trust levels" + "Manifest" + "Economics"). It consumes the `/apps` registry public contract READ-ONLY for every catalog fact (the listing, version history and exact-version resolution — the marketplace NEVER becomes a second registry: it owns no app catalog table, only the append-only trust_events governance ledger and the app_reviews display-metadata records). Trust transitions are append-only events with operator provenance — never registry rewrites (the registry's certification column stays frozen at birth); trust is METADATA and a policy input that never grants authority by itself. The MKT-048 install gate consumes the marketplace-derived trust state through a STRUCTURAL PORT declared in `/app-installs`'s public entry and wired at the composition root (the `/policies`→`/credentials` port precedent — deliberately off-matrix, disclosed); reviews are display metadata no policy consumes. Marketplace attribution stays separate from the core financial authority (metering/attribution is later Work Item territory).
- No module imports another module's database repository implementation directly unless the matrix explicitly names that authority boundary and the imported symbol is part of its public contract.

## Composition root

Provider SDKs, concrete queue/storage clients, sandbox drivers, browser drivers and external integration adapters are wired at the composition root. Domain/application modules depend on provider-neutral contracts.
