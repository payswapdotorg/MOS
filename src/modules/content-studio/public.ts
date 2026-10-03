/**
 * MarketingOS module: /content-studio
 * Authority: Content Studio Runtime (STUDIO-001) + the Pluggable
 * Format Framework (STUDIO-002 — spec/effective-backlog-v1.7.md
 * STUDIO-002: "Build the format contract and registry.
 * Acceptance: formats declare input, participant, capture,
 * interviewer, organization, output, provenance and evaluation
 * contracts; new formats do not require another Studio runtime.";
 * dependencies satisfied on main: STUDIO-001 (merged PR #73 — the
 * /content-studio runtime + migration 064 this framework extends) —
 * spec/effective-backlog-v1.7.md STUDIO-001: "Build the MOS-owned
 * AI+Human production session runtime used standalone or by the Lab.
 * Acceptance: tenant-scoped versioned production sessions,
 * asynchronous/durable processing, guarded lifecycle, no
 * publishing/experiment authority."; LAB-011 (merged PR #70 — the
 * /lab-agent-body Agent Body Runtime Contract, the pawn runtime this
 * module loads organizations through) and the frozen v1.6 Content
 * Asset/Rights boundaries). The governing sub-contract is
 * spec/content-studio-contract-v1.0.md (FROZEN):
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
 *        runtime or a second Lab authority." (STUDIO-002 — THIS
 *        delivery — makes every one of the nine §2 declaration
 *        surfaces real: each field is a validated,
 *        closed-vocabulary-backed declaration surface on the
 *        migration-068 registry record, expressed as declared DATA
 *        (the one-level LAB-011 contract discipline), never runtime
 *        logic the format cannot inspect; the registry carries the
 *        /lab-agent-body versioned-registry discipline — draft →
 *        active → retired, append-only version corrections, identity
 *        immutable — and registering a future format is a declaration
 *        through the SAME seam, never a second Studio runtime.)
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
 *   §6  the single-person podcast interviewer representations (the
 *        construction options the podcast formats declare: "voice;
 *        voice + text; avatar; prerecorded interviewer content;
 *        generated interviewer content; hybrid representation" +
 *        spec/architecture-v1.7-marketing-lab.md §27.6 "another
 *        declared multimodal interviewer representation" — the
 *        closed interviewer-representation vocabulary) + "The
 *        interviewer may adapt questions using previous answers" +
 *        "Synthetic or prerecorded interviewer material MUST NOT be
 *        represented as a live human recording when it is not";
 *   §7  the multi-person podcast participation grants ("Each
 *        participant joins through an explicit participation grant" —
 *        the participation-grant model a format's participant model
 *        declares; the multi-account session surface itself is
 *        STUDIO-006, never this module);
 *   §9  "Long-running processing is asynchronous/durable rather than
 *        a synchronous web request." (AGENTS.md v1.7: "Long-running
 *        simulation/training and production processing use durable
 *        worker infrastructure, not synchronous requests");
 *   §12 the output artifact package vocabulary (the "where available"
 *        kinds the output artifact contract declares: raw captures,
 *        final media, alternate takes, transcript, question/answer
 *        graph, timestamps, participant contributions, edit graph,
 *        transform graph, composition/layout data, captions/subtitles,
 *        derived clips, provenance, consent records, quality/
 *        evaluation metadata, costs and processing durations);
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

/**
 * The versioned identity of the format-framework contract (STUDIO-002 —
 * the migration-068 CHECK fence pins it on every registry row): the
 * nine §2 declaration surfaces + the honest availability layer. A
 * SECOND contract identity, not a version bump of the runtime
 * contract: the six migration-064 runtime tables keep
 * 'content-studio-runtime-v1' immutable (the STUDIO-001 delivery is
 * frozen); the migration-068 registry rows carry the format-framework
 * identity (the /lab-features lab-featureset-v1 precedent of a
 * versioned sub-contract identity inside one module).
 */
export const CONTENT_STUDIO_FORMAT_CONTRACT_VERSION = 'content-studio-format-v1' as const;

/**
 * The versioned identity of the intent-to-script contract (STUDIO-003 —
 * the migration-070 CHECK fence pins it on every intent/script/graph/
 * review/conversation row): the §8 record surfaces — the INTENT
 * records, the VERSIONED SCRIPT records, the VERSIONED QUESTION-GRAPH
 * records, the HUMAN-REVIEW DECISION records and the CONVERSATION-
 * GRAPH HOOK records. A THIRD contract identity inside the one module
 * (the STUDIO-002 sub-contract precedent): the migration-064 runtime
 * tables and the migration-068 registry rows keep their identities
 * immutable; the migration-070 rows carry this one.
 */
export const CONTENT_STUDIO_SCRIPT_CONTRACT_VERSION = 'content-studio-script-v1' as const;

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

/**
 * §6 + architecture-v1.7 §27.6 — the interviewer representation forms
 * a one-person podcast may declare (provenance-labeled): the §6 six
 * (voice; voice + text; avatar; prerecorded interviewer content;
 * generated interviewer content; hybrid representation) PLUS the
 * §27.6 "another declared multimodal interviewer representation"
 * (mapped to the enum member 'multimodal_declared' — the disclosed
 * spelling of the parent architecture's seventh form).
 */
export const CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS = [
  'voice',
  'voice_text',
  'avatar',
  'prerecorded',
  'generated',
  'multimodal_declared',
  'hybrid',
] as const;
export type ContentStudioInterviewerRepresentation = (typeof CONTENT_STUDIO_INTERVIEWER_REPRESENTATIONS)[number];

/**
 * §6 — the interviewer follow-up discipline a declaring format pins:
 * 'adaptive' ("The interviewer may adapt questions using previous
 * answers" — the §8 question/branch graph discipline) or 'fixed' (a
 * non-adaptive script-driven interviewer).
 */
export const CONTENT_STUDIO_INTERVIEWER_FOLLOW_UP_MODES = ['adaptive', 'fixed'] as const;
export type ContentStudioInterviewerFollowUpMode = (typeof CONTENT_STUDIO_INTERVIEWER_FOLLOW_UP_MODES)[number];

/**
 * §7 — the participation grant model a format's participant model
 * declares: 'single_scope' (the §6 single-person surface — one
 * authorized account, no per-participant grants) or
 * 'explicit_grant_per_participant' (the §7 multi-person surface —
 * every participant joins through an explicit participation grant;
 * the grant records themselves are STUDIO-006, never this module).
 */
export const CONTENT_STUDIO_PARTICIPATION_GRANT_MODELS = ['single_scope', 'explicit_grant_per_participant'] as const;
export type ContentStudioParticipationGrantModel = (typeof CONTENT_STUDIO_PARTICIPATION_GRANT_MODELS)[number];

/** §2/§9 — the capture modalities a format may declare (modality-specific but format-neutral). */
export const CONTENT_STUDIO_CAPTURE_MODALITIES = ['audio', 'video', 'screen', 'participant_streams', 'alternate_takes'] as const;
export type ContentStudioCaptureModality = (typeof CONTENT_STUDIO_CAPTURE_MODALITIES)[number];

