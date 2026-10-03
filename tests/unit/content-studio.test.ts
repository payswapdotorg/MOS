/**
 * STUDIO-001 unit tests — the PURE contract guards + the frozen §5
 * state machine of /content-studio (the LAB-011 unit battery
 * precedent: pure functions only, no clock, no network, no database).
 *
 * The Work Item's named acceptance proofs (spec/
 * effective-backlog-v1.7.md STUDIO-001: "tenant-scoped versioned
 * production sessions, asynchronous/durable processing, guarded
 * lifecycle, no publishing/experiment authority" — the pure halves):
 *   (a) THE GUARDED LIFECYCLE: the frozen §5 legal-edge table over the
 *       verbatim vocabulary — every legal edge enumerated, EVERY
 *       illegal edge rejected (the exhaustive 11×11 from/to proof),
 *       the terminal freeze, the no-self-transition fence;
 *   (b) THE FORMAT SEAM (§2): a valid declaration passes (including a
 *       brand-new CUSTOM format through the seam — the pluggability
 *       proof: adding a future format needs NO runtime change), the
 *       three initial formats are valid + distinct, and the closed
 *       vocabularies (input modes, capture modalities, interviewer
 *       representations) reject unknown entries;
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
  CONTENT_STUDIO_CONTRACT_VERSION,
  CONTENT_STUDIO_ENTRY_MODES,
  CONTENT_STUDIO_INITIAL_FORMATS,
  CONTENT_STUDIO_INPUT_MODES,
  CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS,
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
    participantModel: { participants: 1, humanCapture: 'required' },
    captureRequirements: { modalities: ['audio', 'video'] },
    interviewerRequirements: { interviewer: 'none' },
    organizationRequirements: { minAgentBodies: 1, requiredPermissions: ['read', 'transform', 'compose'] },
    outputContract: { outputs: ['final_media'] },
    provenanceConsentRequirements: { consent: ['participant_recording_consent'], provenance: ['source_reference'] },
    evaluationHooks: { hooks: [{ hookId: 'quality-hook' }] },
    processingStages: [
      { stageId: 'capture_ingestion', description: 'Ingest the raw capture.' },
      { stageId: 'organization_treatment' },
      { stageId: 'output_assembly' },
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
  assert.deepEqual(CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS, ['voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'hybrid']);
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
// (b) THE FORMAT SEAM (§2 — the pluggability proof).
// ---------------------------------------------------------------------------

test('STUDIO-001: a valid format declaration passes the seam discipline', () => {
  assertValidContentStudioFormatDeclaration(validFormat());
});

test('STUDIO-001: THE PLUGGABILITY PROOF — a brand-new future format passes through the SAME seam with zero runtime change', () => {
  const futureFormat = validFormat({
    formatId: 'carousel-thread',
    formatVersion: 7,
    inputRequirements: { modes: ['script', 'question_list'], sourceArtifacts: 'optional' },
    participantModel: { participants: 2, humanCapture: 'optional' },
    captureRequirements: { modalities: ['screen', 'participant_streams', 'alternate_takes'] },
    interviewerRequirements: { interviewer: 'representation', representations: ['voice', 'hybrid'] },
    organizationRequirements: { minAgentBodies: 2, requiredPermissions: ['read', 'compose'], requiredCapabilities: ['capability:layout@v9'] },
    outputContract: { outputs: ['final_media', 'thread_transcript', 'derived_clips'] },
    provenanceConsentRequirements: { consent: ['participant_recording_consent', 'interviewer_representation_disclosure'], provenance: ['question_answer_graph', 'recording', 'transform_graph'] },
    evaluationHooks: { hooks: [{ hookId: 'engagement-hook' }, { hookId: 'quality-hook' }] },
    processingStages: [
      { stageId: 'thread_preparation' },
      { stageId: 'panel_capture' },
      { stageId: 'organization_treatment' },
      { stageId: 'output_assembly' },
    ],
  });
  assertValidContentStudioFormatDeclaration(futureFormat);
  // The seam never needed a runtime change: the declaration is data.
  assert.equal(futureFormat.formatId, 'carousel-thread');
});

test('STUDIO-001: the initial format registry content — reaction, audio-podcast and video-podcast are valid, distinct, and carry the §2 declared fields', () => {
  assert.equal(CONTENT_STUDIO_INITIAL_FORMATS.length, 3);
  assert.deepEqual(
    CONTENT_STUDIO_INITIAL_FORMATS.map((format) => format.formatId),
    ['reaction', 'audio-podcast', 'video-podcast'],
  );
  for (const format of CONTENT_STUDIO_INITIAL_FORMATS) {
    assertValidContentStudioFormatDeclaration(format);
  }
  // The podcasts declare interviewer representations; the reaction does not.
  const reaction = CONTENT_STUDIO_INITIAL_FORMATS[0]!;
  const audioPodcast = CONTENT_STUDIO_INITIAL_FORMATS[1]!;
  const videoPodcast = CONTENT_STUDIO_INITIAL_FORMATS[2]!;
  assert.equal(reaction.interviewerRequirements.interviewer, 'none');
  assert.equal(audioPodcast.interviewerRequirements.interviewer, 'representation');
  assert.equal(videoPodcast.interviewerRequirements.interviewer, 'representation');
  assert.ok(audioPodcast.interviewerRequirements.representations!.includes('generated'));
  // The reaction requires source artifacts; the podcasts accept intent alone.
  assert.equal(reaction.inputRequirements.sourceArtifacts, 'required');
  assert.equal(audioPodcast.inputRequirements.sourceArtifacts, 'optional');
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
