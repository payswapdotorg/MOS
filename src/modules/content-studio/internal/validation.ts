/**
 * /content-studio pure contract guards (STUDIO-001 — the migration-064
 * discipline's module-side surface).
 *
 * Every guard here is a PURE function: no clock, no randomness, no
 * network, no database. The migration-064 CHECK fences and guard
 * triggers are the DB backstop of exactly these rules (defense in
 * depth — the honest error surface here, the structural authority
 * there).
 *
 * The frozen surfaces:
 *   1. THE §5 STATE MACHINE — the legal-edge table over the verbatim
 *      session lifecycle vocabulary. No implicit jumps: a transition
 *      is legal only as an explicit edge in this table, and terminal
 *      revisions have NO outgoing edges (treatment_requested included
 *      — a treatment continues through a NEW linked revision).
 *   2. THE §2 FORMAT SEAM — the declaration discipline every plugged
 *      format must satisfy (identity/version, input requirements,
 *      participant model, capture requirements, interviewer
 *      requirements, organization compatibility requirements, output
 *      artifact contract, provenance/consent requirements, evaluation
 *      hooks, processing stages). A future format is a new
 *      declaration through this seam — never a runtime change.
 *   3. THE §3 REQUEST FENCES — the immutable request content
 *      discipline: the standalone/lab_initiated entry-mode fence, the
 *      input-mode consistency, the budget/deadline/stopping bounds,
 *      the output contract shape.
 *   4. THE §4 ORGANIZATION FENCE — the submitted organization
 *      declaration discipline (versioned, opaque body references).
 *   5. THE §13 TREATMENT GUARDS — the structured treatment shape.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type {
  ContentStudioEntryMode,
  ContentStudioFormatDeclaration,
  ContentStudioInputMode,
  ContentStudioOrganizationDeclaration,
  ContentStudioProductionRequestContent,
  ContentStudioSessionState,
  ContentStudioTerminalReason,
  ContentStudioTerminalSessionState,
  ContentStudioTreatmentSpecification,
} from '../public.ts';
import {
  CONTENT_STUDIO_CAPTURE_MODALITIES,
  CONTENT_STUDIO_CONSENT_KINDS,
  CONTENT_STUDIO_ENTRY_MODES,
  CONTENT_STUDIO_EVALUATION_HOOK_SURFACES,
  CONTENT_STUDIO_FORMAT_AVAILABILITY_STATES,
  CONTENT_STUDIO_INPUT_MODES,
  CONTENT_STUDIO_INTERVIEWER_FOLLOW_UP_MODES,
  CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS,
  CONTENT_STUDIO_ORGANIZATION_PERMISSIONS,
  CONTENT_STUDIO_OUTPUT_ARTIFACT_KINDS,
  CONTENT_STUDIO_PARTICIPATION_GRANT_MODELS,
  CONTENT_STUDIO_PROVENANCE_ELEMENTS,
  CONTENT_STUDIO_SESSION_STATES,
  CONTENT_STUDIO_TERMINAL_SESSION_STATES,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Shared bounded-string / shape helpers
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** The opaque /lab-agent-body version-reference format (`<bodyId>#v<version>`). */
const BODY_REFERENCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#v[1-9][0-9]{0,3}$/;
const MAX_PAYLOAD_VALUE_BYTES = 65_536;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedTrimmedString(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max && value.trim() === value;
}

function assertBoundedStringArray(value: unknown, maxEntries: number, maxChars: number, label: string): asserts value is ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new InvalidRequestError(`${label} must be an array of strings`);
  }
  if (value.length > maxEntries) {
    throw new InvalidRequestError(`${label} must hold at most ${maxEntries} entries`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > maxChars) {
      throw new InvalidRequestError(`${label} entries must be strings of 1-${maxChars} chars`);
    }
    if (seen.has(entry)) {
      throw new InvalidRequestError(`${label} entry '${entry.slice(0, 40)}' is duplicated`);
    }
    seen.add(entry);
  }
}

