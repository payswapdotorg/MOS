/**
 * MarketingOS module: /jobs
 * Authority: Human Job lifecycle (spec/implementation-contract.md §1).
 *
 * MKT-026 implements the JOB MARKETPLACE BOUNDARY (work-items.md: "project
 * eligible human Tasks into Jobs with offers, acceptance, decline and
 * expiry while preserving Workflow authority"; JOB-001; JOB-AC-01..03;
 * spec/job-offer-v1.2.md; spec/human-agent-v1.3.md §3/§4; architecture.md
 * §13 "Jobs are governed projections of Tasks using candidate-specific
 * Offers and the existing concurrency-safe acceptance contract").
 *
 * This module owns:
 *
 *   - the JOB: a governed PROJECTION of exactly ONE Task occurrence — the
 *     logical Task coordinates (workflow instance + node within the
 *     instance's pinned definition). The reference is FK-backed to the
 *     workflow-authoritative instance row and DB-fenced by the UNIQUE
 *     (workflow_instance_id, node_id) task key ("A Job represents exactly
 *     one Task projection", implementation-clarifications-v1.2.md), the
 *     task-reference trigger (human_task node of a RUNNING instance) and
 *     the scope-chain trigger (the Job's scope IS the Task's
 *     server-derived scope — every Job is scoped to exactly one
 *     commissioning Agency and Client, architecture.md §13);
 *   - the Job status machine projected → offered → accepted | declined |
 *     expired, accepted → outcome_submitted (edge-for-edge in code AND in
 *     migration 023); declined/expired/outcome_submitted are TERMINAL;
 *   - CANDIDATE-SPECIFIC OFFERS (job-offer-v1.2.md): one Offer row per
 *     (Job, candidate Human Agent) with an immutable expiry contract, the
 *     open → accepted | declined | expired | withdrawn per-offer machine
 *     (terminal states frozen), and the EXACTLY-ONE-WINNER partial unique
 *     fence — the storage end of the concurrency-safe acceptance claim;
 *   - ACCEPTANCE as a concurrency-safe claim (JOB-AC-02): one row-locked
 *     transaction (lock the Job, lock the Offer, decide, apply) with the
 *     database fence as the race backstop. Repeated acceptance of the SAME
 *     offer by the SAME agent converges idempotently (replay, never an
 *     error); acceptance of a DIFFERENT offer after the Job has been
 *     claimed is a clean ConflictError — losing offers terminalize as
 *     expired and can never later claim; decline and expiry are terminal
 *     per-offer, and declining never affects the underlying Task;
 *   - the SUBMITTED OUTCOME (JOB-AC-03): the accepted agent reports
 *     succeeded | failed with an optional opaque payload reference and a
 *     REQUIRED evidence reference validated through the /evidence public
 *     contract (same-Client, uniform 404). Actor + provenance are
 *     SERVER-DERIVED and PRESERVED on an append-only, one-per-job outcome
 *     row: recorded_actor, recorded_via, correlation_id, causation_id,
 *     submitted_by, submitted_at. UNKNOWN outcomes stay unresolved — a
 *     Job without a submitted outcome simply has no outcome record; the
 *     module never fabricates or defaults one;
 *   - the ELIGIBILITY-GATED marketplace listing (human-agent-v1.3.md §3):
 *     a Job exposes only the minimum data required, and eligibility is
 *     evaluated BEFORE any Client-specific detail is exposed — the
 *     listing surface returns job DESCRIPTORS (title, description and the
 *     profile-data-only eligibility requirements — never Client, Agency,
 *     Workspace or Task identifiers) to ELIGIBLE agents only, computed by
 *     the merged /field-agents pure matcher from PROFILE DATA ONLY.
 *
 * What this module deliberately does NOT do (the frozen boundary —
 * "preserving Workflow authority", JOB-001 "without creating a second
 * workflow engine"):
 *   - it NEVER owns workflow state: no graph, no node/edge semantics, no
 *     node-instance bookkeeping, no scheduling of downstream work. The
 *     /workflows public contract is consumed READ-ONLY (instance and
 *     pinned-definition reads for Task-reference validation; ownership
 *     resolution) — the module never calls transitionWorkflowInstance and
 *     never mutates instance state. The submitted outcome is REPORTED as
 *     the durable outcome record referencing the governed Task
 *     coordinates (plus the observed instance status at report time,
 *     reported_instance_status); the workflow authority decides what to
 *     do with the report — that decision arrives with the Work Item that
 *     owns task-completion interpretation, never here. (The /workflows
 *     public surface at base c4edcf2 exposes no task-outcome report port;
 *     commanding an instance transition from a job outcome would make
 *     /jobs own a workflow state transition — forbidden.)
 *   - it is NOT a second Task/Execution authority: the Task coordinates
 *     are REFERENCE data resolved through /workflows; executions are the
 *     /executions authority (imported by nobody here);
 *   - no relationship continuity (JOB-AC-04 is a later Work Item), no
 *     field execution evidence flows (MKT-027 owns evidence capture), no
 *     work-queue UI (MKT-031), no payment, no matching policy beyond the
 *     frozen profile-only eligibility matcher;
 *   - no secrets in domain records, no provider SDKs.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * dependency matrix: /jobs ──→ /workflows, /executions, /field-agents,
 * /clients, /evidence, /policies (this Work Item consumes exactly
 * /workflows + /field-agents + /evidence). Authorization composition
 * stays at the route layer exactly like MKT-003/004/005/025: the frozen
 * matrix gives /jobs no /agencies dependency, so agency membership is
 * composed by ROUTES, never re-imported here.
 *
 * MKT-027 (Field execution and evidence — JOB-001 field subset + EVID-001
 * field subset; JOB-AC-03..04; EVID-AC-01..03 field subset) EXTENDS this
 * same module with the FIELD EXECUTION surface (spec/work-items.md
 * "enable visit/field execution, structured outcomes, evidence capture,
 * follow-up and continuity"). This module additionally owns:
 *
 *   - the VISIT: the /jobs-owned field execution record of ONE accepted
 *     Job — planned → in_progress → completed | cancelled (frozen machine,
 *     terminal states immutable). A visit exists only inside the
 *     acceptance window (the job is 'accepted'), belongs to exactly ONE
 *     Job, and its scope chain (workspace/client/agency) is INHERITED
 *     from the Job — never caller-provided (DB-fenced by the migration-024
 *     scope-chain trigger). Only the job's ACCEPTED agent may open or
 *     transition a visit (the server-derived actor). Visits are NOT a
 *     second workflow/execution engine: they carry no task linkage of
 *     their own (the Task reference stays on the Job), no dispatch/queue/
 *     sandbox/runtime semantics and no downstream scheduling — /workflows
 *     stays the single workflow authority and /jobs still never mutates
 *     instance state;
 *   - the append-only VISIT TRANSITION HISTORY with full server-derived
 *     provenance on every applied lifecycle event;
 *   - the STRUCTURED VISIT OUTCOME (JOB-AC-03 field subset): a frozen
 *     field-result vocabulary (succeeded | partial | no_contact | failed),
 *     an explicit follow_up_required declaration, bounded notes, a
 *     structured observations payload (non-empty JSON object) and a
 *     REQUIRED evidence reference validated through the /evidence public
 *     contract (same-Client, uniform 404) — append-only, exactly one per
 *     visit, with actor + provenance SERVER-DERIVED and PRESERVED;
 *   - FIELD EVIDENCE CAPTURE: the accepted agent appends /evidence
 *     records THROUGH this module's surface with a server-derived scope
 *     (the job's Client/Workspace — never caller input) and server-derived
 *     provenance (recordedVia 'field-agent', causation the visit id).
 *     Human-submitted observations are actor-attributed submissions
 *     (human-agent-v1.3.md §5): the submitting agent can never
 *     self-authorize provenance promotion or causal conclusions — there
 *     is NO class-mutation path anywhere in this module, so claims stay
 *     claims (EVID-AC-03);
 *   - FOLLOW-UP: a visit may declare follow_up_of_visit_id — the prior
 *     COMPLETED visit of the SAME relationship it follows up on
 *     (DB-fenced);
 *   - CONTINUITY (JOB-AC-04): the derived relationship chain — the prior
 *     COMPLETED visits of the same (agency, client, target identity). It
 *     is DERIVED data (a read; history is never rewritten) and it is
 *     gated by the EXISTING policy checkpoint: the merged /field-agents
 *     profile relationship-continuity block (the single pure predicate
 *     visitContinuityExposedToAgent is the swap point for the future
 *     /policies authority — MKT-021; NO second policy engine is created
 *     here). The commissioning side always sees the full chain through
 *     its client scope.
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type {
  FieldAgentsModuleApi,
  JobEligibilitySpec,
  RelationshipContinuity,
} from '../field-agents/public.ts';
import type {
  WorkflowAgencySummary,
  WorkflowClientRow,
  WorkflowInstanceRecord,
  WorkflowInstanceStatus,
  WorkflowOwnerContext,
  WorkflowsModuleApi,
} from '../workflows/public.ts';

/**
 * The Workspace row as reached THROUGH the /workflows canonical owner
 * context — the frozen dependency matrix (/jobs ──→ /workflows, …) gives
 * /jobs no direct /workspaces dependency, so the Job owner context
 * composes exactly the rows the /workflows authority already resolved
 * (the WorkflowClientRow/WorkflowAgencySummary pattern).
 */
