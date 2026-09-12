/**
 * MKT-034 — THE END-TO-END ACQUISITION OPERATING LOOP (work-items.md:
 * "prove Goal → Playbook → Workflow → AI task → field Job → extension
 * action → Evidence → Experiment → Learning → Client Decision Room without
 * bypassing authority boundaries"; requirements.md E2E-001; acceptance
 * E2E-AC-01: "a complete pilot can execute using at least one AI path, one
 * human field-agent path, and one extension path with a shared
 * Goal/Workflow/Evidence lifecycle — end-to-end integration test").
 *
 * COMPOSITION TYPES + NODE ID CONSTANTS for the acquisition-loop template
 * package and wiring service (src/workers/acquisition-loop/).
 *
 * ARCHITECTURAL PLACEMENT (frozen-conformant, deliberately NOT a module —
 * the src/workers/acquisition-pilot/ MKT-028 precedent): implementation-
 * contract §1 — "there is no /pilots authority"; a loop is a BOUNDED
 * COMPOSITION over the existing authorities, one hop wider than the
 * MKT-028 pilot (the pilot proved Goal → digital/field execution →
 * decision; the loop adds the EXTENSION execution path, the AI RUNTIME
 * routing path and the LEARNING append, and is surfaced through the
 * read-only Client Decision Room):
 *
 *   Goal (/goals) → Playbook Version (/playbooks) → Workflow Definition
 *   (/workflows) → ONE workflow instance carrying the three execution
 *   legs — AI task (/executions + /ai-runtime routing), human field
 *   Job/Visit/Outcome (/jobs, §18), extension action (/extensions §19 +
 *   /executions pooled path) → Evidence (/evidence) → Metric observations
 *   (/metrics) → Experiment decision (/experiments, §16) → Learning
 *   (/learnings, §17) → Client Decision Room (/reporting, read-only).
 *
 * The loop owns NO authority state: every derived status is re-computed
 * from the underlying authorities' durable state on each call (the
 * /reporting MKT-030 posture). The service composes ONLY frozen module
 * public contracts — the same discipline as src/workers/acquisition-pilot/
 * (the MKT-028 precedent: a workers-area composition service, never a
 * second authority).
 *
 * This file is TYPES AND CONSTANTS ONLY — no runtime behavior, no imports
 * beyond module public-contract TYPES (pinned by
 * tests/architecture/acquisition-loop-boundary.test.ts).
 */

import type { ExperimentMetricIdentity } from '../../modules/experiments/public.ts';
import type { MetricObservationRecord } from '../../modules/metrics/public.ts';

// ---------------------------------------------------------------------------
// Template node identity — the pinned node ids of the acquisition-loop
// workflow graph (the coordinates the §7 task linkage, the §18 field job
// projection and the §19 extension invocation reference; constants so the
// template, the wiring and the tests can never drift apart).
// ---------------------------------------------------------------------------

/** The loop staging entry: one `function` node — the single entry whose fan-out starts all three legs. */
export const LOOP_ENTRY_NODE = 'acq_loop_entry' as const;

/** The AI leg node: one `ai_task` executed through the AI Runtime routing path. */
export const LOOP_AI_NODE = 'acq_loop_ai_scoring' as const;

/** The FIELD leg node: one `human_task` projected into a §18 field Job. */
export const LOOP_FIELD_NODE = 'acq_loop_field_visit' as const;

/** The EXTENSION leg node: one `extension_capability` action through the §19 invocation boundary. */
export const LOOP_EXTENSION_NODE = 'acq_loop_extension_sync' as const;

/** The convergence point: `join` (all semantics) over the three execution legs. */
export const LOOP_JOIN_NODE = 'acq_loop_join' as const;

/** The loop outcome recorder: `terminal`. */
export const LOOP_TERMINAL_NODE = 'acq_loop_outcome' as const;

/** Every node id of the acquisition-loop workflow graph, in graph order. */
export const LOOP_NODE_IDS: readonly string[] = [
  LOOP_ENTRY_NODE,
  LOOP_AI_NODE,
  LOOP_FIELD_NODE,
  LOOP_EXTENSION_NODE,
  LOOP_JOIN_NODE,
  LOOP_TERMINAL_NODE,
];

// ---------------------------------------------------------------------------
// Boundedness — the loop's declared bounds (E2E-001 "bounded"; the §16 stop
// conditions made structural — the same discipline as the MKT-028 pilot).
// ---------------------------------------------------------------------------

