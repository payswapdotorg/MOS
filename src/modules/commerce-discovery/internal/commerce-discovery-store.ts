/**
 * /commerce-discovery persistence (MKT-072 — the migration-062 tables).
 *
 * Owns EXACTLY the module's own tables (the 058/060 table discipline):
 *
 *   commerce_discovery_missions               — the program headers (the
 *                                               lifecycle state + the
 *                                               version-tail pointer + the
 *                                               CAS token; the ONE mutable
 *                                               row family);
 *   commerce_discovery_mission_versions       — the APPEND-ONLY version
 *                                               tail (the declared
 *                                               bounded-spend budget + the
 *                                               derived plan blocks);
 *   commerce_discovery_events                 — the APPEND-ONLY history
 *                                               tail;
 *   commerce_discovery_candidates             — the APPEND-ONLY candidate
 *                                               records;
 *   commerce_discovery_demand_tests           — the demand-test arm records
 *                                               (the single guarded
 *                                               launched→concluded advance);
 *   commerce_discovery_outcomes               — the APPEND-ONLY learning-
 *                                               loop outcome records;
 *   commerce_discovery_guardrail_evaluations  — the APPEND-ONLY guardrail
 *                                               evaluation records;
 *   the THIRTEEN citation link tables         — the FK-anchored
 *                                               scope-fenced citation
 *                                               basis.
 *
 * NO AUTHORITY TRANSFER: no mission, goal, product-context, content,
 * health, analysis, experiment, metric, commerce-event, connection, policy
 * or tenant table is written here — the anchored authority tables are read
 * CHECK-ONLY by the DB scope triggers. Versions, events, candidates,
 * outcomes, evaluations and every citation link are APPEND-ONLY: UPDATE
 * and DELETE are rejected by the migration-062 triggers (history is never
 * rewritten); the demand tests admit exactly the one guarded conclusion
 * advance.
 */

import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import { ConflictError } from '../../../platform/errors/errors.ts';
import type {
  CommerceDiscoveryCandidateRecord,
  CommerceDiscoveryDemandTestRecord,
  CommerceDiscoveryEventDetail,
  CommerceDiscoveryEventKind,
  CommerceDiscoveryEventRecord,
  CommerceDiscoveryGuardrailEvaluationRecord,
  CommerceDiscoveryMissionRecord,
  CommerceDiscoveryOutcomeRecord,
  CommerceDiscoveryProvenance,
  CommerceDiscoveryStatus,
  CommerceDiscoveryVersionRecord,
  ComposedCommerceDiscoveryPlan,
  DiscoveryCitation,
} from '../public.ts';