export type JobWorkspaceRow = WorkflowOwnerContext['workspace'];

// ---------------------------------------------------------------------------
// Job status machine (the frozen MKT-026 lifecycle)
// ---------------------------------------------------------------------------

/**
 * The frozen Job lifecycle:
 *
 *   projected → offered → accepted | declined | expired
 *               accepted → outcome_submitted
 *
 * `projected`: the Task projection exists, no offer yet. `offered`: at
 * least one candidate-specific offer exists. Exactly one winning
 * acceptance moves the Job to `accepted`; `declined`/`expired` record the
 * round closing with no winner (every offer terminal); `outcome_submitted`
 * records the accepted agent's reported outcome. `declined`, `expired` and
 * `outcome_submitted` are TERMINAL (frozen history; re-projection and
 * relationship continuity are later Work Items — MKT-026 is the boundary).
 */
export type JobStatus =
  | 'projected'
  | 'offered'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'outcome_submitted';

export const JOB_STATUSES: readonly JobStatus[] = [
  'projected',
  'offered',
  'accepted',
  'declined',
  'expired',
  'outcome_submitted',
];

/** The frozen transition table (exhaustive; unit-tested byte for byte). */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  projected: ['offered'],
  offered: ['accepted', 'declined', 'expired'],
  accepted: ['outcome_submitted'],
  declined: [],
  expired: [],
  outcome_submitted: [],
};

export function isLegalJobTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = ['declined', 'expired', 'outcome_submitted'];

export function isTerminalJobStatus(status: JobStatus): boolean {
  return JOB_TERMINAL_STATUSES.includes(status);
}

/** Job statuses from which new offers may be created (the open round). */
export const JOB_OFFERABLE_STATUSES: readonly JobStatus[] = ['projected', 'offered'];

// ---------------------------------------------------------------------------
// Offer status machine (job-offer-v1.2.md)
// ---------------------------------------------------------------------------

/**
 * The per-offer lifecycle: open → accepted | declined | expired |
 * withdrawn, and nothing else. Every terminal state is FROZEN history —
 * "losing offers … cannot later claim the Job"; decline and expiry are
 * terminal per-offer.
 */
export type OfferStatus = 'open' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

export const OFFER_STATUSES: readonly OfferStatus[] = [
  'open',
  'accepted',
  'declined',
  'expired',
  'withdrawn',
];

export const OFFER_TRANSITIONS: Readonly<Record<OfferStatus, readonly OfferStatus[]>> = {
  open: ['accepted', 'declined', 'expired', 'withdrawn'],
  accepted: [],
  declined: [],
  expired: [],
  withdrawn: [],
};

export function isLegalOfferTransition(from: OfferStatus, to: OfferStatus): boolean {
  return OFFER_TRANSITIONS[from].includes(to);
}

export const OFFER_TERMINAL_STATUSES: readonly OfferStatus[] = [
  'accepted',
  'declined',
  'expired',
  'withdrawn',
];

export function isTerminalOfferStatus(status: OfferStatus): boolean {
  return OFFER_TERMINAL_STATUSES.includes(status);
}

/**
 * Why an offer reached its terminal state (DB-fenced vocabulary):
 * `claimed` — the winning acceptance; `declined` — the candidate declined;
 * `expiry` — the immutable expiry passed; `lost` — a different offer won
 * the job (losing offers can never later claim); `withdrawn` — the
 * commissioning side withdrew it.
 */
export type OfferTerminalReason = 'claimed' | 'declined' | 'expiry' | 'lost' | 'withdrawn';

export const OFFER_TERMINAL_REASONS: readonly OfferTerminalReason[] = [
  'claimed',
  'declined',
  'expiry',
  'lost',
  'withdrawn',
];

/** The terminal reason recorded with the offer status (null while open). */
export const OFFER_STATUS_TERMINAL_REASONS: Readonly<Record<OfferStatus, OfferTerminalReason | null>> = {
  open: null,
  accepted: 'claimed',
  declined: 'declined',
  expired: 'expiry',
  withdrawn: 'withdrawn',
};

// ---------------------------------------------------------------------------
// Job descriptor (the minimum data a Job exposes — human-agent-v1.3.md §3)
// ---------------------------------------------------------------------------

/**
 * The projection input: the public descriptor (title/description — NO
 * Client-specific data) plus the profile-data-only eligibility
 * specification the /field-agents matcher evaluates. The descriptor is
 * IMMUTABLE after projection (DB trigger).
 */
export interface JobDescriptor {
  readonly title: string;
  readonly description: string;
  readonly eligibility: JobEligibilitySpec;
}

/** Maximum offer expiry horizon from creation (the bounded window). */
export const MAX_OFFER_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Pure validation of a Job projection (single source of truth for the
 * JOB-AC-01 descriptor shape; the module throws InvalidRequestError with
 * these problems, migration 023 backstops the type/cardinality fences).
 * Returns the list of problems (empty = valid).
 */
