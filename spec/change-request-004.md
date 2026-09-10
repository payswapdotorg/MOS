# Architecture Change Request 004 — Marketing Cloud Deployment

**Status:** FROZEN
**Effective Architecture:** v1.4

## Change

Introduce a first-class Marketing Cloud Deployment control-plane authority that binds authorized Client Workspaces to immutable Playbook/Workflow versions and manages validation, activation, pause/resume, redeploy and rollback.

## Explicit boundaries

- Deployment owns deployment intent, dependency resolution, validation, activation state and deployment history.
- Deployment does not own Workflow, Task or Execution state.
- Deployment may request workflow execution but cannot mutate Workflow/Execution lifecycle directly.
- Redeploy/rollback selects future immutable versions and never rewrites historical Executions, Outcomes, Evidence or Learnings.
- Runtime allocation remains under Execution/Runtime policy; deployment semantics must not encode vendor infrastructure identity.
- Persistent Sandboxes remain Workspace/Client-scoped and Sandbox Leases remain Execution-scoped.

## Requirements added

`DEPLOY-002` as defined by `spec/requirements-v1.4.md`.

## Acceptance authority

`DEPLOY-AC-03..09` in `spec/requirements-v1.4.md` and the full contract in `spec/marketing-cloud-deployment-v1.4.md`.

## Non-changes

This change does not authorize a new Workflow engine, Execution engine, Evidence authority, AI router, Policy authority, Credential authority or provider-specific runtime authority.
