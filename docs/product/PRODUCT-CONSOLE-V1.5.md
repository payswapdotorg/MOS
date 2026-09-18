# MOS Product Console — v1.5 Implementation Contract

**Status:** Product implementation contract / coordination document  
**Architecture authority:** `spec/frozen-manifest-v1.5.json` and `spec/architecture-v1.5.md` remain authoritative.  
**Purpose:** Turn the frozen v1.5 backend/product contracts into a calm, discoverable user experience without creating a new authority.

## 1. Product mental model

MOS is the operating workspace for an agency.

The primary question is not "which object do I open?" It is:

> **What matters now, what should we do next, why, and what happened?**

The console therefore uses five primary agency-level areas:

1. **Today** — command center, attention, decisions and immediate actions.
2. **Clients** — client portfolio and contextual client operating workspaces.
3. **Work** — human work, workflow/execution timeline, experiments and deployment operations.
4. **Apps** — installed apps, marketplace, first-party packs and developer portal.
5. **Admin** — platform/agency configuration, identities, integrations and operational controls.

Architecture objects remain discoverable contextually. They do not become separate primary navigation items merely because they are database/module concepts.

## 2. Agency Today

The default agency home should answer:

- What needs attention?
- What can make or save money?
- What is blocked?
- Which clients need intervention?
- Which approvals are waiting?
- Which experiments need a decision?
- What does MOS recommend doing next?

The default hierarchy is:

```
Good morning, <agency>

N things need attention

Revenue opportunities
Client risks
Margin leaks
Blocked work
Approvals
Experiments ready for a decision

Recommended next actions
[Action] [Action] [Action]

Why MOS is recommending this
Objective → Evidence → Hypothesis → expected impact/cost → decision/action contract
```

The surface consumes the /ai-operator and /profit-intelligence contracts. It does not recreate their calculations.

## 3. Client workspace

Client pages use progressive disclosure:

```
<Client>

Health / Revenue / Margin / Goals

TODAY
What happened
What matters
What MOS recommends

OPERATING
Goals
Strategy / Playbooks
Workflows
Deployments

INTELLIGENCE
Evidence
Experiments
Decisions
Learning
Memory

TRACE
Goal → Evidence → Hypothesis → Playbook → Workflow → Execution
→ Outcome → Decision → Learning
```

The Operating Graph is visible through trace and context, not through a technical "graph" navigation item.

## 4. Work experience

Workflow and Execution are rendered as an operational timeline:

```
Playbook
  ↓
Deployment
  ↓
Workflow
  ↓
Task
  ↓
Participant (Human / AI / App / Extension)
  ↓
Execution
  ↓
Evidence
  ↓
Outcome
  ↓
Decision
  ↓
Learning
```

The UI must distinguish observed, inferred, proposed and causal states wherever the backend exposes those distinctions.

UNKNOWN execution outcomes remain unresolved in the UI and must expose reconciliation state rather than appearing successful.

## 5. Deployment experience

The Deployment Center presents:

**Configure → Validate → Deploy → Observe → Pause/Resume → Redeploy/Rollback**

It must show:

- immutable Playbook/Workflow version;
- required App/Extension capability versions;
- permission and policy status;
- credential/reference readiness;
- runtime requirements;
- trigger readiness;
- lifecycle state;
- deployment history;
- correlation/audit context.

The UI does not execute Workflows itself.

## 6. Experiment Lab

Experimentation must be a product surface rather than a buried Decision Room subsection.

Show:

- hypothesis;
- objective and target population;
- treatment/comparison;
- outcome metrics;
- analysis method;
- evidence quality;
- uncertainty;
- current decision;
- observed outcome;
- learning and contradiction history.

The product must not label correlation or attribution as causation.

## 7. Decision trace

Every material recommendation should provide a human-readable trace:

```
Goal
  ↓
Evidence
  ↓
Hypothesis
  ↓
Relevant Playbook
  ↓
Workflow / Execution
  ↓
Outcome
  ↓
Decision
  ↓
Learning
```

Each step should link to the canonical record and preserve source references. The frontend may format and group the trace, but cannot synthesize a competing source of truth.

## 8. Apps

Apps use:

**Installed / Marketplace / First-party / Developer Portal**

The lifecycle is:

**Discover → Inspect trust/permissions → Install → Compose/Use → Observe → Upgrade → Rollback**

The UI must explain the exact installed App Version and granted scopes. Historical invocations must retain their original version.

## 9. Sales-to-delivery

The sales journey should visibly carry:

**Proposal → Scope → Goals → Outcomes → Economics → Playbook → Deployment**

Users should never need to re-enter the same commercial context merely to start delivery.

## 10. Human work

Human Work is a first-class product surface.

It should optimize for:

**available work → eligible jobs → assignment → execution → evidence/outcome**

not for exposing internal Job table mechanics.

## 11. Client Portal

Client Portal is an App surface. It should be discoverable from the client workspace but must not become a second reporting or client-data authority.

## 12. Integrations

Integrations should normally be discovered contextually when a workflow, app, deployment or data source needs them. Ordinary agency users should not need to browse infrastructure-oriented integration internals merely to operate a client.

## 13. Visual language

Use the existing Geist/shadcn foundation with a calm professional treatment:

- warm/off-white surfaces where the existing theme permits;
- graphite typography;
- restrained borders;
- status color only for meaningful state;
- one obvious primary action per view;
- progressive disclosure;
- minimal chrome;
- responsive desktop/mobile behavior.

Avoid:

- architecture diagrams as primary UI;
- giant metric-card walls;
- excessive gradients/glass effects;
- database-object navigation;
- technical identifiers in ordinary user-facing copy.

## 14. Repository source-of-truth rule

The user-facing console source is part of MOS.

A Vercel deployment, compiled Next.js bundle, screenshot, or external source workspace is not source authority.

The production deployment may prove runtime behavior, but source, tests, configuration and deployment instructions must be reproducible from this repository.

## 15. Acceptance

A Tech Lead may declare the product-console program complete only after:

- frontend source is present in `payswapdotorg/MOS`;
- the console can be built from the repo;
- the five primary areas are implemented;
- major v1.5 capabilities have contextual entry points;
- owner/operator, client, human-agent, sales and app journeys pass browser/E2E checks;
- client isolation and frontend-bypass security checks pass;
- deployment is reproducible;
- production health has been independently verified;
- the final handoff states exact SHAs, commands, test results and disclosed limitations.
