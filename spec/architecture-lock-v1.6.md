# MOS Architecture Lock — v1.6

Status: FROZEN

1. MOS v1.6 supersedes v1.5 only where the v1.6 change request explicitly adds or alters behavior.
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
16. Growth Mission is a durable orchestration layer over existing Goals, Playbooks, Workflows, Executions, Experiments, Evidence and Learning; it is not a replacement authority.
17. Growth Operator is a decision/replanning controller and is never a second Workflow or Execution engine.
18. Each social platform is integrated through its own adapter behind the provider-neutral Integration contract.
19. Social platform capability parity must never be assumed.
20. Cross-platform distribution is rights-gated per source asset and destination.
21. Content rights uncertainty fails closed for autonomous publication.
22. Fair-use reasoning is never represented as an automatic legal guarantee.
23. Every derived content artifact retains ingredient and transformation lineage.
24. Transformation engines are replaceable first-party capabilities or Extensions/Apps and must not become alternate MOS authorities.
25. Platform Health describes observable signals and must not fabricate hidden moderation state.
26. Shadow-ban claims are represented as suspected distribution anomalies unless the platform itself exposes an explicit restriction.
27. Maneuvering around platform blockers means compliant strategy adaptation only; evasion, fake engagement, anti-abuse bypass and human impersonation are forbidden.
28. Social account authorization, product/source access, store access and other credentials remain separate least-privilege grants.
29. Cross-platform publishing requires both source rights and destination capability/policy clearance.
30. Product Marketing Missions may choose a platform portfolio instead of optimizing one platform.
31. Business outcomes outrank vanity metrics when the mission declares a business outcome.
32. Commerce Discovery may recommend products and orchestrate experiments but cannot become a second order/inventory authority.
33. Store orders remain external commerce-provider authority accessed through Integration.
34. Notification delivery is provider-pluggable and cannot become an operational authority.
35. Historical evidence, experiments, decisions and learnings remain immutable or append-oriented according to their existing contracts.
36. Client/Workspace isolation remains fail-closed before external access or dependent traversal.
37. Any future platform adapter must declare its current capability matrix, authorization constraints, policy dependencies and limitations before acceptance.
38. Human growth work uses the existing Human Agent + Job + Task + Execution authorities; no second marketplace authority is introduced.
39. UGC/creator offers must carry explicit deliverables, compensation terms, disclosure requirements and content-rights/usage terms.
40. Compensation records in Jobs are not payment settlement records.
41. Human amplification must represent authentic creator activity; fake engagement and fabricated social proof are forbidden.
42. Human-created content retains the same lineage, rights and provenance gates as automated content.
43. Human amplification is an optional experiment treatment and MUST NOT become a prerequisite for autonomous mission activation, core distribution, product marketing, commerce discovery or final autonomy proof.
44. Zero human budget, no eligible humans, no accepted offers, offer expiry and offer decline are valid non-human strategy states, not architectural failures.
45. A genuinely mandatory human approval may block a specific action, but the state must be represented explicitly as pending human action rather than hidden dependency or simulated success.
