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
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { FieldAgentsModuleApi, JobEligibilitySpec } from '../field-agents/public.ts';
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
