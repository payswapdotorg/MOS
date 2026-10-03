/**
 * MarketingOS module: /content-studio
 * Authority: Content Studio Runtime (STUDIO-001 — spec/
 * effective-backlog-v1.7.md STUDIO-001: "Build the MOS-owned
 * AI+Human production session runtime used standalone or by the Lab.
 * Acceptance: tenant-scoped versioned production sessions,
 * asynchronous/durable processing, guarded lifecycle, no
 * publishing/experiment authority."; dependencies satisfied on main:
 * LAB-011 (merged PR #70 — the /lab-agent-body Agent Body Runtime
 * Contract, the pawn runtime this module loads organizations through)
 * and the frozen v1.6 Content Asset/Rights boundaries). The governing
 * sub-contract is spec/content-studio-contract-v1.0.md (FROZEN):
 *
 *   §1  "Content Studio is the MOS-owned runtime for producing
 *        AI+Human content. It has two entry modes: 1. Standalone
 *        Studio ... 2. Lab-initiated Studio ... Both modes use the
 *        same production/session/artifact contracts."
 *   §2  "The format registry MUST be pluggable. Initial formats:
 *        reaction; audio podcast; video podcast. A format declares:
 *        format identity/version; input requirements; participant
 *        model; capture requirements; interviewer requirements;
 *        organization compatibility requirements; output artifact
 *        contract; provenance/consent requirements; evaluation hooks.
 *        Adding a future format MUST NOT require a second Studio
 *        runtime or a second Lab authority." (STUDIO-002 owns the
 *        full format framework; this module owns the RUNTIME + the
 *        SEAM the formats plug into.)
 *   §3  the immutable/versioned Production Request field set;
 *   §4  organization loading: "The Studio MUST load any Organization
 *        that satisfies the declared Studio compatibility contract"
 *        + "The Studio MUST NOT silently replace a requested
 *        organization with a different organization. A compatibility
 *        failure is explicit and auditable.";
 *   §5  the session lifecycle vocabulary + "State transitions are
 *        guarded and append-audited." + "A completed session remains
 *        immutable. A retry/treatment creates a new session revision
 *        or child production run linked to the prior output.";
 *   §9  "Long-running processing is asynchronous/durable rather than
 *        a synchronous web request." (AGENTS.md v1.7: "Long-running
 *        simulation/training and production processing use durable
 *        worker infrastructure, not synchronous requests");
 *   §13 the structured treatment request fields ("A rejection is a
 *        Lab decision and is distinct from a Rights/Policy
 *        rejection." — the Lab-side evaluation verdicts are LAB-023,
 *        NEVER this module; this module only records the structured
 *        treatment request and opens the linked revision);
 *   §16 "The Studio MUST NOT: infer rights from public accessibility;
 *        bypass Rights/Policy gates; directly publish to social
 *        providers outside v1.6 Distribution/Integration; turn a
 *        participant contribution into an unrestricted reusable asset
 *        without the necessary rights/consent. Real publication
 *        follows the existing MOS authorities.";
 *   §17 the failure vocabulary + "The Lab, not the Studio, owns the
 *        economic choice to wait, substitute, retry or abandon a
 *        production branch. The Studio must expose enough
 *        deterministic cost/delay/status information for that
 *        decision.";
 *
 * spec/architecture-v1.7-marketing-lab.md §30 "Studio/Lab authority
 * boundary" — the Studio MUST NOT "choose a business marketing
 * objective as its own authority; publish directly to social
 * providers; replace MOS Workflow/Execution; create a second model
 * router; become a marketplace." VERBATIM: "The Studio does not become
 * a second workflow or experiment authority. It owns production
 * sessions and production artifacts only."
 * spec/architecture-lock-v1.7.md #43 "The Studio is not a marketing
 * objective, publishing, rights, policy, experiment, evidence,
 * workflow, execution, model-routing or marketplace authority."
 * AGENTS.md v1.7: "Content Studio is the single MOS-owned AI+Human
 * production runtime for standalone and Lab-initiated creation";
 * frozen-manifest-v1.7.json studioRules:
 * "studioIsNotPublicationOrExperimentAuthority": true.
 *
 * THE NO-AUTHORITY-TRANSFER DISCIPLINE (structural): this module
 * creates NO publishing, distribution, experiment, evidence, rights,
 * policy, workflow or execution surface anywhere — no such table, no
 * such verb, no such import. Artifacts produced here are intermediate
 * production artifacts recorded as DECLARED DATA with opaque
 * references; real publication follows the existing v1.6 authorities.
 * The /lab-agent-body consumption is the narrow structural port
 * (organization compatibility resolution ONLY — the body-version
 * registry reads; the pawn RUNTIME stays /lab-agent-body, never a
 * second one here). Zero cross-module imports exist inside
 * src/modules/content-studio (the /lab family discipline; the
 * composition root wires the real instances at the composition point).
 */