/**
 * §4 (the organization compatibility requirements' permission fence) —
 * the CLOSED action-kind vocabulary the /lab-agent-body §14 contract
 * CHECK-fences (migration 063's permissions <@ fence): a format's
 * requiredPermissions must be a subset of EXACTLY this set, so the
 * collective-coverage validation at session open is a closed-set
 * comparison, never an open string match.
 */
export const CONTENT_STUDIO_ORGANIZATION_PERMISSIONS = [
  'read',
  'analyze',
  'compose',
  'transform',
  'communicate',
  'simulate',
] as const;
export type ContentStudioOrganizationPermission = (typeof CONTENT_STUDIO_ORGANIZATION_PERMISSIONS)[number];

/**
 * §12 — the output artifact package kinds ("A completed Studio Session
 * returns an Artifact Package containing, where available: ...") — the
 * CLOSED vocabulary the output artifact contract declares its outputs
 * from. Every member is a §12 package kind verbatim (snake_cased):
 * raw captures; final media; alternate takes; transcript; question/
 * answer graph; timestamps; participant contributions; edit graph;
 * transform graph; composition/layout data; captions/subtitles;
 * derived clips; provenance; consent records; quality/evaluation
 * metadata; costs and processing durations.
 */
export const CONTENT_STUDIO_OUTPUT_ARTIFACT_KINDS = [
  'raw_captures',
  'final_media',
  'alternate_takes',
  'transcript',
  'question_answer_graph',
  'timestamps',
  'participant_contributions',
  'edit_graph',
  'transform_graph',
  'composition_layout',
  'captions_subtitles',
  'derived_clips',
  'provenance',
  'consent_records',
  'quality_evaluation_metadata',
  'costs_durations',
] as const;
export type ContentStudioOutputArtifactKind = (typeof CONTENT_STUDIO_OUTPUT_ARTIFACT_KINDS)[number];

/**
 * §6/§7/§16 — the CLOSED consent-kind vocabulary the provenance/
 * consent requirements declare from (each member grounded in a
 * contract phrase — the disclosed mapping):
 * 'participant_recording_consent' (§6 "participant consent");
 * 'interviewer_representation_disclosure' (§6 "Synthetic or
 * prerecorded interviewer material MUST NOT be represented as a live
 * human recording when it is not");
 * 'participant_contribution_rights' (§7 "output rights metadata" +
 * §16 "turn a participant contribution into an unrestricted reusable
 * asset without the necessary rights/consent");
 * 'source_artifact_rights' (§16 "declared rights/consent context"
 * for the cited source/reference artifacts — never inferred from
 * public accessibility).
 */
export const CONTENT_STUDIO_CONSENT_KINDS = [
  'participant_recording_consent',
  'interviewer_representation_disclosure',
  'participant_contribution_rights',
  'source_artifact_rights',
] as const;
export type ContentStudioConsentKind = (typeof CONTENT_STUDIO_CONSENT_KINDS)[number];

/**
 * §6/§11/§12 — the CLOSED provenance-element vocabulary the
 * provenance/consent requirements declare from (each member grounded
 * in a contract phrase — the disclosed mapping):
 * 'source_reference' (§11 "source/reference → human capture →
 * transformation → assembled output" — the lineage head);
 * 'human_capture' (§11); 'interviewer_representation' (§6
 * "interviewer representation provenance");
 * 'generated_vs_human_distinction' (§6 "generated versus
 * human-authored distinction"); 'question_answer_sequence' (§6
 * "question/answer sequence"); 'recording' (§6 "recording
 * provenance"); 'transform_graph' (§11 "transformation" + §12);
 * 'edit_graph' (§12); 'participant_contribution' (§7/§12
 * "participant contributions"); 'treatment_lineage' (§12 "New
 * treatment produces a new version linked to its predecessor").
 */
export const CONTENT_STUDIO_PROVENANCE_ELEMENTS = [
  'source_reference',
  'human_capture',
  'interviewer_representation',
  'generated_vs_human_distinction',
  'question_answer_sequence',
  'recording',
  'transform_graph',
  'edit_graph',
  'participant_contribution',
  'treatment_lineage',
] as const;
export type ContentStudioProvenanceElement = (typeof CONTENT_STUDIO_PROVENANCE_ELEMENTS)[number];

/**
 * §2 — the CLOSED evaluation-hook firing surfaces: the deterministic
 * runtime events a format's evaluation hooks may declare attachment
 * to ('stage_completion' — a declared processing stage's durable step
 * completed; 'output_recorded' — the output version was recorded).
 * The hook FIRINGS are DATA on the session event tail; the hook
 * EVALUATION is the caller's (the Lab verdicts are LAB-023, never
 * this module) — this surface is the declaration the format can
 * inspect, never logic it cannot.
 */
export const CONTENT_STUDIO_EVALUATION_HOOK_SURFACES = ['stage_completion', 'output_recorded'] as const;
export type ContentStudioEvaluationHookSurface = (typeof CONTENT_STUDIO_EVALUATION_HOOK_SURFACES)[number];

/**
 * The honest availability layer (the STUDIO-002 gap disclosure as
 * DATA): 'runtime_driven' — the CURRENT Studio runtime executes the
 * stage's contract surface end-to-end through the durable
 * claim/complete machinery; 'awaiting_execution_module' — the stage's
 * real execution is owned by a future declared Studio module (cited
 * by awaitingModule, e.g. 'STUDIO-007'). The runtime does NOT gate
 * execution on the availability state — it is the format's honest
 * declaration of what is shipped, never a silent overstatement.
 */
export const CONTENT_STUDIO_FORMAT_AVAILABILITY_STATES = ['runtime_driven', 'awaiting_execution_module'] as const;
export type ContentStudioFormatAvailabilityState = (typeof CONTENT_STUDIO_FORMAT_AVAILABILITY_STATES)[number];

/**
 * The §2 format-registry lifecycle (the /lab-agent-body
 * versioned-registry precedent): a format version is registered as
 * 'draft', activated explicitly ('active' — the only state whose
 * versions resolve for NEW sessions), then possibly 'retired' (new
 * resolutions refuse; RUNNING sessions never break — they carry the
 * bound format identity/version as their own recorded data, and the
 * registry never deletes). No resurrection: a retired or superseded
 * version is corrected by a NEW version row.
 */
export const CONTENT_STUDIO_FORMAT_STATUSES = ['draft', 'active', 'retired'] as const;
export type ContentStudioFormatStatus = (typeof CONTENT_STUDIO_FORMAT_STATUSES)[number];

// ---------------------------------------------------------------------------
// §8 — the INTENT-TO-SCRIPT vocabularies (STUDIO-003 — the closed sets
// the migration-070 CHECK fences pin)
// ---------------------------------------------------------------------------

/**
 * §8 — the two script/question-graph record origins: 'supplied' (the
 * §3 path — a complete script or a podcast question list supplied by
 * the user: recorded, versioned, NO generation, NO review state) or
 * 'generated' (the selected organization's output from an intent:
 * FULL provenance required — the intent lineage, the generator
 * organization identity, the participating model/capability references
 * — and the explicit human-review lifecycle, born 'pending').
 */
