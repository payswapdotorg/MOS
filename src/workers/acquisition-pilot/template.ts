/**
 * MKT-028 — THE ACQUISITION PILOT TEMPLATE PACKAGE (the first deliverable:
 * the playbook + workflow definition template handed through the /playbooks
 * and /workflows public contracts).
 *
 * PURE DATA + PURE FUNCTIONS. This file contains NO I/O, NO module value
 * imports (module contracts appear as TYPE imports only) and NO state: the
 * template is assembled by pure builder functions whose outputs are fed to
 * the /playbooks and /workflows authority public contracts by the WIRING
 * service (pilot-flow.ts). Template purity is pinned by unit tests and by
 * the static boundary tests.
 *
 * The package pins, in ONE place:
 *
 *   1. the PLAYBOOK STRATEGY (spec/implementation-contract.md §1 authority
 *      list: "versioned, reusable strategy artifacts" — MKT-007) plus its
 *      declarative deployment metadata (runtime class pooled-worker — the
 *      MKT-011 default runtime leg this pilot's digital execution rides);
 *   2. the WORKFLOW DEFINITION CONTENT — a frozen-contract §4 typed graph:
 *      one `ai_task` digital outreach node (pooled/idempotent), one
 *      `human_task` field visit node (the §18 field Job projection target),
 *      an `all`-semantics `join` over both legs and a `terminal` outcome
 *      recorder. The graph is validated by the /workflows authority
 *      validator itself (unit test: zero problems);
 *   3. the FIELD JOB DESCRIPTOR (§18): the public title/description and the
 *      profile-data-only eligibility spec the /jobs projection carries —
 *      NO Client-specific data (human-agent-v1.3.md §3);
 *   4. the EVIDENCE CAPTURE POINTS: the declared classes/qualities the
 *      pilot's execution legs record through /evidence (field observations
 *      through the §18 capture surface; execution artifacts referenced by
 *      outcome evidence);
 *   5. the EXPERIMENT DECLARATION (§16): the full frozen contract —
 *      hypothesis, decision target, population/unit, treatment/comparison,
 *      assignment method, design type, primary metric BY NAME + DIMENSIONS
 *      (never a provider metric id), guardrails, analysis method/version,
 *      expected direction, start/stop criteria, minimum evidence
 *      requirement, uncertainty representation;
 *   6. the BOUNDS (E2E-001 "bounded"): instance cap, live-instance cap and
 *      guardrail thresholds — the structural stop conditions the wiring
 *      service enforces fail-closed BEFORE any write;
 *   7. the METRIC IDENTITIES: the primary metric and guardrail metric
 *      name+dimension sets the pilot's /metrics observations and /metrics
 *      evaluation are keyed by.
 *
 * MKT-034 (full closed loop with extension paths and Learning) is OUT OF
 * SCOPE — this template is the bounded prove-it-first pilot only.
 */

import type { PlaybookStrategy, PlaybookDeploymentMetadata } from '../../modules/playbooks/public.ts';
import type { WorkflowDefinitionContent } from '../../modules/workflows/public.ts';
import type { ExperimentCreateInput, ExperimentMetricIdentity } from '../../modules/experiments/public.ts';
import type { JobDescriptor } from '../../modules/jobs/public.ts';
import {
  ACQ_DIGITAL_NODE,
  ACQ_ENTRY_NODE,
  ACQ_FIELD_NODE,
  ACQ_JOIN_NODE,
  ACQ_TERMINAL_NODE,
  type AcquisitionPilotBounds,
  type PilotGuardrailEvaluation,
  type PilotGuardrailResult,
  type PilotObservationView,
} from './contract.ts';

// ---------------------------------------------------------------------------
// The template's metric identities — BY NAME + DIMENSIONS (§16: never a
// provider metric id; experiments are declared before observations exist)
// ---------------------------------------------------------------------------

/** The pilot's PRIMARY metric: qualified leads attributed to the pilot cohort. */
export const ACQ_PRIMARY_METRIC: ExperimentMetricIdentity = {
  name: 'pilot_qualified_leads',
  dimensions: { pilot: 'acquisition' },
};

/** The pilot's GUARDRAIL metric: total pilot cost (USD). */
export const ACQ_GUARDRAIL_COST: ExperimentMetricIdentity = {
  name: 'pilot_cost_usd',
  dimensions: { pilot: 'acquisition' },
};

