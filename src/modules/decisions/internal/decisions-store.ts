/**
 * /decisions persistence (decisions + decision_events tables — migration
 * 036, the MKT-042-reserved number).
 *
 * Two durable structures:
 *
 *   - `decisions`: ONE row per decision. The PROPOSAL columns (scope,
 *     objective … alternatives, predecessor link, proposer, idempotency
 *     key/fingerprint, provenance) are IMMUTABLE after insert — a BEFORE
 *     UPDATE trigger rejects any rewrite of them (the migration 019
 *     design-immutability pattern). Only the lifecycle columns
 *     (disposition, successor_decision_id, disposition_at,
 *     observed_outcome, execution_ref, deployment_ref, learning_ref,
 *     outcome_at) may change — and ONLY along the frozen legal edges
 *     (disposition proposed → accepted | rejected | superseded under the
 *     CAS update; the outcome observation exactly once on an accepted
 *     record), enforced by a second trigger as the race backstop.
 *   - `decision_events`: the APPEND-ONLY ledger event tail — UPDATE and
 *     DELETE are rejected by triggers (the migration 015/018/019/027
 *     pattern). Each row is one immutable event: a disposition (with its
 *     reason and, for supersession, the successor) or an outcome
 *     observation (with the observed outcome, the execution/deployment
 *     reference and the learning reference — the post-execution linkage
 *     retained verbatim).
 *
 * The database is the final backstop for every material invariant:
 *   - the closed enums (disposition, event kind) are CHECKs;
 *   - the §8 fences are UNIQUE constraints — (client_id, idempotency_key)
 *     on decisions and (decision_id, idempotency_key) on decision_events
 *     ("Application-level check-then-insert is insufficient as the sole
 *     duplicate fence");
 *   - the disposition event must be a legal edge (row CHECK);
 *   - the successor of a supersede must be a live same-Client correction
 *     whose predecessor points back (trigger);
 *   - the predecessor must exist, be same-Client and not already be
 *     superseded (trigger);
 *   - the workspace scope must live inside the owning Client (trigger);
 *   - cited evidence refs / the experiment ref must belong to the SAME
 *     Client (trigger); the outcome's execution/deployment/learning refs
 *     must belong to the SAME Client (trigger on UPDATE).
 *
 * Provenance columns (recorded_actor, recorded_via, correlation_id,
 * causation_id, recorded_at) and the proposer columns (proposer_actor,
 * proposer_role) are written ONLY from server-built values — there is no
 * request DTO path to them.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  DecisionCreateInput,
  DecisionDisposition,
  DecisionDispositionInput,
  DecisionEventRecord,
  DecisionExpectedImpact,
  DecisionObservedOutcome,
  DecisionOutcomeInput,
  DecisionProposer,
  DecisionProvenance,
  DecisionRecord,
  DecisionUncertainty,
} from '../public.ts';
import {
  DECISION_DISPOSITION_TABLE,
  isKnownDecisionDispositionCommand,
  isKnownDecisionImpactDirection,
} from '../public.ts';
// The ONE shared cross-module guard of the frozen vocabulary: the §21
// material-key backstop from the /evidence public contract — a single
// source of truth for the forbidden key set (the /experiments and
// /learnings precedent).
import { containsMaterialKey } from '../../evidence/public.ts';

// ---------------------------------------------------------------------------
// Shape bounds (module-side; the DB CHECKs mirror the scalar ones)
// ---------------------------------------------------------------------------

const MAX_TEXT_200 = 200;
const MAX_TEXT_500 = 500;
const MAX_TEXT_2000 = 2000;
const MAX_EVIDENCE_REFS = 50;
const MAX_ALTERNATIVES = 20;
const MAX_ALTERNATIVE_LENGTH = 1000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface DecisionRow extends DbRow {
  decision_id: string;
  client_id: string;
  workspace_id: string | null;
  agency_id: string;
  objective: string;
  context: string | null;
  hypothesis_summary: string;
  experiment_ref: string | null;
  evidence_refs: unknown;
  expected_impact: unknown;
  uncertainty: unknown;
  expected_cost: string | null;
  alternatives: unknown;
  predecessor_decision_id: string | null;
  proposer_actor: string;
  proposer_role: string;
  disposition: string;
  successor_decision_id: string | null;
  disposition_at: Date | null;
  observed_outcome: unknown;
  execution_ref: string | null;
  deployment_ref: string | null;
  learning_ref: string | null;
  outcome_at: Date | null;
  idempotency_key: string;
  create_fingerprint: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface DecisionEventRow extends DbRow {
  event_id: string;
  decision_id: string;
  event_kind: string;
  disposition: string | null;
  reason: string | null;
  successor_decision_id: string | null;
  observed_outcome: unknown;
  execution_ref: string | null;
  deployment_ref: string | null;
  learning_ref: string | null;
  idempotency_key: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const DECISION_SELECT = `
  SELECT d.decision_id, d.client_id, d.workspace_id, d.agency_id, d.objective, d.context,
         d.hypothesis_summary, d.experiment_ref, d.evidence_refs, d.expected_impact,
         d.uncertainty, d.expected_cost, d.alternatives, d.predecessor_decision_id,
         d.proposer_actor, d.proposer_role, d.disposition, d.successor_decision_id,
         d.disposition_at, d.observed_outcome, d.execution_ref, d.deployment_ref,
         d.learning_ref, d.outcome_at, d.idempotency_key, d.create_fingerprint,
         d.recorded_actor, d.recorded_via, d.correlation_id, d.causation_id, d.recorded_at
  FROM decisions d
`;

// ---------------------------------------------------------------------------
// Pure guards (exported through the public contract)
// ---------------------------------------------------------------------------

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

function uuidRefProblems(label: string, value: string | null): string[] {
  if (value === null) return [];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    return [`${label}: must be a canonical record id (uuid)`];
  }
  return [];
}

/**
 * The structured EXPECTED IMPACT guard: required summary, optional closed-set
 * direction, optional bounded magnitude. §21 defense in depth — material-
 * shaped keys can never appear inside the payload.
 */