/** Asserts the payload bound (JSON-serializable + the byte ceiling) on a declared jsonb surface. */
function assertBoundedJson(value: unknown, label: string): void {
  if (!isPlainObject(value)) {
    throw new InvalidRequestError(`${label} must be an object`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new InvalidRequestError(`${label} is not JSON-serializable`);
  }
  if (serialized.length > MAX_PAYLOAD_VALUE_BYTES) {
    throw new InvalidRequestError(`${label} exceeds the ${MAX_PAYLOAD_VALUE_BYTES}-byte declared-data bound`);
  }
}

// ---------------------------------------------------------------------------
// 1. THE §5 STATE MACHINE (the frozen legal-edge table)
// ---------------------------------------------------------------------------

/**
 * The frozen §5 legal-transition table: the ONLY edges a session
 * revision may ever take. Derived from the contract's canonical
 * production flows:
 *   created → preparing (the session begins work);
 *   preparing → awaiting_participant | recording | processing
 *     (the production shape the caller drives — a fully autonomous
 *     production needs no participant; a capture-first production
 *     records before processing);
 *   awaiting_participant → recording (the participant joined);
 *   recording → processing (capture complete → the durable work);
 *   processing → review (ALL durable steps succeeded + the output
 *     version recorded — the runtime guard);
 *   review → treatment_requested | completed (the governing caller's
 *     decision — §13/§14);
 *   cancelled | failed | expired reachable from EVERY non-terminal
 *     state (honest abandonment, honest failure, honest deadline —
 *     §17: the economic choice to wait/substitute/abandon is the
 *     CALLER's, never implicit here).
 * Terminal revisions (treatment_requested, completed, cancelled,
 * failed, expired) have NO outgoing edges — a retry/treatment opens a
 * NEW linked revision (§5).
 */
export const CONTENT_STUDIO_SESSION_TRANSITIONS: Readonly<Record<ContentStudioSessionState, ReadonlyArray<ContentStudioSessionState>>> = {
  created: ['preparing', 'cancelled', 'failed', 'expired'],
  preparing: ['awaiting_participant', 'recording', 'processing', 'cancelled', 'failed', 'expired'],
  awaiting_participant: ['recording', 'cancelled', 'failed', 'expired'],
  recording: ['processing', 'cancelled', 'failed', 'expired'],
  processing: ['review', 'cancelled', 'failed', 'expired'],
  review: ['treatment_requested', 'completed', 'cancelled', 'failed', 'expired'],
  treatment_requested: [],
  completed: [],
  cancelled: [],
  failed: [],
  expired: [],
};

/** Whether a session state is terminal (frozen forever — no outgoing edges). */
export function isTerminalContentStudioSessionState(state: ContentStudioSessionState): state is ContentStudioTerminalSessionState {
  return CONTENT_STUDIO_TERMINAL_SESSION_STATES.includes(state as ContentStudioTerminalSessionState);
}

/** Whether a from→to edge is in the frozen legal-transition table (the single transition authority). */
export function isLegalContentStudioSessionTransition(from: ContentStudioSessionState, to: ContentStudioSessionState): boolean {
  return CONTENT_STUDIO_SESSION_TRANSITIONS[from]!.includes(to);
}

/** The frozen table as (from, to) pairs — the exhaustive unit-test surface. */
export function legalContentStudioSessionTransitions(): ReadonlyArray<{ readonly from: ContentStudioSessionState; readonly to: ContentStudioSessionState }> {
  const pairs: Array<{ from: ContentStudioSessionState; to: ContentStudioSessionState }> = [];
  for (const from of CONTENT_STUDIO_SESSION_STATES) {
    for (const to of CONTENT_STUDIO_SESSION_TRANSITIONS[from]!) {
      pairs.push({ from, to });
    }
  }
  return pairs;
}

/** The guarded transition assert (the module + the unit tests call this before any DB advance). */
export function assertLegalContentStudioSessionTransition(from: ContentStudioSessionState, to: ContentStudioSessionState): void {
  if (from === to) {
    throw new InvalidRequestError(`studio session is already in state '${from}' — a transition must move`);
  }
  if (isTerminalContentStudioSessionState(from)) {
    throw new InvalidRequestError(`studio session state '${from}' is terminal — terminal revisions are frozen (a retry/treatment opens a NEW linked revision)`);
  }
  if (!isLegalContentStudioSessionTransition(from, to)) {
    throw new InvalidRequestError(`studio session transition '${from}' → '${to}' is not legal (the frozen §5 lifecycle table)`);
  }
}

// ---------------------------------------------------------------------------
// 2. THE §2 FORMAT SEAM (the full nine-surface declaration discipline —
//    STUDIO-002: every surface is closed-vocabulary-backed declared
//    data; the migration-068 CHECK fences are the DB backstop of
//    exactly these rules)
// ---------------------------------------------------------------------------

/** §2 surface 2 — the input requirements (closed input-mode vocabulary + the source-artifact fence). */
function assertFormatInputRequirements(format: ContentStudioFormatDeclaration): void {
  const requirements = format.inputRequirements;
  if (!isPlainObject(requirements)) {
    throw new InvalidRequestError(`format '${format.formatId}' inputRequirements must be an object`);
  }
  if (!Array.isArray(requirements.modes) || requirements.modes.length < 1 || requirements.modes.length > CONTENT_STUDIO_INPUT_MODES.length) {
    throw new InvalidRequestError(`format '${format.formatId}' inputRequirements.modes must be a non-empty subset of the input-mode vocabulary`);
  }
  const seen = new Set<string>();
  for (const mode of requirements.modes) {
    if (!CONTENT_STUDIO_INPUT_MODES.includes(mode as ContentStudioInputMode)) {
      throw new InvalidRequestError(`format '${format.formatId}' inputRequirements.modes entry '${String(mode)}' is not in the closed input-mode vocabulary`);
    }
    if (seen.has(mode)) {
      throw new InvalidRequestError(`format '${format.formatId}' inputRequirements.modes entry '${String(mode)}' is duplicated`);
    }
    seen.add(mode);
  }
  if (requirements.sourceArtifacts !== 'required' && requirements.sourceArtifacts !== 'optional') {
    throw new InvalidRequestError(`format '${format.formatId}' inputRequirements.sourceArtifacts must be 'required' or 'optional'`);
  }
}

/** §2 surface 3 — the participant model (the §6/§7 range + grant pairing). */
function assertFormatParticipantModel(format: ContentStudioFormatDeclaration): void {
  const model = format.participantModel;
  if (!isPlainObject(model)) {
    throw new InvalidRequestError(`format '${format.formatId}' participantModel must be an object`);
  }
  if (!isPlainObject(model.participants)) {
    throw new InvalidRequestError(`format '${format.formatId}' participantModel.participants must be { min, max }`);
  }
  const { min, max } = model.participants as { min?: unknown; max?: unknown };
  if (typeof min !== 'number' || !Number.isSafeInteger(min) || min < 1 || min > 16) {
    throw new InvalidRequestError(`format '${format.formatId}' participantModel.participants.min must be an integer 1-16`);
  }
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > 16) {
    throw new InvalidRequestError(`format '${format.formatId}' participantModel.participants.max must be an integer 1-16`);
  }
  if (min > max) {
    throw new InvalidRequestError(`format '${format.formatId}' participantModel.participants requires min ≤ max`);
  }
  if (model.humanCapture !== 'required' && model.humanCapture !== 'optional') {
    throw new InvalidRequestError(`format '${format.formatId}' participantModel.humanCapture must be 'required' or 'optional'`);
  }
  if (!CONTENT_STUDIO_PARTICIPATION_GRANT_MODELS.includes(model.participationGrants as never)) {
    throw new InvalidRequestError(
      `format '${format.formatId}' participantModel.participationGrants must be one of ${CONTENT_STUDIO_PARTICIPATION_GRANT_MODELS.join(', ')}`,
    );
  }
  // The §6/§7 pairing fence: a multi-person-capable format (max > 1)
  // MUST declare the §7 explicit per-participant grants; a
  // single-person format (max = 1) MUST declare the §6 single scope.
  if (max > 1 && model.participationGrants !== 'explicit_grant_per_participant') {
    throw new InvalidRequestError(
      `format '${format.formatId}' participantModel: a format supporting ${max} participants must declare participationGrants 'explicit_grant_per_participant' (§7 — every participant joins through an explicit participation grant)`,
    );
  }
  if (max === 1 && model.participationGrants !== 'single_scope') {
    throw new InvalidRequestError(
      `format '${format.formatId}' participantModel: a single-person format (max = 1) must declare participationGrants 'single_scope' (§6)`,
    );
  }
}

