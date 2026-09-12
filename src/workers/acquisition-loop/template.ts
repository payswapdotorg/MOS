/**
 * MKT-034 — THE ACQUISITION LOOP TEMPLATE PACKAGE (the bounded template the
 * wiring service drives through the /playbooks and /workflows public
 * contracts; the MKT-028 acquisition-pilot template discipline, widened to
 * the three execution legs of E2E-AC-01).
 *
 * PURE DATA + PURE FUNCTIONS. This file contains NO I/O, NO module value
 * imports (module contracts appear as TYPE imports only) and NO state: the
 * template is assembled by pure builder functions whose outputs are fed to
 * the /playbooks, /workflows, /jobs, /extensions and /experiments public
 * contracts by the WIRING service (loop-flow.ts) and the loop's callers.
 * Template purity is pinned by unit tests and by the static boundary tests.
 *
 * The package pins, in ONE place:
 *
 *   1. the PLAYBOOK STRATEGY plus its declarative deployment metadata —
 *      the loop REQUIRES one extension capability (the §19 leg) and the
 *      pooled-worker runtime class (the MKT-011 default runtime the
 *      extension execution rides);
 *   2. the WORKFLOW DEFINITION CONTENT — a frozen-contract §4 typed graph:
 *      one `ai_task` scoring node (the AI Runtime leg), one `human_task`
 *      field visit node (the §18 field Job projection target), one
 *      `extension_capability` audience-sync node (the §19 extension action
 *      target), an `all`-semantics `join` over the three legs and a
 *      `terminal` outcome recorder. The graph is validated by the
 *      /workflows authority validator itself (unit test: zero problems);
 *   3. the FIELD JOB DESCRIPTOR (§18): the public title/description and
 *      the profile-data-only eligibility spec the /jobs projection carries
 *      — NO Client-specific data (human-agent-v1.3.md §3);
 *   4. the EXTENSION MANIFEST (§2 of extension-model.md): the manifest of
 *      the extension version whose `extension_capability` node the loop
 *      drives through the MKT-032/MKT-022 boundary (publish → permission
 *      review → install → configure → authorize → invoke). The manifest is
 *      DECLARED DATA ONLY — publication happens through the /extensions
 *      authority by the loop's callers, never here;
 *   5. the EVIDENCE CAPTURE POINTS: the declared classes/qualities the
 *      loop's execution legs record through /evidence (field observations
 *      through the §18 capture surface; commissioning-side leg evidence
 *      through the /evidence append surface);
 *   6. the EXPERIMENT DECLARATION (§16): the full frozen contract — the
 *      loop hypothesis covers all three execution paths, the primary
 *      metric and the cost guardrail;
 *   7. the BOUNDS (E2E-001 "bounded"): instance cap, live-instance cap and
 *      guardrail thresholds — the structural stop conditions the wiring
 *      service enforces fail-closed BEFORE any write;
 *   8. the METRIC IDENTITIES: the primary metric and guardrail metric
 *      name+dimension sets the loop's /metrics observations and /metrics
 *      evaluation are keyed by.
 */

import type { PlaybookStrategy, PlaybookDeploymentMetadata } from '../../modules/playbooks/public.ts';
import type { WorkflowDefinitionContent } from '../../modules/workflows/public.ts';
import type { ExperimentCreateInput, ExperimentMetricIdentity } from '../../modules/experiments/public.ts';
import type { JobDescriptor } from '../../modules/jobs/public.ts';
import type { ExtensionManifest } from '../../modules/extensions/public.ts';
import {
  LOOP_AI_NODE,
  LOOP_ENTRY_NODE,
  LOOP_EXTENSION_NODE,
  LOOP_FIELD_NODE,
  LOOP_JOIN_NODE,
  LOOP_TERMINAL_NODE,
  type AcquisitionLoopBounds,
  type LoopGuardrailEvaluation,
  type LoopGuardrailResult,
  type LoopObservationView,
} from './contract.ts';

// ---------------------------------------------------------------------------
// The template's metric identities — BY NAME + DIMENSIONS (§16: never a
// provider metric id; experiments are declared before observations exist)
// ---------------------------------------------------------------------------

/** The loop's PRIMARY metric: qualified leads attributed to the loop cohort. */
export const LOOP_PRIMARY_METRIC: ExperimentMetricIdentity = {
  name: 'loop_qualified_leads',
  dimensions: { loop: 'acquisition' },
};