export const CONTENT_STUDIO_SCRIPT_ORIGINS = ['supplied', 'generated'] as const;
export type ContentStudioScriptOrigin = (typeof CONTENT_STUDIO_SCRIPT_ORIGINS)[number];

/**
 * §8 — the CLOSED review-state vocabulary (the explicit human-review
 * option): a generated script/question-graph version is BORN
 * 'pending' and advances ONLY along pending → approved | rejected |
 * superseded, approved | rejected → superseded (no resurrection). A
 * 'superseded' version is replaced by a newer version of the same
 * chain (a correction or a regeneration). Supplied records carry NO
 * review state (user-authored material is its own authority).
 */
export const CONTENT_STUDIO_REVIEW_STATES = ['pending', 'approved', 'rejected', 'superseded'] as const;
export type ContentStudioReviewState = (typeof CONTENT_STUDIO_REVIEW_STATES)[number];

/** The CLOSED review-DECISION vocabulary (pending is the born state, not a decision). */
export const CONTENT_STUDIO_REVIEW_VERDICTS = ['approved', 'rejected', 'superseded'] as const;
export type ContentStudioReviewVerdict = (typeof CONTENT_STUDIO_REVIEW_VERDICTS)[number];

/**
 * The HONEST autonomous/human reviewer split (§6 "generated versus
 * human-authored distinction", extended to the review decision): a
 * 'human' reviewer is an explicit human actor; an 'autonomous'
 * reviewer is the system (e.g. the generation registry superseding a
 * prior version on regeneration). Never conflated.
 */
export const CONTENT_STUDIO_REVIEWER_KINDS = ['human', 'autonomous'] as const;
export type ContentStudioReviewerKind = (typeof CONTENT_STUDIO_REVIEWER_KINDS)[number];

/**
 * §8 — "The generated script is versioned and reviewable before
 * recording WHEN THE FORMAT REQUIRES explicit user confirmation": the
 * OPTIONAL format input-requirements field a declaring format pins
 * (ABSENT = 'not_required' — every STUDIO-002 declaration and every
 * already-materialized tenant registry row is unaffected). When
 * 'required', a session against the format may enter RECORDING only
 * with an APPROVED generated script/question-graph for the request
 * version — the structural gate (honored at session open when the
 * generated material already exists, and at the recording advance).
 */
export const CONTENT_STUDIO_GENERATED_INPUT_REVIEW_MODES = ['required', 'not_required'] as const;
export type ContentStudioGeneratedInputReviewMode = (typeof CONTENT_STUDIO_GENERATED_INPUT_REVIEW_MODES)[number];

/**
 * §8 (the declared question/branch graph) — the CLOSED question
 * modality-hint vocabulary: the §6/§27.6 interviewer representation
 * forms a question node may declare as its delivery hints (the same
 * 7-member set the format declarations use — one closed vocabulary,
 * two declaration surfaces).
 */
export const CONTENT_STUDIO_QUESTION_MODALITY_HINTS = [
  'voice',
  'voice_text',
  'avatar',
  'prerecorded',
  'generated',
  'multimodal_declared',
  'hybrid',
] as const;
export type ContentStudioQuestionModalityHint = (typeof CONTENT_STUDIO_QUESTION_MODALITY_HINTS)[number];

/**
 * §8 — the CLOSED branch-condition vocabulary (the declared edge
 * conditions of the question/branch graph, the DISCLOSED mapping of
 * "choose a follow-up ... based on the preceding answer" to a closed
 * deterministic set): 'always' (the unconditional next question) and
 * the five answer-shaped conditions — 'on_answer_positive',
 * 'on_answer_negative', 'on_answer_neutral', 'on_answer_elaborate',
 * 'on_answer_abbreviated'. At most ONE declared edge per (from,
 * condition) — the deterministic adjacency: a follow-up chosen by
 * condition always resolves to exactly one next question.
 */
export const CONTENT_STUDIO_BRANCH_CONDITIONS = [
  'always',
  'on_answer_positive',
  'on_answer_negative',
  'on_answer_neutral',
  'on_answer_elaborate',
  'on_answer_abbreviated',
] as const;
export type ContentStudioBranchCondition = (typeof CONTENT_STUDIO_BRANCH_CONDITIONS)[number];

/**
 * §9 (the conversation records) — the CLOSED answer-kind vocabulary:
 * the modality of the recorded answer behind a conversation step
 * (grounded in the §9 capture modalities audio/video + the text
 * modality of the voice+text interviewer surface).
 */
export const CONTENT_STUDIO_ANSWER_KINDS = ['audio', 'video', 'text'] as const;
export type ContentStudioAnswerKind = (typeof CONTENT_STUDIO_ANSWER_KINDS)[number];

/**
 * §8 (the conversation records) — the HONEST chooser split: who chose
 * the declared follow-up edge — the ADAPTIVE INTERVIEWER ('interviewer'
 * — the autonomous choice mechanics, STUDIO-004's runtime) or an
 * explicit human choice ('human'). The resulting conversation graph
 * preserves the distinction as data (§6 "generated versus human-
 * authored distinction").
 */
export const CONTENT_STUDIO_CHOOSER_KINDS = ['interviewer', 'human'] as const;
export type ContentStudioChooserKind = (typeof CONTENT_STUDIO_CHOOSER_KINDS)[number];

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
   * the composition-root wired registry CONTENT — the initial (or
   * test-wired) FULL §2 declarations the registry materializes
   * per CLIENT scope (materialize-if-absent, born active through the
   * guarded lifecycle; a tenant's own registry state is never
   * resurrected or overwritten). Future formats arrive through the
   * SAME seam (a new declaration here) OR through the operational
   * registerFormat/activateFormat commands — both land in the ONE
   * migration-068 registry, never a second Studio runtime
   * (STUDIO-002 made this seam the full framework).
   */
  readonly formats: ReadonlyArray<ContentStudioFormatDeclaration>;
}

// ---------------------------------------------------------------------------
// §2 — the FORMAT SEAM (the pluggable format declaration)
// ---------------------------------------------------------------------------

/**
 * §2 DECLARATION SURFACE 1 of 9 — the format identity/version: the
 * identity (1-64 chars of [a-z0-9_-]) + the version (1..1000) declared
 * on ContentStudioFormatDeclaration are the registry's natural key;
 * the identity is IMMUTABLE across a version chain (the
 * /lab-agent-body discipline) and the version chain is append-only
 * (corrections are NEW version rows, never in-place rewrites).
 */
/** §2 DECLARATION SURFACE 2 of 9 — the input requirements (validated deterministically at session open). */
export interface ContentStudioFormatInputRequirements {
  /** The §8 input modes this format accepts (a non-empty subset of the closed input-mode vocabulary). */
  readonly modes: ReadonlyArray<ContentStudioInputMode>;
  /** Whether source/reference artifacts are REQUIRED (§3 source/reference artifacts). */
  readonly sourceArtifacts: 'required' | 'optional';
  /**
   * §8 (STUDIO-003) — the OPTIONAL generated-input review requirement:
   * 'required' pins the explicit-confirmation gate (a session against
   * this format may enter RECORDING only with an APPROVED generated
   * script/question-graph for the request version — the structural
   * honor of "reviewable before recording when the format requires
   * explicit user confirmation"); ABSENT means 'not_required' (every
   * STUDIO-002 declaration and every materialized registry row is
   * unaffected — the smallest architecture-consistent extension of
   * the frozen nine-surface declaration, DISCLOSED in the runbook).
   */
  readonly generatedInputReview?: ContentStudioGeneratedInputReviewMode;
}

