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
```

## Forbidden dependency directions

- `/ai-runtime` must not import a concrete provider SDK outside its adapter implementation.
- `/workflows` must not depend on a model/provider implementation.
- `/executions` must not select a business strategy or decide business success.
- `/evidence` must not mutate workflow/execution state.
- `/reporting` must never mutate authoritative domain state.
- `/operating-graph` is a derived coordination model over canonical authorities (read-only composition): it must never mutate authoritative domain state, must store only source references (canonical ids, kinds, versions and the scope chain — never shadowed authoritative shape), and must never become a second authority for any composed module.
- `/extensions` must not mutate `/workflows` except through an authorized workflow command/port.
- No module imports another module's database repository implementation directly unless the matrix explicitly names that authority boundary and the imported symbol is part of its public contract.

## Composition root

Provider SDKs, concrete queue/storage clients, sandbox drivers, browser drivers and external integration adapters are wired at the composition root. Domain/application modules depend on provider-neutral contracts.
