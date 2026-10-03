/**
 * /lab-capabilities persistence (LAB-013 — the migration-067 tables).
 *
 * Owns EXACTLY the nine own flow-stage tables:
 *
 *   lab_capability_gaps, lab_capability_contracts,
 *   lab_capability_value_estimates, lab_capability_requests,
 *   lab_capability_results, lab_capability_verifications,
 *   lab_capability_versions, lab_capability_simulations,
 *   lab_capability_real_tests.
 *
 * NO AUTHORITY TRANSFER / NO SHADOWING (§3/§17): no experiment, decision,
 * evidence, metric, publication, workflow, execution, marketplace or
 * tenant-authority table is written or joined here; no /lab, /lab-agent-
 * body or /integrations table is written either — the strategy, human-
 * plane, real-test and provider citations are OPAQUE recorded data (the
 * /lab family by-reference discipline); the provider calls flow through
 * the module's structural port (the /integrations gates stay the sole
 * provider authority).
 *
 * The stage records keep identity immutable and advance ONLY their closed
 * status vocabulary under the guarded UPDATE triggers; the result,
 * verification, simulation and real-test records are APPEND-ONLY
 * OUTRIGHT. Every read is CLIENT-scoped (the uniform tenant fence; the
 * module resolves foreign/unknown scope to the uniform NotFound — no
 * existence oracle).
 */

import type { DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  LabCapabilityActor,
  LabCapabilityContractRecord,
  LabCapabilityCost,
  LabCapabilityFulfillmentKind,
  LabCapabilityGapRecord,
  LabCapabilityGrantedRights,
  LabCapabilityHumanPlaneCitation,
  LabCapabilityImplementation,
  LabCapabilityImplementationReference,
  LabCapabilityLatency,
  LabCapabilityLinkOutcome,
  LabCapabilityQualityEvaluatorDeclaration,
  LabCapabilityRealTestCitation,
  LabCapabilityRealTestRecord,
  LabCapabilityRequestedRights,
  LabCapabilityRequirement,
  LabCapabilityRequestRecord,
  LabCapabilityResultRecord,
  LabCapabilitySchema,
  LabCapabilitySimulationRecord,
  LabCapabilityValueEstimateRecord,
  LabCapabilityVerificationRecord,
  LabCapabilityVerificationState,
  LabCapabilityVersionRecord,
  LabCapabilityVersionStatus,
  LabCapabilitiesScope,
} from '../public.ts';
import { LAB_CAPABILITIES_CONTRACT_VERSION } from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case as returned by PostgreSQL)
// ---------------------------------------------------------------------------