/**
 * §2 DECLARATION SURFACE 3 of 9 — the participant model (§6 the
 * single-person surface + §7 the multi-person participation grants;
 * the multi-account session surface itself is STUDIO-006).
 */
export interface ContentStudioFormatParticipantModel {
  /**
   * The §7 participant count bounds: min ≥ 1, max ≤ 16, min ≤ max.
   * A single-person format pins {1, 1}; a multi-person-capable
   * format declares the range it supports (the §7 multi-person
   * surface starts at 2).
   */
  readonly participants: { readonly min: number; readonly max: number };
  /** Whether human capture is required for production. */
  readonly humanCapture: 'required' | 'optional';
  /**
   * §7 — the participation grant model: exactly
   * 'explicit_grant_per_participant' when participants.max > 1 (every
   * participant joins through an explicit participation grant) and
   * 'single_scope' when participants.max = 1 (the §6 single-person
   * surface — the validation fences the pairing).
   */
  readonly participationGrants: ContentStudioParticipationGrantModel;
}

/** §2 DECLARATION SURFACE 4 of 9 — the capture requirements (§9 — modality-specific but format-neutral). */
export interface ContentStudioFormatCaptureRequirements {
  /** The capture modalities this format requires (a non-empty subset of the closed capture-modality vocabulary). */
  readonly modalities: ReadonlyArray<ContentStudioCaptureModality>;
}

/**
 * §2 DECLARATION SURFACE 5 of 9 — the interviewer requirements (§6 —
 * the representation construction options with provenance).
 */
export interface ContentStudioFormatInterviewerRequirements {
  /** 'none' when the format has no interviewer portion. */
  readonly interviewer: 'none' | 'representation';
  /** The declared representation forms (REQUIRED when interviewer is 'representation'; a non-empty subset of the closed vocabulary). */
  readonly representations?: ReadonlyArray<ContentStudioInterviewerRepresentation>;
  /** The §6 follow-up discipline (REQUIRED when interviewer is 'representation'). */
  readonly followUps?: ContentStudioInterviewerFollowUpMode;
}

/**
 * §2 DECLARATION SURFACE 6 of 9 — the organization compatibility
 * requirements (§4 — what the loaded organization must satisfy).
 */
export interface ContentStudioFormatOrganizationRequirements {
  /** The minimum number of Agent Body versions the organization must cite (1..32). */
  readonly minAgentBodies: number;
  /**
   * The action kinds the organization's bodies must COLLECTIVELY cover
   * — a subset of the CLOSED §14 action-kind vocabulary (the
   * migration-063 permissions fence; the closed-set comparison at
   * session open).
   */
  readonly requiredPermissions: ReadonlyArray<ContentStudioOrganizationPermission>;
  /**
   * The opaque capability references the organization must
   * collectively declare (optional; bounded opaque strings — the
   * capability ENGINE is /lab-capabilities (LAB-013), NEVER this
   * module; the declared references normalize into the
   * migration-068 format-capability link records).
   */
  readonly requiredCapabilities?: ReadonlyArray<string>;
}

/**
 * §2 DECLARATION SURFACE 7 of 9 — the output artifact contract (§12 —
 * the artifact kinds the format produces).
 */
export interface ContentStudioFormatOutputContract {
  /** The §12 artifact kinds this format can produce (a non-empty subset of the closed artifact-kind vocabulary; the request's output contract must be a subset). */
  readonly outputs: ReadonlyArray<ContentStudioOutputArtifactKind>;
}

/**
 * §2 DECLARATION SURFACE 8 of 9 — the provenance/consent requirements
 * (declared context, never evaluated here — the Rights/Policy
 * authorities decide; STUDIO-010 builds the records).
 */
export interface ContentStudioFormatProvenanceConsentRequirements {
  /** The consent kinds the format's production requires (a subset of the closed consent-kind vocabulary — declared data, the Rights authority evaluates). */
  readonly consent: ReadonlyArray<ContentStudioConsentKind>;
  /** The provenance chain the format's outputs must carry (a subset of the closed provenance-element vocabulary — declared data, STUDIO-010 builds the records). */
  readonly provenance: ReadonlyArray<ContentStudioProvenanceElement>;
}

/**
 * §2 DECLARATION SURFACE 9 of 9 — the evaluation hooks (hook
 * declarations only; the firings are DATA on the session event tail,
 * the evaluation is the caller's — the Lab verdicts are LAB-023,
 * never this module).
 */
export interface ContentStudioFormatEvaluationHooks {
  readonly hooks: ReadonlyArray<{
    /** The hook identity (1-64 chars of [a-z0-9-], unique within the declaration). */
    readonly hookId: string;
    /** The closed firing surface the hook attaches to. */
    readonly firesOn: ContentStudioEvaluationHookSurface;
    /** The declared stage the hook attaches to (REQUIRED when firesOn is 'stage_completion'; must be a declared processing stage). */
    readonly stageId?: string;
  }>;
}

/**
 * One declared processing stage (the durable §9 step plan a session
 * derives) with its HONEST AVAILABILITY state (the STUDIO-002 gap
 * disclosure as data: what the current runtime executes vs what a
 * future module owns).
 */
export interface ContentStudioProcessingStage {
  readonly stageId: string;
  readonly description?: string;
  /** The honest availability of this stage's execution (never an execution gate — a disclosure). */
  readonly availability: {
    readonly status: ContentStudioFormatAvailabilityState;
    /** The bounded citation of the owning future module (REQUIRED when status is 'awaiting_execution_module'). */
    readonly awaitingModule?: string;
  };
}

/**
 * §2 — the format declaration: EVERYTHING a format declares, as
 * bounded declared data — all NINE §2 declaration surfaces, each
 * closed-vocabulary-backed and one-level-shaped (the LAB-011
 * contract discipline), never runtime logic the format cannot
 * inspect. The runtime validates requests against the declaration;
 * the format IMPLEMENTATION (capture, interviewers, editing —
 * STUDIO-003..014) drives the durable steps through the
 * claim/complete surface. Adding a future format is a new
 * declaration through this seam — never a second Studio runtime.
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
 * audio podcast; video podcast") — the FULL §2 declarations
 * (STUDIO-002 promoted the STUDIO-001 minimal DATA to the complete
 * nine-surface field sets), wired by the composition root through the
 * SAME seam. The registry materializes them per CLIENT scope
 * (materialize-if-absent, born active through the guarded lifecycle)
 * on first resolution/listing — a tenant's own registry state (a
 * retirement, a corrected version) is never resurrected or
 * overwritten. The reaction/podcast EXECUTION implementations are
 * STUDIO-011/012/013 — never this module; each stage's honest
 * availability discloses which future module owns its real execution.
 */
