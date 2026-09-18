# MOS Architecture v1.6 — Growth Autonomy

Version: 1.6
Status: FROZEN
Supersedes: 1.5 only for the additive behavior defined here.

## 1. Product model

MOS v1.6 is an evidence-driven, multi-tenant Growth Operating System.

A Growth Mission expresses the outcome being pursued. The outcome may be creator-specific or business/product-specific.

Examples:
- grow a YouTube channel to 1,000,000 qualified views;
- establish a healthy social presence across YouTube, Instagram and TikTok;
- market a crypto trading product to qualified users;
- discover a viable dropshipping product and generate the first 100 orders;
- generate $50,000 in attributable revenue.

## 2. Growth Mission lifecycle

Mission → Product/Market Context → Research/Observation → Hypothesis → Strategy → Experiment → Rights/Policy Gate → Content/Action → Publish/Execute → Measure → Analyze → Decision → Learning → Replan → repeat until goal state.

Terminal states:
- achieved;
- stopped by user;
- blocked pending human action;
- blocked by unavailable capability;
- budget/quota exhausted;
- policy-constrained;
- failed after bounded recovery.

The controller never silently converts a block into success.

## 3. Goal and objective generalization

The existing Goal authority remains the canonical measurable business-intent authority.

v1.6 adds a Growth Mission layer that maps a mission into one or more existing Goals and target metrics.

Objective families:
- audience_growth;
- creator_growth;
- product_marketing;
- acquisition;
- lead_generation;
- revenue;
- commerce_discovery;
- hybrid.

A mission may optimize intermediate metrics, but the terminal decision is evaluated against the declared business objective.

## 4. Social Account and platform adapter model

Social accounts are external account identities attached to a Client/Workspace through an authorized integration.

Each Social Platform Adapter declares capabilities such as:
- account discovery;
- public content discovery where permitted;
- own-content reads;
- audience/analytics reads;
- content publish;
- scheduling;
- media upload;
- status polling;
- webhooks/events;
- restrictions/eligibility signals;
- comments or responses where explicitly supported.

Platform adapters remain independent. A normalized MOS contract describes the semantic capability; platform-specific rules remain inside the adapter.

MVP adapters:
- YouTube;
- Instagram;
- Facebook Pages;
- TikTok;
- X.

The contract MUST allow a platform to expose a subset of capabilities. The UI and planner cannot assume parity.

## 5. Cross-platform distribution

A Distribution Plan maps Source Asset → Rights/Provenance → Transformation Plan → Target Platform → Target Account → Target Format → Publication → Measurement.

Cross-platform publication is legal/policy-gated per destination.

The system distinguishes:
- user's own source content;
- content the user has explicit redistribution rights to;
- source content with a machine-verifiable license that permits the intended use;
- content that requires human/legal review;
- content that is blocked.

A platform connection never implies rights to redistribute content that originated elsewhere.

## 6. Content Intelligence

The Content Intelligence layer normalizes platform observations into evidence and candidate records.

Important features can include topic/entity, niche/sub-niche, content format, length, hook features, narrative structure, publishing time, observed performance, performance velocity, engagement, audience-fit signals, freshness, novelty and reuse/duplication risk.

Observed competitor/platform performance generates hypotheses. It does not by itself establish causality for the user's account.

## 7. Web Research

Research sources may include public web pages, documentation, research papers, news, market sources, public social content, and connected repositories/workspaces when explicitly authorized.

Every material source fact retains source provenance. Model output is a claim unless backed by evidence.

## 8. Product Intelligence

A mission can optionally attach a Product Context.

Inputs may include public product/site URL, authenticated application environment, source-code repository URL, connected source workspace, product documentation, catalog/inventory and current analytics.

Product Intelligence derives product capabilities, user/problem hypotheses, ICP/audience hypotheses, value propositions, conversion paths, content-worthy features, market language, product risks and commercial metrics to optimize.

Source-code inspection is analysis-only unless the user separately grants write capability.

## 9. Content rights

Content Rights is an explicit publication gate.

States:
- owned;
- explicit_license;
- platform_permitted;
- public_domain;
- license_allows_derivative;
- human_review;
- unclear;
- blocked.

Every derived asset keeps lineage to its ingredients.

Fair-use reasoning is represented as review evidence, not as an automatic legal guarantee.

Autonomous publishing requires a rights state explicitly permitted by mission policy. Rights uncertainty routes to human action.