/**
 * The loop bounds (the §16 experiment discipline as composition-level
 * invariants — the mechanism that keeps the loop bounded and
 * prove-it-first):
 *
 *   - `maxInstancesPerLoop` — the total instance budget: after this many
 *     workflow instances EVER existed for the loop workflow, no further
 *     instance may start (append-only history counts every past instance);
 *   - `maxConcurrentInstances` — the live-instance cap: at most this many
 *     NON-TERMINAL loop instances may exist at once;
 *   - `guardrailThresholds` — per guardrail metric NAME → maximum TOTAL
 *     observed value. A guardrail whose summed /metrics observations exceed
 *     its threshold is BREACHED: the breach is exposed through the loop
 *     status evaluation and BLOCKS all future instance starts (fail closed).
 *
 * Every value is finite and positive — asserted by unit tests.
 */
export interface AcquisitionLoopBounds {
  readonly maxInstancesPerLoop: number;
  readonly maxConcurrentInstances: number;
  readonly guardrailThresholds: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Guardrail evaluation (pure) — over /metrics observations ONLY
// ---------------------------------------------------------------------------

/** The observed-value view of one /metrics observation the evaluation consumes. */
export interface LoopObservationView {
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string | number | boolean>>;
  readonly value: number;
  readonly unit: string;
}

/** One evaluated guardrail: the summed total against its declared threshold. */
export interface LoopGuardrailResult {
  readonly name: string;
  readonly dimensions: Readonly<Record<string, string | number | boolean>>;
  readonly unit: string | null;
  readonly totalValue: number;
  readonly threshold: number;
  readonly breached: boolean;
}

/** The full loop measurement evaluation: guardrails + the primary metric total. */
export interface LoopGuardrailEvaluation {
  readonly primaryMetric: ExperimentMetricIdentity;
  readonly primaryMetricTotal: number;
  readonly guardrails: readonly LoopGuardrailResult[];
  readonly breached: boolean;
}

// ---------------------------------------------------------------------------
// Deployment + status (derived) — the loop wiring surface shapes
// ---------------------------------------------------------------------------

/**
 * The loop deployment descriptor: the EXPLICIT identities the deploy step
 * produced through the authority public contracts (every id is
 * authority-owned durable state; the loop merely remembers the pinning).
 * Used by start/evaluate/status/conclude/learn to re-derive everything
 * from the authorities on every call. The EXTENSION identity is
 * deliberately NOT part of the descriptor: the extension version is
 * published, reviewed, installed and authorized through the MKT-032/MKT-022
 * boundary by the loop's CALLERS — the loop composes authorities, it never
 * becomes an extension marketplace authority.
 */
export interface AcquisitionLoopDeployment {
  readonly goalId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly playbookId: string;
  readonly playbookVersionId: string;
  readonly workflowId: string;
  readonly workflowDefinitionId: string;
  readonly experimentId: string;
}

/** One derived loop instance summary (workflow-instance state re-read). */
export interface LoopInstanceSummary {
  readonly workflowInstanceId: string;
  readonly status: string;
  readonly terminal: boolean;
  readonly createdAt: string;
}

/** One derived Learning summary on the loop status (re-read from /learnings). */
export interface LoopLearningSummary {
  readonly learningId: string;
  readonly status: string;
  readonly statement: string;
}

/**
 * The DERIVED loop status snapshot — every field re-read from the
 * underlying authorities at call time (the loop owns NO durable state).
 * The learnings list is the /learnings append surface's own view of the
 * client's Learning ledger — surfaced so the loop status closes the full
 * Goal → … → Learning chain without the loop storing anything.
 */
export interface AcquisitionLoopStatus {
  readonly deployment: AcquisitionLoopDeployment;
  readonly goalStatus: string;
  readonly playbookVersionStatus: string;
  readonly workflowDefinitionStatus: string;
  readonly experimentStatus: string;
  readonly experimentResultState: string;
  readonly resultingDecision: string | null;
  readonly instances: readonly LoopInstanceSummary[];
  readonly liveInstanceCount: number;
  readonly learnings: readonly LoopLearningSummary[];
  readonly measurement: LoopGuardrailEvaluation;
}

/** The conclusion input for the loop experiment (§16 conclude payload parts). */
export interface LoopConclusionInput {
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

/** The Learning append input for the loop's final §17 hop (→ /learnings). */
export interface LoopLearningInput {
  readonly statement: string;
  readonly applicability: Readonly<Record<string, string | number | boolean>>;
  /** /evidence records cited by the Learning (SAME Client — uniform 404 otherwise). */
  readonly evidenceRefs: readonly string[];
  /** /experiments records cited (SAME Client, must be CONCLUDED — LEARN-AC-01). */
  readonly experimentRefs: readonly string[];
  readonly confidence: number | null;
}

/** Server-side correlation labels the wiring service derives provenance from. */
export interface LoopCorrelationInput {
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * Coerces one /metrics observation record into the pure evaluation's view
 * shape (type-level bridge only — no data transformation).
 */
export function observationView(record: MetricObservationRecord): LoopObservationView {
  return {
    metricName: record.metricName,
    dimensions: record.dimensions,
    value: record.value,
    unit: record.unit,
  };
}