/** §2 surface 4 — the capture requirements (closed capture-modality vocabulary). */
function assertFormatCaptureRequirements(format: ContentStudioFormatDeclaration): void {
  const requirements = format.captureRequirements;
  if (!isPlainObject(requirements)) {
    throw new InvalidRequestError(`format '${format.formatId}' captureRequirements must be an object`);
  }
  if (!Array.isArray(requirements.modalities) || requirements.modalities.length < 1 || requirements.modalities.length > CONTENT_STUDIO_CAPTURE_MODALITIES.length) {
    throw new InvalidRequestError(`format '${format.formatId}' captureRequirements.modalities must be a non-empty subset of the capture-modality vocabulary`);
  }
  const seen = new Set<string>();
  for (const modality of requirements.modalities) {
    if (!CONTENT_STUDIO_CAPTURE_MODALITIES.includes(modality as never)) {
      throw new InvalidRequestError(`format '${format.formatId}' captureRequirements.modalities entry '${String(modality)}' is not in the closed capture-modality vocabulary`);
    }
    if (seen.has(modality)) {
      throw new InvalidRequestError(`format '${format.formatId}' captureRequirements.modalities entry '${String(modality)}' is duplicated`);
    }
    seen.add(modality);
  }
}

/** §2 surface 5 — the interviewer requirements (closed representation vocabulary + the §6 follow-up discipline). */
function assertFormatInterviewerRequirements(format: ContentStudioFormatDeclaration): void {
  const requirements = format.interviewerRequirements;
  if (!isPlainObject(requirements)) {
    throw new InvalidRequestError(`format '${format.formatId}' interviewerRequirements must be an object`);
  }
  if (requirements.interviewer !== 'none' && requirements.interviewer !== 'representation') {
    throw new InvalidRequestError(`format '${format.formatId}' interviewerRequirements.interviewer must be 'none' or 'representation'`);
  }
  if (requirements.interviewer === 'representation') {
    if (!Array.isArray(requirements.representations) || requirements.representations.length < 1 || requirements.representations.length > CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS.length) {
      throw new InvalidRequestError(`format '${format.formatId}' interviewerRequirements.representations must be a non-empty subset of the interviewer-representation vocabulary`);
    }
    const seen = new Set<string>();
    for (const representation of requirements.representations) {
      if (!CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS.includes(representation as never)) {
        throw new InvalidRequestError(`format '${format.formatId}' interviewerRequirements.representations entry '${String(representation)}' is not in the closed interviewer-representation vocabulary`);
      }
      if (seen.has(representation)) {
        throw new InvalidRequestError(`format '${format.formatId}' interviewerRequirements.representations entry '${String(representation)}' is duplicated`);
      }
      seen.add(representation);
    }
    if (!CONTENT_STUDIO_INTERVIEWER_FOLLOW_UP_MODES.includes(requirements.followUps as never)) {
      throw new InvalidRequestError(
        `format '${format.formatId}' interviewerRequirements.followUps must be one of ${CONTENT_STUDIO_INTERVIEWER_FOLLOW_UP_MODES.join(', ')} when interviewer is 'representation'`,
      );
    }
  } else {
    if (requirements.representations !== undefined) {
      throw new InvalidRequestError(`format '${format.formatId}' interviewerRequirements.representations must be absent when interviewer is 'none'`);
    }
    if (requirements.followUps !== undefined) {
      throw new InvalidRequestError(`format '${format.formatId}' interviewerRequirements.followUps must be absent when interviewer is 'none'`);
    }
  }
}

