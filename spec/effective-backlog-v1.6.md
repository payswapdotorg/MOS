# Effective Implementation Backlog — MOS v1.6

Status: FROZEN
Architecture: 1.6
Maximum concurrent implementation workers: 3

MKT-001..MKT-052 remain the accepted v1.5 baseline. v1.6 adds MKT-053..MKT-075.

## A. Mission and autonomy

### MKT-053 — Growth Mission and Objective Model
Objective: introduce mission-level durable orchestration around existing Goals.
Dependencies: MKT-006, MKT-015, MKT-016, MKT-041, MKT-042.
Acceptance: creator-growth, audience-growth, product-marketing and commerce-discovery missions round-trip with immutable objective/version/history and fail-closed Client isolation.

### MKT-054 — Growth Operator
Objective: persistent goal-pursuit controller that selects bounded next experiments/actions and delegates all physical work to existing Workflow/Execution authorities.
Dependencies: MKT-053, MKT-008, MKT-010, MKT-015, MKT-016, MKT-021.
Acceptance: restart-safe controller, idempotent replanning, blocked/paused/resume semantics, no second execution engine.

## B. Social capability plane

### MKT-055 — Social Account and OAuth Connection Model
Objective: first-class social-account authorization over existing Credentials/Integrations.
Dependencies: MKT-021, MKT-023.
Acceptance: least-privilege OAuth lifecycle, refresh/reauthorize, account identity binding, exact scope recording, fail-closed disconnect/revocation.

### MKT-056 — Social Platform Adapter Contract
Objective: formalize per-platform capability matrix and normalized social account/content/analytics/publish operations.
Dependencies: MKT-023, MKT-055.
Acceptance: capability-subset support, adapter conformance suite, no platform-specific knowledge outside adapter subtrees.

### MKT-057 — YouTube Adapter
Objective: first-party YouTube account, discovery, analytics, upload/publish/status and restriction-signal adapter.
Dependencies: MKT-056.
Acceptance: sandbox + contract tests; current OAuth/API scopes, quota behavior and rights metadata documented.

### MKT-058 — Instagram Adapter
Objective: first-party Instagram Professional-account adapter for supported discovery, insights and publishing capabilities.
Dependencies: MKT-056.
Acceptance: current Instagram Login scopes/capabilities and account-type limitations verified in the adapter runbook.

### MKT-059 — Facebook Pages Adapter
Objective: first-party Facebook Pages adapter for supported Page content discovery, insights and publishing.
Dependencies: MKT-056.
Acceptance: Page authorization, publishing and insights contract tests with policy/rate-limit handling.

### MKT-060 — TikTok Adapter
Objective: first-party TikTok adapter for supported content discovery/analytics/publishing paths.
Dependencies: MKT-056.
Acceptance: audited direct-post capability, private-mode/audit restrictions, creator capability query and upload status documented and tested.

### MKT-061 — X Adapter
Objective: first-party X adapter for post/media publishing and supported account/content/analytics reads.
Dependencies: MKT-056.
Acceptance: OAuth lifecycle, media upload, post lifecycle and provider limits verified.

## C. Intelligence, rights and content production

### MKT-062 — Web Research and Content Intelligence
Objective: research web/social markets and normalize source facts, content observations, trends and candidate records.
Dependencies: MKT-013, MKT-023, MKT-057, MKT-058, MKT-059, MKT-060, MKT-061.
Acceptance: provenance-preserving research, niche clustering, candidate ranking and evidence/hypothesis separation.

### MKT-063 — Content Rights and Provenance
Objective: explicit asset-level rights state and publication gate.
Dependencies: MKT-013, MKT-022.
Acceptance: owned/license/platform-permitted/cleared/review/blocked states, ingredient lineage, fail-closed autonomous publication.

### MKT-064 — Content Asset and Transformation Authority
Objective: versioned content assets plus first-party/extension transformation execution contracts.
Dependencies: MKT-010, MKT-022, MKT-063.
Acceptance: crop/reframe/padding/compilation/clip/caption/voice/translation/format transformations retain lineage and quality observations.

### MKT-065 — Cross-Platform Distribution
Objective: plan and execute rights/policy-gated distribution of a canonical source/derived asset to multiple connected social accounts.
Dependencies: MKT-054, MKT-056, MKT-063, MKT-064.
Acceptance: one source → multiple destination variants; per-platform capability validation; destination-specific publishing; historical lineage.

## D. Health and scientific optimization

### MKT-066 — Platform Health and Distribution Anomaly Detection
Objective: detect observable reach collapse, restrictions, publishing failures, quota blocks and automation/inauthenticity-risk signals without inventing hidden moderation state.
Dependencies: MKT-057..MKT-061, MKT-014, MKT-016.
Acceptance: baseline-relative anomaly detection, descriptive reason codes, confidence/uncertainty, compliant response recommendations.