// ---------------------------------------------------------------------------
// The frozen contract identity
// ---------------------------------------------------------------------------

/** The versioned identity of the Studio runtime contract (the migration-064 CHECK fence pins it). */
export const CONTENT_STUDIO_CONTRACT_VERSION = 'content-studio-runtime-v1' as const;

import type { Clock } from '../../platform/clock/clock.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { Db } from '../../platform/db/contract.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (the closed sets the migration CHECK-fences)
// ---------------------------------------------------------------------------

/** §1 — the two entry modes (both use the same runtime contracts). */
export const CONTENT_STUDIO_ENTRY_MODES = ['standalone', 'lab_initiated'] as const;
export type ContentStudioEntryMode = (typeof CONTENT_STUDIO_ENTRY_MODES)[number];

/**
 * §5 — the MINIMUM lifecycle vocabulary, verbatim and complete:
 * "created; preparing; awaiting_participant; recording; processing;
 * review; treatment_requested; completed; cancelled; failed; expired."
 */
export const CONTENT_STUDIO_SESSION_STATES = [
  'created',
  'preparing',
  'awaiting_participant',
  'recording',
  'processing',
  'review',
  'treatment_requested',
  'completed',
  'cancelled',
  'failed',
  'expired',
] as const;
export type ContentStudioSessionState = (typeof CONTENT_STUDIO_SESSION_STATES)[number];

/**
 * The terminal session states (§5 "A completed session remains
 * immutable" — extended to every terminal revision state: a terminal
 * revision is frozen forever; a retry/treatment continues through a
 * NEW revision linked to the prior output, never a resurrection).
 * `treatment_requested` is terminal PER REVISION: the treatment
 * request closes the revision and opens its successor (the disclosed
 * conservative reading of "a retry/treatment creates a new session
 * revision or child production run linked to the prior output").
 */
export const CONTENT_STUDIO_TERMINAL_SESSION_STATES = [
  'treatment_requested',
  'completed',
  'cancelled',
  'failed',
  'expired',
] as const;
export type ContentStudioTerminalSessionState = (typeof CONTENT_STUDIO_TERMINAL_SESSION_STATES)[number];

/**
 * The honest terminal reasons (§17-adjacent): a cancelled/failed/expired
 * revision MUST carry one (the terminal-shape fence; completed and
 * treatment_requested revisions carry their own linkage instead).
 */
export const CONTENT_STUDIO_TERMINAL_REASONS = [
  'user_cancelled',
  'lab_abandoned',
  'blocked_dependency',
  'capability_failure',
  'participant_delay',
  'processing_delay',
  'provider_failure',
  'budget_exhausted',
  'rights_consent_issue',
  'quality_failure',
  'deadline_passed',
] as const;
export type ContentStudioTerminalReason = (typeof CONTENT_STUDIO_TERMINAL_REASONS)[number];

/** The append-only session event tail kinds (the §5 "append-audited" substrate). */
export const CONTENT_STUDIO_SESSION_EVENT_KINDS = [
  'session_opened',
  'organization_loaded',
  'state_advanced',
  'processing_plan_recorded',
  'step_claimed',
  'step_completed',
  'step_failed',
  'step_requeued',
  'output_version_recorded',
  'treatment_requested',
] as const;
export type ContentStudioSessionEventKind = (typeof CONTENT_STUDIO_SESSION_EVENT_KINDS)[number];

/** The durable processing-step statuses (the asynchronous/durable §9 substrate). */
export const CONTENT_STUDIO_STEP_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type ContentStudioStepStatus = (typeof CONTENT_STUDIO_STEP_STATUSES)[number];

/**
 * §17 — the Studio records (closed honest taxonomy): "blocked
 * dependency; capability failure; participant delay; processing delay;
 * provider failure; budget exhaustion; rights/consent issue; quality
 * failure." A failed processing step carries exactly one.
 */
export const CONTENT_STUDIO_STEP_FAILURE_REASONS = [
  'blocked_dependency',
  'capability_failure',
  'participant_delay',
  'processing_delay',
  'provider_failure',
  'budget_exhausted',
  'rights_consent_issue',
  'quality_failure',
] as const;
export type ContentStudioStepFailureReason = (typeof CONTENT_STUDIO_STEP_FAILURE_REASONS)[number];

/** §8 — the accepted production input modes (script, question list, intent, intent + sources). */
export const CONTENT_STUDIO_INPUT_MODES = ['script', 'question_list', 'intent'] as const;
export type ContentStudioInputMode = (typeof CONTENT_STUDIO_INPUT_MODES)[number];

/** §6 — the interviewer representation forms a one-person podcast may declare (provenance-labeled). */
export const CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS = [
  'voice',
  'voice_text',
  'avatar',
  'prerecorded',
  'generated',
  'hybrid',
] as const;
export type ContentStudioInterviewerRepresentation = (typeof CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS)[number];