/** The loop's GUARDRAIL metric: total loop cost (USD). */
export const LOOP_GUARDRAIL_COST: ExperimentMetricIdentity = {
  name: 'loop_cost_usd',
  dimensions: { loop: 'acquisition' },
};

/** Every metric identity the loop declares (primary first, then guardrails). */
export const LOOP_METRIC_IDENTITIES: readonly ExperimentMetricIdentity[] = [
  LOOP_PRIMARY_METRIC,
  LOOP_GUARDRAIL_COST,
];

// ---------------------------------------------------------------------------
// The bounds (E2E-001 "bounded" — the §16 stop conditions, structural)
// ---------------------------------------------------------------------------

/** The frozen loop bounds: 3 instances ever, 1 live at a time, ≤ 500 USD total cost. */
export const ACQUISITION_LOOP_BOUNDS: AcquisitionLoopBounds = {
  maxInstancesPerLoop: 3,
  maxConcurrentInstances: 1,
  guardrailThresholds: {
    [LOOP_GUARDRAIL_COST.name]: 500,
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
        'End-to-end acquisition operating loop: one bounded Goal cohort driven through one AI-scored outreach task, one field visit and one extension audience-sync action, measured on qualified leads against a hard cost guardrail, concluded through the declared experiment and recorded as a Learning.',
      templates: [
        {
          name: 'acquisition-loop-flow',
          description:
            'Goal → deployed loop template → one ai_task (AI Runtime routing) + one human_task field visit (§18 Job) + one extension_capability audience sync (§19 invocation) → evidence + metrics → experiment decision → Learning.',
        },
      ],
    },
    deploymentMetadata: {
      // The loop composes core authorities plus exactly ONE extension
      // capability (the §19 leg) — no Domain Pack requirement.
      requiredDomainPacks: [],
      requiredCapabilities: [
        { kind: 'extension', name: 'acq-audience-sync', versionConstraint: '1.x' },
      ],
      runtimeRequirements: { runtimeClass: 'pooled-worker' },
      triggers: [{ kind: 'manual', config: null }],
    },
  };
}

// ---------------------------------------------------------------------------
// 2. The workflow definition content (→ /workflows public, §4 contract)
// ---------------------------------------------------------------------------

/**
 * The loop workflow definition content — the §4 typed graph:
 *
 *   acq_loop_entry (function) ──success──> acq_loop_ai_scoring (ai_task) ──────join(all)──┐
 *          │                                                                              ├── acq_loop_join (join, all) ──success──> acq_loop_outcome (terminal)
 *          ├──────────────success──────> acq_loop_field_visit (human_task) ──join(all)──┤
 *          └──────────────success──────> acq_loop_extension_sync (extension_capability) ┘
 *
 * ONE deterministic entry (the §4 single-entry rule: parallel starts are
 * fan-out from the single entry) staging the cohort, fanning out into the
 * AI, field and extension legs, converging at an `all`-semantics join and
 * recording the outcome at the terminal. THE THREE PATHS RUN UNDER ONE
 * WORKFLOW LIFECYCLE (E2E-AC-01 "a shared Goal/Workflow/Evidence
 * lifecycle"). Validated by the /workflows authority validator
 * (validateWorkflowDefinitionContent returns ZERO problems — pinned by
 * unit test).
 */