/** §2 surface 6 — the organization compatibility requirements (the closed §14 permission set). */
function assertFormatOrganizationRequirements(format: ContentStudioFormatDeclaration): void {
  const requirements = format.organizationRequirements;
  if (!isPlainObject(requirements)) {
    throw new InvalidRequestError(`format '${format.formatId}' organizationRequirements must be an object`);
  }
  if (typeof requirements.minAgentBodies !== 'number' || !Number.isSafeInteger(requirements.minAgentBodies) || requirements.minAgentBodies < 1 || requirements.minAgentBodies > 32) {
    throw new InvalidRequestError(`format '${format.formatId}' organizationRequirements.minAgentBodies must be an integer 1-32`);
  }
  if (!Array.isArray(requirements.requiredPermissions) || requirements.requiredPermissions.length < 1 || requirements.requiredPermissions.length > CONTENT_STUDIO_ORGANIZATION_PERMISSIONS.length) {
    throw new InvalidRequestError(`format '${format.formatId}' organizationRequirements.requiredPermissions must be a non-empty subset of the closed action-kind vocabulary`);
  }
  const seen = new Set<string>();
  for (const permission of requirements.requiredPermissions) {
    if (!CONTENT_STUDIO_ORGANIZATION_PERMISSIONS.includes(permission as never)) {
      throw new InvalidRequestError(`format '${format.formatId}' organizationRequirements.requiredPermissions entry '${String(permission)}' is not in the closed action-kind vocabulary (read, analyze, compose, transform, communicate, simulate)`);
    }
    if (seen.has(permission)) {
      throw new InvalidRequestError(`format '${format.formatId}' organizationRequirements.requiredPermissions entry '${String(permission)}' is duplicated`);
    }
    seen.add(permission);
  }
  if (requirements.requiredCapabilities !== undefined && requirements.requiredCapabilities !== null) {
    assertBoundedStringArray(
      requirements.requiredCapabilities as unknown,
      32,
      256,
      `format '${format.formatId}' organizationRequirements.requiredCapabilities`,
    );
  }
}

/** §2 surface 7 — the output artifact contract (the closed §12 artifact-kind vocabulary). */
function assertFormatOutputContract(format: ContentStudioFormatDeclaration): void {
  const contract = format.outputContract;
  if (!isPlainObject(contract)) {
    throw new InvalidRequestError(`format '${format.formatId}' outputContract must be an object`);
  }
  if (!Array.isArray(contract.outputs) || contract.outputs.length < 1 || contract.outputs.length > CONTENT_STUDIO_OUTPUT_ARTIFACT_KINDS.length) {
    throw new InvalidRequestError(`format '${format.formatId}' outputContract.outputs must be a non-empty subset of the closed §12 artifact-kind vocabulary`);
  }
  const seen = new Set<string>();
  for (const output of contract.outputs) {
    if (!CONTENT_STUDIO_OUTPUT_ARTIFACT_KINDS.includes(output as never)) {
      throw new InvalidRequestError(`format '${format.formatId}' outputContract.outputs entry '${String(output)}' is not in the closed §12 artifact-kind vocabulary`);
    }
    if (seen.has(output)) {
      throw new InvalidRequestError(`format '${format.formatId}' outputContract.outputs entry '${String(output)}' is duplicated`);
    }
    seen.add(output);
  }
}

/** §2 surface 8 — the provenance/consent requirements (the closed consent/provenance vocabularies). */
function assertFormatProvenanceConsent(format: ContentStudioFormatDeclaration): void {
  const requirements = format.provenanceConsentRequirements;
  if (!isPlainObject(requirements)) {
    throw new InvalidRequestError(`format '${format.formatId}' provenanceConsentRequirements must be an object`);
  }
  if (!Array.isArray(requirements.consent) || requirements.consent.length > CONTENT_STUDIO_CONSENT_KINDS.length) {
    throw new InvalidRequestError(`format '${format.formatId}' provenanceConsentRequirements.consent must be a subset of the closed consent-kind vocabulary`);
  }
  const consentSeen = new Set<string>();
  for (const kind of requirements.consent) {
    if (!CONTENT_STUDIO_CONSENT_KINDS.includes(kind as never)) {
      throw new InvalidRequestError(`format '${format.formatId}' provenanceConsentRequirements.consent entry '${String(kind)}' is not in the closed consent-kind vocabulary`);
    }
    if (consentSeen.has(kind)) {
      throw new InvalidRequestError(`format '${format.formatId}' provenanceConsentRequirements.consent entry '${String(kind)}' is duplicated`);
    }
    consentSeen.add(kind);
  }
  if (!Array.isArray(requirements.provenance) || requirements.provenance.length > CONTENT_STUDIO_PROVENANCE_ELEMENTS.length) {
    throw new InvalidRequestError(`format '${format.formatId}' provenanceConsentRequirements.provenance must be a subset of the closed provenance-element vocabulary`);
  }
  const provenanceSeen = new Set<string>();
  for (const element of requirements.provenance) {
    if (!CONTENT_STUDIO_PROVENANCE_ELEMENTS.includes(element as never)) {
      throw new InvalidRequestError(`format '${format.formatId}' provenanceConsentRequirements.provenance entry '${String(element)}' is not in the closed provenance-element vocabulary`);
    }
    if (provenanceSeen.has(element)) {
      throw new InvalidRequestError(`format '${format.formatId}' provenanceConsentRequirements.provenance entry '${String(element)}' is duplicated`);
    }
    provenanceSeen.add(element);
  }
}

