/**
 * /experiments persistence (experiments + experiment_transitions tables —
 * migration 019, the MKT-015-reserved number).
 *
 * Two durable structures:
 *
 *   - `experiments`: ONE row per experiment. The DECLARED DESIGN columns
 *     (hypothesis … uncertainty_representation) are IMMUTABLE after insert —
 *     a BEFORE UPDATE trigger rejects any rewrite of them (only the
 *     lifecycle columns status/result_state/resulting_decision/concluded_at
 *     may change, and ONLY through legal frozen-state-machine edges — a
 *     second trigger). "Conclusion state must preserve the declared design
 *     and analysis metadata" (spec/state-machines.md).
 *   - `experiment_transitions`: the APPEND-ONLY lifecycle history — UPDATE
 *     and DELETE are rejected by triggers (the migration 015/018 pattern).
 *     The conclusion row retains the FULL conclusion payload (result state,
 *     uncertainty, assumptions, sample limitations, confounders, decision,
 *     evidence refs) verbatim — EXP-AC-03 retention.
 *
 * The database is the final backstop for every material invariant:
 *   - the closed enums (design type, result state, status, transition,
 *     uncertainty representation, expected direction) are CHECKs;
 *   - the CAUSAL EVIDENCE STANDARD is a row CHECK on BOTH tables: a causal
 *     result state can only coexist with a causal-capable design
 *     (randomized / controlled comparison / quasi-experimental);
 *   - the workspace scope must live inside the owning Client (trigger);
 *   - cited evidence refs must belong to the SAME Client (trigger).
 *
 * Provenance columns (recorded_actor, recorded_via, correlation_id,
 * causation_id, recorded_at) are written ONLY from the server-built
 * ExperimentProvenance argument — there is no other write path, and the
 * guards refuse to run with an incomplete provenance.
 *
 * The §21 secret-leak guard (re-exported from the /evidence public
 * contract — the frozen matrix allows /experiments ──→ /evidence) runs on
 * the metric-identity dimension payloads BEFORE insert: material-shaped
 * keys can never enter an experiment at any nesting level.
 */

import { InvalidRequestError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  ExperimentConclusion,
  ExperimentCreateInput,
  ExperimentMetricDimensionValue,
  ExperimentMetricIdentity,
  ExperimentProvenance,
  ExperimentRecord,
  ExperimentResultState,
  ExperimentTransition,
  ExperimentTransitionInput,
  ExperimentTransitionRecord,
  ExperimentUncertainty,
} from '../public.ts';
import {
  EXPERIMENT_TRANSITION_TABLE,
  isCausalResultState,
  isKnownExperimentDesignType,
  isKnownExperimentExpectedDirection,
  isKnownExperimentResultState,
  isKnownExperimentTransition,
  isKnownUncertaintyRepresentation,
  designSatisfiesCausalStandard,
} from '../public.ts';
// The ONE allowed cross-module import (frozen matrix: /experiments ──→
// /evidence, /metrics, /goals): the shared §21 material-key backstop from
// the /evidence public contract — a single source of truth for the
// forbidden key set.
import { containsMaterialKey } from '../../evidence/public.ts';

// ---------------------------------------------------------------------------
// Shape bounds (module-side; the DB CHECKs mirror the scalar ones)
// ---------------------------------------------------------------------------