/** Every metric identity the pilot declares (primary first, then guardrails). */
export const ACQ_METRIC_IDENTITIES: readonly ExperimentMetricIdentity[] = [
  ACQ_PRIMARY_METRIC,
  ACQ_GUARDRAIL_COST,
];

// ---------------------------------------------------------------------------
// The bounds (E2E-001 "bounded" — the §16 stop conditions, structural)
// ---------------------------------------------------------------------------

/** The frozen pilot bounds: 3 instances ever, 1 live at a time, ≤ 500 USD total cost. */
export const ACQUISITION_PILOT_BOUNDS: AcquisitionPilotBounds = {
  maxInstancesPerPilot: 3,
  maxConcurrentInstances: 1,
  guardrailThresholds: {
    [ACQ_GUARDRAIL_COST.name]: 500,
  },
};

// ---------------------------------------------------------------------------
// 1. The playbook strategy + deployment metadata (→ /playbooks public)
// ---------------------------------------------------------------------------

/** The playbook strategy + declarative deployment metadata (→ /playbooks.createPlaybookVersion). */
export function buildPlaybookStrategy(): {
  readonly strategy: PlaybookStrategy;
  readonly deploymentMetadata: PlaybookDeploymentMetadata;
} {
  return {
    strategy: {
      summary:
        'Prove-it-first acquisition pilot: one bounded Goal cohort driven through one digital outreach execution and one field visit, measured on qualified leads against a hard cost guardrail, concluded through the declared experiment.',
      templates: [
        {
          name: 'acquisition-pilot-flow',
          description:
            'Goal → deployed pilot template → one digital ai_task (pooled worker) + one human_task field visit (§18 Job) → evidence + metrics → experiment decision.',
        },
      ],
    },
    deploymentMetadata: {
      // The bounded pilot composes core authorities only — no Domain Pack and
      // no integration/extension capability requirement (extension paths are
      // MKT-034, out of scope).
      requiredDomainPacks: [],
      requiredCapabilities: [],
      runtimeRequirements: { runtimeClass: 'pooled-worker' },
      triggers: [{ kind: 'manual', config: null }],
    },
  };
}

// ---------------------------------------------------------------------------
// 2. The workflow definition content (→ /workflows public, §4 contract)
// ---------------------------------------------------------------------------

/**
 * The pilot workflow definition content — the §4 typed graph:
 *
 *   acq_pilot_entry (function) ──success──> acq_digital_outreach (ai_task) ──join(all)──┐
 *          │                                                                             ├── acq_pilot_join (join, all) ──success──> acq_pilot_outcome (terminal)
 *          └──────────────success──────> acq_field_visit (human_task) ──join(all)─────┘
 *
 * ONE deterministic entry (the §4 single-entry rule: parallel starts are
 * fan-out from the single entry) staging the cohort, fanning out into the
 * digital and field legs, converging at an `all`-semantics join and
 * recording the outcome at the terminal. Validated by the /workflows
 * authority validator (validateWorkflowDefinitionContent returns ZERO
 * problems — pinned by unit test).
 */
