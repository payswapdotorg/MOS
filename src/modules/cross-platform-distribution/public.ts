/**
 * MarketingOS module: /cross-platform-distribution
 * Authority: Cross-Platform Distribution (MKT-065 — spec/
 * effective-backlog-v1.6.md; spec/architecture-v1.6.md §5: "A Distribution
 * Plan maps Source Asset → Rights/Provenance → Transformation Plan →
 * Target Platform → Target Account → Target Format → Publication →
 * Measurement. Cross-platform publication is legal/policy-gated per
 * destination. ... A platform connection never implies rights to
 * redistribute content that originated elsewhere"; spec/
 * architecture-lock-v1.6.md rules 20 ("Cross-platform distribution is
 * rights-gated per source asset and destination") and 29 ("Cross-platform
 * publishing requires both source rights and destination
 * capability/policy clearance"); spec/module-dependency-matrix-v1.6.md
 * frozen row "/cross-platform-distribution → /growth-missions,
 * /social-accounts, /content-assets, /content-rights, /integrations,
 * /policies").
 *
 * This module owns the DISTRIBUTION PLAN authority: planning and recording
 * rights/policy-gated multi-destination distribution of a canonical
 * source or derived asset to multiple connected social accounts.
 *
 *   - the PLAN records (migration 055): one durable §5 chain declaration —
 *     the SOURCE ASSET (an opaque 064 'ca:' ref resolved to its EXPLICIT
 *     version before any write — never a floating pointer), the
 *     TRANSFORMATION PLAN (the bounded declared mapping to versioned
 *     derived outputs, each resolved the same way), the optional MISSION
 *     ANCHOR (a read-only /growth-missions reference — the mission
 *     authority stays sole for mission identity/lifecycle; this module
 *     NEVER mutates a mission), and the deterministic canonical input
 *     digest of the declaration;
 *   - the DESTINATION VARIANT records: the fan-out — one source → N
 *     destinations, each with its own TARGET ACCOUNT (a read-only
 *     /social-accounts anchor), platform id (data), TARGET FORMAT,
 *     destination-specific publish request (the 056 shape frozen at
 *     planning) and the derived deterministic idempotency key
 *     (cpd:<plan>:<destination> — the at-most-once identity toward the
 *     056 ledger), with the per-destination outcome pointer moving only
 *     along the frozen outcome vocabulary;
 *   - the PUBLICATION records: the per-destination submit-time link to
 *     the 056 publish idempotency ledger (the attempt id, the submit-time
 *     state mirror, the provider refs, the duplicate flag) — ONE
 *     append-only row per destination; the LIVE publication truth stays
 *     the 056 ledger (social_publish_attempts), never re-stated here;
 *   - the fully APPEND-ONLY historical lineage tail: planning, gate
 *     evaluations (the 063 verdicts WITH reasons), capability resolutions
 *     (the per-platform validation verdicts WITH reasons), policy
 *     evaluations (the dispatch gate decisions), publication attempts
 *     (the 056 results with provider refs), dispatch completion and
 *     measurement references — recorded as immutable events with full
 *     structured payloads and server-derived provenance (UPDATE/DELETE
 *     are rejected by the migration-055 DB triggers — the 047/052/053
 *     pattern).
 *
 * THE FAN-OUT EXECUTION (dispatchDistributionPlan) — fail-closed PER
 * DESTINATION, one destination's outcome never blocks the others:
 *   1. THE 063 RIGHTS GATE FIRST (legal/policy-gated per destination):
 *      evaluatePublicationGate(assetRef, destinationPlatform) is called
 *      BEFORE any publication attempt; only `allow` permits an autonomous
 *      publish — `review_required` and `blocked` NEVER publish (the
 *      destination is recorded rights_review_required / rights_blocked;
 *      review_required is the blocked_pending_human_action surface). This
 *      module COMPOSES the gate — it records the verdicts, it never
 *      re-evaluates rights and holds no rights authority of its own (the
 *      063 boundary rule: the gate holds no publication authority, THIS
 *      module is the publication executor).
 *   2. PER-PLATFORM CAPABILITY VALIDATION (lock rules 19/29): the
 *      destination account's REAL capabilities are resolved through the
 *      /social-accounts public contract (resolveAccountCapabilityMatrix —
 *      the grants, the platform-normalized capability tags and the
 *      declared adapter capability matrix) and the /integrations adapter
 *      registry (listRegisteredAdapters — the 056 normalized adapter
 *      contract registry). Capability parity is NEVER assumed: a
 *      destination lacking the required publish capability (unregistered
 *      platform adapter, unusable authorization, undeclared publish
 *      operation, unsatisfied scopes, unregistered integration adapter)
 *      is REJECTED and recorded with reasons — never attempted blind.
 *   3. THE DISPATCH POLICY GATE (/policies, read via the public
 *      contract): the network-dimension action
 *      'content.distribution.dispatch' (resource = destination platform)
 *      is evaluated fail-closed on EVERY destination — only an explicit
 *      allow permits; deny and unknown both BLOCK (the decision rides
 *      the policy engine's own append-only ledger; this module holds NO
 *      policy authority — it reads the decisions and records their ids).
 *   4. THE PUBLICATION ATTEMPT (destination-specific publishing): the
 *      056 contract's submitPublish (the idempotency ledger — provider
 *      refs, accepted/published/failed/restricted outcomes) with the
 *      destination-specific format/parameters and the derived
 *      deterministic idempotency key. The physical publish goes
 *      EXCLUSIVELY through this contract — NO parallel HTTP client, NO
 *      second execution engine. A 'submitted' attempt stays UNKNOWN
 *      (destination 'publishing' — pending reconciliation, never blindly
 *      replayed under the same key).
 *
 * What this module deliberately does NOT do (the lock rules):
 *   - NO second execution engine: the physical publish flows through the
 *     056 adapter submitPublish contract only; there is no provider
 *     HTTP client, worker host, dispatch loop or runtime identity here;
 *   - NO rights authority: the 063 gate is composed, never duplicated —
 *     rights states are never re-evaluated, re-derived or re-interpreted;
 *   - NO workflow/execution authority: plans, attempts and outcomes are
 *     DATA toward the mission/operator layer (§13 composes this module;
 *     this module never composes the operator);
 *   - NO policy authority: /policies decisions ride the policy ledger;
 *     this module reads them;
 *   - NO mission mutation: the mission anchor is a read-only reference;
 *   - NO provider/platform knowledge: platform ids are opaque adapter
 *     keys carried as data; platform rules live behind the adapter plane;
 *   - NO /ai-runtime dependency (the frozen row lists none): the module
 *     is fully deterministic.
 *
 * DEPENDENCY POSTURE (frozen matrix: /cross-platform-distribution ──→
 * /growth-missions, /social-accounts, /content-assets, /content-rights,
 * /integrations, /policies): this public entry imports the six public
 * contracts DIRECTLY (the only matrix-allowed module dependencies), all
 * consumed READ-ONLY except the /social-accounts publish submit (the 056
 * publication executor) — every consumed authority stays sole.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { ContentAssetsModuleApi } from '../content-assets/public.ts';
import type { ContentRightsModuleApi } from '../content-rights/public.ts';
import type { GrowthMissionsModuleApi } from '../growth-missions/public.ts';
import type { IntegrationsModuleApi } from '../integrations/public.ts';
import type { PoliciesModuleApi } from '../policies/public.ts';
import type { SocialAccountsModuleApi } from '../social-accounts/public.ts';
import type { SocialPublishRequest } from '../social-accounts/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (cpd-vocab-v1 — CHECK-fenced in migration 055;
// pinned by unit tests)
// ---------------------------------------------------------------------------

/**
 * The frozen PLAN LIFECYCLE: `planned` is the born state (the recorded
 * declaration); `dispatching` marks a fan-out execution in flight;
 * `dispatched` marks a completed dispatch. A re-dispatch of a dispatched
 * plan re-enters `dispatching` — the idempotent convergence discipline
 * (per-destination: recorded outcomes replay from the 056 fence,
 * non-attempted destinations re-evaluate honestly).
 */