/** §2/§9 — the capture modalities a format may declare (modality-specific but format-neutral). */
export const CONTENT_STUDIO_CAPTURE_MODALITIES = ['audio', 'video', 'screen', 'participant_streams', 'alternate_takes'] as const;
export type ContentStudioCaptureModality = (typeof CONTENT_STUDIO_CAPTURE_MODALITIES)[number];

// ---------------------------------------------------------------------------
// The scope + the platform ports (the composition-root wiring point)
// ---------------------------------------------------------------------------

/** The tenant scope every Studio record anchors (the v1.7 #29 tenant/workspace scoping; client-scope authorization stays the route-layer authority). */
export interface ContentStudioScope {
  readonly agencyId: string;
  readonly clientId: string;
  /** Optional workspace INSIDE the client (the migration-063 anchor discipline). */
  readonly workspaceId?: string | null;
}

export interface ContentStudioModuleDeps {
  /** The platform database port (system of record — the sole persistence boundary). */
  readonly db: Db;
  /** The platform time port (deterministic deadline/expiry decisions). */
  readonly clock: Clock;
  /** The platform id port (server-generated opaque identifiers). */
  readonly ids: IdGenerator;
  /**
   * The narrow /lab-agent-body structural port (§4 organization
   * loading): resolves an opaque body-version reference to the
   * compatibility-relevant declared data. The composition root wires
   * the REAL /lab-agent-body instance behind a disclosed READ-ONLY
   * adapter (the growth-operator pursuit-scope precedent) — the pawn
   * runtime stays /lab-agent-body (LAB-011); this module NEVER
   * builds a second agent runtime.
   */
  readonly agentBodies: ContentStudioAgentBodyPort;
  /**
   * The format seam (§2 "The format registry MUST be pluggable"):
   * the declared formats this runtime validates requests against.
   * The composition root wires the initial registry content; future
   * formats arrive through the SAME seam without a second runtime
   * (STUDIO-002 owns the full framework — this is the seam it plugs
   * into).
   */
  readonly formats: ReadonlyArray<ContentStudioFormatDeclaration>;
}

// ---------------------------------------------------------------------------
// §2 — the FORMAT SEAM (the pluggable format declaration)
// ---------------------------------------------------------------------------

/** The input requirements a format declares (validated deterministically at session open). */
export interface ContentStudioFormatInputRequirements {
  /** The §8 input modes this format accepts. */
  readonly modes: ReadonlyArray<ContentStudioInputMode>;
  /** Whether source/reference artifacts are REQUIRED (§3 source/reference artifacts). */
  readonly sourceArtifacts: 'required' | 'optional';
}

/** The participant model a format declares (§2; the multi-account surface itself is STUDIO-006). */
export interface ContentStudioFormatParticipantModel {
  /** The number of human participants the format expects (1..16). */
  readonly participants: number;
  /** Whether human capture is required for production. */
  readonly humanCapture: 'required' | 'optional';
}

/** The capture requirements a format declares (§9 — modality-specific but format-neutral). */
export interface ContentStudioFormatCaptureRequirements {
  readonly modalities: ReadonlyArray<ContentStudioCaptureModality>;
}

/** The interviewer requirements a format declares (§6 — the representation forms with provenance). */
export interface ContentStudioFormatInterviewerRequirements {
  /** 'none' when the format has no interviewer portion. */
  readonly interviewer: 'none' | 'representation';
  /** The declared representation forms (REQUIRED when interviewer is 'representation'). */
  readonly representations?: ReadonlyArray<ContentStudioInterviewerRepresentation>;
}

/** The organization compatibility requirements a format declares (§4 — what the loaded organization must satisfy). */
export interface ContentStudioFormatOrganizationRequirements {
  /** The minimum number of Agent Body versions the organization must cite (1..32). */
  readonly minAgentBodies: number;
  /** The action kinds the organization's bodies must COLLECTIVELY cover (the §14 permission vocabulary). */
  readonly requiredPermissions: ReadonlyArray<string>;
  /** The opaque capability references the organization must collectively declare (optional). */
  readonly requiredCapabilities?: ReadonlyArray<string>;
}

/** The output artifact contract a format declares (§2 — the artifact kinds the format produces). */
export interface ContentStudioFormatOutputContract {
  /** The artifact kinds this format can produce (the request's output contract must be a subset). */
  readonly outputs: ReadonlyArray<string>;
}

/** The provenance/consent requirements a format declares (§2 — declared context, never evaluated here). */
export interface ContentStudioFormatProvenanceConsentRequirements {
  /** The consent kinds the format's production requires (declared data — the Rights authority evaluates). */
  readonly consent: ReadonlyArray<string>;
  /** The provenance chain the format's outputs must carry (declared data — STUDIO-010 builds the records). */
  readonly provenance: ReadonlyArray<string>;
}

/** The evaluation hooks a format declares (§2 — hook declarations only; the firings are DATA, the evaluation is the caller's). */
export interface ContentStudioFormatEvaluationHooks {
  readonly hooks: ReadonlyArray<{ readonly hookId: string }>;
}