export function buildWorkflowDefinitionContent(): WorkflowDefinitionContent {
  return {
    graph: {
      nodes: [
        {
          nodeId: ACQ_ENTRY_NODE,
          nodeType: 'function',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              cohort_staged: {
                type: 'boolean',
                description: 'the pilot cohort inputs were staged for both execution legs',
              },
            },
            required: [],
          },
          executionPolicyRef: null,
          retryPolicy: null,
          timeout: null,
          idempotencyKeyStrategy: 'workflow',
          humanApproval: null,
          join: null,
          loop: null,
        },
        {
          nodeId: ACQ_DIGITAL_NODE,
          nodeType: 'ai_task',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              qualified_leads: {
                type: 'number',
                description: 'qualified leads attributed by the digital outreach run',
              },
              cost_usd: {
                type: 'number',
                description: 'spend attributed to the digital outreach run (USD)',
              },
            },
            required: [],
          },
          executionPolicyRef: null,
          retryPolicy: { maxAttempts: 2, backoffMs: null },
          timeout: { seconds: 300 },
          // §8 idempotency key strategy: stable per (workflow instance, node)
          // — the pooled path derives its task key from exactly these
          // coordinates, so replays converge to one logical artifact.
          idempotencyKeyStrategy: 'workflow',
          humanApproval: null,
          join: null,
          loop: null,
        },
        {
          nodeId: ACQ_FIELD_NODE,
          nodeType: 'human_task',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              visit_result: {
                type: 'string',
                description: 'the frozen §18 field result vocabulary value',
              },
              follow_up_required: {
                type: 'boolean',
                description: 'the explicit follow-up declaration',
              },
            },
            required: [],
          },
          executionPolicyRef: null,
          retryPolicy: null,
          timeout: null,
          idempotencyKeyStrategy: 'workflow',
          // §4 node contract: human_task nodes REQUIRE the human approval block.
          humanApproval: { required: true, approverPolicyRef: null },
          join: null,
          loop: null,
        },
        {
          nodeId: ACQ_JOIN_NODE,
          nodeType: 'join',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              both_legs_settled: {
                type: 'boolean',
                description: 'both pilot execution legs reached the join',
              },
            },
            required: [],
          },
          executionPolicyRef: null,
          retryPolicy: null,
          timeout: null,
          idempotencyKeyStrategy: null,
          humanApproval: null,
          // §4 edge contract: the declared predecessor set EXACTLY equals the
          // set of nodes with a join-type edge into this node; 'all' releases
          // only after every declared predecessor arrived.
          join: {
            semantics: 'all',
            predecessors: [ACQ_DIGITAL_NODE, ACQ_FIELD_NODE],
            threshold: null,
          },
          loop: null,
        },
        {
          nodeId: ACQ_TERMINAL_NODE,
          nodeType: 'terminal',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              pilot_outcome_recorded: {
                type: 'boolean',
                description: 'the pilot outcome was recorded through the authorities',
              },
            },
            required: [],
          },
          executionPolicyRef: null,
          retryPolicy: null,
          timeout: null,
          idempotencyKeyStrategy: null,
          humanApproval: null,
          join: null,
          loop: null,
        },
      ],
      edges: [
        {
          fromNode: ACQ_ENTRY_NODE,
          toNode: ACQ_DIGITAL_NODE,
          edgeType: 'success',
          predicateRef: null,
          joinSemantics: null,
        },
        {
          fromNode: ACQ_ENTRY_NODE,
          toNode: ACQ_FIELD_NODE,
          edgeType: 'success',
          predicateRef: null,
          joinSemantics: null,
        },
        {
          fromNode: ACQ_DIGITAL_NODE,
          toNode: ACQ_JOIN_NODE,
          edgeType: 'join',
          predicateRef: null,
          joinSemantics: 'all',
        },
        {
          fromNode: ACQ_FIELD_NODE,
          toNode: ACQ_JOIN_NODE,
          edgeType: 'join',
          predicateRef: null,
          joinSemantics: 'all',
        },
        {
          fromNode: ACQ_JOIN_NODE,
          toNode: ACQ_TERMINAL_NODE,
          edgeType: 'success',
          predicateRef: null,
          joinSemantics: null,
        },
      ],
    },
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'the pilot Goal the instance operationalizes' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        pilot_concluded: {
          type: 'boolean',
          description: 'the pilot instance concluded through the experiment authority',
        },
      },
      required: [],
    },
    retryPolicyDefaults: { maxAttempts: 2, backoffMs: null },
    concurrencyLimits: { maxConcurrentWorkflows: 1, maxConcurrentNodes: 2 },
    timeoutPolicy: { defaultTimeoutSeconds: 300, maxTimeoutSeconds: 3600 },
    compensation: [],
  };
}

// ---------------------------------------------------------------------------
// 3. The §18 field job descriptor (→ /jobs projectJob descriptor)
// ---------------------------------------------------------------------------

/**
 * The §18 field job descriptor the pilot pins: the public title/description
 * plus the PROFILE-DATA-ONLY eligibility spec (specialization, capability
 * tags, territory, availability window) — NO Client-specific data
 * (human-agent-v1.3.md §3; FIELD-AC-02).
 */