function expectedImpactProblems(impact: DecisionExpectedImpact | null | undefined): string[] {
  if (impact === null || typeof impact !== 'object' || Array.isArray(impact)) {
    return ['expectedImpact: a structured expected impact (summary + optional direction/magnitude) is required'];
  }
  const problems: string[] = [];
  problems.push(
    ...boundedTextProblems('expectedImpact.summary', impact.summary, {
      required: true,
      max: MAX_TEXT_2000,
    }),
  );
  if (impact.direction !== null && impact.direction !== undefined) {
    if (
      typeof impact.direction !== 'string' ||
      !isKnownDecisionImpactDirection(impact.direction)
    ) {
      problems.push(
        'expectedImpact.direction: must be one of the frozen impact directions when present',
      );
    }
  }
  problems.push(
    ...boundedTextProblems('expectedImpact.magnitude', impact.magnitude, {
      required: false,
      max: MAX_TEXT_200,
    }),
  );
  if (containsMaterialKey(impact as unknown as Record<string, unknown>)) {
    problems.push(
      'expectedImpact: material-shaped keys can never appear in decision payloads (implementation-contract §21)',
    );
  }
  return problems;
}

/**
 * The DECLARED UNCERTAINTY guard — the payload SEPARATE from expected
 * impact (its own column): a discriminated union whose kind determines the
 * required shape. Null = not declared; a declared uncertainty is never
 * silently transformed.
 */
