/**
 * /content-intelligence store + input guards + the deterministic
 * clustering/ranking core (MKT-062).
 *
 * Owns the migration 057 tables: the client-scoped append-only CANDIDATE
 * records (the §6 observed-feature set as data), the FK-anchored
 * same-Client evidence links, the FK-anchored /metrics observation
 * references, the append-only HYPOTHESIS records with their evidence/
 * candidate/research links, and the append-only observation-ingestion run
 * records.
 *
 * The §21 material-key backstop is the SHARED /evidence guard
 * (containsMaterialKey — the /product-intelligence /decisions precedent):
 * the ONE /evidence guard import of this module, READ-ONLY.
 *
 * The deterministic clustering (clusterContentCandidatesByNiche,
 * 'ci-cluster-v1') and ranking (rankContentCandidates, 'ci-rank-v1') are
 * PURE functions: the same inputs always produce the same outputs — no
 * clock, no randomness, no network. Candidates are OBSERVED FEATURES as
 * data, never conclusions (architecture-v1.6.md §6).
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import { containsMaterialKey } from '../../evidence/public.ts';
import type {
  ContentCandidateFeaturesInput,
  ContentCandidateRecord,
  ContentHypothesisRecord,
  ContentIntelligenceProvenance,
  ContentIntelligenceRecordedProvenance,
  ContentObservationIngestionRunRecord,
  ContentNicheCluster,
  RankedContentCandidate,
} from '../public.ts';
import {
  CONTENT_INTELLIGENCE_AUDIENCE_FIT_SIGNALS,
  CONTENT_INTELLIGENCE_FORMATS,
  CONTENT_INTELLIGENCE_HOOK_FEATURES,
  CONTENT_INTELLIGENCE_LENGTH_UNITS,
  CONTENT_INTELLIGENCE_NARRATIVE_STRUCTURES,
  CONTENT_INTELLIGENCE_NOVELTY_STATES,
  CONTENT_INTELLIGENCE_FRESHNESS_STATES,
  CONTENT_INTELLIGENCE_REUSE_RISK_LEVELS,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounds (the frozen input guards — module-side mirrors of the DB fences)
// ---------------------------------------------------------------------------

export const CONTENT_INTELLIGENCE_STATEMENT_SUMMARY_MAX = 2000 as const;
const TOPIC_ENTITY_MAX_LENGTH = 300;
const NICHE_MAX_LENGTH = 200;
const ACTOR_MAX_LENGTH = 100;
const MAX_HOOK_FEATURES = 8;
const MAX_STATEMENT_KEYS = 16;
const MAX_STATEMENT_SERIALIZED = 8000;
const MAX_EVIDENCE_REFS = 20;
const MAX_CANDIDATE_REFS = 20;
const MAX_RESEARCH_REFS = 10;
const MAX_PERFORMANCE_KEYS = 24;
const MAX_PERFORMANCE_SERIALIZED = 4000;
const LENGTH_VALUE_MAX = 10_000_000;
/** The ci-rank-v1 disclosed weight vector (frozen — a change is a NEW calculation version). */
export const CONTENT_INTELLIGENCE_RANK_WEIGHTS = {
  audienceFit: { strong_fit: 3, moderate_fit: 2, weak_fit: 1, unclear: 0 },
  freshness: { breaking: 4, recent: 3, established: 2, evergreen: 2, dated: 0 },
  novelty: { novel: 3, variation: 2, common: 1, saturated: 0 },
  reuseRisk: { low: 3, medium: 2, high: 1, unclear: 0 },
} as const;

// ---------------------------------------------------------------------------
// Input guards (pure — exported for unit tests + future server-side callers)
// ---------------------------------------------------------------------------

/** SERVER-DERIVED provenance validation (the growth-missions guard). */
export function assertValidContentIntelligenceProvenance(
  provenance: ContentIntelligenceProvenance,
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
    throw new InvalidRequestError('Invalid content intelligence provenance', problems);
  }
}

