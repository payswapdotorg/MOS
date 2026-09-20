/**
 * /product-intelligence persistence (the migration 048 tables — OWN
 * tables only).
 *
 * DB backstops (migration 048 + implementation-contract §3, §25):
 *   - the context record's identity/scope/provenance columns are IMMUTABLE
 *     (trigger); the CAS version must advance by EXACTLY one per mutation
 *     (trigger); the version-tail pointer only ever ADVANCES and must
 *     reference an EXISTING declared version of the same context
 *     (trigger); DELETE is rejected outright;
 *   - the VERSION tail and the per-version INPUTS are append-only
 *     (UPDATE and DELETE rejected outright — corrections are NEW version
 *     records carrying their own input declarations);
 *   - the SOURCE-FACT ledger is append-only with the same-version input
 *     fence and the unchanged-source (version, input, extractor,
 *     content-hash) fence;
 *   - the DERIVED MODEL records and RISK FLAGS are append-only with the
 *     verification-state / hypothesis-kind / ai-pair shape CHECKs, the
 *     same-context source-fact fences, the same-agency evidence-citation
 *     fences and the repetition fences.
 *
 * The store issues DML against THESE tables only (proven by the static
 * boundary tests); every cross-module read composes the declared
 * structural ports (/agencies, /evidence, /ai-runtime, /integrations).
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  ProductContextDeclaration,
  ProductContextInputDeclaration,
  ProductContextInputRecord,
  ProductContextRecord,
  ProductContextVersionRecord,
  ProductDerivedModelRecord,
  ProductIntelligenceAiAssistance,
  ProductIntelligenceDerivationKind,
  ProductIntelligenceProvenance,
  ProductIntelligenceRiskKind,
  ProductIntelligenceRiskSeverity,
  ProductRiskFlagRecord,
  ProductSourceFactRecord,
} from '../public.ts';
import {
  PRODUCT_INTELLIGENCE_DERIVATION_KINDS,
  PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS,
  PRODUCT_INTELLIGENCE_INPUT_KINDS,
  PRODUCT_INTELLIGENCE_RISK_KINDS,
  PRODUCT_INTELLIGENCE_RISK_SEVERITIES,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Input guards (pure — exported for unit tests and the MKT-070 planner)
// ---------------------------------------------------------------------------

const NAME_MAX_LENGTH = 500;
const SUMMARY_MAX_LENGTH = 5000;
const REFERENCE_MAX_LENGTH = 2048;
const NOTES_MAX_LENGTH = 2000;
const STATEMENT_MAX_LENGTH = 2000;
const ACTOR_MAX_LENGTH = 100;
const INPUTS_MAX = 50;
const REFS_MAX = 50;
const MODEL_IDENTITY_MAX_LENGTH = 200;
const CALL_REFERENCE_MAX_LENGTH = 100;

/** Loopback hosts permitted over plain http (mirrors the HttpCallPort rule). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The public-source URL rule (the platform HttpCallPort discipline): an
 * absolute https URL, or plain http for loopback hosts only (the
 * disclosed local-test allowance). Every publicly-declared input's
 * reference must pass this rule — the deterministic fetch boundary.
 */
export function assertValidPublicSourceUrl(reference: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(reference);
  } catch {
    throw new InvalidRequestError('Invalid public source URL', [
      `${field}: must be an absolute URL (https, or http for loopback hosts) — got '${reference}'`,
    ]);
  }
  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new InvalidRequestError('Invalid public source URL', [
      `${field}: must be https (http is only permitted for loopback hosts) — got '${reference}'`,
    ]);
  }
}