/**
 * §2 surface 9 — the evaluation hooks (the closed firing-surface
 * vocabulary; the stageId cross-reference fence runs in the main
 * guard once the stages are known).
 */
function assertFormatEvaluationHooks(format: ContentStudioFormatDeclaration): void {
  const hooks = format.evaluationHooks;
  if (!isPlainObject(hooks)) {
    throw new InvalidRequestError(`format '${format.formatId}' evaluationHooks must be an object`);
  }
  if (!Array.isArray(hooks.hooks) || hooks.hooks.length > 16) {
    throw new InvalidRequestError(`format '${format.formatId}' evaluationHooks.hooks must be an array of at most 16 declarations`);
  }
  const seen = new Set<string>();
  for (const hook of hooks.hooks) {
    if (!isPlainObject(hook) || typeof hook.hookId !== 'string' || !ID_PATTERN.test(hook.hookId)) {
      throw new InvalidRequestError(`format '${format.formatId}' evaluationHooks.hooks entries must be { hookId: 1-64 chars of [a-z0-9-] }`);
    }
    if (!CONTENT_STUDIO_EVALUATION_HOOK_SURFACES.includes(hook.firesOn as never)) {
      throw new InvalidRequestError(
        `format '${format.formatId}' evaluationHooks.hooks entry '${hook.hookId}' firesOn must be one of ${CONTENT_STUDIO_EVALUATION_HOOK_SURFACES.join(', ')}`,
      );
    }
    if (hook.firesOn === 'stage_completion') {
      if (typeof hook.stageId !== 'string' || !ID_PATTERN.test(hook.stageId)) {
        throw new InvalidRequestError(`format '${format.formatId}' evaluationHooks.hooks entry '${hook.hookId}' must declare stageId (a declared stage id) when firesOn is 'stage_completion'`);
      }
    } else if (hook.stageId !== undefined) {
      throw new InvalidRequestError(`format '${format.formatId}' evaluationHooks.hooks entry '${hook.hookId}' must NOT declare stageId when firesOn is '${hook.firesOn}'`);
    }
    if (seen.has(hook.hookId)) {
      throw new InvalidRequestError(`format '${format.formatId}' evaluationHooks.hooks hookId '${hook.hookId}' is duplicated`);
    }
    seen.add(hook.hookId);
  }
}

/**
 * The processing stages (the §9 durable plan derivation surface) with
 * the HONEST AVAILABILITY layer (the STUDIO-002 gap disclosure:
 * closed status vocabulary + the required awaitingModule citation).
 */
function assertFormatProcessingStages(format: ContentStudioFormatDeclaration): void {
  const stages = format.processingStages;
  if (!Array.isArray(stages) || stages.length < 1 || stages.length > 16) {
    throw new InvalidRequestError(`format '${format.formatId}' processingStages must be an array of 1-16 declared stages`);
  }
  const seen = new Set<string>();
  stages.forEach((stage, index) => {
    if (!isPlainObject(stage) || typeof stage.stageId !== 'string' || !ID_PATTERN.test(stage.stageId)) {
      throw new InvalidRequestError(`format '${format.formatId}' processingStages[${index}].stageId must be 1-64 chars of [a-z0-9_-]`);
    }
    if (stage.description !== undefined && stage.description !== null && !boundedTrimmedString(stage.description, 0, 512)) {
      throw new InvalidRequestError(`format '${format.formatId}' processingStages[${index}].description must be a trimmed string of 0-512 chars`);
    }
    const availability = (stage as { availability?: unknown }).availability;
    if (!isPlainObject(availability)) {
      throw new InvalidRequestError(`format '${format.formatId}' processingStages[${index}].availability must be an object (the honest availability declaration)`);
    }
    const status = (availability as { status?: unknown }).status;
    if (!CONTENT_STUDIO_FORMAT_AVAILABILITY_STATES.includes(status as never)) {
      throw new InvalidRequestError(
        `format '${format.formatId}' processingStages[${index}].availability.status must be one of ${CONTENT_STUDIO_FORMAT_AVAILABILITY_STATES.join(', ')}`,
      );
    }
    const awaitingModule = (availability as { awaitingModule?: unknown }).awaitingModule;
    if (status === 'awaiting_execution_module') {
      if (typeof awaitingModule !== 'string' || !/^[A-Z0-9-]{3,32}$/.test(awaitingModule)) {
        throw new InvalidRequestError(
          `format '${format.formatId}' processingStages[${index}].availability.awaitingModule is required (3-32 chars of [A-Z0-9-]) when the stage awaits an execution module`,
        );
      }
    } else if (awaitingModule !== undefined) {
      throw new InvalidRequestError(
        `format '${format.formatId}' processingStages[${index}].availability.awaitingModule must be absent when the status is 'runtime_driven'`,
      );
    }
    if (seen.has(stage.stageId)) {
      throw new InvalidRequestError(`format '${format.formatId}' processingStages stageId '${stage.stageId}' is duplicated`);
    }
    seen.add(stage.stageId);
  });
}

/**
 * The §2 format-declaration discipline: every plugged format must
 * pass this guard (the composition root validates the wired registry
 * content at construction; registerFormat validates every
 * operational registration; a bad declaration fails loudly, never
 * silently). All NINE surfaces validated + the cross-surface fences
 * (the hook stageId must be a declared stage).
 */