function uncertaintyProblems(uncertainty: DecisionUncertainty | null | undefined): string[] {
  if (uncertainty === null || uncertainty === undefined) return [];
  if (typeof uncertainty !== 'object' || Array.isArray(uncertainty)) {
    return ['uncertainty: must be a structured uncertainty payload or null'];
  }
  const problems: string[] = [];
  if (
    uncertainty.kind !== 'interval' &&
    uncertainty.kind !== 'distribution' &&
    uncertainty.kind !== 'qualitative'
  ) {
    return ['uncertainty.kind: must be one of interval, distribution, qualitative'];
  }
  if (uncertainty.kind === 'interval') {
    const { lower, upper, level } = uncertainty;
    if (typeof lower !== 'number' || !Number.isFinite(lower)) {
      problems.push('uncertainty.lower: a finite number is required');
    }
    if (typeof upper !== 'number' || !Number.isFinite(upper)) {
      problems.push('uncertainty.upper: a finite number is required');
    }
    if (
      typeof lower === 'number' &&
      typeof upper === 'number' &&
      Number.isFinite(lower) &&
      Number.isFinite(upper) &&
      lower > upper
    ) {
      problems.push('uncertainty: lower must not exceed upper');
    }
    if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0 || level >= 1) {
      problems.push('uncertainty.level: a coverage level strictly between 0 and 1 is required');
    }
  } else if (uncertainty.kind === 'distribution') {
    if (
      typeof uncertainty.descriptor !== 'string' ||
      uncertainty.descriptor.trim() === ''
    ) {
      problems.push('uncertainty.descriptor: a non-empty distribution descriptor is required');
    } else if (uncertainty.descriptor.length > MAX_TEXT_500) {
      problems.push(`uncertainty.descriptor: must be at most ${MAX_TEXT_500} characters`);
    }
  } else {
    if (
      typeof uncertainty.description !== 'string' ||
      uncertainty.description.trim() === ''
    ) {
      problems.push('uncertainty.description: a non-empty qualitative description is required');
    } else if (uncertainty.description.length > MAX_TEXT_2000) {
      problems.push(`uncertainty.description: must be at most ${MAX_TEXT_2000} characters`);
    }
  }
  if (containsMaterialKey(uncertainty as unknown as Record<string, unknown>)) {
    problems.push(
      'uncertainty: material-shaped keys can never appear in decision payloads (implementation-contract §21)',
    );
  }
  return problems;
}

function alternativesProblems(alternatives: readonly string[] | null | undefined): string[] {
  if (alternatives === null || alternatives === undefined) {
    return ['alternatives: required (an array; empty when none were considered)'];
  }
  if (!Array.isArray(alternatives)) {
    return ['alternatives: must be an array of strings'];
  }
  if (alternatives.length > MAX_ALTERNATIVES) {
    return [`alternatives: at most ${MAX_ALTERNATIVES} considered alternatives are retained`];
  }
  const problems: string[] = [];
  alternatives.forEach((alternative, index) => {
    if (typeof alternative !== 'string' || alternative.trim() === '') {
      problems.push(`alternatives[${index}]: non-empty strings only`);
    } else if (alternative.length > MAX_ALTERNATIVE_LENGTH) {
      problems.push(
        `alternatives[${index}]: must be at most ${MAX_ALTERNATIVE_LENGTH} characters`,
      );
    }
  });
  return problems;
}

