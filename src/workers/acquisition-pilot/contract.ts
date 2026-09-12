/**
 * MKT-028 — ACQUISITION PILOT FLOW (work-items.md: "bounded prove-it-first
 * acquisition pilots connecting Goal → Workflow → digital/field execution →
 * outcomes → decision"; requirements.md E2E-001 "Prove an end-to-end goal →
 * workflow → AI/human/extension execution → evidence → experiment/
 * measurement → learning flow without bypassing authority boundaries";
 * acceptance: "pilot end-to-end evidence" + E2E-AC-01).
 *
 * COMPOSITION TYPES + NODE ID CONSTANTS for the acquisition-pilot template
 * package and wiring service (src/workers/acquisition-pilot/).
 *
 * ARCHITECTURAL PLACEMENT (frozen-conformant, deliberately NOT a module):
 * implementation-contract §1 — "there is no /pilots authority". A pilot is a
 * BOUNDED COMPOSITION over the existing authorities:
 *
 *   Goal (/goals) → Playbook Version (/playbooks) → Workflow Definition
 *   (/workflows) → digital Execution (/executions + the MKT-011 pooled
 *   worker path) + field Job/Visit/Outcome (/jobs, §18) → Evidence
 *   (/evidence) → Metric observations (/metrics) → Experiment decision
 *   (/experiments, §16).
 *
 * The pilot owns NO authority state: every derived status is re-computed
 * from the underlying authorities' durable state on each call (the /reporting
 * MKT-030 posture). The service composes ONLY frozen module public
 * contracts — the same discipline as src/workers/pooled/ (the MKT-011
 * precedent: a workers-area composition service, never a second authority).
 *
 * This file is TYPES AND CONSTANTS ONLY — no runtime behavior, no imports
 * beyond module public-contract TYPES (pinned by
 * tests/architecture/acquisition-pilot-boundary.test.ts).
 */

import type { ExperimentMetricIdentity } from '../../modules/experiments/public.ts';
import type { MetricObservationRecord } from '../../modules/metrics/public.ts';

// ---------------------------------------------------------------------------
// Template node identity — the pinned node ids of the acquisition-pilot
// workflow graph (the coordinates the §7 task linkage and the §18 field job
// projection reference; constants so the template, the wiring and the tests
// can never drift apart).
// ---------------------------------------------------------------------------

/** The pilot staging entry: one `function` node — the single entry whose fan-out starts both legs. */
export const ACQ_ENTRY_NODE = 'acq_pilot_entry' as const;

/** The DIGITAL outreach node: one `ai_task` executed through the pooled worker path. */
export const ACQ_DIGITAL_NODE = 'acq_digital_outreach' as const;

/** The FIELD visit node: one `human_task` projected into a §18 field Job. */
export const ACQ_FIELD_NODE = 'acq_field_visit' as const;

/** The convergence point: `join` (all semantics) over the two execution legs. */
export const ACQ_JOIN_NODE = 'acq_pilot_join' as const;

/** The pilot outcome recorder: `terminal`. */
export const ACQ_TERMINAL_NODE = 'acq_pilot_outcome' as const;

/** Every node id of the acquisition-pilot workflow graph, in graph order. */
export const ACQ_NODE_IDS: readonly string[] = [
  ACQ_ENTRY_NODE,
  ACQ_DIGITAL_NODE,
  ACQ_FIELD_NODE,
  ACQ_JOIN_NODE,
  ACQ_TERMINAL_NODE,
];

// ---------------------------------------------------------------------------
// Boundedness — the pilot's declared bounds (E2E-001 "bounded" pilot; the
// §16 stop conditions made structural). PURE DATA: consumed by the wiring
// service's fail-closed checks and by the pure guardrail evaluation.
// ---------------------------------------------------------------------------