export type DistributionPlanState = 'planned' | 'dispatching' | 'dispatched';

export const DISTRIBUTION_PLAN_STATES: readonly DistributionPlanState[] = [
  'planned',
  'dispatching',
  'dispatched',
];

/** The frozen plan transition table (planned → dispatching → dispatched; dispatched → dispatching on re-dispatch). */
export const DISTRIBUTION_PLAN_TRANSITIONS: Readonly<
  Record<DistributionPlanState, readonly DistributionPlanState[]>
> = {
  planned: ['dispatching'],
  dispatching: ['dispatched'],
  dispatched: ['dispatching'],
};

export function isLegalDistributionPlanTransition(
  from: DistributionPlanState,
  to: DistributionPlanState,
): boolean {
  return DISTRIBUTION_PLAN_TRANSITIONS[from].includes(to);
}

/**
 * The frozen DESTINATION OUTCOME vocabulary (cpd-vocab-v1):
 *   - planned                  — the born state (the declared variant);
 *   - rights_review_required   — the 063 gate returned review_required:
 *                                rights uncertainty routes to human
 *                                action; NEVER an autonomous publish (the
 *                                blocked_pending_human_action surface);
 *   - rights_blocked           — the 063 gate returned blocked (including
 *                                no_rights_record — an absent evaluation
 *                                is never an allow: a platform connection
 *                                never implies redistribution rights for
 *                                third-party content);
 *   - capability_rejected      — the per-platform capability validation
 *                                failed (never attempted blind);
 *   - policy_blocked           — the dispatch policy gate denied/unknown;
 *   - publishing               — the 056 attempt stayed 'submitted'
 *                                (UNKNOWN — pending reconciliation,
 *                                never blindly replayed);
 *   - published / accepted / failed / restricted — the 056 terminal
 *                                attempt states (the provider's own
 *                                outcome, recorded verbatim).
 */