export function buildFieldJobDescriptor(): JobDescriptor {
  return {
    title: 'Acquisition pilot — field visit',
    description:
      'Visit the pilot target, record structured field observations and capture the field evidence backing the pilot outcome. One bounded visit per pilot instance.',
    eligibility: {
      specialization: 'field_agent',
      requiredCapabilities: ['canvassing'],
      territory: { kind: 'city', value: 'accra' },
      availability: { dayOfWeek: 2, startMinute: 480, endMinute: 1080 },
    },
  };
}

// ---------------------------------------------------------------------------
// 4. The evidence capture points (declared; recorded through /evidence)
// ---------------------------------------------------------------------------

/**
 * One declared evidence capture point: WHERE in the pilot flow an /evidence
 * record is appended, under WHICH frozen class/quality, and through WHICH
 * authority surface. Declared data only — the appends go through the
 * authority public contracts (§18 captureVisitEvidence for the field leg,
 * the /evidence surface for the commissioning-side outcome backing).
 */
export interface EvidenceCapturePoint {
  readonly stage: 'digital_execution' | 'field_visit' | 'pilot_outcome';
  readonly surface: '/jobs (§18 captureVisitEvidence)' | '/evidence (appendEvidence)';
  readonly evidenceClass: 'observation' | 'source_fact';
  readonly quality: 'C' | 'B';
  readonly description: string;
}

/** The pilot's declared evidence capture points (the E2E-001 evidence chain). */
export const ACQ_EVIDENCE_CAPTURE_POINTS: readonly EvidenceCapturePoint[] = [
  {
    stage: 'digital_execution',
    surface: '/evidence (appendEvidence)',
    evidenceClass: 'observation',
    quality: 'C',
    description:
      'The digital outreach run artifact (content-addressed pooled output) is recorded as an observation-class evidence row referenced by the pilot outcome metrics.',
  },
  {
    stage: 'field_visit',
    surface: '/jobs (§18 captureVisitEvidence)',
    evidenceClass: 'observation',
    quality: 'C',
    description:
      'The accepted field agent captures visit observations during execution — actor-attributed submission, claims stay claims (EVID-AC-03).',
  },
  {
    stage: 'pilot_outcome',
    surface: '/evidence (appendEvidence)',
    evidenceClass: 'source_fact',
    quality: 'B',
    description:
      'The commissioning side records the authoritative pilot outcome facts the experiment conclusion cites (same-Client, DB-fenced).',
  },
];

// ---------------------------------------------------------------------------
// 5. The experiment declaration (§16 — → /experiments public)
// ---------------------------------------------------------------------------

/**
 * The §16 experiment declaration payload (minus the ownership scope the
 * wiring service derives from the Goal). Design honesty: a single-arm
 * prove-it-first pilot is a QUASI-EXPERIMENTAL pre/post window comparison;
 * the pilot conclusion records an OBSERVATION (never a causal claim — the
 * frozen causal evidence standard), and uncertainty is declared as an
 * interval.
 */
export function buildExperimentDeclaration(): Omit<ExperimentCreateInput, 'clientId' | 'workspaceId'> {
  return {
    hypothesis:
      'A bounded acquisition pilot — one digital outreach execution plus one field visit per instance — produces qualified leads for an active Goal within the declared cost guardrail.',
    decisionTarget:
      'Whether to extend the acquisition motion beyond the prove-it-first pilot (scale, adjust, or stop).',
    populationUnit: 'pilot instance (one bounded Goal/Workflow cohort)',
    treatment: 'acquisition pilot instance: one digital outreach execution plus one field visit',
    comparison: 'pilot baseline: the Goal state before the pilot window (single-arm bounded pilot)',
    assignmentMethod: 'manual single-arm pilot assignment — every pilot instance receives the treatment',
    designType: 'quasi_experimental',
    primaryMetric: ACQ_PRIMARY_METRIC,
    guardrails: [ACQ_GUARDRAIL_COST],
    analysisMethod: 'pilot_window_comparison',
    analysisMethodVersion: '1',
    expectedDirection: 'increase',
    startCriteria:
      'the Goal is active and the pilot template is deployed (playbook version PUBLISHED, workflow definition ACTIVE, experiment declared)',
    stopCriteria:
      'stop when any guardrail threshold is breached, when the instance cap is reached, or when the Goal leaves the active state; stopping blocks future instance selection only and never rewrites recorded history',
    minimumEvidenceRequirement:
      'B — strong quasi-experimental evidence at minimum (pilot window comparison with recorded field evidence)',
    uncertaintyRepresentation: 'interval',
  };
}