function evidenceRefsProblems(evidenceRefs: readonly string[] | null | undefined): string[] {
  if (evidenceRefs === null || evidenceRefs === undefined) {
    return ['evidenceRefs: required (an array; empty when nothing is cited)'];
  }
  if (!Array.isArray(evidenceRefs)) {
    return ['evidenceRefs: must be an array of /evidence record ids'];
  }
  if (evidenceRefs.length > MAX_EVIDENCE_REFS) {
    return [`evidenceRefs: at most ${MAX_EVIDENCE_REFS} evidence records may be cited`];
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  evidenceRefs.forEach((ref, index) => {
    if (typeof ref !== 'string' || !UUID_PATTERN.test(ref)) {
      problems.push(`evidenceRefs[${index}]: must be an evidence record id (uuid)`);
    } else if (seen.has(ref)) {
      problems.push(`evidenceRefs[${index}]: duplicate evidence reference`);
    } else {
      seen.add(ref);
    }
  });
  return problems;
}

function idempotencyKeyProblems(key: string | null | undefined): string[] {
  if (typeof key !== 'string' || key.trim() === '') {
    return ['idempotencyKey: a non-empty logical command key is required'];
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return [`idempotencyKey: must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`];
  }
  return [];
}

/**
 * Pure creation guard at the authority boundary: the module never persists
 * a decision that violates the frozen MKT-042 proposal vocabulary, whatever
 * the caller did upstream. Mirrors the DB CHECKs and adds the per-field
 * semantics the jsonb CHECKs cannot express.
 */
export function assertValidDecisionCreate(input: DecisionCreateInput): void {
  const problems: string[] = [];

  problems.push(
    ...boundedTextProblems('objective', input.objective, { required: true, max: MAX_TEXT_2000 }),
  );
  problems.push(
    ...boundedTextProblems('context', input.context, { required: false, max: MAX_TEXT_2000 }),
  );
  problems.push(
    ...boundedTextProblems('hypothesisSummary', input.hypothesisSummary, {
      required: true,
      max: MAX_TEXT_2000,
    }),
  );
  problems.push(...uuidRefProblems('experimentRef', input.experimentRef));
  problems.push(...evidenceRefsProblems(input.evidenceRefs));
  problems.push(...expectedImpactProblems(input.expectedImpact));
  problems.push(...uncertaintyProblems(input.uncertainty));
  problems.push(
    ...boundedTextProblems('expectedCost', input.expectedCost, {
      required: false,
      max: MAX_TEXT_2000,
    }),
  );
  problems.push(...alternativesProblems(input.alternatives));
  problems.push(...uuidRefProblems('predecessorDecisionId', input.predecessorDecisionId));
  problems.push(...idempotencyKeyProblems(input.idempotencyKey));

  if (problems.length > 0) {
    throw new InvalidRequestError('decision rejected by the proposal guard', problems);
  }
}

/**
 * Pure disposition-input guard: known command; successor present exactly
 * when superseding, absent otherwise; bounded reason; the logical key.
 */
export function assertValidDecisionDispositionInput(input: DecisionDispositionInput): void {
  const problems: string[] = [];
  if (
    typeof input.command !== 'string' ||
    !isKnownDecisionDispositionCommand(input.command)
  ) {
    throw new InvalidRequestError(
      'decision disposition rejected: unknown disposition command',
      ['command: must be one of the frozen disposition commands (accept, reject, supersede)'],
    );
  }
  if (input.command === 'supersede') {
    if (input.successorDecisionId === null || input.successorDecisionId === undefined) {
      problems.push('successorDecisionId: required for the supersede command');
    } else if (!UUID_PATTERN.test(input.successorDecisionId)) {
      problems.push('successorDecisionId: must be a decision id (uuid)');
    }
  } else if (input.successorDecisionId !== null && input.successorDecisionId !== undefined) {
    problems.push('successorDecisionId: only the supersede command carries a successor');
  }
  problems.push(
    ...boundedTextProblems('reason', input.reason, { required: false, max: MAX_TEXT_2000 }),
  );
  problems.push(...idempotencyKeyProblems(input.idempotencyKey));
  if (problems.length > 0) {
    throw new InvalidRequestError('decision disposition rejected', problems);
  }
}

/**
 * Pure observed-outcome guard: the structured observation (required
 * summary, optional asExpected, optional bounded notes), the
 * execution/deployment AT-MOST-ONE rule, the learning reference shape and
 * the logical key.
 */
export function assertValidDecisionOutcomeInput(input: DecisionOutcomeInput): void {
  const problems: string[] = [];
  const outcome = input.observedOutcome;
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) {
    problems.push(
      'observedOutcome: a structured observed outcome (summary + optional asExpected/notes) is required',
    );
  } else {
    problems.push(
      ...boundedTextProblems('observedOutcome.summary', outcome.summary, {
        required: true,
        max: MAX_TEXT_2000,
      }),
    );
    if (
      outcome.asExpected !== null &&
      outcome.asExpected !== undefined &&
      typeof outcome.asExpected !== 'boolean'
    ) {
      problems.push('observedOutcome.asExpected: must be a boolean when present');
    }
    problems.push(
      ...boundedTextProblems('observedOutcome.notes', outcome.notes, {
        required: false,
        max: MAX_TEXT_2000,
      }),
    );
    if (containsMaterialKey(outcome as unknown as Record<string, unknown>)) {
      problems.push(
        'observedOutcome: material-shaped keys can never appear in decision payloads (implementation-contract §21)',
      );
    }
  }
  // The execution/deployment reference is AT MOST ONE: a decision is
  // carried out by an execution OR a deployment, never both.
  if (input.executionRef !== null && input.deploymentRef !== null) {
    problems.push(
      'executionRef/deploymentRef: at most ONE implementation reference may be recorded — supply executionRef or deploymentRef, not both',
    );
  }
  problems.push(...uuidRefProblems('executionRef', input.executionRef));
  problems.push(...uuidRefProblems('deploymentRef', input.deploymentRef));
  problems.push(...uuidRefProblems('learningRef', input.learningRef));
  problems.push(...idempotencyKeyProblems(input.idempotencyKey));
  if (problems.length > 0) {
    throw new InvalidRequestError('decision outcome rejected by the outcome guard', problems);
  }
}

/**
 * The proposer is server-derived and must be COMPLETE before any write:
 * identity + role. There is no caller path to either.
 */
