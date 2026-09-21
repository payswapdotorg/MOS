# MOS v1.6 UX Discovery + Major-Journey Simulation

Status: VERIFIED DISCOVERY INPUT FOR IMPLEMENTATION
Audit date: 2026-09-21

## Method

Reviewed current main source, current architecture/backlog, current live production HTML, production deployment metadata, recorded real E2E results, latest MKT-054/056/063/064 runbooks, and the ShareNet source reference.

The available toolchain did not expose a live interactive browser driver, so this pass does not claim fresh click-by-click browser execution. It combines a live deployed HTML fetch with source-level journey simulation and previously recorded real E2E browser evidence.

## Journey simulation

### 1. First visit

The live production URL currently serves the real MOS authentication experience with Sign in, Create account and demo quick-login options.

Result: authentication discoverable; product positioning weak.

After authentication, source inspection shows the operations-first navigation:
Command Center -> Clients -> Attention -> Profit Intelligence -> Human Work -> Apps -> Administration.

Learning: the first authenticated screen teaches users how MOS is structured instead of what outcome it can autonomously pursue.

### 2. Creator growth

Desired:
Grow -> connect accounts -> research -> evidence -> hypothesis -> experiment -> rights -> transform -> publish -> measure -> learn.

Current: not discoverable.

The backend now contains MKT-053 Growth Mission, MKT-054 Growth Operator, MKT-055 Social Account/OAuth and MKT-056 Social Adapter Contract, but no first-party MKT-057..061 adapter set and no mission-first console.

Learning: "Grow an audience" must be a first-class entry action. Internal operator/task/execution terms remain progressive disclosure.

### 3. Product marketing

Desired:
Paste product URL -> understand product -> audience/platform/metric plan -> approve -> execute -> measure.

Current: not discoverable.

MKT-069 Product Intelligence exists, but MKT-070 and the mission UI are not implemented.

Learning: "Market a product" must be a first-class entry action rather than something users discover through Apps or Client Workspace.

### 4. Commerce discovery

Desired:
I don't know what to sell -> research -> candidates -> demand tests -> viability -> listing -> traffic -> orders -> margin -> learning.

Current: not discoverable.

MKT-071 commerce capability exists, but MKT-072 and its mission UX are not implemented.

Learning: commerce must be represented as an outcome lifecycle, not an integration configuration.

### 5. Rights and transformations

MKT-063 and MKT-064 are now implemented on main, but their behavior is not exposed through a mission-first UI.

Learning: content candidates must reveal source, evidence basis, rights decision, transformation lineage, destination capability and publication state before publish.

### 6. Human amplification

Existing Human Work is discoverable, but human amplification remains detached from growth strategy.

Learning: "Add human treatment" belongs inside a mission and should look like another experiment arm. Human capacity shortages are optional constraints, not mission failure.

### 7. Scientific trace

The existing Client Workspace remains a strong v1.5 foundation:
Goals, Strategy, Deployments, Workflows, Evidence, Decisions, Learning, Memory.

Learning: reuse these authorities as a mission trace instead of building a second analytics hierarchy.

### 8. Platform health

No mission-level platform-health capability is implemented yet.

Learning: expose descriptive observable states, evidence basis and the next compliant action. Never assert an unobservable hidden moderation state.

### 9. Existing v1.5 operations

Current Command Center, Clients, Attention, Profit Intelligence, Human Work, Apps and Administration remain useful and should be preserved.

Learning: v1.6 should become the new front door over the same product rather than a second application.

## Global findings

1. v1.6 backend maturity has advanced faster than the console.
2. Outcome-first discoverability is still the dominant product gap.
3. Internal architecture is too visible as the primary information architecture.
4. Connections should be contextual during mission setup and also available in a reusable Connections center.
5. Rights/provenance and platform-health decisions must be visible before actions.
6. Human amplification belongs inside experiments, not only in a detached marketplace.
7. Current production is five commits behind main; MKT-064 is previewed but not promoted.

## ShareNet-inspired design

Use the already-frozen direction:
warm neutral/light surfaces, graphite typography, restrained teal/green healthy state, amber warning, red failure, generous whitespace, minimal chrome, progressive disclosure and subtle state transitions.

## Browser acceptance

Every new journey must be proven at 390x844 and 1280x800 with real APIs, real authorization, zero horizontal overflow, zero page/browser errors, no raw JSON and explicit next actions for empty/error/blocked states.