export type DistributionDestinationStatus =
  | 'planned'
  | 'rights_review_required'
  | 'rights_blocked'
  | 'capability_rejected'
  | 'policy_blocked'
  | 'publishing'
  | 'published'
  | 'accepted'
  | 'failed'
  | 'restricted';

export const DISTRIBUTION_DESTINATION_STATUSES: readonly DistributionDestinationStatus[] = [
  'planned',
  'rights_review_required',
  'rights_blocked',
  'capability_rejected',
  'policy_blocked',
  'publishing',
  'published',
  'accepted',
  'failed',
  'restricted',
];

/** The born destination state — never re-entered after the first outcome move. */
export const DISTRIBUTION_DESTINATION_BORN_STATE: DistributionDestinationStatus = 'planned';

/**
 * The frozen EVENT-KIND vocabulary of the append-only lineage tail: the
 * planning, the per-destination gate evaluations, capability resolutions,
 * policy evaluations and publication attempts, the plan-level dispatch
 * lifecycle and the §5 measurement references.
 */
export type DistributionEventKind =
  | 'plan_created'
  | 'dispatch_started'
  | 'gate_evaluation'
  | 'capability_resolution'
  | 'policy_evaluation'
  | 'publication_attempt'
  | 'dispatch_completed'
  | 'measurement_reference';

export const DISTRIBUTION_EVENT_KINDS: readonly DistributionEventKind[] = [
  'plan_created',
  'dispatch_started',
  'gate_evaluation',
  'capability_resolution',
  'policy_evaluation',
  'publication_attempt',
  'dispatch_completed',
  'measurement_reference',
];

/** The frozen capability-rejection reason codes (the fail-closed validation vocabulary). */
export type DistributionCapabilityRejectionCode =
  | 'platform_adapter_unregistered'
  | 'authorization_unusable'
  | 'publish_capability_undeclared'
  | 'publish_operation_undeclared'
  | 'publish_scope_unsatisfied'
  | 'integration_adapter_unregistered';

export const DISTRIBUTION_CAPABILITY_REJECTION_CODES: readonly DistributionCapabilityRejectionCode[] = [
  'platform_adapter_unregistered',
  'authorization_unusable',
  'publish_capability_undeclared',
  'publish_operation_undeclared',
  'publish_scope_unsatisfied',
  'integration_adapter_unregistered',
];

