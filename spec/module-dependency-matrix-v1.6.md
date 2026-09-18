# MOS Module Dependency Matrix — v1.6

Status: FROZEN
Architecture Version: 1.6

v1.5 module dependencies remain valid. v1.6 adds these bounded domains:

/growth-missions → /clients, /workspaces, /goals, /evidence, /experiments, /learnings, /decisions
/growth-operator → /growth-missions, /goals, /playbooks, /deployments, /workflows, /executions, /evidence, /experiments, /learnings, /decisions, /policies, /platform-health
/social-accounts → /integrations, /credentials, /policies, /clients, /workspaces
/social-intelligence → /integrations, /evidence, /metrics, /experiments, /growth-missions
/content-intelligence → /evidence, /metrics, /experiments, /integrations, /research
/research → /integrations, /evidence, /ai-runtime
/content-rights → /evidence, /policies, /content-assets
/content-assets → /executions, /object-storage, /content-rights
/cross-platform-distribution → /growth-missions, /social-accounts, /content-assets, /content-rights, /integrations, /policies
/platform-health → /social-accounts, /integrations, /metrics, /evidence, /experiments
/experiment-analysis → /experiments, /metrics, /evidence, /learnings
/product-intelligence → /research, /evidence, /integrations, /ai-runtime
/product-marketing → /growth-missions, /product-intelligence, /content-intelligence, /platform-health, /experiment-analysis
/commerce-discovery → /growth-missions, /product-intelligence, /content-intelligence, /experiment-analysis, /integrations, /platform-health
/social-commerce-attribution → /cross-platform-distribution, /integrations, /metrics, /evidence, /growth-missions
/notification-delivery → /notifications, /policies, /credentials

## Boundary rules

1. Social adapters are concrete provider implementations and may be imported only by the composition root.
2. Domain/application modules consume platform-neutral Social capability contracts, never a provider SDK.
3. Growth Operator can create/advance mission decisions but cannot own workflow/execution lifecycle.
4. Content Rights can block publication but cannot silently approve unclear rights.
5. Content Assets stores/derives artifact lineage but cannot become a rights authority.
6. Platform Health describes observable signals and cannot fabricate provider-side moderation decisions.
7. Product Intelligence has read-only source-code/product inspection unless a separate write capability is explicitly granted.
8. Commerce Discovery never writes directly to catalog/order tables; store mutations flow through Integrations.
9. Notification Delivery delivers messages only; it does not become canonical task/action state.
10. All new modules preserve Client/Workspace scope and fail closed before dependent traversal.

/growth-human-work → /field-agents, /jobs, /growth-missions, /content-assets, /content-rights, /policies
/human-growth-optimization → /growth-missions, /growth-operator, /jobs, /experiments, /metrics, /evidence, /learnings
