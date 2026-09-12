/**
 * Creator Operations Domain Pack — the pack CONTRACT (MKT-037, CREATOR-001).
 *
 * This is the provider-neutral composition layer of spec/
 * creator-operations-v1.3.md (FROZEN): pack-owned, Client-scoped domain
 * subjects (§2), governed workflow templates (§3), human-role
 * specializations over the GENERIC Human Agent model (§4), AI task
 * declarations through the platform TaskProfile contract (§5), normalized
 * creator-platform capability bindings (§6) and observation mappings into
 * the COMMON Evidence/Measurement architecture (§7).
 *
 * It is a Domain Pack, NOT a second authority (domain-pack-v1.3.md §3):
 *   - tenant/client authorization stays the /clients + /agencies
 *     authorities — every pack-owned record carries the EXISTING
 *     agency/client scope chain, re-fenced by the migration-031
 *     scope-chain triggers (CREATOR-AC-01);
 *   - evidence/provenance stays the /evidence authority and metric
 *     normalization stays the /metrics authority — engagement,
 *     monetization, audience, conversation, content and performance
 *     observations enter through the pack's mapping adapters bound to
 *     those authorities (CREATOR-AC-02); the pack owns the MAPPING, never
 *     a parallel store;
 *   - AI routing stays the /ai-runtime authority — the pack's AI task
 *     classes are TaskProfile declarations registered through that
 *     authority's own creation surface (CREATOR-AC-03);
 *   - human execution stays the generic Human Agent → Job → Task →
 *     Execution model of /field-agents + /jobs + /executions — the pack
 *     only declares specialization capability metadata and workflow
 *     templates whose human_task nodes project into Jobs through the
 *     EXISTING /jobs authority (CREATOR-AC-04);
 *   - policy evaluation stays the /policies authority — sensitive
 *     outbound side effects (conversation sends, content publication) are
 *     gated by fail-closed policy evaluation plus configurable pack-owned
 *     human approval records (CREATOR-AC-06);
 *   - provider implementations stay behind /integrations + /extensions —
 *     the pack carries ONLY provider-neutral labels and normalized
 *     capability bindings (CREATOR-AC-05).
 *
 * DEPENDENCY POSTURE (the /metrics-for-/clients structural-port
 * precedent, applied uniformly): the frozen matrix row
 * `/domain-packs → /agencies, /clients, /workspaces, /goals, /playbooks,
 * /workflows, /executions, /agents, /jobs, /evidence, /metrics,
 * /experiments, /learnings, /extensions, /policies, /audit` allows the
 * pack to consume the core public contracts, and module-dependency-v1.3.md
 * says "Creator Operations pack code may consume Domain Pack public
 * contracts and the existing core public contracts above. It may not
 * depend on internal repositories of another module." This pack lives
 * inside the /domain-packs module tree, whose MKT-036 boundary tests keep
 * the FRAMEWORK itself free of every authority import; the pack therefore
 * composes the authorities through the NARROW STRUCTURAL PORTS declared
 * below — pure interface slices satisfied structurally by the concrete
 * module public-contract instances (ClientsModuleApi, EvidenceModuleApi,
 * MetricsModuleApi, PoliciesModuleApi, AiRuntimeModuleApi) and wired at
 * the composition root. No pack file imports any other module: the
 * boundary guarantees of MKT-036 stay intact bit-for-bit, and the wiring
 * site is the type-level proof that the real public contracts satisfy the
 * ports (the /metrics precedent).
 *
 * Pure functions and closed vocabularies here are part of the frozen pack
 * contract (unit-tested; extension is a pack version bump, never a caller
 * freedom).
 */

import type { Clock } from '../../../../../platform/clock/clock.ts';
import type { Db } from '../../../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../../../platform/ids/ids.ts';
import type {
  DomainPackManifest,
  DomainPackRegistryRecord,
  DomainPacksModuleApi,
} from '../../../public.ts';

// ---------------------------------------------------------------------------
// The frozen lifecycle tables (migration 031 — the single sourced truth)
// ---------------------------------------------------------------------------

/**
 * The frozen Creator Account lifecycle (migration 031): born ACTIVE;
 * active ⇄ paused; active|paused → retired (TERMINAL).
 */
export type CreatorAccountStatus = 'active' | 'paused' | 'retired';

export const CREATOR_ACCOUNT_STATUSES: readonly CreatorAccountStatus[] = [
  'active',
  'paused',
  'retired',
];

export const CREATOR_ACCOUNT_TRANSITIONS: Readonly<
  Record<CreatorAccountStatus, readonly CreatorAccountStatus[]>
> = {
  active: ['paused', 'retired'],
  paused: ['active', 'retired'],
  retired: [],
};

/** Terminal account rows — frozen, reject every change. */
export const CREATOR_ACCOUNT_TERMINAL_STATUSES: readonly CreatorAccountStatus[] = ['retired'];

/**
 * The frozen Fan lifecycle (migration 031): born SUBSCRIBED;
 * subscribed ⇄ churned; subscribed|churned → removed (TERMINAL).
 */
export type CreatorFanStatus = 'subscribed' | 'churned' | 'removed';

export const CREATOR_FAN_STATUSES: readonly CreatorFanStatus[] = [
  'subscribed',
  'churned',
  'removed',
];

export const CREATOR_FAN_TRANSITIONS: Readonly<
  Record<CreatorFanStatus, readonly CreatorFanStatus[]>
