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
import type { DbRow, DbTransaction, QueryParam } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  ContentStudioCaptureSessionRecord,
  ContentStudioCaptureTakeRecord,
  ContentStudioDeclaredQuestionGraph,
  ContentStudioConversationStepRecord,
  ContentStudioFormatDeclaration,
  ContentStudioFormatRecord,
  ContentStudioFormatStatus,
  ContentStudioGeneratorProvenance,
  ContentStudioIntentRecord,
  ContentStudioOrganizationDeclaration,
  ContentStudioOrganizationValidation,
  ContentStudioOutputVersionRecord,
  ContentStudioProcessingStepRecord,
  ContentStudioProductionRequestContent,
  ContentStudioProductionRequestRecord,
  ContentStudioQuestionGraphRecord,
  ContentStudioQuestionGraphReviewRecord,
  ContentStudioReviewState,
  ContentStudioReviewVerdict,
  ContentStudioReviewerKind,
  ContentStudioScope,
  ContentStudioScriptOrigin,
  ContentStudioScriptRecord,
  ContentStudioScriptReviewRecord,
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
import { CONTENT_STUDIO_CONTRACT_VERSION, CONTENT_STUDIO_CAPTURE_CONTRACT_VERSION, CONTENT_STUDIO_FORMAT_CONTRACT_VERSION, CONTENT_STUDIO_SCRIPT_CONTRACT_VERSION } from '../public.ts';

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

// The STUDIO-002 format registry rows (migration 068's studio_formats
// + studio_format_capabilities).