/** One declared processing stage (the durable §9 step plan a session derives). */
export interface ContentStudioProcessingStage {
  readonly stageId: string;
  readonly description?: string;
}

/**
 * §2 — the format declaration: EVERYTHING a format declares, as
 * bounded declared data. The runtime validates requests against the
 * declaration; the format IMPLEMENTATION (capture, interviewers,
 * editing — STUDIO-003..014) drives the durable steps through the
 * claim/complete surface. Adding a future format is a new declaration
 * through this seam — never a second Studio runtime.
 */
export interface ContentStudioFormatDeclaration {
  /** The format identity (1-64 chars of [a-z0-9_-]). */
  readonly formatId: string;
  /** The format version (1..1000). */
  readonly formatVersion: number;
  readonly inputRequirements: ContentStudioFormatInputRequirements;
  readonly participantModel: ContentStudioFormatParticipantModel;
  readonly captureRequirements: ContentStudioFormatCaptureRequirements;
  readonly interviewerRequirements: ContentStudioFormatInterviewerRequirements;
  readonly organizationRequirements: ContentStudioFormatOrganizationRequirements;
  readonly outputContract: ContentStudioFormatOutputContract;
  readonly provenanceConsentRequirements: ContentStudioFormatProvenanceConsentRequirements;
  readonly evaluationHooks: ContentStudioFormatEvaluationHooks;
  /** The ordered durable processing stages (1..16, unique ids) the runtime turns into persisted steps. */
  readonly processingStages: ReadonlyArray<ContentStudioProcessingStage>;
}

/**
 * The initial format registry content (§2 "Initial formats: reaction;
 * audio podcast; video podcast") — MINIMAL declared DATA through the
 * seam, wired by the composition root. The full format framework is
 * STUDIO-002; the reaction/podcast implementations are
 * STUDIO-011/012/013 — never this module.
 */
