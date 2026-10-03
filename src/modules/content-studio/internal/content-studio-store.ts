/**
 * /content-studio persistence (STUDIO-001 — the migration-064 tables).
 *
 * Owns EXACTLY the six own tables (the 059/060/061/063 discipline):
 *
 *   studio_production_requests, studio_sessions,
 *   studio_session_events, studio_processing_steps,
 *   studio_output_versions, studio_treatment_requests.
 *
 * NO AUTHORITY TRANSFER / NO SHADOWING (§16 + lock v1.7 #43): no
 * publishing, distribution, experiment, evidence, rights, policy,
 * workflow or execution table is written or joined here; no content
 * asset/rights table is written — the source artifacts and consent
 * records are OPAQUE references in the request's declared data, and
 * the existing v1.6 authorities stay the sole decision-makers. No
 * /lab-agent-body table is written either — the organization bodies
 * are OPAQUE version-reference strings resolved through the module's
 * structural port (registry reads only).
 *
 * THE DURABILITY DISCIPLINE (§9): the processing steps are PERSISTED
 * WORK — the claim is a CAS UPDATE over `status = 'queued'` rows
 * (SELECT ... FOR UPDATE SKIP LOCKED), the outcomes are guarded
 * terminal advances, and NOTHING processing-related lives in module
 * memory: a restart re-reads the same rows and continues (the
 * integration durability proof).
 *
 * Requests are immutable version rows (append-only chain + scope
 * fence); sessions are versioned revisions whose state advances ONLY
 * along the frozen §5 table under the guarded UPDATE trigger;
 * session events are APPEND-ONLY OUTRIGHT; output versions and
 * treatment requests are INSERT-ONLY. Every read is CLIENT-scoped
 * (the uniform tenant fence; the module resolves foreign/unknown
 * scope to the uniform NotFound — no existence oracle).
 */

import { createHash } from 'node:crypto';
import type { DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  ContentStudioFormatDeclaration,
  ContentStudioOrganizationDeclaration,
  ContentStudioOrganizationValidation,
  ContentStudioOutputVersionRecord,
  ContentStudioProcessingStepRecord,
  ContentStudioProductionRequestContent,
  ContentStudioProductionRequestRecord,
  ContentStudioScope,
  ContentStudioSessionEventKind,
  ContentStudioSessionEventRecord,
  ContentStudioSessionRecord,
  ContentStudioSessionState,
  ContentStudioStepFailureReason,
  ContentStudioStepStatus,
  ContentStudioTerminalReason,
  ContentStudioTreatmentRequestRecord,
  ContentStudioTreatmentSpecification,
} from '../public.ts';
import { CONTENT_STUDIO_CONTRACT_VERSION } from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case as returned by PostgreSQL)
// ---------------------------------------------------------------------------

interface RequestRow extends DbRow {
  request_id: string;
  request_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  content: unknown;
  contract_version: string;
  created_at: Date;
}

interface SessionRow extends DbRow {
  session_id: string;
  revision: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  request_id: string;
  request_version: number | string;
  format_id: string;
  format_version: number | string;
  organization: unknown;
  organization_validation: unknown;
  state: string;
  terminal_reason: string | null;
  prior_output_version_id: string | null;
  origin_treatment_id: string | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
  state_changed_at: Date;
}

interface EventRow extends DbRow {
  event_id: string;
  session_id: string;
  revision: number | string;
  agency_id: string;
  client_id: string;
  seq: number | string;
  event_kind: string;
  payload: unknown;
  payload_digest: string;
  contract_version: string;
  created_at: Date;
}

