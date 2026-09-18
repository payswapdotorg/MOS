# Architecture Change Request 006 — MOS v1.6 Growth Autonomy

Status: APPROVED
New architecture version: 1.6
Supersedes: 1.5 only where this change request explicitly adds or alters behavior.

## Purpose

Expand MOS into a provider-independent autonomous growth system that can:

- pursue audience-growth, product-marketing, acquisition, revenue and commerce objectives;
- operate across multiple social platforms through unique adapters;
- distribute an approved content asset from one platform to other connected platforms;
- research markets, products, niches and content patterns;
- form evidence-backed hypotheses and test them through governed publishing experiments;
- adapt strategy continuously toward an explicit outcome target;
- detect platform reach/restriction/automation-risk signals and adapt within platform rules;
- transform content through first-party or extension-provided capabilities while preserving the value-driving characteristics of successful source content;
- notify operators through pluggable channels;
- discover and validate products for commerce missions and connect social demand generation to store orders.

## Approved v1.6 changes

1. Introduce a first-class Growth Mission / Objective model above channel-specific campaigns.
2. Introduce Social Account and Social Platform capability contracts. Each platform remains an independent adapter.
3. MVP first-party social adapters: YouTube, Instagram, Facebook Pages, TikTok and X.
4. Permit cross-platform distribution only when the source asset's rights/terms permit the selected destination use.
5. Add Content Intelligence and Web Research capabilities for niche/market/content discovery and hypothesis generation.
6. Add Content Rights and Provenance as a hard gate for autonomous publishing.
7. Add a provider-independent Content Asset / Transformation pipeline with first-party and community extension points.
8. Add Platform Health / Distribution Anomaly analysis for visibility collapse, restrictions, publishing failures and automation/inauthenticity risk.
9. Add Experiment Analysis and adaptive strategy allocation over the existing Experiment authority.
10. Add Growth Operator as the persistent goal-pursuit controller. It orchestrates existing Workflow/Execution authority and is never a second execution engine.
11. Upgrade Notifications into a provider-pluggable delivery system. MVP channels: email and in-app. Future channels include WhatsApp, Telegram, SMS and Signal.
12. Add Product Intelligence for public product/site inspection and authorized source-code/workspace inspection.
13. Add Product Marketing Mission planning that chooses platform mix, target metrics and experiments based on the product and desired business outcome.
14. Extend commerce capabilities so product candidates, catalog/listing actions, order events and attribution can participate in the same evidence → experiment → learning loop.
15. Add an autonomous Commerce Discovery mission: discover market/niche/product candidates, test demand through social experiments, notify when a candidate crosses viability gates, drive traffic to the store, and learn from real orders.
16. Keep platform policy and legal boundaries explicit: MOS may adapt around observed restrictions only through compliant changes, appeals, pauses, platform switching or human action. It must not evade enforcement, fabricate engagement, bypass platform safeguards, or simulate humans to defeat bot/anti-abuse controls.

## Non-changes

- Workflow remains the sole workflow authority.
- Execution remains the sole execution identity/lifecycle authority.
- Deployment remains the deployment authority.
- Evidence, Experiment and Learning remain singular authorities.
- Apps and Extensions remain participants/capability packages, not alternate authorities.
- Provider SDKs remain behind provider adapter boundaries.
- PostgreSQL remains authoritative for durable MOS state.
- v1.5 remains frozen for existing behavior except the explicit v1.6 additions in this request.

17. Generalize the existing Human Agent/Job authorities into a Growth Human Marketplace. Growth missions may create governed human work for UGC creation, creator posts, creator-ad placements/authorizations, product trials and other authentic creator work.
18. Add offer types and compensation terms for creator/UGC work without creating a second job, payment or order authority. Human work remains `/jobs`; settlement remains an external/composed capability.
19. Human participation is an experiment arm alongside owned-account publishing and other automated strategies. The system may shift allocation based on measured outcomes while preserving authentic-human and platform-policy constraints.