/** Validates one candidate's §6 observed-feature set against the frozen vocabularies + bounds. */
export function assertValidContentCandidateFeatures(features: {
  readonly topicEntity: string;
  readonly niche: string;
  readonly subNiche: string | null;
  readonly contentFormat: string;
  readonly lengthValue: number | null;
  readonly lengthUnit: string | null;
  readonly hookFeatures: readonly string[];
  readonly narrativeStructure: string;
  readonly publishedAt: string | null;
  readonly observedPerformance: Readonly<Record<string, unknown>>;
  readonly performanceVelocity: Readonly<Record<string, unknown>> | null;
  readonly engagement: Readonly<Record<string, unknown>> | null;
  readonly audienceFit: string;
  readonly freshness: string;
  readonly novelty: string;
  readonly reuseRisk: string;
}): void {
  const problems: string[] = [];
  if (
    typeof features.topicEntity !== 'string' ||
    features.topicEntity.length === 0 ||
    features.topicEntity.length > TOPIC_ENTITY_MAX_LENGTH
  ) {
    problems.push(`topicEntity: 1..${TOPIC_ENTITY_MAX_LENGTH} characters`);
  }
  if (
    typeof features.niche !== 'string' ||
    features.niche.length === 0 ||
    features.niche.length > NICHE_MAX_LENGTH
  ) {
    problems.push(`niche: 1..${NICHE_MAX_LENGTH} characters`);
  }
  if (
    features.subNiche !== null &&
    (typeof features.subNiche !== 'string' ||
      features.subNiche.length === 0 ||
      features.subNiche.length > NICHE_MAX_LENGTH)
  ) {
    problems.push(`subNiche: null or 1..${NICHE_MAX_LENGTH} characters`);
  }
  if (
    typeof features.contentFormat !== 'string' ||
    !(CONTENT_INTELLIGENCE_FORMATS as readonly string[]).includes(features.contentFormat)
  ) {
    problems.push('contentFormat: must be one of the frozen content formats');
  }
  // The length pair: both or neither.
  const hasLengthValue = features.lengthValue !== null;
  const hasLengthUnit = features.lengthUnit !== null;
  if (hasLengthValue !== hasLengthUnit) {
    problems.push('lengthValue + lengthUnit: must be supplied together or both null');
  }
  if (
    features.lengthValue !== null &&
    (typeof features.lengthValue !== 'number' ||
      !Number.isFinite(features.lengthValue) ||
      features.lengthValue < 0 ||
      features.lengthValue > LENGTH_VALUE_MAX)
  ) {
    problems.push(`lengthValue: null or 0..${LENGTH_VALUE_MAX}`);
  }
  if (
    features.lengthUnit !== null &&
    (typeof features.lengthUnit !== 'string' ||
      !(CONTENT_INTELLIGENCE_LENGTH_UNITS as readonly string[]).includes(features.lengthUnit))
  ) {
    problems.push('lengthUnit: must be one of the frozen length units');
  }
  if (!Array.isArray(features.hookFeatures)) {
    problems.push('hookFeatures: must be an array');
  } else {
    if (features.hookFeatures.length > MAX_HOOK_FEATURES) {
      problems.push(`hookFeatures: at most ${MAX_HOOK_FEATURES} features`);
    }
    const seen = new Set<string>();
    for (const [index, feature] of features.hookFeatures.entries()) {
      if (
        typeof feature !== 'string' ||
        !(CONTENT_INTELLIGENCE_HOOK_FEATURES as readonly string[]).includes(feature)
      ) {
        problems.push(`hookFeatures[${index}]: unknown hook feature '${String(feature)}'`);
      } else if (seen.has(feature)) {
        problems.push(`hookFeatures[${index}]: duplicate feature '${feature}'`);
      }
      seen.add(feature);
    }
  }
  if (
    typeof features.narrativeStructure !== 'string' ||
    !(CONTENT_INTELLIGENCE_NARRATIVE_STRUCTURES as readonly string[]).includes(
      features.narrativeStructure,
    )
  ) {
    problems.push('narrativeStructure: must be one of the frozen narrative structures');
  }
  if (
    features.publishedAt !== null &&
    (typeof features.publishedAt !== 'string' || Number.isNaN(Date.parse(features.publishedAt)))
  ) {
    problems.push('publishedAt: null or a valid ISO-8601 timestamp');
  }
  problems.push(
    ...observedObjectProblems(features.observedPerformance, 'observedPerformance', true),
  );
  problems.push(
    ...observedObjectProblems(features.performanceVelocity, 'performanceVelocity', false),
  );
  problems.push(...observedObjectProblems(features.engagement, 'engagement', false));
  if (
    typeof features.audienceFit !== 'string' ||
    !(CONTENT_INTELLIGENCE_AUDIENCE_FIT_SIGNALS as readonly string[]).includes(features.audienceFit)
  ) {
    problems.push('audienceFit: must be one of the frozen audience-fit signals');
  }
  if (
    typeof features.freshness !== 'string' ||
    !(CONTENT_INTELLIGENCE_FRESHNESS_STATES as readonly string[]).includes(features.freshness)
  ) {
    problems.push('freshness: must be one of the frozen freshness states');
  }
  if (
    typeof features.novelty !== 'string' ||
    !(CONTENT_INTELLIGENCE_NOVELTY_STATES as readonly string[]).includes(features.novelty)
  ) {
    problems.push('novelty: must be one of the frozen novelty states');
  }
  if (
    typeof features.reuseRisk !== 'string' ||
    !(CONTENT_INTELLIGENCE_REUSE_RISK_LEVELS as readonly string[]).includes(features.reuseRisk)
  ) {
    problems.push('reuseRisk: must be one of the frozen reuse-risk levels');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid content candidate features', problems);
  }
}