interface StepRow extends DbRow {
  step_id: string;
  session_id: string;
  revision: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  stage_id: string;
  stage_index: number | string;
  status: string;
  attempts: number | string;
  run_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  output: unknown;
  failure_reason: string | null;
  failure_detail: string | null;
  cost_units: number | string;
  duration_ms: number | string;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface OutputRow extends DbRow {
  output_version_id: string;
  session_id: string;
  revision: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  artifact_package: unknown;
  parent_output_version_id: string | null;
  aggregate_cost_units: number | string;
  aggregate_duration_ms: number | string;
  contract_version: string;
  created_at: Date;
}

interface TreatmentRow extends DbRow {
  treatment_id: string;
  session_id: string;
  revision: number | string;
  target_output_version_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  specification: unknown;
  successor_revision: number | string;
  contract_version: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// The canonical payload digest (the deterministic event digest)
// ---------------------------------------------------------------------------

/**
 * The canonical payload digest: SHA-256 over the JSON serialization
 * with SORTED keys (deterministic regardless of insertion order — the
 * reproducibility discipline, the migration-063 precedent).
 */
export function canonicalStudioPayloadDigest(payload: Readonly<Record<string, unknown>>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key];
  }
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

export function mapRequestRow(r: RequestRow): ContentStudioProductionRequestRecord {
  return {
    requestId: r.request_id,
    requestVersion: Number(r.request_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    content: r.content as ContentStudioProductionRequestContent,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapSessionRow(r: SessionRow): ContentStudioSessionRecord {
  return {
    sessionId: r.session_id,
    revision: Number(r.revision),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    requestId: r.request_id,
    requestVersion: Number(r.request_version),
    formatId: r.format_id,
    formatVersion: Number(r.format_version),
    organization: r.organization as ContentStudioOrganizationDeclaration,
    organizationValidation: r.organization_validation as ContentStudioOrganizationValidation,
    state: r.state as ContentStudioSessionState,
    terminalReason: r.terminal_reason === null ? null : (r.terminal_reason as ContentStudioTerminalReason),
    priorOutputVersionId: r.prior_output_version_id,
    originTreatmentId: r.origin_treatment_id,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    stateChangedAt: toIso(r.state_changed_at),
  };
}

export function mapEventRow(r: EventRow): ContentStudioSessionEventRecord {
  return {
    eventId: r.event_id,
    sessionId: r.session_id,
    revision: Number(r.revision),
    agencyId: r.agency_id,
    clientId: r.client_id,
    seq: Number(r.seq),
    eventKind: r.event_kind as ContentStudioSessionEventKind,
    payload: r.payload as Readonly<Record<string, unknown>>,
    payloadDigest: r.payload_digest,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapStepRow(r: StepRow): ContentStudioProcessingStepRecord {
  return {
    stepId: r.step_id,
    sessionId: r.session_id,
    revision: Number(r.revision),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    stageId: r.stage_id,
    stageIndex: Number(r.stage_index),
    status: r.status as ContentStudioStepStatus,
    attempts: Number(r.attempts),
    runAt: toIso(r.run_at),
    lockedAt: r.locked_at === null ? null : toIso(r.locked_at),
    lockedBy: r.locked_by,
    output: r.output === null ? null : (r.output as Readonly<Record<string, unknown>>),
    failureReason: r.failure_reason === null ? null : (r.failure_reason as ContentStudioStepFailureReason),
    failureDetail: r.failure_detail,
    costUnits: Number(r.cost_units),
    durationMs: Number(r.duration_ms),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapOutputRow(r: OutputRow): ContentStudioOutputVersionRecord {
  return {
    outputVersionId: r.output_version_id,
    sessionId: r.session_id,
    revision: Number(r.revision),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    artifactPackage: r.artifact_package as Readonly<Record<string, unknown>>,
    parentOutputVersionId: r.parent_output_version_id,
    aggregateCostUnits: Number(r.aggregate_cost_units),
    aggregateDurationMs: Number(r.aggregate_duration_ms),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapTreatmentRow(r: TreatmentRow): ContentStudioTreatmentRequestRecord {
  return {
    treatmentId: r.treatment_id,
    sessionId: r.session_id,
    revision: Number(r.revision),
    targetOutputVersionId: r.target_output_version_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    specification: r.specification as ContentStudioTreatmentSpecification,
    successorRevision: Number(r.successor_revision),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface InsertRequestVersionInput {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly scope: ContentStudioScope;
  readonly content: ContentStudioProductionRequestContent;
}

export interface InsertSessionRevisionInput {
  readonly sessionId: string;
  readonly revision: number;
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly format: Pick<ContentStudioFormatDeclaration, 'formatId' | 'formatVersion'>;
  readonly organization: ContentStudioOrganizationDeclaration;
  readonly organizationValidation: ContentStudioOrganizationValidation;
  readonly priorOutputVersionId: string | null;
  readonly originTreatmentId: string | null;
}

export interface AdvanceSessionStateInput {
  readonly clientId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly to: ContentStudioSessionState;
  readonly terminalReason: ContentStudioTerminalReason | null;
}

export interface InsertSessionEventInput {
  readonly eventId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly scope: ContentStudioScope;
  readonly seq: number;
  readonly eventKind: ContentStudioSessionEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface InsertProcessingStepInput {
  readonly stepId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly scope: ContentStudioScope;
  readonly stageId: string;
  readonly stageIndex: number;
  readonly runAtIso: string;
}

export interface CompleteStepUpdateInput {
  readonly stepId: string;
  readonly output: Readonly<Record<string, unknown>>;
  readonly costUnits: number;
  readonly durationMs: number;
}

export interface InsertOutputVersionInput {
  readonly outputVersionId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly scope: ContentStudioScope;
  readonly artifactPackage: Readonly<Record<string, unknown>>;
  readonly parentOutputVersionId: string | null;
  readonly aggregateCostUnits: number;
  readonly aggregateDurationMs: number;
}

export interface InsertTreatmentRequestInput {
  readonly treatmentId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly targetOutputVersionId: string;
  readonly scope: ContentStudioScope;
  readonly specification: ContentStudioTreatmentSpecification;
  readonly successorRevision: number;
}

export class ContentStudioStore {
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

  // --- production requests (immutable version rows) ---

  async insertRequestVersion(input: InsertRequestVersionInput): Promise<RequestRow> {
    const r = await this.db.query<RequestRow>(
      `INSERT INTO studio_production_requests
         (request_id, request_version, agency_id, client_id, workspace_id,
          content, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz)
       RETURNING *`,
      [
        input.requestId,
        input.requestVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        JSON.stringify(input.content),
        CONTENT_STUDIO_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async findRequestVersion(clientId: string, requestId: string, requestVersion: number): Promise<RequestRow | null> {
    const r = await this.db.query<RequestRow>(
      `SELECT * FROM studio_production_requests
        WHERE client_id = $1 AND request_id = $2 AND request_version = $3`,
      [clientId, requestId, requestVersion],
    );
    return r.rows[0] ?? null;
  }

  async findLatestRequestVersion(clientId: string, requestId: string): Promise<RequestRow | null> {
    const r = await this.db.query<RequestRow>(
      `SELECT * FROM studio_production_requests
        WHERE client_id = $1 AND request_id = $2
        ORDER BY request_version DESC LIMIT 1`,
      [clientId, requestId],
    );
    return r.rows[0] ?? null;
  }

  async listLatestRequests(clientId: string): Promise<ReadonlyArray<RequestRow>> {
    const r = await this.db.query<RequestRow>(
      `SELECT DISTINCT ON (request_id) *
         FROM studio_production_requests
        WHERE client_id = $1
        ORDER BY request_id, request_version DESC`,
      [clientId],
    );
    return r.rows;
  }

  // --- session revisions (the guarded §5 state machine) ---

  async insertSessionRevision(input: InsertSessionRevisionInput): Promise<SessionRow> {
    const now = this.nowIso();
    const r = await this.db.query<SessionRow>(
      `INSERT INTO studio_sessions
         (session_id, revision, agency_id, client_id, workspace_id,
          request_id, request_version, format_id, format_version,
          organization, organization_validation, state, terminal_reason,
          prior_output_version_id, origin_treatment_id,
          contract_version, created_at, updated_at, state_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10::jsonb, $11::jsonb, 'created', NULL, $12, $13,
               $14, $15::timestamptz, $15::timestamptz, $15::timestamptz)
       RETURNING *`,
      [
        input.sessionId,
        input.revision,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.requestId,
        input.requestVersion,
        input.format.formatId,
        input.format.formatVersion,
        JSON.stringify(input.organization),
        JSON.stringify(input.organizationValidation),
        input.priorOutputVersionId,
        input.originTreatmentId,
        CONTENT_STUDIO_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findLatestSessionRevision(clientId: string, sessionId: string): Promise<SessionRow | null> {
    const r = await this.db.query<SessionRow>(
      `SELECT * FROM studio_sessions
        WHERE client_id = $1 AND session_id = $2
        ORDER BY revision DESC LIMIT 1`,
      [clientId, sessionId],
    );
    return r.rows[0] ?? null;
  }

  async findSessionRevision(clientId: string, sessionId: string, revision: number): Promise<SessionRow | null> {
    const r = await this.db.query<SessionRow>(
      `SELECT * FROM studio_sessions
        WHERE client_id = $1 AND session_id = $2 AND revision = $3`,
      [clientId, sessionId, revision],
    );
    return r.rows[0] ?? null;
  }

  async listSessionRevisions(clientId: string, sessionId: string): Promise<ReadonlyArray<SessionRow>> {
    const r = await this.db.query<SessionRow>(
      `SELECT * FROM studio_sessions
        WHERE client_id = $1 AND session_id = $2
        ORDER BY revision ASC`,
      [clientId, sessionId],
    );
    return r.rows;
  }

  async listLatestSessions(clientId: string): Promise<ReadonlyArray<SessionRow>> {
    const r = await this.db.query<SessionRow>(
      `SELECT DISTINCT ON (session_id) *
         FROM studio_sessions
        WHERE client_id = $1
        ORDER BY session_id, revision DESC`,
      [clientId],
    );
    return r.rows;
  }

  async advanceSessionState(input: AdvanceSessionStateInput): Promise<SessionRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<SessionRow>(
      `UPDATE studio_sessions
          SET state = $4,
              terminal_reason = $5,
              updated_at = $6::timestamptz,
              state_changed_at = $6::timestamptz
        WHERE client_id = $1 AND session_id = $2 AND revision = $3
        RETURNING *`,
      [input.clientId, input.sessionId, input.revision, input.to, input.terminalReason, now],
    );
    return r.rows[0] ?? null;
  }

  // --- the append-only session event tail ---

  async insertSessionEvent(input: InsertSessionEventInput): Promise<EventRow> {
    const r = await this.db.query<EventRow>(
      `INSERT INTO studio_session_events
         (event_id, session_id, revision, agency_id, client_id, seq,
          event_kind, payload, payload_digest, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::timestamptz)
       RETURNING *`,
      [
        input.eventId,
        input.sessionId,
        input.revision,
        input.scope.agencyId,
        input.scope.clientId,
        input.seq,
        input.eventKind,
        JSON.stringify(input.payload),
        canonicalStudioPayloadDigest(input.payload),
        CONTENT_STUDIO_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async listSessionEvents(clientId: string, sessionId: string): Promise<ReadonlyArray<EventRow>> {
    const r = await this.db.query<EventRow>(
      `SELECT * FROM studio_session_events
        WHERE client_id = $1 AND session_id = $2
        ORDER BY revision ASC, seq ASC`,
      [clientId, sessionId],
    );
    return r.rows;
  }

  async nextEventSeq(clientId: string, sessionId: string, revision: number): Promise<number> {
    const r = await this.db.query<{ max_seq: number | string | null }>(
      `SELECT MAX(seq) AS max_seq FROM studio_session_events
        WHERE client_id = $1 AND session_id = $2 AND revision = $3`,
      [clientId, sessionId, revision],
    );
    const current = r.rows[0]?.max_seq;
    return current === null || current === undefined ? 1 : Number(current) + 1;
  }

  // --- the durable processing steps (§9) ---

  async insertProcessingStep(input: InsertProcessingStepInput): Promise<StepRow> {
    const now = this.nowIso();
    const r = await this.db.query<StepRow>(
      `INSERT INTO studio_processing_steps
         (step_id, session_id, revision, agency_id, client_id, workspace_id,
          stage_id, stage_index, status, attempts, run_at, locked_at, locked_by,
          output, failure_reason, failure_detail, cost_units, duration_ms,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 0, $9::timestamptz, NULL, NULL,
               NULL, NULL, NULL, 0, 0, $10, $11::timestamptz, $11::timestamptz)
       RETURNING *`,
      [
        input.stepId,
        input.sessionId,
        input.revision,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.stageId,
        input.stageIndex,
        input.runAtIso,
        CONTENT_STUDIO_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findStep(clientId: string, stepId: string): Promise<StepRow | null> {
    const r = await this.db.query<StepRow>(
      `SELECT * FROM studio_processing_steps
        WHERE client_id = $1 AND step_id = $2`,
      [clientId, stepId],
    );
    return r.rows[0] ?? null;
  }

  async listSessionSteps(clientId: string, sessionId: string): Promise<ReadonlyArray<StepRow>> {
    const r = await this.db.query<StepRow>(
      `SELECT * FROM studio_processing_steps
        WHERE client_id = $1 AND session_id = $2
        ORDER BY revision ASC, stage_index ASC, created_at ASC`,
      [clientId, sessionId],
    );
    return r.rows;
  }

  /**
   * THE DURABLE CLAIM (§9): the CAS batch-claim over due queued steps —
   * `FOR UPDATE SKIP LOCKED` so concurrent drivers never double-claim.
   * The step guard trigger enforces queued→running (+ the attempt
   * increment); the claim is tenant-scoped by construction and may be
   * further scoped to one session's pipeline.
   */
  async claimDueSteps(clientId: string, sessionId: string | null, limit: number, lockedBy: string): Promise<ReadonlyArray<StepRow>> {
    const now = this.nowIso();
    const r = await this.db.query<StepRow>(
      `UPDATE studio_processing_steps AS step
          SET status = 'running',
              attempts = step.attempts + 1,
              locked_at = $3::timestamptz,
              locked_by = $4,
              updated_at = $3::timestamptz
        WHERE step.step_id IN (
            SELECT claim.step_id FROM studio_processing_steps AS claim
             WHERE claim.client_id = $1
               AND ($5::uuid IS NULL OR claim.session_id = $5::uuid)
               AND claim.status = 'queued'
               AND claim.run_at <= $3::timestamptz
             ORDER BY claim.created_at ASC, claim.revision ASC, claim.stage_index ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [clientId, limit, now, lockedBy, sessionId],
    );
    return r.rows;
  }

  async completeStep(input: CompleteStepUpdateInput): Promise<StepRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<StepRow>(
      `UPDATE studio_processing_steps
          SET status = 'succeeded',
              output = $2::jsonb,
              failure_reason = NULL,
              failure_detail = NULL,
              locked_at = NULL,
              locked_by = NULL,
              cost_units = $3,
              duration_ms = $4,
              updated_at = $5::timestamptz
        WHERE step_id = $1 AND status = 'running'
        RETURNING *`,
      [input.stepId, JSON.stringify(input.output), input.costUnits, input.durationMs, now],
    );
    return r.rows[0] ?? null;
  }

  async failStep(stepId: string, failureReason: ContentStudioStepFailureReason, failureDetail: string | null): Promise<StepRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<StepRow>(
      `UPDATE studio_processing_steps
          SET status = 'failed',
              output = NULL,
              failure_reason = $2,
              failure_detail = $3,
              locked_at = NULL,
              locked_by = NULL,
              updated_at = $4::timestamptz
        WHERE step_id = $1 AND status = 'running'
        RETURNING *`,
      [stepId, failureReason, failureDetail, now],
    );
    return r.rows[0] ?? null;
  }

  async requeueStep(stepId: string): Promise<StepRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<StepRow>(
      `UPDATE studio_processing_steps
          SET status = 'queued',
              output = NULL,
              failure_reason = NULL,
              failure_detail = NULL,
              run_at = $2::timestamptz,
              locked_at = NULL,
              locked_by = NULL,
              updated_at = $2::timestamptz
        WHERE step_id = $1 AND status = 'failed'
        RETURNING *`,
      [stepId, now],
    );
    return r.rows[0] ?? null;
  }

  // --- the immutable output versions (§12 minimal runtime tail) ---

  async insertOutputVersion(input: InsertOutputVersionInput): Promise<OutputRow> {
    const r = await this.db.query<OutputRow>(
      `INSERT INTO studio_output_versions
         (output_version_id, session_id, revision, agency_id, client_id, workspace_id,
          artifact_package, parent_output_version_id,
          aggregate_cost_units, aggregate_duration_ms, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12::timestamptz)
       RETURNING *`,
      [
        input.outputVersionId,
        input.sessionId,
        input.revision,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        JSON.stringify(input.artifactPackage),
        input.parentOutputVersionId,
        input.aggregateCostUnits,
        input.aggregateDurationMs,
        CONTENT_STUDIO_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async listSessionOutputs(clientId: string, sessionId: string): Promise<ReadonlyArray<OutputRow>> {
    const r = await this.db.query<OutputRow>(
      `SELECT * FROM studio_output_versions
        WHERE client_id = $1 AND session_id = $2
        ORDER BY created_at ASC, output_version_id ASC`,
      [clientId, sessionId],
    );
    return r.rows;
  }

  async findOutputVersion(clientId: string, outputVersionId: string): Promise<OutputRow | null> {
    const r = await this.db.query<OutputRow>(
      `SELECT * FROM studio_output_versions
        WHERE client_id = $1 AND output_version_id = $2`,
      [clientId, outputVersionId],
    );
    return r.rows[0] ?? null;
  }

  // --- the structured treatment requests (§13) ---

  async insertTreatmentRequest(input: InsertTreatmentRequestInput): Promise<TreatmentRow> {
    const r = await this.db.query<TreatmentRow>(
      `INSERT INTO studio_treatment_requests
         (treatment_id, session_id, revision, target_output_version_id,
          agency_id, client_id, workspace_id, specification, successor_revision,
          contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::timestamptz)
       RETURNING *`,
      [
        input.treatmentId,
        input.sessionId,
        input.revision,
        input.targetOutputVersionId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        JSON.stringify(input.specification),
        input.successorRevision,
        CONTENT_STUDIO_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async listSessionTreatments(clientId: string, sessionId: string): Promise<ReadonlyArray<TreatmentRow>> {
    const r = await this.db.query<TreatmentRow>(
      `SELECT * FROM studio_treatment_requests
        WHERE client_id = $1 AND session_id = $2
        ORDER BY created_at ASC, treatment_id ASC`,
      [clientId, sessionId],
    );
    return r.rows;
  }
}