export function validateJobProjection(input: {
  readonly title: string;
  readonly description: string;
  readonly eligibility: JobEligibilitySpec;
}): ReadonlyArray<string> {
  const problems: string[] = [];

  if (typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > 200) {
    problems.push('title: must be 1..200 characters (trimmable)');
  }
  if (typeof input.description !== 'string' || input.description.length > 2000) {
    problems.push('description: must be a string of at most 2000 characters');
  }

  const spec = input.eligibility;
  if (spec === null || typeof spec !== 'object') {
    problems.push('eligibility: must be a job eligibility specification');
    return problems;
  }
  if (
    spec.specialization === undefined ||
    !(JOB_ELIGIBILITY_SPECIALIZATIONS as readonly string[]).includes(spec.specialization)
  ) {
    problems.push(`eligibility.specialization: unknown specialization '${String(spec.specialization)}'`);
  }
  if (spec.requiredCapabilities === undefined || !Array.isArray(spec.requiredCapabilities)) {
    problems.push('eligibility.requiredCapabilities: must be an array of skill tags');
  } else {
    if (spec.requiredCapabilities.length > 50) {
      problems.push('eligibility.requiredCapabilities: must contain at most 50 entries');
    }
    const seen = new Set<string>();
    for (const skill of spec.requiredCapabilities) {
      if (typeof skill !== 'string' || !SKILL_PATTERN.test(skill)) {
        problems.push(`eligibility.requiredCapabilities: '${String(skill)}' is not a valid normalized skill tag`);
      }
      if (seen.has(skill)) {
        problems.push(`eligibility.requiredCapabilities: duplicate skill '${skill}'`);
      }
      seen.add(skill);
    }
  }
  if (spec.territory !== null && spec.territory !== undefined) {
    const territory = spec.territory;
    if (territory === null || typeof territory !== 'object') {
      problems.push('eligibility.territory: must be null or a territory object');
    } else {
      if (!(JOB_ELIGIBILITY_TERRITORY_KINDS as readonly string[]).includes(territory.kind)) {
        problems.push(`eligibility.territory: '${String(territory.kind)}' is not a valid territory kind`);
      }
      if (typeof territory.value !== 'string' || !TERRITORY_VALUE_PATTERN.test(territory.value)) {
        problems.push('eligibility.territory: value must be 1..100 characters (letters, digits, spaces, commas, dots, dashes)');
      }
    }
  } else if (spec.territory === undefined) {
    problems.push('eligibility.territory: must be null or a territory object');
  }
  const window = spec.availability;
  if (window === undefined || window === null || typeof window !== 'object') {
    problems.push('eligibility.availability: must be an availability window');
  } else {
    const dayOk =
      Number.isSafeInteger(window.dayOfWeek) && window.dayOfWeek >= 0 && window.dayOfWeek <= 6;
    if (!dayOk) {
      problems.push('eligibility.availability.dayOfWeek: must be an integer 0 (Sunday) to 6 (Saturday)');
    }
    const startOk =
      Number.isSafeInteger(window.startMinute) && window.startMinute >= 0 && window.startMinute < 1440;
    const endOk =
      Number.isSafeInteger(window.endMinute) && window.endMinute > 0 && window.endMinute <= 1440;
    if (!startOk) problems.push('eligibility.availability.startMinute: must be an integer 0..1439');
    if (!endOk) problems.push('eligibility.availability.endMinute: must be an integer 1..1440');
    if (startOk && endOk && window.startMinute >= window.endMinute) {
      problems.push('eligibility.availability.startMinute: must be before endMinute');
    }
  }
  return problems;
}

/**
 * Pure validation of an offer expiry (the bounded future window). Returns
 * the list of problems (empty = valid).
 */
export function validateOfferExpiry(
  expiresAtIso: string,
  nowIso: string,
): ReadonlyArray<string> {
  const problems: string[] = [];
  const expiresAt = Date.parse(expiresAtIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(expiresAt)) {
    problems.push('expiresAt: must be an ISO-8601 timestamp');
    return problems;
  }
  if (Number.isNaN(now)) {
    problems.push('now: must be an ISO-8601 timestamp');
    return problems;
  }
  if (expiresAt <= now) {
    problems.push('expiresAt: must be in the future');
  }
  if (expiresAt - now > MAX_OFFER_TTL_MS) {
    problems.push(`expiresAt: must be at most ${MAX_OFFER_TTL_MS}ms after now`);
  }
  return problems;
}

// The frozen vocabularies the eligibility spec draws from (mirrors of the
// /field-agents public registries — kept as local pattern constants so this
// module never imports /field-agents internals; tests pin the registries
// and patterns stay in sync with the frozen spec).
const JOB_ELIGIBILITY_SPECIALIZATIONS = [
  'field_agent',
  'chatter',
  'creator_manager',
  'content_manager',
  'growth_manager',
  'account_manager',
  'reviewer',
  'sales_agent',
] as const;
const JOB_ELIGIBILITY_TERRITORY_KINDS = ['country', 'region', 'city', 'postal_area'] as const;
const SKILL_PATTERN = /^[a-z][a-z0-9_]{1,48}$/;
const TERRITORY_VALUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ,.-]{0,99}$/;

// ---------------------------------------------------------------------------
// Durable records
// ---------------------------------------------------------------------------