const MAX_TEXT_100 = 100;
const MAX_TEXT_500 = 500;
const MAX_TEXT_2000 = 2000;
const MAX_METRIC_NAME_LENGTH = 200;
const MAX_DIMENSION_KEYS = 20;
const MAX_DIMENSION_KEY_LENGTH = 100;
const MAX_DIMENSION_VALUE_LENGTH = 256;
const MAX_GUARDRAILS = 20;
const MAX_ANALYSIS_METADATA_ITEMS = 50;
const MAX_ANALYSIS_METADATA_ITEM_LENGTH = 1000;
const MAX_EVIDENCE_REFS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface ExperimentRow extends DbRow {
  experiment_id: string;
  client_id: string;
  workspace_id: string | null;
  hypothesis: string;
  decision_target: string;
  population_unit: string;
  treatment: string;
  comparison: string;
  assignment_method: string;
  design_type: string;
  primary_metric: unknown;
  guardrails: unknown;
  analysis_method: string;
  analysis_method_version: string | null;
  expected_direction: string | null;
  start_criteria: string | null;
  stop_criteria: string;
  minimum_evidence_requirement: string;
  uncertainty_representation: string;
  status: string;
  result_state: string;
  resulting_decision: string | null;
  concluded_at: Date | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface ExperimentTransitionRow extends DbRow {
  transition_id: string;
  experiment_id: string;
  transition: string;
  from_status: string;
  to_status: string;
  conclusion: unknown;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const EXPERIMENT_SELECT = `
  SELECT e.experiment_id, e.client_id, e.workspace_id, e.hypothesis, e.decision_target,
         e.population_unit, e.treatment, e.comparison, e.assignment_method, e.design_type,
         e.primary_metric, e.guardrails, e.analysis_method, e.analysis_method_version,
         e.expected_direction, e.start_criteria, e.stop_criteria,
         e.minimum_evidence_requirement, e.uncertainty_representation, e.status, e.result_state,
         e.resulting_decision, e.concluded_at, e.recorded_actor, e.recorded_via,
         e.correlation_id, e.causation_id, e.recorded_at
  FROM experiments e
`;

// ---------------------------------------------------------------------------
// Pure guards (exported through the public contract)
// ---------------------------------------------------------------------------

/** Dimension values are scalars by construction (JSON-safe). */
function isScalarDimensionValue(value: unknown): value is ExperimentMetricDimensionValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

/**
 * Validates one declared metric identity (primary metric or guardrail):
 * named series + scalar dimension set, material-key clean (§21). Shared by
 * the create guard so the primary metric and every guardrail obey ONE shape.
 */
function metricIdentityProblems(
  label: string,
  identity: ExperimentMetricIdentity | null | undefined,
): string[] {
  const problems: string[] = [];
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    return [`${label}: a metric identity (name + dimensions) is required`];
  }
  if (
    typeof identity.name !== 'string' ||
    identity.name.trim() === '' ||
    identity.name.length > MAX_METRIC_NAME_LENGTH
  ) {
    problems.push(
      `${label}.name: a metric name between 1 and ${MAX_METRIC_NAME_LENGTH} characters is required`,
    );
  }
  if (
    identity.dimensions === null ||
    typeof identity.dimensions !== 'object' ||
    Array.isArray(identity.dimensions)
  ) {
    problems.push(`${label}.dimensions: must be a JSON object of dimension key → scalar value`);
    return problems;
  }
  const entries = Object.entries(identity.dimensions);
  if (entries.length > MAX_DIMENSION_KEYS) {
    problems.push(
      `${label}.dimensions: must carry at most ${MAX_DIMENSION_KEYS} dimension keys`,
    );
  }
  for (const [key, value] of entries) {
    if (key.trim() === '' || key.length > MAX_DIMENSION_KEY_LENGTH) {
      problems.push(
        `${label}.dimensions: dimension keys must be between 1 and ${MAX_DIMENSION_KEY_LENGTH} characters (found '${key}')`,
      );
    }
    if (!isScalarDimensionValue(value)) {
      problems.push(
        `${label}.dimensions.${key}: dimension values must be scalars (string, number or boolean)`,
      );
    } else if (typeof value === 'string' && value.length > MAX_DIMENSION_VALUE_LENGTH) {
      problems.push(
        `${label}.dimensions.${key}: string dimension values must be at most ${MAX_DIMENSION_VALUE_LENGTH} characters`,
      );
    }
  }
  // §21 defense in depth: material-shaped keys can never appear in the
  // metric-identity dimension payload.
  if (containsMaterialKey(identity.dimensions)) {
    problems.push(
      `${label}.dimensions: material-shaped keys can never appear in experiment payloads (implementation-contract §21)`,
    );
  }
  return problems;
}

function boundedTextProblems(
  label: string,
  value: string | null | undefined,
  options: { readonly required: true; readonly max: number }
    | { readonly required: false; readonly max: number },
): string[] {
  if (typeof value !== 'string' || value.trim() === '') {
    if (options.required) return [`${label}: a non-empty value is required`];
    return value === null || value === undefined
      ? []
      : [`${label}: must be a non-empty string when present`];
  }
  if (value.length > options.max) {
    return [`${label}: must be at most ${options.max} characters`];
  }
  return [];
}

/**
 * Pure declaration guard at the authority boundary: the module never
 * persists an experiment that violates the frozen §16 Experiment contract,
 * whatever the caller did upstream. Mirrors the DB CHECKs and adds the
 * per-field semantics the jsonb CHECKs cannot express (metric identity
 * shapes, guardrail bounds, §21 material-key rejection).
 */
export function assertValidExperimentCreate(input: ExperimentCreateInput): void {
  const problems: string[] = [];

  problems.push(
    ...boundedTextProblems('hypothesis', input.hypothesis, { required: true, max: MAX_TEXT_2000 }),
  );
  problems.push(
    ...boundedTextProblems('decisionTarget', input.decisionTarget, {
      required: true,
      max: MAX_TEXT_2000,
    }),
  );
  problems.push(
    ...boundedTextProblems('populationUnit', input.populationUnit, {
      required: true,
      max: MAX_TEXT_500,
    }),
  );
  problems.push(...boundedTextProblems('treatment', input.treatment, { required: true, max: MAX_TEXT_2000 }));
  problems.push(
    ...boundedTextProblems('comparison', input.comparison, { required: true, max: MAX_TEXT_2000 }),
  );
  problems.push(
    ...boundedTextProblems('assignmentMethod', input.assignmentMethod, {
      required: true,
      max: MAX_TEXT_500,
    }),
  );

  if (typeof input.designType !== 'string' || !isKnownExperimentDesignType(input.designType)) {
    problems.push('designType: must be one of the frozen declared design types (§16)');
  }

  problems.push(...metricIdentityProblems('primaryMetric', input.primaryMetric));

  if (
    input.guardrails === null ||
    typeof input.guardrails !== 'object' ||
    !Array.isArray(input.guardrails)
  ) {
    problems.push('guardrails: must be an array of guardrail metric identities (possibly empty)');
  } else {
    if (input.guardrails.length > MAX_GUARDRAILS) {
      problems.push(`guardrails: at most ${MAX_GUARDRAILS} guardrail metrics are supported`);
    }
    input.guardrails.forEach((guardrail, index) => {
      problems.push(...metricIdentityProblems(`guardrails[${index}]`, guardrail));
    });
  }

  problems.push(
    ...boundedTextProblems('analysisMethod', input.analysisMethod, {
      required: true,
      max: MAX_TEXT_500,
    }),
  );
  problems.push(
    ...boundedTextProblems('analysisMethodVersion', input.analysisMethodVersion, {
      required: false,
      max: MAX_TEXT_100,
    }),
  );

  if (input.expectedDirection !== null) {
    if (
      typeof input.expectedDirection !== 'string' ||
      !isKnownExperimentExpectedDirection(input.expectedDirection)
    ) {
      problems.push(
        'expectedDirection: must be one of the frozen expected directions when present',
      );
    }
  }

  problems.push(
    ...boundedTextProblems('startCriteria', input.startCriteria, {
      required: false,
      max: MAX_TEXT_2000,
    }),
  );
  problems.push(
    ...boundedTextProblems('stopCriteria', input.stopCriteria, { required: true, max: MAX_TEXT_2000 }),
  );
  problems.push(
    ...boundedTextProblems('minimumEvidenceRequirement', input.minimumEvidenceRequirement, {
      required: true,
      max: MAX_TEXT_500,
    }),
  );

  if (
    typeof input.uncertaintyRepresentation !== 'string' ||
    !isKnownUncertaintyRepresentation(input.uncertaintyRepresentation)
  ) {
    problems.push(
      'uncertaintyRepresentation: must be one of the frozen uncertainty representations',
    );
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('experiment rejected by the declaration guard', problems);
  }
}

function analysisMetadataProblems(
  label: string,
  items: readonly string[] | null | undefined,
): string[] {
  if (items === null || items === undefined) {
    return [`${label}: required (an array; empty when the analysis has none)`];
  }
  if (!Array.isArray(items)) {
    return [`${label}: must be an array of strings`];
  }
  if (items.length > MAX_ANALYSIS_METADATA_ITEMS) {
    return [`${label}: at most ${MAX_ANALYSIS_METADATA_ITEMS} items are retained`];
  }
  const problems: string[] = [];
  items.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      problems.push(`${label}[${index}]: non-empty strings only`);
    } else if (item.length > MAX_ANALYSIS_METADATA_ITEM_LENGTH) {
      problems.push(
        `${label}[${index}]: must be at most ${MAX_ANALYSIS_METADATA_ITEM_LENGTH} characters`,
      );
    }
  });
  return problems;
}