function inputProblems(input: ProductContextInputDeclaration, prefix: string): string[] {
  const problems: string[] = [];
  if (
    typeof input.inputKind !== 'string' ||
    !(PRODUCT_INTELLIGENCE_INPUT_KINDS as readonly string[]).includes(input.inputKind)
  ) {
    problems.push(
      `${prefix}.inputKind: must be one of ${PRODUCT_INTELLIGENCE_INPUT_KINDS.join(', ')} (the frozen architecture-v1.6.md §8 input vocabulary)`,
    );
    return problems;
  }
  const allowedStates = PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS[input.inputKind];
  if (
    typeof input.authorizationState !== 'string' ||
    !allowedStates.includes(input.authorizationState as (typeof allowedStates)[number])
  ) {
    problems.push(
      `${prefix}.authorizationState: '${input.inputKind}' accepts ${allowedStates.join(' | ')} (the frozen per-kind authorization map)`,
    );
  }
  if (
    typeof input.reference !== 'string' ||
    input.reference.trim().length === 0 ||
    input.reference.length > REFERENCE_MAX_LENGTH
  ) {
    problems.push(
      `${prefix}.reference: required, non-empty, at most ${REFERENCE_MAX_LENGTH} characters`,
    );
  } else if (input.authorizationState === 'public') {
    // The public-source URL rule applies to every publicly-declared input.
    assertValidPublicSourceUrl(input.reference, `${prefix}.reference`);
  }
  if (input.authorizationState === 'explicitly_authorized') {
    if (typeof input.authorizationRef !== 'string' || input.authorizationRef.trim().length === 0) {
      problems.push(
        `${prefix}.authorizationRef: required for an explicitly-authorized input (the /integrations connection id that authorizes the read)`,
      );
    }
  } else if (input.authorizationRef !== null) {
    problems.push(
      `${prefix}.authorizationRef: must be null for a public input (the authorization-state shape fence)`,
    );
  }
  if (
    input.notes !== null &&
    (typeof input.notes !== 'string' || input.notes.length > NOTES_MAX_LENGTH)
  ) {
    problems.push(`${prefix}.notes: at most ${NOTES_MAX_LENGTH} characters`);
  }
  return problems;
}

/**
 * Defensive declaration assertion at the authority boundary: the module
 * never persists a declared context that is not structurally honest — a
 * bounded product name, a bounded optional summary, AT LEAST ONE declared
 * input, every input carrying its frozen §8 kind + authorization state +
 * the authorization-reference shape, and public inputs passing the
 * public-source URL rule.
 */
export function assertValidProductContextDeclaration(
  declaration: ProductContextDeclaration,
): void {
  const problems: string[] = [];
  if (
    typeof declaration.name !== 'string' ||
    declaration.name.trim().length === 0 ||
    declaration.name.length > NAME_MAX_LENGTH
  ) {
    problems.push(`name: required, non-empty, at most ${NAME_MAX_LENGTH} characters`);
  }
  if (
    declaration.summary !== null &&
    (typeof declaration.summary !== 'string' || declaration.summary.length > SUMMARY_MAX_LENGTH)
  ) {
    problems.push(`summary: at most ${SUMMARY_MAX_LENGTH} characters`);
  }
  if (!Array.isArray(declaration.inputs) || declaration.inputs.length === 0) {
    problems.push('inputs: required, at least one declared input (a product context with nothing to inspect is not a product context)');
  } else {
    if (declaration.inputs.length > INPUTS_MAX) {
      problems.push(`inputs: at most ${INPUTS_MAX} declared inputs per version`);
    }
    declaration.inputs.forEach((input, index) => {
      problems.push(...inputProblems(input, `inputs[${index}]`));
    });
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid Product Context declaration', problems);
  }
}

/**
 * SERVER-DERIVED provenance validation (the §21-style guard): the actor
 * is a bounded labeled principal, the surface is a bounded label,
 * correlation is present — a provenance block is never caller-invented
 * free-form payload.
 */
export function assertValidProductIntelligenceProvenance(
  provenance: ProductIntelligenceProvenance,
): void {
  const problems: string[] = [];
  if (
    typeof provenance.actor !== 'string' ||
    provenance.actor.length === 0 ||
    provenance.actor.length > ACTOR_MAX_LENGTH
  ) {
    problems.push('provenance.actor: a server-derived actor label is required');
  }
  if (
    typeof provenance.recordedVia !== 'string' ||
    provenance.recordedVia.length === 0 ||
    provenance.recordedVia.length > ACTOR_MAX_LENGTH
  ) {
    problems.push('provenance.recordedVia: a server-derived surface label is required');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.length === 0) {
    problems.push('provenance.correlationId: required');
  }
  if (
    provenance.causationId !== null &&
    (typeof provenance.causationId !== 'string' || provenance.causationId.length === 0)
  ) {
    problems.push('provenance.causationId: must be null or a non-empty string');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid Product Intelligence provenance', problems);
  }
}