export const CONTENT_STUDIO_INITIAL_FORMATS: ReadonlyArray<ContentStudioFormatDeclaration> = [
  {
    formatId: 'reaction',
    formatVersion: 1,
    inputRequirements: { modes: ['intent', 'script'], sourceArtifacts: 'required' },
    participantModel: { participants: 1, humanCapture: 'required' },
    captureRequirements: { modalities: ['audio', 'video', 'screen'] },
    interviewerRequirements: { interviewer: 'none' },
    organizationRequirements: { minAgentBodies: 1, requiredPermissions: ['read', 'transform', 'compose'] },
    outputContract: { outputs: ['final_media'] },
    provenanceConsentRequirements: {
      consent: ['participant_recording_consent'],
      provenance: ['source_reference', 'human_capture', 'transform_graph'],
    },
    evaluationHooks: { hooks: [{ hookId: 'reaction-quality-hook' }] },
    processingStages: [
      { stageId: 'capture_ingestion', description: 'Ingest the raw human capture as an intermediate artifact.' },
      { stageId: 'organization_treatment', description: 'The loaded organization composes source + reaction.' },
      { stageId: 'output_assembly', description: 'Assemble the final media + provenance package.' },
    ],
  },
  {
    formatId: 'audio-podcast',
    formatVersion: 1,
    inputRequirements: { modes: ['script', 'question_list', 'intent'], sourceArtifacts: 'optional' },
    participantModel: { participants: 1, humanCapture: 'required' },
    captureRequirements: { modalities: ['audio'] },
    interviewerRequirements: { interviewer: 'representation', representations: ['voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'hybrid'] },
    organizationRequirements: { minAgentBodies: 1, requiredPermissions: ['read', 'compose'] },
    outputContract: { outputs: ['final_media', 'transcript'] },
    provenanceConsentRequirements: {
      consent: ['participant_recording_consent', 'interviewer_representation_disclosure'],
      provenance: ['question_answer_graph', 'interviewer_representation', 'recording'],
    },
    evaluationHooks: { hooks: [{ hookId: 'podcast-quality-hook' }] },
    processingStages: [
      { stageId: 'script_preparation', description: 'Prepare the versioned script/question graph from the supplied input.' },
      { stageId: 'interview_capture', description: 'Run the interview with the declared interviewer representation.' },
      { stageId: 'organization_treatment', description: 'The loaded organization edits/composes the raw capture.' },
      { stageId: 'output_assembly', description: 'Assemble the final audio + transcript + provenance package.' },
    ],
  },
  {
    formatId: 'video-podcast',
    formatVersion: 1,
    inputRequirements: { modes: ['script', 'question_list', 'intent'], sourceArtifacts: 'optional' },
    participantModel: { participants: 1, humanCapture: 'required' },
    captureRequirements: { modalities: ['audio', 'video'] },
    interviewerRequirements: { interviewer: 'representation', representations: ['voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'hybrid'] },
    organizationRequirements: { minAgentBodies: 1, requiredPermissions: ['read', 'compose', 'transform'] },
    outputContract: { outputs: ['final_media', 'transcript'] },
    provenanceConsentRequirements: {
      consent: ['participant_recording_consent', 'interviewer_representation_disclosure'],
      provenance: ['question_answer_graph', 'interviewer_representation', 'recording'],
    },
    evaluationHooks: { hooks: [{ hookId: 'podcast-quality-hook' }] },
    processingStages: [
      { stageId: 'script_preparation', description: 'Prepare the versioned script/question graph from the supplied input.' },
      { stageId: 'interview_capture', description: 'Run the interview with the declared interviewer representation.' },
      { stageId: 'organization_treatment', description: 'The loaded organization edits/composes the raw capture.' },
      { stageId: 'output_assembly', description: 'Assemble the final video + transcript + provenance package.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// §4 — the ORGANIZATION SEAM (the submitted organization declaration)
// ---------------------------------------------------------------------------

/**
 * The submitted organization declaration (§4 "Organizations may be:
 * Lab-discovered; user-supplied; previously saved/versioned" — the
 * versioned, explicit selection lock v1.7 #39 demands). The bodies are
 * cited through the OPAQUE /lab-agent-body version-reference string
 * (never joined here); the compatibility validation resolves them
 * through the structural port and FAILS EXPLICITLY with every
 * incompatibility listed — never a silent replacement.
 */
export interface ContentStudioOrganizationDeclaration {
  /** The organization identity (1-128 chars, the caller's own namespace). */
  readonly organizationId: string;
  /** The organization version (1..1000 — the explicit versioned selection). */
  readonly organizationVersion: number;
  /** The Agent Body version references the organization inhabits (`<bodyId>#v<version>` — resolved through the port). */
  readonly agentBodyReferences: ReadonlyArray<string>;
  /** The opaque capability references the organization declares (may be empty). */
  readonly capabilities: ReadonlyArray<string>;
}

/**
 * The narrow /lab-agent-body structural port: resolves one opaque
 * body-version reference to the compatibility-relevant declared data,
 * or null when the reference does not resolve in scope. READ-ONLY —
 * this module never writes /lab-agent-body state and never runs the
 * pawn loop (the organization EXECUTION during processing is the
 * step-driver's job through the /lab-agent-body runtime, outside this
 * module).
 */
export interface ContentStudioAgentBodyResolution {
  readonly bodyVersionReference: string;
  readonly status: 'draft' | 'active' | 'retired';
  /** The body's declared §14 permissions (action kinds). */
  readonly permissions: ReadonlyArray<string>;
  /** The body's declared §14 safety constraints (non-empty by the body contract). */
  readonly safetyConstraints: ReadonlyArray<string>;
  /** The body's declared §14 capability references (opaque strings). */
  readonly capabilities: ReadonlyArray<string>;
}

export interface ContentStudioAgentBodyPort {
  resolveAgentBody(scope: ContentStudioScope, bodyVersionReference: string): Promise<ContentStudioAgentBodyResolution | null>;
}

/** The recorded compatibility validation (§4 — explicit and auditable). */
export interface ContentStudioOrganizationValidation {
  readonly organizationId: string;
  readonly organizationVersion: number;
  readonly resolvedBodies: ReadonlyArray<ContentStudioAgentBodyResolution>;
  readonly validatedAt: string;
}

// ---------------------------------------------------------------------------
// §3 — the PRODUCTION REQUEST (immutable/versioned)
// ---------------------------------------------------------------------------

/** §8 — the production input: a complete script, a question list, or an intent (optionally with source material). */
export interface ContentStudioRequestInput {
  readonly mode: ContentStudioInputMode;
  /** REQUIRED when mode is 'script' — the supplied script (declared data). */
  readonly script?: Readonly<Record<string, unknown>>;
  /** REQUIRED when mode is 'question_list' — the supplied question list. */
  readonly questions?: ReadonlyArray<string>;
  /** REQUIRED when mode is 'intent' — the declared objective/intent. */
  readonly intent?: string;
  /** §3 source/reference artifacts — OPAQUE references to the existing Content Asset authority's assets (never inferred rights). */
  readonly sourceArtifactReferences?: ReadonlyArray<string>;
}

/** The request's output contract (§3 — must be a subset of the selected format's declared outputs). */
export interface ContentStudioRequestOutputContract {
  readonly requiredOutputs: ReadonlyArray<string>;
}

/** §15 — the Lab binding a lab_initiated request MUST carry (opaque citations; standalone requests MUST NOT). */
export interface ContentStudioLabBinding {
  readonly strategyReference: string;
  readonly missionReference?: string;
  readonly scenarioReference?: string;
  readonly transformGraphReference?: string;
}

/** §3 — the declared budget (bounded, non-negative). */
export interface ContentStudioRequestBudget {
  readonly maxCostUnits: number;
  readonly maxDurationMs: number;
}

/** §3 — the delay/stopping policy declaration (the economic authority stays the caller's — §17). */
export interface ContentStudioDelayStoppingPolicy {
  /** The bounded infrastructure retry allowance for a failed processing step (0..10; 0 = no requeue). */
  readonly retryLimit: number;
}

/**
 * §3 — the production request content: request identity/version;
 * client/workspace scope; optional mission/scenario binding; declared
 * objective; source/reference artifacts; explicit script/question
 * list or intent; selected format; selected organization version;
 * model/capability references; human task references; output
 * contract; acceptance criteria; budget; deadline; delay/stopping
 * policy; rights/provenance context — the standalone omissions and
 * lab_initiated requirements are fenced below.
 */
export interface ContentStudioProductionRequestContent {
  readonly entryMode: ContentStudioEntryMode;
  /** The selected format identity (validated against the registry at session open). */
  readonly formatId: string;
  /** The selected format version. */
  readonly formatVersion: number;
  /** §4 — the explicitly selected organization (validated at session open; never silently replaced). */
  readonly organization: ContentStudioOrganizationDeclaration;
  readonly input: ContentStudioRequestInput;
  readonly output: ContentStudioRequestOutputContract;
  /** §3 model/capability references — OPAQUE strings resolved by the caller's execution drivers. */
  readonly modelCapabilityReferences?: ReadonlyArray<string>;
  /** §3 human task references — OPAQUE strings (the human production task packages are LAB-021). */
  readonly humanTaskReferences?: ReadonlyArray<string>;
  /** §3 acceptance criteria (declared data, bounded). */
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly budget: ContentStudioRequestBudget;
  /** §3 deadline (ISO-8601 UTC — the expiry guard reads it through the clock port). */
  readonly deadline: string;
  readonly delayStoppingPolicy: ContentStudioDelayStoppingPolicy;
  /**
   * §3 + §16 rights/provenance context — DECLARED consent/provenance
   * references and notes ONLY. The Studio never evaluates rights
   * (no second Rights/Policy engine): the declared context rides with
   * the request and the outputs, and the existing v1.6 authorities
   * decide.
   */
  readonly provenanceConsent: {
    readonly consentReferences: ReadonlyArray<string>;
    readonly notes?: string;
  };
  /** §15 — REQUIRED for lab_initiated requests; FORBIDDEN for standalone requests. */
  readonly labBinding?: ContentStudioLabBinding;
}

/** The public record view of one request version row. */
export interface ContentStudioProductionRequestRecord {
  readonly requestId: string;
  readonly requestVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly content: ContentStudioProductionRequestContent;
  readonly contractVersion: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// §5 — the SESSION records
// ---------------------------------------------------------------------------

/** The public record view of one session revision row. */
export interface ContentStudioSessionRecord {
  readonly sessionId: string;
  readonly revision: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly formatId: string;
  readonly formatVersion: number;
  /** The validated organization snapshot this revision executes (§4 — the explicit selection). */
  readonly organization: ContentStudioOrganizationDeclaration;
  /** The recorded compatibility validation (explicit and auditable). */
  readonly organizationValidation: ContentStudioOrganizationValidation;
  readonly state: ContentStudioSessionState;
  /** Set exactly when the revision enters a cancelled/failed/expired terminal (the terminal-shape fence). */
  readonly terminalReason: ContentStudioTerminalReason | null;
  /** The prior output this revision treats (revision > 1 only — the §5 linkage). */
  readonly priorOutputVersionId: string | null;
  /** The treatment request that opened this revision (revision > 1 only). */
  readonly originTreatmentId: string | null;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateChangedAt: string;
}

// ---------------------------------------------------------------------------
// §9 — the durable processing-step records
// ---------------------------------------------------------------------------

/** The public record view of one durable processing-step row. */
export interface ContentStudioProcessingStepRecord {
  readonly stepId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The format-declared stage this step executes (the seam's stageId). */
  readonly stageId: string;
  /** The stage order within the session's plan (1-based). */
  readonly stageIndex: number;
  readonly status: ContentStudioStepStatus;
  /** The claim count (the bounded infrastructure-retry accounting). */
  readonly attempts: number;
  readonly runAt: string;
  readonly lockedAt: string | null;
  readonly lockedBy: string | null;
  /** The step's declared output payload (present only on a succeeded step). */
  readonly output: Readonly<Record<string, unknown>> | null;
  /** The honest failure reason (present only on a failed step — the §17 taxonomy). */
  readonly failureReason: ContentStudioStepFailureReason | null;
  readonly failureDetail: string | null;
  readonly costUnits: number;
  readonly durationMs: number;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// §12 — the OUTPUT VERSION records (immutable; the minimal runtime tail)
// ---------------------------------------------------------------------------

/**
 * The public record view of one immutable output version. The FULL
 * artifact package/provenance richness is STUDIO-010; the runtime
 * records the versioned, lineage-linked output the lifecycle reviews
 * (§5 "A retry/treatment creates a new session revision ... linked to
 * the prior output"; lock v1.7 #42 "Each treatment creates a new
 * linked output version").
 */
export interface ContentStudioOutputVersionRecord {
  readonly outputVersionId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The artifact package as declared data — every key the request's output contract requires is present. */
  readonly artifactPackage: Readonly<Record<string, unknown>>;
  /** The treatment lineage: the predecessor output this version replaces (null on the first version). */
  readonly parentOutputVersionId: string | null;
  readonly aggregateCostUnits: number;
  readonly aggregateDurationMs: number;
  readonly contractVersion: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// §13 — the structured TREATMENT REQUEST records
// ---------------------------------------------------------------------------

/**
 * §13 — the structured treatment request (declared data): "defect;
 * desired change; target quality; affected artifact(s); alternate
 * organization; alternate transform; human action; retry limit;
 * deadline; acceptance test." The EVALUATION verdicts (accepted,
 * rejected_quality, rejected_strategy, rejected_missing_artifact,
 * treatment_required, human_action_required,
 * alternate_organization_required, alternate_transform_required,
 * abandon_branch) are the Lab's (LAB-023) — never this module; this
 * module records the structured request, closes the reviewed revision
 * and opens the linked successor revision.
 */
export interface ContentStudioTreatmentSpecification {
  readonly defect: string;
  readonly desiredChange: string;
  readonly targetQuality?: string;
  readonly affectedArtifacts?: ReadonlyArray<string>;
  /** §4 — when declared, the successor revision MUST bind EXACTLY this organization (no silent replacement). */
  readonly alternateOrganization?: ContentStudioOrganizationDeclaration;
  readonly alternateTransformReference?: string;
  readonly humanAction?: string;
  readonly retryLimit?: number;
  readonly deadline?: string;
  readonly acceptanceTest?: string;
}

/** The public record view of one treatment request row. */
export interface ContentStudioTreatmentRequestRecord {
  readonly treatmentId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly targetOutputVersionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly specification: ContentStudioTreatmentSpecification;
  readonly successorRevision: number;
  readonly contractVersion: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// §5 — the append-only audit events
// ---------------------------------------------------------------------------

/** The public record view of one append-only session event row. */
export interface ContentStudioSessionEventRecord {
  readonly eventId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly seq: number;
  readonly eventKind: ContentStudioSessionEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadDigest: string;
  readonly contractVersion: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// The module inputs
// ---------------------------------------------------------------------------

export interface CreateContentStudioProductionRequestInput {
  readonly scope: ContentStudioScope;
  readonly content: ContentStudioProductionRequestContent;
}

export interface AppendContentStudioProductionRequestInput {
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  /** The full corrected request content (a NEW immutable version row — never a mutation). */
  readonly content: ContentStudioProductionRequestContent;
}

export interface OpenContentStudioSessionInput {
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  /** The exact request version to bind (defaults to the latest in scope). */
  readonly requestVersion?: number;
}

export interface AdvanceContentStudioSessionInput {
  readonly scope: ContentStudioScope;
  readonly sessionId: string;
  /** The target state — must be a legal edge from the current revision's state (the frozen table). */
  readonly to: ContentStudioSessionState;
  /** REQUIRED for the cancelled/failed/expired terminals (the honest terminal record). */
  readonly terminalReason?: ContentStudioTerminalReason;
  /** An optional bounded note recorded on the audit event. */
  readonly note?: string;
}

export interface ClaimContentStudioProcessingStepsInput {
  readonly scope: ContentStudioScope;
  /** The maximum steps to claim (1..16 — one driver batch). */
  readonly limit: number;
  /** The driver identity recorded on the claim (bounded string). */
  readonly lockedBy: string;
  /** Optional session scoping — a driver driving one session's pipeline claims only that session's due steps (still tenant-fenced). */
  readonly sessionId?: string;
}

export interface CompleteContentStudioProcessingStepInput {
  readonly scope: ContentStudioScope;
  readonly stepId: string;
  /** The step's declared output payload (bounded JSON object). */
  readonly output: Readonly<Record<string, unknown>>;
  readonly costUnits?: number;
  readonly durationMs?: number;
}

export interface FailContentStudioProcessingStepInput {
  readonly scope: ContentStudioScope;
  readonly stepId: string;
  readonly failureReason: ContentStudioStepFailureReason;
  readonly failureDetail?: string;
}

export interface RequeueContentStudioProcessingStepInput {
  readonly scope: ContentStudioScope;
  readonly stepId: string;
}

export interface RequestContentStudioTreatmentInput {
  readonly scope: ContentStudioScope;
  readonly sessionId: string;
  /** The output version the treatment targets (must belong to the session's current revision, in review). */
  readonly targetOutputVersionId: string;
  readonly treatment: ContentStudioTreatmentSpecification;
  /**
   * The revised request content binding the successor revision.
   * REQUIRED when the treatment declares an alternateOrganization
   * (which it must carry VERBATIM — the versioned explicit selection);
   * optional otherwise (the successor re-binds the same version).
   */
  readonly revisedRequest?: ContentStudioProductionRequestContent;
}

/** The result of the treatment request: the closed revision + its opened successor. */
export interface ContentStudioTreatmentResult {
  readonly treatment: ContentStudioTreatmentRequestRecord;
  readonly closedRevision: ContentStudioSessionRecord;
  readonly successorRevision: ContentStudioSessionRecord;
}

/** The result of a step completion: the step + (when the plan completed) the recorded output + advanced session. */
export interface ContentStudioStepCompletionResult {
  readonly step: ContentStudioProcessingStepRecord;
  readonly outputVersion: ContentStudioOutputVersionRecord | null;
  readonly session: ContentStudioSessionRecord | null;
}

// ---------------------------------------------------------------------------
// The module API
// ---------------------------------------------------------------------------

export interface ContentStudioModuleApi {
  // --- The §3 production request registry (immutable/versioned) ---

  createProductionRequest(input: CreateContentStudioProductionRequestInput): Promise<ContentStudioProductionRequestRecord>;
  appendProductionRequestVersion(input: AppendContentStudioProductionRequestInput): Promise<ContentStudioProductionRequestRecord>;
  getProductionRequest(scope: ContentStudioScope, requestId: string): Promise<ContentStudioProductionRequestRecord>;
  getProductionRequestVersion(scope: ContentStudioScope, requestId: string, requestVersion: number): Promise<ContentStudioProductionRequestRecord>;
  listProductionRequests(scope: ContentStudioScope): Promise<ReadonlyArray<ContentStudioProductionRequestRecord>>;

  // --- The §2 format seam (the read surface) ---

  listFormats(): ReadonlyArray<ContentStudioFormatDeclaration>;

  // --- The §5 versioned production sessions ---

  openSession(input: OpenContentStudioSessionInput): Promise<ContentStudioSessionRecord>;
  getSession(scope: ContentStudioScope, sessionId: string): Promise<ContentStudioSessionRecord>;
  listSessions(scope: ContentStudioScope): Promise<ReadonlyArray<ContentStudioSessionRecord>>;
  listSessionRevisions(scope: ContentStudioScope, sessionId: string): Promise<ReadonlyArray<ContentStudioSessionRecord>>;
  listSessionEvents(scope: ContentStudioScope, sessionId: string): Promise<ReadonlyArray<ContentStudioSessionEventRecord>>;

  // --- The guarded lifecycle ---

  advanceSession(input: AdvanceContentStudioSessionInput): Promise<ContentStudioSessionRecord>;

  // --- The §9 asynchronous/durable processing surface ---

  listProcessingSteps(scope: ContentStudioScope, sessionId: string): Promise<ReadonlyArray<ContentStudioProcessingStepRecord>>;
  claimProcessingSteps(input: ClaimContentStudioProcessingStepsInput): Promise<ReadonlyArray<ContentStudioProcessingStepRecord>>;
  completeProcessingStep(input: CompleteContentStudioProcessingStepInput): Promise<ContentStudioStepCompletionResult>;
  failProcessingStep(input: FailContentStudioProcessingStepInput): Promise<ContentStudioProcessingStepRecord>;
  requeueProcessingStep(input: RequeueContentStudioProcessingStepInput): Promise<ContentStudioProcessingStepRecord>;

  // --- The §12 output versions (immutable) ---

  getSessionOutputs(scope: ContentStudioScope, sessionId: string): Promise<ReadonlyArray<ContentStudioOutputVersionRecord>>;
  getOutputVersion(scope: ContentStudioScope, outputVersionId: string): Promise<ContentStudioOutputVersionRecord>;

  // --- The §13 structured treatment loop ---

  requestTreatment(input: RequestContentStudioTreatmentInput): Promise<ContentStudioTreatmentResult>;
  listTreatmentRequests(scope: ContentStudioScope, sessionId: string): Promise<ReadonlyArray<ContentStudioTreatmentRequestRecord>>;
}

export { createContentStudioModule } from './internal/content-studio-module.ts';
/**
 * The pure contract guards + deterministic helpers (the §5 state
 * machine, the format-seam declaration discipline, the request fences,
 * the organization declaration fences, the treatment guards) —
 * exported for unit tests and the later Studio modules so the
 * CONTRACT semantics are part of the module surface. Pure functions:
 * no clock, no randomness, no network.
 */
export {
  CONTENT_STUDIO_SESSION_TRANSITIONS,
  assertLegalContentStudioSessionTransition,
  assertValidContentStudioFormatDeclaration,
  assertValidContentStudioProductionRequestContent,
  assertValidContentStudioOrganizationDeclaration,
  assertValidContentStudioTreatmentSpecification,
  assertValidContentStudioScope,
  assertTerminalReasonForAdvance,
  legalContentStudioSessionTransitions,
  isLegalContentStudioSessionTransition,
  isTerminalContentStudioSessionState,
} from './internal/validation.ts';