/**
 * The uncertainty payload must MATCH the DECLARED uncertainty
 * representation (EXP-AC-03 retention is representation-faithful): an
 * 'interval' design concludes with a finite-bounded interval, a
 * 'distribution' design with a descriptor, a 'qualitative' design with a
 * description, and a 'none' design with null — never a silently
 * transformed or dropped payload.
 */
function uncertaintyProblems(
  uncertainty: ExperimentUncertainty | null,
  representation: string,
): string[] {
  const problems: string[] = [];
  if (representation === 'none') {
    if (uncertainty !== null) {
      problems.push(
        'conclusion.uncertainty: this experiment declared the \'none\' uncertainty representation — the conclusion must carry null',
      );
    }
    return problems;
  }
  if (uncertainty === null || typeof uncertainty !== 'object') {
    return ['conclusion.uncertainty: required — this experiment declared a non-null uncertainty representation'];
  }
  if (uncertainty.kind !== representation) {
    problems.push(
      `conclusion.uncertainty.kind: must equal the declared uncertainty representation '${representation}'`,
    );
    return problems;
  }
  if (uncertainty.kind === 'interval') {
    const { lower, upper, level } = uncertainty;
    if (typeof lower !== 'number' || !Number.isFinite(lower)) {
      problems.push('conclusion.uncertainty.lower: a finite number is required');
    }
    if (typeof upper !== 'number' || !Number.isFinite(upper)) {
      problems.push('conclusion.uncertainty.upper: a finite number is required');
    }
    if (
      typeof lower === 'number' &&
      typeof upper === 'number' &&
      Number.isFinite(lower) &&
      Number.isFinite(upper) &&
      lower > upper
    ) {
      problems.push('conclusion.uncertainty: lower must not exceed upper');
    }
    if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0 || level >= 1) {
      problems.push('conclusion.uncertainty.level: a coverage level strictly between 0 and 1 is required');
    }
  } else if (uncertainty.kind === 'distribution') {
    if (typeof uncertainty.descriptor !== 'string' || uncertainty.descriptor.trim() === '') {
      problems.push('conclusion.uncertainty.descriptor: a non-empty distribution descriptor is required');
    } else if (uncertainty.descriptor.length > MAX_TEXT_500) {
      problems.push(`conclusion.uncertainty.descriptor: must be at most ${MAX_TEXT_500} characters`);
    }
  } else if (uncertainty.kind === 'qualitative') {
    if (typeof uncertainty.description !== 'string' || uncertainty.description.trim() === '') {
      problems.push('conclusion.uncertainty.description: a non-empty qualitative description is required');
    } else if (uncertainty.description.length > MAX_TEXT_2000) {
      problems.push(
        `conclusion.uncertainty.description: must be at most ${MAX_TEXT_2000} characters`,
      );
    }
  }
  return problems;
}

