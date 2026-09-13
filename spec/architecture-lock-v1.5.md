# MOS Architecture Lock — v1.5

Status: FROZEN

1. MOS v1.5 supersedes v1.4 only where the v1.5 change request explicitly adds or alters behavior.
2. Deployment remains the sole deployment lifecycle authority.
3. Workflow, Task, Execution, Evidence, Experiment, Learning, Policy, Credential, Job and Client/Workspace boundaries remain singular.
4. The Operating Graph is a derived coordination/read-write composition model and never a replacement for those authorities.
5. Decision Ledger is append-oriented and cannot rewrite historical execution, evidence, outcome or learning records.
6. Profit Intelligence is derived analytics and cannot become a financial system of record.
7. Apps are versioned composition packages over Extensions, capability contracts, UI surfaces and bounded app-owned state.
8. Apps may be first-party or community published and may reproduce incumbent product capabilities without copying core MOS authorities.
9. App-owned state must declare its authority scope and cannot shadow core MOS objects such as Workflow or Execution state.
10. App permissions are least-privilege, policy-gated, server-derived and revocable.
11. Published App Versions are immutable; upgrades and rollback affect future selection only.
12. App UI is non-authoritative and uses server capabilities for mutations.
13. Provider SDKs, AI models, Domain Packs, Human Agents and Apps remain participants and cannot become alternate authorities.
14. Deployment validation must include the capabilities/apps required by the selected immutable deployment version.
15. PostgreSQL remains authoritative for durable MOS state.