## 10. Transformation system

A Content Asset is an immutable versioned artifact with lineage.

Transformations are capabilities, not a hardcoded provider list.

First-party and extension implementations may provide crop/reframe, aspect-ratio adaptation, padding/side-by-side or top/bottom composition, clipping, compilations, sequencing, captions/subtitles, voice-over, translation/dubbing, audio cleanup, background treatment, scene selection, thumbnail generation, metadata rewriting and format/compression optimization.

Each transformation declares expected effects and constraints.

The planner must score whether a transformation preserves the source's observed value-driving characteristics before publication.

Content added as padding or compilation material is itself subject to rights and provenance gates.

## 11. Platform health and blockers

MOS does not claim access to hidden platform moderation state unless a platform explicitly exposes it.

Platform Health is composed from platform-reported restrictions, publishing errors, policy/eligibility signals, copyright/claim signals, recommendation/distribution metrics where available, non-follower reach, search/recommendation impressions where available, engagement and retention, deviations from the account's historical baseline, cross-platform control comparisons, and automation/inauthenticity risk signals observable from first-party metrics or connected platform feedback.

Descriptive states:
- healthy;
- degraded;
- restricted;
- suspected_distribution_anomaly;
- suspected_automation_risk;
- authorization_blocked;
- publishing_blocked;
- quota_limited;
- human_review_required.

Maneuver means compliant adaptation: change content mix/frequency, pause a risky strategy, shift activity to another connected platform, adjust transformations, reduce automation, request human interaction, appeal/review where the platform provides that mechanism, preserve the goal while changing the route.

MOS never attempts to defeat anti-abuse controls, fake engagement, bypass account restrictions, or impersonate human activity.

## 12. Experiment analysis

The existing Experiment authority remains responsible for experiment identity/design.

v1.6 adds an analysis layer that computes treatment/comparison effects, uncertainty, sample sizes, observation windows, sequential-analysis state, confounders, limitations, practical effect thresholds and recommended next allocation.

Adaptive allocation may increase exposure to promising strategy variants while retaining explicit exploration.

A negative or inconclusive result remains a valid scientific outcome.

## 13. Growth Operator

Growth Operator is a persistent controller, not a workflow engine.

It can inspect mission state, inspect current evidence and learnings, select or create the next bounded experiment, request an existing Playbook/Workflow/Execution path, wait for measurement, request analysis, record decisions, update learning and replan.

All physical work continues through existing Workflow/Execution authorities.

The controller is idempotent and resumable. A process restart cannot lose durable mission state.

## 14. Notifications

Notification is a provider-pluggable capability.

MVP: in-app and email.
Future adapters: WhatsApp, Telegram, SMS, Signal and additional channels.

Every notification has event type, urgency, human-readable explanation, source/mission reference, required action, deep link and delivery status.

## 15. Commerce loop

The existing Integration boundary becomes capable of commerce operations required by v1.6: catalog read, product read/write where authorized, product listing, price/inventory read, order read, order webhook and attribution data.

Commerce Discovery can operate: market discovery → product candidate → content hypothesis → social experiment → demand signal → listing → traffic → order → contribution/margin → learning.

A candidate becomes viable only when it passes the mission's explicit economic and operational gates.

## 16. Attribution

Every social-to-product action can carry a mission-scoped attribution reference.

Preferred mechanisms include platform-native links where available, UTM parameters, unique landing routes, campaign identifiers, creator/content identifiers and first-party conversion events.

Attributed outcomes flow back as evidence/metrics; attribution is never silently treated as causal proof.

## 17. Budget and quota

Growth Operator must consider platform API quota, content-production compute cost, AI cost, storage/bandwidth cost, paid-media budget when applicable, commerce test budget and human-review capacity.

The planner may stop or change strategy when additional experimentation has poor expected information value relative to budget.

## 18. Security and tenancy

All external account access remains Client/Workspace scoped.

OAuth tokens and secret material remain under the existing Credential authority.

Source-code access, product access, store access and social account access are separate grants.

No model, extension, adapter or transformation provider receives broader tenant scope than the current execution requires.

## 19. Architectural non-goals

v1.6 does not make MOS a social-network clone, ad-fraud or engagement-manipulation system, anti-ban evasion system, generic video editor replacing every media tool, alternate workflow engine, legal-advice authority, or second commerce order authority.

Growth Operator orchestrates existing authorities; it never replaces them.