interface ProgramRow extends DbRow {
  commerce_discovery_mission_id: string;
  mission_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  current_version_seq: number;
  version: number;
  created_actor: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow extends DbRow {
  commerce_discovery_mission_version_id: string;
  commerce_discovery_mission_id: string;
  version_seq: number;
  product_context_id: string;
  product_context_version_id: string;
  store_connection_id: string;
  spend_currency: string;
  test_budget_minor_units: number;
  max_demand_tests: number;
  min_order_count_for_viability: number;
  reason: string;
  input_snapshot: unknown;
  input_digest: string;
  niche_selection: unknown;
  candidate_proposals: unknown;
  demand_test_plan: unknown;
  economic_gates: unknown;
  decisions: unknown;
  strategy_version: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface EventRow extends DbRow {
  commerce_discovery_event_id: string;
  commerce_discovery_mission_id: string;
  event_seq: number;
  event_kind: string;
  from_status: string | null;
  to_status: string | null;
  reason: string;
  detail: unknown;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface CandidateRow extends DbRow {
  commerce_discovery_candidate_id: string;
  commerce_discovery_mission_id: string;
  mission_id: string;
  agency_id: string;
  client_id: string;
  label: string;
  niche: string;
  sub_niche: string | null;
  product_descriptor: string;
  estimated_cost_minor_units: number;
  estimated_price_minor_units: number;
  economics_currency: string;
  demand_hypothesis: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface DemandTestRow extends DbRow {
  commerce_discovery_demand_test_id: string;
  commerce_discovery_mission_id: string;
  commerce_discovery_candidate_id: string;
  mission_id: string;
  agency_id: string;
  client_id: string;
  experiment_id: string;
  test_spend_minor_units: number;
  spend_currency: string;
  derived_experiment_design: unknown;
  state: string;
  conclusion_result_state: string | null;
  conclusion_uncertainty_representation: string | null;
  conclusion_recorded_at: Date | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface OutcomeRow extends DbRow {
  commerce_discovery_outcome_id: string;
  commerce_discovery_mission_id: string;
  commerce_discovery_candidate_id: string;
  mission_id: string;
  agency_id: string;
  client_id: string;
  observed_order_count: number;
  observed_cancelled_order_count: number;
  observed_order_values: unknown;
  viability_verdict: string;
  listing_recommendation: string;
  rationale: string;
  reason: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface EvaluationRow extends DbRow {
  commerce_discovery_evaluation_id: string;
  commerce_discovery_mission_id: string;
  mission_id: string;
  agency_id: string;
  client_id: string;
  evaluated_spend_currency: string;
  evaluated_test_budget_minor_units: number;
  evaluated_max_demand_tests: number;
  observed_spend_minor_units: number;
  observed_demand_test_count: number;
  observed_order_count: number;
  verdict: string;
  breach_reasons: unknown;
  rationale: string;
  reason: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

const PROGRAM_SELECT = `
  SELECT commerce_discovery_mission_id, mission_id, agency_id, client_id, workspace_id,
         status, current_version_seq, version, created_actor, created_at, updated_at
  FROM commerce_discovery_missions
`;

const VERSION_SELECT = `
  SELECT commerce_discovery_mission_version_id, commerce_discovery_mission_id, version_seq,
         product_context_id, product_context_version_id, store_connection_id,
         spend_currency, test_budget_minor_units, max_demand_tests, min_order_count_for_viability,
         reason, input_snapshot, input_digest, niche_selection, candidate_proposals,
         demand_test_plan, economic_gates, decisions, strategy_version,
         recorded_actor, recorded_via, correlation_id, causation_id, created_at
  FROM commerce_discovery_mission_versions
`;

const EVENT_SELECT = `
  SELECT commerce_discovery_event_id, commerce_discovery_mission_id, event_seq, event_kind,
         from_status, to_status, reason, detail,
         recorded_actor, recorded_via, correlation_id, causation_id, created_at
  FROM commerce_discovery_events
`;

const CANDIDATE_SELECT = `
  SELECT commerce_discovery_candidate_id, commerce_discovery_mission_id, mission_id, agency_id,
         client_id, label, niche, sub_niche, product_descriptor, estimated_cost_minor_units,
         estimated_price_minor_units, economics_currency, demand_hypothesis,
         recorded_actor, recorded_via, correlation_id, causation_id, created_at
  FROM commerce_discovery_candidates
`;

const DEMAND_TEST_SELECT = `
  SELECT commerce_discovery_demand_test_id, commerce_discovery_mission_id,
         commerce_discovery_candidate_id, mission_id, agency_id, client_id, experiment_id,
         test_spend_minor_units, spend_currency, derived_experiment_design, state,
         conclusion_result_state, conclusion_uncertainty_representation, conclusion_recorded_at,
         recorded_actor, recorded_via, correlation_id, causation_id, created_at
  FROM commerce_discovery_demand_tests
`;

const OUTCOME_SELECT = `
  SELECT commerce_discovery_outcome_id, commerce_discovery_mission_id, commerce_discovery_candidate_id,
         mission_id, agency_id, client_id, observed_order_count, observed_cancelled_order_count,
         observed_order_values, viability_verdict, listing_recommendation, rationale, reason,
         recorded_actor, recorded_via, correlation_id, causation_id, created_at
  FROM commerce_discovery_outcomes
`;

const EVALUATION_SELECT = `
  SELECT commerce_discovery_evaluation_id, commerce_discovery_mission_id, mission_id, agency_id,
         client_id, evaluated_spend_currency, evaluated_test_budget_minor_units, evaluated_max_demand_tests,
         observed_spend_minor_units, observed_demand_test_count, observed_order_count,
         verdict, breach_reasons, rationale, reason,
         recorded_actor, recorded_via, correlation_id, causation_id, created_at
  FROM commerce_discovery_guardrail_evaluations
`;

function toProgramRecord(row: ProgramRow): CommerceDiscoveryMissionRecord {
  return {
    discoveryMissionId: row.commerce_discovery_mission_id,
    missionId: row.mission_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    status: row.status as CommerceDiscoveryStatus,
    currentVersionSeq: row.current_version_seq,
    version: row.version,
    createdActor: row.created_actor,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function toVersionRecord(row: VersionRow): CommerceDiscoveryVersionRecord {
  return {
    discoveryVersionId: row.commerce_discovery_mission_version_id,
    discoveryMissionId: row.commerce_discovery_mission_id,
    versionSeq: row.version_seq,
    productContextId: row.product_context_id,
    productContextVersionId: row.product_context_version_id,
    storeConnectionId: row.store_connection_id,
    declared: {
      spendCurrency: row.spend_currency,
      testBudgetMinorUnits: row.test_budget_minor_units,
      maxDemandTests: row.max_demand_tests,
      minOrderCountForViability: row.min_order_count_for_viability,
    },
    reason: row.reason,
    inputSnapshot: (row.input_snapshot ?? {}) as Readonly<Record<string, unknown>>,
    inputDigest: row.input_digest,
    nicheSelection: (row.niche_selection ?? []) as CommerceDiscoveryVersionRecord['nicheSelection'],
    candidateProposals:
      (row.candidate_proposals ?? []) as CommerceDiscoveryVersionRecord['candidateProposals'],
    demandTestPlan: (row.demand_test_plan ?? {}) as CommerceDiscoveryVersionRecord['demandTestPlan'],
    economicGates: (row.economic_gates ?? {}) as CommerceDiscoveryVersionRecord['economicGates'],
    decisions: (row.decisions ?? []) as CommerceDiscoveryVersionRecord['decisions'],
    strategyVersion: row.strategy_version as CommerceDiscoveryVersionRecord['strategyVersion'],
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function toEventRecord(row: EventRow): CommerceDiscoveryEventRecord {
  return {
    eventId: row.commerce_discovery_event_id,
    discoveryMissionId: row.commerce_discovery_mission_id,
    eventSeq: row.event_seq,
    eventKind: row.event_kind as CommerceDiscoveryEventKind,
    fromStatus: (row.from_status ?? null) as CommerceDiscoveryStatus | null,
    toStatus: (row.to_status ?? null) as CommerceDiscoveryStatus | null,
    reason: row.reason,
    detail: (row.detail ?? null) as CommerceDiscoveryEventDetail,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
  };
}

function toCandidateRecord(row: CandidateRow): CommerceDiscoveryCandidateRecord {
  return {
    candidateId: row.commerce_discovery_candidate_id,
    discoveryMissionId: row.commerce_discovery_mission_id,
    missionId: row.mission_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    label: row.label,
    niche: row.niche,
    subNiche: row.sub_niche,
    productDescriptor: row.product_descriptor,
    estimatedCostMinorUnits: row.estimated_cost_minor_units,
    estimatedPriceMinorUnits: row.estimated_price_minor_units,
    economicsCurrency: row.economics_currency,
    demandHypothesis: row.demand_hypothesis,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function toDemandTestRecord(row: DemandTestRow): CommerceDiscoveryDemandTestRecord {
  return {
    demandTestId: row.commerce_discovery_demand_test_id,
    discoveryMissionId: row.commerce_discovery_mission_id,
    candidateId: row.commerce_discovery_candidate_id,
    missionId: row.mission_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    experimentId: row.experiment_id,
    testSpendMinorUnits: row.test_spend_minor_units,
    spendCurrency: row.spend_currency,
    derivedExperimentDesign:
      (row.derived_experiment_design ?? {}) as Readonly<Record<string, unknown>>,
    state: row.state as CommerceDiscoveryDemandTestRecord['state'],
    conclusionResultState: row.conclusion_result_state,
    conclusionUncertaintyRepresentation: row.conclusion_uncertainty_representation,
    conclusionRecordedAt:
      row.conclusion_recorded_at === null
        ? null
        : row.conclusion_recorded_at instanceof Date
          ? row.conclusion_recorded_at.toISOString()
          : String(row.conclusion_recorded_at),
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function toOutcomeRecord(row: OutcomeRow): CommerceDiscoveryOutcomeRecord {
  return {
    outcomeId: row.commerce_discovery_outcome_id,
    discoveryMissionId: row.commerce_discovery_mission_id,
    candidateId: row.commerce_discovery_candidate_id,
    missionId: row.mission_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    observedOrderCount: row.observed_order_count,
    observedCancelledOrderCount: row.observed_cancelled_order_count,
    observedOrderValues:
      (row.observed_order_values ?? {}) as Readonly<Record<string, number>>,
    viabilityVerdict: row.viability_verdict as CommerceDiscoveryOutcomeRecord['viabilityVerdict'],
    listingRecommendation:
      row.listing_recommendation as CommerceDiscoveryOutcomeRecord['listingRecommendation'],
    rationale: row.rationale,
    reason: row.reason,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function toEvaluationRecord(row: EvaluationRow): CommerceDiscoveryGuardrailEvaluationRecord {
  return {
    evaluationId: row.commerce_discovery_evaluation_id,
    discoveryMissionId: row.commerce_discovery_mission_id,
    missionId: row.mission_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    evaluated: {
      spendCurrency: row.evaluated_spend_currency,
      testBudgetMinorUnits: row.evaluated_test_budget_minor_units,
      maxDemandTests: row.evaluated_max_demand_tests,
    },
    observed: {
      spendMinorUnits: row.observed_spend_minor_units,
      demandTestCount: row.observed_demand_test_count,
      orderCount: row.observed_order_count,
    },
    verdict: row.verdict as CommerceDiscoveryGuardrailEvaluationRecord['verdict'],
    breachReasons: (row.breach_reasons ?? []) as CommerceDiscoveryGuardrailEvaluationRecord['breachReasons'],
    rationale: row.rationale,
    reason: row.reason,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * The version-citation link table map (which citation kinds ride which
 * FK-anchored table — the fabrication-resistance validation input).
 */
const VERSION_CITATION_TABLES: Readonly<
  Record<DiscoveryCitation['kind'], { table: string; column: string } | undefined>
> = {
  product_derived_model: {
    table: 'commerce_discovery_version_cited_product_models',
    column: 'derived_model_id',
  },
  content_candidate: {
    table: 'commerce_discovery_version_cited_content_candidates',
    column: 'content_candidate_id',
  },
  content_hypothesis: {
    table: 'commerce_discovery_version_cited_content_hypotheses',
    column: 'content_hypothesis_id',
  },
  platform_health_evaluation: {
    table: 'commerce_discovery_version_cited_platform_health_evaluations',
    column: 'platform_health_evaluation_id',
  },
  experiment_analysis: {
    table: 'commerce_discovery_version_cited_experiment_analyses',
    column: 'analysis_id',
  },
};

/** The candidate-citation link table map. */
const CANDIDATE_CITATION_TABLES: Readonly<
  Record<DiscoveryCitation['kind'], { table: string; column: string } | undefined>
> = {
  product_derived_model: {
    table: 'commerce_discovery_candidate_cited_product_models',
    column: 'derived_model_id',
  },
  content_candidate: {
    table: 'commerce_discovery_candidate_cited_content_candidates',
    column: 'content_candidate_id',
  },
  content_hypothesis: {
    table: 'commerce_discovery_candidate_cited_content_hypotheses',
    column: 'content_hypothesis_id',
  },
  platform_health_evaluation: undefined,
  experiment_analysis: undefined,
};

async function insertCitations(
  tx: DbTransaction,
  map: typeof VERSION_CITATION_TABLES,
  ownerColumn: string,
  ownerId: string,
  citations: readonly DiscoveryCitation[],
): Promise<void> {
  const positions = new Map<string, number>();
  for (const citation of citations) {
    const target = map[citation.kind];
    if (target === undefined) {
      throw new ConflictError(
        `citation kind '${citation.kind}' is not a citation of this record family`,
      );
    }
    const position = (positions.get(citation.kind) ?? 0) + 1;
    positions.set(citation.kind, position);
    await tx.query(
      `INSERT INTO ${target.table} (${ownerColumn}, ${target.column}, position)
       VALUES ($1, $2, $3)`,
      [ownerId, citation.refId, position],
    );
  }
}

/** The input of one version append (the header creation or the version advance). */
export interface DiscoveryVersionInsertInput {
  readonly programId: string;
  readonly missionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly versionSeq: number;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly storeConnectionId: string;
  readonly reason: string;
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
  readonly composed: ComposedCommerceDiscoveryPlan;
  readonly provenance: CommerceDiscoveryProvenance;
  /** The valid citation id sets — the fabrication-resistance validation input. */
  readonly validCitations: Readonly<Record<DiscoveryCitation['kind'], ReadonlySet<string>>>;
}

/**
 * Validates that every citation the composed plan emits references a
 * record present in the input snapshot (the fabrication-resistance
 * server-side fence: the core NEVER emits a plan citing records it does
 * not reference — a violation is a hard error, never persisted).
 */
function assertCitationsResolve(input: DiscoveryVersionInsertInput): void {
  const problems: string[] = [];
  for (const citation of input.composed.citations) {
    if (!input.validCitations[citation.kind]?.has(citation.refId)) {
      problems.push(`${citation.kind}:${citation.refId} is not part of the discovery input snapshot`);
    }
  }
  if (problems.length > 0) {
    throw new ConflictError(
      `commerce-discovery plan citations do not resolve in the input snapshot: ${problems.join('; ')}`,
    );
  }
}

/** The demand-test conclusion advance input. */
export interface DemandTestConclusionAdvanceInput {
  readonly demandTestId: string;
  readonly conclusionResultState: string;
  readonly conclusionUncertaintyRepresentation: string;
  readonly concludedAt: string;
}

export class CommerceDiscoveryStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /** Fresh id (the platform IdGenerator — server-derived, never caller input). */
  newId(): string {
    return this.ids.newId();
  }

  /** The module clock (server-stamped recording times, never caller input). */
  nowIso(): string {
    return this.clock.nowIso();
  }

  /**
   * Appends ONE append-only history event under the program row lock (the
   * gapless per-program sequence). The caller MUST already hold the row
   * lock inside the same transaction.
   */
  private async appendEvent(
    tx: DbTransaction,
    input: {
      readonly programId: string;
      readonly eventKind: CommerceDiscoveryEventKind;
      readonly fromStatus: string | null;
      readonly toStatus: string | null;
      readonly reason: string;
      readonly detail: CommerceDiscoveryEventDetail;
      readonly provenance: CommerceDiscoveryProvenance;
      readonly now: string;
    },
  ): Promise<void> {
    const seqResult = await tx.query<{ next: number }>(
      `SELECT COALESCE(MAX(event_seq), 0) + 1 AS next
         FROM commerce_discovery_events
        WHERE commerce_discovery_mission_id = $1`,
      [input.programId],
    );
    const eventSeq = seqResult.rows[0]?.next ?? 1;
    await tx.query(
      `INSERT INTO commerce_discovery_events
         (commerce_discovery_event_id, commerce_discovery_mission_id, event_seq, event_kind,
          from_status, to_status, reason, detail,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
      [
        this.newId(),
        input.programId,
        eventSeq,
        input.eventKind,
        input.fromStatus,
        input.toStatus,
        input.reason,
        JSON.stringify(input.detail ?? {}),
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        input.now,
      ],
    );
  }

  /**
   * Appends ONE plan version under the program row lock — creating the
   * program header on the first version (ONE program per mission;
   * concurrent first compositions converge) and advancing the version-tail
   * pointer on the rest. The append, its citation links and its history
   * events persist in a single transaction.
   */
  async appendVersion(input: DiscoveryVersionInsertInput): Promise<{
    readonly program: CommerceDiscoveryMissionRecord;
    readonly version: CommerceDiscoveryVersionRecord;
    readonly created: boolean;
  }> {
    assertCitationsResolve(input);
    const now = this.nowIso();
    const versionId = this.newId();

    const created = await this.db.transaction(async (tx: DbTransaction) => {
      const existing = await tx.query<ProgramRow>(
        `SELECT * FROM commerce_discovery_missions WHERE mission_id = $1 FOR UPDATE`,
        [input.missionId],
      );
      let header: ProgramRow;
      let wasCreated = false;
      if (existing.rows.length === 0) {
        if (input.versionSeq !== 1) {
          throw new Error('discovery version sequence must start at 1 for a new program');
        }
        wasCreated = true;
        await tx.query(
          `INSERT INTO commerce_discovery_missions
             (commerce_discovery_mission_id, mission_id, agency_id, client_id, workspace_id,
              status, current_version_seq, version, created_actor, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, 1, $7, $8, $8)`,
          [
            input.programId,
            input.missionId,
            input.agencyId,
            input.clientId,
            input.workspaceId,
            input.versionSeq,
            input.provenance.actor,
            now,
          ],
        );
        const inserted = await tx.query<ProgramRow>(
          `${PROGRAM_SELECT} WHERE commerce_discovery_mission_id = $1`,
          [input.programId],
        );
        header = inserted.rows[0]!;
        await this.appendEvent(tx, {
          programId: input.programId,
          eventKind: 'discovery_created',
          fromStatus: null,
          toStatus: 'active',
          reason: input.reason,
          detail: null,
          provenance: input.provenance,
          now,
        });
      } else {
        header = existing.rows[0]!;
        const nextSeq = header.current_version_seq + 1;
        if (input.versionSeq !== nextSeq) {
          // A concurrent composition advanced the tail first — the honest
          // 409: the caller recomposes and converges through the digest
          // check (never a silent overwrite).
          throw new ConflictError(
            `discovery version sequence mismatch: expected ${nextSeq}, got ${input.versionSeq} — recompose`,
          );
        }
        await tx.query(
          `UPDATE commerce_discovery_missions
              SET current_version_seq = $1, version = $2, updated_at = $3
            WHERE commerce_discovery_mission_id = $4`,
          [nextSeq, header.version + 1, now, header.commerce_discovery_mission_id],
        );
        header.current_version_seq = nextSeq;
        header.version = header.version + 1;
      }
      // The version (+ its events) always anchor the EXISTING header row
      // (the fresh programId is only the first-compose creation id).
      const programId = header.commerce_discovery_mission_id;

      await tx.query(
        `INSERT INTO commerce_discovery_mission_versions
           (commerce_discovery_mission_version_id, commerce_discovery_mission_id, version_seq,
            product_context_id, product_context_version_id, store_connection_id,
            spend_currency, test_budget_minor_units, max_demand_tests, min_order_count_for_viability,
            reason, input_snapshot, input_digest, niche_selection, candidate_proposals,
            demand_test_plan, economic_gates, decisions, strategy_version,
            recorded_actor, recorded_via, correlation_id, causation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13,
                 $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, $19,
                 $20, $21, $22, $23, $24)`,
        [
          versionId,
          programId,
          input.versionSeq,
          input.productContextId,
          input.productContextVersionId,
          input.storeConnectionId,
          input.composed.economicGates.spendCurrency,
          input.composed.economicGates.testBudgetMinorUnits,
          input.composed.economicGates.maxDemandTests,
          input.composed.economicGates.minOrderCountForViability,
          input.reason,
          JSON.stringify(input.inputSnapshot),
          input.composed.inputDigest,
          JSON.stringify(input.composed.nicheSelection),
          JSON.stringify(input.composed.candidateProposals),
          JSON.stringify({ ...input.composed.demandTestPlan }),
          JSON.stringify({ ...input.composed.economicGates }),
          JSON.stringify(input.composed.decisions),
          input.composed.strategyVersion,
          input.provenance.actor,
          input.provenance.recordedVia,
          input.provenance.correlationId,
          input.provenance.causationId,
          now,
        ],
      );

      await insertCitations(
        tx,
        VERSION_CITATION_TABLES,
        'commerce_discovery_mission_version_id',
        versionId,
        input.composed.citations,
      );

      await this.appendEvent(tx, {
        programId,
        eventKind: 'version_recorded',
        fromStatus: null,
        toStatus: null,
        reason: input.reason,
        detail: { kind: 'version', versionSeq: input.versionSeq },
        provenance: input.provenance,
        now,
      });

      return wasCreated;
    });

    const program = await this.getProgramByMission(input.missionId);
    const version = await this.getVersionById(versionId);
    if (program === null || version === null) {
      throw new Error('discovery program/version did not persist');
    }
    return { program, version, created };
  }

  /**
   * Appends ONE candidate (+ its citation links + its history event) under
   * the program row lock.
   */
  async insertCandidate(input: {
    readonly candidateId: string;
    readonly program: CommerceDiscoveryMissionRecord;
    readonly label: string;
    readonly niche: string;
    readonly subNiche: string | null;
    readonly productDescriptor: string;
    readonly estimatedCostMinorUnits: number;
    readonly estimatedPriceMinorUnits: number;
    readonly economicsCurrency: string;
    readonly demandHypothesis: string;
    readonly citations: readonly DiscoveryCitation[];
    readonly reason: string;
    readonly provenance: CommerceDiscoveryProvenance;
  }): Promise<CommerceDiscoveryCandidateRecord> {
    const now = this.nowIso();
    await this.db.transaction(async (tx: DbTransaction) => {
      await tx.query(
        `SELECT 1 FROM commerce_discovery_missions
          WHERE commerce_discovery_mission_id = $1 FOR UPDATE`,
        [input.program.discoveryMissionId],
      );
      await tx.query(
        `INSERT INTO commerce_discovery_candidates
           (commerce_discovery_candidate_id, commerce_discovery_mission_id, mission_id, agency_id,
            client_id, label, niche, sub_niche, product_descriptor, estimated_cost_minor_units,
            estimated_price_minor_units, economics_currency, demand_hypothesis,
            recorded_actor, recorded_via, correlation_id, causation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          input.candidateId,
          input.program.discoveryMissionId,
          input.program.missionId,
          input.program.agencyId,
          input.program.clientId,
          input.label,
          input.niche,
          input.subNiche,
          input.productDescriptor,
          input.estimatedCostMinorUnits,
          input.estimatedPriceMinorUnits,
          input.economicsCurrency,
          input.demandHypothesis,
          input.provenance.actor,
          input.provenance.recordedVia,
          input.provenance.correlationId,
          input.provenance.causationId,
          now,
        ],
      );
      await insertCitations(
        tx,
        CANDIDATE_CITATION_TABLES,
        'commerce_discovery_candidate_id',
        input.candidateId,
        input.citations,
      );
      await this.appendEvent(tx, {
        programId: input.program.discoveryMissionId,
        eventKind: 'candidate_recorded',
        fromStatus: null,
        toStatus: null,
        reason: input.reason,
        detail: { kind: 'candidate', candidateId: input.candidateId },
        provenance: input.provenance,
        now,
      });
    });
    const inserted = await this.getCandidateById(input.candidateId);
    if (inserted === null) {
      throw new Error('candidate did not persist');
    }
    return inserted;
  }

  /**
   * Appends ONE demand-test record (born 'launched') + its history event
   * under the program row lock.
   */
  async insertDemandTest(input: {
    readonly demandTestId: string;
    readonly program: CommerceDiscoveryMissionRecord;
    readonly candidateId: string;
    readonly experimentId: string;
    readonly testSpendMinorUnits: number;
    readonly spendCurrency: string;
    readonly derivedDesign: Readonly<Record<string, unknown>>;
    readonly reason: string;
    readonly provenance: CommerceDiscoveryProvenance;
  }): Promise<CommerceDiscoveryDemandTestRecord> {
    const now = this.nowIso();
    await this.db.transaction(async (tx: DbTransaction) => {
      await tx.query(
        `SELECT 1 FROM commerce_discovery_missions
          WHERE commerce_discovery_mission_id = $1 FOR UPDATE`,
        [input.program.discoveryMissionId],
      );
      await tx.query(
        `INSERT INTO commerce_discovery_demand_tests
           (commerce_discovery_demand_test_id, commerce_discovery_mission_id,
            commerce_discovery_candidate_id, mission_id, agency_id, client_id, experiment_id,
            test_spend_minor_units, spend_currency, derived_experiment_design, state,
            recorded_actor, recorded_via, correlation_id, causation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'launched',
                 $11, $12, $13, $14, $15)`,
        [
          input.demandTestId,
          input.program.discoveryMissionId,
          input.candidateId,
          input.program.missionId,
          input.program.agencyId,
          input.program.clientId,
          input.experimentId,
          input.testSpendMinorUnits,
          input.spendCurrency,
          JSON.stringify(input.derivedDesign),
          input.provenance.actor,
          input.provenance.recordedVia,
          input.provenance.correlationId,
          input.provenance.causationId,
          now,
        ],
      );
      await this.appendEvent(tx, {
        programId: input.program.discoveryMissionId,
        eventKind: 'demand_test_launched',
        fromStatus: null,
        toStatus: null,
        reason: input.reason,
        detail: {
          kind: 'demand_test',
          demandTestId: input.demandTestId,
          experimentId: input.experimentId,
        },
        provenance: input.provenance,
        now,
      });
    });
    const inserted = await this.getDemandTestById(input.demandTestId);
    if (inserted === null) {
      throw new Error('demand test did not persist');
    }
    return inserted;
  }

  /**
   * The SINGLE guarded conclusion advance (launched → concluded) + its
   * history event, under the program row lock.
   */
  async advanceDemandTestConclusion(input: {
    readonly demandTestId: string;
    readonly program: CommerceDiscoveryMissionRecord;
    readonly conclusionResultState: string;
    readonly conclusionUncertaintyRepresentation: string;
    readonly reason: string;
    readonly provenance: CommerceDiscoveryProvenance;
  }): Promise<CommerceDiscoveryDemandTestRecord> {
    const now = this.nowIso();
    await this.db.transaction(async (tx: DbTransaction) => {
      await tx.query(
        `SELECT 1 FROM commerce_discovery_missions
          WHERE commerce_discovery_mission_id = $1 FOR UPDATE`,
        [input.program.discoveryMissionId],
      );
      const updated = await tx.query(
        `UPDATE commerce_discovery_demand_tests
            SET state = 'concluded', conclusion_result_state = $1,
                conclusion_uncertainty_representation = $2, conclusion_recorded_at = $3
          WHERE commerce_discovery_demand_test_id = $4 AND state = 'launched'`,
        [
          input.conclusionResultState,
          input.conclusionUncertaintyRepresentation,
          now,
          input.demandTestId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new ConflictError(
          'the demand test is not launchable-for-conclusion (unknown id or already concluded — the advance is single-shot)',
        );
      }
      const row = await tx.query<{ experiment_id: string }>(
        `SELECT experiment_id FROM commerce_discovery_demand_tests
          WHERE commerce_discovery_demand_test_id = $1`,
        [input.demandTestId],
      );
      await this.appendEvent(tx, {
        programId: input.program.discoveryMissionId,
        eventKind: 'demand_test_concluded',
        fromStatus: null,
        toStatus: null,
        reason: input.reason,
        detail: {
          kind: 'demand_test',
          demandTestId: input.demandTestId,
          experimentId: row.rows[0]?.experiment_id ?? '',
        },
        provenance: input.provenance,
        now,
      });
    });
    const updated = await this.getDemandTestById(input.demandTestId);
    if (updated === null) {
      throw new Error('demand test conclusion did not persist');
    }
    return updated;
  }

  /**
   * Appends ONE outcome record (+ its citation links + its history event)
   * under the program row lock.
   */
  async insertOutcome(input: {
    readonly outcomeId: string;
    readonly program: CommerceDiscoveryMissionRecord;
    readonly candidateId: string;
    readonly derived: {
      readonly observedOrderCount: number;
      readonly observedCancelledOrderCount: number;
      readonly observedOrderValues: Readonly<Record<string, number>>;
      readonly viabilityVerdict: string;
      readonly listingRecommendation: string;
      readonly rationale: string;
    };
    readonly commerceEventIds: readonly string[];
    readonly metricObservationIds: readonly string[];
    readonly reason: string;
    readonly provenance: CommerceDiscoveryProvenance;
  }): Promise<CommerceDiscoveryOutcomeRecord> {
    const now = this.nowIso();
    await this.db.transaction(async (tx: DbTransaction) => {
      await tx.query(
        `SELECT 1 FROM commerce_discovery_missions
          WHERE commerce_discovery_mission_id = $1 FOR UPDATE`,
        [input.program.discoveryMissionId],
      );
      await tx.query(
        `INSERT INTO commerce_discovery_outcomes
           (commerce_discovery_outcome_id, commerce_discovery_mission_id,
            commerce_discovery_candidate_id, mission_id, agency_id, client_id,
            observed_order_count, observed_cancelled_order_count, observed_order_values,
            viability_verdict, listing_recommendation, rationale, reason,
            recorded_actor, recorded_via, correlation_id, causation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18)`,
        [
          input.outcomeId,
          input.program.discoveryMissionId,
          input.candidateId,
          input.program.missionId,
          input.program.agencyId,
          input.program.clientId,
          input.derived.observedOrderCount,
          input.derived.observedCancelledOrderCount,
          JSON.stringify(input.derived.observedOrderValues),
          input.derived.viabilityVerdict,
          input.derived.listingRecommendation,
          input.derived.rationale,
          input.reason,
          input.provenance.actor,
          input.provenance.recordedVia,
          input.provenance.correlationId,
          input.provenance.causationId,
          now,
        ],
      );
      let position = 0;
      for (const commerceEventId of input.commerceEventIds) {
        position += 1;
        await tx.query(
          `INSERT INTO commerce_discovery_outcome_cited_commerce_events
             (commerce_discovery_outcome_id, commerce_event_id, position)
           VALUES ($1, $2, $3)`,
          [input.outcomeId, commerceEventId, position],
        );
      }
      position = 0;
      for (const observationId of input.metricObservationIds) {
        position += 1;
        await tx.query(
          `INSERT INTO commerce_discovery_outcome_cited_metric_observations
             (commerce_discovery_outcome_id, observation_id, position)
           VALUES ($1, $2, $3)`,
          [input.outcomeId, observationId, position],
        );
      }
      await this.appendEvent(tx, {
        programId: input.program.discoveryMissionId,
        eventKind: 'outcome_recorded',
        fromStatus: null,
        toStatus: null,
        reason: input.reason,
        detail: { kind: 'outcome', outcomeId: input.outcomeId, candidateId: input.candidateId },
        provenance: input.provenance,
        now,
      });
    });
    const inserted = await this.getOutcomeById(input.outcomeId);
    if (inserted === null) {
      throw new Error('outcome did not persist');
    }
    return inserted;
  }

  /**
   * Appends ONE guardrail evaluation record (+ its citation links + its
   * history event) and — on a breach — performs the honest
   * 'guardrail_blocked' state transition, all under the program row lock
   * in a single transaction.
   */
  async insertEvaluation(input: {
    readonly evaluationId: string;
    readonly program: CommerceDiscoveryMissionRecord;
    readonly evaluated: {
      readonly spendCurrency: string;
      readonly testBudgetMinorUnits: number;
      readonly maxDemandTests: number;
    };
    readonly observed: {
      readonly spendMinorUnits: number;
      readonly demandTestCount: number;
      readonly orderCount: number;
    };
    readonly verdict: 'within_bounds' | 'breached';
    readonly breachReasons: readonly string[];
    readonly rationale: string;
    readonly policyVersionIds: readonly string[];
    readonly commerceEventIds: readonly string[];
    readonly metricObservationIds: readonly string[];
    readonly reason: string;
    readonly provenance: CommerceDiscoveryProvenance;
  }): Promise<CommerceDiscoveryGuardrailEvaluationRecord> {
    const now = this.nowIso();
    await this.db.transaction(async (tx: DbTransaction) => {
      const locked = await tx.query<ProgramRow>(
        `${PROGRAM_SELECT} WHERE commerce_discovery_mission_id = $1 FOR UPDATE`,
        [input.program.discoveryMissionId],
      );
      const header = locked.rows[0];
      if (header === undefined) {
        throw new ConflictError('the discovery program no longer resolves');
      }
      if (
        header.status !== 'active' &&
        header.status !== 'guardrail_blocked'
      ) {
        throw new ConflictError(
          'a terminal discovery program has frozen history — no new guardrail evaluations are recorded on it',
        );
      }
      await tx.query(
        `INSERT INTO commerce_discovery_guardrail_evaluations
           (commerce_discovery_evaluation_id, commerce_discovery_mission_id, mission_id, agency_id,
            client_id, evaluated_spend_currency, evaluated_test_budget_minor_units, evaluated_max_demand_tests,
            observed_spend_minor_units, observed_demand_test_count, observed_order_count,
            verdict, breach_reasons, rationale, reason,
            recorded_actor, recorded_via, correlation_id, causation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15,
                 $16, $17, $18, $19, $20)`,
        [
          input.evaluationId,
          input.program.discoveryMissionId,
          input.program.missionId,
          input.program.agencyId,
          input.program.clientId,
          input.evaluated.spendCurrency,
          input.evaluated.testBudgetMinorUnits,
          input.evaluated.maxDemandTests,
          input.observed.spendMinorUnits,
          input.observed.demandTestCount,
          input.observed.orderCount,
          input.verdict,
          JSON.stringify(input.breachReasons),
          input.rationale,
          input.reason,
          input.provenance.actor,
          input.provenance.recordedVia,
          input.provenance.correlationId,
          input.provenance.causationId,
          now,
        ],
      );
      let position = 0;
      for (const commerceEventId of input.commerceEventIds) {
        position += 1;
        await tx.query(
          `INSERT INTO commerce_discovery_evaluation_cited_commerce_events
             (commerce_discovery_evaluation_id, commerce_event_id, position)
           VALUES ($1, $2, $3)`,
          [input.evaluationId, commerceEventId, position],
        );
      }
      position = 0;
      for (const observationId of input.metricObservationIds) {
        position += 1;
        await tx.query(
          `INSERT INTO commerce_discovery_evaluation_cited_metric_observations
             (commerce_discovery_evaluation_id, observation_id, position)
           VALUES ($1, $2, $3)`,
          [input.evaluationId, observationId, position],
        );
      }
      position = 0;
      for (const policyId of input.policyVersionIds) {
        position += 1;
        await tx.query(
          `INSERT INTO commerce_discovery_evaluation_cited_policy_versions
             (commerce_discovery_evaluation_id, policy_id, position)
           VALUES ($1, $2, $3)`,
          [input.evaluationId, policyId, position],
        );
      }
      await this.appendEvent(tx, {
        programId: input.program.discoveryMissionId,
        eventKind: 'guardrail_evaluated',
        fromStatus: null,
        toStatus: null,
        reason: input.reason,
        detail: { kind: 'evaluation', evaluationId: input.evaluationId, verdict: input.verdict },
        provenance: input.provenance,
        now,
      });
      if (input.verdict === 'breached' && header.status === 'active') {
        await tx.query(
          `UPDATE commerce_discovery_missions
              SET status = 'guardrail_blocked', version = version + 1, updated_at = $1
            WHERE commerce_discovery_mission_id = $2`,
          [now, input.program.discoveryMissionId],
        );
        await this.appendEvent(tx, {
          programId: input.program.discoveryMissionId,
          eventKind: 'state_transition',
          fromStatus: 'active',
          toStatus: 'guardrail_blocked',
          reason: input.reason,
          detail: { kind: 'evaluation', evaluationId: input.evaluationId, verdict: input.verdict },
          provenance: input.provenance,
          now,
        });
      }
    });
    const inserted = await this.getEvaluationById(input.evaluationId);
    if (inserted === null) {
      throw new Error('guardrail evaluation did not persist');
    }
    return inserted;
  }

  /**
   * CAS lifecycle transition guarded by the frozen module transition table
   * (row-locked): appends the 'state_transition' event with the REQUIRED
   * reason + actor + provenance. Terminal targets from the resolve flow
   * carry the 'guardrail_resolved' event kind.
   */
  async transitionStatus(input: {
    readonly program: CommerceDiscoveryMissionRecord;
    readonly toStatus: CommerceDiscoveryStatus;
    readonly reason: string;
    readonly eventKind: CommerceDiscoveryEventKind;
    readonly detail: CommerceDiscoveryEventDetail;
    readonly provenance: CommerceDiscoveryProvenance;
  }): Promise<CommerceDiscoveryMissionRecord> {
    const now = this.nowIso();
    await this.db.transaction(async (tx: DbTransaction) => {
      const locked = await tx.query<ProgramRow>(
        `${PROGRAM_SELECT} WHERE commerce_discovery_mission_id = $1 FOR UPDATE`,
        [input.program.discoveryMissionId],
      );
      const header = locked.rows[0];
      if (header === undefined) {
        throw new ConflictError('the discovery program no longer resolves');
      }
      const fromStatus = header.status as CommerceDiscoveryStatus;
      if (fromStatus === input.toStatus) {
        throw new ConflictError(
          `the discovery program is already '${input.toStatus}'`,
        );
      }
      const updated = await tx.query(
        `UPDATE commerce_discovery_missions
            SET status = $1, version = version + 1, updated_at = $2
          WHERE commerce_discovery_mission_id = $3 AND status = $4`,
        [input.toStatus, now, input.program.discoveryMissionId, fromStatus],
      );
      if (updated.rowCount !== 1) {
        throw new ConflictError(
          'the discovery program transitioned concurrently — retry',
        );
      }
      await this.appendEvent(tx, {
        programId: input.program.discoveryMissionId,
        eventKind: input.eventKind,
        fromStatus,
        toStatus: input.toStatus,
        reason: input.reason,
        detail: input.detail,
        provenance: input.provenance,
        now,
      });
    });
    const program = await this.getProgramByMission(input.program.missionId);
    if (program === null) {
      throw new Error('discovery program did not persist');
    }
    return program;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getProgramByMission(missionId: string): Promise<CommerceDiscoveryMissionRecord | null> {
    const result = await this.db.query<ProgramRow>(`${PROGRAM_SELECT} WHERE mission_id = $1`, [
      missionId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toProgramRecord(row);
  }

  async getProgramById(discoveryMissionId: string): Promise<CommerceDiscoveryMissionRecord | null> {
    const result = await this.db.query<ProgramRow>(
      `${PROGRAM_SELECT} WHERE commerce_discovery_mission_id = $1`,
      [discoveryMissionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toProgramRecord(row);
  }

  async listVersionsByMission(
    missionId: string,
  ): Promise<readonly CommerceDiscoveryVersionRecord[] | null> {
    const programId = await this.programIdOf(missionId);
    if (programId === null) return null;
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE commerce_discovery_mission_id = $1 ORDER BY version_seq`,
      [programId],
    );
    return result.rows.map(toVersionRecord);
  }

  async listEvents(
    discoveryMissionId: string,
  ): Promise<readonly CommerceDiscoveryEventRecord[]> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE commerce_discovery_mission_id = $1 ORDER BY event_seq`,
      [discoveryMissionId],
    );
    return result.rows.map(toEventRecord);
  }

  async listCandidates(
    discoveryMissionId: string,
  ): Promise<readonly CommerceDiscoveryCandidateRecord[]> {
    const result = await this.db.query<CandidateRow>(
      `${CANDIDATE_SELECT} WHERE commerce_discovery_mission_id = $1
        ORDER BY created_at, commerce_discovery_candidate_id`,
      [discoveryMissionId],
    );
    return result.rows.map(toCandidateRecord);
  }

  async getCandidateById(candidateId: string): Promise<CommerceDiscoveryCandidateRecord | null> {
    const result = await this.db.query<CandidateRow>(
      `${CANDIDATE_SELECT} WHERE commerce_discovery_candidate_id = $1`,
      [candidateId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCandidateRecord(row);
  }

  async listCandidateCitations(candidateId: string): Promise<readonly DiscoveryCitation[]> {
    const citations: DiscoveryCitation[] = [];
    for (const [kind, target] of Object.entries(CANDIDATE_CITATION_TABLES) as [
      DiscoveryCitation['kind'],
      { table: string; column: string } | undefined,
    ][]) {
      if (target === undefined) continue;
      const result = await this.db.query<{ ref: string }>(
        `SELECT ${target.column} AS ref FROM ${target.table}
          WHERE commerce_discovery_candidate_id = $1 ORDER BY position`,
        [candidateId],
      );
      for (const row of result.rows) {
        citations.push({ kind, refId: row.ref });
      }
    }
    return citations;
  }

  async listVersionCitations(versionId: string): Promise<readonly DiscoveryCitation[]> {
    const citations: DiscoveryCitation[] = [];
    for (const [kind, target] of Object.entries(VERSION_CITATION_TABLES) as [
      DiscoveryCitation['kind'],
      { table: string; column: string } | undefined,
    ][]) {
      if (target === undefined) continue;
      const result = await this.db.query<{ ref: string }>(
        `SELECT ${target.column} AS ref FROM ${target.table}
          WHERE commerce_discovery_mission_version_id = $1 ORDER BY position`,
        [versionId],
      );
      for (const row of result.rows) {
        citations.push({ kind, refId: row.ref });
      }
    }
    return citations;
  }

  async listDemandTests(
    discoveryMissionId: string,
  ): Promise<readonly CommerceDiscoveryDemandTestRecord[]> {
    const result = await this.db.query<DemandTestRow>(
      `${DEMAND_TEST_SELECT} WHERE commerce_discovery_mission_id = $1
        ORDER BY created_at, commerce_discovery_demand_test_id`,
      [discoveryMissionId],
    );
    return result.rows.map(toDemandTestRecord);
  }

  async getDemandTestById(demandTestId: string): Promise<CommerceDiscoveryDemandTestRecord | null> {
    const result = await this.db.query<DemandTestRow>(
      `${DEMAND_TEST_SELECT} WHERE commerce_discovery_demand_test_id = $1`,
      [demandTestId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDemandTestRecord(row);
  }

  async listOutcomes(
    discoveryMissionId: string,
  ): Promise<readonly CommerceDiscoveryOutcomeRecord[]> {
    const result = await this.db.query<OutcomeRow>(
      `${OUTCOME_SELECT} WHERE commerce_discovery_mission_id = $1
        ORDER BY created_at, commerce_discovery_outcome_id`,
      [discoveryMissionId],
    );
    return result.rows.map(toOutcomeRecord);
  }

  async getOutcomeById(outcomeId: string): Promise<CommerceDiscoveryOutcomeRecord | null> {
    const result = await this.db.query<OutcomeRow>(
      `${OUTCOME_SELECT} WHERE commerce_discovery_outcome_id = $1`,
      [outcomeId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOutcomeRecord(row);
  }

  async listEvaluations(
    discoveryMissionId: string,
  ): Promise<readonly CommerceDiscoveryGuardrailEvaluationRecord[]> {
    const result = await this.db.query<EvaluationRow>(
      `${EVALUATION_SELECT} WHERE commerce_discovery_mission_id = $1
        ORDER BY created_at, commerce_discovery_evaluation_id`,
      [discoveryMissionId],
    );
    return result.rows.map(toEvaluationRecord);
  }

  async getEvaluationById(
    evaluationId: string,
  ): Promise<CommerceDiscoveryGuardrailEvaluationRecord | null> {
    const result = await this.db.query<EvaluationRow>(
      `${EVALUATION_SELECT} WHERE commerce_discovery_evaluation_id = $1`,
      [evaluationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEvaluationRecord(row);
  }

  private async programIdOf(missionId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT commerce_discovery_mission_id AS id FROM commerce_discovery_missions WHERE mission_id = $1`,
      [missionId],
    );
    return result.rows[0]?.id ?? null;
  }

  private async getVersionById(
    versionId: string,
  ): Promise<CommerceDiscoveryVersionRecord | null> {
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE commerce_discovery_mission_version_id = $1`,
      [versionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersionRecord(row);
  }
}