function refListProblems(
  refs: readonly string[],
  field: string,
  problems: string[],
): void {
  if (!Array.isArray(refs)) {
    problems.push(`${field}: must be an array of record ids`);
    return;
  }
  if (refs.length > REFS_MAX) {
    problems.push(`${field}: at most ${REFS_MAX} references`);
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      problems.push(`${field}: every reference must be a non-empty id`);
      return;
    }
    if (seen.has(ref)) {
      problems.push(`${field}: '${ref}' is listed more than once`);
    }
    seen.add(ref);
  }
}

function aiAssistanceProblems(
  aiAssistance: ProductIntelligenceAiAssistance | null,
  problems: string[],
): void {
  if (aiAssistance === null) return;
  if (
    typeof aiAssistance.modelIdentity !== 'string' ||
    aiAssistance.modelIdentity.length === 0 ||
    aiAssistance.modelIdentity.length > MODEL_IDENTITY_MAX_LENGTH
  ) {
    problems.push(
      `aiAssistance.modelIdentity: required, at most ${MODEL_IDENTITY_MAX_LENGTH} characters (the /ai-runtime model-registry id the referenced selection decision chose)`,
    );
  }
  if (
    typeof aiAssistance.callReference !== 'string' ||
    aiAssistance.callReference.length === 0 ||
    aiAssistance.callReference.length > CALL_REFERENCE_MAX_LENGTH
  ) {
    problems.push(
      `aiAssistance.callReference: required, at most ${CALL_REFERENCE_MAX_LENGTH} characters (the /ai-runtime selection-decision id)`,
    );
  }
}

function detailProblems(
  detail: Readonly<Record<string, unknown>> | null,
  problems: string[],
): void {
  if (detail === null) return;
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    problems.push('detail: must be an object or null');
  }
}

/**
 * The derived-model input assertion (AC-3): the frozen §8 kind, a bounded
 * non-empty statement, a structured optional detail, bounded backing
 * reference lists and the honest ai-assistance disclosure shape.
 */
export function assertValidDerivedModelInput(input: {
  readonly derivationKind: ProductIntelligenceDerivationKind;
  readonly statement: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly sourceFactIds: readonly string[];
  readonly evidenceCitations: readonly string[];
  readonly aiAssistance: ProductIntelligenceAiAssistance | null;
}): void {
  const problems: string[] = [];
  if (
    typeof input.derivationKind !== 'string' ||
    !(PRODUCT_INTELLIGENCE_DERIVATION_KINDS as readonly string[]).includes(input.derivationKind)
  ) {
    problems.push(
      `derivationKind: must be one of ${PRODUCT_INTELLIGENCE_DERIVATION_KINDS.join(', ')} (the frozen architecture-v1.6.md §8 derivation vocabulary)`,
    );
  }
  if (
    typeof input.statement !== 'string' ||
    input.statement.trim().length === 0 ||
    input.statement.length > STATEMENT_MAX_LENGTH
  ) {
    problems.push(
      `statement: required, non-empty, at most ${STATEMENT_MAX_LENGTH} characters (the derived claim, verbatim)`,
    );
  }
  detailProblems(input.detail, problems);
  refListProblems(input.sourceFactIds, 'sourceFactIds', problems);
  refListProblems(input.evidenceCitations, 'evidenceCitations', problems);
  aiAssistanceProblems(input.aiAssistance, problems);
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid derived model record', problems);
  }
}

/**
 * The risk-flag input assertion (AC-4): the frozen risk-kind + severity
 * vocabularies, a bounded non-empty statement and the same backing /
 * disclosure discipline.
 */