/**
 * Pure conclusion guard: the CLOSED result-state taxonomy (EXP-AC-02), the
 * causal evidence standard gate, uncertainty-representation matching, the
 * retained analysis metadata shapes and the evidence-citation shape.
 * `designType` is the experiment's IMMUTABLE declared design — the guard is
 * pure over (designType, declaredRepresentation, conclusion).
 */
export function assertValidExperimentConclusion(
  designType: string,
  declaredRepresentation: string,
  conclusion: ExperimentConclusion | null,
): void {
  const problems: string[] = [];
  if (conclusion === null || typeof conclusion !== 'object') {
    throw new InvalidRequestError(
      'experiment conclusion rejected: the conclude transition requires its conclusion payload',
      ['conclusion: required for the conclude transition'],
    );
  }

  // Widen to the runtime string: the closed-set membership (and the
  // exclusion of 'undecided' — a conclusion is never undecided) is a
  // RUNTIME guarantee the guard itself enforces.
  const resultState: string = conclusion.resultState;
  if (!isKnownExperimentResultState(resultState) || resultState === 'undecided') {
    problems.push(
      'conclusion.resultState: must be one of the closed conclusion types (causal_supported, causal_not_supported, attribution, observation, inconclusive)',
    );
  } else if (isCausalResultState(resultState)) {
    // THE CAUSAL EVIDENCE STANDARD (EXP-AC-02): a causal conclusion type
    // requires a declared design that satisfies the configured standard —
    // observational/descriptive designs can never carry one ("Do not claim
    // causality from observational correlation alone").
    if (
      typeof designType === 'string' &&
      isKnownExperimentDesignType(designType) &&
      !designSatisfiesCausalStandard(designType)
    ) {
      problems.push(
        `conclusion.resultState '${resultState}' requires a design satisfying the causal evidence standard (randomized, controlled comparison or quasi-experimental); the declared design '${designType}' cannot support a causal conclusion`,
      );
    }
  }

  problems.push(...uncertaintyProblems(conclusion.uncertainty, declaredRepresentation));
  problems.push(...analysisMetadataProblems('conclusion.assumptions', conclusion.assumptions));
  problems.push(
    ...analysisMetadataProblems('conclusion.sampleLimitations', conclusion.sampleLimitations),
  );
  problems.push(...analysisMetadataProblems('conclusion.confounders', conclusion.confounders));

  problems.push(
    ...boundedTextProblems('conclusion.resultingDecision', conclusion.resultingDecision, {
      required: false,
      max: MAX_TEXT_2000,
    }),
  );

  if (conclusion.evidenceRefs === null || conclusion.evidenceRefs === undefined) {
    problems.push('conclusion.evidenceRefs: required (an array; empty when nothing is cited)');
  } else if (!Array.isArray(conclusion.evidenceRefs)) {
    problems.push('conclusion.evidenceRefs: must be an array of /evidence record ids');
  } else {
    if (conclusion.evidenceRefs.length > MAX_EVIDENCE_REFS) {
      problems.push(`conclusion.evidenceRefs: at most ${MAX_EVIDENCE_REFS} evidence records may be cited`);
    }
    const seen = new Set<string>();
    conclusion.evidenceRefs.forEach((ref, index) => {
      if (typeof ref !== 'string' || !UUID_PATTERN.test(ref)) {
        problems.push(`conclusion.evidenceRefs[${index}]: must be an evidence record id (uuid)`);
      } else if (seen.has(ref)) {
        problems.push(`conclusion.evidenceRefs[${index}]: duplicate evidence reference`);
      } else {
        seen.add(ref);
      }
    });
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('experiment conclusion rejected by the conclusion guard', problems);
  }
}