export function assertValidDecisionProposer(proposer: DecisionProposer): void {
  const problems: string[] = [];
  if (proposer.actor.trim() === '') {
    problems.push('proposer.actor: a non-empty server-derived proposer identity is required');
  }
  if (proposer.role.trim() === '') {
    problems.push('proposer.role: a non-empty server-derived proposer role is required');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      'decision rejected: the proposer is server-derived and must be complete',
      problems,
    );
  }
}

/**
 * Provenance is server-derived and must be COMPLETE before any write: an
 * incomplete provenance fails closed (the rows' authority columns are
 * never defaulted from caller input). Mirrors the /evidence, /metrics,
 * /experiments and /learnings guards.
 */
export function assertValidDecisionProvenance(provenance: DecisionProvenance): void {
  const problems: string[] = [];
  if (provenance.actor.trim() === '') {
    problems.push('provenance.actor: a non-empty server-derived principal label is required');
  }
  if (provenance.recordedVia.trim() === '' || provenance.recordedVia.length > 100) {
    problems.push('provenance.recordedVia: a non-empty server-derived system label is required');
  }
  if (provenance.correlationId.trim() === '') {
    problems.push('provenance.correlationId: decision mutations are correlation-linked');
  }
  if (provenance.causationId !== null && provenance.causationId.trim() === '') {
    problems.push('provenance.causationId: must be a non-empty identifier when present');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      'decision mutation rejected: provenance is server-derived and must be complete',
      problems,
    );
  }
}

// ---------------------------------------------------------------------------
// The §8 create fingerprint (the convergence proof)
// ---------------------------------------------------------------------------

/**
 * The deterministic digest of one logical create command: a canonical JSON
 * serialization of the CALLER-VISIBLE proposal payload (objective …
 * alternatives, predecessor link, scope inputs). Server-derived values
 * (ids, proposer, provenance, timestamps) are deliberately excluded — one
 * key + one payload identifies one logical command (the executions
 * fingerprint precedent).
 */
export function fingerprintDecisionCreate(input: DecisionCreateInput): string {
  const canonical = JSON.stringify({
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    objective: input.objective,
    context: input.context,
    hypothesisSummary: input.hypothesisSummary,
    experimentRef: input.experimentRef,
    evidenceRefs: [...input.evidenceRefs],
    expectedImpact: {
      summary: input.expectedImpact.summary,
      direction: input.expectedImpact.direction,
      magnitude: input.expectedImpact.magnitude,
    },
    uncertainty: input.uncertainty,
    expectedCost: input.expectedCost,
    alternatives: [...input.alternatives],
    predecessorDecisionId: input.predecessorDecisionId,
  });
  // A stable, injective-enough digest of the canonical form (hex SHA-256
  // via the Web Crypto API is async; the house precedent uses a plain
  // deterministic string — the fingerprint column is a convergence PROOF,
  // not a security boundary).
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `dc1:${hash.toString(16).padStart(8, '0')}:${canonical.length}`;
}

// ---------------------------------------------------------------------------
// Insert/update classification (DB-triggered invariants converged to
// domain errors)
// ---------------------------------------------------------------------------

/** Distinctive phrases of the migration 036 backstop triggers/CHECKs. */
const DISPOSITION_TRANSITION_MARKER = 'illegal decision disposition transition';
const PROPOSAL_IMMUTABLE_MARKER = 'decision proposal payload is immutable';
const PREDECESSOR_MARKER = 'predecessor';
const EVIDENCE_REFS_CROSS_TENANT_MARKER = 'cross-tenant evidence linkage is rejected';
const EXPERIMENT_REF_MARKER = 'cross-tenant experiment linkage is rejected';
const OUTCOME_REFS_MARKER = 'decision outcome references';
const SUCCESSOR_MARKER = 'supersede requires a live correction successor';
const IDEMPOTENCY_MARKER = 'duplicate key value violates unique constraint';

export type DecisionWriteConflict =
  | 'disposition-transition'
  | 'proposal-immutable'
  | 'predecessor-illegal'
  | 'evidence-refs-client'
  | 'experiment-ref-client'
  | 'outcome-refs-client'
  | 'successor-illegal'
  | 'idempotency-fence';

/**
 * Classifies a postgres error on a decisions write into the module-level
 * domain error (the module pre-checks lost to a concurrent change — the DB
 * trigger/fence won). Anything else propagates untouched.
 */