export function assertValidRiskFlagInput(input: {
  readonly riskKind: ProductIntelligenceRiskKind;
  readonly severity: ProductIntelligenceRiskSeverity;
  readonly statement: string;
  readonly sourceFactIds: readonly string[];
  readonly evidenceCitations: readonly string[];
  readonly aiAssistance: ProductIntelligenceAiAssistance | null;
}): void {
  const problems: string[] = [];
  if (
    typeof input.riskKind !== 'string' ||
    !(PRODUCT_INTELLIGENCE_RISK_KINDS as readonly string[]).includes(input.riskKind)
  ) {
    problems.push(
      `riskKind: must be one of ${PRODUCT_INTELLIGENCE_RISK_KINDS.join(', ')} (the frozen risk-kind vocabulary)`,
    );
  }
  if (
    typeof input.severity !== 'string' ||
    !(PRODUCT_INTELLIGENCE_RISK_SEVERITIES as readonly string[]).includes(input.severity)
  ) {
    problems.push(
      `severity: must be one of ${PRODUCT_INTELLIGENCE_RISK_SEVERITIES.join(', ')} (the frozen severity vocabulary)`,
    );
  }
  if (
    typeof input.statement !== 'string' ||
    input.statement.trim().length === 0 ||
    input.statement.length > STATEMENT_MAX_LENGTH
  ) {
    problems.push(
      `statement: required, non-empty, at most ${STATEMENT_MAX_LENGTH} characters`,
    );
  }
  refListProblems(input.sourceFactIds, 'sourceFactIds', problems);
  refListProblems(input.evidenceCitations, 'evidenceCitations', problems);
  aiAssistanceProblems(input.aiAssistance, problems);
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid risk flag record', problems);
  }
}

/**
 * The pure verification-state derivation (AC-3c): 'unverified' exactly
 * when NO backing evidence reference exists; 'evidence_backed' exactly
 * when at least ONE does. Repetition never changes this — the function
 * reads only PRESENCE, never counts, and the derived rows are append-only
 * so no later mutation can rewrite a recorded state.
 */
export function deriveVerificationState(backing: {
  readonly sourceFactIds: readonly string[];
  readonly evidenceCitations: readonly string[];
}): 'unverified' | 'evidence_backed' {
  return backing.sourceFactIds.length > 0 || backing.evidenceCitations.length > 0
    ? 'evidence_backed'
    : 'unverified';
}

/**
 * Pure composition of the canonical product-context owner context from
 * the context row and the ALREADY-RESOLVED /agencies row (the
 * composeGrowthMissionOwnerContext precedent). Purity is asserted by
 * unit tests.
 */