export function buildWorkflowDefinitionContent(): WorkflowDefinitionContent {
  return {
    graph: {
      nodes: [
        {
          nodeId: LOOP_ENTRY_NODE,
          nodeType: 'function',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              cohort_staged: {
                type: 'boolean',
                description: 'the loop cohort inputs were staged for all three execution legs',
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
          nodeId: LOOP_AI_NODE,
          nodeType: 'ai_task',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              qualified_count: {
                type: 'number',
                description: 'qualified prospects attributed by the AI scoring run',
              },
              top_prospect: {
                type: 'string',
                description: 'the highest-scoring prospect of the run',
              },
            },
            required: [],
          },
          executionPolicyRef: null,
          retryPolicy: { maxAttempts: 2, backoffMs: null },
          timeout: { seconds: 300 },
          // §8 idempotency key strategy: stable per (workflow instance, node)
          // — the routed task derives its logical identity from exactly these
          // coordinates, so replays converge.
          idempotencyKeyStrategy: 'workflow',
          humanApproval: null,
          join: null,
          loop: null,
        },
        {
          nodeId: LOOP_FIELD_NODE,
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
          nodeId: LOOP_EXTENSION_NODE,
          nodeType: 'extension_capability',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              synced_count: {
                type: 'number',
                description: 'audience members synced by the extension action',
              },
            },
            required: [],
          },
          executionPolicyRef: null,
          retryPolicy: { maxAttempts: 2, backoffMs: null },
          timeout: { seconds: 300 },
          idempotencyKeyStrategy: 'workflow',
          humanApproval: null,
          join: null,
          loop: null,
        },
        {
          nodeId: LOOP_JOIN_NODE,
          nodeType: 'join',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              all_legs_settled: {
                type: 'boolean',
                description: 'all three loop execution legs reached the join',
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
            predecessors: [LOOP_AI_NODE, LOOP_FIELD_NODE, LOOP_EXTENSION_NODE],
            threshold: null,
          },
          loop: null,
        },
        {
          nodeId: LOOP_TERMINAL_NODE,
          nodeType: 'terminal',
          inputMapping: {},
          outputSchema: {
            type: 'object',
            properties: {
              loop_outcome_recorded: {
                type: 'boolean',
                description: 'the loop outcome was recorded through the authorities',
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
          fromNode: LOOP_ENTRY_NODE,
          toNode: LOOP_AI_NODE,
          edgeType: 'success',
          predicateRef: null,
          joinSemantics: null,
        },
        {
          fromNode: LOOP_ENTRY_NODE,
          toNode: LOOP_FIELD_NODE,
          edgeType: 'success',
          predicateRef: null,
          joinSemantics: null,
        },
        {
          fromNode: LOOP_ENTRY_NODE,
          toNode: LOOP_EXTENSION_NODE,
          edgeType: 'success',
          predicateRef: null,
          joinSemantics: null,
        },
        {
          fromNode: LOOP_AI_NODE,
          toNode: LOOP_JOIN_NODE,
          edgeType: 'join',
          predicateRef: null,
          joinSemantics: 'all',
        },
        {
          fromNode: LOOP_FIELD_NODE,
          toNode: LOOP_JOIN_NODE,
          edgeType: 'join',
          predicateRef: null,
          joinSemantics: 'all',
        },
        {
          fromNode: LOOP_EXTENSION_NODE,
          toNode: LOOP_JOIN_NODE,
          edgeType: 'join',
          predicateRef: null,
          joinSemantics: 'all',
        },
        {
          fromNode: LOOP_JOIN_NODE,
          toNode: LOOP_TERMINAL_NODE,
          edgeType: 'success',
          predicateRef: null,
          joinSemantics: null,
        },
      ],
    },
    inputSchema: {
      type: 'object',
      properties: {
        goal_id: { type: 'string', description: 'the loop Goal the instance operationalizes' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        loop_concluded: {
          type: 'boolean',
          description: 'the loop instance concluded through the experiment authority',
        },
      },
      required: [],
    },
    retryPolicyDefaults: { maxAttempts: 2, backoffMs: null },
    concurrencyLimits: { maxConcurrentWorkflows: 1, maxConcurrentNodes: 3 },
    timeoutPolicy: { defaultTimeoutSeconds: 300, maxTimeoutSeconds: 3600 },
    compensation: [],
  };
}

// ---------------------------------------------------------------------------
// 3. The §18 field job descriptor (→ /jobs projectJob descriptor)
// ---------------------------------------------------------------------------

/**
 * The §18 field job descriptor the loop pins: the public title/description
 * plus the PROFILE-DATA-ONLY eligibility spec (specialization, capability
 * tags, territory, availability window) — NO Client-specific data
 * (human-agent-v1.3.md §3; FIELD-AC-02).
 */
export function buildFieldJobDescriptor(): JobDescriptor {
  return {
    title: 'Acquisition loop — field visit',
    description:
      'Visit the loop target, record structured field observations and capture the field evidence backing the loop outcome. One bounded visit per loop instance.',
    eligibility: {
      specialization: 'field_agent',
      requiredCapabilities: ['canvassing'],
      territory: { kind: 'city', value: 'accra' },
      availability: { dayOfWeek: 2, startMinute: 480, endMinute: 1080 },
    },
  };
}

// ---------------------------------------------------------------------------
// 4. The extension manifest (§2 — DECLARED DATA; published through the
//    /extensions authority by the loop's callers, never here)
// ---------------------------------------------------------------------------

/**
 * The manifest of the extension version the loop's §19 leg drives through
 * the MKT-032/MKT-022 boundary. The `extension_capability` node of the
 * workflow graph names this extension's `sync-audience-segment`
 * capability; the manifest declares the least-privilege posture:
 *
 *   - one execution-action capability (the invocable unit the §19
 *     invocation requests by NAME);
 *   - one measurement capability (the synced-count observation the leg
 *     reports back);
 *   - permissions limited to data:read/data:write of the OWNING client's
 *     data (the closed §5 vocabulary has no workflow-state, credential or
 *     evidence-provenance action at all);
 *   - one required secret LOGICAL NAME (the CRED-001 posture: the
 *     install-time configure step binds it to a credential REFERENCE,
 *     never material);
 *   - data scopes limited to client:read/client:write;
 *   - NO network egress requirement (the pooled-runtime execution of the
 *     leg is the MKT-011 generic path — the manifest is the frozen
 *     capability declaration, not a provider call);
 *   - runtime class pooled-worker (the runtime contract extension code
 *     executes under — /executions owns it).
 */
export function buildExtensionManifest(): ExtensionManifest {
  return {
    extensionKey: 'acq-audience-sync',
    publisher: 'payswap-labs',
    version: '1.0.0',
    compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
    capabilities: [
      { category: 'execution-action', name: 'sync-audience-segment' },
      { category: 'measurement', name: 'report-synced-count' },
    ],
    permissions: [
      { action: 'data:read', resource: 'audience-segments' },
      { action: 'data:write', resource: 'audience-segments' },
      { action: 'secret:use', resource: 'AUDIENCE_SYNC_KEY' },
    ],
    requiredSecretNames: ['AUDIENCE_SYNC_KEY'],
    dataScopes: ['client:read', 'client:write'],
    networkRequirements: [],
    runtimeClass: 'pooled-worker',
    inputContract: { required: ['segmentId'] },
    outputContract: { required: ['syncedCount'] },
    eventSubscriptions: [],
    uiSurfaces: [],
    configContract: {
      region: {
        type: 'string',
        required: true,
        description: 'The audience-sync region the extension operates in',
        pattern: '^(eu|us)$',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 5. The evidence capture points (declared; recorded through /evidence)
// ---------------------------------------------------------------------------

/**
 * One declared evidence capture point: WHERE in the loop flow an /evidence
 * record is appended, under WHICH frozen class/quality, and through WHICH
 * authority surface. Declared data only — the appends go through the
 * authority public contracts (§18 captureVisitEvidence for the field leg,
 * the /evidence surface for the commissioning-side leg backing).
 */
export interface LoopEvidenceCapturePoint {
  readonly stage: 'ai_execution' | 'field_visit' | 'extension_action' | 'loop_outcome';
  readonly surface: '/jobs (§18 captureVisitEvidence)' | '/evidence (appendEvidence)';
  readonly evidenceClass: 'observation' | 'source_fact';
  readonly quality: 'C' | 'B';
  readonly description: string;
}

/** The loop's declared evidence capture points (the E2E-AC-01 evidence chain). */
export const LOOP_EVIDENCE_CAPTURE_POINTS: readonly LoopEvidenceCapturePoint[] = [
  {
    stage: 'ai_execution',
    surface: '/evidence (appendEvidence)',
    evidenceClass: 'observation',
    quality: 'C',
    description:
      'The AI leg outcome: the validated model output of the routed prospect-scoring task, appended commissioning-side as an observation citing the routing decision.',
  },
  {
    stage: 'field_visit',
    surface: '/jobs (§18 captureVisitEvidence)',
    evidenceClass: 'observation',
    quality: 'C',
    description:
      'The field leg outcome: structured observations captured DURING the accepted visit by the field agent, with server-derived scope and field-agent provenance.',
  },
  {
    stage: 'extension_action',
    surface: '/evidence (appendEvidence)',
    evidenceClass: 'observation',
    quality: 'C',
    description:
      'The extension leg outcome: the §19 invocation-ledger reference and the pooled-run output artifact of the audience-sync action, appended commissioning-side.',
  },
  {
    stage: 'loop_outcome',
    surface: '/evidence (appendEvidence)',
    evidenceClass: 'source_fact',
    quality: 'B',
    description:
      'The commissioning-side loop outcome: the authoritative facts of all three legs and the measured totals, cited by the experiment conclusion and the Learning.',
  },
];

// ---------------------------------------------------------------------------
// 6. The §16 experiment declaration (→ /experiments public)
// ---------------------------------------------------------------------------

/** The loop's §16 experiment declaration (minus the server-derived scope). */
export function buildExperimentDeclaration(): Omit<ExperimentCreateInput, 'clientId' | 'workspaceId'> {
  return {
    hypothesis:
      'An end-to-end acquisition operating loop — one AI-scored outreach task, one field visit and one extension audience-sync action per instance under one workflow lifecycle — produces qualified leads for an active Goal within the declared cost guardrail.',
    decisionTarget:
      'Whether to extend the acquisition motion beyond the prove-it-first loop (scale, adjust, or stop).',
    populationUnit: 'loop instance (one bounded Goal/Workflow cohort)',
    treatment:
      'acquisition loop instance: one AI-scored outreach task + one field visit + one extension audience-sync action',
    comparison: 'loop baseline: the Goal state before the loop window (single-arm bounded loop)',
    assignmentMethod: 'manual single-arm loop assignment — every loop instance receives the treatment',
    designType: 'quasi_experimental',
    primaryMetric: LOOP_PRIMARY_METRIC,
    guardrails: [LOOP_GUARDRAIL_COST],
    analysisMethod: 'loop_window_comparison',
    analysisMethodVersion: '1',
    expectedDirection: 'increase',
    startCriteria:
      'the Goal is active and the loop template is deployed (playbook version PUBLISHED, workflow definition ACTIVE, experiment declared)',
    stopCriteria:
      'stop when any guardrail threshold is breached, when the instance cap is reached, or when the Goal leaves the active state; stopping blocks future instance selection only and never rewrites recorded history',
    minimumEvidenceRequirement:
      'B — strong quasi-experimental evidence at minimum (loop window comparison with recorded field evidence)',
    uncertaintyRepresentation: 'interval',
  };
}

// ---------------------------------------------------------------------------
// The whole template package (pure assembly of 1–6 + the bounds)
// ---------------------------------------------------------------------------

/** The complete acquisition loop template package (PURE assembly). */
export interface AcquisitionLoopTemplate {
  readonly playbook: ReturnType<typeof buildPlaybookStrategy>;
  readonly workflowDefinition: ReturnType<typeof buildWorkflowDefinitionContent>;
  readonly fieldJob: ReturnType<typeof buildFieldJobDescriptor>;
  readonly extensionManifest: ReturnType<typeof buildExtensionManifest>;
  readonly evidenceCapturePoints: readonly LoopEvidenceCapturePoint[];
  readonly experiment: ReturnType<typeof buildExperimentDeclaration>;
  readonly bounds: AcquisitionLoopBounds;
  readonly metricIdentities: readonly ExperimentMetricIdentity[];
}

/** The full template package — identical output on every call (pure). */
export function acquisitionLoopTemplate(): AcquisitionLoopTemplate {
  return {
    playbook: buildPlaybookStrategy(),
    workflowDefinition: buildWorkflowDefinitionContent(),
    fieldJob: buildFieldJobDescriptor(),
    extensionManifest: buildExtensionManifest(),
    evidenceCapturePoints: LOOP_EVIDENCE_CAPTURE_POINTS,
    experiment: buildExperimentDeclaration(),
    bounds: ACQUISITION_LOOP_BOUNDS,
    metricIdentities: LOOP_METRIC_IDENTITIES,
  };
}

// ---------------------------------------------------------------------------
// 7. Pure guardrail + primary-metric evaluation over /metrics observations
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
  observations: readonly LoopObservationView[],
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
export function evaluateLoopGuardrails(
  observations: readonly LoopObservationView[],
  bounds: AcquisitionLoopBounds,
): LoopGuardrailEvaluation {
  const template = acquisitionLoopTemplate();
  const primary = metricTotal(observations, template.experiment.primaryMetric);
  const guardrails: LoopGuardrailResult[] = [];
  let breached = false;
  for (const identity of template.experiment.guardrails) {
    const { total, unit } = metricTotal(observations, identity);
    const threshold = bounds.guardrailThresholds[identity.name] ?? Number.POSITIVE_INFINITY;
    const guardrailBreached = total > threshold;
    if (guardrailBreached) breached = true;
    guardrails.push({
      name: identity.name,
      dimensions: identity.dimensions,
      unit,
      totalValue: total,
      threshold,
      breached: guardrailBreached,
    });
  }
  return {
    primaryMetric: template.experiment.primaryMetric,
    primaryMetricTotal: primary.total,
    guardrails,
    breached,
  };
}
