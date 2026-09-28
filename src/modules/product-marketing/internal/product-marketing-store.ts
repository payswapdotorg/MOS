/**
 * /product-marketing persistence (MKT-070 — the migration-060 tables).
 *
 * Owns EXACTLY the module's own tables (the 063/064/058 table discipline):
 *
 *   product_marketing_plans                       — the plan headers (the
 *                                                   version-tail pointer +
 *                                                   the CAS token; the ONE
 *                                                   mutable row family);
 *   product_marketing_plan_versions               — the APPEND-ONLY plan
 *                                                   version tail;
 *   the NINE citation link tables                 — the FK-anchored
 *                                                   scope-fenced citation
 *                                                   basis of every version.
 *
 * NO AUTHORITY TRANSFER: no mission, goal, product-context, research,
 * health-evaluation, analysis, experiment, account or tenant table is
 * written here — the anchored authority tables are read CHECK-ONLY by the
 * DB scope triggers. Plan versions and citation links are APPEND-ONLY:
 * UPDATE and DELETE are rejected by the migration-060 triggers (a plan
 * correction is a NEW version record; history is never rewritten).
 */

import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import { ConflictError } from '../../../platform/errors/errors.ts';
import type {
  ComposedProductMarketingPlan,
  PlannerAttributionPlan,
  PlannerCitation,
  PlannerContentStrategy,
  PlannerDecisionEntry,
  PlannerExperimentPlan,
  PlannerMetricPlanEntry,
  PlannerPlatformPortfolioEntry,
  ProductMarketingPlanRecord,
  ProductMarketingPlanVersionRecord,
  ProductMarketingProvenance,
} from '../public.ts';

