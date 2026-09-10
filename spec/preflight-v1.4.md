# Implementation Preflight — v1.4

**Status:** FROZEN

Before implementing or accepting v1.4 work, confirm:

- `spec/frozen-manifest.json` identifies Architecture 1.4 and lists the effective v1.4 contracts.
- `spec/frozen-manifest-v1.4.json` is present and valid JSON.
- `spec/architecture-lock-v1.4.md` is treated as authoritative for the v1.4 Deployment and Sandbox corrections.
- Marketing Cloud Deployment is the single deployment control-plane authority.
- Deployment binds authorized Client Workspaces to immutable Playbook/Workflow versions.
- Deployment cannot mutate Workflow/Execution lifecycle directly or become a second retry/orchestration engine.
- Redeploy/rollback never rewrites historical Execution, Outcome, Evidence or Learning records.
- Persistent Sandbox identity is Workspace/Client-scoped and Sandbox Lease identity is Execution-scoped.
- Human Agents, Domain Packs and Creator Operations use the common Job/Task/Execution/Evidence/Policy/AI authorities.
- Provider-specific creator APIs, SDKs, scraping and browser automation remain adapters/extensions.
- Client ownership is resolved before dependent traversal or external access.
- AI remains a replaceable reasoning layer; hard eligibility precedes ranking.
- External UNKNOWN outcomes remain unresolved and require reconciliation.
- Every material side effect has the required idempotency/recovery contract.
- Evidence/provenance, attribution and causality remain distinct.
- No Work Item may require an architecture change hidden inside implementation convenience.

If any preflight condition fails, stop the affected Work Item and perform architecture reconciliation before changing frozen contracts.