interface GapRow extends DbRow {
  gap_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  detection_actor: string;
  strategy_citation: unknown;
  required_action: unknown;
  rationale: string;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface ContractRow extends DbRow {
  contract_id: string;
  gap_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  actor: string;
  input_schema: unknown;
  output_schema: unknown;
  constraints: unknown;
  quality_evaluator: unknown;
  cost_ceiling: unknown;
  latency_ceiling: unknown;
  requirements: unknown;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface EstimateRow extends DbRow {
  estimate_id: string;
  contract_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  actor: string;
  estimated_value_units: number | string;
  expected_quality_lift: number | string;
  estimated_cost_ceiling: number | string;
  uncertainty: string;
  basis: string;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface RequestRow extends DbRow {
  request_id: string;
  gap_id: string;
  contract_id: string;
  estimate_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  actor: string;
  adapter_key: string;
  connection_id: string;
  operation: string;
  request_parameters: unknown;
  requested_rights: unknown;
  provider_ok: boolean | null;
  provider_record_id: string | null;
  provider_error: string | null;
  dispatched_at: Date | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface ResultRow extends DbRow {
  result_id: string;
  request_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  fulfillment_kind: string;
  actor: string;
  provider_adapter_key: string | null;
  provider_record_id: string | null;
  human_plane_citation: unknown;
  delivered_artifact: unknown;
  granted_rights: unknown;
  contract_version: string;
  created_at: Date;
}

interface VerificationRow extends DbRow {
  verification_id: string;
  result_id: string;
  contract_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  verdict: string;
  actor: string;
  evaluator_id: string;
  evaluator_version: string;
  evaluation_evidence: unknown;
  contract_version: string;
  created_at: Date;
}

interface VersionRow extends DbRow {
  capability_id: string;
  capability_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  capability_key: string;
  display_name: string;
  status: string;
  actor: string;
  input_schema: unknown;
  output_schema: unknown;
  constraints: unknown;
  quality_evaluator: unknown;
  cost: unknown;
  latency: unknown;
  origin: string;
  provenance: unknown;
  implementation: unknown;
  simulator_implementation: unknown;
  real_implementation: unknown;
  requirements: unknown;
  source_verification_id: string | null;
  source_gap_id: string | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface SimulationRow extends DbRow {
  simulation_id: string;
  capability_id: string;
  capability_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  actor: string;
  simulation_reference: string;
  outcome: string;
  evidence: unknown;
  contract_version: string;
  created_at: Date;
}

interface RealTestRow extends DbRow {
  real_test_id: string;
  capability_id: string;
  capability_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  actor: string;
  real_test_citation: unknown;
  outcome: string;
  evidence: unknown;
  contract_version: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return (value ?? {}) as Readonly<Record<string, unknown>>;
}

export function mapGapRow(r: GapRow): LabCapabilityGapRecord {
  return {
    gapId: r.gap_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabCapabilityGapRecord['status'],
    detectionActor: r.detection_actor as LabCapabilityActor,
    strategyCitation: r.strategy_citation as LabCapabilityGapRecord['strategyCitation'],
    requiredAction: r.required_action as LabCapabilityGapRecord['requiredAction'],
    rationale: r.rationale,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapContractRow(r: ContractRow): LabCapabilityContractRecord {
  const costCeiling = asRecord(r.cost_ceiling) as unknown as LabCapabilityCost;
  return {
    contractId: r.contract_id,
    gapId: r.gap_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabCapabilityContractRecord['status'],
    actor: r.actor as LabCapabilityActor,
    inputSchema: r.input_schema as LabCapabilitySchema,
    outputSchema: r.output_schema as LabCapabilitySchema,
    constraints: (r.constraints ?? []) as ReadonlyArray<string>,
    qualityEvaluator: r.quality_evaluator as LabCapabilityQualityEvaluatorDeclaration,
    costCeiling,
    latencyCeilingMs: Number(asRecord(r.latency_ceiling)['deadlineMs'] ?? 0),
    requirements: (r.requirements ?? []) as ReadonlyArray<LabCapabilityRequirement>,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapEstimateRow(r: EstimateRow): LabCapabilityValueEstimateRecord {
  return {
    estimateId: r.estimate_id,
    contractId: r.contract_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabCapabilityValueEstimateRecord['status'],
    actor: r.actor as LabCapabilityActor,
    estimatedValueUnits: Number(r.estimated_value_units),
    expectedQualityLift: Number(r.expected_quality_lift),
    estimatedCostCeiling: Number(r.estimated_cost_ceiling),
    uncertainty: r.uncertainty,
    basis: r.basis,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapRequestRow(r: RequestRow): LabCapabilityRequestRecord {
  return {
    requestId: r.request_id,
    gapId: r.gap_id,
    contractId: r.contract_id,
    estimateId: r.estimate_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabCapabilityRequestRecord['status'],
    actor: r.actor as LabCapabilityActor,
    adapterKey: r.adapter_key,
    connectionId: r.connection_id,
    operation: r.operation,
    requestParameters: asRecord(r.request_parameters),
    requestedRights: r.requested_rights as LabCapabilityRequestedRights,
    providerOk: r.provider_ok,
    providerRecordId: r.provider_record_id,
    providerError: r.provider_error,
    dispatchedAt: toIsoOrNull(r.dispatched_at),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapResultRow(r: ResultRow): LabCapabilityResultRecord {
  return {
    resultId: r.result_id,
    requestId: r.request_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    fulfillmentKind: r.fulfillment_kind as LabCapabilityFulfillmentKind,
    actor: r.actor as LabCapabilityActor,
    providerAdapterKey: r.provider_adapter_key,
    providerRecordId: r.provider_record_id,
    humanPlaneCitation: (r.human_plane_citation ?? null) as LabCapabilityHumanPlaneCitation | null,
    deliveredArtifact: asRecord(r.delivered_artifact),
    grantedRights: (r.granted_rights ?? null) as LabCapabilityGrantedRights | null,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapVerificationRow(r: VerificationRow): LabCapabilityVerificationRecord {
  return {
    verificationId: r.verification_id,
    resultId: r.result_id,
    contractId: r.contract_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    verdict: r.verdict as LabCapabilityVerificationRecord['verdict'],
    actor: r.actor as LabCapabilityActor,
    evaluatorId: r.evaluator_id,
    evaluatorVersion: r.evaluator_version,
    evaluationEvidence: asRecord(r.evaluation_evidence),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapVersionRow(r: VersionRow, verification: LabCapabilityVerificationState): LabCapabilityVersionRecord {
  const provenance = asRecord(r.provenance);
  return {
    capabilityId: r.capability_id,
    capabilityVersion: Number(r.capability_version),
    capabilityVersionReference: `${r.capability_id}#v${Number(r.capability_version)}`,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    capabilityKey: r.capability_key,
    displayName: r.display_name,
    status: r.status as LabCapabilityVersionStatus,
    actor: r.actor as LabCapabilityActor,
    inputSchema: r.input_schema as LabCapabilitySchema,
    outputSchema: r.output_schema as LabCapabilitySchema,
    constraints: (r.constraints ?? []) as ReadonlyArray<string>,
    qualityEvaluator: r.quality_evaluator as LabCapabilityQualityEvaluatorDeclaration,
    cost: r.cost as LabCapabilityCost,
    latency: r.latency as LabCapabilityLatency,
    origin: r.origin as LabCapabilityVersionRecord['origin'],
    provenance: {
      origin: provenance['origin'] as LabCapabilityVersionRecord['origin'],
      sourceNote: String(provenance['sourceNote'] ?? ''),
    },
    implementation: r.implementation as LabCapabilityImplementation,
    simulatorImplementation: (r.simulator_implementation ?? null) as LabCapabilityImplementationReference | null,
    realImplementation: (r.real_implementation ?? null) as LabCapabilityImplementationReference | null,
    requirements: (r.requirements ?? []) as ReadonlyArray<LabCapabilityRequirement>,
    sourceVerificationId: r.source_verification_id,
    sourceGapId: r.source_gap_id,
    verification,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapSimulationRow(r: SimulationRow): LabCapabilitySimulationRecord {
  return {
    simulationId: r.simulation_id,
    capabilityId: r.capability_id,
    capabilityVersion: Number(r.capability_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    actor: r.actor as LabCapabilityActor,
    simulationReference: r.simulation_reference,
    outcome: r.outcome as LabCapabilityLinkOutcome,
    evidence: asRecord(r.evidence),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapRealTestRow(r: RealTestRow): LabCapabilityRealTestRecord {
  return {
    realTestId: r.real_test_id,
    capabilityId: r.capability_id,
    capabilityVersion: Number(r.capability_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    actor: r.actor as LabCapabilityActor,
    realTestCitation: r.real_test_citation as LabCapabilityRealTestCitation,
    outcome: r.outcome as LabCapabilityLinkOutcome,
    evidence: asRecord(r.evidence),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

function json(value: unknown): string | null {
  // SQL NULL — a jsonb 'null' LITERAL would violate the pairing fences
  // (IS NOT NULL is true for the jsonb null literal) and misrepresent
  // the honest nothing-granted / no-citation states.
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export class LabCapabilitiesStore {
  private readonly db: DbTransaction;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: DbTransaction, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  nowIso(): string {
    return this.clock.nowIso();
  }

  newId(): string {
    return this.ids.newId();
  }

  // --- Stage 1: gaps ---

  async insertGap(input: {
    gapId: string;
    scope: LabCapabilitiesScope;
    detectionActor: LabCapabilityActor;
    strategyCitation: unknown;
    requiredAction: unknown;
    rationale: string;
  }): Promise<GapRow> {
    const now = this.nowIso();
    const r = await this.db.query<GapRow>(
      `INSERT INTO lab_capability_gaps
         (gap_id, agency_id, client_id, workspace_id, status, detection_actor,
          strategy_citation, required_action, rationale, contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $6::jsonb, $7::jsonb, $8, $9, $10::timestamptz, $10::timestamptz)
       RETURNING *`,
      [
        input.gapId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.detectionActor,
        json(input.strategyCitation),
        json(input.requiredAction),
        input.rationale,
        LAB_CAPABILITIES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async updateGapStatus(clientId: string, gapId: string, status: string): Promise<GapRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<GapRow>(
      `UPDATE lab_capability_gaps
          SET status = $3, updated_at = $4::timestamptz
        WHERE client_id = $1 AND gap_id = $2
        RETURNING *`,
      [clientId, gapId, status, now],
    );
    return r.rows[0] ?? null;
  }

  async findGap(clientId: string, gapId: string): Promise<GapRow | null> {
    const r = await this.db.query<GapRow>(
      `SELECT * FROM lab_capability_gaps WHERE client_id = $1 AND gap_id = $2`,
      [clientId, gapId],
    );
    return r.rows[0] ?? null;
  }

  async listGaps(clientId: string, status: string | null): Promise<ReadonlyArray<GapRow>> {
    const r = await this.db.query<GapRow>(
      `SELECT * FROM lab_capability_gaps
        WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC, gap_id`,
      [clientId, status],
    );
    return r.rows;
  }

  // --- Stage 2: contracts ---

  async insertContract(input: {
    contractId: string;
    scope: LabCapabilitiesScope;
    gapId: string;
    actor: LabCapabilityActor;
    inputSchema: unknown;
    outputSchema: unknown;
    constraints: unknown;
    qualityEvaluator: unknown;
    costCeiling: unknown;
    latencyCeiling: unknown;
    requirements: unknown;
  }): Promise<ContractRow> {
    const now = this.nowIso();
    const r = await this.db.query<ContractRow>(
      `INSERT INTO lab_capability_contracts
         (contract_id, gap_id, agency_id, client_id, workspace_id, status, actor,
          input_schema, output_schema, constraints, quality_evaluator, cost_ceiling,
          latency_ceiling, requirements, contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'derived', $6, $7::jsonb, $8::jsonb, $9::jsonb,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::timestamptz, $15::timestamptz)
       RETURNING *`,
      [
        input.contractId,
        input.gapId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.actor,
        json(input.inputSchema),
        json(input.outputSchema),
        json(input.constraints),
        json(input.qualityEvaluator),
        json(input.costCeiling),
        json(input.latencyCeiling),
        json(input.requirements),
        LAB_CAPABILITIES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async updateContractStatus(clientId: string, contractId: string, status: string): Promise<ContractRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<ContractRow>(
      `UPDATE lab_capability_contracts
          SET status = $3, updated_at = $4::timestamptz
        WHERE client_id = $1 AND contract_id = $2
        RETURNING *`,
      [clientId, contractId, status, now],
    );
    return r.rows[0] ?? null;
  }

  async findContract(clientId: string, contractId: string): Promise<ContractRow | null> {
    const r = await this.db.query<ContractRow>(
      `SELECT * FROM lab_capability_contracts WHERE client_id = $1 AND contract_id = $2`,
      [clientId, contractId],
    );
    return r.rows[0] ?? null;
  }

  async listContracts(clientId: string, gapId: string | null): Promise<ReadonlyArray<ContractRow>> {
    const r = await this.db.query<ContractRow>(
      `SELECT * FROM lab_capability_contracts
        WHERE client_id = $1 AND ($2::uuid IS NULL OR gap_id = $2)
        ORDER BY created_at DESC, contract_id`,
      [clientId, gapId],
    );
    return r.rows;
  }

  // --- Stage 3: value estimates ---

  async insertEstimate(input: {
    estimateId: string;
    scope: LabCapabilitiesScope;
    contractId: string;
    actor: LabCapabilityActor;
    estimatedValueUnits: number;
    expectedQualityLift: number;
    estimatedCostCeiling: number;
    uncertainty: string;
    basis: string;
  }): Promise<EstimateRow> {
    const now = this.nowIso();
    const r = await this.db.query<EstimateRow>(
      `INSERT INTO lab_capability_value_estimates
         (estimate_id, contract_id, agency_id, client_id, workspace_id, status, actor,
          estimated_value_units, expected_quality_lift, estimated_cost_ceiling,
          uncertainty, basis, contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'recorded', $6, $7, $8, $9, $10, $11, $12,
               $13::timestamptz, $13::timestamptz)
       RETURNING *`,
      [
        input.estimateId,
        input.contractId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.actor,
        input.estimatedValueUnits,
        input.expectedQualityLift,
        input.estimatedCostCeiling,
        input.uncertainty,
        input.basis,
        LAB_CAPABILITIES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async supersedeRecordedEstimates(contractId: string): Promise<void> {
    const now = this.nowIso();
    await this.db.query(
      `UPDATE lab_capability_value_estimates
          SET status = 'superseded', updated_at = $2::timestamptz
        WHERE contract_id = $1 AND status = 'recorded'`,
      [contractId, now],
    );
  }

  async findEstimate(clientId: string, estimateId: string): Promise<EstimateRow | null> {
    const r = await this.db.query<EstimateRow>(
      `SELECT * FROM lab_capability_value_estimates WHERE client_id = $1 AND estimate_id = $2`,
      [clientId, estimateId],
    );
    return r.rows[0] ?? null;
  }

  async listEstimates(clientId: string, contractId: string | null): Promise<ReadonlyArray<EstimateRow>> {
    const r = await this.db.query<EstimateRow>(
      `SELECT * FROM lab_capability_value_estimates
        WHERE client_id = $1 AND ($2::uuid IS NULL OR contract_id = $2)
        ORDER BY created_at DESC, estimate_id`,
      [clientId, contractId],
    );
    return r.rows;
  }

  // --- Stage 4: governed requests ---

  async insertRequest(input: {
    requestId: string;
    scope: LabCapabilitiesScope;
    gapId: string;
    contractId: string;
    estimateId: string;
    actor: LabCapabilityActor;
    adapterKey: string;
    connectionId: string;
    operation: string;
    requestParameters: unknown;
    requestedRights: unknown;
  }): Promise<RequestRow> {
    const now = this.nowIso();
    const r = await this.db.query<RequestRow>(
      `INSERT INTO lab_capability_requests
         (request_id, gap_id, contract_id, estimate_id, agency_id, client_id, workspace_id,
          status, actor, adapter_key, connection_id, operation, request_parameters,
          requested_rights, provider_ok, provider_record_id, provider_error, dispatched_at,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11, $12::jsonb,
               $13::jsonb, NULL, NULL, NULL, NULL, $14, $15::timestamptz, $15::timestamptz)
       RETURNING *`,
      [
        input.requestId,
        input.gapId,
        input.contractId,
        input.estimateId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.actor,
        input.adapterKey,
        input.connectionId,
        input.operation,
        json(input.requestParameters),
        json(input.requestedRights),
        LAB_CAPABILITIES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async advanceRequest(input: {
    clientId: string;
    requestId: string;
    status: 'completed' | 'failed' | 'cancelled';
    providerOk: boolean | null;
    providerRecordId: string | null;
    providerError: string | null;
    dispatchedAt: string | null;
  }): Promise<RequestRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<RequestRow>(
      `UPDATE lab_capability_requests
          SET status = $3,
              provider_ok = COALESCE($4, provider_ok),
              provider_record_id = COALESCE($5, provider_record_id),
              provider_error = $6,
              dispatched_at = COALESCE($7::timestamptz, dispatched_at),
              updated_at = $8::timestamptz
        WHERE client_id = $1 AND request_id = $2
        RETURNING *`,
      [
        input.clientId,
        input.requestId,
        input.status,
        input.providerOk,
        input.providerRecordId,
        input.providerError,
        input.dispatchedAt,
        now,
      ],
    );
    return r.rows[0] ?? null;
  }

  async findRequest(clientId: string, requestId: string): Promise<RequestRow | null> {
    const r = await this.db.query<RequestRow>(
      `SELECT * FROM lab_capability_requests WHERE client_id = $1 AND request_id = $2`,
      [clientId, requestId],
    );
    return r.rows[0] ?? null;
  }

  async listRequests(
    clientId: string,
    gapId: string | null,
    status: string | null,
  ): Promise<ReadonlyArray<RequestRow>> {
    const r = await this.db.query<RequestRow>(
      `SELECT * FROM lab_capability_requests
        WHERE client_id = $1 AND ($2::uuid IS NULL OR gap_id = $2) AND ($3::text IS NULL OR status = $3)
        ORDER BY created_at DESC, request_id`,
      [clientId, gapId, status],
    );
    return r.rows;
  }

  // --- Stage 5: results ---

  async insertResult(input: {
    resultId: string;
    scope: LabCapabilitiesScope;
    requestId: string;
    fulfillmentKind: LabCapabilityFulfillmentKind;
    actor: LabCapabilityActor;
    providerAdapterKey: string | null;
    providerRecordId: string | null;
    humanPlaneCitation: unknown;
    deliveredArtifact: unknown;
    grantedRights: unknown;
  }): Promise<ResultRow> {
    const now = this.nowIso();
    const r = await this.db.query<ResultRow>(
      `INSERT INTO lab_capability_results
         (result_id, request_id, agency_id, client_id, workspace_id, fulfillment_kind, actor,
          provider_adapter_key, provider_record_id, human_plane_citation, delivered_artifact,
          granted_rights, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb,
               $13, $14::timestamptz)
       RETURNING *`,
      [
        input.resultId,
        input.requestId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.fulfillmentKind,
        input.actor,
        input.providerAdapterKey,
        input.providerRecordId,
        json(input.humanPlaneCitation),
        json(input.deliveredArtifact),
        json(input.grantedRights),
        LAB_CAPABILITIES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findResult(clientId: string, resultId: string): Promise<ResultRow | null> {
    const r = await this.db.query<ResultRow>(
      `SELECT * FROM lab_capability_results WHERE client_id = $1 AND result_id = $2`,
      [clientId, resultId],
    );
    return r.rows[0] ?? null;
  }

  async listResults(clientId: string, requestId: string | null): Promise<ReadonlyArray<ResultRow>> {
    const r = await this.db.query<ResultRow>(
      `SELECT * FROM lab_capability_results
        WHERE client_id = $1 AND ($2::uuid IS NULL OR request_id = $2)
        ORDER BY created_at DESC, result_id`,
      [clientId, requestId],
    );
    return r.rows;
  }

  // --- Stage 6: verifications ---

  async insertVerification(input: {
    verificationId: string;
    scope: LabCapabilitiesScope;
    resultId: string;
    contractId: string;
    verdict: string;
    actor: LabCapabilityActor;
    evaluatorId: string;
    evaluatorVersion: string;
    evaluationEvidence: unknown;
  }): Promise<VerificationRow> {
    const now = this.nowIso();
    const r = await this.db.query<VerificationRow>(
      `INSERT INTO lab_capability_verifications
         (verification_id, result_id, contract_id, agency_id, client_id, workspace_id,
          verdict, actor, evaluator_id, evaluator_version, evaluation_evidence,
          contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::timestamptz)
       RETURNING *`,
      [
        input.verificationId,
        input.resultId,
        input.contractId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.verdict,
        input.actor,
        input.evaluatorId,
        input.evaluatorVersion,
        json(input.evaluationEvidence),
        LAB_CAPABILITIES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findVerification(clientId: string, verificationId: string): Promise<VerificationRow | null> {
    const r = await this.db.query<VerificationRow>(
      `SELECT * FROM lab_capability_verifications WHERE client_id = $1 AND verification_id = $2`,
      [clientId, verificationId],
    );
    return r.rows[0] ?? null;
  }

  async listVerifications(clientId: string, resultId: string | null): Promise<ReadonlyArray<VerificationRow>> {
    const r = await this.db.query<VerificationRow>(
      `SELECT * FROM lab_capability_verifications
        WHERE client_id = $1 AND ($2::uuid IS NULL OR result_id = $2)
        ORDER BY created_at DESC, verification_id`,
      [clientId, resultId],
    );
    return r.rows;
  }

  // --- Stage 7: capability versions ---

  async insertVersion(input: {
    capabilityId: string;
    capabilityVersion: number;
    scope: LabCapabilitiesScope;
    capabilityKey: string;
    displayName: string;
    actor: LabCapabilityActor;
    inputSchema: unknown;
    outputSchema: unknown;
    constraints: unknown;
    qualityEvaluator: unknown;
    cost: unknown;
    latency: unknown;
    origin: string;
    provenance: unknown;
    implementation: unknown;
    simulatorImplementation: unknown;
    realImplementation: unknown;
    requirements: unknown;
    sourceVerificationId: string | null;
    sourceGapId: string | null;
  }): Promise<VersionRow> {
    const now = this.nowIso();
    const r = await this.db.query<VersionRow>(
      `INSERT INTO lab_capability_versions
         (capability_id, capability_version, agency_id, client_id, workspace_id, capability_key,
          display_name, status, actor, input_schema, output_schema, constraints, quality_evaluator,
          cost, latency, origin, provenance, implementation, simulator_implementation,
          real_implementation, requirements, source_verification_id, source_gap_id,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
               $13::jsonb, $14::jsonb, $15, $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb,
               $20::jsonb, $21, $22, $23, $24::timestamptz, $24::timestamptz)
       RETURNING *`,
      [
        input.capabilityId,
        input.capabilityVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.capabilityKey,
        input.displayName,
        input.actor,
        json(input.inputSchema),
        json(input.outputSchema),
        json(input.constraints),
        json(input.qualityEvaluator),
        json(input.cost),
        json(input.latency),
        input.origin,
        json(input.provenance),
        json(input.implementation),
        json(input.simulatorImplementation),
        json(input.realImplementation),
        json(input.requirements),
        input.sourceVerificationId,
        input.sourceGapId,
        LAB_CAPABILITIES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async updateVersionStatus(
    clientId: string,
    capabilityId: string,
    capabilityVersion: number,
    status: string,
  ): Promise<VersionRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<VersionRow>(
      `UPDATE lab_capability_versions
          SET status = $4, updated_at = $5::timestamptz
        WHERE client_id = $1 AND capability_id = $2 AND capability_version = $3
        RETURNING *`,
      [clientId, capabilityId, capabilityVersion, status, now],
    );
    return r.rows[0] ?? null;
  }

  async findVersion(clientId: string, capabilityId: string, capabilityVersion: number): Promise<VersionRow | null> {
    const r = await this.db.query<VersionRow>(
      `SELECT * FROM lab_capability_versions
        WHERE client_id = $1 AND capability_id = $2 AND capability_version = $3`,
      [clientId, capabilityId, capabilityVersion],
    );
    return r.rows[0] ?? null;
  }

  async findLatestVersion(clientId: string, capabilityId: string): Promise<VersionRow | null> {
    const r = await this.db.query<VersionRow>(
      `SELECT * FROM lab_capability_versions
        WHERE client_id = $1 AND capability_id = $2
        ORDER BY capability_version DESC
        LIMIT 1`,
      [clientId, capabilityId],
    );
    return r.rows[0] ?? null;
  }

  async listVersions(clientId: string, capabilityId: string): Promise<ReadonlyArray<VersionRow>> {
    const r = await this.db.query<VersionRow>(
      `SELECT * FROM lab_capability_versions
        WHERE client_id = $1 AND capability_id = $2
        ORDER BY capability_version ASC`,
      [clientId, capabilityId],
    );
    return r.rows;
  }

  async listLatestVersions(
    clientId: string,
    status: string | null,
  ): Promise<ReadonlyArray<VersionRow>> {
    const r = await this.db.query<VersionRow>(
      `SELECT DISTINCT ON (capability_id) *
         FROM lab_capability_versions
        WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY capability_id, capability_version DESC`,
      [clientId, status],
    );
    return r.rows;
  }

  /** The linked verification for a version row (the derived verification state — EVIDENCE, never asserted). */
  async findVerificationState(row: VersionRow): Promise<LabCapabilityVerificationState> {
    if (row.source_verification_id === null) {
      return { verified: false, verificationId: null, verdict: null, evaluatorId: null, evaluatorVersion: null, verifiedAt: null };
    }
    const r = await this.db.query<VerificationRow>(
      `SELECT * FROM lab_capability_verifications WHERE verification_id = $1`,
      [row.source_verification_id],
    );
    const verification = r.rows[0];
    if (verification === undefined) {
      return { verified: false, verificationId: row.source_verification_id, verdict: null, evaluatorId: null, evaluatorVersion: null, verifiedAt: null };
    }
    return {
      verified: verification.verdict === 'pass',
      verificationId: verification.verification_id,
      verdict: verification.verdict as LabCapabilityVerificationRecord['verdict'],
      evaluatorId: verification.evaluator_id,
      evaluatorVersion: verification.evaluator_version,
      verifiedAt: toIso(verification.created_at),
    };
  }

  // --- Stage 8: simulation links ---

  async insertSimulation(input: {
    simulationId: string;
    scope: LabCapabilitiesScope;
    capabilityId: string;
    capabilityVersion: number;
    actor: LabCapabilityActor;
    simulationReference: string;
    outcome: string;
    evidence: unknown;
  }): Promise<SimulationRow> {
    const now = this.nowIso();
    const r = await this.db.query<SimulationRow>(
      `INSERT INTO lab_capability_simulations
         (simulation_id, capability_id, capability_version, agency_id, client_id, workspace_id,
          actor, simulation_reference, outcome, evidence, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::timestamptz)
       RETURNING *`,
      [
        input.simulationId,
        input.capabilityId,
        input.capabilityVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.actor,
        input.simulationReference,
        input.outcome,
        json(input.evidence),
        LAB_CAPABILITIES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listSimulations(clientId: string, capabilityId: string | null): Promise<ReadonlyArray<SimulationRow>> {
    const r = await this.db.query<SimulationRow>(
      `SELECT * FROM lab_capability_simulations
        WHERE client_id = $1 AND ($2::uuid IS NULL OR capability_id = $2)
        ORDER BY created_at DESC, simulation_id`,
      [clientId, capabilityId],
    );
    return r.rows;
  }

  // --- Stage 9: real-test links ---

  async insertRealTest(input: {
    realTestId: string;
    scope: LabCapabilitiesScope;
    capabilityId: string;
    capabilityVersion: number;
    actor: LabCapabilityActor;
    realTestCitation: unknown;
    outcome: string;
    evidence: unknown;
  }): Promise<RealTestRow> {
    const now = this.nowIso();
    const r = await this.db.query<RealTestRow>(
      `INSERT INTO lab_capability_real_tests
         (real_test_id, capability_id, capability_version, agency_id, client_id, workspace_id,
          actor, real_test_citation, outcome, evidence, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12::timestamptz)
       RETURNING *`,
      [
        input.realTestId,
        input.capabilityId,
        input.capabilityVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.actor,
        json(input.realTestCitation),
        input.outcome,
        json(input.evidence),
        LAB_CAPABILITIES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listRealTests(clientId: string, capabilityId: string | null): Promise<ReadonlyArray<RealTestRow>> {
    const r = await this.db.query<RealTestRow>(
      `SELECT * FROM lab_capability_real_tests
        WHERE client_id = $1 AND ($2::uuid IS NULL OR capability_id = $2)
        ORDER BY created_at DESC, real_test_id`,
      [clientId, capabilityId],
    );
    return r.rows;
  }
}