export interface FormatRow extends DbRow {
  format_version_id: string;
  format_id: string;
  format_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  declaration: unknown;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface FormatCapabilityLinkRow extends DbRow {
  format_version_id: string;
  capability_kind: string;
  capability_reference: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  contract_version: string;
  created_at: Date;
}

// The STUDIO-003 rows (migration 070's studio_intents, studio_scripts,
// studio_script_reviews, studio_question_graphs,
// studio_question_graph_reviews, studio_conversation_edges).

interface IntentRow extends DbRow {
  intent_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  request_id: string;
  request_version: number | string;
  objective: string;
  source_references: unknown;
  contract_version: string;
  created_at: Date;
}

interface ScriptRow extends DbRow {
  script_id: string;
  script_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  request_id: string;
  request_version: number | string;
  origin: string;
  body: unknown;
  intent_id: string | null;
  generator_organization: unknown;
  generator_model_references: unknown;
  review_state: string | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface ScriptReviewRow extends DbRow {
  review_id: string;
  script_id: string;
  script_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  verdict: string;
  reviewer_kind: string;
  reviewer_actor: string;
  note: string | null;
  decided_at: Date;
  contract_version: string;
  created_at: Date;
}

export interface QuestionGraphRow extends DbRow {
  graph_id: string;
  graph_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  request_id: string;
  request_version: number | string;
  origin: string;
  declared_graph: unknown;
  intent_id: string | null;
  generator_organization: unknown;
  generator_model_references: unknown;
  review_state: string | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface QuestionGraphReviewRow extends DbRow {
  review_id: string;
  graph_id: string;
  graph_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  verdict: string;
  reviewer_kind: string;
  reviewer_actor: string;
  note: string | null;
  decided_at: Date;
  contract_version: string;
  created_at: Date;
}

interface ConversationEdgeRow extends DbRow {
  conversation_id: string;
  session_id: string;
  revision: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  seq: number | string;
  graph_id: string;
  graph_version: number | string;
  question_id: string;
  answer_reference: string;
  answer_kind: string;
  chosen_to_question_id: string | null;
  chosen_condition: string | null;
  chooser_kind: string;
  contract_version: string;
  created_at: Date;
}

interface CaptureSessionRow extends DbRow {
  capture_session_id: string;
  session_id: string;
  revision: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  capture_mode: string;
  graph_id: string | null;
  graph_version: number | string | null;
  interviewer_representation: string | null;
  contract_version: string;
  created_at: Date;
}

interface CaptureTakeRow extends DbRow {
  take_id: string;
  take_reference: string;
  capture_session_id: string;
  session_id: string;
  revision: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  graph_id: string | null;
  graph_version: number | string | null;
  question_id: string | null;
  modality: string;
  alternate_of_take_id: string | null;
  input_kind: string;
  device_label: string;
  source_metadata: unknown;
  participant_reference: string;
  participant_grant_reference: string | null;
  consent_references: unknown;
  interviewer_representation: string | null;
  object_key: string;
  object_digest: string;
  object_size: number | string;
  content_type: string;
  ingest_state: string;
  ingest_analysis: unknown;
  ingest_failure_reason: string | null;
  ingest_failure_detail: string | null;
  ingest_duration_ms: number | string | null;
  ingest_completed_at: Date | null;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
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

/** Maps one migration-068 registry row to its record view (WITHOUT the capability links — the caller assembles them). */
export function mapFormatRow(r: FormatRow, capabilityLinks: ReadonlyArray<string>): ContentStudioFormatRecord {
  return {
    formatVersionId: r.format_version_id,
    formatId: r.format_id,
    formatVersion: Number(r.format_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as ContentStudioFormatStatus,
    declaration: r.declaration as ContentStudioFormatDeclaration,
    capabilityLinks,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

// The STUDIO-003 mappers (migration 070).

export function mapIntentRow(r: IntentRow): ContentStudioIntentRecord {
  return {
    intentId: r.intent_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    requestId: r.request_id,
    requestVersion: Number(r.request_version),
    objective: r.objective,
    sourceReferences: r.source_references as ReadonlyArray<string>,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapScriptRow(r: ScriptRow): ContentStudioScriptRecord {
  return {
    scriptId: r.script_id,
    scriptVersion: Number(r.script_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    requestId: r.request_id,
    requestVersion: Number(r.request_version),
    origin: r.origin as ContentStudioScriptOrigin,
    body: r.body as Readonly<Record<string, unknown>>,
    intentId: r.intent_id,
    generatorOrganization: r.generator_organization === null ? null : (r.generator_organization as ContentStudioOrganizationDeclaration),
    generatorModelReferences: r.generator_model_references === null ? null : (r.generator_model_references as ReadonlyArray<string>),
    reviewState: r.review_state === null ? null : (r.review_state as ContentStudioReviewState),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapScriptReviewRow(r: ScriptReviewRow): ContentStudioScriptReviewRecord {
  return {
    reviewId: r.review_id,
    scriptId: r.script_id,
    scriptVersion: Number(r.script_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    verdict: r.verdict as ContentStudioReviewVerdict,
    reviewerKind: r.reviewer_kind as ContentStudioReviewerKind,
    reviewerActor: r.reviewer_actor,
    note: r.note,
    decidedAt: toIso(r.decided_at),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapQuestionGraphRow(r: QuestionGraphRow): ContentStudioQuestionGraphRecord {
  return {
    graphId: r.graph_id,
    graphVersion: Number(r.graph_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    requestId: r.request_id,
    requestVersion: Number(r.request_version),
    origin: r.origin as ContentStudioScriptOrigin,
    declaredGraph: r.declared_graph as ContentStudioDeclaredQuestionGraph,
    intentId: r.intent_id,
    generatorOrganization: r.generator_organization === null ? null : (r.generator_organization as ContentStudioOrganizationDeclaration),
    generatorModelReferences: r.generator_model_references === null ? null : (r.generator_model_references as ReadonlyArray<string>),
    reviewState: r.review_state === null ? null : (r.review_state as ContentStudioReviewState),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapQuestionGraphReviewRow(r: QuestionGraphReviewRow): ContentStudioQuestionGraphReviewRecord {
  return {
    reviewId: r.review_id,
    graphId: r.graph_id,
    graphVersion: Number(r.graph_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    verdict: r.verdict as ContentStudioReviewVerdict,
    reviewerKind: r.reviewer_kind as ContentStudioReviewerKind,
    reviewerActor: r.reviewer_actor,
    note: r.note,
    decidedAt: toIso(r.decided_at),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapConversationEdgeRow(r: ConversationEdgeRow): ContentStudioConversationStepRecord {
  return {
    conversationId: r.conversation_id,
    sessionId: r.session_id,
    revision: Number(r.revision),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    seq: Number(r.seq),
    graphId: r.graph_id,
    graphVersion: Number(r.graph_version),
    questionId: r.question_id,
    answerReference: r.answer_reference,
    answerKind: r.answer_kind as ContentStudioConversationStepRecord['answerKind'],
    chosenToQuestionId: r.chosen_to_question_id,
    chosenCondition: r.chosen_condition === null ? null : (r.chosen_condition as ContentStudioConversationStepRecord['chosenCondition']),
    chooserKind: r.chooser_kind as ContentStudioConversationStepRecord['chooserKind'],
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapCaptureSessionRow(r: CaptureSessionRow): ContentStudioCaptureSessionRecord {
  return {
    captureSessionId: r.capture_session_id,
    sessionId: r.session_id,
    revision: Number(r.revision),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    captureMode: r.capture_mode as ContentStudioCaptureSessionRecord['captureMode'],
    graphId: r.graph_id,
    graphVersion: r.graph_version === null ? null : Number(r.graph_version),
    interviewerRepresentation:
      r.interviewer_representation === null ? null : (r.interviewer_representation as ContentStudioCaptureSessionRecord['interviewerRepresentation']),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

export function mapCaptureTakeRow(r: CaptureTakeRow): ContentStudioCaptureTakeRecord {
  return {
    takeId: r.take_id,
    takeReference: r.take_reference,
    captureSessionId: r.capture_session_id,
    sessionId: r.session_id,
    revision: Number(r.revision),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    graphId: r.graph_id,
    graphVersion: r.graph_version === null ? null : Number(r.graph_version),
    questionId: r.question_id,
    modality: r.modality as ContentStudioCaptureTakeRecord['modality'],
    alternateOfTakeId: r.alternate_of_take_id,
    inputKind: r.input_kind as ContentStudioCaptureTakeRecord['inputKind'],
    deviceLabel: r.device_label,
    sourceMetadata: r.source_metadata as Readonly<Record<string, unknown>>,
    participantReference: r.participant_reference,
    participantGrantReference: r.participant_grant_reference,
    consentReferences: r.consent_references as ReadonlyArray<string>,
    interviewerRepresentation:
      r.interviewer_representation === null ? null : (r.interviewer_representation as ContentStudioCaptureTakeRecord['interviewerRepresentation']),
    objectKey: r.object_key,
    objectDigest: r.object_digest,
    objectSize: Number(r.object_size),
    contentType: r.content_type,
    ingestState: r.ingest_state as ContentStudioCaptureTakeRecord['ingestState'],
    ingestAnalysis: r.ingest_analysis === null ? null : (r.ingest_analysis as Readonly<Record<string, unknown>>),
    ingestFailureReason: r.ingest_failure_reason === null ? null : (r.ingest_failure_reason as ContentStudioCaptureTakeRecord['ingestFailureReason']),
    ingestFailureDetail: r.ingest_failure_detail,
    ingestDurationMs: r.ingest_duration_ms === null ? null : Number(r.ingest_duration_ms),
    ingestCompletedAt: r.ingest_completed_at === null ? null : toIso(r.ingest_completed_at),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
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

// The STUDIO-002 format-registry inputs (migration 068).

export interface InsertFormatVersionInput {
  readonly formatVersionId: string;
  readonly formatId: string;
  readonly formatVersion: number;
  readonly scope: ContentStudioScope;
  readonly declaration: ContentStudioFormatDeclaration;
}

export interface InsertFormatCapabilityLinkInput {
  readonly formatVersionId: string;
  readonly scope: ContentStudioScope;
  readonly capabilityKind: 'required';
  readonly capabilityReference: string;
}

export interface AdvanceFormatStatusInput {
  readonly formatVersionId: string;
  readonly from: ContentStudioFormatStatus;
  readonly to: ContentStudioFormatStatus;
}

// The STUDIO-003 insert inputs (migration 070).

export interface InsertIntentInput {
  readonly intentId: string;
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly objective: string;
  readonly sourceReferences: ReadonlyArray<string>;
}

export interface InsertScriptVersionInput {
  readonly scriptId: string;
  readonly scriptVersion: number;
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly origin: ContentStudioScriptOrigin;
  readonly body: Readonly<Record<string, unknown>>;
  /** REQUIRED for generated rows (the intent lineage). */
  readonly intentId?: string;
  /** REQUIRED for generated rows (the FULL generation provenance). */
  readonly generator?: ContentStudioGeneratorProvenance;
}

export interface AdvanceScriptReviewStateInput {
  readonly clientId: string;
  readonly scriptId: string;
  readonly scriptVersion: number;
  readonly to: ContentStudioReviewState;
  readonly from: ContentStudioReviewState;
}

export interface InsertScriptReviewInput {
  readonly reviewId: string;
  readonly scriptId: string;
  readonly scriptVersion: number;
  readonly scope: ContentStudioScope;
  readonly verdict: ContentStudioReviewVerdict;
  readonly reviewerKind: ContentStudioReviewerKind;
  readonly reviewerActor: string;
  readonly note?: string | null;
}

export interface InsertQuestionGraphVersionInput {
  readonly graphId: string;
  readonly graphVersion: number;
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly origin: ContentStudioScriptOrigin;
  readonly declaredGraph: ContentStudioDeclaredQuestionGraph;
  /** REQUIRED for generated rows (the intent lineage). */
  readonly intentId?: string;
  /** REQUIRED for generated rows (the FULL generation provenance). */
  readonly generator?: ContentStudioGeneratorProvenance;
}

export interface AdvanceQuestionGraphReviewStateInput {
  readonly clientId: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly to: ContentStudioReviewState;
  readonly from: ContentStudioReviewState;
}

export interface InsertQuestionGraphReviewInput {
  readonly reviewId: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly scope: ContentStudioScope;
  readonly verdict: ContentStudioReviewVerdict;
  readonly reviewerKind: ContentStudioReviewerKind;
  readonly reviewerActor: string;
  readonly note?: string | null;
}

export interface InsertConversationEdgeInput {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly scope: ContentStudioScope;
  readonly seq: number;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly questionId: string;
  readonly answerReference: string;
  readonly answerKind: ContentStudioConversationStepRecord['answerKind'];
  readonly chosenToQuestionId?: string | null;
  readonly chosenCondition?: string | null;
  readonly chooserKind: ContentStudioConversationStepRecord['chooserKind'];
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

  // --- the §2 format registry (STUDIO-002 — migration 068) ---

  /** Inserts one registry version row BORN DRAFT (the DB born-draft fence backstops this). */
  async insertFormatVersion(input: InsertFormatVersionInput): Promise<FormatRow> {
    const r = await this.db.query<FormatRow>(
      `INSERT INTO studio_formats
         (format_version_id, format_id, format_version, agency_id, client_id, workspace_id,
          status, declaration, contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7::jsonb, $8, $9::timestamptz, $9::timestamptz)
       RETURNING *`,
      [
        input.formatVersionId,
        input.formatId,
        input.formatVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        JSON.stringify(input.declaration),
        CONTENT_STUDIO_FORMAT_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  /** Inserts one append-only format-capability link record (the normalized declared requiredCapabilities). */
  async insertFormatCapabilityLink(input: InsertFormatCapabilityLinkInput): Promise<FormatCapabilityLinkRow> {
    const r = await this.db.query<FormatCapabilityLinkRow>(
      `INSERT INTO studio_format_capabilities
         (format_version_id, capability_kind, capability_reference,
          agency_id, client_id, workspace_id, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       RETURNING *`,
      [
        input.formatVersionId,
        input.capabilityKind,
        input.capabilityReference,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        CONTENT_STUDIO_FORMAT_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async findFormatVersion(clientId: string, formatId: string, formatVersion: number): Promise<FormatRow | null> {
    const r = await this.db.query<FormatRow>(
      `SELECT * FROM studio_formats
        WHERE client_id = $1 AND format_id = $2 AND format_version = $3`,
      [clientId, formatId, formatVersion],
    );
    return r.rows[0] ?? null;
  }

  async listFormatVersions(clientId: string): Promise<ReadonlyArray<FormatRow>> {
    const r = await this.db.query<FormatRow>(
      `SELECT * FROM studio_formats
        WHERE client_id = $1
        ORDER BY format_id ASC, format_version ASC`,
      [clientId],
    );
    return r.rows;
  }

  async listFormatCapabilityLinks(clientId: string, formatVersionId?: string): Promise<ReadonlyArray<FormatCapabilityLinkRow>> {
    const r = await this.db.query<FormatCapabilityLinkRow>(
      `SELECT * FROM studio_format_capabilities
        WHERE client_id = $1 AND ($2::uuid IS NULL OR format_version_id = $2::uuid)
        ORDER BY format_version_id ASC, capability_reference ASC`,
      [clientId, formatVersionId ?? null],
    );
    return r.rows;
  }

  /**
   * The guarded lifecycle advance (draft → active → retired): a CAS
   * update over the exact from-status — the DB guard trigger is the
   * authority (the legal-edge table + the identity freeze + the
   * activation capability-consistency check); the CAS is the honest
   * concurrency surface. Returns null when the row moved on.
   */
  async advanceFormatStatus(input: AdvanceFormatStatusInput): Promise<FormatRow | null> {
    const r = await this.db.query<FormatRow>(
      `UPDATE studio_formats
          SET status = $1, updated_at = $2::timestamptz
        WHERE format_version_id = $3 AND status = $4
        RETURNING *`,
      [input.to, this.nowIso(), input.formatVersionId, input.from],
    );
    return r.rows[0] ?? null;
  }

  // --- the §8 INTENT-TO-SCRIPT tables (STUDIO-003 — migration 070) ---

  async insertIntent(input: InsertIntentInput): Promise<IntentRow> {
    const r = await this.db.query<IntentRow>(
      `INSERT INTO studio_intents
         (intent_id, agency_id, client_id, workspace_id,
          request_id, request_version, objective, source_references,
          contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz)
       RETURNING *`,
      [
        input.intentId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.requestId,
        input.requestVersion,
        input.objective,
        JSON.stringify(input.sourceReferences),
        CONTENT_STUDIO_SCRIPT_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async findIntent(clientId: string, intentId: string): Promise<IntentRow | null> {
    const r = await this.db.query<IntentRow>(
      `SELECT * FROM studio_intents WHERE client_id = $1 AND intent_id = $2`,
      [clientId, intentId],
    );
    return r.rows[0] ?? null;
  }

  async findIntentForRequest(clientId: string, requestId: string, requestVersion: number): Promise<IntentRow | null> {
    const r = await this.db.query<IntentRow>(
      `SELECT * FROM studio_intents
        WHERE client_id = $1 AND request_id = $2 AND request_version = $3`,
      [clientId, requestId, requestVersion],
    );
    return r.rows[0] ?? null;
  }

  async insertScriptVersion(input: InsertScriptVersionInput): Promise<ScriptRow> {
    const now = this.nowIso();
    const r = await this.db.query<ScriptRow>(
      `INSERT INTO studio_scripts
         (script_id, script_version, agency_id, client_id, workspace_id,
          request_id, request_version, origin, body,
          intent_id, generator_organization, generator_model_references, review_state,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14, $15::timestamptz, $15::timestamptz)
       RETURNING *`,
      [
        input.scriptId,
        input.scriptVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.requestId,
        input.requestVersion,
        input.origin,
        JSON.stringify(input.body),
        input.intentId ?? null,
        input.generator === undefined ? null : JSON.stringify(input.generator.organization),
        input.generator === undefined ? null : JSON.stringify(input.generator.modelReferences),
        input.origin === 'generated' ? 'pending' : null,
        CONTENT_STUDIO_SCRIPT_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findScriptVersion(clientId: string, scriptId: string, scriptVersion: number): Promise<ScriptRow | null> {
    const r = await this.db.query<ScriptRow>(
      `SELECT * FROM studio_scripts
        WHERE client_id = $1 AND script_id = $2 AND script_version = $3`,
      [clientId, scriptId, scriptVersion],
    );
    return r.rows[0] ?? null;
  }

  async findLatestScriptVersion(clientId: string, scriptId: string): Promise<ScriptRow | null> {
    const r = await this.db.query<ScriptRow>(
      `SELECT * FROM studio_scripts
        WHERE client_id = $1 AND script_id = $2
        ORDER BY script_version DESC LIMIT 1`,
      [clientId, scriptId],
    );
    return r.rows[0] ?? null;
  }

  async findLatestScriptForRequest(clientId: string, requestId: string, requestVersion: number): Promise<ScriptRow | null> {
    // The one-materialization fence guarantees at most ONE chain per
    // (request, request version); the latest version of that chain.
    const r = await this.db.query<ScriptRow>(
      `SELECT * FROM studio_scripts
        WHERE client_id = $1 AND request_id = $2 AND request_version = $3
        ORDER BY script_version DESC LIMIT 1`,
      [clientId, requestId, requestVersion],
    );
    return r.rows[0] ?? null;
  }

  async listScriptVersions(clientId: string, scriptId: string): Promise<ReadonlyArray<ScriptRow>> {
    const r = await this.db.query<ScriptRow>(
      `SELECT * FROM studio_scripts
        WHERE client_id = $1 AND script_id = $2
        ORDER BY script_version ASC`,
      [clientId, scriptId],
    );
    return r.rows;
  }

  /**
   * The guarded review-state advance: a CAS update over the exact
   * from-state — the DB guard trigger is the authority (the legal-edge
   * table + the decision-record backing); the CAS is the honest
   * concurrency surface. Returns null when the row moved on.
   */
  async advanceScriptReviewState(input: AdvanceScriptReviewStateInput): Promise<ScriptRow | null> {
    const r = await this.db.query<ScriptRow>(
      `UPDATE studio_scripts
          SET review_state = $4, updated_at = $5::timestamptz
        WHERE client_id = $1 AND script_id = $2 AND script_version = $3 AND review_state = $6
        RETURNING *`,
      [input.clientId, input.scriptId, input.scriptVersion, input.to, this.nowIso(), input.from],
    );
    return r.rows[0] ?? null;
  }

  async insertScriptReview(input: InsertScriptReviewInput): Promise<ScriptReviewRow> {
    const now = this.nowIso();
    const r = await this.db.query<ScriptReviewRow>(
      `INSERT INTO studio_script_reviews
         (review_id, script_id, script_version, agency_id, client_id, workspace_id,
          verdict, reviewer_kind, reviewer_actor, note, decided_at,
          contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)
       RETURNING *`,
      [
        input.reviewId,
        input.scriptId,
        input.scriptVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.verdict,
        input.reviewerKind,
        input.reviewerActor,
        input.note ?? null,
        now,
        CONTENT_STUDIO_SCRIPT_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listScriptReviews(clientId: string, scriptId: string): Promise<ReadonlyArray<ScriptReviewRow>> {
    const r = await this.db.query<ScriptReviewRow>(
      `SELECT * FROM studio_script_reviews
        WHERE client_id = $1 AND script_id = $2
        ORDER BY created_at ASC, review_id ASC`,
      [clientId, scriptId],
    );
    return r.rows;
  }

  async insertQuestionGraphVersion(input: InsertQuestionGraphVersionInput): Promise<QuestionGraphRow> {
    const now = this.nowIso();
    const r = await this.db.query<QuestionGraphRow>(
      `INSERT INTO studio_question_graphs
         (graph_id, graph_version, agency_id, client_id, workspace_id,
          request_id, request_version, origin, declared_graph,
          intent_id, generator_organization, generator_model_references, review_state,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13, $14, $15::timestamptz, $15::timestamptz)
       RETURNING *`,
      [
        input.graphId,
        input.graphVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.requestId,
        input.requestVersion,
        input.origin,
        JSON.stringify(input.declaredGraph),
        input.intentId ?? null,
        input.generator === undefined ? null : JSON.stringify(input.generator.organization),
        input.generator === undefined ? null : JSON.stringify(input.generator.modelReferences),
        input.origin === 'generated' ? 'pending' : null,
        CONTENT_STUDIO_SCRIPT_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findQuestionGraphVersion(clientId: string, graphId: string, graphVersion: number): Promise<QuestionGraphRow | null> {
    const r = await this.db.query<QuestionGraphRow>(
      `SELECT * FROM studio_question_graphs
        WHERE client_id = $1 AND graph_id = $2 AND graph_version = $3`,
      [clientId, graphId, graphVersion],
    );
    return r.rows[0] ?? null;
  }

  async findLatestQuestionGraphVersion(clientId: string, graphId: string): Promise<QuestionGraphRow | null> {
    const r = await this.db.query<QuestionGraphRow>(
      `SELECT * FROM studio_question_graphs
        WHERE client_id = $1 AND graph_id = $2
        ORDER BY graph_version DESC LIMIT 1`,
      [clientId, graphId],
    );
    return r.rows[0] ?? null;
  }

  async findLatestQuestionGraphForRequest(clientId: string, requestId: string, requestVersion: number): Promise<QuestionGraphRow | null> {
    const r = await this.db.query<QuestionGraphRow>(
      `SELECT * FROM studio_question_graphs
        WHERE client_id = $1 AND request_id = $2 AND request_version = $3
        ORDER BY graph_version DESC LIMIT 1`,
      [clientId, requestId, requestVersion],
    );
    return r.rows[0] ?? null;
  }

  async listQuestionGraphVersions(clientId: string, graphId: string): Promise<ReadonlyArray<QuestionGraphRow>> {
    const r = await this.db.query<QuestionGraphRow>(
      `SELECT * FROM studio_question_graphs
        WHERE client_id = $1 AND graph_id = $2
        ORDER BY graph_version ASC`,
      [clientId, graphId],
    );
    return r.rows;
  }

  /** The guarded review-state advance (the script precedent — CAS over the exact from-state). */
  async advanceQuestionGraphReviewState(input: AdvanceQuestionGraphReviewStateInput): Promise<QuestionGraphRow | null> {
    const r = await this.db.query<QuestionGraphRow>(
      `UPDATE studio_question_graphs
          SET review_state = $4, updated_at = $5::timestamptz
        WHERE client_id = $1 AND graph_id = $2 AND graph_version = $3 AND review_state = $6
        RETURNING *`,
      [input.clientId, input.graphId, input.graphVersion, input.to, this.nowIso(), input.from],
    );
    return r.rows[0] ?? null;
  }

  async insertQuestionGraphReview(input: InsertQuestionGraphReviewInput): Promise<QuestionGraphReviewRow> {
    const now = this.nowIso();
    const r = await this.db.query<QuestionGraphReviewRow>(
      `INSERT INTO studio_question_graph_reviews
         (review_id, graph_id, graph_version, agency_id, client_id, workspace_id,
          verdict, reviewer_kind, reviewer_actor, note, decided_at,
          contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)
       RETURNING *`,
      [
        input.reviewId,
        input.graphId,
        input.graphVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.verdict,
        input.reviewerKind,
        input.reviewerActor,
        input.note ?? null,
        now,
        CONTENT_STUDIO_SCRIPT_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listQuestionGraphReviews(clientId: string, graphId: string): Promise<ReadonlyArray<QuestionGraphReviewRow>> {
    const r = await this.db.query<QuestionGraphReviewRow>(
      `SELECT * FROM studio_question_graph_reviews
        WHERE client_id = $1 AND graph_id = $2
        ORDER BY created_at ASC, review_id ASC`,
      [clientId, graphId],
    );
    return r.rows;
  }

  async insertConversationEdge(input: InsertConversationEdgeInput): Promise<ConversationEdgeRow> {
    const r = await this.db.query<ConversationEdgeRow>(
      `INSERT INTO studio_conversation_edges
         (conversation_id, session_id, revision, agency_id, client_id, workspace_id,
          seq, graph_id, graph_version, question_id, answer_reference, answer_kind,
          chosen_to_question_id, chosen_condition, chooser_kind,
          contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::timestamptz)
       RETURNING *`,
      [
        input.conversationId,
        input.sessionId,
        input.revision,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.seq,
        input.graphId,
        input.graphVersion,
        input.questionId,
        input.answerReference,
        input.answerKind,
        input.chosenToQuestionId ?? null,
        input.chosenCondition ?? null,
        input.chooserKind,
        CONTENT_STUDIO_SCRIPT_CONTRACT_VERSION,
        this.nowIso(),
      ],
    );
    return r.rows[0]!;
  }

  async listSessionConversationEdges(clientId: string, sessionId: string): Promise<ReadonlyArray<ConversationEdgeRow>> {
    const r = await this.db.query<ConversationEdgeRow>(
      `SELECT * FROM studio_conversation_edges
        WHERE client_id = $1 AND session_id = $2
        ORDER BY conversation_id ASC, seq ASC`,
      [clientId, sessionId],
    );
    return r.rows;
  }

  async listConversationEdges(clientId: string, conversationId: string): Promise<ReadonlyArray<ConversationEdgeRow>> {
    const r = await this.db.query<ConversationEdgeRow>(
      `SELECT * FROM studio_conversation_edges
        WHERE client_id = $1 AND conversation_id = $2
        ORDER BY seq ASC`,
      [clientId, conversationId],
    );
    return r.rows;
  }

  async maxConversationSeq(clientId: string, conversationId: string): Promise<number> {
    const r = await this.db.query<{ max_seq: number | string | null }>(
      `SELECT MAX(seq) AS max_seq FROM studio_conversation_edges
        WHERE client_id = $1 AND conversation_id = $2`,
      [clientId, conversationId],
    );
    const current = r.rows[0]?.max_seq;
    return current === null || current === undefined ? 0 : Number(current);
  }

  // ---------------------------------------------------------------------------
  // The migration-073 capture tables (STUDIO-007 — the audio/video
  // capture layer): the capture sessions + the append-only raw takes.
  // ---------------------------------------------------------------------------

  async insertCaptureSession(input: InsertCaptureSessionInput): Promise<CaptureSessionRow> {
    const now = this.nowIso();
    const r = await this.db.query<CaptureSessionRow>(
      `INSERT INTO studio_capture_sessions
         (capture_session_id, session_id, revision, agency_id, client_id, workspace_id,
          capture_mode, graph_id, graph_version, interviewer_representation,
          contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)
       RETURNING *`,
      [
        input.captureSessionId,
        input.sessionId,
        input.revision,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.captureMode,
        input.graphId,
        input.graphVersion,
        input.interviewerRepresentation ?? null,
        CONTENT_STUDIO_CAPTURE_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findCaptureSession(clientId: string, captureSessionId: string): Promise<CaptureSessionRow | null> {
    const r = await this.db.query<CaptureSessionRow>(
      `SELECT * FROM studio_capture_sessions
        WHERE client_id = $1 AND capture_session_id = $2`,
      [clientId, captureSessionId],
    );
    return r.rows[0] ?? null;
  }

  async listCaptureSessions(clientId: string, sessionId: string): Promise<ReadonlyArray<CaptureSessionRow>> {
    const r = await this.db.query<CaptureSessionRow>(
      `SELECT * FROM studio_capture_sessions
        WHERE client_id = $1 AND session_id = $2
        ORDER BY created_at ASC, capture_session_id ASC`,
      [clientId, sessionId],
    );
    return r.rows;
  }

  async insertCaptureTake(input: InsertCaptureTakeInput): Promise<CaptureTakeRow> {
    const now = this.nowIso();
    const r = await this.db.query<CaptureTakeRow>(
      `INSERT INTO studio_capture_takes
         (take_id, take_reference, capture_session_id, session_id, revision,
          agency_id, client_id, workspace_id, graph_id, graph_version, question_id,
          modality, alternate_of_take_id, input_kind, device_label, source_metadata,
          participant_reference, participant_grant_reference, consent_references,
          interviewer_representation, object_key, object_digest, object_size, content_type,
          ingest_state, contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16::jsonb, $17, $18, $19::jsonb, $20, $21, $22, $23, $24,
               'processing', $25, $26::timestamptz, $26::timestamptz)
       RETURNING *`,
      [
        input.takeId,
        input.takeReference,
        input.captureSessionId,
        input.sessionId,
        input.revision,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.graphId,
        input.graphVersion,
        input.questionId,
        input.modality,
        input.alternateOfTakeId ?? null,
        input.inputKind,
        input.deviceLabel,
        JSON.stringify(input.sourceMetadata),
        input.participantReference,
        input.participantGrantReference ?? null,
        JSON.stringify(input.consentReferences),
        input.interviewerRepresentation ?? null,
        input.objectKey,
        input.objectDigest,
        input.objectSize,
        input.contentType,
        CONTENT_STUDIO_CAPTURE_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findCaptureTake(clientId: string, takeId: string): Promise<CaptureTakeRow | null> {
    const r = await this.db.query<CaptureTakeRow>(
      `SELECT * FROM studio_capture_takes
        WHERE client_id = $1 AND take_id = $2`,
      [clientId, takeId],
    );
    return r.rows[0] ?? null;
  }

  async findCaptureTakeByReference(clientId: string, takeReference: string): Promise<CaptureTakeRow | null> {
    const r = await this.db.query<CaptureTakeRow>(
      `SELECT * FROM studio_capture_takes
        WHERE client_id = $1 AND take_reference = $2`,
      [clientId, takeReference],
    );
    return r.rows[0] ?? null;
  }

  async listCaptureTakes(clientId: string, query: {
    readonly sessionId: string;
    readonly captureSessionId?: string | null;
    readonly questionId?: string | null;
    readonly modality?: string | null;
    readonly alternateOfTakeId?: string | null;
  }): Promise<ReadonlyArray<CaptureTakeRow>> {
    const filters: string[] = ['client_id = $1', 'session_id = $2'];
    const params: QueryParam[] = [clientId, query.sessionId];
    if (query.captureSessionId !== undefined && query.captureSessionId !== null) {
      params.push(query.captureSessionId);
      filters.push(`capture_session_id = $${params.length}`);
    }
    if (query.questionId !== undefined && query.questionId !== null) {
      params.push(query.questionId);
      filters.push(`question_id = $${params.length}`);
    }
    if (query.modality !== undefined && query.modality !== null) {
      params.push(query.modality);
      filters.push(`modality = $${params.length}`);
    }
    if (query.alternateOfTakeId !== undefined && query.alternateOfTakeId !== null) {
      params.push(query.alternateOfTakeId);
      filters.push(`alternate_of_take_id = $${params.length}`);
    }
    const r = await this.db.query<CaptureTakeRow>(
      `SELECT * FROM studio_capture_takes
        WHERE ${filters.join(' AND ')}
        ORDER BY created_at ASC, take_id ASC`,
      params,
    );
    return r.rows;
  }

  async advanceCaptureTakeIngest(input: {
    readonly clientId: string;
    readonly takeId: string;
    readonly to: 'stored' | 'failed';
    readonly analysis: Readonly<Record<string, unknown>> | null;
    readonly failureReason: string | null;
    readonly failureDetail: string | null;
    readonly durationMs: number | null;
  }): Promise<CaptureTakeRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<CaptureTakeRow>(
      `UPDATE studio_capture_takes
          SET ingest_state = $3,
              ingest_analysis = $4::jsonb,
              ingest_failure_reason = $5,
              ingest_failure_detail = $6,
              ingest_duration_ms = $7,
              ingest_completed_at = $8::timestamptz,
              updated_at = $8::timestamptz
        WHERE client_id = $1 AND take_id = $2 AND ingest_state = 'processing'
        RETURNING *`,
      [
        input.clientId,
        input.takeId,
        input.to,
        input.analysis === null ? null : JSON.stringify(input.analysis),
        input.failureReason,
        input.failureDetail,
        input.durationMs,
        now,
      ],
    );
    return r.rows[0] ?? null;
  }
}

export interface InsertCaptureSessionInput {
  readonly captureSessionId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly scope: ContentStudioScope;
  readonly captureMode: 'graph_walk' | 'session_direct';
  readonly graphId: string | null;
  readonly graphVersion: number | null;
  readonly interviewerRepresentation?: string | null;
}

export interface InsertCaptureTakeInput {
  readonly takeId: string;
  readonly takeReference: string;
  readonly captureSessionId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly scope: ContentStudioScope;
  readonly graphId: string | null;
  readonly graphVersion: number | null;
  readonly questionId: string | null;
  readonly modality: 'audio' | 'video' | 'screen';
  readonly alternateOfTakeId?: string | null;
  readonly inputKind: string;
  readonly deviceLabel: string;
  readonly sourceMetadata: Readonly<Record<string, unknown>>;
  readonly participantReference: string;
  readonly participantGrantReference?: string | null;
  readonly consentReferences: ReadonlyArray<string>;
  readonly interviewerRepresentation?: string | null;
  readonly objectKey: string;
  readonly objectDigest: string;
  readonly objectSize: number;
  readonly contentType: string;
}