/** The bounded observed-data object guard: non-empty when required, §21-guarded. */
function observedObjectProblems(
  value: Readonly<Record<string, unknown>> | null,
  field: string,
  required: boolean,
): string[] {
  if (value === null) {
    return required ? [`${field}: a non-empty observed-data object is required`] : [];
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return [`${field}: must be an object`];
  }
  const problems: string[] = [];
  const keys = Object.keys(value);
  if (keys.length === 0) {
    problems.push(`${field}: a non-empty object is required`);
  }
  if (keys.length > MAX_PERFORMANCE_KEYS) {
    problems.push(`${field}: at most ${MAX_PERFORMANCE_KEYS} keys`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = '';
  }
  if (serialized === '' || serialized.length > MAX_PERFORMANCE_SERIALIZED) {
    problems.push(
      `${field}: the serialized observation must stay under ${MAX_PERFORMANCE_SERIALIZED} characters`,
    );
  }
  if (containsMaterialKey(value)) {
    problems.push(`${field}: material-shaped keys are rejected at every nesting level (§21)`);
  }
  return problems;
}

/** Validates one hypothesis recording input (the frozen kind + the bounded statement). */
export function assertValidContentHypothesisInput(input: {
  readonly hypothesisKind: string;
  readonly statement: Readonly<Record<string, unknown>>;
  readonly evidenceIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly researchInsightIds: readonly string[];
}): void {
  const problems: string[] = [];
  if (
    typeof input.hypothesisKind !== 'string' ||
    !(
      [
        'format_hypothesis',
        'topic_hypothesis',
        'hook_hypothesis',
        'narrative_hypothesis',
        'timing_hypothesis',
        'length_hypothesis',
        'audience_hypothesis',
        'distribution_hypothesis',
      ] as readonly string[]
    ).includes(input.hypothesisKind)
  ) {
    problems.push('hypothesisKind: must be one of the frozen hypothesis kinds');
  }
  problems.push(...statementProblems(input.statement, 'statement'));
  if (!Array.isArray(input.evidenceIds)) {
    problems.push('evidenceIds: must be an array');
  } else {
    if (input.evidenceIds.length === 0) {
      problems.push(
        'evidenceIds: at least one evidence reference is required — evidence/hypothesis separation (a hypothesis cites the evidence it was generated from)',
      );
    }
    if (input.evidenceIds.length > MAX_EVIDENCE_REFS) {
      problems.push(`evidenceIds: at most ${MAX_EVIDENCE_REFS} references`);
    }
    const seen = new Set<string>();
    for (const [index, ref] of input.evidenceIds.entries()) {
      if (typeof ref !== 'string' || ref.length === 0) {
        problems.push(`evidenceIds[${index}]: a non-empty evidence id is required`);
      } else if (seen.has(ref)) {
        problems.push(`evidenceIds[${index}]: duplicate reference '${ref}'`);
      }
      seen.add(ref);
    }
  }
  for (const [field, refs, max] of [
    ['candidateIds', input.candidateIds, MAX_CANDIDATE_REFS],
    ['researchInsightIds', input.researchInsightIds, MAX_RESEARCH_REFS],
  ] as const) {
    if (!Array.isArray(refs)) {
      problems.push(`${field}: must be an array`);
      continue;
    }
    if (refs.length > max) {
      problems.push(`${field}: at most ${max} references`);
    }
    const seen = new Set<string>();
    for (const [index, ref] of refs.entries()) {
      if (typeof ref !== 'string' || ref.length === 0) {
        problems.push(`${field}[${index}]: a non-empty id is required`);
      } else if (seen.has(ref)) {
        problems.push(`${field}[${index}]: duplicate reference '${ref}'`);
      }
      seen.add(ref);
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid content hypothesis recording', problems);
  }
}

/** The bounded statement guard: a non-empty object with a REQUIRED bounded summary, §21-guarded. */
function statementProblems(
  statement: Readonly<Record<string, unknown>>,
  field: string,
): string[] {
  if (statement === null || typeof statement !== 'object' || Array.isArray(statement)) {
    return [`${field}: must be a non-empty object`];
  }
  const problems: string[] = [];
  const keys = Object.keys(statement);
  if (keys.length === 0) {
    problems.push(`${field}: a non-empty object is required`);
  }
  if (keys.length > MAX_STATEMENT_KEYS) {
    problems.push(`${field}: at most ${MAX_STATEMENT_KEYS} keys`);
  }
  const summary = (statement as Record<string, unknown>)['summary'];
  if (
    typeof summary !== 'string' ||
    summary.length === 0 ||
    summary.length > CONTENT_INTELLIGENCE_STATEMENT_SUMMARY_MAX
  ) {
    problems.push(
      `${field}.summary: required, 1..${CONTENT_INTELLIGENCE_STATEMENT_SUMMARY_MAX} characters`,
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(statement);
  } catch {
    serialized = '';
  }
  if (serialized === '' || serialized.length > MAX_STATEMENT_SERIALIZED) {
    problems.push(
      `${field}: the serialized statement must stay under ${MAX_STATEMENT_SERIALIZED} characters`,
    );
  }
  if (containsMaterialKey(statement)) {
    problems.push(`${field}: material-shaped keys are rejected at every nesting level (§21)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The deterministic clustering + ranking core (pure — ci-cluster-v1 / ci-rank-v1)
// ---------------------------------------------------------------------------

/**
 * THE DETERMINISTIC NICHE CLUSTERING ('ci-cluster-v1'): groups candidates
 * by (niche, sub-niche) with per-cluster feature histograms. Pure and
 * total: the same candidates always produce the same clusters in the same
 * order (clusters sorted by key; candidate ids in record order; hook
 * features deduplicated alphabetically). The MKT-062 "niche clustering"
 * acceptance as reproducible DATA — never a mutation.
 */
export function clusterContentCandidatesByNiche(
  candidates: readonly ContentCandidateRecord[],
): readonly ContentNicheCluster[] {
  const clusters = new Map<string, {
    niche: string;
    subNiche: string | null;
    candidateIds: string[];
    formatCounts: Map<string, number>;
    narrativeCounts: Map<string, number>;
    hookFeatures: Set<string>;
  }>();
  for (const candidate of candidates) {
    const key = candidate.subNiche === null
      ? candidate.niche
      : `${candidate.niche} > ${candidate.subNiche}`;
    let cluster = clusters.get(key);
    if (cluster === undefined) {
      cluster = {
        niche: candidate.niche,
        subNiche: candidate.subNiche,
        candidateIds: [],
        formatCounts: new Map(),
        narrativeCounts: new Map(),
        hookFeatures: new Set(),
      };
      clusters.set(key, cluster);
    }
    cluster.candidateIds.push(candidate.contentCandidateId);
    cluster.formatCounts.set(
      candidate.contentFormat,
      (cluster.formatCounts.get(candidate.contentFormat) ?? 0) + 1,
    );
    cluster.narrativeCounts.set(
      candidate.narrativeStructure,
      (cluster.narrativeCounts.get(candidate.narrativeStructure) ?? 0) + 1,
    );
    for (const feature of candidate.hookFeatures) {
      cluster.hookFeatures.add(feature);
    }
  }
  return [...clusters.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, cluster]) => ({
      key,
      niche: cluster.niche,
      subNiche: cluster.subNiche,
      candidateIds: cluster.candidateIds,
      formatCounts: Object.fromEntries(cluster.formatCounts),
      narrativeCounts: Object.fromEntries(cluster.narrativeCounts),
      hookFeatures: [...cluster.hookFeatures].sort(),
    }));
}

/**
 * THE DETERMINISTIC CANDIDATE RANKING ('ci-rank-v1'): orders candidates by
 * the DISCLOSED frozen weight vector over the closed-vocab observed
 * features (audience fit, freshness, novelty, reuse risk). Pure and total:
 * the same candidates always produce the same order (score descending,
 * then candidate id ascending — a deterministic tiebreak, never a
 * coin flip). The ranked order is a RECOMMENDATION as data toward
 * planners — never a mutation, never an outcome claim, and it carries NO
 * causality statement (§6: observed features do not establish causality
 * for the user's account).
 */
export function rankContentCandidates(
  candidates: readonly ContentCandidateRecord[],
): readonly RankedContentCandidate[] {
  const weights = CONTENT_INTELLIGENCE_RANK_WEIGHTS;
  const ranked = candidates.map((candidate) => {
    const breakdown = {
      audienceFit: weights.audienceFit[candidate.audienceFit] ?? 0,
      freshness: weights.freshness[candidate.freshness] ?? 0,
      novelty: weights.novelty[candidate.novelty] ?? 0,
      reuseRisk: weights.reuseRisk[candidate.reuseRisk] ?? 0,
    };
    const score =
      breakdown.audienceFit + breakdown.freshness + breakdown.novelty + breakdown.reuseRisk;
    return { contentCandidateId: candidate.contentCandidateId, score, breakdown };
  });
  ranked.sort((a, b) =>
    b.score - a.score !== 0
      ? b.score - a.score
      : a.contentCandidateId < b.contentCandidateId
        ? -1
        : a.contentCandidateId > b.contentCandidateId
          ? 1
          : 0,
  );
  return ranked;
}

/**
 * Pure composition of the canonical content-candidate owner context from
 * the candidate record (the composeGrowthMissionOwnerContext precedent).
 * The client ROW is resolved at the route layer (requireClientAccess);
 * this context carries the scope identity the route layer authorizes
 * (the agency id rides the route-layer client ownership resolution — the
 * candidate's agency is resolved by the caller's client scope chain).
 */
export function composeContentCandidateOwnerContext(
  candidate: ContentCandidateRecord,
  agencyId: string,
  resolvedAt: string,
): {
  readonly scope: {
    readonly kind: 'content-candidate';
    readonly agencyId: string;
    readonly clientId: string;
    readonly contentCandidateId: string;
  };
  readonly candidate: ContentCandidateRecord;
  readonly resolvedAt: string;
} {
  return {
    scope: {
      kind: 'content-candidate',
      agencyId,
      clientId: candidate.clientId,
      contentCandidateId: candidate.contentCandidateId,
    },
    candidate,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Row shapes (snake_case DB rows)
// ---------------------------------------------------------------------------

interface CandidateRow extends DbRow {
  content_candidate_id: string;
  client_id: string;
  workspace_id: string | null;
  topic_entity: string;
  niche: string;
  sub_niche: string | null;
  content_format: string;
  length_value: string | number | null;
  length_unit: string | null;
  hook_features: string[] | Record<string, unknown>;
  narrative_structure: string;
  published_at: Date | null;
  observed_performance: Record<string, unknown>;
  performance_velocity: Record<string, unknown> | null;
  engagement: Record<string, unknown> | null;
  audience_fit: string;
  freshness_state: string;
  novelty_state: string;
  reuse_risk: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface HypothesisRow extends DbRow {
  content_hypothesis_id: string;
  client_id: string;
  workspace_id: string | null;
  hypothesis_kind: string;
  statement: Record<string, unknown>;
  supersedes_content_hypothesis_id: string | null;
  experiment_id: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface IngestionRunRow extends DbRow {
  ingestion_run_id: string;
  client_id: string;
  workspace_id: string | null;
  connection_id: string;
  observation_kind: string;
  operation: string;
  status: string;
  records_observed: number;
  evidence_appended: number;
  appended_evidence_ids: string[];
  started_at: Date;
  finished_at: Date;
  detail: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class ContentIntelligenceStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  now(): string {
    return this.clock.nowIso();
  }

  newId(): string {
    return this.ids.newId();
  }

  // --- observation ingestion runs ---

  async insertIngestionRun(
    tx: DbTransaction,
    input: {
      readonly ingestionRunId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly connectionId: string;
      readonly observationKind: string;
      readonly operation: string;
      readonly status: string;
      readonly recordsObserved: number;
      readonly evidenceAppended: number;
      readonly appendedEvidenceIds: readonly string[];
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly detail: string | null;
      readonly provenance: ContentIntelligenceProvenance;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO content_observation_ingestion_runs (ingestion_run_id, client_id, workspace_id,
                                                          connection_id, observation_kind, operation,
                                                          status, records_observed, evidence_appended,
                                                          appended_evidence_ids, started_at, finished_at,
                                                          detail, recorded_actor, recorded_via,
                                                          correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        input.ingestionRunId,
        input.clientId,
        input.workspaceId,
        input.connectionId,
        input.observationKind,
        input.operation,
        input.status,
        input.recordsObserved,
        input.evidenceAppended,
        JSON.stringify(input.appendedEvidenceIds),
        input.startedAt,
        input.finishedAt,
        input.detail,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        this.now(),
      ],
    );
  }

  async listIngestionRuns(clientId: string): Promise<ContentObservationIngestionRunRecord[]> {
    const result = await this.db.query<IngestionRunRow>(
      `SELECT * FROM content_observation_ingestion_runs WHERE client_id = $1
        ORDER BY created_at, ingestion_run_id`,
      [clientId],
    );
    return result.rows.map(toIngestionRunRecord);
  }

  // --- candidates ---

  async insertCandidate(
    tx: DbTransaction,
    input: {
      readonly contentCandidateId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly features: ContentCandidateFeaturesInput;
      readonly provenance: ContentIntelligenceProvenance;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO content_candidates (content_candidate_id, client_id, workspace_id,
                                         topic_entity, niche, sub_niche, content_format,
                                         length_value, length_unit, hook_features, narrative_structure,
                                         published_at, observed_performance, performance_velocity,
                                         engagement, audience_fit, freshness_state, novelty_state,
                                         reuse_risk, recorded_actor, recorded_via, correlation_id,
                                         causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24)`,
      [
        input.contentCandidateId,
        input.clientId,
        input.workspaceId,
        input.features.topicEntity,
        input.features.niche,
        input.features.subNiche,
        input.features.contentFormat,
        input.features.lengthValue,
        input.features.lengthUnit,
        JSON.stringify(input.features.hookFeatures),
        input.features.narrativeStructure,
        input.features.publishedAt,
        JSON.stringify(input.features.observedPerformance),
        input.features.performanceVelocity === null
          ? null
          : JSON.stringify(input.features.performanceVelocity),
        input.features.engagement === null ? null : JSON.stringify(input.features.engagement),
        input.features.audienceFit,
        input.features.freshness,
        input.features.novelty,
        input.features.reuseRisk,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        this.now(),
      ],
    );
  }

  async insertCandidateEvidence(
    tx: DbTransaction,
    input: {
      readonly contentCandidateId: string;
      readonly evidenceIds: readonly string[];
    },
  ): Promise<void> {
    for (const [index, evidenceId] of input.evidenceIds.entries()) {
      await tx.query(
        `INSERT INTO content_candidate_evidence (content_candidate_id, evidence_id, position)
         VALUES ($1, $2, $3)`,
        [input.contentCandidateId, evidenceId, index + 1],
      );
    }
  }

  async insertCandidateMetricLinks(
    tx: DbTransaction,
    input: {
      readonly contentCandidateId: string;
      readonly metricObservationIds: readonly string[];
    },
  ): Promise<void> {
    for (const [index, observationId] of input.metricObservationIds.entries()) {
      await tx.query(
        `INSERT INTO content_candidate_metric_observations (content_candidate_id, metric_observation_id, position)
         VALUES ($1, $2, $3)`,
        [input.contentCandidateId, observationId, index + 1],
      );
    }
  }

  async listCandidatesForClient(clientId: string): Promise<ContentCandidateRecord[]> {
    const [candidateRows, evidenceRows, metricRows] = await Promise.all([
      this.db.query<CandidateRow>(
        `SELECT * FROM content_candidates WHERE client_id = $1
          ORDER BY created_at, content_candidate_id`,
        [clientId],
      ),
      this.db.query<{ content_candidate_id: string; evidence_id: string }>(
        `SELECT e.content_candidate_id, e.evidence_id FROM content_candidate_evidence e
           JOIN content_candidates c ON c.content_candidate_id = e.content_candidate_id
          WHERE c.client_id = $1
          ORDER BY e.content_candidate_id, e.position`,
        [clientId],
      ),
      this.db.query<{ content_candidate_id: string; metric_observation_id: string }>(
        `SELECT m.content_candidate_id, m.metric_observation_id
           FROM content_candidate_metric_observations m
           JOIN content_candidates c ON c.content_candidate_id = m.content_candidate_id
          WHERE c.client_id = $1
          ORDER BY m.content_candidate_id, m.position`,
        [clientId],
      ),
    ]);
    return candidateRows.rows.map((row) => {
      const evidence = evidenceRows.rows
        .filter((link) => link.content_candidate_id === row.content_candidate_id)
        .map((link) => link.evidence_id);
      const metrics = metricRows.rows
        .filter((link) => link.content_candidate_id === row.content_candidate_id)
        .map((link) => link.metric_observation_id);
      return toCandidateRecord(row, evidence, metrics);
    });
  }

  async getCandidateById(contentCandidateId: string): Promise<ContentCandidateRecord | null> {
    const candidateRows = await this.db.query<CandidateRow>(
      `SELECT * FROM content_candidates WHERE content_candidate_id = $1`,
      [contentCandidateId],
    );
    const row = candidateRows.rows[0];
    if (row === undefined) return null;
    const [evidenceRows, metricRows] = await Promise.all([
      this.db.query<{ evidence_id: string }>(
        `SELECT evidence_id FROM content_candidate_evidence
          WHERE content_candidate_id = $1 ORDER BY position`,
        [contentCandidateId],
      ),
      this.db.query<{ metric_observation_id: string }>(
        `SELECT metric_observation_id FROM content_candidate_metric_observations
          WHERE content_candidate_id = $1 ORDER BY position`,
        [contentCandidateId],
      ),
    ]);
    return toCandidateRecord(
      row,
      evidenceRows.rows.map((link) => link.evidence_id),
      metricRows.rows.map((link) => link.metric_observation_id),
    );
  }

  // --- hypotheses ---

  async insertHypothesis(
    tx: DbTransaction,
    input: {
      readonly contentHypothesisId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly hypothesisKind: string;
      readonly statement: Readonly<Record<string, unknown>>;
      readonly supersedesContentHypothesisId: string | null;
      readonly experimentId: string | null;
      readonly provenance: ContentIntelligenceProvenance;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO content_hypotheses (content_hypothesis_id, client_id, workspace_id,
                                         hypothesis_kind, statement, supersedes_content_hypothesis_id,
                                         experiment_id, recorded_actor, recorded_via, correlation_id,
                                         causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        input.contentHypothesisId,
        input.clientId,
        input.workspaceId,
        input.hypothesisKind,
        JSON.stringify(input.statement),
        input.supersedesContentHypothesisId,
        input.experimentId,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        this.now(),
      ],
    );
  }

  async insertHypothesisEvidence(
    tx: DbTransaction,
    input: {
      readonly contentHypothesisId: string;
      readonly evidenceIds: readonly string[];
    },
  ): Promise<void> {
    for (const [index, evidenceId] of input.evidenceIds.entries()) {
      await tx.query(
        `INSERT INTO content_hypothesis_evidence (content_hypothesis_id, evidence_id, position)
         VALUES ($1, $2, $3)`,
        [input.contentHypothesisId, evidenceId, index + 1],
      );
    }
  }

  async insertHypothesisCandidates(
    tx: DbTransaction,
    input: {
      readonly contentHypothesisId: string;
      readonly candidateIds: readonly string[];
    },
  ): Promise<void> {
    for (const [index, candidateId] of input.candidateIds.entries()) {
      await tx.query(
        `INSERT INTO content_hypothesis_candidates (content_hypothesis_id, content_candidate_id, position)
         VALUES ($1, $2, $3)`,
        [input.contentHypothesisId, candidateId, index + 1],
      );
    }
  }

  async insertHypothesisResearchRefs(
    tx: DbTransaction,
    input: {
      readonly contentHypothesisId: string;
      readonly researchInsightIds: readonly string[];
    },
  ): Promise<void> {
    for (const [index, insightId] of input.researchInsightIds.entries()) {
      await tx.query(
        `INSERT INTO content_hypothesis_research_refs (content_hypothesis_id, research_insight_id, position)
         VALUES ($1, $2, $3)`,
        [input.contentHypothesisId, insightId, index + 1],
      );
    }
  }

  async listHypothesesForClient(clientId: string): Promise<ContentHypothesisRecord[]> {
    const [hypothesisRows, evidenceRows, candidateRows, researchRows] = await Promise.all([
      this.db.query<HypothesisRow>(
        `SELECT * FROM content_hypotheses WHERE client_id = $1
          ORDER BY created_at, content_hypothesis_id`,
        [clientId],
      ),
      this.db.query<{ content_hypothesis_id: string; evidence_id: string }>(
        `SELECT e.content_hypothesis_id, e.evidence_id FROM content_hypothesis_evidence e
           JOIN content_hypotheses h ON h.content_hypothesis_id = e.content_hypothesis_id
          WHERE h.client_id = $1
          ORDER BY e.content_hypothesis_id, e.position`,
        [clientId],
      ),
      this.db.query<{ content_hypothesis_id: string; content_candidate_id: string }>(
        `SELECT c.content_hypothesis_id, c.content_candidate_id FROM content_hypothesis_candidates c
           JOIN content_hypotheses h ON h.content_hypothesis_id = c.content_hypothesis_id
          WHERE h.client_id = $1
          ORDER BY c.content_hypothesis_id, c.position`,
        [clientId],
      ),
      this.db.query<{ content_hypothesis_id: string; research_insight_id: string }>(
        `SELECT r.content_hypothesis_id, r.research_insight_id FROM content_hypothesis_research_refs r
           JOIN content_hypotheses h ON h.content_hypothesis_id = r.content_hypothesis_id
          WHERE h.client_id = $1
          ORDER BY r.content_hypothesis_id, r.position`,
        [clientId],
      ),
    ]);
    const supersededBy = await this.db.query<{
      supersedes_content_hypothesis_id: string;
      superseded_by: string;
    }>(
      `SELECT supersedes_content_hypothesis_id, content_hypothesis_id AS superseded_by
         FROM content_hypotheses
        WHERE client_id = $1 AND supersedes_content_hypothesis_id IS NOT NULL`,
      [clientId],
    );
    const supersededByMap = new Map(
      supersededBy.rows.map((row) => [row.supersedes_content_hypothesis_id, row.superseded_by]),
    );
    return hypothesisRows.rows.map((row) => {
      const evidence = evidenceRows.rows
        .filter((link) => link.content_hypothesis_id === row.content_hypothesis_id)
        .map((link) => link.evidence_id);
      const candidates = candidateRows.rows
        .filter((link) => link.content_hypothesis_id === row.content_hypothesis_id)
        .map((link) => link.content_candidate_id);
      const research = researchRows.rows
        .filter((link) => link.content_hypothesis_id === row.content_hypothesis_id)
        .map((link) => link.research_insight_id);
      return toHypothesisRecord(
        row,
        evidence,
        candidates,
        research,
        supersededByMap.get(row.content_hypothesis_id) ?? null,
      );
    });
  }

  async getHypothesisById(contentHypothesisId: string): Promise<ContentHypothesisRecord | null> {
    const hypothesisRows = await this.db.query<HypothesisRow>(
      `SELECT * FROM content_hypotheses WHERE content_hypothesis_id = $1`,
      [contentHypothesisId],
    );
    const row = hypothesisRows.rows[0];
    if (row === undefined) return null;
    const [evidenceRows, candidateRows, researchRows, supersededBy] = await Promise.all([
      this.db.query<{ evidence_id: string }>(
        `SELECT evidence_id FROM content_hypothesis_evidence
          WHERE content_hypothesis_id = $1 ORDER BY position`,
        [contentHypothesisId],
      ),
      this.db.query<{ content_candidate_id: string }>(
        `SELECT content_candidate_id FROM content_hypothesis_candidates
          WHERE content_hypothesis_id = $1 ORDER BY position`,
        [contentHypothesisId],
      ),
      this.db.query<{ research_insight_id: string }>(
        `SELECT research_insight_id FROM content_hypothesis_research_refs
          WHERE content_hypothesis_id = $1 ORDER BY position`,
        [contentHypothesisId],
      ),
      this.db.query<{ superseded_by: string }>(
        `SELECT content_hypothesis_id AS superseded_by FROM content_hypotheses
          WHERE supersedes_content_hypothesis_id = $1`,
        [contentHypothesisId],
      ),
    ]);
    return toHypothesisRecord(
      row,
      evidenceRows.rows.map((link) => link.evidence_id),
      candidateRows.rows.map((link) => link.content_candidate_id),
      researchRows.rows.map((link) => link.research_insight_id),
      supersededBy.rows[0]?.superseded_by ?? null,
    );
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

function toRecordedProvenance(
  actor: string,
  recordedVia: string,
  correlationId: string,
  causationId: string | null,
  recordedAt: Date,
): ContentIntelligenceRecordedProvenance {
  return {
    actor,
    recordedVia,
    correlationId,
    causationId,
    recordedAt: toIso(recordedAt),
  };
}

function toHookFeatures(value: string[] | Record<string, unknown>): readonly ContentCandidateRecord['hookFeatures'][number][] {
  const list: readonly unknown[] = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object' && Array.isArray((value as { hookFeatures?: unknown }).hookFeatures)
      ? ((value as { hookFeatures: unknown[] }).hookFeatures)
      : [];
  return list.filter(
    (entry): entry is ContentCandidateRecord['hookFeatures'][number] =>
      typeof entry === 'string' &&
      (CONTENT_INTELLIGENCE_HOOK_FEATURES as readonly string[]).includes(entry),
  );
}

function toCandidateRecord(
  row: CandidateRow,
  evidence: readonly string[],
  metrics: readonly string[],
): ContentCandidateRecord {
  return {
    contentCandidateId: row.content_candidate_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    topicEntity: row.topic_entity,
    niche: row.niche,
    subNiche: row.sub_niche,
    contentFormat: row.content_format as ContentCandidateRecord['contentFormat'],
    lengthValue:
      row.length_value === null ? null : Number(row.length_value),
    lengthUnit: row.length_unit as ContentCandidateRecord['lengthUnit'],
    hookFeatures: toHookFeatures(row.hook_features),
    narrativeStructure: row.narrative_structure as ContentCandidateRecord['narrativeStructure'],
    publishedAt: row.published_at === null ? null : toIso(row.published_at),
    observedPerformance: row.observed_performance,
    performanceVelocity: row.performance_velocity,
    engagement: row.engagement,
    audienceFit: row.audience_fit as ContentCandidateRecord['audienceFit'],
    freshness: row.freshness_state as ContentCandidateRecord['freshness'],
    novelty: row.novelty_state as ContentCandidateRecord['novelty'],
    reuseRisk: row.reuse_risk as ContentCandidateRecord['reuseRisk'],
    evidenceIds: evidence,
    metricObservationIds: metrics,
    provenance: toRecordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}

function toHypothesisRecord(
  row: HypothesisRow,
  evidence: readonly string[],
  candidates: readonly string[],
  research: readonly string[],
  supersededBy: string | null,
): ContentHypothesisRecord {
  return {
    contentHypothesisId: row.content_hypothesis_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    hypothesisKind: row.hypothesis_kind as ContentHypothesisRecord['hypothesisKind'],
    statement: row.statement,
    supersedesContentHypothesisId: row.supersedes_content_hypothesis_id,
    supersededByContentHypothesisId: supersededBy,
    evidenceIds: evidence,
    candidateIds: candidates,
    researchInsightIds: research,
    experimentId: row.experiment_id,
    provenance: toRecordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}

function toIngestionRunRecord(row: IngestionRunRow): ContentObservationIngestionRunRecord {
  return {
    ingestionRunId: row.ingestion_run_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    observationKind: row.observation_kind as ContentObservationIngestionRunRecord['observationKind'],
    operation: row.operation,
    status: row.status as ContentObservationIngestionRunRecord['status'],
    recordsObserved: row.records_observed,
    evidenceAppended: row.evidence_appended,
    appendedEvidenceIds: Array.isArray(row.appended_evidence_ids)
      ? row.appended_evidence_ids
      : [],
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    detail: row.detail,
    provenance: toRecordedProvenance(
      row.recorded_actor,
      row.recorded_via,
      row.correlation_id,
      row.causation_id,
      row.created_at,
    ),
  };
}