export function classifyDecisionWriteConflict(error: unknown): DecisionWriteConflict | null {
  const candidate = error as { message?: string; code?: string; detail?: string };
  if (candidate?.message === undefined) return null;
  const message = candidate.message;
  if (message.includes(DISPOSITION_TRANSITION_MARKER)) return 'disposition-transition';
  if (message.includes(PROPOSAL_IMMUTABLE_MARKER)) return 'proposal-immutable';
  if (message.includes(SUCCESSOR_MARKER)) return 'successor-illegal';
  if (message.includes(EVIDENCE_REFS_CROSS_TENANT_MARKER)) return 'evidence-refs-client';
  if (message.includes(EXPERIMENT_REF_MARKER)) return 'experiment-ref-client';
  if (message.includes(OUTCOME_REFS_MARKER)) return 'outcome-refs-client';
  if (message.includes(PREDECESSOR_MARKER)) return 'predecessor-illegal';
  if (
    candidate.code === '23505' ||
    message.includes(IDEMPOTENCY_MARKER)
  ) {
    return 'idempotency-fence';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface DecisionInsertRow {
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly agencyId: string;
  readonly objective: string;
  readonly context: string | null;
  readonly hypothesisSummary: string;
  readonly experimentRef: string | null;
  readonly evidenceRefs: readonly string[];
  readonly expectedImpact: DecisionExpectedImpact;
  readonly uncertainty: DecisionUncertainty | null;
  readonly expectedCost: string | null;
  readonly alternatives: readonly string[];
  readonly predecessorDecisionId: string | null;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
}

export class DecisionStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Inserts the proposed decision ('proposed', no outcome, no successor).
   * The §8 fence is the (client_id, idempotency_key) UNIQUE constraint:
   * ON CONFLICT DO NOTHING — returns true when the row was inserted,
   * false when the fence fired (a concurrent/replayed duplicate; the
   * caller converges through findDecisionByIdempotencyKey). The DB
   * triggers are the final backstops (workspace-within-client; every enum
   * CHECK; the reference fences).
   */
  async insertDecision(
    row: DecisionInsertRow,
    proposer: DecisionProposer,
    provenance: DecisionProvenance,
  ): Promise<boolean> {
    const decisionId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    const result = await this.db.query(
      `INSERT INTO decisions (decision_id, client_id, workspace_id, agency_id,
                             objective, context, hypothesis_summary, experiment_ref,
                             evidence_refs, expected_impact, uncertainty, expected_cost,
                             alternatives, predecessor_decision_id, proposer_actor, proposer_role,
                             disposition, successor_decision_id, disposition_at,
                             observed_outcome, execution_ref, deployment_ref, learning_ref, outcome_at,
                             idempotency_key, create_fingerprint,
                             recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12,
               $13::jsonb, $14, $15, $16, 'proposed', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
               $17, $18, $19, $20, $21, $22, $23)
       ON CONFLICT (client_id, idempotency_key) DO NOTHING`,
      [
        decisionId,
        row.clientId,
        row.workspaceId,
        row.agencyId,
        row.objective,
        row.context,
        row.hypothesisSummary,
        row.experimentRef,
        JSON.stringify([...row.evidenceRefs]),
        JSON.stringify(row.expectedImpact),
        row.uncertainty === null ? null : JSON.stringify(row.uncertainty),
        row.expectedCost,
        JSON.stringify([...row.alternatives]),
        row.predecessorDecisionId,
        proposer.actor,
        proposer.role,
        row.idempotencyKey,
        row.createFingerprint,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        recordedAt,
      ],
    );
    return result.rowCount === 1;
  }

  async getDecision(decisionId: string): Promise<DecisionRecord | null> {
    const result = await this.db.query<DecisionRow>(
      `${DECISION_SELECT} WHERE d.decision_id = $1`,
      [decisionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDecisionRecord(row);
  }

  /**
   * The §8 convergence read: the decision recorded under one Client's
   * logical create key (null when the fence has not fired).
   */
  async findDecisionByIdempotencyKey(
    clientId: string,
    idempotencyKey: string,
  ): Promise<DecisionRecord | null> {
    const result = await this.db.query<DecisionRow>(
      `${DECISION_SELECT} WHERE d.client_id = $1 AND d.idempotency_key = $2`,
      [clientId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDecisionRecord(row);
  }

  /**
   * The Client's decisions, newest first by server-recorded time (bounded —
   * the append-only ledger grows without end).
   */
  async listDecisionsForClient(
    clientId: string,
    limit = 500,
  ): Promise<readonly DecisionRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<DecisionRow>(
      `${DECISION_SELECT} WHERE d.client_id = $1
       ORDER BY d.recorded_at DESC, d.decision_id LIMIT $2`,
      [clientId, bounded],
    );
    return result.rows.map(toDecisionRecord);
  }

  /**
   * Applies ONE disposition atomically under the CAS update: the row moves
   * proposed → target ONLY (WHERE disposition = 'proposed' — exactly one
   * concurrent winner; the DB legal-successor trigger is the backstop),
   * then the append-only event row is inserted in the same transaction.
   * Returns null when the CAS lost (the row is no longer 'proposed') —
   * the CALLER converges through findEventByIdempotencyKey before
   * surfacing the conflict.
   */
  async applyDisposition(
    decisionId: string,
    input: DecisionDispositionInput,
    provenance: DecisionProvenance,
  ): Promise<DecisionEventRecord | null> {
    const edge = DECISION_DISPOSITION_TABLE[input.command];
    const eventId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    const applied = await this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE decisions SET disposition = $2, successor_decision_id = $3, disposition_at = $4
         WHERE decision_id = $1 AND disposition = 'proposed'`,
        [
          decisionId,
          edge.to,
          input.command === 'supersede' ? input.successorDecisionId : null,
          recordedAt,
        ],
      );
      if (updated.rowCount !== 1) {
        return false;
      }
      await tx.query(
        `INSERT INTO decision_events (event_id, decision_id, event_kind, disposition,
                               reason, successor_decision_id, observed_outcome,
                               execution_ref, deployment_ref, learning_ref,
                               idempotency_key,
                               recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
         VALUES ($1, $2, 'disposition', $3, $4, $5, NULL, NULL, NULL, NULL, $6,
                 $7, $8, $9, $10, $11)`,
        [
          eventId,
          decisionId,
          edge.to,
          input.reason,
          input.command === 'supersede' ? input.successorDecisionId : null,
          input.idempotencyKey,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          recordedAt,
        ],
      );
      return true;
    });
    if (!applied) return null;
    return this.getEvent(eventId);
  }

  /**
   * Records the observed outcome atomically: the row's outcome columns are
   * set exactly once (WHERE disposition = 'accepted' AND observed_outcome
   * IS NULL — one winner; a second observation loses with null), then the
   * append-only event row is inserted in the same transaction. Returns
   * null when the CAS lost — the CALLER converges through
   * findEventByIdempotencyKey before surfacing the conflict.
   */
  async applyOutcome(
    decisionId: string,
    input: DecisionOutcomeInput,
    provenance: DecisionProvenance,
  ): Promise<DecisionEventRecord | null> {
    const eventId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    const applied = await this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE decisions SET observed_outcome = $2::jsonb, execution_ref = $3,
                             deployment_ref = $4, learning_ref = $5, outcome_at = $6
         WHERE decision_id = $1 AND disposition = 'accepted' AND observed_outcome IS NULL`,
        [
          decisionId,
          JSON.stringify(input.observedOutcome),
          input.executionRef,
          input.deploymentRef,
          input.learningRef,
          recordedAt,
        ],
      );
      if (updated.rowCount !== 1) {
        return false;
      }
      await tx.query(
        `INSERT INTO decision_events (event_id, decision_id, event_kind, disposition,
                               reason, successor_decision_id, observed_outcome,
                               execution_ref, deployment_ref, learning_ref,
                               idempotency_key,
                               recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
         VALUES ($1, $2, 'outcome_observed', NULL, NULL, NULL, $3::jsonb, $4, $5, $6, $7,
                 $8, $9, $10, $11, $12)`,
        [
          eventId,
          decisionId,
          JSON.stringify(input.observedOutcome),
          input.executionRef,
          input.deploymentRef,
          input.learningRef,
          input.idempotencyKey,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          recordedAt,
        ],
      );
      return true;
    });
    if (!applied) return null;
    return this.getEvent(eventId);
  }

  async getEvent(eventId: string): Promise<DecisionEventRecord | null> {
    const result = await this.db.query<DecisionEventRow>(
      `SELECT e.event_id, e.decision_id, e.event_kind, e.disposition, e.reason,
              e.successor_decision_id, e.observed_outcome, e.execution_ref, e.deployment_ref,
              e.learning_ref, e.idempotency_key, e.recorded_actor, e.recorded_via,
              e.correlation_id, e.causation_id, e.recorded_at
       FROM decision_events e
       WHERE e.event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDecisionEventRecord(row);
  }

  /**
   * The §8 convergence read for events: the event recorded under one
   * decision's logical command key (null when the fence has not fired).
   */
  async findEventByIdempotencyKey(
    decisionId: string,
    idempotencyKey: string,
  ): Promise<DecisionEventRecord | null> {
    const result = await this.db.query<DecisionEventRow>(
      `SELECT e.event_id, e.decision_id, e.event_kind, e.disposition, e.reason,
              e.successor_decision_id, e.observed_outcome, e.execution_ref, e.deployment_ref,
              e.learning_ref, e.idempotency_key, e.recorded_actor, e.recorded_via,
              e.correlation_id, e.causation_id, e.recorded_at
       FROM decision_events e
       WHERE e.decision_id = $1 AND e.idempotency_key = $2`,
      [decisionId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDecisionEventRecord(row);
  }

  /**
   * The append-only event tail of one decision, oldest first. Cross-tenant
   * decision identifiers never reach the store (the module resolves
   * ownership first); the read is id-scoped only.
   */
  async listEventsForDecision(
    decisionId: string,
    limit = 500,
  ): Promise<readonly DecisionEventRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<DecisionEventRow>(
      `SELECT e.event_id, e.decision_id, e.event_kind, e.disposition, e.reason,
              e.successor_decision_id, e.observed_outcome, e.execution_ref, e.deployment_ref,
              e.learning_ref, e.idempotency_key, e.recorded_actor, e.recorded_via,
              e.correlation_id, e.causation_id, e.recorded_at
       FROM decision_events e
       WHERE e.decision_id = $1
       ORDER BY e.recorded_at ASC, e.event_id LIMIT $2`,
      [decisionId, bounded],
    );
    return result.rows.map(toDecisionEventRecord);
  }
}

// ---------------------------------------------------------------------------
// Row → record mapping (byte-faithful round-trip; nothing is dropped)
// ---------------------------------------------------------------------------

function toDecisionRecord(row: DecisionRow): DecisionRecord {
  return {
    decisionId: row.decision_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    agencyId: row.agency_id,
    objective: row.objective,
    context: row.context,
    hypothesisSummary: row.hypothesis_summary,
    experimentRef: row.experiment_ref,
    evidenceRefs: (row.evidence_refs ?? []) as readonly string[],
    expectedImpact: (row.expected_impact ?? {
      summary: '',
      direction: null,
      magnitude: null,
    }) as DecisionExpectedImpact,
    uncertainty: (row.uncertainty ?? null) as DecisionUncertainty | null,
    expectedCost: row.expected_cost,
    alternatives: (row.alternatives ?? []) as readonly string[],
    predecessorDecisionId: row.predecessor_decision_id,
    proposer: {
      actor: row.proposer_actor,
      role: row.proposer_role,
    },
    disposition: row.disposition as DecisionDisposition,
    successorDecisionId: row.successor_decision_id,
    dispositionAt: row.disposition_at === null ? null : row.disposition_at.toISOString(),
    observedOutcome: (row.observed_outcome ?? null) as DecisionObservedOutcome | null,
    executionRef: row.execution_ref,
    deploymentRef: row.deployment_ref,
    learningRef: row.learning_ref,
    outcomeAt: row.outcome_at === null ? null : row.outcome_at.toISOString(),
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
  };
}

function toDecisionEventRecord(row: DecisionEventRow): DecisionEventRecord {
  return {
    eventId: row.event_id,
    decisionId: row.decision_id,
    eventKind: row.event_kind as DecisionEventRecord['eventKind'],
    disposition: (row.disposition ?? null) as DecisionDisposition | null,
    reason: row.reason,
    successorDecisionId: row.successor_decision_id,
    observedOutcome: (row.observed_outcome ?? null) as DecisionObservedOutcome | null,
    executionRef: row.execution_ref,
    deploymentRef: row.deployment_ref,
    learningRef: row.learning_ref,
    idempotencyKey: row.idempotency_key,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
  };
}