> = {
  subscribed: ['churned', 'removed'],
  churned: ['subscribed', 'removed'],
  removed: [],
};

/** Terminal fan rows — frozen. */
export const CREATOR_FAN_TERMINAL_STATUSES: readonly CreatorFanStatus[] = ['removed'];

/**
 * The frozen Conversation lifecycle (migration 031): born OPEN;
 * open ⇄ paused; open|paused → closed (TERMINAL).
 */
export type CreatorConversationStatus = 'open' | 'paused' | 'closed';

export const CREATOR_CONVERSATION_STATUSES: readonly CreatorConversationStatus[] = [
  'open',
  'paused',
  'closed',
];

export const CREATOR_CONVERSATION_TRANSITIONS: Readonly<
  Record<CreatorConversationStatus, readonly CreatorConversationStatus[]>
> = {
  open: ['paused', 'closed'],
  paused: ['open', 'closed'],
  closed: [],
};

/** Terminal conversation rows — frozen. */
export const CREATOR_CONVERSATION_TERMINAL_STATUSES: readonly CreatorConversationStatus[] = [
  'closed',
];

/**
 * The frozen Content Asset lifecycle (migration 031): born DRAFT;
 * draft → in_review → approved → published (TERMINAL, the approval-gated
 * side effect); in_review|approved → rejected (TERMINAL side-exit).
 */
export type CreatorContentStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'published'
  | 'rejected';

export const CREATOR_CONTENT_STATUSES: readonly CreatorContentStatus[] = [
  'draft',
  'in_review',
  'approved',
  'published',
  'rejected',
];

export const CREATOR_CONTENT_TRANSITIONS: Readonly<
  Record<CreatorContentStatus, readonly CreatorContentStatus[]>
> = {
  draft: ['in_review', 'rejected'],
  in_review: ['approved', 'rejected'],
  approved: ['published', 'rejected'],
  published: [],
  rejected: [],
};

/** Terminal content rows — frozen (both exits). */
export const CREATOR_CONTENT_TERMINAL_STATUSES: readonly CreatorContentStatus[] = [
  'published',
  'rejected',
];

/**
 * The frozen Offer lifecycle (migration 031): born DRAFT;
 * draft → active ⇄ paused; active|paused → retired (TERMINAL).
 */
export type CreatorOfferStatus = 'draft' | 'active' | 'paused' | 'retired';

export const CREATOR_OFFER_STATUSES: readonly CreatorOfferStatus[] = [
  'draft',
  'active',
  'paused',
  'retired',
];

export const CREATOR_OFFER_TRANSITIONS: Readonly<
  Record<CreatorOfferStatus, readonly CreatorOfferStatus[]>
> = {
  draft: ['active', 'retired'],
  active: ['paused', 'retired'],
  paused: ['active', 'retired'],
  retired: [],
};