/**
 * Pure transition-input guard: known transition, conclusion present exactly
 * when the transition is 'conclude', absent otherwise.
 */
export function assertValidExperimentTransitionInput(input: ExperimentTransitionInput): void {
  const problems: string[] = [];
  if (typeof input.transition !== 'string' || !isKnownExperimentTransition(input.transition)) {
    throw new InvalidRequestError(
      'experiment transition rejected: unknown lifecycle transition',
      ['transition: must be one of the frozen lifecycle transitions (mark_ready, start, begin_analysis, conclude, stop, invalidate)'],
    );
  }
  if (input.transition === 'conclude') {
    if (input.conclusion === null || input.conclusion === undefined) {
      problems.push('conclusion: required for the conclude transition');
    }
  } else if (input.conclusion !== null && input.conclusion !== undefined) {
    problems.push('conclusion: only the conclude transition carries a conclusion payload');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('experiment transition rejected', problems);
  }
}

/**
 * Provenance is server-derived and must be COMPLETE before any write: an
 * incomplete provenance fails closed (the rows' authority columns are never
 * defaulted from caller input). Mirrors the /evidence and /metrics guards.
 */
export function assertValidExperimentProvenance(provenance: ExperimentProvenance): void {
  const problems: string[] = [];
  if (provenance.actor.trim() === '') {
    problems.push('provenance.actor: a non-empty server-derived principal label is required');
  }
  if (provenance.recordedVia.trim() === '' || provenance.recordedVia.length > 100) {
    problems.push('provenance.recordedVia: a non-empty server-derived system label is required');
  }
  if (provenance.correlationId.trim() === '') {
    problems.push('provenance.correlationId: experiment mutations are correlation-linked');
  }
  if (provenance.causationId !== null && provenance.causationId.trim() === '') {
    problems.push('provenance.causationId: must be a non-empty identifier when present');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      'experiment mutation rejected: provenance is server-derived and must be complete',
      problems,
    );
  }
}