interface PlanRow extends DbRow {
  product_marketing_plan_id: string;
  mission_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  current_version_seq: number;
  version: number;
  created_actor: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow extends DbRow {
  product_marketing_plan_version_id: string;
  product_marketing_plan_id: string;
  version_seq: number;
  product_context_id: string;
  product_context_version_id: string;
  research_session_id: string | null;
  reason: string;
  input_snapshot: unknown;
  input_digest: string;
  platform_portfolio: unknown;
  metric_plan: unknown;
  content_strategy: unknown;
  attribution_plan: unknown;
  experiment_plan: unknown;
  decisions: unknown;
  strategy_version: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

const PLAN_SELECT = `
  SELECT product_marketing_plan_id, mission_id, agency_id, client_id, workspace_id,
         current_version_seq, version, created_actor, created_at, updated_at
  FROM product_marketing_plans
`;

const VERSION_SELECT = `
  SELECT product_marketing_plan_version_id, product_marketing_plan_id, version_seq,
         product_context_id, product_context_version_id, research_session_id, reason,
         input_snapshot, input_digest, platform_portfolio, metric_plan, content_strategy,
         attribution_plan, experiment_plan, decisions, strategy_version,
         recorded_actor, recorded_via, correlation_id, causation_id, created_at
  FROM product_marketing_plan_versions
`;

function toPlanRecord(row: PlanRow): ProductMarketingPlanRecord {
  return {
    planId: row.product_marketing_plan_id,
    missionId: row.mission_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    currentVersionSeq: row.current_version_seq,
    version: row.version,
    createdActor: row.created_actor,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function toVersionRecord(row: VersionRow): ProductMarketingPlanVersionRecord {
  return {
    planVersionId: row.product_marketing_plan_version_id,
    planId: row.product_marketing_plan_id,
    versionSeq: row.version_seq,
    productContextId: row.product_context_id,
    productContextVersionId: row.product_context_version_id,
    researchSessionId: row.research_session_id,
    reason: row.reason,
    inputSnapshot: (row.input_snapshot ?? {}) as Readonly<Record<string, unknown>>,
    inputDigest: row.input_digest,
    platformPortfolio: (row.platform_portfolio ?? []) as readonly PlannerPlatformPortfolioEntry[],
    metricPlan: (row.metric_plan ?? []) as readonly PlannerMetricPlanEntry[],
    contentStrategy: (row.content_strategy ?? {}) as PlannerContentStrategy,
    attributionPlan: (row.attribution_plan ?? {}) as PlannerAttributionPlan,
    experimentPlan: (row.experiment_plan ?? {}) as PlannerExperimentPlan,
    decisions: (row.decisions ?? []) as readonly PlannerDecisionEntry[],
    strategyVersion: row.strategy_version as ProductMarketingPlanVersionRecord['strategyVersion'],
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

/** The input of one version append (the header creation or the version advance). */
export interface PlanVersionInsertInput {
  readonly planId: string;
  readonly missionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly versionSeq: number;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly researchSessionId: string | null;
  readonly reason: string;
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
  readonly composed: ComposedProductMarketingPlan;
  readonly provenance: ProductMarketingProvenance;
  /** The valid citation id sets — the fabrication-resistance validation input. */
  readonly validCitations: Readonly<Record<PlannerCitation['kind'], ReadonlySet<string>>>;
}

/**
 * Validates that every citation the composed plan emits references a
 * record present in the input snapshot (the fabrication-resistance
 * server-side fence: the planner NEVER emits a plan citing records it
 * does not reference — a violation is a hard error, never persisted).
 */
function assertCitationsResolve(input: PlanVersionInsertInput): void {
  const problems: string[] = [];
  for (const citation of input.composed.citations) {
    if (!input.validCitations[citation.kind]?.has(citation.refId)) {
      problems.push(`${citation.kind}:${citation.refId} is not part of the planning input snapshot`);
    }
  }
  if (problems.length > 0) {
    throw new ConflictError(
      `product-marketing plan citations do not resolve in the input snapshot: ${problems.join('; ')}`,
    );
  }
}

const CITATION_TABLES: Readonly<Record<PlannerCitation['kind'], { table: string; column: string }>> = {
  product_input: { table: 'product_marketing_plan_cited_product_inputs', column: 'input_id' },
  product_source_fact: { table: 'product_marketing_plan_cited_product_facts', column: 'source_fact_id' },
  product_derived_model: { table: 'product_marketing_plan_cited_product_models', column: 'derived_model_id' },
  product_risk_flag: { table: 'product_marketing_plan_cited_product_risk_flags', column: 'risk_flag_id' },
  research_insight: { table: 'product_marketing_plan_cited_research_insights', column: 'research_insight_id' },
  platform_health_evaluation: {
    table: 'product_marketing_plan_cited_platform_health_evaluations',
    column: 'platform_health_evaluation_id',
  },
  experiment_analysis: { table: 'product_marketing_plan_cited_experiment_analyses', column: 'analysis_id' },
  allocation_recommendation: {
    table: 'product_marketing_plan_cited_allocation_recommendations',
    column: 'recommendation_id',
  },
  content_hypothesis: { table: 'product_marketing_plan_cited_content_hypotheses', column: 'content_hypothesis_id' },
};

export class ProductMarketingStore {
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

  /**
   * Appends ONE plan version under the plan row lock — creating the plan
   * header on the first version (ONE plan per mission; concurrent first
   * compositions converge) and advancing the version-tail pointer on the
   * rest. The append and its citation links persist in a single
   * transaction.
   */
  async appendPlanVersion(input: PlanVersionInsertInput): Promise<ProductMarketingPlanVersionRecord> {
    assertCitationsResolve(input);
    const now = this.clock.nowIso();
    const planVersionId = this.newId();

    await this.db.transaction(async (tx: DbTransaction) => {
      // Lock the plan header row (or create it — the one-plan-per-mission
      // convergence fence).
      const existing = await tx.query<PlanRow>(
        `SELECT * FROM product_marketing_plans WHERE mission_id = $1 FOR UPDATE`,
        [input.missionId],
      );
      let planId: string;
      if (existing.rows.length === 0) {
        if (input.versionSeq !== 1) {
          throw new Error('plan version sequence must start at 1 for a new plan');
        }
        planId = input.planId;
        await tx.query(
          `INSERT INTO product_marketing_plans
             (product_marketing_plan_id, mission_id, agency_id, client_id, workspace_id,
              current_version_seq, version, created_actor, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            planId,
            input.missionId,
            input.agencyId,
            input.clientId,
            input.workspaceId,
            input.versionSeq,
            1,
            input.provenance.actor,
            now,
          ],
        );
      } else {
        const header = existing.rows[0]!;
        planId = header.product_marketing_plan_id;
        const nextSeq = header.current_version_seq + 1;
        if (input.versionSeq !== nextSeq) {
          // A concurrent composition advanced the tail first — the honest
          // 409: the caller recomposes and converges through the digest
          // check (never a silent overwrite).
          throw new ConflictError(
            `plan version sequence mismatch: expected ${nextSeq}, got ${input.versionSeq} — recompose`,
          );
        }
        await tx.query(
          `UPDATE product_marketing_plans
             SET current_version_seq = $1, version = $2, updated_at = $3
           WHERE product_marketing_plan_id = $4`,
          [nextSeq, header.version + 1, now, planId],
        );
      }

      await tx.query(
        `INSERT INTO product_marketing_plan_versions
           (product_marketing_plan_version_id, product_marketing_plan_id, version_seq,
            product_context_id, product_context_version_id, research_session_id, reason,
            input_snapshot, input_digest, platform_portfolio, metric_plan, content_strategy,
            attribution_plan, experiment_plan, decisions, strategy_version,
            recorded_actor, recorded_via, correlation_id, causation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb,
                 $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21)`,
        [
          planVersionId,
          planId,
          input.versionSeq,
          input.productContextId,
          input.productContextVersionId,
          input.researchSessionId,
          input.reason,
          JSON.stringify(input.inputSnapshot),
          input.composed.inputDigest,
          JSON.stringify(input.composed.platformPortfolio),
          JSON.stringify(input.composed.metricPlan),
          JSON.stringify(input.composed.contentStrategy),
          JSON.stringify({ ...input.composed.attributionPlan }),
          JSON.stringify({ ...input.composed.experimentPlan }),
          JSON.stringify(input.composed.decisions),
          input.composed.strategyVersion,
          input.provenance.actor,
          input.provenance.recordedVia,
          input.provenance.correlationId,
          input.provenance.causationId,
          now,
        ],
      );

      // The citation links persist with PER-TABLE positions (each table's
      // own 1..N citation order — the position CHECK fences are per-table).
      const positions = new Map<string, number>();
      for (const citation of input.composed.citations) {
        const target = CITATION_TABLES[citation.kind]!;
        const position = (positions.get(citation.kind) ?? 0) + 1;
        positions.set(citation.kind, position);
        await tx.query(
          `INSERT INTO ${target.table}
             (product_marketing_plan_version_id, ${target.column}, position)
           VALUES ($1, $2, $3)`,
          [planVersionId, citation.refId, position],
        );
      }
    });

    const inserted = await this.getVersionById(planVersionId);
    if (inserted === null) {
      throw new Error('plan version did not persist');
    }
    return inserted;
  }

  async getPlanByMission(missionId: string): Promise<ProductMarketingPlanRecord | null> {
    const result = await this.db.query<PlanRow>(`${PLAN_SELECT} WHERE mission_id = $1`, [missionId]);
    const row = result.rows[0];
    return row === undefined ? null : toPlanRecord(row);
  }

  async getLatestVersionByMission(
    missionId: string,
  ): Promise<ProductMarketingPlanVersionRecord | null> {
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE product_marketing_plan_id = $1 ORDER BY version_seq DESC LIMIT 1`,
      [await this.planIdOf(missionId)],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersionRecord(row);
  }

  async listVersionsByMission(
    missionId: string,
  ): Promise<readonly ProductMarketingPlanVersionRecord[] | null> {
    const planId = await this.planIdOf(missionId);
    if (planId === null) return null;
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE product_marketing_plan_id = $1 ORDER BY version_seq`,
      [planId],
    );
    return result.rows.map(toVersionRecord);
  }

  async listCitations(
    planVersionId: string,
  ): Promise<readonly PlannerCitation[]> {
    const citations: PlannerCitation[] = [];
    for (const [kind, target] of Object.entries(CITATION_TABLES) as [
      PlannerCitation['kind'],
      { table: string; column: string },
    ][]) {
      const result = await this.db.query<{ ref: string; position: number }>(
        `SELECT ${target.column} AS ref, position FROM ${target.table}
         WHERE product_marketing_plan_version_id = $1 ORDER BY position`,
        [planVersionId],
      );
      for (const row of result.rows) {
        citations.push({ kind, refId: row.ref });
      }
    }
    // Deterministic order: the same order the composed citation set used
    // (kind table order, then citation position).
    return citations;
  }

  private async planIdOf(missionId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT product_marketing_plan_id AS id FROM product_marketing_plans WHERE mission_id = $1`,
      [missionId],
    );
    return result.rows[0]?.id ?? null;
  }

  private async getVersionById(
    planVersionId: string,
  ): Promise<ProductMarketingPlanVersionRecord | null> {
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE product_marketing_plan_version_id = $1`,
      [planVersionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersionRecord(row);
  }
}