/** The module vocabulary version (cpd-vocab-v1 — the migration-055 mirror). */
export const CROSS_PLATFORM_DISTRIBUTION_VOCABULARY_VERSION = 'cpd-vocab-v1';

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every distribution mutation (the
 * content-rights/content-assets precedent): built exclusively from the
 * authenticated principal, the ambient correlation context and the
 * recording surface — never from a request body.
 */
export interface CrossPlatformDistributionProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the durable records. */
export interface CrossPlatformDistributionRecordedProvenance
  extends CrossPlatformDistributionProvenance {
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The frozen input grammars (the interop mirrors)
// ---------------------------------------------------------------------------

/** The 064-minted content-asset ref grammar (the migration-053 mirror). */
export const DISTRIBUTION_ASSET_REF_PATTERN =
  /^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The platform-key grammar (the social-accounts adapter-key mirror). */
export const DISTRIBUTION_PLATFORM_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The target-format label grammar (a bounded path-safe label). */
export const DISTRIBUTION_TARGET_FORMAT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The 056 idempotency-key grammar (the migration-050 mirror). */
export const DISTRIBUTION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The derived idempotency-key prefix (the at-most-once identity namespace of this module). */
export const DISTRIBUTION_IDEMPOTENCY_KEY_PREFIX = 'cpd:';

/**
 * Derives the deterministic idempotency key of one destination's
 * publication (PURE): `cpd:<planId>:<destinationId>` — the at-most-once
 * identity toward the 056 ledger (same plan + same destination → same
 * key; a re-dispatch converges on the fence with ZERO provider traffic).
 */
export function derivePublishIdempotencyKey(
  planId: string,
  destinationId: string,
): string {
  return `${DISTRIBUTION_IDEMPOTENCY_KEY_PREFIX}${planId}:${destinationId}`;
}

// ---------------------------------------------------------------------------
// The declared input shapes (the planning DTO — frozen at planning time)
// ---------------------------------------------------------------------------

/** One declared transformation-plan output: a versioned derived asset + its bounded variant label. */
export interface DistributionTransformationOutput {
  /** The opaque 064 'ca:' ref of the derived output (resolved through /content-assets at planning time). */
  readonly assetRef: string;
  /** The bounded variant label (e.g. 'vertical-cut', 'square-padded'). */
  readonly variantLabel: string;
}

/**
 * The declared TRANSFORMATION PLAN (§5): the bounded mapping from the
 * source asset to the versioned derived outputs the destinations may
 * publish. Every referenced output is an opaque 064 'ca:' ref resolved to
 * its EXPLICIT version before any write — a floating 'latest' pointer is
 * rejected at planning time (the 064 discipline).
 */
export interface DistributionTransformationPlan {
  readonly description: string;
  readonly outputs: readonly DistributionTransformationOutput[];
}

/** One declared destination variant (§5 Target Platform → Target Account → Target Format). */
export interface DistributionDestinationDeclaration {
  /** The TARGET ACCOUNT: the /social-accounts binding this destination publishes through. */
  readonly socialAccountId: string;
  /** The TARGET FORMAT: the destination-specific format label (§5). */
  readonly targetFormat: string;
  /** The versioned asset ref this destination publishes (the source or one of the declared outputs). */
  readonly assetRef: string;
  /** The destination-specific publish request (the 056 shape: contentType + payload + attribution + optional scheduling). */
  readonly publishRequest: {
    readonly contentType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly attribution: Readonly<Record<string, unknown>>;
    readonly scheduledFor: string | null;
  };
}

// ---------------------------------------------------------------------------
// The durable record shapes (migration 055)
// ---------------------------------------------------------------------------

/** One DISTRIBUTION PLAN record (the §5 chain head). */
export interface DistributionPlanRecord {
  readonly planId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The optional mission anchor (READ-ONLY — the mission authority stays sole). */
  readonly missionId: string | null;
  readonly sourceAssetRef: string;
  readonly sourceVersionId: string;
  readonly transformationPlan: DistributionTransformationPlan;
  readonly planState: DistributionPlanState;
  readonly inputDigest: string;
  readonly provenance: CrossPlatformDistributionRecordedProvenance;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One DESTINATION VARIANT record (the fan-out row). */
export interface DistributionDestinationRecord {
  readonly destinationId: string;
  readonly planId: string;
  readonly clientId: string;
  readonly position: number;
  readonly socialAccountId: string;
  readonly platformId: string;
  readonly assetRef: string;
  readonly assetVersionId: string;
  readonly targetFormat: string;
  /** The frozen publish request (the 056 shape; the media assets derive from the versioned asset ref). */
  readonly publishRequest: SocialPublishRequest;
  readonly idempotencyKey: string;
  readonly destinationStatus: DistributionDestinationStatus;
  readonly provenance: CrossPlatformDistributionRecordedProvenance;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One PUBLICATION record (the per-destination submit-time link to the 056 ledger). */
export interface DistributionPublicationRecord {
  readonly publicationId: string;
  readonly planId: string;
  readonly destinationId: string;
  readonly clientId: string;
  readonly socialAccountId: string;
  readonly publishAttemptId: string;
  readonly idempotencyKey: string;
  readonly publishState: 'submitted' | 'accepted' | 'published' | 'failed' | 'restricted';
  readonly failureCode: string | null;
  readonly providerPublishId: string | null;
  readonly providerContentId: string | null;
  readonly publishedAt: string | null;
  readonly duplicate: boolean;
  readonly provenance: CrossPlatformDistributionRecordedProvenance;
}

/** One immutable row of the append-only lineage tail. */
export interface DistributionEventRecord {
  readonly eventId: string;
  readonly planId: string;
  readonly destinationId: string | null;
  readonly clientId: string;
  readonly eventSeq: number;
  readonly eventKind: DistributionEventKind;
  /** The full structured payload (the verdicts WITH reasons, the attempt result WITH provider refs). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provenance: CrossPlatformDistributionRecordedProvenance;
}

/**
 * The composed plan read model: the record, the destination variants (in
 * fan-out order), the publication links and the complete append-only
 * lineage (oldest first) — the honest read-back surface.
 */
export interface DistributionPlanDetail {
  readonly plan: DistributionPlanRecord;
  readonly destinations: readonly DistributionDestinationRecord[];
  readonly publications: readonly DistributionPublicationRecord[];
  readonly events: readonly DistributionEventRecord[];
}

/** The canonical ownership resolution (the route-layer uniform-404 input). */
export interface DistributionPlanOwnership {
  readonly scope: {
    readonly kind: 'distribution_plan';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly planId: string;
  };
  readonly plan: DistributionPlanRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// The dispatch outcome payloads (the recorded event payload shapes)
// ---------------------------------------------------------------------------

/** The recorded 063 gate evaluation of one destination (the verdict WITH reasons — never re-evaluated here). */
export interface DistributionGateEvaluationPayload {
  readonly assetRef: string;
  readonly destinationPlatform: string;
  readonly outcome: 'allow' | 'review_required' | 'blocked';
  readonly reasons: readonly { readonly code: string; readonly detail: string }[];
  readonly composite: boolean;
  readonly policyDecisionId: string;
  readonly vocabularyVersion: string;
}

/** The recorded capability resolution of one destination (fail-closed, WITH reasons). */
export interface DistributionCapabilityResolutionPayload {
  readonly platformId: string;
  readonly socialPlatformAdapterRegistered: boolean;
  readonly integrationAdapterRegistered: boolean;
  readonly authorizationUsable: boolean;
  readonly publishCapabilityDeclared: boolean;
  readonly publishOperationDeclared: boolean;
  readonly publishScopesSatisfied: boolean;
  readonly missingScopes: readonly string[];
  readonly allowed: boolean;
  readonly rejectionCodes: readonly DistributionCapabilityRejectionCode[];
}

/** The recorded dispatch policy evaluation of one destination (the decision id rides the policy ledger). */
export interface DistributionPolicyEvaluationPayload {
  readonly platformId: string;
  readonly decisionId: string;
  readonly outcome: 'allow' | 'deny' | 'unknown';
  readonly reasonCode: string;
  readonly reasons: readonly string[];
}

/** The recorded publication attempt of one destination (the 056 ledger result, verbatim). */
export interface DistributionPublicationAttemptPayload {
  readonly publishAttemptId: string;
  readonly idempotencyKey: string;
  readonly duplicate: boolean;
  readonly publishState: 'submitted' | 'accepted' | 'published' | 'failed' | 'restricted';
  readonly failureCode: string | null;
  readonly providerPublishId: string | null;
  readonly providerContentId: string | null;
  readonly publishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface CrossPlatformDistributionModuleApi {
  /**
   * THE PLANNING (§5): records one distribution plan — the source asset,
   * the transformation plan (versioned outputs), the optional mission
   * anchor and the destination variants. Every asset reference (source +
   * outputs + each destination's published ref) is resolved canonically
   * through /content-assets BEFORE any write (explicit versioned records
   * — never floating pointers); every destination account is resolved
   * through /social-accounts (must exist and belong to the SAME Client —
   * uniform 404 otherwise; the platform id is frozen from the account
   * record, never caller-supplied); the optional mission is resolved
   * through /growth-missions READ-ONLY (must belong to the same agency).
   * NO rights evaluation happens at planning time (the 063 gate runs at
   * dispatch, per destination) and NO publication happens here. The plan
   * is born 'planned' with its deterministic input digest; the full
   * declaration is recorded as the plan_created event.
   */
  createDistributionPlan(
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly missionId: string | null;
      readonly sourceAssetRef: string;
      readonly transformationPlan: DistributionTransformationPlan;
      readonly destinations: readonly DistributionDestinationDeclaration[];
    },
    provenance: CrossPlatformDistributionProvenance,
  ): Promise<DistributionPlanDetail>;

  /**
   * THE FAN-OUT EXECUTION (the AC): dispatches the plan to EVERY
   * destination, fail-closed per destination (one destination's failure
   * never blocks the others). Per destination, in fan-out order:
   *   1. THE 063 RIGHTS GATE (evaluatePublicationGate — allow /
   *      review_required / blocked WITH reasons): only `allow` permits;
   *      review_required and blocked NEVER publish;
   *   2. PER-PLATFORM CAPABILITY VALIDATION (resolveAccountCapabilityMatrix
   *      + listRegisteredAdapters): a destination lacking the required
   *      publish capability is rejected and recorded, never attempted
   *      blind;
   *   3. THE DISPATCH POLICY GATE (/policies evaluateAction — the network
   *      dimension, operation 'content.distribution.dispatch', resource
   *      the destination platform): only an explicit allow permits;
   *   4. THE PUBLICATION ATTEMPT through the 056 submitPublish contract
   *      with the derived deterministic idempotency key and the
   *      destination-specific request.
   * Every step is recorded on the append-only lineage tail. The command
   * is IDEMPOTENT: a re-dispatch replays recorded outcomes from the 056
   * fence (duplicate: true, ZERO provider traffic) for attempted
   * destinations and re-evaluates honestly for non-attempted ones (the
   * rights/capability/policy state may have changed). The plan lifecycle
   * moves planned|dispatched → dispatching → dispatched.
   */
  dispatchDistributionPlan(
    input: {
      readonly planId: string;
    },
    provenance: CrossPlatformDistributionProvenance,
  ): Promise<DistributionPlanDetail>;

  /** Raw plan record by id (the lifecycle pointer; the lineage is the event tail). */
  getDistributionPlan(planId: string): Promise<DistributionPlanRecord | null>;

  /**
   * Canonical ownership resolution: the plan + its owning chain. Null
   * when the plan does not exist OR belongs to another tenant — callers
   * surface a uniform 404 so foreign, unknown and malformed identifiers
   * are indistinguishable (hard-boundary posture).
   */
  resolveDistributionPlanOwnership(
    planId: string,
  ): Promise<DistributionPlanOwnership | null>;

  /** The client's plans, newest first (bounded, server-chosen limit). */
  listDistributionPlansForClient(
    clientId: string,
  ): Promise<readonly DistributionPlanRecord[]>;

  /**
   * The composed honest read-back: the plan + the destination variants +
   * the publication links + the complete append-only lineage. Null when
   * unknown.
   */
  getDistributionPlanDetail(planId: string): Promise<DistributionPlanDetail | null>;

  /**
   * Records ONE §5 measurement reference on the lineage tail (append-only
   * DATA — e.g. an evidence or metrics reference the mission/operator
   * layer resolves): the opaque bounded reference + the optional
   * destination narrowing. The module records measurement references; it
   * never computes measurement (attribution is distinct from causal
   * inference — the measurement authority stays with its owners).
   */
  recordMeasurementReference(
    input: {
      readonly planId: string;
      readonly destinationId: string | null;
      readonly measurementRef: string;
      readonly note: string | null;
    },
    provenance: CrossPlatformDistributionProvenance,
  ): Promise<DistributionEventRecord>;
}

export interface CrossPlatformDistributionModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix: /cross-platform-distribution ──→ /growth-missions —
   * the MISSION ANCHOR authority, consumed READ-ONLY (mission ownership
   * resolution for the optional plan anchor; the mission authority stays
   * sole for mission identity/lifecycle — this module NEVER mutates a
   * mission).
   */
  readonly growthMissions: GrowthMissionsModuleApi;
  /**
   * Frozen matrix: /cross-platform-distribution ──→ /social-accounts —
   * the ACCOUNT/CAPABILITY/PUBLISH authority: the destination account
   * resolution (resolveAccountOwnership), the REAL capability matrix
   * (resolveAccountCapabilityMatrix — grants, capability tags, scope
   * satisfaction; capability parity is never assumed) and THE 056
   * PUBLISH SUBMIT (submitPublish — the idempotency ledger; the ONLY
   * physical publish path; no parallel engine exists here).
   */
  readonly socialAccounts: SocialAccountsModuleApi;
  /**
   * Frozen matrix: /cross-platform-distribution ──→ /content-assets —
   * the ASSET VERSION authority, consumed READ-ONLY (resolveAssetRef: the
   * explicit versioned records behind every opaque 'ca:' ref — never
   * floating pointers).
   */
  readonly contentAssets: ContentAssetsModuleApi;
  /**
   * Frozen matrix: /cross-platform-distribution ──→ /content-rights —
   * THE PUBLICATION GATE authority, consumed READ-ONLY
   * (evaluatePublicationGate: allow / review_required / blocked WITH
   * reasons). This module COMPOSES the gate before every publication
   * attempt and RECORDS its verdicts — it never re-evaluates rights and
   * holds no rights authority of its own (boundary rule 4).
   */
  readonly contentRights: ContentRightsModuleApi;
  /**
   * Frozen matrix: /cross-platform-distribution ──→ /integrations — the
   * adapter REGISTRY authority, consumed READ-ONLY
   * (listRegisteredAdapters: the 056 normalized adapter contract's
   * registry — the destination platform's integration adapter must be
   * registered; fail-closed otherwise).
   */
  readonly integrations: IntegrationsModuleApi;
  /**
   * Frozen matrix: /cross-platform-distribution ──→ /policies — the
   * POLICY ENGINE, consumed through the public contract (evaluateAction:
   * the fail-closed dispatch gate of every destination — only an explicit
   * allow permits; the decisions ride the policy engine's own append-only
   * ledger and this module records their ids). This module holds NO
   * policy authority.
   */
  readonly policies: PoliciesModuleApi;
}

export { createCrossPlatformDistributionModule } from './internal/module.ts';
/**
 * The input guards (vocabulary/shape/provenance validation + the
 * transition-legality twin of the migration CHECKs) and the pure
 * derivation helpers (the deterministic idempotency key, the canonical
 * plan input digest, the destination outcome derivation from the 056
 * attempt state) — exported for unit tests and future server-side
 * callers so the guard semantics are part of the module contract. Pure
 * functions.
 */
export {
  assertValidCrossPlatformDistributionProvenance,
  assertValidCreateDistributionPlanInput,
  assertValidDispatchInput,
  assertValidMeasurementReferenceInput,
  computeDistributionPlanInputDigest,
  destinationStatusOfPublishState,
  DISTRIBUTION_MAX_DESTINATIONS,
} from './internal/validation.ts';