export function composeProductContextOwnerContext(
  context: ProductContextRecord,
  agency: { readonly agencyId: string; readonly status: string },
  resolvedAt: string,
): {
  readonly scope: {
    readonly kind: 'product-context';
    readonly agencyId: string;
    readonly productContextId: string;
  };
  readonly context: ProductContextRecord;
  readonly agency: { readonly agencyId: string; readonly status: string };
  readonly resolvedAt: string;
} {
  return {
    scope: {
      kind: 'product-context',
      agencyId: context.agencyId,
      productContextId: context.productContextId,
    },
    context,
    agency,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ContextRow extends DbRow {
  product_context_id: string;
  agency_id: string;
  current_version_seq: number | string;
  version: number | string;
  created_actor: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow extends DbRow {
  product_context_version_id: string;
  product_context_id: string;
  version_seq: number | string;
  name: string;
  summary: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface InputRow extends DbRow {
  input_id: string;
  product_context_version_id: string;
  input_kind: string;
  reference: string;
  authorization_state: string;
  authorization_ref: string | null;
  notes: string | null;
}

interface FactRow extends DbRow {
  source_fact_id: string;
  product_context_id: string;
  product_context_version_id: string;
  input_id: string;
  source_url: string;
  fetched_at: Date;
  extractor: string;
  content_hash: string;
  extraction_notes: string | null;
  observation: unknown;
  actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface DerivedRow extends DbRow {
  derived_model_id: string;
  product_context_id: string;
  product_context_version_id: string;
  derivation_kind: string;
  statement: string;
  detail: unknown;
  source_fact_ids: unknown;
  evidence_citations: unknown;
  ai_model_identity: string | null;
  ai_call_reference: string | null;
  verification_state: string;
  hypothesis: boolean;
  actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface RiskRow extends DbRow {
  risk_flag_id: string;
  product_context_id: string;
  product_context_version_id: string;
  risk_kind: string;
  severity: string;
  statement: string;
  source_fact_ids: unknown;
  evidence_citations: unknown;
  ai_model_identity: string | null;
  ai_call_reference: string | null;
  actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const CONTEXT_SELECT = `
  SELECT product_context_id, agency_id, current_version_seq, version,
         created_actor, created_at, updated_at
  FROM product_contexts
`;

const VERSION_SELECT = `
  SELECT v.product_context_version_id, v.product_context_id, v.version_seq,
         v.name, v.summary, v.recorded_actor, v.recorded_via,
         v.correlation_id, v.causation_id, v.created_at
  FROM product_context_versions v
`;

const INPUT_SELECT = `
  SELECT input_id, product_context_version_id, input_kind, reference,
         authorization_state, authorization_ref, notes
  FROM product_context_inputs
`;

const FACT_SELECT = `
  SELECT source_fact_id, product_context_id, product_context_version_id, input_id,
         source_url, fetched_at, extractor, content_hash, extraction_notes,
         observation, actor, recorded_via, correlation_id, causation_id, recorded_at
  FROM product_source_facts
`;

const DERIVED_SELECT = `
  SELECT derived_model_id, product_context_id, product_context_version_id,
         derivation_kind, statement, detail, source_fact_ids, evidence_citations,
         ai_model_identity, ai_call_reference, verification_state, hypothesis,
         actor, recorded_via, correlation_id, causation_id, recorded_at
  FROM product_derived_models
`;

const RISK_SELECT = `
  SELECT risk_flag_id, product_context_id, product_context_version_id,
         risk_kind, severity, statement, source_fact_ids, evidence_citations,
         ai_model_identity, ai_call_reference,
         actor, recorded_via, correlation_id, causation_id, recorded_at
  FROM product_risk_flags
`;

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toContextRecord(row: ContextRow): ProductContextRecord {
  return {
    productContextId: row.product_context_id,
    agencyId: row.agency_id,
    currentVersionSeq: Number(row.current_version_seq),
    version: Number(row.version),
    createdActor: row.created_actor,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function recordedProvenance(
  actor: string,
  recordedVia: string,
  correlationId: string,
  causationId: string | null,
  at: Date,
): ProductIntelligenceProvenance & { readonly recordedAt: string } {
  return {
    actor,
    recordedVia,
    correlationId,
    causationId,
    recordedAt: at.toISOString(),
  };
}

function toVersionRecord(row: VersionRow): ProductContextVersionRecord {
  return {
    productContextVersionId: row.product_context_version_id,
    productContextId: row.product_context_id,
    versionSeq: Number(row.version_seq),
    name: row.name,
    summary: row.summary,
    provenance: recordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}

function toInputRecord(row: InputRow): ProductContextInputRecord {
  return {
    inputId: row.input_id,
    productContextVersionId: row.product_context_version_id,
    inputKind: row.input_kind as ProductContextInputRecord['inputKind'],
    reference: row.reference,
    authorizationState: row.authorization_state as ProductContextInputRecord['authorizationState'],
    authorizationRef: row.authorization_ref,
    notes: row.notes,
  };
}

function toFactRecord(row: FactRow): ProductSourceFactRecord {
  return {
    sourceFactId: row.source_fact_id,
    productContextId: row.product_context_id,
    productContextVersionId: row.product_context_version_id,
    inputId: row.input_id,
    sourceUrl: row.source_url,
    fetchedAt: row.fetched_at.toISOString(),
    extractor: row.extractor,
    contentHash: row.content_hash,
    extractionNotes: row.extraction_notes,
    observation: (row.observation ?? {}) as Record<string, unknown>,
    provenance: recordedProvenance(
      row.actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.recorded_at,
    ),
  };
}

function toDerivedRecord(row: DerivedRow): ProductDerivedModelRecord {
  return {
    derivedModelId: row.derived_model_id,
    productContextId: row.product_context_id,
    productContextVersionId: row.product_context_version_id,
    derivationKind: row.derivation_kind as ProductDerivedModelRecord['derivationKind'],
    statement: row.statement,
    detail: row.detail === null ? null : (row.detail as Record<string, unknown>),
    sourceFactIds: (row.source_fact_ids ?? []) as string[],
    evidenceCitations: (row.evidence_citations ?? []) as string[],
    aiAssistance:
      row.ai_model_identity === null || row.ai_call_reference === null
        ? null
        : { modelIdentity: row.ai_model_identity, callReference: row.ai_call_reference },
    verificationState: row.verification_state as ProductDerivedModelRecord['verificationState'],
    hypothesis: row.hypothesis,
    provenance: recordedProvenance(
      row.actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.recorded_at,
    ),
  };
}

function toRiskRecord(row: RiskRow): ProductRiskFlagRecord {
  return {
    riskFlagId: row.risk_flag_id,
    productContextId: row.product_context_id,
    productContextVersionId: row.product_context_version_id,
    riskKind: row.risk_kind as ProductRiskFlagRecord['riskKind'],
    severity: row.severity as ProductRiskFlagRecord['severity'],
    statement: row.statement,
    sourceFactIds: (row.source_fact_ids ?? []) as string[],
    evidenceCitations: (row.evidence_citations ?? []) as string[],
    aiAssistance:
      row.ai_model_identity === null || row.ai_call_reference === null
        ? null
        : { modelIdentity: row.ai_model_identity, callReference: row.ai_call_reference },
    provenance: recordedProvenance(
      row.actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.recorded_at,
    ),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface AppendVersionInput {
  readonly productContextId: string;
  readonly versionSeq: number;
  readonly declaration: ProductContextDeclaration;
  readonly provenance: ProductIntelligenceProvenance;
}

export interface AppendFactInput {
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly inputId: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly extractor: string;
  readonly contentHash: string;
  readonly extractionNotes: string;
  readonly observation: Readonly<Record<string, unknown>>;
  readonly provenance: ProductIntelligenceProvenance;
}

export class ProductIntelligenceStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // --- the context record ---

  async insertContext(input: {
    readonly productContextId: string;
    readonly agencyId: string;
    readonly createdActor: string;
    readonly now: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO product_contexts (product_context_id, agency_id, current_version_seq,
                                     version, created_actor, created_at, updated_at)
       VALUES ($1, $2, 1, 1, $3, $4, $4)`,
      [input.productContextId, input.agencyId, input.createdActor, input.now],
    );
  }

  async getContext(productContextId: string): Promise<ProductContextRecord | null> {
    const result = await this.db.query<ContextRow>(
      `${CONTEXT_SELECT} WHERE product_context_id = $1`,
      [productContextId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toContextRecord(row);
  }

  async listContextsForAgency(agencyId: string): Promise<readonly ProductContextRecord[]> {
    const result = await this.db.query<ContextRow>(
      `${CONTEXT_SELECT} WHERE agency_id = $1 ORDER BY created_at, product_context_id`,
      [agencyId],
    );
    return result.rows.map(toContextRecord);
  }

  /** Locks the context row (FOR UPDATE) — every mutation is CAS-serialized. */
  async lockContext(
    tx: DbTransaction,
    productContextId: string,
  ): Promise<ProductContextRecord | null> {
    const result = await tx.query<ContextRow>(
      `${CONTEXT_SELECT} WHERE product_context_id = $1 FOR UPDATE`,
      [productContextId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toContextRecord(row);
  }

  /**
   * CAS version-pointer advance on the CALLER'S transaction: the new
   * version row was appended first; the context record now points at it
   * (the pointer only ever ADVANCES — the DB trigger is the backstop).
   */
  async advanceContextVersionRow(
    tx: DbTransaction,
    input: { productContextId: string; versionSeq: number; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE product_contexts SET current_version_seq = $1, version = version + 1, updated_at = $2
       WHERE product_context_id = $3 AND version = $4`,
      [input.versionSeq, now, input.productContextId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, input.productContextId);
  }

  // --- the append-only version tail (+ its inputs) ---

  async appendVersion(tx: DbTransaction, input: AppendVersionInput): Promise<string> {
    const productContextVersionId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO product_context_versions (product_context_version_id, product_context_id,
                                              version_seq, name, summary,
                                              recorded_actor, recorded_via, correlation_id,
                                              causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        productContextVersionId,
        input.productContextId,
        input.versionSeq,
        input.declaration.name,
        input.declaration.summary,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        now,
      ],
    );
    for (const declared of input.declaration.inputs) {
      await tx.query(
        `INSERT INTO product_context_inputs (input_id, product_context_version_id, input_kind,
                                              reference, authorization_state, authorization_ref,
                                              notes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          this.ids.newId(),
          productContextVersionId,
          declared.inputKind,
          declared.reference,
          declared.authorizationState,
          declared.authorizationRef,
          declared.notes,
          now,
        ],
      );
    }
    return productContextVersionId;
  }

  async listVersions(
    productContextId: string,
  ): Promise<readonly ProductContextVersionRecord[]> {
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE v.product_context_id = $1 ORDER BY v.version_seq`,
      [productContextId],
    );
    return result.rows.map(toVersionRecord);
  }

  async getVersionBySeq(
    tx: DbTransaction,
    productContextId: string,
    versionSeq: number,
  ): Promise<ProductContextVersionRecord | null> {
    const result = await tx.query<VersionRow>(
      `${VERSION_SELECT} WHERE v.product_context_id = $1 AND v.version_seq = $2`,
      [productContextId, versionSeq],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersionRecord(row);
  }

  async countVersions(tx: DbTransaction, productContextId: string): Promise<number> {
    const result = await tx.query<{ count: string | number }>(
      `SELECT count(*)::int AS count FROM product_context_versions WHERE product_context_id = $1`,
      [productContextId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listInputsForVersion(
    productContextVersionId: string,
  ): Promise<readonly ProductContextInputRecord[]> {
    const result = await this.db.query<InputRow>(
      `${INPUT_SELECT} WHERE product_context_version_id = $1 ORDER BY input_id`,
      [productContextVersionId],
    );
    return result.rows.map(toInputRecord);
  }

  async listInputsForVersionTx(
    tx: DbTransaction,
    productContextVersionId: string,
  ): Promise<readonly ProductContextInputRecord[]> {
    const result = await tx.query<InputRow>(
      `${INPUT_SELECT} WHERE product_context_version_id = $1 ORDER BY input_id`,
      [productContextVersionId],
    );
    return result.rows.map(toInputRecord);
  }

  // --- the append-only source-fact ledger ---

  async appendFact(tx: DbTransaction, input: AppendFactInput): Promise<string> {
    const sourceFactId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO product_source_facts (source_fact_id, product_context_id,
                                          product_context_version_id, input_id,
                                          source_url, fetched_at, extractor, content_hash,
                                          extraction_notes, observation,
                                          actor, recorded_via, correlation_id,
                                          causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)`,
      [
        sourceFactId,
        input.productContextId,
        input.productContextVersionId,
        input.inputId,
        input.sourceUrl,
        input.fetchedAt,
        input.extractor,
        input.contentHash,
        input.extractionNotes,
        JSON.stringify(input.observation),
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        now,
      ],
    );
    return sourceFactId;
  }

  async listFacts(productContextId: string): Promise<readonly ProductSourceFactRecord[]> {
    const result = await this.db.query<FactRow>(
      `${FACT_SELECT} WHERE product_context_id = $1 ORDER BY recorded_at, source_fact_id`,
      [productContextId],
    );
    return result.rows.map(toFactRecord);
  }

  async getFact(sourceFactId: string): Promise<ProductSourceFactRecord | null> {
    const result = await this.db.query<FactRow>(
      `${FACT_SELECT} WHERE source_fact_id = $1`,
      [sourceFactId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toFactRecord(row);
  }

  // --- the append-only derived-model records ---

  async insertDerivedModel(tx: DbTransaction, input: {
    readonly productContextId: string;
    readonly productContextVersionId: string;
    readonly derivationKind: ProductIntelligenceDerivationKind;
    readonly statement: string;
    readonly detail: Readonly<Record<string, unknown>> | null;
    readonly sourceFactIds: readonly string[];
    readonly evidenceCitations: readonly string[];
    readonly aiAssistance: ProductIntelligenceAiAssistance | null;
    readonly verificationState: 'unverified' | 'evidence_backed';
    readonly hypothesis: boolean;
    readonly provenance: ProductIntelligenceProvenance;
  }): Promise<ProductDerivedModelRecord> {
    const derivedModelId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO product_derived_models (derived_model_id, product_context_id,
                                            product_context_version_id, derivation_kind,
                                            statement, detail, source_fact_ids, evidence_citations,
                                            ai_model_identity, ai_call_reference,
                                            verification_state, hypothesis,
                                            actor, recorded_via, correlation_id,
                                            causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12,
               $13, $14, $15, $16, $17)`,
      [
        derivedModelId,
        input.productContextId,
        input.productContextVersionId,
        input.derivationKind,
        input.statement,
        input.detail === null ? null : JSON.stringify(input.detail),
        JSON.stringify(input.sourceFactIds),
        JSON.stringify(input.evidenceCitations),
        input.aiAssistance === null ? null : input.aiAssistance.modelIdentity,
        input.aiAssistance === null ? null : input.aiAssistance.callReference,
        input.verificationState,
        input.hypothesis,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        now,
      ],
    );
    // The read-back composes through the CALLER'S transaction — the row
    // is visible only on this connection until the commit (READ
    // COMMITTED; the pool's other connections must never be consulted
    // mid-transaction — the growth-missions post-commit discipline,
    // inverted for the in-transaction read-back).
    const result = await tx.query<DerivedRow>(
      `${DERIVED_SELECT} WHERE derived_model_id = $1`,
      [derivedModelId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`derived model ${derivedModelId} could not be read back`);
    }
    return toDerivedRecord(row);
  }

  async listDerivedModels(
    productContextId: string,
  ): Promise<readonly ProductDerivedModelRecord[]> {
    const result = await this.db.query<DerivedRow>(
      `${DERIVED_SELECT} WHERE product_context_id = $1 ORDER BY recorded_at, derived_model_id`,
      [productContextId],
    );
    return result.rows.map(toDerivedRecord);
  }

  async findDerivedModelByStatement(
    productContextId: string,
    derivationKind: string,
    statement: string,
  ): Promise<ProductDerivedModelRecord | null> {
    const result = await this.db.query<DerivedRow>(
      `${DERIVED_SELECT} WHERE product_context_id = $1 AND derivation_kind = $2 AND statement = $3`,
      [productContextId, derivationKind, statement],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDerivedRecord(row);
  }

  // --- the append-only risk flags ---

  async insertRiskFlag(tx: DbTransaction, input: {
    readonly productContextId: string;
    readonly productContextVersionId: string;
    readonly riskKind: ProductIntelligenceRiskKind;
    readonly severity: ProductIntelligenceRiskSeverity;
    readonly statement: string;
    readonly sourceFactIds: readonly string[];
    readonly evidenceCitations: readonly string[];
    readonly aiAssistance: ProductIntelligenceAiAssistance | null;
    readonly provenance: ProductIntelligenceProvenance;
  }): Promise<ProductRiskFlagRecord> {
    const riskFlagId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO product_risk_flags (risk_flag_id, product_context_id,
                                       product_context_version_id, risk_kind, severity,
                                       statement, source_fact_ids, evidence_citations,
                                       ai_model_identity, ai_call_reference,
                                       actor, recorded_via, correlation_id,
                                       causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
               $11, $12, $13, $14, $15)`,
      [
        riskFlagId,
        input.productContextId,
        input.productContextVersionId,
        input.riskKind,
        input.severity,
        input.statement,
        JSON.stringify(input.sourceFactIds),
        JSON.stringify(input.evidenceCitations),
        input.aiAssistance === null ? null : input.aiAssistance.modelIdentity,
        input.aiAssistance === null ? null : input.aiAssistance.callReference,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        now,
      ],
    );
    // The read-back composes through the CALLER'S transaction (READ
    // COMMITTED — the same discipline as the derived models: the row is
    // visible only on this connection until the commit).
    const readBack = await tx.query<RiskRow>(`${RISK_SELECT} WHERE risk_flag_id = $1`, [
      riskFlagId,
    ]);
    const row = readBack.rows[0];
    if (row === undefined) {
      throw new Error(`risk flag ${riskFlagId} could not be read back`);
    }
    return toRiskRecord(row);
  }

  private async getRiskFlag(riskFlagId: string): Promise<ProductRiskFlagRecord | null> {
    const result = await this.db.query<RiskRow>(
      `${RISK_SELECT} WHERE risk_flag_id = $1`,
      [riskFlagId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRiskRecord(row);
  }

  async listRiskFlags(productContextId: string): Promise<readonly ProductRiskFlagRecord[]> {
    const result = await this.db.query<RiskRow>(
      `${RISK_SELECT} WHERE product_context_id = $1 ORDER BY recorded_at, risk_flag_id`,
      [productContextId],
    );
    return result.rows.map(toRiskRecord);
  }
}

async function classifyUpdateMiss(
  tx: DbTransaction,
  productContextId: string,
): Promise<'not-found' | 'version-conflict'> {
  const result = await tx.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM product_contexts WHERE product_context_id = $1) AS exists`,
    [productContextId],
  );
  return result.rows[0]?.exists ? 'version-conflict' : 'not-found';
}