// ---------------------------------------------------------------------------
// Insert classification (DB-triggered invariants converged to domain errors)
// ---------------------------------------------------------------------------

/** Distinctive phrases of the migration 019 backstop triggers. */
const DESIGN_IMMUTABLE_MARKER = 'experiment declared design is immutable';
const STATUS_TRANSITION_MARKER = 'illegal experiment status transition';
const EVIDENCE_REFS_CROSS_TENANT_MARKER = 'cross-tenant evidence linkage is rejected';

export type ExperimentWriteConflict =
  | 'design-immutable'
  | 'status-transition'
  | 'evidence-refs-client';

/**
 * Classifies a postgres error on an experiments write into the module-level
 * domain error (the module pre-checks lost to a concurrent change — the DB
 * trigger won). Anything else propagates untouched.
 */
export function classifyExperimentWriteConflict(
  error: unknown,
): ExperimentWriteConflict | null {
  const candidate = error as { message?: string };
  if (candidate?.message === undefined) return null;
  if (candidate.message.includes(DESIGN_IMMUTABLE_MARKER)) return 'design-immutable';
  if (candidate.message.includes(STATUS_TRANSITION_MARKER)) return 'status-transition';
  if (candidate.message.includes(EVIDENCE_REFS_CROSS_TENANT_MARKER)) return 'evidence-refs-client';
  return null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ExperimentInsertRow {
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly hypothesis: string;
  readonly decisionTarget: string;
  readonly populationUnit: string;
  readonly treatment: string;
  readonly comparison: string;
  readonly assignmentMethod: string;
  readonly designType: string;
  readonly primaryMetric: ExperimentMetricIdentity;
  readonly guardrails: readonly ExperimentMetricIdentity[];
  readonly analysisMethod: string;
  readonly analysisMethodVersion: string | null;
  readonly expectedDirection: string | null;
  readonly startCriteria: string | null;
  readonly stopCriteria: string;
  readonly minimumEvidenceRequirement: string;
  readonly uncertaintyRepresentation: string;
}

export class ExperimentStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Inserts the declared experiment (DRAFT / undecided / decision null).
   * The DB triggers are the final backstops (workspace-within-client;
   * every enum CHECK; the causal-gate CHECK is trivially satisfied while
   * the result state is 'undecided').
   */
  async insertExperiment(
    row: ExperimentInsertRow,
    provenance: ExperimentProvenance,
  ): Promise<ExperimentRecord> {
    const experimentId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO experiments (experiment_id, client_id, workspace_id, hypothesis,
                             decision_target, population_unit, treatment, comparison,
                             assignment_method, design_type, primary_metric, guardrails,
                             analysis_method, analysis_method_version, expected_direction,
                             start_criteria, stop_criteria, minimum_evidence_requirement,
                             uncertainty_representation, status, result_state,
                             resulting_decision, concluded_at,
                             recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14,
               $15, $16, $17, $18, $19, 'draft', 'undecided', NULL, NULL,
               $20, $21, $22, $23, $24)`,
      [
        experimentId,
        row.clientId,
        row.workspaceId,
        row.hypothesis,
        row.decisionTarget,
        row.populationUnit,
        row.treatment,
        row.comparison,
        row.assignmentMethod,
        row.designType,
        JSON.stringify(row.primaryMetric),
        JSON.stringify(row.guardrails),
        row.analysisMethod,
        row.analysisMethodVersion,
        row.expectedDirection,
        row.startCriteria,
        row.stopCriteria,
        row.minimumEvidenceRequirement,
        row.uncertaintyRepresentation,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        recordedAt,
      ],
    );
    const created = await this.getExperiment(experimentId);
    if (created === null) {
      throw new Error(`declared experiment ${experimentId} could not be read back`);
    }
    return created;
  }

  async getExperiment(experimentId: string): Promise<ExperimentRecord | null> {
    const result = await this.db.query<ExperimentRow>(
      `${EXPERIMENT_SELECT} WHERE e.experiment_id = $1`,
      [experimentId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toExperimentRecord(row);
  }

  /**
   * The Client's experiments, newest first by server-recorded time
   * (bounded — the declared designs accumulate without end).
   */
  async listExperimentsForClient(
    clientId: string,
    limit = 500,
  ): Promise<readonly ExperimentRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<ExperimentRow>(
      `${EXPERIMENT_SELECT} WHERE e.client_id = $1
       ORDER BY e.recorded_at DESC, e.experiment_id LIMIT $2`,
      [clientId, bounded],
    );
    return result.rows.map(toExperimentRecord);
  }

  /**
   * Applies ONE lifecycle transition atomically: the experiments-row status
   * update (design columns untouched — the DB immutability trigger is the
   * backstop) plus the append-only history insert, in one transaction. The
   * caller has already validated the transition table + conclusion guard;
   * the DB triggers are the race backstops (legal-successor guard, causal
   * CHECK, evidence-refs trigger).
   */
  async applyTransition(
    experimentId: string,
    transition: ExperimentTransition,
    conclusion: ExperimentConclusion | null,
    provenance: ExperimentProvenance,
  ): Promise<ExperimentRecord> {
    const edge = EXPERIMENT_TRANSITION_TABLE[transition];
    const transitionId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    const conclusionJson =
      transition === 'conclude' && conclusion !== null ? JSON.stringify(conclusion) : null;

    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE experiments SET status = $2, result_state = $3, resulting_decision = $4,
                               concluded_at = $5
         WHERE experiment_id = $1`,
        [
          experimentId,
          edge.to,
          conclusion === null ? 'undecided' : conclusion.resultState,
          conclusion === null ? null : conclusion.resultingDecision,
          transition === 'conclude' ? recordedAt : null,
        ],
      );
      await tx.query(
        `INSERT INTO experiment_transitions (transition_id, experiment_id, transition,
                               from_status, to_status, conclusion,
                               recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
        [
          transitionId,
          experimentId,
          transition,
          edge.from,
          edge.to,
          conclusionJson,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          recordedAt,
        ],
      );
    });

    const updated = await this.getExperiment(experimentId);
    if (updated === null) {
      throw new Error(`transitioned experiment ${experimentId} could not be read back`);
    }
    return updated;
  }

  /**
   * The append-only transition history of one experiment, oldest first.
   * Cross-tenant experiment identifiers never reach the store (the module
   * resolves ownership first); the read is id-scoped only.
   */
  async listTransitionsForExperiment(
    experimentId: string,
    limit = 500,
  ): Promise<readonly ExperimentTransitionRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<ExperimentTransitionRow>(
      `SELECT t.transition_id, t.experiment_id, t.transition, t.from_status, t.to_status,
              t.conclusion, t.recorded_actor, t.recorded_via, t.correlation_id,
              t.causation_id, t.recorded_at
       FROM experiment_transitions t
       WHERE t.experiment_id = $1
       ORDER BY t.recorded_at ASC, t.transition_id LIMIT $2`,
      [experimentId, bounded],
    );
    return result.rows.map(toExperimentTransitionRecord);
  }
}

// ---------------------------------------------------------------------------
// Row → record mapping (byte-faithful round-trip; nothing is dropped)
// ---------------------------------------------------------------------------

type PersistedConclusion = {
  resultState: Exclude<ExperimentResultState, 'undecided'>;
  uncertainty: ExperimentUncertainty | null;
  assumptions: readonly string[];
  sampleLimitations: readonly string[];
  confounders: readonly string[];
  resultingDecision: string | null;
  evidenceRefs: readonly string[];
};

function toExperimentRecord(row: ExperimentRow): ExperimentRecord {
  return {
    experimentId: row.experiment_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    hypothesis: row.hypothesis,
    decisionTarget: row.decision_target,
    populationUnit: row.population_unit,
    treatment: row.treatment,
    comparison: row.comparison,
    assignmentMethod: row.assignment_method,
    designType: row.design_type as ExperimentRecord['designType'],
    primaryMetric: (row.primary_metric ?? {
      name: '',
      dimensions: {},
    }) as ExperimentMetricIdentity,
    guardrails: (row.guardrails ?? []) as readonly ExperimentMetricIdentity[],
    analysisMethod: row.analysis_method,
    analysisMethodVersion: row.analysis_method_version,
    expectedDirection: (row.expected_direction ?? null) as ExperimentRecord['expectedDirection'],
    startCriteria: row.start_criteria,
    stopCriteria: row.stop_criteria,
    minimumEvidenceRequirement: row.minimum_evidence_requirement,
    uncertaintyRepresentation: row.uncertainty_representation as ExperimentRecord['uncertaintyRepresentation'],
    status: row.status as ExperimentRecord['status'],
    resultState: row.result_state as ExperimentResultState,
    resultingDecision: row.resulting_decision,
    concludedAt: row.concluded_at === null ? null : row.concluded_at.toISOString(),
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
  };
}

function toExperimentTransitionRecord(row: ExperimentTransitionRow): ExperimentTransitionRecord {
  const raw = row.conclusion as PersistedConclusion | null;
  const conclusion =
    raw === null || raw === undefined
      ? null
      : {
          resultState: raw.resultState,
          uncertainty: (raw.uncertainty ?? null) as ExperimentUncertainty | null,
          assumptions: raw.assumptions ?? [],
          sampleLimitations: raw.sampleLimitations ?? [],
          confounders: raw.confounders ?? [],
          resultingDecision: raw.resultingDecision ?? null,
          evidenceRefs: raw.evidenceRefs ?? [],
        };
  return {
    transitionId: row.transition_id,
    experimentId: row.experiment_id,
    transition: row.transition as ExperimentTransition,
    fromStatus: row.from_status as ExperimentTransitionRecord['fromStatus'],
    toStatus: row.to_status as ExperimentTransitionRecord['toStatus'],
    conclusion,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
  };
}

/** Uniform domain 404 helper for foreign/unknown identifiers. */
export function experimentNotFound(experimentId: string): NotFoundError {
  return new NotFoundError('experiment', experimentId);
}