export function assertValidContentStudioFormatDeclaration(format: ContentStudioFormatDeclaration): void {
  if (!isPlainObject(format)) {
    throw new InvalidRequestError('format declaration must be an object');
  }
  if (typeof format.formatId !== 'string' || !ID_PATTERN.test(format.formatId)) {
    throw new InvalidRequestError('format.formatId must be 1-64 chars of [a-z0-9_-]');
  }
  if (typeof format.formatVersion !== 'number' || !Number.isSafeInteger(format.formatVersion) || format.formatVersion < 1 || format.formatVersion > 1000) {
    throw new InvalidRequestError(`format '${format.formatId}' formatVersion must be an integer 1-1000`);
  }
  assertFormatInputRequirements(format);
  assertFormatParticipantModel(format);
  assertFormatCaptureRequirements(format);
  assertFormatInterviewerRequirements(format);
  assertFormatOrganizationRequirements(format);
  assertFormatOutputContract(format);
  assertFormatProvenanceConsent(format);
  assertFormatEvaluationHooks(format);
  assertFormatProcessingStages(format);

  // The cross-surface fence: a stage_completion hook must attach to a
  // DECLARED stage id (the format can inspect its own hook bindings).
  const stageIds = new Set<string>(format.processingStages.map((stage) => stage.stageId));
  for (const hook of format.evaluationHooks.hooks) {
    if (hook.firesOn === 'stage_completion' && !stageIds.has(hook.stageId as string)) {
      throw new InvalidRequestError(
        `format '${format.formatId}' evaluationHooks.hooks entry '${hook.hookId}' attaches to stage '${String(hook.stageId)}' which the declaration does not declare`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. THE §4 ORGANIZATION FENCE (the submitted declaration discipline)
// ---------------------------------------------------------------------------

/**
 * The §4 organization-declaration discipline: a versioned, explicit
 * selection citing OPAQUE /lab-agent-body version references. The
 * compatibility VALIDATION (resolution + the format's requirements)
 * happens at session open through the structural port — with every
 * failure listed explicitly (never a silent replacement).
 */
export function assertValidContentStudioOrganizationDeclaration(organization: ContentStudioOrganizationDeclaration): void {
  if (!isPlainObject(organization)) {
    throw new InvalidRequestError('organization must be an object');
  }
  if (typeof organization.organizationId !== 'string' || !boundedTrimmedString(organization.organizationId, 1, 128)) {
    throw new InvalidRequestError('organization.organizationId must be a trimmed string of 1-128 chars');
  }
  if (typeof organization.organizationVersion !== 'number' || !Number.isSafeInteger(organization.organizationVersion) || organization.organizationVersion < 1 || organization.organizationVersion > 1000) {
    throw new InvalidRequestError(`organization '${organization.organizationId}' organizationVersion must be an integer 1-1000`);
  }
  if (!Array.isArray(organization.agentBodyReferences) || organization.agentBodyReferences.length < 1 || organization.agentBodyReferences.length > 32) {
    throw new InvalidRequestError(`organization '${organization.organizationId}' agentBodyReferences must be an array of 1-32 body-version references`);
  }
  const seen = new Set<string>();
  for (const reference of organization.agentBodyReferences) {
    if (typeof reference !== 'string' || !BODY_REFERENCE_PATTERN.test(reference)) {
      throw new InvalidRequestError(`organization '${organization.organizationId}' agentBodyReferences entry '${String(reference).slice(0, 64)}' is not a body-version reference (<bodyId>#v<version>)`);
    }
    if (seen.has(reference)) {
      throw new InvalidRequestError(`organization '${organization.organizationId}' agentBodyReferences entry '${reference}' is duplicated`);
    }
    seen.add(reference);
  }
  if (organization.capabilities !== undefined && organization.capabilities !== null) {
    assertBoundedStringArray(organization.capabilities, 32, 256, `organization '${organization.organizationId}' capabilities`);
  } else {
    throw new InvalidRequestError(`organization '${organization.organizationId}' capabilities must be an array (may be empty)`);
  }
}

// ---------------------------------------------------------------------------
// 4. THE §3 REQUEST FENCES (the immutable request content discipline)
// ---------------------------------------------------------------------------

function assertRequestInput(content: ContentStudioProductionRequestContent): void {
  const input = content.input;
  if (!isPlainObject(input)) {
    throw new InvalidRequestError('content.input must be an object');
  }
  if (!CONTENT_STUDIO_INPUT_MODES.includes(input.mode as ContentStudioInputMode)) {
    throw new InvalidRequestError(`content.input.mode must be one of ${CONTENT_STUDIO_INPUT_MODES.join(', ')}`);
  }
  if (input.mode === 'script') {
    if (input.script === undefined || input.script === null) {
      throw new InvalidRequestError('content.input.script is required when mode is script');
    }
    assertBoundedJson(input.script, 'content.input.script');
    if (input.questions !== undefined || input.intent !== undefined) {
      throw new InvalidRequestError('content.input must carry exactly one of script/questions/intent (script mode)');
    }
  } else if (input.mode === 'question_list') {
    if (input.questions === undefined || input.questions === null) {
      throw new InvalidRequestError('content.input.questions is required when mode is question_list');
    }
    assertBoundedStringArray(input.questions, 256, 2000, 'content.input.questions');
    if (input.script !== undefined || input.intent !== undefined) {
      throw new InvalidRequestError('content.input must carry exactly one of script/questions/intent (question_list mode)');
    }
  } else {
    if (input.intent === undefined || input.intent === null || !boundedTrimmedString(input.intent, 1, 2000)) {
      throw new InvalidRequestError('content.input.intent must be a trimmed string of 1-2000 chars when mode is intent');
    }
    if (input.script !== undefined || input.questions !== undefined) {
      throw new InvalidRequestError('content.input must carry exactly one of script/questions/intent (intent mode)');
    }
  }
  if (input.sourceArtifactReferences !== undefined && input.sourceArtifactReferences !== null) {
    assertBoundedStringArray(input.sourceArtifactReferences, 64, 512, 'content.input.sourceArtifactReferences');
  }
}

/**
 * The §3 request-content discipline: the full immutable field set with
 * the entry-mode fence (§1 + §15: a standalone request MUST NOT carry
 * Lab fields; a lab_initiated request MUST carry the Lab binding),
 * the format selection shape, the budget/deadline/stopping bounds and
 * the declared rights/provenance context shape.
 */
export function assertValidContentStudioProductionRequestContent(content: ContentStudioProductionRequestContent): void {
  if (!isPlainObject(content)) {
    throw new InvalidRequestError('content must be an object');
  }

  // --- §1/§15 the entry-mode fence ---
  if (!CONTENT_STUDIO_ENTRY_MODES.includes(content.entryMode as ContentStudioEntryMode)) {
    throw new InvalidRequestError(`content.entryMode must be one of ${CONTENT_STUDIO_ENTRY_MODES.join(', ')}`);
  }
  if (content.entryMode === 'standalone' && content.labBinding !== undefined) {
    throw new InvalidRequestError('content.labBinding is forbidden on a standalone request (the §1/§15 entry-mode fence)');
  }
  if (content.entryMode === 'lab_initiated') {
    if (content.labBinding === undefined || content.labBinding === null) {
      throw new InvalidRequestError('content.labBinding is required on a lab_initiated request (the §15 Lab invocation contract)');
    }
    if (!isPlainObject(content.labBinding)) {
      throw new InvalidRequestError('content.labBinding must be an object');
    }
    if (typeof content.labBinding.strategyReference !== 'string' || !boundedTrimmedString(content.labBinding.strategyReference, 1, 512)) {
      throw new InvalidRequestError('content.labBinding.strategyReference must be a trimmed string of 1-512 chars (the discovered-strategy citation)');
    }
    for (const optional of ['missionReference', 'scenarioReference', 'transformGraphReference'] as const) {
      const value = content.labBinding[optional];
      if (value !== undefined && value !== null && !boundedTrimmedString(value, 1, 512)) {
        throw new InvalidRequestError(`content.labBinding.${optional} must be a trimmed string of 1-512 chars`);
      }
    }
  }

  // --- the §2 format selection shape ---
  if (typeof content.formatId !== 'string' || !ID_PATTERN.test(content.formatId)) {
    throw new InvalidRequestError('content.formatId must be 1-64 chars of [a-z0-9_-]');
  }
  if (typeof content.formatVersion !== 'number' || !Number.isSafeInteger(content.formatVersion) || content.formatVersion < 1 || content.formatVersion > 1000) {
    throw new InvalidRequestError(`content.formatVersion must be an integer 1-1000 (format '${content.formatId}')`);
  }

  // --- the §4 organization selection ---
  assertValidContentStudioOrganizationDeclaration(content.organization);

  // --- the §8 input fence ---
  assertRequestInput(content);

  // --- the output contract ---
  if (!isPlainObject(content.output)) {
    throw new InvalidRequestError('content.output must be an object');
  }
  assertBoundedStringArray(content.output.requiredOutputs, 16, 64, 'content.output.requiredOutputs');

  // --- the optional opaque citation surfaces ---
  if (content.modelCapabilityReferences !== undefined && content.modelCapabilityReferences !== null) {
    assertBoundedStringArray(content.modelCapabilityReferences, 32, 256, 'content.modelCapabilityReferences');
  }
  if (content.humanTaskReferences !== undefined && content.humanTaskReferences !== null) {
    assertBoundedStringArray(content.humanTaskReferences, 32, 256, 'content.humanTaskReferences');
  }

  // --- the acceptance criteria ---
  assertBoundedStringArray(content.acceptanceCriteria, 32, 512, 'content.acceptanceCriteria');

  // --- the budget ---
  if (!isPlainObject(content.budget)) {
    throw new InvalidRequestError('content.budget must be an object');
  }
  if (typeof content.budget.maxCostUnits !== 'number' || !Number.isFinite(content.budget.maxCostUnits) || content.budget.maxCostUnits < 0 || content.budget.maxCostUnits > 1_000_000) {
    throw new InvalidRequestError('content.budget.maxCostUnits must be a finite number 0-1000000');
  }
  if (typeof content.budget.maxDurationMs !== 'number' || !Number.isSafeInteger(content.budget.maxDurationMs) || content.budget.maxDurationMs < 1 || content.budget.maxDurationMs > 2_592_000_000) {
    throw new InvalidRequestError('content.budget.maxDurationMs must be an integer 1-2592000000 (30 days)');
  }

  // --- the deadline ---
  if (typeof content.deadline !== 'string' || !ISO_TIMESTAMP_PATTERN.test(content.deadline)) {
    throw new InvalidRequestError('content.deadline must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SS[.fff]Z)');
  }
  if (Number.isNaN(Date.parse(content.deadline))) {
    throw new InvalidRequestError('content.deadline must parse as a real timestamp');
  }

  // --- the delay/stopping policy ---
  if (!isPlainObject(content.delayStoppingPolicy)) {
    throw new InvalidRequestError('content.delayStoppingPolicy must be an object');
  }
  if (
    typeof content.delayStoppingPolicy.retryLimit !== 'number' ||
    !Number.isSafeInteger(content.delayStoppingPolicy.retryLimit) ||
    content.delayStoppingPolicy.retryLimit < 0 ||
    content.delayStoppingPolicy.retryLimit > 10
  ) {
    throw new InvalidRequestError('content.delayStoppingPolicy.retryLimit must be an integer 0-10');
  }

  // --- the declared rights/provenance context (§16 — DECLARED, never evaluated here) ---
  if (!isPlainObject(content.provenanceConsent)) {
    throw new InvalidRequestError('content.provenanceConsent must be an object (the declared §16 rights/provenance context)');
  }
  assertBoundedStringArray(content.provenanceConsent.consentReferences, 32, 512, 'content.provenanceConsent.consentReferences');
  if (content.provenanceConsent.notes !== undefined && content.provenanceConsent.notes !== null && !boundedTrimmedString(content.provenanceConsent.notes, 0, 2000)) {
    throw new InvalidRequestError('content.provenanceConsent.notes must be a trimmed string of 0-2000 chars');
  }
}

// ---------------------------------------------------------------------------
// 5. THE §13 TREATMENT GUARDS (the structured treatment shape)
// ---------------------------------------------------------------------------

/**
 * The §13 structured-treatment discipline: defect + desired change
 * are mandatory; the optional fields are bounded declared data. The
 * alternateOrganization, when present, forces a revised request
 * binding it VERBATIM (enforced at requestTreatment — the no-silent-
 * replacement fence).
 */
export function assertValidContentStudioTreatmentSpecification(treatment: ContentStudioTreatmentSpecification): void {
  if (!isPlainObject(treatment)) {
    throw new InvalidRequestError('treatment must be an object');
  }
  if (typeof treatment.defect !== 'string' || !boundedTrimmedString(treatment.defect, 1, 2000)) {
    throw new InvalidRequestError('treatment.defect must be a trimmed string of 1-2000 chars');
  }
  if (typeof treatment.desiredChange !== 'string' || !boundedTrimmedString(treatment.desiredChange, 1, 2000)) {
    throw new InvalidRequestError('treatment.desiredChange must be a trimmed string of 1-2000 chars');
  }
  for (const optional of ['targetQuality', 'alternateTransformReference', 'humanAction', 'acceptanceTest'] as const) {
    const value = treatment[optional];
    if (value !== undefined && value !== null && !boundedTrimmedString(value, 1, 2000)) {
      throw new InvalidRequestError(`treatment.${optional} must be a trimmed string of 1-2000 chars`);
    }
  }
  if (treatment.affectedArtifacts !== undefined && treatment.affectedArtifacts !== null) {
    assertBoundedStringArray(treatment.affectedArtifacts, 16, 512, 'treatment.affectedArtifacts');
  }
  if (treatment.retryLimit !== undefined && treatment.retryLimit !== null) {
    if (typeof treatment.retryLimit !== 'number' || !Number.isSafeInteger(treatment.retryLimit) || treatment.retryLimit < 0 || treatment.retryLimit > 10) {
      throw new InvalidRequestError('treatment.retryLimit must be an integer 0-10');
    }
  }
  if (treatment.deadline !== undefined && treatment.deadline !== null && !ISO_TIMESTAMP_PATTERN.test(treatment.deadline)) {
    throw new InvalidRequestError('treatment.deadline must be an ISO-8601 UTC timestamp');
  }
  if (treatment.alternateOrganization !== undefined && treatment.alternateOrganization !== null) {
    assertValidContentStudioOrganizationDeclaration(treatment.alternateOrganization);
  }
}

// ---------------------------------------------------------------------------
// The shared module-input fences (the honest error surface)
// ---------------------------------------------------------------------------

/** The scope fence (the uniform tenant anchor shape). */
export function assertValidContentStudioScope(scope: { agencyId: string; clientId: string; workspaceId?: string | null }): void {
  if (!isPlainObject(scope)) {
    throw new InvalidRequestError('scope must be an object');
  }
  if (!UUID_PATTERN.test(String(scope.agencyId)) || !UUID_PATTERN.test(String(scope.clientId))) {
    throw new InvalidRequestError('scope.agencyId and scope.clientId must be agency/client ids');
  }
  if (scope.workspaceId !== undefined && scope.workspaceId !== null && !UUID_PATTERN.test(String(scope.workspaceId))) {
    throw new InvalidRequestError('scope.workspaceId must be a workspace id or null');
  }
}

/** The terminal-reason fence for the cancelled/failed/expired advances. */
export function assertTerminalReasonForAdvance(to: ContentStudioSessionState, terminalReason: ContentStudioTerminalReason | undefined): void {
  if (to === 'cancelled' || to === 'failed' || to === 'expired') {
    if (terminalReason === undefined || terminalReason === null) {
      throw new InvalidRequestError(`advancing to '${to}' requires an explicit terminalReason (the honest terminal record)`);
    }
  } else if (terminalReason !== undefined && terminalReason !== null) {
    throw new InvalidRequestError(`terminalReason is only accepted when advancing to cancelled/failed/expired (found target '${to}')`);
  }
}