export const CONTENT_STUDIO_INITIAL_FORMATS: ReadonlyArray<ContentStudioFormatDeclaration> = [
  {
    formatId: 'reaction',
    formatVersion: 1,
    inputRequirements: { modes: ['intent', 'script'], sourceArtifacts: 'required' },
    participantModel: { participants: { min: 1, max: 1 }, humanCapture: 'required', participationGrants: 'single_scope' },
    captureRequirements: { modalities: ['audio', 'video', 'screen'] },
    interviewerRequirements: { interviewer: 'none' },
    organizationRequirements: { minAgentBodies: 1, requiredPermissions: ['read', 'transform', 'compose'] },
    outputContract: { outputs: ['final_media'] },
    provenanceConsentRequirements: {
      consent: ['participant_recording_consent', 'source_artifact_rights'],
      provenance: ['source_reference', 'human_capture', 'transform_graph', 'treatment_lineage'],
    },
    evaluationHooks: { hooks: [{ hookId: 'reaction-quality-hook', firesOn: 'output_recorded' }] },
    processingStages: [
      {
        stageId: 'capture_ingestion',
        description: 'Ingest the raw human capture as an intermediate artifact.',
        availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-007' },
      },
      {
        stageId: 'organization_treatment',
        description: 'The loaded organization composes source + reaction.',
        availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-008' },
      },
      {
        stageId: 'output_assembly',
        description: 'Assemble the final media + provenance package.',
        availability: { status: 'runtime_driven' },
      },
    ],
  },
  {
    formatId: 'audio-podcast',
    formatVersion: 1,
    inputRequirements: { modes: ['script', 'question_list', 'intent'], sourceArtifacts: 'optional' },
    participantModel: { participants: { min: 1, max: 16 }, humanCapture: 'required', participationGrants: 'explicit_grant_per_participant' },
    captureRequirements: { modalities: ['audio', 'participant_streams', 'alternate_takes'] },
    interviewerRequirements: {
      interviewer: 'representation',
      representations: ['voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'multimodal_declared', 'hybrid'],
      followUps: 'adaptive',
    },
    organizationRequirements: { minAgentBodies: 1, requiredPermissions: ['read', 'compose'] },
    outputContract: { outputs: ['final_media', 'transcript'] },
    provenanceConsentRequirements: {
      consent: ['participant_recording_consent', 'interviewer_representation_disclosure', 'participant_contribution_rights'],
      provenance: [
        'question_answer_sequence',
        'interviewer_representation',
        'generated_vs_human_distinction',
        'recording',
        'participant_contribution',
        'transform_graph',
        'treatment_lineage',
      ],
    },
    evaluationHooks: {
      hooks: [
        { hookId: 'podcast-quality-hook', firesOn: 'output_recorded' },
        { hookId: 'interview-flow-hook', firesOn: 'stage_completion', stageId: 'interview_capture' },
      ],
    },
    processingStages: [
      {
        stageId: 'script_preparation',
        description: 'Prepare the versioned script/question graph from the supplied input.',
        availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-003' },
      },
      {
        stageId: 'interview_capture',
        description: 'Run the interview with the declared interviewer representation.',
        availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-004' },
      },
      {
        stageId: 'organization_treatment',
        description: 'The loaded organization edits/composes the raw capture.',
        availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-008' },
      },
      {
        stageId: 'output_assembly',
        description: 'Assemble the final audio + transcript + provenance package.',
        availability: { status: 'runtime_driven' },
      },
    ],
  },
  {
    formatId: 'video-podcast',
    formatVersion: 1,
    inputRequirements: { modes: ['script', 'question_list', 'intent'], sourceArtifacts: 'optional' },
    participantModel: { participants: { min: 1, max: 16 }, humanCapture: 'required', participationGrants: 'explicit_grant_per_participant' },
    captureRequirements: { modalities: ['audio', 'video', 'participant_streams', 'alternate_takes'] },
    interviewerRequirements: {
      interviewer: 'representation',
      representations: ['voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'multimodal_declared', 'hybrid'],
      followUps: 'adaptive',
    },
    organizationRequirements: { minAgentBodies: 1, requiredPermissions: ['read', 'compose', 'transform'] },
    outputContract: { outputs: ['final_media', 'transcript', 'captions_subtitles'] },
    provenanceConsentRequirements: {
      consent: ['participant_recording_consent', 'interviewer_representation_disclosure', 'participant_contribution_rights'],
      provenance: [
        'question_answer_sequence',
        'interviewer_representation',
        'generated_vs_human_distinction',
        'recording',
        'participant_contribution',
        'transform_graph',
        'treatment_lineage',
      ],
    },
    evaluationHooks: {
      hooks: [
        { hookId: 'podcast-quality-hook', firesOn: 'output_recorded' },
        { hookId: 'interview-flow-hook', firesOn: 'stage_completion', stageId: 'interview_capture' },
      ],
    },
    processingStages: [
      {
        stageId: 'script_preparation',
        description: 'Prepare the versioned script/question graph from the supplied input.',
        availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-003' },
      },
      {
        stageId: 'interview_capture',
        description: 'Run the interview with the declared interviewer representation.',
        availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-004' },
      },
      {
        stageId: 'organization_treatment',
        description: 'The loaded organization edits/composes the raw capture.',
        availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-008' },
      },
      {
        stageId: 'output_assembly',
        description: 'Assemble the final video + transcript + captions + provenance package.',
        availability: { status: 'runtime_driven' },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// §2 — THE FORMAT REGISTRY (STUDIO-002 — the versioned registry records)
// ---------------------------------------------------------------------------

/**
 * The public record view of one versioned format registry row
 * (migration 068's studio_formats): the format identity/version, the
 * CLIENT scope (the optional workspace anchor), the draft → active →
 * retired lifecycle status, the FULL §2 declaration as declared data
 * and the normalized capability link references (the
 * studio_format_capabilities link records). Identity and declaration
 * are immutable after insert; corrections are NEW version rows; the
 * registry never deletes — retirement only closes NEW resolutions.
 */
export interface ContentStudioFormatRecord {
  /** The server-generated opaque row identifier (the capability links' FK anchor). */
  readonly formatVersionId: string;
  readonly formatId: string;
  readonly formatVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly status: ContentStudioFormatStatus;
  readonly declaration: ContentStudioFormatDeclaration;
  /** The declared capability link references (the normalized requiredCapabilities — exactly the link records). */
  readonly capabilityLinks: ReadonlyArray<string>;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The registration input: a FULL §2 declaration, validated then inserted as a DRAFT version row. */
export interface RegisterContentStudioFormatInput {
  readonly scope: ContentStudioScope;
  readonly declaration: ContentStudioFormatDeclaration;
}

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
// §8 — the INTENT-TO-SCRIPT records (STUDIO-003 — the migration-070
// surfaces: the intent records, the versioned script/question-graph
// records, the review decisions, the conversation-graph hooks)
// ---------------------------------------------------------------------------

/**
 * §8 — the DECLARED QUESTION/BRANCH GRAPH: nodes are questions (each
 * with a bounded unique questionId + its text + the OPTIONAL closed
 * modality hints — the interviewer representation forms that may
 * deliver the question); edges are the declared branch conditions
 * (from/to endpoints that ARE declared nodes + one condition from the
 * closed 6-member vocabulary); the entry question starts every walk.
 * At most ONE edge per (fromQuestionId, condition) — the DETERMINISTIC
 * ADJACENCY (a follow-up chosen by condition resolves to exactly one
 * next question). One-level declared data (the LAB-011 contract
 * discipline) — never runtime logic.
 */
export interface ContentStudioDeclaredQuestionGraph {
  /** The declared entry question (a declared node — the conversation's first asked question). */
  readonly entryQuestionId: string;
  /** The declared question nodes (1..128, unique questionIds). */
  readonly nodes: ReadonlyArray<{
    /** The question identity (1-64 chars of [a-z0-9_-]; unique within the graph). */
    readonly questionId: string;
    /** The question text (1-2000 chars, trimmed). */
    readonly text: string;
    /** The OPTIONAL closed modality hints (a deduplicated subset of the 7-member interviewer representation vocabulary). */
    readonly modalityHints?: ReadonlyArray<ContentStudioQuestionModalityHint>;
  }>;
  /** The declared branch edges (0..256; unique (fromQuestionId, condition) pairs — the deterministic adjacency). */
  readonly edges: ReadonlyArray<{
    readonly fromQuestionId: string;
    readonly toQuestionId: string;
    readonly condition: ContentStudioBranchCondition;
  }>;
}

/**
 * §8 — the generation provenance (REQUIRED on every generated
 * script/question-graph record): the generator identity (the
 * organization version that generated the material, cited VERBATIM —
 * identity, version, the agent-body references and the capabilities it
 * declared at generation time) + the participating model/capability
 * references (OPAQUE strings — never resolved here; the /ai-runtime and
 * /lab-capabilities authorities stay the resolvers). No generated
 * material is ever presented without this record.
 */
export interface ContentStudioGeneratorProvenance {
  /** The organization version that generated the material (the §4 submitted-declaration shape, recorded verbatim). */
  readonly organization: ContentStudioOrganizationDeclaration;
  /** The OPAQUE model/capability references that participated in the generation (0..32 × 1..256 chars). */
  readonly modelReferences: ReadonlyArray<string>;
}

/** The public record view of one INTENT record (immutable — one per request version on the intent path). */
export interface ContentStudioIntentRecord {
  readonly intentId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly requestId: string;
  readonly requestVersion: number;
  /** The declared objective (§3 "declared objective" / §8 "an intent/objective"). */
  readonly objective: string;
  /** The OPTIONAL supplied source/reference material citations (§8 "an intent plus supplied source material") — OPAQUE strings. */
  readonly sourceReferences: ReadonlyArray<string>;
  readonly contractVersion: string;
  readonly createdAt: string;
}

/**
 * The public record view of one VERSIONED SCRIPT record. A SUPPLIED
 * script (origin 'supplied') carries no provenance and no review
 * state; a GENERATED script (origin 'generated') carries the FULL
 * provenance (the intent lineage + the generator identity + the
 * participating model/capability references) and the review state.
 */
export interface ContentStudioScriptRecord {
  readonly scriptId: string;
  readonly scriptVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly origin: ContentStudioScriptOrigin;
  /** The script body as declared data. */
  readonly body: Readonly<Record<string, unknown>>;
  /** The intent lineage (generated records only — which intent + source citations produced it). */
  readonly intentId: string | null;
  /** The generator organization identity (generated records only — recorded verbatim). */
  readonly generatorOrganization: ContentStudioOrganizationDeclaration | null;
  /** The participating model/capability references (generated records only — OPAQUE). */
  readonly generatorModelReferences: ReadonlyArray<string> | null;
  /** The review state (generated records only; supplied records carry none — user material is its own authority). */
  readonly reviewState: ContentStudioReviewState | null;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The public record view of one VERSIONED QUESTION-GRAPH record (the declared question/branch graph). */
export interface ContentStudioQuestionGraphRecord {
  readonly graphId: string;
  readonly graphVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly requestId: string;
  readonly requestVersion: number;
  readonly origin: ContentStudioScriptOrigin;
  /** The declared question/branch graph (nodes + edges + the entry question — the deterministic adjacency substrate). */
  readonly declaredGraph: ContentStudioDeclaredQuestionGraph;
  readonly intentId: string | null;
  readonly generatorOrganization: ContentStudioOrganizationDeclaration | null;
  readonly generatorModelReferences: ReadonlyArray<string> | null;
  readonly reviewState: ContentStudioReviewState | null;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The public record view of one append-only HUMAN-REVIEW DECISION record (scripts). */
export interface ContentStudioScriptReviewRecord {
  readonly reviewId: string;
  readonly scriptId: string;
  readonly scriptVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly verdict: ContentStudioReviewVerdict;
  /** The honest autonomous/human split: who made the decision. */
  readonly reviewerKind: ContentStudioReviewerKind;
  /** The OPAQUE reviewer actor identity. */
  readonly reviewerActor: string;
  readonly note: string | null;
  readonly decidedAt: string;
  readonly contractVersion: string;
  readonly createdAt: string;
}

/** The public record view of one append-only HUMAN-REVIEW DECISION record (question graphs). */
export interface ContentStudioQuestionGraphReviewRecord {
  readonly reviewId: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly verdict: ContentStudioReviewVerdict;
  readonly reviewerKind: ContentStudioReviewerKind;
  readonly reviewerActor: string;
  readonly note: string | null;
  readonly decidedAt: string;
  readonly contractVersion: string;
  readonly createdAt: string;
}

/**
 * The public record view of one CONVERSATION-GRAPH step (the adaptive-
 * branching hook surface): the question asked, the recorded answer
 * (the OPAQUE answer reference + the closed answer kind), the CHOSEN
 * declared edge (the follow-up chosen for the preceding answer + its
 * declared condition; null ends the conversation) and the honest
 * chooser split. The interviewer CHOICE MECHANICS are STUDIO-004 —
 * this surface is where the choices land as data.
 */
export interface ContentStudioConversationStepRecord {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly seq: number;
  /** The walked declared question-graph version (the exact version this conversation cites on every step). */
  readonly graphId: string;
  readonly graphVersion: number;
  /** The question asked this step (a declared node of the walked graph). */
  readonly questionId: string;
  /** The recorded answer: the OPAQUE answer reference (the capture/answer artifact). */
  readonly answerReference: string;
  readonly answerKind: ContentStudioAnswerKind;
  /** The chosen declared edge's target question (null when the conversation ends — no follow-up). */
  readonly chosenToQuestionId: string | null;
  /** The chosen declared edge's condition (null when the conversation ends). */
  readonly chosenCondition: ContentStudioBranchCondition | null;
  /** The honest chooser split: the adaptive interviewer (autonomous) vs an explicit human choice. */
  readonly chooserKind: ContentStudioChooserKind;
  readonly contractVersion: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// §8 — the INTENT-TO-SCRIPT module inputs (STUDIO-003)
// ---------------------------------------------------------------------------

/** Records the request's declared intent as the INTENT record (the generation-path lineage anchor; intent-only AND intent+source). */
export interface RecordContentStudioIntentInput {
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  /** The exact request version to materialize (defaults to the latest in scope). */
  readonly requestVersion?: number;
}

/** Records the request's supplied script as the VERSIONED SCRIPT chain v1 (the §3 path — recorded, versioned, no generation). */
export interface RecordContentStudioSuppliedScriptInput {
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  /** The exact request version to materialize (defaults to the latest in scope; its input mode must be 'script'). */
  readonly requestVersion?: number;
}

/** Appends a SUPPLIED script correction (a NEW immutable version row under the same chain id). */
export interface AppendContentStudioSuppliedScriptVersionInput {
  readonly scope: ContentStudioScope;
  readonly scriptId: string;
  /** The corrected script body (the full corrected script — never a mutation). */
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Records (or regenerates) the organization's GENERATED script for the
 * request version: a NEW immutable version row BORN 'pending' with the
 * FULL provenance; a regeneration supersedes the prior version
 * transactionally (the autonomous supersession decision rides the
 * append-only review tail).
 */
export interface RecordContentStudioGeneratedScriptInput {
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  /** The exact request version (defaults to the latest in scope; its input mode must be 'intent'). */
  readonly requestVersion?: number;
  /** The intent lineage (the materialized intent record for the SAME request version). */
  readonly intentId: string;
  /** The generated script body (the organization's output as declared data). */
  readonly body: Readonly<Record<string, unknown>>;
  /** The FULL generation provenance (the generator organization identity + the participating model/capability references). */
  readonly generator: ContentStudioGeneratorProvenance;
}

/** Reviews a GENERATED script version: the append-only decision + the guarded review-state advance (one transaction). */
export interface ReviewContentStudioScriptInput {
  readonly scope: ContentStudioScope;
  readonly scriptId: string;
  readonly scriptVersion: number;
  readonly verdict: ContentStudioReviewVerdict;
  readonly reviewerKind: ContentStudioReviewerKind;
  /** The OPAQUE reviewer actor identity (1-128 chars). */
  readonly reviewerActor: string;
  readonly note?: string;
}

/** The result of a review: the append-only decision record + the advanced script version. */
export interface ContentStudioScriptReviewResult {
  readonly decision: ContentStudioScriptReviewRecord;
  readonly script: ContentStudioScriptRecord;
}

/** Records the request's supplied question list as the DECLARED question-graph chain v1 (the deterministic linear graph). */
export interface RecordContentStudioSuppliedQuestionGraphInput {
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  /** The exact request version to materialize (defaults to the latest in scope; its input mode must be 'question_list'). */
  readonly requestVersion?: number;
}

/** Appends a SUPPLIED question-graph correction (a NEW immutable version row under the same chain id). */
export interface AppendContentStudioSuppliedQuestionGraphVersionInput {
  readonly scope: ContentStudioScope;
  readonly graphId: string;
  /** The corrected declared question/branch graph (the full corrected graph — never a mutation). */
  readonly declaredGraph: ContentStudioDeclaredQuestionGraph;
}

/**
 * Records (or regenerates) the organization's GENERATED question graph
 * for the request version: a NEW immutable version row BORN 'pending'
 * with the FULL provenance; a regeneration supersedes the prior
 * version transactionally.
 */
export interface RecordContentStudioGeneratedQuestionGraphInput {
  readonly scope: ContentStudioScope;
  readonly requestId: string;
  /** The exact request version (defaults to the latest in scope; its input mode must be 'intent'). */
  readonly requestVersion?: number;
  /** The intent lineage (the materialized intent record for the SAME request version). */
  readonly intentId: string;
  /** The generated declared question/branch graph (the organization's output as declared data). */
  readonly declaredGraph: ContentStudioDeclaredQuestionGraph;
  /** The FULL generation provenance. */
  readonly generator: ContentStudioGeneratorProvenance;
}

/** Reviews a GENERATED question-graph version: the append-only decision + the guarded review-state advance (one transaction). */
export interface ReviewContentStudioQuestionGraphInput {
  readonly scope: ContentStudioScope;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly verdict: ContentStudioReviewVerdict;
  readonly reviewerKind: ContentStudioReviewerKind;
  readonly reviewerActor: string;
  readonly note?: string;
}

/** The result of a question-graph review: the decision record + the advanced graph version. */
export interface ContentStudioQuestionGraphReviewResult {
  readonly decision: ContentStudioQuestionGraphReviewRecord;
  readonly graph: ContentStudioQuestionGraphRecord;
}

/**
 * Records one CONVERSATION-GRAPH step (the adaptive-branching hook
 * surface): the question asked + the recorded answer + the CHOSEN
 * declared edge for the follow-up. When conversationId is omitted a
 * NEW conversation starts (its first step MUST ask the walked graph's
 * declared entry question). Every step cites the walked declared
 * question-graph version bound to the session's request version; the
 * chosen edge MUST be a declared edge of that graph (the module + the
 * DB trigger both enforce it — the deterministic adjacency surface).
 */
export interface RecordContentStudioConversationStepInput {
  readonly scope: ContentStudioScope;
  readonly sessionId: string;
  /** The conversation to append to (omitted = a NEW conversation for the session's current revision). */
  readonly conversationId?: string;
  /** The question asked this step (a declared node; the FIRST step of a conversation asks the declared entry question). */
  readonly questionId: string;
  /** The recorded answer: the OPAQUE answer reference (the capture/answer artifact). */
  readonly answerReference: string;
  readonly answerKind: ContentStudioAnswerKind;
  /** The chosen follow-up (a DECLARED edge from the asked question); omit BOTH to end the conversation. */
  readonly chosenToQuestionId?: string;
  /** The declared condition of the chosen edge (REQUIRED with chosenToQuestionId). */
  readonly chosenCondition?: ContentStudioBranchCondition;
  /** The honest chooser split: the adaptive interviewer (autonomous) vs an explicit human choice. */
  readonly chooserKind: ContentStudioChooserKind;
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

  // --- The §2 FORMAT REGISTRY (STUDIO-002 — the versioned registry + the pluggable seam) ---

  /**
   * Registers a format version: validates the FULL §2 declaration
   * (the nine closed-vocabulary-backed surfaces) and inserts the
   * registry row as DRAFT (+ its format-capability link records,
   * transactionally). The version chain is append-only: registering
   * version n > 1 requires version n-1 in the same scope (the
   * /lab-agent-body correction discipline); a duplicate identity/
   * version is rejected — corrections are NEW version rows. THE
   * PLUGGABILITY SEAM: registering a future format here requires ZERO
   * changes to the Studio runtime (the deepened STUDIO-001 proof).
   */
  registerFormat(input: RegisterContentStudioFormatInput): Promise<ContentStudioFormatRecord>;
  /** Activates a DRAFT format version (draft → active — the only state whose versions resolve for NEW sessions). */
  activateFormat(scope: ContentStudioScope, formatId: string, formatVersion: number): Promise<ContentStudioFormatRecord>;
  /**
   * Retires an ACTIVE format version (active → retired): NEW session
   * resolutions refuse; RUNNING sessions never break (they carry the
   * bound format identity/version as their own recorded data, and the
   * registry never deletes — no resurrection, corrections are new
   * version rows).
   */
  retireFormat(scope: ContentStudioScope, formatId: string, formatVersion: number): Promise<ContentStudioFormatRecord>;
  /**
   * Resolves one registry record (any status; the uniform NotFound for
   * foreign/unknown scope — no existence oracle). The composition-root
   * wired initial formats materialize-if-absent on read.
   */
  getFormat(scope: ContentStudioScope, formatId: string, formatVersion: number): Promise<ContentStudioFormatRecord>;
  /**
   * Lists the tenant's registry records (every version row, any
   * status). The composition-root wired initial formats
   * materialize-if-absent on read (the frozen §2 out-of-the-box
   * availability); a tenant's own registry state is never
   * resurrected or overwritten.
   */
  listFormats(scope: ContentStudioScope): Promise<ReadonlyArray<ContentStudioFormatRecord>>;

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

  // --- The §8 INTENT-TO-SCRIPT pipeline (STUDIO-003 — the intents, the
  // versioned scripts/question graphs, the human review, the
  // conversation-graph hooks) ---

  /**
   * Materializes the request version's declared intent (+ its supplied
   * source/reference citations) as the IMMUTABLE INTENT record — the
   * generation-path lineage anchor (one per request version; the
   * request's input mode must be 'intent').
   */
  recordIntent(input: RecordContentStudioIntentInput): Promise<ContentStudioIntentRecord>;
  /** Resolves one intent record (the uniform NotFound for foreign/unknown scope — no existence oracle). */
  getIntent(scope: ContentStudioScope, intentId: string): Promise<ContentStudioIntentRecord>;
  /** Resolves the intent record materialized for one request version (if any). */
  getIntentForRequest(scope: ContentStudioScope, requestId: string, requestVersion?: number): Promise<ContentStudioIntentRecord | null>;

  /**
   * Records the request's SUPPLIED complete script as the versioned
   * script chain v1 (the §3 path — recorded, versioned, NO generation,
   * NO review state; the request's input mode must be 'script').
   */
  recordSuppliedScript(input: RecordContentStudioSuppliedScriptInput): Promise<ContentStudioScriptRecord>;
  /** Appends a SUPPLIED script correction (a NEW immutable version row under the same chain id). */
  appendSuppliedScriptVersion(input: AppendContentStudioSuppliedScriptVersionInput): Promise<ContentStudioScriptRecord>;
  /**
   * Records (or regenerates) the organization's GENERATED script — a
   * NEW version row BORN 'pending' with the FULL provenance (the
   * intent lineage + the generator organization identity + the
   * participating model/capability references); a regeneration
   * supersedes the prior version transactionally.
   */
  recordGeneratedScript(input: RecordContentStudioGeneratedScriptInput): Promise<ContentStudioScriptRecord>;
  /** Reviews a GENERATED script version: the append-only decision + the guarded review-state advance (one transaction). */
  reviewScript(input: ReviewContentStudioScriptInput): Promise<ContentStudioScriptReviewResult>;
  /** Resolves one script version (or the chain's latest when scriptVersion is omitted; the uniform tenant fence). */
  getScript(scope: ContentStudioScope, scriptId: string, scriptVersion?: number): Promise<ContentStudioScriptRecord>;
  /** Lists the chain's version rows (oldest first). */
  listScriptVersions(scope: ContentStudioScope, scriptId: string): Promise<ReadonlyArray<ContentStudioScriptRecord>>;
  /** Resolves the script chain's latest version for one request version (if any). */
  getScriptForRequest(scope: ContentStudioScope, requestId: string, requestVersion?: number): Promise<ContentStudioScriptRecord | null>;
  /** Lists the chain's append-only review decisions (oldest first). */
  listScriptReviews(scope: ContentStudioScope, scriptId: string): Promise<ReadonlyArray<ContentStudioScriptReviewRecord>>;

  /** Records the request's SUPPLIED question list as the DECLARED question-graph chain v1 (the deterministic linear graph). */
  recordSuppliedQuestionGraph(input: RecordContentStudioSuppliedQuestionGraphInput): Promise<ContentStudioQuestionGraphRecord>;
  /** Appends a SUPPLIED question-graph correction (a NEW immutable version row under the same chain id). */
  appendSuppliedQuestionGraphVersion(input: AppendContentStudioSuppliedQuestionGraphVersionInput): Promise<ContentStudioQuestionGraphRecord>;
  /** Records (or regenerates) the organization's GENERATED question graph — born 'pending' with the FULL provenance. */
  recordGeneratedQuestionGraph(input: RecordContentStudioGeneratedQuestionGraphInput): Promise<ContentStudioQuestionGraphRecord>;
  /** Reviews a GENERATED question-graph version: the append-only decision + the guarded review-state advance (one transaction). */
  reviewQuestionGraph(input: ReviewContentStudioQuestionGraphInput): Promise<ContentStudioQuestionGraphReviewResult>;
  /** Resolves one question-graph version (or the chain's latest when graphVersion is omitted; the uniform tenant fence). */
  getQuestionGraph(scope: ContentStudioScope, graphId: string, graphVersion?: number): Promise<ContentStudioQuestionGraphRecord>;
  /** Lists the chain's version rows (oldest first). */
  listQuestionGraphVersions(scope: ContentStudioScope, graphId: string): Promise<ReadonlyArray<ContentStudioQuestionGraphRecord>>;
  /** Resolves the question-graph chain's latest version for one request version (if any). */
  getQuestionGraphForRequest(scope: ContentStudioScope, requestId: string, requestVersion?: number): Promise<ContentStudioQuestionGraphRecord | null>;
  /** Lists the chain's append-only review decisions (oldest first). */
  listQuestionGraphReviews(scope: ContentStudioScope, graphId: string): Promise<ReadonlyArray<ContentStudioQuestionGraphReviewRecord>>;

  /**
   * Records one CONVERSATION-GRAPH step (the adaptive-branching hook
   * surface): the question asked, the recorded answer and the CHOSEN
   * declared edge — validated against the declared question-graph
   * version bound to the session's request version. The interviewer
   * CHOICE MECHANICS are STUDIO-004's; this surface is where every
   * choice lands as preserved data (§8 "preserving the resulting
   * conversation graph").
   */
  recordConversationStep(input: RecordContentStudioConversationStepInput): Promise<ContentStudioConversationStepRecord>;
  /** Lists the session's conversation steps (every conversation, ordered by conversation + seq — the resulting conversation graph as data). */
  listConversationSteps(scope: ContentStudioScope, sessionId: string): Promise<ReadonlyArray<ContentStudioConversationStepRecord>>;
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
  assertValidContentStudioDeclaredQuestionGraph,
  assertValidContentStudioGeneratorProvenance,
  assertValidContentStudioReviewDecision,
  assertValidContentStudioConversationChoice,
  deriveLinearQuestionGraph,
} from './internal/validation.ts';
