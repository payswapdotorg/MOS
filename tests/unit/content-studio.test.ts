/**
 * STUDIO-001 + STUDIO-002 unit tests — the PURE contract guards + the
 * frozen §5 state machine of /content-studio (the LAB-011 unit battery
 * precedent: pure functions only, no clock, no network, no database).
 *
 * The Work Items' named acceptance proofs (spec/
 * effective-backlog-v1.7.md STUDIO-001: "tenant-scoped versioned
 * production sessions, asynchronous/durable processing, guarded
 * lifecycle, no publishing/experiment authority" — the pure halves;
 * STUDIO-002: "Build the format contract and registry. Acceptance:
 * formats declare input, participant, capture, interviewer,
 * organization, output, provenance and evaluation contracts; new
 * formats do not require another Studio runtime."):
 *   (a) THE GUARDED LIFECYCLE: the frozen §5 legal-edge table over the
 *       verbatim vocabulary — every legal edge enumerated, EVERY
 *       illegal edge rejected (the exhaustive 11×11 from/to proof),
 *       the terminal freeze, the no-self-transition fence;
 *   (b) THE FORMAT SEAM (§2 — STUDIO-002's FULL nine-surface
 *       declaration discipline): a valid declaration passes
 *       (including a brand-new CUSTOM format through the seam — the
 *       pluggability proof: adding a future format needs NO runtime
 *       change), the three initial formats are valid + distinct +
 *       carry the complete §2 field sets with their honest
 *       availability states, and EVERY closed vocabulary (input
 *       modes, capture modalities, interviewer representations,
 *       follow-up discipline, participation grants, action-kind
 *       permissions, §12 artifact kinds, consent kinds, provenance
 *       elements, hook firing surfaces, availability states)
 *       rejects unknown entries, malformed shapes and cross-surface
 *       inconsistencies;
 *   (c) THE REQUEST FENCES (§3/§1/§15): the standalone/lab_initiated
 *       entry-mode fence, the input-mode consistency (exactly one of
 *       script/questions/intent), the budget/deadline/stopping bounds,
 *       the source-artifact + output-subset seams;
 *   (d) THE ORGANIZATION FENCE (§4): the versioned declaration
 *       discipline (opaque body-version references, never joined);
 *   (e) THE TREATMENT GUARDS (§13): the structured shape;
 *   (f) the structural no-secret surface (the no-second-authority
 *       posture's data half — the boundary suite proves the code half).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_STUDIO_CAPTURE_MODALITIES,
  CONTENT_STUDIO_CONSENT_KINDS,
  CONTENT_STUDIO_CONTRACT_VERSION,
  CONTENT_STUDIO_ENTRY_MODES,
  CONTENT_STUDIO_EVALUATION_HOOK_SURFACES,
  CONTENT_STUDIO_FORMAT_AVAILABILITY_STATES,
  CONTENT_STUDIO_FORMAT_CONTRACT_VERSION,
  CONTENT_STUDIO_FORMAT_STATUSES,
  CONTENT_STUDIO_INITIAL_FORMATS,
  CONTENT_STUDIO_INPUT_MODES,
  CONTENT_STUDIO_INTERVIEWER_FOLLOW_UP_MODES,
  CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS,
  CONTENT_STUDIO_ORGANIZATION_PERMISSIONS,
  CONTENT_STUDIO_OUTPUT_ARTIFACT_KINDS,
  CONTENT_STUDIO_PARTICIPATION_GRANT_MODELS,
  CONTENT_STUDIO_PROVENANCE_ELEMENTS,
  CONTENT_STUDIO_SESSION_EVENT_KINDS,
  CONTENT_STUDIO_SESSION_STATES,
  CONTENT_STUDIO_SESSION_TRANSITIONS,
  CONTENT_STUDIO_STEP_FAILURE_REASONS,
  CONTENT_STUDIO_STEP_STATUSES,
  CONTENT_STUDIO_TERMINAL_REASONS,
  CONTENT_STUDIO_TERMINAL_SESSION_STATES,
  assertLegalContentStudioSessionTransition,
  assertTerminalReasonForAdvance,
  assertValidContentStudioFormatDeclaration,
  assertValidContentStudioOrganizationDeclaration,
  assertValidContentStudioProductionRequestContent,
  assertValidContentStudioTreatmentSpecification,
  isLegalContentStudioSessionTransition,
  isTerminalContentStudioSessionState,
  legalContentStudioSessionTransitions,
  type ContentStudioFormatDeclaration,
  type ContentStudioOrganizationDeclaration,
  type ContentStudioProductionRequestContent,
} from '../../src/modules/content-studio/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const BODY_ID = '01923f7e-8b1d-7abc-9def-0123456789ab';
const BODY_REFERENCE = `${BODY_ID}#v1`;

function assertInvalid(fn: () => void, fragment: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InvalidRequestError, `expected InvalidRequestError containing '${fragment}'`);
  assert.ok(
    String((caught as InvalidRequestError).message).includes(fragment),
    `message "${String((caught as InvalidRequestError).message)}" should contain '${fragment}'`,
  );
}

// ---------------------------------------------------------------------------
// The format + organization + request fixtures.
// ---------------------------------------------------------------------------

function validFormat(overrides: Partial<ContentStudioFormatDeclaration> = {}): ContentStudioFormatDeclaration {
  return {
    formatId: 'reaction',
    formatVersion: 1,
    inputRequirements: { modes: ['intent', 'script'], sourceArtifacts: 'required' },
    participantModel: { participants: { min: 1, max: 1 }, humanCapture: 'required', participationGrants: 'single_scope' },
    captureRequirements: { modalities: ['audio', 'video'] },
    interviewerRequirements: { interviewer: 'none' },
    organizationRequirements: { minAgentBodies: 1, requiredPermissions: ['read', 'transform', 'compose'] },
    outputContract: { outputs: ['final_media'] },
    provenanceConsentRequirements: { consent: ['participant_recording_consent'], provenance: ['source_reference', 'transform_graph'] },
    evaluationHooks: { hooks: [{ hookId: 'quality-hook', firesOn: 'output_recorded' }] },
    processingStages: [
      { stageId: 'capture_ingestion', description: 'Ingest the raw capture.', availability: { status: 'runtime_driven' } },
      { stageId: 'organization_treatment', availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-008' } },
      { stageId: 'output_assembly', availability: { status: 'runtime_driven' } },
    ],
    ...overrides,
  };
}

function validOrganization(overrides: Partial<ContentStudioOrganizationDeclaration> = {}): ContentStudioOrganizationDeclaration {
  return {
    organizationId: 'org-reaction-composer',
    organizationVersion: 3,
    agentBodyReferences: [BODY_REFERENCE],
    capabilities: ['capability:clip-selection@v2'],
    ...overrides,
  };
}

function validRequestContent(overrides: Partial<ContentStudioProductionRequestContent> = {}): ContentStudioProductionRequestContent {
  return {
    entryMode: 'standalone',
    formatId: 'reaction',
    formatVersion: 1,
    organization: validOrganization(),
    input: { mode: 'intent', intent: 'A punchy reaction to the launch video.', sourceArtifactReferences: ['asset:01923f7e-8b1d-7abc-9def-0123456789cd'] },
    output: { requiredOutputs: ['final_media'] },
    acceptanceCriteria: ['holds attention in the first 3 seconds'],
    budget: { maxCostUnits: 12.5, maxDurationMs: 3_600_000 },
    deadline: '2026-12-01T12:00:00.000Z',
    delayStoppingPolicy: { retryLimit: 2 },
    provenanceConsent: { consentReferences: ['consent:participant-recording-1'] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) THE GUARDED LIFECYCLE — the frozen §5 state machine.
// ---------------------------------------------------------------------------

test('STUDIO-001: the frozen vocabularies are the closed sets (the §5 lifecycle verbatim, the §1 entry modes, the §17 failure taxonomy, the step statuses, the event kinds)', () => {
  assert.equal(CONTENT_STUDIO_CONTRACT_VERSION, 'content-studio-runtime-v1');
  assert.deepEqual(CONTENT_STUDIO_ENTRY_MODES, ['standalone', 'lab_initiated']);
  assert.deepEqual(CONTENT_STUDIO_SESSION_STATES, [
    'created', 'preparing', 'awaiting_participant', 'recording', 'processing',
    'review', 'treatment_requested', 'completed', 'cancelled', 'failed', 'expired',
  ]);
  assert.deepEqual(CONTENT_STUDIO_TERMINAL_SESSION_STATES, ['treatment_requested', 'completed', 'cancelled', 'failed', 'expired']);
  assert.deepEqual(CONTENT_STUDIO_INPUT_MODES, ['script', 'question_list', 'intent']);
  // STUDIO-002 — the FULL closed §2 vocabularies (the migration-068
  // CHECK fences pin exactly these sets).
  assert.deepEqual(CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS, [
    'voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'multimodal_declared', 'hybrid',
  ]);
  assert.deepEqual(CONTENT_STUDIO_INTERVIEWER_FOLLOW_UP_MODES, ['adaptive', 'fixed']);
  assert.deepEqual(CONTENT_STUDIO_PARTICIPATION_GRANT_MODELS, ['single_scope', 'explicit_grant_per_participant']);
  assert.deepEqual(CONTENT_STUDIO_ORGANIZATION_PERMISSIONS, ['read', 'analyze', 'compose', 'transform', 'communicate', 'simulate']);
  assert.deepEqual(CONTENT_STUDIO_OUTPUT_ARTIFACT_KINDS, [
    'raw_captures', 'final_media', 'alternate_takes', 'transcript', 'question_answer_graph',
    'timestamps', 'participant_contributions', 'edit_graph', 'transform_graph', 'composition_layout',
    'captions_subtitles', 'derived_clips', 'provenance', 'consent_records', 'quality_evaluation_metadata', 'costs_durations',
  ]);
  assert.deepEqual(CONTENT_STUDIO_CONSENT_KINDS, [
    'participant_recording_consent', 'interviewer_representation_disclosure', 'participant_contribution_rights', 'source_artifact_rights',
  ]);
  assert.deepEqual(CONTENT_STUDIO_PROVENANCE_ELEMENTS, [
    'source_reference', 'human_capture', 'interviewer_representation', 'generated_vs_human_distinction',
    'question_answer_sequence', 'recording', 'transform_graph', 'edit_graph', 'participant_contribution', 'treatment_lineage',
  ]);
  assert.deepEqual(CONTENT_STUDIO_EVALUATION_HOOK_SURFACES, ['stage_completion', 'output_recorded']);
  assert.deepEqual(CONTENT_STUDIO_FORMAT_AVAILABILITY_STATES, ['runtime_driven', 'awaiting_execution_module']);
  assert.deepEqual(CONTENT_STUDIO_FORMAT_STATUSES, ['draft', 'active', 'retired']);
  assert.equal(CONTENT_STUDIO_FORMAT_CONTRACT_VERSION, 'content-studio-format-v1');
  assert.deepEqual(CONTENT_STUDIO_CAPTURE_MODALITIES, ['audio', 'video', 'screen', 'participant_streams', 'alternate_takes']);
  assert.deepEqual(CONTENT_STUDIO_STEP_STATUSES, ['queued', 'running', 'succeeded', 'failed']);
  assert.deepEqual(CONTENT_STUDIO_STEP_FAILURE_REASONS, [
    'blocked_dependency', 'capability_failure', 'participant_delay', 'processing_delay',
    'provider_failure', 'budget_exhausted', 'rights_consent_issue', 'quality_failure',
  ]);
  assert.deepEqual(CONTENT_STUDIO_SESSION_EVENT_KINDS, [
    'session_opened', 'organization_loaded', 'state_advanced', 'processing_plan_recorded',
    'step_claimed', 'step_completed', 'step_failed', 'step_requeued',
    'output_version_recorded', 'treatment_requested',
  ]);
  assert.deepEqual(CONTENT_STUDIO_TERMINAL_REASONS, [
    'user_cancelled', 'lab_abandoned', 'blocked_dependency', 'capability_failure',
    'participant_delay', 'processing_delay', 'provider_failure', 'budget_exhausted',
    'rights_consent_issue', 'quality_failure', 'deadline_passed',
  ]);
});

test('STUDIO-001: THE FROZEN §5 LEGAL-EDGE TABLE — every legal edge enumerated exactly (the canonical production flows)', () => {
  assert.deepEqual(legalContentStudioSessionTransitions(), [
    { from: 'created', to: 'preparing' },
    { from: 'created', to: 'cancelled' },
    { from: 'created', to: 'failed' },
    { from: 'created', to: 'expired' },
    { from: 'preparing', to: 'awaiting_participant' },
    { from: 'preparing', to: 'recording' },
    { from: 'preparing', to: 'processing' },
    { from: 'preparing', to: 'cancelled' },
    { from: 'preparing', to: 'failed' },
    { from: 'preparing', to: 'expired' },
    { from: 'awaiting_participant', to: 'recording' },
    { from: 'awaiting_participant', to: 'cancelled' },
    { from: 'awaiting_participant', to: 'failed' },
    { from: 'awaiting_participant', to: 'expired' },
    { from: 'recording', to: 'processing' },
    { from: 'recording', to: 'cancelled' },
    { from: 'recording', to: 'failed' },
    { from: 'recording', to: 'expired' },
    { from: 'processing', to: 'review' },
    { from: 'processing', to: 'cancelled' },
    { from: 'processing', to: 'failed' },
    { from: 'processing', to: 'expired' },
    { from: 'review', to: 'treatment_requested' },
    { from: 'review', to: 'completed' },
    { from: 'review', to: 'cancelled' },
    { from: 'review', to: 'failed' },
    { from: 'review', to: 'expired' },
  ]);
});

test('STUDIO-001: THE EXHAUSTIVE ILLEGAL-EDGE PROOF — every from×to pair NOT in the frozen table is rejected (no implicit jumps, 11×11)', () => {
  for (const from of CONTENT_STUDIO_SESSION_STATES) {
    for (const to of CONTENT_STUDIO_SESSION_STATES) {
      const legal = isLegalContentStudioSessionTransition(from, to);
      if (from === to) {
        assert.ok(!legal, `self-transition ${from} → ${to} is never legal`);
        continue;
      }
      if (isTerminalContentStudioSessionState(from)) {
        assert.ok(!legal, `terminal state ${from} has no outgoing edges (${from} → ${to} must be illegal)`);
        continue;
      }
      if (legal) continue;
      assert.throws(
        () => assertLegalContentStudioSessionTransition(from, to),
        /not legal/,
        `the illegal edge ${from} → ${to} must be rejected by the guard`,
      );
    }
  }
  // The guard names the terminal freeze exactly.
  assert.throws(
    () => assertLegalContentStudioSessionTransition('completed', 'processing'),
    /terminal revisions are frozen/,
  );
  assert.throws(
    () => assertLegalContentStudioSessionTransition('treatment_requested', 'created'),
    /terminal revisions are frozen/,
  );
  // The no-self-transition fence.
  assert.throws(
    () => assertLegalContentStudioSessionTransition('processing', 'processing'),
    /must move/,
  );
});

test('STUDIO-001: the canonical NO-IMPLICIT-JUMP examples — skipped states and backward edges are rejected', () => {
  // created → review skips preparing/processing (an implicit jump).
  assert.throws(() => assertLegalContentStudioSessionTransition('created', 'review'), /not legal/);
  // created → completed skips the whole lifecycle.
  assert.throws(() => assertLegalContentStudioSessionTransition('created', 'completed'), /not legal/);
  // preparing → review skips recording/processing.
  assert.throws(() => assertLegalContentStudioSessionTransition('preparing', 'review'), /not legal/);
  // awaiting_participant → processing skips recording.
  assert.throws(() => assertLegalContentStudioSessionTransition('awaiting_participant', 'processing'), /not legal/);
  // review → recording is a backward edge.
  assert.throws(() => assertLegalContentStudioSessionTransition('review', 'recording'), /not legal/);
  // processing → preparing is a backward edge.
  assert.throws(() => assertLegalContentStudioSessionTransition('processing', 'preparing'), /not legal/);
  // Every non-terminal state CAN honestly cancel/fail/expire (§17 — the caller's economic choice).
  for (const from of ['created', 'preparing', 'awaiting_participant', 'recording', 'processing', 'review']) {
    for (const to of ['cancelled', 'failed', 'expired']) {
      assert.ok(isLegalContentStudioSessionTransition(from as never, to as never), `${from} → ${to} is a legal honest terminal edge`);
    }
  }
});

test('STUDIO-001: the terminal-reason fence — cancelled/failed/expired REQUIRE an explicit reason; other targets reject one', () => {
  assertTerminalReasonForAdvance('cancelled', 'user_cancelled');
  assertTerminalReasonForAdvance('failed', 'provider_failure');
  assertTerminalReasonForAdvance('expired', 'deadline_passed');
  assertInvalid(() => assertTerminalReasonForAdvance('cancelled', undefined), 'terminalReason');
  assertInvalid(() => assertTerminalReasonForAdvance('failed', undefined), 'terminalReason');
  assertInvalid(() => assertTerminalReasonForAdvance('preparing', 'user_cancelled'), 'only accepted when advancing to cancelled/failed/expired');
});

test('STUDIO-001: the transition table is internally consistent with the state vocabulary (every state key present, every target in the vocabulary)', () => {
  assert.deepEqual([...Object.keys(CONTENT_STUDIO_SESSION_TRANSITIONS)].sort(), [...CONTENT_STUDIO_SESSION_STATES].sort());
  for (const [from, targets] of Object.entries(CONTENT_STUDIO_SESSION_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(CONTENT_STUDIO_SESSION_STATES.includes(to), `target '${to}' of '${from}' is in the state vocabulary`);
    }
  }
});

// ---------------------------------------------------------------------------
// (b) THE FORMAT SEAM (§2 — the pluggability proof + STUDIO-002's full
//     nine-surface declaration discipline).
// ---------------------------------------------------------------------------

test('STUDIO-001: a valid format declaration passes the seam discipline', () => {
  assertValidContentStudioFormatDeclaration(validFormat());
});

test('STUDIO-001 + STUDIO-002: THE PLUGGABILITY PROOF — a brand-new future format passes through the SAME seam with zero runtime change (the deepened full-field-set declaration)', () => {
  const futureFormat = validFormat({
    formatId: 'carousel-thread',
    formatVersion: 7,
    inputRequirements: { modes: ['script', 'question_list'], sourceArtifacts: 'optional' },
    participantModel: { participants: { min: 2, max: 4 }, humanCapture: 'optional', participationGrants: 'explicit_grant_per_participant' },
    captureRequirements: { modalities: ['screen', 'participant_streams', 'alternate_takes'] },
    interviewerRequirements: { interviewer: 'representation', representations: ['voice', 'multimodal_declared', 'hybrid'], followUps: 'adaptive' },
    organizationRequirements: { minAgentBodies: 2, requiredPermissions: ['read', 'compose'], requiredCapabilities: ['capability:layout@v9'] },
    outputContract: { outputs: ['final_media', 'transcript', 'derived_clips'] },
    provenanceConsentRequirements: {
      consent: ['participant_recording_consent', 'interviewer_representation_disclosure', 'participant_contribution_rights'],
      provenance: ['question_answer_sequence', 'recording', 'transform_graph'],
    },
    evaluationHooks: {
      hooks: [
        { hookId: 'engagement-hook', firesOn: 'output_recorded' },
        { hookId: 'panel-flow-hook', firesOn: 'stage_completion', stageId: 'panel_capture' },
      ],
    },
    processingStages: [
      { stageId: 'thread_preparation', availability: { status: 'runtime_driven' } },
      { stageId: 'panel_capture', availability: { status: 'runtime_driven' } },
      { stageId: 'organization_treatment', availability: { status: 'runtime_driven' } },
      { stageId: 'output_assembly', availability: { status: 'runtime_driven' } },
    ],
  });
  assertValidContentStudioFormatDeclaration(futureFormat);
  // The seam never needed a runtime change: the declaration is data.
  assert.equal(futureFormat.formatId, 'carousel-thread');
});

test('STUDIO-002: THE NINE §2 DECLARATION SURFACES — each surface is a validated, closed-vocabulary-backed declared-data field on the declaration', () => {
  // Surface 1 — the format identity/version: the registry's natural key.
  const badId = validFormat();
  (badId as unknown as { formatId: string }).formatId = 'Not A Format';
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badId), 'formatId');

  const badVersion = validFormat();
  (badVersion as unknown as { formatVersion: number }).formatVersion = 0;
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badVersion), 'formatVersion');

  // Surface 2 — the input requirements: closed mode vocabulary + the source fence.
  const badSource = validFormat();
  (badSource as unknown as { inputRequirements: { sourceArtifacts: string } }).inputRequirements.sourceArtifacts = 'sometimes';
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badSource), 'sourceArtifacts');

  // Surface 3 — the participant model: the range + the §6/§7 grant pairing.
  const badRange = validFormat();
  (badRange as unknown as { participantModel: { participants: { min: number; max: number } } }).participantModel.participants = { min: 3, max: 2 };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badRange), 'min ≤ max');

  const multiPersonWithoutGrants = validFormat({
    participantModel: { participants: { min: 1, max: 4 }, humanCapture: 'optional', participationGrants: 'single_scope' },
  });
  assertInvalid(() => assertValidContentStudioFormatDeclaration(multiPersonWithoutGrants), 'explicit_grant_per_participant');

  const singlePersonWithGrants = validFormat({
    participantModel: { participants: { min: 1, max: 1 }, humanCapture: 'required', participationGrants: 'explicit_grant_per_participant' },
  });
  assertInvalid(() => assertValidContentStudioFormatDeclaration(singlePersonWithGrants), 'single_scope');

  // Surface 4 — the capture requirements: the closed modality vocabulary.
  const badModality = validFormat();
  (badModality as unknown as { captureRequirements: { modalities: string[] } }).captureRequirements.modalities = ['smell'];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badModality), 'capture-modality vocabulary');

  // Surface 5 — the interviewer requirements: the closed representation
  // vocabulary + the §6 follow-up discipline.
  const badRepresentation = validFormat();
  (badRepresentation as unknown as { interviewerRequirements: { interviewer: string; representations: string[]; followUps?: string } }).interviewerRequirements = {
    interviewer: 'representation',
    representations: ['telepathy'],
    followUps: 'adaptive',
  };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badRepresentation), 'interviewer-representation vocabulary');

  const representationWithoutFollowUps = validFormat();
  (representationWithoutFollowUps as unknown as { interviewerRequirements: { interviewer: string; representations: string[]; followUps?: string } }).interviewerRequirements = {
    interviewer: 'representation',
    representations: ['voice'],
  };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(representationWithoutFollowUps), 'followUps');

  const noneWithFollowUps = validFormat();
  (noneWithFollowUps as unknown as { interviewerRequirements: { interviewer: string; followUps?: string } }).interviewerRequirements = {
    interviewer: 'none',
    followUps: 'adaptive',
  };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(noneWithFollowUps), 'followUps must be absent when interviewer is');

  // Surface 6 — the organization compatibility requirements: the closed
  // §14 action-kind permission vocabulary.
  const badPermission = validFormat();
  (badPermission as unknown as { organizationRequirements: { requiredPermissions: string[] } }).organizationRequirements.requiredPermissions = ['publish'];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badPermission), 'closed action-kind vocabulary');

  const emptyPermissions = validFormat();
  (emptyPermissions as unknown as { organizationRequirements: { requiredPermissions: never[] } }).organizationRequirements.requiredPermissions = [];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(emptyPermissions), 'non-empty subset');

  // Surface 7 — the output artifact contract: the closed §12 artifact-kind vocabulary.
  const badOutput = validFormat();
  (badOutput as unknown as { outputContract: { outputs: string[] } }).outputContract.outputs = ['vibes'];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badOutput), 'artifact-kind vocabulary');

  const emptyOutputs = validFormat();
  (emptyOutputs as unknown as { outputContract: { outputs: never[] } }).outputContract.outputs = [];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(emptyOutputs), 'non-empty subset');

  // Surface 8 — the provenance/consent requirements: the closed
  // consent-kind + provenance-element vocabularies.
  const badConsent = validFormat();
  (badConsent as unknown as { provenanceConsentRequirements: { consent: string[] } }).provenanceConsentRequirements.consent = ['handshake'];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badConsent), 'consent-kind vocabulary');

  const badProvenance = validFormat();
  (badProvenance as unknown as { provenanceConsentRequirements: { provenance: string[] } }).provenanceConsentRequirements.provenance = ['the_vibe'];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badProvenance), 'provenance-element vocabulary');

  // Surface 9 — the evaluation hooks: the closed firing-surface
  // vocabulary + the stageId cross-reference fence.
  const badFiresOn = validFormat();
  (badFiresOn as unknown as { evaluationHooks: { hooks: Array<{ hookId: string; firesOn: string }> } }).evaluationHooks.hooks[0]!.firesOn = 'whenever';
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badFiresOn), 'firesOn');

  const stageHookWithoutStage = validFormat();
  (stageHookWithoutStage as unknown as { evaluationHooks: { hooks: Array<{ hookId: string; firesOn: string }> } }).evaluationHooks.hooks[0]!.firesOn = 'stage_completion';
  assertInvalid(() => assertValidContentStudioFormatDeclaration(stageHookWithoutStage), 'stageId');

  const stageHookUnknownStage = validFormat();
  (stageHookUnknownStage as unknown as { evaluationHooks: { hooks: Array<{ hookId: string; firesOn: string; stageId: string }> } }).evaluationHooks.hooks[0] = {
    hookId: 'quality-hook',
    firesOn: 'stage_completion',
    stageId: 'a_stage_that_is_not_declared',
  };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(stageHookUnknownStage), 'does not declare');

  const outputHookWithStage = validFormat();
  (outputHookWithStage as unknown as { evaluationHooks: { hooks: Array<{ hookId: string; firesOn: string; stageId: string }> } }).evaluationHooks.hooks[0] = {
    hookId: 'quality-hook',
    firesOn: 'output_recorded',
    stageId: 'output_assembly',
  };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(outputHookWithStage), 'must NOT declare stageId');
});

test('STUDIO-002: the honest availability layer — every stage declares a closed availability state with the required awaitingModule citation', () => {
  const noAvailability = validFormat();
  (noAvailability as unknown as { processingStages: Array<{ stageId: string; description?: string; availability?: unknown }> }).processingStages[0] = {
    stageId: 'capture_ingestion',
    description: 'Ingest the raw capture.',
  };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(noAvailability), 'availability must be an object');

  const badAvailability = validFormat();
  (badAvailability as unknown as { processingStages: Array<{ stageId: string; availability: { status: string } }> }).processingStages[0]!.availability = { status: 'probably_fine' };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badAvailability), 'availability.status must be one of');

  const awaitingWithoutModule = validFormat();
  (awaitingWithoutModule as unknown as { processingStages: Array<{ stageId: string; availability: { status: string } }> }).processingStages[0]!.availability = { status: 'awaiting_execution_module' };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(awaitingWithoutModule), 'awaitingModule is required');

  const runtimeDrivenWithModule = validFormat();
  (runtimeDrivenWithModule as unknown as { processingStages: Array<{ stageId: string; availability: { status: string; awaitingModule?: string } }> }).processingStages[2]!.availability = {
    status: 'runtime_driven',
    awaitingModule: 'STUDIO-010',
  };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(runtimeDrivenWithModule), 'awaitingModule must be absent');
});

test('STUDIO-001 + STUDIO-002: the initial format registry content — reaction, audio-podcast and video-podcast are valid, distinct, and carry the COMPLETE §2 field sets with honest availability states', () => {
  assert.equal(CONTENT_STUDIO_INITIAL_FORMATS.length, 3);
  assert.deepEqual(
    CONTENT_STUDIO_INITIAL_FORMATS.map((format) => format.formatId),
    ['reaction', 'audio-podcast', 'video-podcast'],
  );
  for (const format of CONTENT_STUDIO_INITIAL_FORMATS) {
    assertValidContentStudioFormatDeclaration(format);
    // EVERY initial format declares ALL NINE surfaces with the
    // availability layer (the promoted full declarations).
    for (const stage of format.processingStages) {
      assert.ok(stage.availability !== undefined, `stage '${stage.stageId}' of '${format.formatId}' declares its availability`);
    }
  }
  // The podcasts declare the interviewer construction options (§6 +
  // §27.6 multimodal_declared + hybrid); the reaction does not.
  const reaction = CONTENT_STUDIO_INITIAL_FORMATS[0]!;
  const audioPodcast = CONTENT_STUDIO_INITIAL_FORMATS[1]!;
  const videoPodcast = CONTENT_STUDIO_INITIAL_FORMATS[2]!;
  assert.equal(reaction.interviewerRequirements.interviewer, 'none');
  assert.equal(audioPodcast.interviewerRequirements.interviewer, 'representation');
  assert.equal(videoPodcast.interviewerRequirements.interviewer, 'representation');
  assert.deepEqual(audioPodcast.interviewerRequirements.representations, [
    'voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'multimodal_declared', 'hybrid',
  ]);
  assert.equal(audioPodcast.interviewerRequirements.followUps, 'adaptive');
  // §7 — the podcasts are multi-person-capable with explicit
  // per-participant grants; the reaction is single-scope.
  assert.deepEqual(reaction.participantModel.participants, { min: 1, max: 1 });
  assert.equal(reaction.participantModel.participationGrants, 'single_scope');
  assert.deepEqual(audioPodcast.participantModel.participants, { min: 1, max: 16 });
  assert.equal(audioPodcast.participantModel.participationGrants, 'explicit_grant_per_participant');
  // The reaction requires source artifacts; the podcasts accept intent alone.
  assert.equal(reaction.inputRequirements.sourceArtifacts, 'required');
  assert.equal(audioPodcast.inputRequirements.sourceArtifacts, 'optional');
  // The honest availability gap: the initial formats' capture/interviewer/
  // treatment stages await their future execution modules (STUDIO-003/004/
  // 007/008) while the output-assembly stage is runtime-driven today.
  for (const format of CONTENT_STUDIO_INITIAL_FORMATS) {
    const assembly = format.processingStages.find((stage) => stage.stageId === 'output_assembly')!;
    assert.equal(assembly.availability.status, 'runtime_driven');
    for (const stage of format.processingStages) {
      if (stage.stageId !== 'output_assembly') {
        assert.equal(stage.availability.status, 'awaiting_execution_module', `stage '${stage.stageId}' of '${format.formatId}' honestly awaits its execution module`);
        assert.ok(/^STUDIO-\d{3}$/.test(stage.availability.awaitingModule!), 'the awaiting module cites a Studio Work Item');
      }
    }
  }
});

test('STUDIO-001: the format-seam fences — unknown vocabularies, zero/oversized stages, duplicate stage ids and malformed shapes are rejected', () => {
  const badMode = validFormat();
  (badMode as unknown as { inputRequirements: { modes: string[] } }).inputRequirements.modes = ['vibe'];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badMode), 'input-mode vocabulary');

  const badModality = validFormat();
  (badModality as unknown as { captureRequirements: { modalities: string[] } }).captureRequirements.modalities = ['smell'];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badModality), 'capture-modality vocabulary');

  const badRepresentation = validFormat();
  (badRepresentation as unknown as { interviewerRequirements: { interviewer: string; representations: string[] } }).interviewerRequirements = {
    interviewer: 'representation',
    representations: ['telepathy'],
  };
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badRepresentation), 'interviewer-representation vocabulary');

  const noStages = validFormat();
  (noStages as unknown as { processingStages: never[] }).processingStages = [];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(noStages), 'processingStages');

  const duplicateStage = validFormat();
  (duplicateStage as unknown as { processingStages: Array<{ stageId: string }> }).processingStages[2]!.stageId = 'capture_ingestion';
  assertInvalid(() => assertValidContentStudioFormatDeclaration(duplicateStage), 'duplicated');

  const badHook = validFormat();
  (badHook as unknown as { evaluationHooks: { hooks: Array<{ hookId: string }> } }).evaluationHooks.hooks[0]!.hookId = 'Not A Hook';
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badHook), 'hookId');

  const badMinBodies = validFormat();
  (badMinBodies as unknown as { organizationRequirements: { minAgentBodies: number } }).organizationRequirements.minAgentBodies = 0;
  assertInvalid(() => assertValidContentStudioFormatDeclaration(badMinBodies), 'minAgentBodies');

  const representationsWithoutInterviewer = validFormat();
  (representationsWithoutInterviewer as unknown as { interviewerRequirements: { representations: string[] } }).interviewerRequirements.representations = ['voice'];
  assertInvalid(() => assertValidContentStudioFormatDeclaration(representationsWithoutInterviewer), 'must be absent when interviewer is');
});

// ---------------------------------------------------------------------------
// (c) THE REQUEST FENCES (§3/§1/§15).
// ---------------------------------------------------------------------------

test('STUDIO-001: a valid standalone request content passes (the FULL §3 field set)', () => {
  assertValidContentStudioProductionRequestContent(validRequestContent());
});

test('STUDIO-001: a valid lab_initiated request content passes with the §15 Lab binding', () => {
  assertValidContentStudioProductionRequestContent(validRequestContent({
    entryMode: 'lab_initiated',
    labBinding: { strategyReference: 'strategy:lab-run-42/candidate-7', missionReference: 'mission:01923f7e-8b1d-7abc-9def-0123456789ef', transformGraphReference: 'transform-graph:tg-9' },
  }));
});

test('STUDIO-001: THE ENTRY-MODE FENCE — a standalone request MUST NOT carry Lab fields; a lab_initiated request MUST', () => {
  const standaloneWithLab = validRequestContent({ labBinding: { strategyReference: 'strategy:x' } });
  assertInvalid(() => assertValidContentStudioProductionRequestContent(standaloneWithLab), 'entry-mode fence');

  const labWithoutBinding = validRequestContent({ entryMode: 'lab_initiated' });
  assertInvalid(() => assertValidContentStudioProductionRequestContent(labWithoutBinding), 'labBinding is required');

  const labEmptyStrategy = validRequestContent({ entryMode: 'lab_initiated', labBinding: { strategyReference: ' ' } });
  assertInvalid(() => assertValidContentStudioProductionRequestContent(labEmptyStrategy), 'strategyReference');
});

test('STUDIO-001: the §8 input-mode consistency — exactly one of script/questions/intent, mode-consistent', () => {
  const scriptMode = validRequestContent({ input: { mode: 'script', script: { opening: 'Three points, then the punchline.' } } });
  assertValidContentStudioProductionRequestContent(scriptMode);

  const questionsMode = validRequestContent({ input: { mode: 'question_list', questions: ['What surprised you most?'] } });
  assertValidContentStudioProductionRequestContent(questionsMode);

  const missingScript = validRequestContent();
  (missingScript as unknown as { input: { mode: string } }).input = { mode: 'script' };
  assertInvalid(() => assertValidContentStudioProductionRequestContent(missingScript), 'script is required');

  const mixedInput = validRequestContent();
  (mixedInput as unknown as { input: Record<string, unknown> }).input = {
    mode: 'intent',
    intent: 'A reaction',
    questions: ['Q1'],
  };
  assertInvalid(() => assertValidContentStudioProductionRequestContent(mixedInput), 'exactly one');

  const emptyIntent = validRequestContent();
  (emptyIntent as unknown as { input: Record<string, unknown> }).input = { mode: 'intent', intent: '  ' };
  assertInvalid(() => assertValidContentStudioProductionRequestContent(emptyIntent), 'intent');
});

test('STUDIO-001: the budget/deadline/stopping fences — zero/negative/oversized caps, malformed deadlines and out-of-bounds retry limits are rejected', () => {
  const negativeBudget = validRequestContent();
  (negativeBudget as unknown as { budget: { maxCostUnits: number } }).budget.maxCostUnits = -0.01;
  assertInvalid(() => assertValidContentStudioProductionRequestContent(negativeBudget), 'maxCostUnits');

  const zeroDuration = validRequestContent();
  (zeroDuration as unknown as { budget: { maxDurationMs: number } }).budget.maxDurationMs = 0;
  assertInvalid(() => assertValidContentStudioProductionRequestContent(zeroDuration), 'maxDurationMs');

  const badDeadline = validRequestContent();
  (badDeadline as unknown as { deadline: string }).deadline = '2026-12-01 12:00:00';
  assertInvalid(() => assertValidContentStudioProductionRequestContent(badDeadline), 'deadline');

  const retryTooBig = validRequestContent();
  (retryTooBig as unknown as { delayStoppingPolicy: { retryLimit: number } }).delayStoppingPolicy.retryLimit = 11;
  assertInvalid(() => assertValidContentStudioProductionRequestContent(retryTooBig), 'retryLimit');

  const noConsent = validRequestContent();
  (noConsent as unknown as { provenanceConsent: Record<string, unknown> }).provenanceConsent = {};
  assertInvalid(() => assertValidContentStudioProductionRequestContent(noConsent), 'provenanceConsent');
});

// ---------------------------------------------------------------------------
// (d) THE ORGANIZATION FENCE (§4).
// ---------------------------------------------------------------------------

test('STUDIO-001: a valid submitted organization declaration passes (versioned, opaque body references)', () => {
  assertValidContentStudioOrganizationDeclaration(validOrganization());
});

test('STUDIO-001: the organization fences — malformed body references, duplicates, empty citation lists and bad versions are rejected', () => {
  const badReference = validOrganization();
  (badReference as unknown as { agentBodyReferences: string[] }).agentBodyReferences = [`${BODY_ID}@1`];
  assertInvalid(() => assertValidContentStudioOrganizationDeclaration(badReference), 'body-version reference');

  const noBodies = validOrganization();
  (noBodies as unknown as { agentBodyReferences: never[] }).agentBodyReferences = [];
  assertInvalid(() => assertValidContentStudioOrganizationDeclaration(noBodies), 'agentBodyReferences');

  const duplicateBody = validOrganization();
  (duplicateBody as unknown as { agentBodyReferences: string[] }).agentBodyReferences = [BODY_REFERENCE, BODY_REFERENCE];
  assertInvalid(() => assertValidContentStudioOrganizationDeclaration(duplicateBody), 'duplicated');

  const zeroVersion = validOrganization();
  (zeroVersion as unknown as { organizationVersion: number }).organizationVersion = 0;
  assertInvalid(() => assertValidContentStudioOrganizationDeclaration(zeroVersion), 'organizationVersion');
});

// ---------------------------------------------------------------------------
// (e) THE TREATMENT GUARDS (§13).
// ---------------------------------------------------------------------------

test('STUDIO-001: a valid structured treatment specification passes (the §13 fields as declared data)', () => {
  assertValidContentStudioTreatmentSpecification({
    defect: 'The intro clips trail off before the punchline.',
    desiredChange: 'Tighten the first 3 seconds; cut the dead air.',
    targetQuality: 'hook-quality-v2',
    affectedArtifacts: ['final_media'],
    alternateTransformReference: 'transform:clip-tighten@v3',
    humanAction: 'Re-record the opening reaction take.',
    retryLimit: 2,
    deadline: '2026-12-05T12:00:00.000Z',
    acceptanceTest: 'First-3s retention hook passes.',
  });
});

test('STUDIO-001: the treatment fences — missing defect/desired change, oversized retry limits and malformed alternates are rejected', () => {
  const noDefect: Record<string, unknown> = { desiredChange: 'Tighten it.' };
  assertInvalid(() => assertValidContentStudioTreatmentSpecification(noDefect as never), 'defect');

  const noDesiredChange: Record<string, unknown> = { defect: 'Dead air in the intro.' };
  assertInvalid(() => assertValidContentStudioTreatmentSpecification(noDesiredChange as never), 'desiredChange');

  const badRetry = { defect: 'd', desiredChange: 'c', retryLimit: 99 };
  assertInvalid(() => assertValidContentStudioTreatmentSpecification(badRetry as never), 'retryLimit');

  const badAlternate = {
    defect: 'd',
    desiredChange: 'c',
    alternateOrganization: { organizationId: 'x', organizationVersion: 0, agentBodyReferences: [BODY_REFERENCE], capabilities: [] },
  };
  assertInvalid(() => assertValidContentStudioTreatmentSpecification(badAlternate as never), 'organizationVersion');
});

// ---------------------------------------------------------------------------
// (f) The structural no-secret surface (the data half).
// ---------------------------------------------------------------------------

test('STUDIO-001: the request-content surface exposes NO credential-shaped field (the no-secret discipline)', () => {
  const keys = Object.keys(validRequestContent()).sort();
  assert.deepEqual(keys, [
    'acceptanceCriteria', 'budget', 'deadline', 'delayStoppingPolicy', 'entryMode',
    'formatId', 'formatVersion', 'input', 'organization', 'output', 'provenanceConsent',
  ]);
  for (const key of keys) {
    assert.ok(!/credential|secret|apikey|api_key|token|password|material/i.test(key), `input field '${key}' must not be a secret-bearing surface`);
  }
  // The organization declaration carries body REFERENCES (opaque
  // strings), never provider configuration or credential data.
  const organizationKeys = Object.keys(validOrganization()).sort();
  assert.deepEqual(organizationKeys, ['agentBodyReferences', 'capabilities', 'organizationId', 'organizationVersion']);
  for (const key of organizationKeys) {
    assert.ok(!/credential|secret|apikey|api_key|token|password|provider/i.test(key), `organization field '${key}' must not be a secret/provider-bearing surface`);
  }
});