/**
 * The pilot bounds (the §16 experiment discipline as composition-level
 * invariants — the mechanism that keeps the pilot bounded and prove-it-first):
 *
 *   - `maxInstancesPerPilot` — the total instance budget: after this many
 *     workflow instances EVER existed for the pilot workflow, no further
 *     instance may start (append-only history counts every past instance);
 *   - `maxConcurrentInstances` — the live-instance cap: at most this many
 *     NON-TERMINAL pilot instances may exist at once;
 *   - `guardrailThresholds` — per guardrail metric NAME → maximum TOTAL
 *     observed value. A guardrail whose summed /metrics observations exceed
 *     its threshold is BREACHED: the breach is exposed through the pilot
 *     status evaluation and BLOCKS all future instance starts (fail closed).
 *
 * Every value is finite and positive — asserted by unit tests.
 */
export interface AcquisitionPilotBounds {
  readonly maxInstancesPerPilot: number;
  readonly maxConcurrentInstances: number;
  readonly guardrailThresholds: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Guardrail evaluation (pure) — over /metrics observations ONLY
// ---------------------------------------------------------------------------

/** The observed-value view of one /metrics observation the evaluation consumes. */
export interface PilotObservationView {
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string | number | boolean>>;
  readonly value: number;
  readonly unit: string;
}

/** One evaluated guardrail: the summed total against its declared threshold. */
export interface PilotGuardrailResult {
  readonly name: string;
  readonly dimensions: Readonly<Record<string, string | number | boolean>>;
  readonly unit: string | null;
  readonly totalValue: number;
  readonly threshold: number;
  readonly breached: boolean;
}

/** The full pilot measurement evaluation: guardrails + the primary metric total. */
export interface PilotGuardrailEvaluation {
  readonly primaryMetric: ExperimentMetricIdentity;
  readonly primaryMetricTotal: number;
  readonly guardrails: readonly PilotGuardrailResult[];
  readonly breached: boolean;
}

// ---------------------------------------------------------------------------
// Deployment + status (derived) — the pilot wiring surface shapes
// ---------------------------------------------------------------------------

/**
 * The pilot deployment descriptor: the EXPLICIT identities the deploy step
 * produced through the authority public contracts (every id is authority-
 * owned durable state; the pilot merely remembers the pinning). Used by
 * start/evaluate/status/conclude to re-derive everything from the
 * authorities on every call.
 */
export interface AcquisitionPilotDeployment {
  readonly goalId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly playbookId: string;
  readonly playbookVersionId: string;
  readonly workflowId: string;
  readonly workflowDefinitionId: string;
  readonly experimentId: string;
}

/** One derived pilot instance summary (workflow-instance state re-read). */
export interface PilotInstanceSummary {
  readonly workflowInstanceId: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly createdAt: string;
}

/**
 * The DERIVED pilot status snapshot — every field re-read from the
 * underlying authorities at call time (the pilot owns NO durable state).
 */
export interface AcquisitionPilotStatus {
  readonly deployment: AcquisitionPilotDeployment;
  readonly goalStatus: string;
  readonly playbookVersionStatus: string;
  readonly workflowDefinitionStatus: string;
  readonly experimentStatus: string;
  readonly experimentResultState: string;
  readonly resultingDecision: string | null;
  readonly instances: readonly PilotInstanceSummary[];
  readonly liveInstanceCount: number;
  readonly measurement: PilotGuardrailEvaluation;
}

/** The conclusion input for the pilot experiment (§16 conclude payload parts). */
export interface PilotConclusionInput {
  readonly resultState:
    | 'causal_supported'
    | 'causal_not_supported'
    | 'attribution'
    | 'observation'
    | 'inconclusive';
  readonly resultingDecision: string | null;
  /** Interval payload — MUST match the template's declared 'interval' representation. */
  readonly uncertaintyInterval: { readonly lower: number; readonly upper: number; readonly level: number };
  readonly assumptions: readonly string[];
  readonly sampleLimitations: readonly string[];
  readonly confounders: readonly string[];
  /** /evidence records cited by the conclusion (SAME Client — uniform 404 otherwise). */
  readonly evidenceRefs: readonly string[];
}

/** Server-side correlation labels the wiring service derives provenance from. */
export interface PilotCorrelationInput {
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * Coerces one /metrics observation record into the pure evaluation's view
 * shape (type-level bridge only — no data transformation).
 */
export function observationView(record: MetricObservationRecord): PilotObservationView {
  return {
    metricName: record.metricName,
    dimensions: record.dimensions,
    value: record.value,
    unit: record.unit,
  };
}