### MKT-067 — Experiment Analysis and Adaptive Allocation
Objective: compute experiment effects/uncertainty and allocate bounded exploration/exploitation.
Dependencies: MKT-015, MKT-014, MKT-016.
Acceptance: negative/inconclusive outcomes preserved; adaptive allocation is auditable and reproducible.

### MKT-068 — Notification Delivery Plane
Objective: real delivery adapters over the existing Notifications boundary.
Dependencies: MKT-001, MKT-021.
Acceptance: in-app/email MVP, pluggable WhatsApp/Telegram/SMS/Signal adapters later, delivery receipts and idempotency.

## E. Product and commerce missions

### MKT-069 — Product Intelligence
Objective: inspect public product/site information and explicitly authorized source code/workspaces to build a product/market model.
Dependencies: MKT-013, MKT-017, MKT-023.
Acceptance: source provenance, product capability model, audience/problem hypotheses, risk flags, no write access without separate authorization.

### MKT-070 — Product Marketing Mission Planner
Objective: choose social platform mix, target metrics, content strategy, attribution and experiment plan for a product-marketing mission.
Dependencies: MKT-053, MKT-062, MKT-066, MKT-067, MKT-069.
Acceptance: product URL/code context changes the selected platform portfolio and metric plan in auditable, evidence-linked decisions.

### MKT-071 — Commerce Catalog and Order Capabilities
Objective: extend the existing commerce integration boundary to catalog, product listing, price/inventory and order-event capabilities.
Dependencies: MKT-023, MKT-024.
Acceptance: normalized catalog/order/listing capabilities with webhook idempotency and policy-gated mutations.

### MKT-072 — Commerce Discovery Mission
Objective: discover viable products/niches, test demand via social experiments, recommend listing candidates and learn from actual orders.
Dependencies: MKT-053, MKT-062, MKT-063, MKT-065, MKT-067, MKT-071.
Acceptance: market → candidate → content → traffic → order → learning golden path with economic guardrails.

### MKT-073 — Social-to-Commerce Attribution
Objective: link content/distribution experiments to store visits, product interactions and orders.
Dependencies: MKT-065, MKT-071, MKT-072, MKT-052.
Acceptance: attribution ids survive content transformations and provider boundaries; causal claims remain explicitly separate.

## F. Product experience and proof

### MKT-074 — Growth Autopilot Console
Objective: first-class console journeys for Growth Missions, social account connections, strategy state, content candidates, rights gates, platform health, experiments and commerce outcomes.
Dependencies: MKT-053..MKT-073 plus P0 console source recovery.
Acceptance: one calm mission UX supports creator growth, product marketing and commerce discovery.

### MKT-075 — v1.6 End-to-End Autonomy Proof
Objective: prove the full evidence-driven operating loop across multi-platform social and commerce scenarios.
Dependencies: MKT-054, MKT-065, MKT-067, MKT-068, MKT-070, MKT-072, MKT-073, MKT-074.
Acceptance:
1. creator goal → research → hypothesis → rights → transform → publish → measure → learn → repeat;
2. product marketing → inspect product → select channel mix → experiment → attributable conversion;
3. commerce discovery → niche/product search → demand experiment → viable product → listing → orders → learning;
4. platform-health anomaly → compliant adaptation;
5. human-required blocker → notification → action → resume.

## G. Human growth marketplace

### MKT-076 — Human Growth Work Extensions
Objective: extend the existing Human Agent and Job authorities with creator/UGC specialization metadata and growth-work Job descriptors.
Dependencies: MKT-025, MKT-026, MKT-053, MKT-054.
Acceptance: eligible humans can receive and accept governed growth Jobs; no second human/job authority; existing concurrency-safe offer semantics remain intact.

### MKT-077 — UGC and Creator Offer Model
Objective: support governed UGC creation, creator posting and creator-ad/authorization offers as experiment treatments.
Dependencies: MKT-063, MKT-064, MKT-065, MKT-076.
Acceptance: offer terms persist deliverables, compensation, disclosure, destination, usage rights, expiry and experiment/mission references; rights and destination-policy gates are enforced before publication.

### MKT-078 — Human Amplification Optimization
Objective: make authentic human work a measurable experiment arm alongside owned-account and automated strategies.
Dependencies: MKT-054, MKT-067, MKT-076, MKT-077.
Acceptance: allocate bounded human/automated treatments, measure outcomes, preserve attribution/evidence, learn cost and quality, and reallocate without creating fake engagement or bypassing platform controls.