/** Immutable storage shape of one persisted Job (the Task projection). */
export interface JobRecord {
  readonly jobId: string;
  /** The governed Task reference (JOB-AC-01): the workflow-authoritative instance. */
  readonly workflowInstanceId: string;
  /** The human_task node within the instance's pinned definition. */
  readonly nodeId: string;
  /** Server-derived from the Task instance's canonical owner at projection. */
  readonly workspaceId: string;
  /** Server-derived from the Task instance's canonical owner at projection. */
  readonly clientId: string;
  /** Server-derived from the Task instance's canonical owner at projection. */
  readonly agencyId: string;
  readonly title: string;
  readonly description: string;
  readonly eligibility: JobEligibilitySpec;
  readonly status: JobStatus;
  /** The winning claim — present exactly in accepted/outcome_submitted. */
  readonly acceptedAgentId: string | null;
  readonly acceptedUserId: string | null;
  readonly acceptedOfferId: string | null;
  readonly acceptedAt: string | null;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Immutable storage shape of one persisted candidate-specific Offer. */
export interface JobOfferRecord {
  readonly jobOfferId: string;
  readonly jobId: string;
  /** The candidate Human Agent profile this Offer is addressed to. */
  readonly candidateAgentId: string;
  /** Server-derived from the candidate profile's platform identity link. */
  readonly candidateUserId: string;
  readonly status: OfferStatus;
  readonly terminalReason: OfferTerminalReason | null;
  /** The immutable expiry contract (an open offer past this time is expired). */
  readonly expiresAt: string;
  readonly acceptedAt: string | null;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Outcome provenance (SERVER-DERIVED — the dimension callers never supply)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of a submitted outcome (JOB-AC-03). Built
 * exclusively by server code from the authenticated principal, the ambient
 * correlation context and the module clock — never from a request body
 * (route validation rejects provenance-shaped authority fields; this type
 * is a separate module-API argument so no DTO can feed it structurally,
 * the /evidence provenance pattern).
 */
export interface JobOutcomeProvenance {
  /** Server-derived actor label: 'user:<uuid>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api'). */
  readonly recordedVia: string;
  /** Correlation identity of the logical flow that submitted the outcome. */
  readonly correlationId: string;
  /** Causation identity (the job id) when the submission was worker-caused. */
  readonly causationId: string | null;
}

/** Provenance block as persisted on the immutable outcome record. */
export interface JobOutcomeRecordedProvenance extends JobOutcomeProvenance {
  /** The accepted agent's platform user (server-derived from the principal). */
  readonly submittedBy: string | null;
  /** Server-stamped submission time (module clock, never caller input). */
  readonly submittedAt: string;
}

/** One immutable, append-only submitted outcome. */
export interface JobOutcomeRecord {
  readonly jobOutcomeId: string;
  readonly jobId: string;
  readonly outcome: 'succeeded' | 'failed';
  /** Opaque reference to a durable payload artifact (null when none). */
  readonly payloadRef: string | null;
  /** The /evidence record backing the outcome (same-Client, DB-fenced). */
  readonly evidenceRef: string;
  /** The workflow instance status observed at report time (the report context). */
  readonly reportedInstanceStatus: WorkflowInstanceStatus;
  readonly provenance: JobOutcomeRecordedProvenance;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Pure claim/settlement decisions (single-sourced semantics; unit-tested)
// ---------------------------------------------------------------------------

/**
 * The outcome of evaluating an ACCEPT request against the durable offer
 * and job state (pure — the module applies what this decides):
 *
 *   - `replay` — the offer is already accepted; because offers are
 *     candidate-specific and the caller is verified to BE the candidate,
 *     this is the SAME agent re-accepting the SAME offer: it converges to
 *     the recorded outcome with no state change (JOB-AC-02 replay);
 *   - `claim` — an open, unexpired offer on an offerable Job: claim it;
 *   - `offer-expired` — the offer is open but its immutable expiry has
 *     passed: terminalize it as expired (reason 'expiry') and conflict;
 *   - `offer-terminal` — the offer is declined/expired/withdrawn: terminal
 *     per-offer, conflict (losing offers can never later claim);
 *   - `job-unavailable` — the Job is not offerable (already accepted by a
 *     different offer, or its round closed): a clean conflict — never a
 *     partial state.
 */
export type OfferAcceptDecision =
  | { readonly kind: 'replay' }
  | { readonly kind: 'claim' }
  | { readonly kind: 'offer-expired' }
  | { readonly kind: 'offer-terminal'; readonly status: OfferStatus }
  | { readonly kind: 'job-unavailable'; readonly status: JobStatus };

export function evaluateOfferAccept(input: {
  readonly offerStatus: OfferStatus;
  readonly offerExpiresAt: string;
  readonly jobStatus: JobStatus;
  readonly nowIso: string;
}): OfferAcceptDecision {
  if (input.offerStatus === 'accepted') return { kind: 'replay' };
  if (isTerminalOfferStatus(input.offerStatus)) {
    return { kind: 'offer-terminal', status: input.offerStatus };
  }
  // offerStatus === 'open'
  if (Date.parse(input.offerExpiresAt) <= Date.parse(input.nowIso)) {
    return { kind: 'offer-expired' };
  }
  if (!(JOB_OFFERABLE_STATUSES as readonly JobStatus[]).includes(input.jobStatus)) {
    return { kind: 'job-unavailable', status: input.jobStatus };
  }
  return { kind: 'claim' };
}

/**
 * The outcome of evaluating a DECLINE request (pure). Declining is the
 * candidate's per-offer right and never affects the underlying Task; a
 * replay of an already-declined offer converges (JOB-AC-02 idempotent
 * decline); an accepted offer cannot be declined (the claim stands);
 * an expired offer is already terminal.
 */
export type OfferDeclineDecision =
  | { readonly kind: 'replay' }
  | { readonly kind: 'decline' }
  | { readonly kind: 'offer-expired' }
  | { readonly kind: 'offer-terminal'; readonly status: OfferStatus }
  | { readonly kind: 'job-unavailable'; readonly status: JobStatus };

export function evaluateOfferDecline(input: {
  readonly offerStatus: OfferStatus;
  readonly offerExpiresAt: string;
  readonly jobStatus: JobStatus;
  readonly nowIso: string;
}): OfferDeclineDecision {
  if (input.offerStatus === 'declined') return { kind: 'replay' };
  if (isTerminalOfferStatus(input.offerStatus)) {
    return { kind: 'offer-terminal', status: input.offerStatus };
  }
  // offerStatus === 'open'
  if (Date.parse(input.offerExpiresAt) <= Date.parse(input.nowIso)) {
    return { kind: 'offer-expired' };
  }
  if (!(JOB_OFFERABLE_STATUSES as readonly JobStatus[]).includes(input.jobStatus)) {
    return { kind: 'job-unavailable', status: input.jobStatus };
  }
  return { kind: 'decline' };
}

/**
 * Pure settlement rule: after an offer changed state, does the JOB's round
 * close? Returns the job transition to apply, or null when the round is
 * still open (open offers remain) or a winner exists (the claim path owns
 * the accepted transition). The round closes with `declined` when EVERY
 * offer was declined, and with `expired` when every offer is terminal with
 * no winner and at least one non-declined terminal (expiry/withdrawn/lost).
 */
export function jobStatusAfterSettlement(counts: {
  readonly open: number;
  readonly accepted: number;
  readonly declined: number;
  readonly expired: number;
  readonly withdrawn: number;
}): 'declined' | 'expired' | null {
  const total = counts.open + counts.accepted + counts.declined + counts.expired + counts.withdrawn;
  if (total === 0) return null;
  if (counts.open > 0 || counts.accepted > 0) return null;
  if (counts.declined === total) return 'declined';
  return 'expired';
}

/**
 * Pure outcome-fingerprint equality (the replay convergence check): two
 * outcome submissions are the SAME logical command when the outcome,
 * payload reference, evidence reference and submitting actor match —
 * provenance bookkeeping (correlation ids) is deliberately excluded (a
 * replay converges to the ORIGINALLY recorded provenance).
 */
export function isSameOutcomeSubmission(
  existing: {
    readonly outcome: 'succeeded' | 'failed';
    readonly payloadRef: string | null;
    readonly evidenceRef: string;
    readonly submittedBy: string | null;
  },
  candidate: {
    readonly outcome: 'succeeded' | 'failed';
    readonly payloadRef: string | null;
    readonly evidenceRef: string;
    readonly submittedBy: string | null;
  },
): boolean {
  return (
    existing.outcome === candidate.outcome &&
    existing.payloadRef === candidate.payloadRef &&
    existing.evidenceRef === candidate.evidenceRef &&
    existing.submittedBy === candidate.submittedBy
  );
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL JOB OWNER CONTEXT: the single server-side resolution of
 * which tenant owns the Job — its Task's workflow instance, the owning
 * Workflow, Workspace, Client and Agency, all derived from durable state
 * on every call. Job-scoped operations authorize against this context —
 * never against caller-supplied tenant or job identity. `scope` mirrors
 * the pipeline OwnerScope shape (client-scoped jobs serialize as the
 * 'client' owner kind at the route layer).
 *
 * A Job whose instance's Workflow or Client is a deleted tombstone never
 * resolves (null — uniform 404 upstream).
 */
export interface JobOwnerContext {
  readonly scope: {
    readonly kind: 'job';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
    readonly jobId: string;
  };
  readonly job: JobRecord;
  readonly workflowInstance: WorkflowInstanceRecord;
  readonly workspace: JobWorkspaceRow;
  readonly client: WorkflowClientRow;
  readonly agency: WorkflowAgencySummary;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical Job owner context from ALREADY-RESOLVED
 * durable rows. Purity is asserted by unit tests — the same inputs always
 * compose the same context.
 */
export function composeJobOwnerContext(
  job: JobRecord,
  workflowInstance: WorkflowInstanceRecord,
  workspace: JobWorkspaceRow,
  client: WorkflowClientRow,
  agency: WorkflowAgencySummary,
  resolvedAt: string,
): JobOwnerContext {
  return {
    scope: {
      kind: 'job',
      agencyId: job.agencyId,
      clientId: job.clientId,
      workspaceId: job.workspaceId,
      jobId: job.jobId,
    },
    job,
    workflowInstance,
    workspace,
    client,
    agency,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// MKT-027: Visit status machine (the frozen field-execution lifecycle)
// ---------------------------------------------------------------------------

/**
 * The frozen MKT-027 visit lifecycle:
 *
 *   planned → in_progress → completed | cancelled
 *   planned → cancelled
 *
 * `planned`: the visit is opened (planned, target identity declared).
 * `in_progress`: the accepted agent has STARTED the field visit.
 * `completed`: the visit finished and its structured outcome was
 * submitted. `cancelled`: the visit was abandoned (before or during
 * execution). `completed` and `cancelled` are TERMINAL (frozen
 * field-execution history; migration 024 rejects every outgoing
 * transition).
 */
export type VisitStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled';

export const VISIT_STATUSES: readonly VisitStatus[] = [
  'planned',
  'in_progress',
  'completed',
  'cancelled',
];

/** The frozen transition table (exhaustive; unit-tested byte for byte). */
export const VISIT_TRANSITIONS: Readonly<Record<VisitStatus, readonly VisitStatus[]>> = {
  planned: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function isLegalVisitTransition(from: VisitStatus, to: VisitStatus): boolean {
  return VISIT_TRANSITIONS[from].includes(to);
}

export const VISIT_TERMINAL_STATUSES: readonly VisitStatus[] = ['completed', 'cancelled'];

export function isTerminalVisitStatus(status: VisitStatus): boolean {
  return VISIT_TERMINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// MKT-027: Structured visit outcome vocabulary
// ---------------------------------------------------------------------------

/**
 * The frozen field-result vocabulary — field-specific granularity beyond
 * the job-level succeeded|failed (spec/work-items.md MKT-027 "structured
 * outcomes"):
 *   succeeded  — the visit fully achieved its purpose;
 *   partial    — the visit achieved part of its purpose;
 *   no_contact — the target was not reachable (the classic follow-up case);
 *   failed     — the visit did not achieve its purpose.
 */
export type VisitResult = 'succeeded' | 'partial' | 'no_contact' | 'failed';

export const VISIT_RESULTS: readonly VisitResult[] = [
  'succeeded',
  'partial',
  'no_contact',
  'failed',
];

// ---------------------------------------------------------------------------
// MKT-027: Visit records (durable shapes)
// ---------------------------------------------------------------------------

/** Immutable storage shape of one persisted visit. */
export interface VisitRecord {
  readonly visitId: string;
  readonly jobId: string;
  /** Per-job sequence (1-based) — the visit order within the Job. */
  readonly visitSeq: number;
  /** INHERITED from the Job (server-derived; never caller-provided). */
  readonly workspaceId: string;
  readonly clientId: string;
  readonly agencyId: string;
  /** The relationship target identity (venue/person/location key). */
  readonly targetIdentity: string;
  readonly status: VisitStatus;
  readonly scheduledAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  /** The prior COMPLETED visit of the same relationship this visit follows up. */
  readonly followUpOfVisitId: string | null;
  /** The accepted agent's platform user (server-derived from the job claim). */
  readonly createdBy: string | null;
  /** Open-event provenance (SERVER-DERIVED — never a DTO field). */
  readonly provenance: VisitRecordedProvenance;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One append-only applied lifecycle transition with full provenance. */
export interface VisitTransitionRecord {
  readonly transitionId: string;
  readonly visitId: string;
  readonly fromStatus: VisitStatus;
  readonly toStatus: VisitStatus;
  readonly reason: string;
  readonly createdBy: string | null;
  readonly provenance: VisitRecordedProvenance;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// MKT-027: Visit provenance (SERVER-DERIVED — the dimension callers never
// supply; the JOB-AC-03 pattern extended to every visit lifecycle event)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of one visit lifecycle event. Built
 * exclusively by server code from the authenticated principal, the
 * ambient correlation context and the module clock — never from a
 * request body (route validation rejects provenance-shaped authority
 * fields; this type is a separate module-API argument so no DTO can
 * feed it structurally, the /evidence provenance pattern).
 */
export interface VisitProvenance {
  /** Server-derived actor label: 'user:<uuid>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api'). */
  readonly recordedVia: string;
  /** Correlation identity of the logical flow that recorded the event. */
  readonly correlationId: string;
  /** Causation identity (the job id) when the event was worker-caused. */
  readonly causationId: string | null;
}

/** Provenance block as persisted on the immutable record. */
export interface VisitRecordedProvenance extends VisitProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// MKT-027: Structured visit outcome record
// ---------------------------------------------------------------------------

/** The structured visit outcome as persisted (append-only, one per visit). */
export interface VisitOutcomeRecord {
  readonly visitOutcomeId: string;
  readonly visitId: string;
  readonly result: VisitResult;
  readonly followUpRequired: boolean;
  readonly notes: string;
  /** The structured observation payload (non-empty JSON object). */
  readonly observations: Readonly<Record<string, unknown>>;
  /** The /evidence record backing the outcome (same-Client, DB-fenced). */
  readonly evidenceRef: string;
  readonly provenance: VisitRecordedProvenance & {
    /** The accepted agent's platform user (server-derived from the principal). */
    readonly submittedBy: string | null;
    /** Server-stamped submission time (module clock, never caller input). */
    readonly submittedAt: string;
  };
  readonly createdAt: string;
}

/** The result of a visit completion: the records AFTER + replay flag. */
export interface VisitCompletionOutcome {
  readonly visit: VisitRecord;
  readonly outcome: VisitOutcomeRecord;
  /** True when the duplicate submission converged to the recorded outcome. */
  readonly replayed: boolean;
}

/** One captured-evidence link (the visit side of the /evidence append). */
export interface VisitEvidenceLinkRecord {
  readonly visitId: string;
  readonly evidenceId: string;
  readonly capturedBy: string | null;
  readonly provenance: VisitRecordedProvenance;
}

// ---------------------------------------------------------------------------
// MKT-027: Continuity (JOB-AC-04) — the derived relationship chain
// ---------------------------------------------------------------------------

/**
 * The relationship coordinates of a visit (JOB-AC-04): the commissioning
 * Agency + Client + the visit's target identity. Repeated visits over the
 * same coordinates form the relationship whose continuity is preserved.
 */
export interface VisitRelationship {
  readonly agencyId: string;
  readonly clientId: string;
  readonly targetIdentity: string;
}

/** One entry of the derived continuity chain (prior completed visit). */
export interface VisitContinuityEntry {
  readonly visit: VisitRecord;
  /** The structured outcome when the prior visit completed with one. */
  readonly outcome: VisitOutcomeRecord | null;
}

/** The derived continuity view of one visit (JOB-AC-04 — a READ). */
export interface VisitContinuityView {
  readonly visit: VisitRecord;
  readonly relationship: VisitRelationship;
  /**
   * The prior COMPLETED visits of the SAME relationship, oldest first.
   * DERIVED data: the chain is computed from durable state; history is
   * never rewritten.
   */
  readonly priorVisits: readonly VisitContinuityEntry[];
  /**
   * The visiting agent's frozen relationship-continuity policy block
   * (resolved server-side through /field-agents) — the POLICY INPUT the
   * route-level checkpoint evaluates with visitContinuityExposedToAgent.
   */
  readonly agentContinuityPolicy: RelationshipContinuity | null;
}

/**
 * The CONTINUITY POLICY CHECKPOINT (JOB-AC-04 "subject to policy"): is
 * the derived continuity chain exposed to the EXECUTING (accepted) agent?
 *
 * This is the single pure gate over the EXISTING policy data — the merged
 * /field-agents profile relationship-continuity block
 * (human-agent-v1.3.md §1: "relationship-continuity preferences", frozen
 * profile data the jobs authority consumes). The chain is exposed to the
 * accepted agent only when the agent's policy data opts INTO repeat
 * relationships (prefersRepeatClients) with a continuity preference
 * beyond 'any'. The commissioning side is NOT gated here (client scope
 * owns the data).
 *
 * This function is the DECLARED SWAP POINT for the /policies authority
 * (MKT-021, not merged at base be8505b): when a policy engine lands, the
 * gate's decision moves there without touching any other call site. NO
 * second policy engine is created here — this predicate only reads
 * frozen profile data. Fails closed: unknown/absent policy data → false.
 */
export function visitContinuityExposedToAgent(
  policy: RelationshipContinuity | null,
): boolean {
  if (policy === null) return false;
  if (policy.prefersRepeatClients !== true) return false;
  return policy.continuity === 'preferred' || policy.continuity === 'required';
}

// ---------------------------------------------------------------------------
// MKT-027: Pure validation and decision functions (single-sourced
// semantics; unit-tested)
// ---------------------------------------------------------------------------

/** Maximum visit outcome notes length. */
export const MAX_VISIT_NOTES_LENGTH = 2000;
/** Maximum visit cancel reason length. */
export const MAX_VISIT_REASON_LENGTH = 2000;
/** Target identity pattern: 1..200 chars, printable identifier shape. */
export const TARGET_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ,.\-:/_]{0,199}$/;

/**
 * Pure validation of a visit OPEN (single source of truth for the DTO
 * shape; the module throws InvalidRequestError with these problems and
 * migration 024 backstops the type/cardinality fences). Returns the list
 * of problems (empty = valid).
 */
export function validateVisitOpen(input: {
  readonly targetIdentity: string;
  readonly scheduledAtIso: string | null;
  readonly followUpOfVisitId: string | null;
}): ReadonlyArray<string> {
  const problems: string[] = [];
  if (
    typeof input.targetIdentity !== 'string' ||
    !TARGET_IDENTITY_PATTERN.test(input.targetIdentity)
  ) {
    problems.push(
      'targetIdentity: must be 1..200 characters (letters, digits, spaces, commas, dots, dashes, colons, slashes, underscores; must start alphanumeric)',
    );
  }
  if (input.scheduledAtIso !== null) {
    if (typeof input.scheduledAtIso !== 'string' || Number.isNaN(Date.parse(input.scheduledAtIso))) {
      problems.push('scheduledAt: must be an ISO-8601 timestamp when present');
    }
  }
  if (input.followUpOfVisitId !== null) {
    if (typeof input.followUpOfVisitId !== 'string' || input.followUpOfVisitId.length < 1) {
      problems.push('followUpOfVisitId: must be a visit identifier when present');
    }
  }
  return problems;
}

/**
 * Pure validation of a structured visit outcome submission. The
 * observations payload must be a non-empty JSON object (the §21
 * material-key guard runs in the module — containsMaterialKey from the
 * /evidence public contract). Returns the list of problems (empty =
 * valid).
 */
export function validateVisitOutcome(input: {
  readonly result: string;
  readonly followUpRequired: boolean;
  readonly notes: string;
  readonly observations: unknown;
  readonly evidenceRef: string;
}): ReadonlyArray<string> {
  const problems: string[] = [];
  if (!(VISIT_RESULTS as readonly string[]).includes(input.result)) {
    problems.push(
      `result: must be one of the frozen field results (succeeded | partial | no_contact | failed)`,
    );
  }
  if (typeof input.followUpRequired !== 'boolean') {
    problems.push('followUpRequired: must be a boolean');
  }
  if (typeof input.notes !== 'string' || input.notes.length > MAX_VISIT_NOTES_LENGTH) {
    problems.push(`notes: must be a string of at most ${MAX_VISIT_NOTES_LENGTH} characters`);
  }
  if (
    input.observations === null ||
    typeof input.observations !== 'object' ||
    Array.isArray(input.observations) ||
    Object.keys(input.observations as Record<string, unknown>).length === 0
  ) {
    problems.push('observations: must be a non-empty JSON object of structured field observations');
  }
  if (typeof input.evidenceRef !== 'string' || input.evidenceRef.trim() === '') {
    problems.push('evidenceRef: the /evidence record backing the outcome is required');
  }
  return problems;
}

/**
 * The outcome of evaluating a START/CANCEL/COMPLETE request against the
 * durable visit state (pure — the module applies what this decides):
 *
 *   - `apply` — the transition is legal, apply it;
 *   - `replay` — the visit is ALREADY in the target state: the duplicate
 *     request converges to the recorded state with no state change;
 *   - `terminal` — the visit is completed/cancelled (terminal): the
 *     request conflicts cleanly (frozen history);
 *   - `illegal` — the transition is not an edge of the frozen machine
 *     (conflict — never a partial state).
 */
export type VisitTransitionDecision =
  | { readonly kind: 'apply' }
  | { readonly kind: 'replay' }
  | { readonly kind: 'terminal'; readonly status: VisitStatus }
  | { readonly kind: 'illegal'; readonly from: VisitStatus; readonly to: VisitStatus };

export function evaluateVisitTransition(
  from: VisitStatus,
  to: VisitStatus,
): VisitTransitionDecision {
  if (from === to) return { kind: 'replay' };
  if (isTerminalVisitStatus(from)) return { kind: 'terminal', status: from };
  if (isLegalVisitTransition(from, to)) return { kind: 'apply' };
  return { kind: 'illegal', from, to };
}

/**
 * Pure outcome-fingerprint equality (the replay convergence check): two
 * visit outcome submissions are the SAME logical command when the result,
 * follow-up declaration, notes, observation payload, evidence reference
 * and submitting actor match — provenance bookkeeping (correlation ids)
 * is deliberately excluded (a replay converges to the ORIGINALLY
 * recorded provenance). Observation payloads compare SEMANTICALLY
 * (JSON key order does not matter): a retried submission of the same
 * content with keys serialized in a different order converges.
 */
export function isSameVisitOutcomeSubmission(
  existing: {
    readonly result: VisitResult;
    readonly followUpRequired: boolean;
    readonly notes: string;
    readonly observations: Readonly<Record<string, unknown>>;
    readonly evidenceRef: string;
    readonly submittedBy: string | null;
  },
  candidate: {
    readonly result: VisitResult;
    readonly followUpRequired: boolean;
    readonly notes: string;
    readonly observations: Readonly<Record<string, unknown>>;
    readonly evidenceRef: string;
    readonly submittedBy: string | null;
  },
): boolean {
  return (
    existing.result === candidate.result &&
    existing.followUpRequired === candidate.followUpRequired &&
    existing.notes === candidate.notes &&
    canonicalJson(existing.observations) === canonicalJson(candidate.observations) &&
    existing.evidenceRef === candidate.evidenceRef &&
    existing.submittedBy === candidate.submittedBy
  );
}

/** Canonical JSON: object keys sorted at every level (order-insensitive equality). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => Object.prototype.hasOwnProperty.call(value, key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Operation outcomes
// ---------------------------------------------------------------------------

/** The result of an ACCEPT: the records AFTER the operation + replay flag. */
export interface OfferAcceptOutcome {
  readonly job: JobRecord;
  readonly offer: JobOfferRecord;
  /** True when the duplicate request converged to the recorded acceptance. */
  readonly replayed: boolean;
}

/** The result of a DECLINE: the records AFTER the operation + replay flag. */
export interface OfferDeclineOutcome {
  readonly job: JobRecord;
  readonly offer: JobOfferRecord;
  readonly replayed: boolean;
}

/** The result of an outcome submission: the outcome + replay flag. */
export interface OutcomeSubmissionOutcome {
  readonly job: JobRecord;
  readonly outcome: JobOutcomeRecord;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface JobsModuleApi {
  /**
   * Projects ONE governed Task into a Job (JOB-AC-01). The Task reference
   * (workflow instance + node) is resolved THROUGH the /workflows public
   * contract before any write: unknown instance → uniform NotFoundError;
   * non-RUNNING instance → ConflictError (the Task's work is not live);
   * unknown node → NotFoundError; a node that is not a human_task →
   * InvalidRequestError (only human Tasks project). The scope chain is
   * SERVER-DERIVED from the instance's canonical owner. The (instance,
   * node) task key is DB-fenced: a second projection of the same Task is
   * a ConflictError (never a second assignment identity). The descriptor
   * carries NO Client-specific data (human-agent-v1.3.md §3).
   */
  projectJob(input: {
    readonly workflowInstanceId: string;
    readonly nodeId: string;
    readonly descriptor: JobDescriptor;
    readonly actorId: string | null;
  }): Promise<JobRecord>;
  /** Raw record by id — module/route internal reads. */
  getJob(jobId: string): Promise<JobRecord | null>;
  /**
   * Canonical ownership resolution: the job row → its Task's workflow
   * instance → the owning Workflow → Workspace → Client → Agency, composed
   * into the canonical owner context (the instance scope must match the
   * job scope — DB-fenced at insert, re-verified defensively here). Null
   * when the Job does not exist OR its Workflow/Client is a deleted
   * tombstone — callers surface a uniform 404 so foreign, unknown and
   * orphaned identifiers are indistinguishable (hard-boundary posture).
   */
  resolveJobOwnership(jobId: string): Promise<JobOwnerContext | null>;
  /**
   * The ELIGIBILITY-GATED marketplace listing (human-agent-v1.3.md §3):
   * the jobs whose round is open (projected/offered) that the given Human
   * Agent profile is ELIGIBLE for, evaluated by the merged /field-agents
   * pure matcher from PROFILE DATA ONLY. The caller serializes
   * DESCRIPTORS ONLY — this module returns records and the route layer
   * is responsible for never exposing Client-specific detail before the
   * eligibility gate; unknown/inactive profile → NotFoundError (fail
   * closed).
   */
  listMarketplaceJobs(candidateAgentId: string): Promise<readonly JobRecord[]>;
  /**
   * Creates one CANDIDATE-SPECIFIC Offer (job-offer-v1.2.md). The Job's
   * round must still be open (projected/offered — ConflictError
   * otherwise). The candidate Human Agent profile is resolved through the
   * merged /field-agents public contract BEFORE any write: unknown
   * profile → NotFoundError; non-active authorization → ConflictError;
   * NOT ELIGIBLE for this job's spec → ConflictError (eligibility is
   * evaluated BEFORE any offer — and therefore before any Client data —
   * is exposed to the candidate). The expiry must be a bounded future
   * timestamp (InvalidRequestError otherwise). One OPEN offer per
   * (job, candidate) is DB-fenced (duplicate → ConflictError). Creating
   * the first Offer moves the Job projected → offered.
   */
  createOffer(input: {
    readonly jobId: string;
    readonly candidateAgentId: string;
    readonly expiresAtIso: string;
    readonly actorId: string | null;
  }): Promise<JobOfferRecord>;
  /** Raw offer record (must belong to the given job) — null when absent. */
  getOffer(jobId: string, offerId: string): Promise<JobOfferRecord | null>;
  /** The offers of one Job in EVERY state (terminal history visible), oldest first. */
  listOffersForJob(jobId: string): Promise<readonly JobOfferRecord[]>;
  /**
   * The offers addressed to one candidate platform user (the caller's own
   * offers — every state, newest first). The user's Human Agent profile
   * is resolved through the merged /field-agents public contract: a user
   * without a profile has no offer surface (NotFoundError — fail closed).
   */
  listOffersForCandidate(candidateUserId: string): Promise<readonly JobOfferRecord[]>;
  /**
   * ACCEPTS an offer — the concurrency-safe claim (JOB-AC-02, the v1.2
   * Job Offer contract). One row-locked transaction (lock the Job, then
   * the offer): repeated acceptance of the SAME offer by the SAME
   * candidate converges idempotently (replayed=true — the recorded
   * outcome, no state change, no version bump); acceptance of a
   * different offer after the Job has been claimed is a clean
   * ConflictError (never a partial state) — losing OPEN offers
   * terminalize as expired (reason 'lost') and can never later claim;
   * an expired offer is terminalized (reason 'expiry') and conflicts;
   * the caller MUST be the offer's candidate (a foreign offer is a
   * uniform NotFoundError — no existence oracle). Exactly one offer may
   * win: the DB partial unique fence is the race backstop.
   */
  acceptOffer(input: {
    readonly jobId: string;
    readonly offerId: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
  }): Promise<OfferAcceptOutcome>;
  /**
   * DECLINES an offer — the candidate's per-offer right; it never affects
   * the underlying Task. Repeated decline of the SAME offer converges
   * idempotently (replayed=true). An accepted offer cannot be declined
   * (the claim stands — ConflictError); an expired offer terminalizes
   * (reason 'expiry') and conflicts. When the declined offer was the
   * round's last open offer with no winner, the Job closes: 'declined'
   * when every offer was declined, 'expired' otherwise. The caller MUST
   * be the offer's candidate (uniform NotFoundError otherwise).
   */
  declineOffer(input: {
    readonly jobId: string;
    readonly offerId: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
  }): Promise<OfferDeclineOutcome>;
  /**
   * SUBMITS the outcome (JOB-AC-03): the accepted agent reports
   * succeeded | failed with an optional opaque payload reference and a
   * REQUIRED evidence reference. The evidence reference is resolved
   * THROUGH the /evidence public contract before any write: unknown,
   * foreign or cross-Client references are a uniform NotFoundError (a
   * foreign evidence id is not a traversal oracle), and the migration-023
   * same-Client trigger is the DB backstop. `provenance` is
   * SERVER-DERIVED (a separate module-API argument no DTO feeds) and is
   * preserved on the append-only outcome row together with the accepted
   * agent identity and the observed workflow instance status at report
   * time. The Job moves accepted → outcome_submitted; exactly one
   * outcome exists per job — a duplicate of the SAME logical submission
   * converges (replayed=true, the ORIGINALLY recorded provenance); a
   * different submission is a ConflictError. The caller MUST be the
   * accepted agent (uniform NotFoundError otherwise). Jobs never own
   * workflow state: the outcome record IS the report to the workflow
   * authority's task state, exposed through this public contract —
   * no instance transition is commanded here.
   */
  submitOutcome(input: {
    readonly jobId: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly payloadRef: string | null;
    readonly evidenceRef: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: JobOutcomeProvenance;
  }): Promise<OutcomeSubmissionOutcome>;
  /** The submitted outcome of one job (null when none — unresolved stays unresolved). */
  getJobOutcome(jobId: string): Promise<JobOutcomeRecord | null>;

  // -------------------------------------------------------------------------
  // MKT-027: Field execution (visit lifecycle, structured outcomes,
  // evidence capture, follow-up and continuity). Every operation is scoped
  // by the Job authority: the visit's scope chain is INHERITED from the
  // Job, the actor is verified to be the Job's ACCEPTED agent, and no
  // workflow state is ever mutated.
  // -------------------------------------------------------------------------

  /**
   * OPENS one visit on an accepted Job (MKT-027): the accepted agent
   * declares the relationship TARGET identity (the continuity
   * coordinate), an optional scheduled time and an optional follow-up
   * link. The Job must be in its acceptance window ('accepted' —
   * ConflictError otherwise; migration 024 DB-backstops the window); the
   * caller MUST be the job's accepted agent (uniform NotFoundError
   * otherwise — no existence oracle). The visit's scope chain is
   * INHERITED from the Job (never caller input; DB-fenced). The
   * follow-up reference is resolved BEFORE any write: unknown or
   * cross-relationship visits are a uniform NotFoundError; a
   * same-relationship visit that is not COMPLETED is a ConflictError.
   * `provenance` is SERVER-DERIVED (a separate module-API argument no
   * DTO feeds) and is preserved on the visit row and the transition
   * history.
   */
  openVisit(input: {
    readonly jobId: string;
    readonly targetIdentity: string;
    readonly scheduledAtIso: string | null;
    readonly followUpOfVisitId: string | null;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<VisitRecord>;
  /** The raw visit record (must belong to the given job) — null when absent. */
  getVisit(jobId: string, visitId: string): Promise<VisitRecord | null>;
  /** All visits of one Job (oldest first) — commissioning/agent read surface. */
  listVisitsForJob(jobId: string): Promise<readonly VisitRecord[]>;
  /** The append-only lifecycle history of one visit (oldest first). */
  listVisitTransitions(visitId: string): Promise<readonly VisitTransitionRecord[]>;
  /**
   * STARTS the visit (planned → in_progress): the accepted agent only.
   * Repeated start of an in_progress visit converges idempotently
   * (replayed=true); a terminal visit conflicts (frozen history).
   */
  startVisit(input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<{ readonly visit: VisitRecord; readonly replayed: boolean }>;
  /**
   * CANCELS the visit (planned | in_progress → cancelled) with a bounded
   * reason: the accepted agent only. Repeated cancel converges
   * idempotently (replayed=true); a completed visit can never be
   * cancelled (the outcome stands — ConflictError).
   */
  cancelVisit(input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly reason: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<{ readonly visit: VisitRecord; readonly replayed: boolean }>;
  /**
   * COMPLETES the visit with its STRUCTURED OUTCOME (in_progress →
   * completed; JOB-AC-03 field subset): the accepted agent reports the
   * field result (succeeded | partial | no_contact | failed), the
   * explicit follow-up declaration, bounded notes, the structured
   * observations payload and a REQUIRED evidence reference. The
   * evidence reference is resolved THROUGH the /evidence public contract
   * before any write: unknown, foreign or cross-Client references are a
   * uniform NotFoundError (a foreign evidence id is not a traversal
   * oracle), and the migration-024 same-Client trigger is the DB
   * backstop. The observations payload is guarded (non-empty object;
   * material-shaped keys rejected at every nesting level — §21).
   * `provenance` is SERVER-DERIVED and preserved on the append-only
   * outcome row (with submittedBy/submittedAt). Exactly one outcome
   * exists per visit — a duplicate of the SAME logical submission
   * converges (replayed=true, the ORIGINALLY recorded provenance); a
   * different submission is a ConflictError. The caller MUST be the
   * accepted agent (uniform NotFoundError otherwise). The Job's own
   * MKT-026 outcome submission stays a separate surface — the job state
   * machine is never touched here.
   */
  completeVisit(input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly result: VisitResult;
    readonly followUpRequired: boolean;
    readonly notes: string;
    readonly observations: Readonly<Record<string, unknown>>;
    readonly evidenceRef: string;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<VisitCompletionOutcome>;
  /** The structured outcome of one visit (null when none — unresolved stays unresolved). */
  getVisitOutcome(visitId: string): Promise<VisitOutcomeRecord | null>;
  /**
   * CAPTURES one evidence record from the field (EVID-AC-01..03 field
   * subset; human-agent-v1.3.md §5): the accepted agent appends an
   * immutable /evidence record THROUGH the /evidence public contract
   * with a SERVER-DERIVED scope (the job's Client + Workspace — never
   * caller input) and SERVER-DERIVED provenance (actor from the
   * principal, recordedVia 'field-agent', correlation ambient, causation
   * the visit id). The visit must be in_progress (evidence is captured
   * during execution; ConflictError otherwise); the caller MUST be the
   * accepted agent (uniform NotFoundError otherwise). The declared
   * class/quality/content shape is validated by the /evidence append
   * guard — claims stay claims: NO code path anywhere mutates an
   * evidence record, so the submitting agent can never self-authorize
   * provenance promotion or causal conclusions (EVID-AC-03).
   */
  captureVisitEvidence(input: {
    readonly jobId: string;
    readonly visitId: string;
    readonly class: string;
    readonly quality: string;
    readonly observedAtIso: string;
    readonly sourceRef: string | null;
    readonly content: Readonly<Record<string, unknown>>;
    readonly contentRef: string | null;
    readonly confidence: number | null;
    readonly actorUserId: string;
    readonly actorId: string | null;
    readonly provenance: VisitProvenance;
  }): Promise<VisitEvidenceLinkRecord>;
  /** The evidence records captured through one visit (oldest first). */
  listVisitEvidence(visitId: string): Promise<readonly VisitEvidenceLinkRecord[]>;
  /**
   * The DERIVED continuity view (JOB-AC-04): the prior COMPLETED visits
   * of the SAME relationship (agency + client + target identity), oldest
   * first, with their structured outcomes — plus the visiting agent's
   * frozen relationship-continuity policy block resolved server-side
   * through /field-agents (the POLICY INPUT for the route-level
   * checkpoint visitContinuityExposedToAgent). DERIVED data: history is
   * never rewritten. Null when the visit does not exist (uniform 404
   * upstream).
   */
  getVisitContinuity(visitId: string): Promise<VisitContinuityView | null>;
}

export interface JobsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Dependency matrix (/jobs ──→ /workflows): READ-ONLY consumption (instance/definition/ownership resolution). */
  readonly workflows: WorkflowsModuleApi;
  /** Dependency matrix (/jobs ──→ /field-agents): candidate profiles + the frozen profile-only eligibility matcher. */
  readonly fieldAgents: FieldAgentsModuleApi;
  /** Dependency matrix (/jobs ──→ /evidence): outcome evidence-reference validation. */
  readonly evidence: EvidenceModuleApi;
}

export { createJobsModule } from './internal/module.ts';