// ---------------------------------------------------------------------------
// The whole template package (pure assembly of 1–5 + the bounds)
// ---------------------------------------------------------------------------

/** The complete acquisition pilot template package (PURE assembly). */
export interface AcquisitionPilotTemplate {
  readonly playbook: ReturnType<typeof buildPlaybookStrategy>;
  readonly workflowDefinition: ReturnType<typeof buildWorkflowDefinitionContent>;
  readonly fieldJob: ReturnType<typeof buildFieldJobDescriptor>;
  readonly evidenceCapturePoints: readonly EvidenceCapturePoint[];
  readonly experiment: ReturnType<typeof buildExperimentDeclaration>;
  readonly bounds: AcquisitionPilotBounds;
  readonly metricIdentities: readonly ExperimentMetricIdentity[];
}

/** The full template package — identical output on every call (pure). */
export function acquisitionPilotTemplate(): AcquisitionPilotTemplate {
  return {
    playbook: buildPlaybookStrategy(),
    workflowDefinition: buildWorkflowDefinitionContent(),
    fieldJob: buildFieldJobDescriptor(),
    evidenceCapturePoints: ACQ_EVIDENCE_CAPTURE_POINTS,
    experiment: buildExperimentDeclaration(),
    bounds: ACQUISITION_PILOT_BOUNDS,
    metricIdentities: ACQ_METRIC_IDENTITIES,
  };
}

// ---------------------------------------------------------------------------
// 6. Pure guardrail + primary-metric evaluation over /metrics observations
// ---------------------------------------------------------------------------

/** Exact dimension-set + value equality (the series identity, §15/§16). */
function dimensionsMatch(
  observed: Readonly<Record<string, string | number | boolean>>,
  declared: Readonly<Record<string, string | number | boolean>>,
): boolean {
  const observedKeys = Object.keys(observed).sort();
  const declaredKeys = Object.keys(declared).sort();
  if (observedKeys.length !== declaredKeys.length) return false;
  for (let index = 0; index < observedKeys.length; index += 1) {
    const key = observedKeys[index]!;
    if (key !== declaredKeys[index]) return false;
    if (observed[key] !== declared[key]) return false;
  }
  return true;
}

/** Sums the values of the observations matching the declared metric identity. */
export function metricTotal(
  observations: readonly PilotObservationView[],
  identity: ExperimentMetricIdentity,
): { total: number; unit: string | null } {
  let total = 0;
  let unit: string | null = null;
  for (const observation of observations) {
    if (observation.metricName !== identity.name) continue;
    if (!dimensionsMatch(observation.dimensions, identity.dimensions)) continue;
    total += observation.value;
    unit = observation.unit;
  }
  return { total, unit };
}

/**
 * PURE guardrail evaluation (§16 guardrails + primary metric over /metrics
 * observations ONLY): every declared guardrail metric identity is summed
 * over the matching observations and compared against its threshold from
 * the bounds; the primary metric is summed for the status snapshot. No
 * I/O, no clock, no state — the same observations always evaluate to the
 * same result (pinned by unit tests).
 */
export function evaluatePilotGuardrails(
  observations: readonly PilotObservationView[],
  bounds: AcquisitionPilotBounds,
): PilotGuardrailEvaluation {
  const template = acquisitionPilotTemplate();
  const primary = metricTotal(observations, template.experiment.primaryMetric);
  const guardrails: PilotGuardrailResult[] = [];
  let breached = false;
  for (const guardrailIdentity of template.experiment.guardrails) {
    const { total, unit } = metricTotal(observations, guardrailIdentity);
    const threshold = bounds.guardrailThresholds[guardrailIdentity.name];
    const isBreached = threshold !== undefined && total > threshold;
    if (isBreached) breached = true;
    guardrails.push({
      name: guardrailIdentity.name,
      dimensions: guardrailIdentity.dimensions,
      unit,
      totalValue: total,
      threshold: threshold ?? Number.POSITIVE_INFINITY,
      breached: isBreached,
    });
  }
  return {
    primaryMetric: template.experiment.primaryMetric,
    primaryMetricTotal: primary.total,
    guardrails,
    breached,
  };
}