/** Terminal offer rows — frozen. */
export const CREATOR_OFFER_TERMINAL_STATUSES: readonly CreatorOfferStatus[] = ['retired'];

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalCreatorAccountTransition(
  from: CreatorAccountStatus,
  to: CreatorAccountStatus,
): boolean {
  return CREATOR_ACCOUNT_TRANSITIONS[from].includes(to);
}

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalCreatorFanTransition(
  from: CreatorFanStatus,
  to: CreatorFanStatus,
): boolean {
  return CREATOR_FAN_TRANSITIONS[from].includes(to);
}

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalCreatorConversationTransition(
  from: CreatorConversationStatus,
  to: CreatorConversationStatus,
): boolean {
  return CREATOR_CONVERSATION_TRANSITIONS[from].includes(to);
}

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalCreatorContentTransition(
  from: CreatorContentStatus,
  to: CreatorContentStatus,
): boolean {
  return CREATOR_CONTENT_TRANSITIONS[from].includes(to);
}

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalCreatorOfferTransition(
  from: CreatorOfferStatus,
  to: CreatorOfferStatus,
): boolean {
  return CREATOR_OFFER_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Closed subject vocabularies (migration 031 CHECKs — data, never coupling)
// ---------------------------------------------------------------------------

/** Declared audience tier (closed set — segmentation input, CREATOR-AC-05 data). */
export const CREATOR_FAN_TIERS = ['standard', 'vip', 'top_fan', 'new_fan'] as const;
export type CreatorFanTier = (typeof CREATOR_FAN_TIERS)[number];

/** Provider-neutral conversation channel (closed set — data). */
export const CREATOR_CONVERSATION_CHANNELS = ['dm', 'post_comment', 'live_chat', 'email'] as const;
export type CreatorConversationChannel = (typeof CREATOR_CONVERSATION_CHANNELS)[number];

/** Provider-neutral content kind (closed set — data). */
export const CREATOR_CONTENT_KINDS = [
  'post',
  'video_short',
  'video_long',
  'photo_set',
  'stream',
  'newsletter',
] as const;
export type CreatorContentKind = (typeof CREATOR_CONTENT_KINDS)[number];

/** Provider-neutral offer kind (closed set — data). */
export const CREATOR_OFFER_KINDS = [
  'subscription',
  'ppv_message',
  'bundle',
  'custom',
  'tip',
] as const;
export type CreatorOfferKind = (typeof CREATOR_OFFER_KINDS)[number];

// ---------------------------------------------------------------------------
// The approval-gate vocabulary (CREATOR-AC-06 — frozen, migration 031)
// ---------------------------------------------------------------------------

/**
 * The closed sensitive-action operation vocabulary of the pack's §5
 * "Sensitive or high-risk operations must use Policy and human approval
 * gates": the two pack side effects that produce OUTBOUND state. These are
 * the operation labels the /policies authority sees on the network
 * dimension, and the action labels of the pack-owned approval records.
 */
export const CREATOR_GATE_OPERATIONS = [
  'creator.conversation.send',
  'creator.content.publish',
] as const;
export type CreatorGateOperation = (typeof CREATOR_GATE_OPERATIONS)[number];

/**
 * The policy dimension the gates evaluate on: outbound creator
 * communication/publication is NETWORK EGRESS (POL-001: "network egress
 * boundaries (outbound hosts/protocols from execution contexts)"). The
 * pack never invents a policy dimension — the seven-dimension set is
 * frozen at /policies.
 */
export const CREATOR_GATE_POLICY_DIMENSION = 'network' as const;

/**
 * The SERVER-DERIVED approval attribute the gate composes onto the policy
 * action descriptor: 'approved' when a valid pack approval record was
 * presented, 'missing' when none was. The CONFIGURED policy rule decides
 * which value it requires (an allow rule with approvalStatus='approved'
 * demands approval; one with 'missing' allows direct sends; deny rules
 * veto; nothing matching fails closed). Callers can never supply this
 * attribute — the module derives it from the approval record state.
 */
export const CREATOR_GATE_APPROVAL_ATTRIBUTE = 'approvalStatus' as const;
export const CREATOR_GATE_APPROVAL_STATUSES = ['approved', 'missing'] as const;
export type CreatorGateApprovalStatus = (typeof CREATOR_GATE_APPROVAL_STATUSES)[number];

/**
 * The frozen approval decision vocabulary of the pack-owned approval
 * records (migration 031): 'approved' satisfies a configured approval
 * requirement; 'rejected' is an explicit NO. Both append-only — a
 * re-decision appends a NEW record.
 */
export const CREATOR_APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type CreatorApprovalDecision = (typeof CREATOR_APPROVAL_DECISIONS)[number];

/**
 * Local mirror of the frozen /field-agents Human Agent specialization
 * registry (the /jobs precedent: "kept as local pattern constants so this
 * module never imports [the sibling] internals; tests pin the registries
 * and patterns stay in sync"). The Creator Operations human roles
 * (creator-operations-v1.3.md §4) are specializations of the GENERIC
 * Human Agent model — capability metadata, never a second execution
 * model. The approver provenance on approval records and the human-task
 * guidance in workflow templates draw from this closed set.
 */
export const CREATOR_HUMAN_SPECIALIZATION_MIRROR = [
  'field_agent',
  'chatter',
  'creator_manager',
  'content_manager',
  'growth_manager',
  'account_manager',
  'reviewer',
  'sales_agent',
] as const;
export type CreatorHumanSpecialization = (typeof CREATOR_HUMAN_SPECIALIZATION_MIRROR)[number];

/**
 * The Creator Operations human roles (§4) as Human Agent specializations
 * — the subset of the registry this pack's templates and approvals use.
 */
export const CREATOR_ROLE_SPECIALIZATIONS = [
  'creator_manager',
  'chatter',
  'content_manager',
  'growth_manager',
  'account_manager',
  'reviewer',
] as const;

// ---------------------------------------------------------------------------
// The creator metric-name vocabulary (CREATOR-AC-02 — the /metrics mapping)
// ---------------------------------------------------------------------------

/**
 * The closed creator metric-name set the pack's observation mapping emits
 * into the COMMON /metrics ledger (the mapping targets, documented by the
 * pack's metric-definition artifacts). Names are provider-neutral data;
 * values/dimensions arrive from the observation inputs.
 */
export const CREATOR_METRIC_NAMES = [
  'creator.audience.event_count',
  'creator.conversation.event_count',
  'creator.content.event_count',
  'creator.engagement.event_count',
  'creator.monetization.revenue_cents',
  'creator.performance.fan_count',
  'creator.performance.revenue_total_cents',
  'creator.performance.engagement_count',
  'creator.performance.content_publish_count',
  'creator.performance.conversation_response_rate',
] as const;
export type CreatorMetricName = (typeof CREATOR_METRIC_NAMES)[number];

/**
 * The closed observation subject kinds of the pack's §7 evidence/metric
 * mapping: audience/fan, conversation, content, engagement, monetization
 * observations (CREATOR-AC-02's enumeration) plus the derived creator
 * performance metric subject (§2).
 */
export const CREATOR_OBSERVATION_SUBJECT_KINDS = [
  'audience',
  'conversation',
  'content',
  'engagement',
  'monetization',
  'performance',
] as const;
export type CreatorObservationSubjectKind = (typeof CREATOR_OBSERVATION_SUBJECT_KINDS)[number];

// ---------------------------------------------------------------------------
// Server-derived provenance (never a request field)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of one pack operation that reaches the
 * composed authorities (the evidence/metric/policy provenance shape).
 * Built exclusively by server code from the authenticated principal, the
 * ambient correlation context and the recording system — never from a
 * request body (route validation rejects provenance-shaped authority
 * fields; this is a separate service-API argument so no DTO can feed it
 * structurally).
 */
export interface CreatorProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' for the HTTP surface). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Durable pack-owned record shapes (migration 031)
// ---------------------------------------------------------------------------

/** One append-only Creator Profile row (§2 — the Client-scoped subject). */
export interface CreatorProfileRecord {
  readonly profileId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly displayName: string;
  readonly handle: string;
  readonly niches: ReadonlyArray<string>;
  readonly bio: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/** One Creator Account row (§2 — provider-neutral platform label). */
export interface CreatorAccountRecord {
  readonly accountId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly profileId: string;
  readonly platformLabel: string;
  readonly accountHandle: string;
  readonly status: CreatorAccountStatus;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retiredAt: string | null;
}

/** One Audience Member / Fan row (§2 — bounded declared data only). */
export interface CreatorFanRecord {
  readonly fanId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly accountId: string;
  readonly fanAlias: string;
  readonly status: CreatorFanStatus;
  readonly tier: CreatorFanTier;
  readonly tags: ReadonlyArray<string>;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly removedAt: string | null;
}

/** One Conversation row (§2). */
export interface CreatorConversationRecord {
  readonly conversationId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly accountId: string;
  readonly fanId: string;
  readonly status: CreatorConversationStatus;
  readonly channel: CreatorConversationChannel;
  readonly topic: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

/** One conversation message row (inbound observation or gated outbound send). */
export interface CreatorMessageRecord {
  readonly messageId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly conversationId: string;
  readonly direction: 'inbound' | 'outbound';
  /** 'received' (inbound observation) or 'sent' (gated outbound side effect). */
  readonly status: 'received' | 'sent';
  readonly body: string;
  /** The allowing policy decision id — NOT NULL iff direction='outbound'. */
  readonly policyDecisionId: string | null;
  /** The pack approval record that satisfied a configured approval requirement. */
  readonly approvalId: string | null;
  /** The /evidence record the observation mapping appended for this message. */
  readonly evidenceRef: string | null;
  readonly idempotencyKey: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

/** One Content Asset row (§2 — the publish-gated side effect lives here). */
export interface CreatorContentAssetRecord {
  readonly assetId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly profileId: string;
  readonly status: CreatorContentStatus;
  readonly title: string;
  readonly contentKind: CreatorContentKind;
  readonly plannedPlatforms: ReadonlyArray<string>;
  readonly brief: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly rejectedAt: string | null;
  /** The allowing policy decision id — NOT NULL iff status='published'. */
  readonly policyDecisionId: string | null;
  readonly approvalId: string | null;
}

/** One Offer row (§2). */
export interface CreatorOfferRecord {
  readonly offerId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly profileId: string;
  readonly status: CreatorOfferStatus;
  readonly title: string;
  readonly offerKind: CreatorOfferKind;
  readonly priceCents: number;
  readonly currency: string;
  readonly terms: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retiredAt: string | null;
}

/** One append-only pack-owned human approval record (CREATOR-AC-06). */
export interface CreatorOperationApprovalRecord {
  readonly approvalId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly action: CreatorGateOperation;
  readonly resourceId: string;
  readonly decision: CreatorApprovalDecision;
  readonly approverUserId: string;
  /** The Human Agent specializations the approver carried at decision time (server-derived). */
  readonly approverSpecializations: readonly string[];
  readonly notes: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Structural ports (the /metrics-for-/clients precedent — see the header)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /clients CANONICAL OWNER CONTEXT the pack
 * consumes: the resolved Client's identity, owning Agency and status (the
 * public-contract shape /metrics declared for the same need). The real
 * ClientOwnerContext satisfies this structurally — /clients remains the
 * ONLY Client ownership authority (CREATOR-AC-01).
 */
export interface CreatorClientOwnershipSnapshot {
  readonly scope: {
    readonly kind: 'client';
    readonly agencyId: string;
    readonly clientId: string;
  };
  readonly client: {
    readonly clientId: string;
    readonly agencyId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /clients public contract the pack depends on: canonical
 * server-side Client ownership resolution from durable state. Satisfied
 * structurally by ClientsModuleApi.resolveClientOwnership; wired at the
 * composition root.
 */
export interface CreatorClientsPort {
  resolveClientOwnership(clientId: string): Promise<CreatorClientOwnershipSnapshot | null>;
}

/** A minimal view of one appended /evidence record (the mapping's receipt). */
export interface CreatorEvidenceReceipt {
  readonly evidenceId: string;
}

/**
 * The slice of the /evidence public contract the pack's observation
 * mapping depends on: appending one immutable observation record with
 * SERVER-DERIVED provenance (the concrete module API method name and
 * input/output shape — the structural-port satisfaction is proven by the
 * composition-root wiring). The input mirrors the evidence append input
 * (client scope, class, source, observedAt, content, quality, confidence,
 * supersession); the concrete EvidenceModuleApi satisfies this
 * structurally; wired at the composition root. The pack owns the MAPPING
 * — /evidence stays the only evidence authority (CREATOR-AC-02).
 */
export interface CreatorEvidencePort {
  appendEvidence(
    input: {
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly class: string;
      readonly source: { readonly system: string; readonly ref: string | null };
      readonly observedAt: string;
      readonly content: Readonly<Record<string, unknown>>;
      readonly contentRef: string | null;
      readonly quality: string;
      readonly confidence: number | null;
      readonly supersedesEvidenceId: string | null;
    },
    provenance: CreatorProvenance,
  ): Promise<CreatorEvidenceReceipt>;
}

/** A minimal view of one appended /metrics observation (the mapping's receipt). */
export interface CreatorMetricReceipt {
  readonly observationId: string;
}

/**
 * The slice of the /metrics public contract the pack's observation mapping
 * depends on: appending one normalized metric observation with
 * SERVER-DERIVED provenance (the concrete module API method name and
 * input/output shape). The concrete MetricsModuleApi satisfies this
 * structurally; wired at the composition root. /metrics stays the only
 * metric normalization authority (CREATOR-AC-02).
 */
export interface CreatorMetricsPort {
  appendMetricObservation(
    input: {
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly metricName: string;
      readonly dimensions: Readonly<Record<string, string | number | boolean>>;
      readonly value: number;
      readonly unit: string;
      readonly source: { readonly system: string; readonly ref: string | null };
      readonly observedAt: string;
      readonly retrievedAt: string | null;
      readonly evidenceRef: string | null;
      readonly quality: string;
      readonly aggregationMethod: string | null;
    },
    provenance: CreatorProvenance,
  ): Promise<CreatorMetricReceipt>;
}

/** A minimal view of one /policies decision record (the gate's verdict). */
export interface CreatorPolicyDecisionSnapshot {
  readonly decisionId: string;
  readonly outcome: 'allow' | 'deny' | 'unknown';
  readonly reasonCode: string;
}

/**
 * The slice of the /policies public contract the pack's approval gates
 * depend on: FAIL-CLOSED evaluation of a proposed action against the
 * declared policy boundaries, recorded append-only with server-derived
 * provenance (the concrete module API method name and input/output
 * shape). The concrete PoliciesModuleApi satisfies this structurally;
 * wired at the composition root. /policies stays the only policy
 * authority — the pack never evaluates rules itself (CREATOR-AC-06).
 */
export interface CreatorPoliciesPort {
  evaluateAction(
    input: {
      readonly action: {
        readonly dimension: string;
        readonly operation: string;
        readonly resource: string | null;
        readonly attributes: Readonly<Record<string, string>>;
      };
      readonly scope: { readonly agencyId: string; readonly clientId: string | null };
    },
    provenance: CreatorProvenance,
  ): Promise<CreatorPolicyDecisionSnapshot>;
}

/**
 * THE FAIL-CLOSED ENFORCEMENT OUTCOME (POL-001: only an explicit 'allow'
 * permits; 'deny' AND 'unknown' both deny). A local pure mirror of the
 * /policies public contract's enforcement predicate — the pack cannot
 * import that entry without breaking the MKT-036 framework boundary, so
 * the frozen two-line semantics is pinned here and by unit tests (the
 * /jobs local-registry-mirror precedent).
 */
export function creatorEnforcementOutcome(
  decision: Pick<CreatorPolicyDecisionSnapshot, 'outcome'>,
): 'allow' | 'deny' {
  return decision.outcome === 'allow' ? 'allow' : 'deny';
}

/** A minimal view of one registered /ai-runtime TaskProfile (the receipt). */
export interface CreatorTaskProfileReceipt {
  readonly taskProfile: {
    readonly taskProfileId: string;
  };
  readonly replayed: boolean;
}

/**
 * One AI task declaration of the pack (§5) — EXACTLY the eleven §10
 * TaskProfile contract fields. Provider/model names appear ONLY inside
 * the bounded label data (taskClass/qualityTarget strings); no SDK, no
 * credential, no provider coupling (CREATOR-AC-03).
 */
export interface CreatorTaskProfileDeclaration {
  readonly taskClass: string;
  readonly qualityTarget: string;
  readonly riskClass: string;
  readonly contextRequirements: Readonly<Record<string, unknown>>;
  readonly latencyTargetMs: number;
  readonly maxCostPerInvocation: number;
  readonly privacyClass: string;
  readonly toolRequirements: readonly string[];
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly evaluatorIds: readonly string[];
  readonly escalationPolicy: Readonly<Record<string, unknown>>;
}

/**
 * The slice of the /ai-runtime public contract the pack depends on:
 * registering one workspace-scoped TaskProfile (the §10 creation surface —
 * the concrete module API method name and input/output shape),
 * idempotently. The concrete AiRuntimeModuleApi satisfies this
 * structurally; wired at the composition root. /ai-runtime stays the only
 * AI routing authority — pack AI tasks are consumed through the AI Router,
 * never through provider-specific model calls (CREATOR-AC-03).
 */
export interface CreatorAiRuntimePort {
  createTaskProfile(input: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly profile: CreatorTaskProfileDeclaration;
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<CreatorTaskProfileReceipt>;
}

// ---------------------------------------------------------------------------
// Operation inputs
// ---------------------------------------------------------------------------

export interface CreatorProfileRecordInput {
  /** The EXISTING Client boundary (CREATOR-AC-01) — resolved canonically inside. */
  readonly clientId: string;
  readonly displayName: string;
  readonly handle: string;
  readonly niches: readonly string[];
  readonly bio: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface CreatorAccountRecordInput {
  readonly profileId: string;
  readonly platformLabel: string;
  readonly accountHandle: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface CreatorFanRecordInput {
  readonly accountId: string;
  readonly fanAlias: string;
  readonly tier: CreatorFanTier;
  readonly tags: readonly string[];
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface CreatorConversationOpenInput {
  readonly accountId: string;
  readonly fanId: string;
  readonly channel: CreatorConversationChannel;
  readonly topic: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface CreatorMessageSendInput {
  readonly conversationId: string;
  readonly body: string;
  readonly idempotencyKey: string;
  /**
   * The pack approval record presented to satisfy a CONFIGURED approval
   * requirement (null when none was). Validity (same client, same
   * conversation, action 'creator.conversation.send', decision
   * 'approved') is verified server-side BEFORE the policy gate composes
   * approvalStatus — callers cannot forge the attribute.
   */
  readonly approvalId: string | null;
}

export interface CreatorContentAssetRecordInput {
  readonly profileId: string;
  readonly title: string;
  readonly contentKind: CreatorContentKind;
  readonly plannedPlatforms: readonly string[];
  readonly brief: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface CreatorOfferRecordInput {
  readonly profileId: string;
  readonly title: string;
  readonly offerKind: CreatorOfferKind;
  readonly priceCents: number;
  readonly currency: string;
  readonly terms: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface CreatorApprovalRecordInput {
  readonly clientId: string;
  readonly action: CreatorGateOperation;
  readonly resourceId: string;
  readonly decision: CreatorApprovalDecision;
  /**
   * The approving platform user — server-derived at the route layer from
   * the authenticated principal (never request-suppliable).
   */
  readonly approverUserId: string;
  /**
   * The Human Agent specializations the approver carried at decision
   * time — server-derived from the /field-agents profile by the route
   * layer (never request-suppliable).
   */
  readonly approverSpecializations: readonly string[];
  readonly notes: string;
  readonly idempotencyKey: string;
}

/**
 * One creator observation mapped into the COMMON /evidence and /metrics
 * contracts (CREATOR-AC-02): an immutable evidence observation record
 * (class 'observation', source 'creator-operations') plus — when `metric`
 * is present — the normalized metric observation bound to that evidence
 * record through evidenceRef. The pack owns the mapping; the authorities
 * own the ledgers.
 */
export interface CreatorObservationInput {
  readonly clientId: string;
  /** Optional Workspace scope inside the owning Client. */
  readonly workspaceId: string | null;
  readonly subjectKind: CreatorObservationSubjectKind;
  /** The pack-owned subject the observation is about (account/fan/conversation/asset id — bounded label). */
  readonly subjectRef: string | null;
  /** Bounded observation event kind (e.g. 'fan_subscribed', 'message_received', 'content_published'). */
  readonly eventKind: string;
  /** The bounded observation payload (the evidence content — §21-fenced). */
  readonly content: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
  /** Evidence quality grade (A..F) — caller-declared against the closed set. */
  readonly quality: string;
  /** Optional metric mapping (null = evidence-only observation). */
  readonly metric: {
    readonly name: CreatorMetricName;
    readonly value: number;
    readonly unit: string;
    readonly dimensions: Readonly<Record<string, string | number | boolean>>;
    readonly aggregationMethod: string | null;
  } | null;
  readonly idempotencyKey: string;
}

/** The receipt of one mapped observation. */
export interface CreatorObservationReceipt {
  readonly evidenceId: string;
  readonly observationId: string | null;
}

/** The receipt of one provisioned TaskProfile registration. */
export interface CreatorTaskProfileProvisionReceipt {
  readonly taskClass: string;
  readonly taskProfileId: string;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// The pack service API
// ---------------------------------------------------------------------------

/**
 * The Creator Operations pack service — the provider-neutral domain
 * surface MKT-037 contributes through the /domain-packs module. It is a
 * COMPOSITION layer over the platform authorities (see the header), not a
 * second authority: subject records are pack-owned Client-scoped rows of
 * migration 031; observations map into /evidence + /metrics; AI tasks are
 * TaskProfiles of /ai-runtime; human work is Jobs of /jobs projected from
 * the pack's workflow templates; side effects pass the /policies fail
 * closed gate.
 */
export interface CreatorOperationsPackApi {
  // ----- The §2 subject records (CREATOR-AC-01 — Client-scoped) ----------

  /**
   * Records one Creator Profile (append-only). Client ownership is
   * resolved canonically through the /clients port BEFORE any write:
   * unknown or tombstoned Client → NotFoundError (uniform); disabled
   * Client → ConflictError. The (client, handle) uniqueness fence
   * converges duplicate logical commands (idempotency replay).
   */
  recordCreatorProfile(
    input: CreatorProfileRecordInput,
    actorId: string | null,
  ): Promise<CreatorProfileRecord>;
  /** Raw profile row by id — append-only history is always readable. */
  getCreatorProfile(profileId: string): Promise<CreatorProfileRecord | null>;
  /** The Client's profiles, newest first (bounded, server-chosen limit). */
  listCreatorProfilesForClient(clientId: string): Promise<readonly CreatorProfileRecord[]>;

  /**
   * Records one Creator Account (born active) under a same-Client profile.
   * The profile is resolved first (uniform 404); the Client chain is
   * resolved through the /clients port; the scope trigger re-fences.
   */
  recordCreatorAccount(
    input: CreatorAccountRecordInput,
    actorId: string | null,
  ): Promise<CreatorAccountRecord>;
  /** Raw account row by id. */
  getCreatorAccount(accountId: string): Promise<CreatorAccountRecord | null>;
  /** The profile's accounts (every state — terminal history stays visible), newest first. */
  listCreatorAccountsForProfile(profileId: string): Promise<readonly CreatorAccountRecord[]>;
  /**
   * CAS lifecycle transition on the frozen account table (active ⇄ paused,
   * terminal retire). Illegal transitions conflict; CAS races conflict;
   * terminal rows reject every change.
   */
  setCreatorAccountStatus(input: {
    readonly accountId: string;
    readonly status: CreatorAccountStatus;
    readonly expectedVersion: number;
    readonly actorId: string | null;
  }): Promise<CreatorAccountRecord>;

  /**
   * Records one Audience Member / Fan (born subscribed) under a
   * same-Client account. Bounded declared data only (§8 — no raw PII
   * blobs).
   */
  recordCreatorFan(input: CreatorFanRecordInput, actorId: string | null): Promise<CreatorFanRecord>;
  /** Raw fan row by id. */
  getCreatorFan(fanId: string): Promise<CreatorFanRecord | null>;
  /** The account's fans (every state), newest first. */
  listCreatorFansForAccount(accountId: string): Promise<readonly CreatorFanRecord[]>;
  /** CAS lifecycle transition on the frozen fan table (subscribed ⇄ churned, terminal remove). */
  setCreatorFanStatus(input: {
    readonly fanId: string;
    readonly status: CreatorFanStatus;
    readonly expectedVersion: number;
    readonly actorId: string | null;
  }): Promise<CreatorFanRecord>;

  /**
   * Opens one Conversation (born open) between a same-account fan and the
   * account, in a provider-neutral channel.
   */
  openCreatorConversation(
    input: CreatorConversationOpenInput,
    actorId: string | null,
  ): Promise<CreatorConversationRecord>;
  /** Raw conversation row by id. */
  getCreatorConversation(conversationId: string): Promise<CreatorConversationRecord | null>;
  /** The account's conversations (every state), newest first. */
  listCreatorConversationsForAccount(
    accountId: string,
  ): Promise<readonly CreatorConversationRecord[]>;
  /** CAS lifecycle transition on the frozen conversation table (open ⇄ paused, terminal close). */
  setCreatorConversationStatus(input: {
    readonly conversationId: string;
    readonly status: CreatorConversationStatus;
    readonly expectedVersion: number;
    readonly actorId: string | null;
  }): Promise<CreatorConversationRecord>;

  // ----- The conversation surface (CREATOR-AC-06 gated) -----------------

  /**
   * Records one INBOUND message — an OBSERVATION, born 'received': the
   * conversation must be live (open|paused), the message is appended
   * immutably and, when `mapToEvidence` is true, the pack's §7 mapping
   * appends the corresponding /evidence observation record through the
   * evidence port (the receipt is stored as the row's evidenceRef).
   * Inbound rows NEVER carry approval provenance (only side effects do).
   */
  recordCreatorInboundMessage(
    input: CreatorMessageSendInput & { readonly mapToEvidence: boolean },
    actorId: string | null,
    provenance: CreatorProvenance | null,
  ): Promise<CreatorMessageRecord>;

  /**
   * Sends one OUTBOUND message — THE CREATOR-AC-06 APPROVAL-GATED SIDE
   * EFFECT. Fail-closed order: resolve the conversation (uniform 404) →
   * resolve the Client chain through the /clients port → the conversation
   * must be OPEN → validate the presented approval record (same Client,
   * this conversation, action 'creator.conversation.send', decision
   * 'approved') → EVALUATE THE POLICY ACTION through the /policies port
   * (dimension 'network', operation 'creator.conversation.send', resource
   * the conversation id, attribute approvalStatus 'approved'|'missing'
   * composed SERVER-SIDE from the approval state) → ONLY an explicit
   * 'allow' writes the row: born 'sent' carrying the allowing policy
   * decision id and the satisfying approval record id. Deny/unknown/
   * error/no-matching-rule → PolicyDeniedError BEFORE any write (an
   * unapproved send never produces a row). `provenance` is REQUIRED (it is
   * the policy decision provenance).
   */
  sendCreatorOutboundMessage(
    input: CreatorMessageSendInput,
    actorId: string | null,
    provenance: CreatorProvenance,
  ): Promise<CreatorMessageRecord>;

  /** The conversation's immutable message history, oldest first. */
  listCreatorMessages(conversationId: string): Promise<readonly CreatorMessageRecord[]>;

  // ----- Content assets (CREATOR-AC-06 publish gate) ---------------------

  /**
   * Records one Content Asset (born draft) under a same-Client profile —
   * provider-neutral planned platforms only (labels are data,
   * CREATOR-AC-05).
   */
  recordCreatorContentAsset(
    input: CreatorContentAssetRecordInput,
    actorId: string | null,
  ): Promise<CreatorContentAssetRecord>;
  /** Raw content row by id. */
  getCreatorContentAsset(assetId: string): Promise<CreatorContentAssetRecord | null>;
  /** The profile's content assets (every state), newest first. */
  listCreatorContentAssetsForProfile(
    profileId: string,
  ): Promise<readonly CreatorContentAssetRecord[]>;
  /**
   * Lifecycle transition on the frozen content table (draft → in_review →
   * approved → published with the terminal reject side-exits). The
   * PUBLISHED edge is the CREATOR-AC-06 approval-gated side effect: same
   * fail-closed policy gate as the outbound send (operation
   * 'creator.content.publish', resource the asset id, approvalStatus
   * composed server-side from the presented approval record), and only an
   * explicit 'allow' stamps published_at + the allowing decision id.
   * `provenance` is required iff the target status is 'published'.
   */
  transitionCreatorContentAsset(input: {
    readonly assetId: string;
    readonly status: CreatorContentStatus;
    readonly expectedVersion: number;
    readonly actorId: string | null;
    readonly approvalId: string | null;
    readonly provenance: CreatorProvenance | null;
  }): Promise<CreatorContentAssetRecord>;

  // ----- Offers ------------------------------------------------------------

  /**
   * Records one Offer (born draft) under a same-Client profile —
   * provider-neutral offer kind and bounded price contract.
   */
  recordCreatorOffer(
    input: CreatorOfferRecordInput,
    actorId: string | null,
  ): Promise<CreatorOfferRecord>;
  /** Raw offer row by id. */
  getCreatorOffer(offerId: string): Promise<CreatorOfferRecord | null>;
  /** The profile's offers (every state), newest first. */
  listCreatorOffersForProfile(profileId: string): Promise<readonly CreatorOfferRecord[]>;
  /** CAS lifecycle transition on the frozen offer table (draft → active ⇄ paused, terminal retire). */
  setCreatorOfferStatus(input: {
    readonly offerId: string;
    readonly status: CreatorOfferStatus;
    readonly expectedVersion: number;
    readonly actorId: string | null;
  }): Promise<CreatorOfferRecord>;

  // ----- The pack-owned approval records (CREATOR-AC-06) -----------------

  /**
   * Records one HUMAN APPROVAL (append-only: 'approved' satisfies a
   * configured approval requirement; 'rejected' is an explicit NO; a
   * re-decision appends a NEW record). The approver identity and the
   * approver's Human Agent specializations are SERVER-DERIVED inputs
   * composed by the route layer from the authenticated principal and the
   * /field-agents profile. The approval does NOT itself perform the side
   * effect — the gated operation re-verifies it at send/publish time.
   */
  recordCreatorOperationApproval(
    input: CreatorApprovalRecordInput,
    actorId: string | null,
    provenance: CreatorProvenance | null,
  ): Promise<CreatorOperationApprovalRecord>;
  /** The approval history of one (action, resource) pair, newest first. */
  listCreatorApprovalsForResource(input: {
    readonly action: CreatorGateOperation;
    readonly resourceId: string;
  }): Promise<readonly CreatorOperationApprovalRecord[]>;

  // ----- The observation mapping (CREATOR-AC-02) ---------------------------

  /**
   * Maps one creator observation into the COMMON /evidence and /metrics
   * contracts: the immutable evidence observation record (class
   * 'observation', source system 'creator-operations', §21-fenced content)
   * and, when the input carries a metric mapping, the normalized metric
   * observation referencing the evidence record (evidenceRef). Client
   * ownership is resolved canonically first (fail closed). The pack owns
   * the mapping — /evidence and /metrics stay the only observation
   * authorities.
   */
  recordCreatorObservation(
    input: CreatorObservationInput,
    provenance: CreatorProvenance,
  ): Promise<CreatorObservationReceipt>;

  // ----- AI task declarations (CREATOR-AC-03) ------------------------------

  /**
   * Provisions the pack's declared AI task classes as REAL TaskProfiles of
   * the /ai-runtime authority in one Workspace scope (idempotent per
   * profile: `${idempotencyKey}:${taskClass}`). Every registration goes
   * through the TaskProfile creation surface — pack AI tasks are consumed
   * through the platform AI Router, never through provider-specific model
   * calls. Fails closed on the first registration error.
   */
  provisionCreatorTaskProfiles(input: {
    readonly scope: {
      readonly workspaceId: string;
      readonly clientId: string;
      readonly agencyId: string;
    };
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }): Promise<readonly CreatorTaskProfileProvisionReceipt[]>;

  // ----- Pack publication through the MKT-036 framework --------------------

  /**
   * Publishes THE FROZEN Creator Operations pack manifest as an immutable
   * registry version through the /domain-packs framework authority (the
   * manifest guard validates every artifact — including §4 workflow
   * template conformance through the Workflow authority's own validator —
   * before any write). Re-publication of the same version is a
   * ConflictError; a semantic change publishes a NEW version.
   */
  publishCreatorOperationsPack(input: {
    readonly actorId: string | null;
    readonly idempotencyKey: string;
  }): Promise<DomainPackRegistryRecord>;
  /** The frozen manifest (pure read — routes/tests surface it without publishing). */
  getCreatorOperationsManifest(): DomainPackManifest;
}

// ---------------------------------------------------------------------------
// The pack service dependencies
// ---------------------------------------------------------------------------

export interface CreatorOperationsPackDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The /domain-packs framework authority — SAME MODULE (the pack lives
   * inside the module tree; this is the intra-module public-contract
   * import). Publication of the frozen manifest flows through it.
   */
  readonly domainPacks: DomainPacksModuleApi;
  /**
   * Canonical Client ownership resolution THROUGH the /clients public
   * contract (structural port; wired at the composition root).
   */
  readonly clients: CreatorClientsPort;
  /**
   * The /evidence authority append surface for the §7 observation mapping
   * (structural port; wired at the composition root).
   */
  readonly evidence: CreatorEvidencePort;
  /**
   * The /metrics authority append surface for the §7 observation mapping
   * (structural port; wired at the composition root).
   */
  readonly metrics: CreatorMetricsPort;
  /**
   * The /policies authority fail-closed evaluation surface for the
   * CREATOR-AC-06 gates (structural port; wired at the composition root).
   */
  readonly policies: CreatorPoliciesPort;
  /**
   * The /ai-runtime TaskProfile creation surface for the pack's AI task
   * declarations (structural port; wired at the composition root).
   */
  readonly aiRuntime: CreatorAiRuntimePort;
}
