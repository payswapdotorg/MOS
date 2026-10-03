/**
 * MarketingOS module: /lab-capabilities
 * Authority: Capability Engine + Arena Adapter (LAB-013 — spec/
 * effective-backlog-v1.7.md LAB-013: "Formalize capability gaps,
 * requests, providers, quality evaluation and verified capability
 * versions. Acceptance: missing capability can be discovered, requested,
 * fulfilled, verified and inserted without creating a second marketplace
 * authority; Arena remains behind Integration/provider contracts.";
 * dependencies satisfied: LAB-001 (merged — the /lab contracts and run
 * model) and LAB-011 (merged — the /lab-agent-body versioned registry
 * whose lifecycle discipline the capability version records follow);
 * spec/architecture-v1.7-marketing-lab.md §16 "Capability system"
 * ("Capabilities are first-class executable contracts. A Capability
 * contains: input schema; output schema; constraints; quality evaluator;
 * cost; latency; provenance; implementation/version; simulator
 * implementation if available; real implementation if available; human/
 * provider requirements." and "The Lab can detect a capability gap when
 * a candidate strategy requires an unavailable quality-preserving
 * action.") and §17 "Arena capability acquisition" (the frozen flow
 * "Capability gap → capability contract → value estimate → governed
 * Arena request → human/provider result → verification → capability
 * version → simulation → real test"; "Arena is an external capability
 * provider and is NOT introduced as another MOS marketplace authority";
 * "Arena results enter MOS through an explicit Integration/provider
 * contract"; "If Arena work ultimately uses the existing Human Agent/
 * Job/Task/Execution plane, those existing authorities remain canonical";
 * "Human availability is never a prerequisite for ordinary autonomous
 * growth"; "A capability acquired from a human does not automatically
 * grant rights to use the resulting artifact beyond the explicit
 * contract") and §22 multi-tenancy; architecture-lock-v1.7 rules 22/23/
 * 24; AGENTS.md v1.7 "Capabilities are explicit contracts with
 * evaluation, cost, latency and provenance" + "Arena is an external
 * capability provider behind Integration, not a MOS marketplace
 * authority".
 *
 * THE BOUNDARY (frozen):
 *
 * This module owns EXACTLY the §16/§17 surface: the versioned capability
 * registry (the full §16 declared field set as one-level-schema DATA,
 * with the LAB-011 draft → active → retired lifecycle, append-only
 * version corrections and opaque version references), the NINE-stage
 * acquisition flow (gap → contract → value estimate → governed Arena
 * request → human/provider result → verification → capability version →
 * simulation → real test — one append-only record per stage, each
 * carrying its actor from the closed autonomous/human vocabulary and its
 * closed state), the declared quality-evaluator contract (verification
 * runs the DECLARED evaluator and records the verdict; a capability
 * version without a PASSING linked verification can never be presented
 * as verified — the verified state is the LINKED EVIDENCE, never an
 * asserted boolean) and the Arena adapter seam.
 *
 * NO SECOND MARKETPLACE AUTHORITY (the core acceptance — structural):
 * Arena is an EXTERNAL provider behind the EXISTING /integrations
 * provider contracts. This module holds ZERO marketplace vocabulary (no
 * price, bid, listing, ranking or negotiation concept exists in this
 * public surface) and ZERO provider-selection logic (the provider target
 * — adapter key + connection id + operation — is CALLER-DECLARED DATA on
 * the governed request record); the Arena dispatch flows through the
 * DECLARED NARROW STRUCTURAL PORT (listRegisteredAdapters +
 * executeMutation ONLY — the LAB-011 /ai-runtime port precedent), wired
 * at the composition root where the REAL /integrations instance
 * satisfies the port structurally, so the fail-closed policy/credential/
 * capability gates stay in /integrations, the sole provider authority.
 *
 * THE HUMAN-PLANE BOUNDARY (§17): when Arena work uses the existing
 * Human Agent/Job/Task/Execution plane, those authorities remain
 * canonical — this module cites their records OPAQUELY (the human-plane
 * citation is recorded data: plane authority + record reference) and
 * NEVER re-models them. Human availability is NEVER a prerequisite for
 * ordinary autonomous growth: every stage accepts its honest actor label
 * and the ordinary path is fully autonomous; the human-plane result is
 * one OPTIONAL fulfillment kind beside the provider fulfillment, never
 * a gate on any autonomous path.
 *
 * THE CONTRACT-RIGHTS DISCIPLINE (§17): an acquired capability grants
 * ONLY its explicit contract rights — the granted-rights object is
 * recorded DATA on the result (null = nothing granted); no usage right
 * is ever assumed, inferred or defaulted beyond it.
 *
 * TENANT ISOLATION (§22): every row is client-scoped with the optional
 * workspace anchor; every read resolves foreign/unknown scope to the
 * uniform NotFound (no existence oracle); the DB-level scope-consistency
 * triggers reject cross-tenant chain injection.
 */

import { InvalidRequestError } from '../../platform/errors/errors.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { Clock } from '../../platform/clock/clock.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// ---------------------------------------------------------------------------
// The pinned contract identity + the frozen vocabularies
// ---------------------------------------------------------------------------

/** The pinned migration-067 contract identity (CHECK-fenced in every table). */
export const LAB_CAPABILITIES_CONTRACT_VERSION = 'lab-capabilities-contract-v1' as const;

/** The §17 actor split (every stage record carries its actor). */
export const LAB_CAPABILITY_ACTORS = ['autonomous', 'human'] as const;
export type LabCapabilityActor = (typeof LAB_CAPABILITY_ACTORS)[number];

/** The gap lifecycle (the flow spine). */
export const LAB_CAPABILITY_GAP_STATUSES = ['open', 'contracted', 'resolved', 'abandoned'] as const;
export type LabCapabilityGapStatus = (typeof LAB_CAPABILITY_GAP_STATUSES)[number];

/** The capability-contract lifecycle. */
export const LAB_CAPABILITY_CONTRACT_STATUSES = ['derived', 'withdrawn'] as const;
export type LabCapabilityContractStatus = (typeof LAB_CAPABILITY_CONTRACT_STATUSES)[number];

/** The value-estimate lifecycle. */
export const LAB_CAPABILITY_ESTIMATE_STATUSES = ['recorded', 'superseded'] as const;
export type LabCapabilityEstimateStatus = (typeof LAB_CAPABILITY_ESTIMATE_STATUSES)[number];

/** The governed-request lifecycle. */
export const LAB_CAPABILITY_REQUEST_STATUSES = ['pending', 'completed', 'failed', 'cancelled'] as const;
export type LabCapabilityRequestStatus = (typeof LAB_CAPABILITY_REQUEST_STATUSES)[number];

/** The closed fulfillment vocabulary (stage 5). */
export const LAB_CAPABILITY_FULFILLMENT_KINDS = ['provider', 'human_plane'] as const;
export type LabCapabilityFulfillmentKind = (typeof LAB_CAPABILITY_FULFILLMENT_KINDS)[number];

/** The closed verification verdict vocabulary (stage 6). */
export const LAB_CAPABILITY_VERDICTS = ['pass', 'fail', 'inconclusive'] as const;
export type LabCapabilityVerdict = (typeof LAB_CAPABILITY_VERDICTS)[number];

/** The closed simulation/real-test outcome vocabulary (stages 8/9). */
export const LAB_CAPABILITY_LINK_OUTCOMES = ['passed', 'failed', 'inconclusive'] as const;
export type LabCapabilityLinkOutcome = (typeof LAB_CAPABILITY_LINK_OUTCOMES)[number];

/** The §16 capability-version lifecycle (the LAB-011 body-registry precedent). */
export const LAB_CAPABILITY_VERSION_STATUSES = ['draft', 'active', 'retired'] as const;
export type LabCapabilityVersionStatus = (typeof LAB_CAPABILITY_VERSION_STATUSES)[number];

/** The closed provenance-origin vocabulary (§16 provenance). */
export const LAB_CAPABILITY_ORIGINS = ['first_party_declared', 'arena_provider', 'human_contribution'] as const;
export type LabCapabilityOrigin = (typeof LAB_CAPABILITY_ORIGINS)[number];

/** The closed implementation-kind vocabulary (§16 implementation/version). */
export const LAB_CAPABILITY_IMPLEMENTATION_KINDS = ['simulator', 'real', 'hybrid', 'declared_only'] as const;
export type LabCapabilityImplementationKind = (typeof LAB_CAPABILITY_IMPLEMENTATION_KINDS)[number];

/**
 * The closed §16 gap action-kind vocabulary — the unavailable
 * quality-preserving action kinds (the §16 examples: "a specific physical
 * performance; a platform-specific action unsupported by APIs; an
 * authentic human demonstration; a specialized visual/audio treatment").
 */
export const LAB_CAPABILITY_ACTION_KINDS = [
  'physical_performance',
  'platform_action_gap',
  'authentic_demonstration',
  'specialized_media_treatment',
] as const;
export type LabCapabilityActionKind = (typeof LAB_CAPABILITY_ACTION_KINDS)[number];

/**
 * The closed strategy-citation vocabulary (the OPAQUE /lab citation —
 * the /lab module owns the strategy/organization/capability candidate
 * artifacts; this module cites them by reference only, never joins
 * them).
 */
export const LAB_CAPABILITY_STRATEGY_KINDS = [
  'lab_strategy_candidate',
  'lab_organization_candidate',
  'lab_capability_candidate',
  'external',
] as const;
export type LabCapabilityStrategyKind = (typeof LAB_CAPABILITY_STRATEGY_KINDS)[number];

/**
 * The closed human-plane authority vocabulary — the canonical Human
 * Agent/Job/Task/Execution plane modules (the Task projections are the
 * /jobs authority's own surface — one authority, one vocabulary entry).
 */
export const LAB_CAPABILITY_HUMAN_PLANE_AUTHORITIES = ['field-agents', 'jobs', 'executions'] as const;
export type LabCapabilityHumanPlaneAuthority = (typeof LAB_CAPABILITY_HUMAN_PLANE_AUTHORITIES)[number];

/**
 * The closed real-test authority vocabulary — the real-plane authorities
 * whose records a real test belongs to (this module only LINKS them; the
 * authorities stay canonical).
 */
export const LAB_CAPABILITY_REAL_TEST_AUTHORITIES = ['experiments', 'executions', 'evidence', 'workflows'] as const;
export type LabCapabilityRealTestAuthority = (typeof LAB_CAPABILITY_REAL_TEST_AUTHORITIES)[number];

/** The closed requirement-kind vocabulary (§16 human/provider requirements). */
export const LAB_CAPABILITY_REQUIREMENT_KINDS = [
  'human_performance',
  'platform_action',
  'provider_api',
  'specialized_treatment',
  'authentic_demonstration',
] as const;
export type LabCapabilityRequirementKind = (typeof LAB_CAPABILITY_REQUIREMENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Bounds (the honest fences mirrored module-side)
// ---------------------------------------------------------------------------

/** The upper bound of capability versions per capability chain. */
export const LAB_CAPABILITY_MAX_VERSIONS = 1000;

/** The §16 latency deadline bounds (ms — the LAB-011 latency precedent). */
export const LAB_CAPABILITY_DEADLINE_MIN_MS = 1;
export const LAB_CAPABILITY_DEADLINE_MAX_MS = 600_000;

/** The one-level schema subset bounds (the LAB-011 message-contract discipline). */
export const LAB_CAPABILITY_SCHEMA_MAX_FIELDS = 32;

/** The declared-constraints bounds. */
export const LAB_CAPABILITY_MAX_CONSTRAINTS = 32;
export const LAB_CAPABILITY_MAX_CONSTRAINT_LENGTH = 512;

/** The requirements bounds. */
export const LAB_CAPABILITY_MAX_REQUIREMENTS = 16;

/** The opaque capability-version reference pattern — what consumers cite (`<capabilityId>#v<version>`). */
export const LAB_CAPABILITY_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#v[1-9][0-9]{0,3}$/;

/** The adapter-key shape (the /integrations descriptor discipline). */
export const LAB_CAPABILITY_ADAPTER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------
// The §16 declared field shapes (the one-level schema subset — the
// LAB-011 message-contract discipline, frozen surface)
// ---------------------------------------------------------------------------

/** The disclosed one-level schema field types (deterministic, no ambiguity). */
export const LAB_CAPABILITY_SCHEMA_FIELD_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
] as const;
export type LabCapabilitySchemaFieldType = (typeof LAB_CAPABILITY_SCHEMA_FIELD_TYPES)[number];

/**
 * The §16 input/output schema subset: a deterministic ONE-LEVEL object
 * schema `{ type: 'object', required, properties, maxKeys? }` — richer
 * schema vocabularies are later additive work, never silent
 * reinterpretation (the LAB-011 disclosed-subset precedent).
 */
export interface LabCapabilitySchema {
  readonly type: 'object';
  readonly required: ReadonlyArray<string>;
  readonly properties: Readonly<Record<string, { readonly type: LabCapabilitySchemaFieldType }>>;
  readonly maxKeys?: number | undefined;
}

/**
 * The §16 QUALITY EVALUATOR declaration (declared DATA on every
 * capability contract and every capability version): the evaluator
 * identity + version + the evaluation contract shape (the one-level
 * schema subset describing the evidence the evaluator produces).
 * Verification runs the DECLARED evaluator; the verdict comes from the
 * closed vocabulary.
 */
export interface LabCapabilityQualityEvaluatorDeclaration {
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly evaluationContract: LabCapabilitySchema;
}

/** The §16 cost (the abstract cost model + units — declared data). */
export interface LabCapabilityCost {
  readonly costModel: string;
  readonly costUnits: number;
}

/** The §16 latency (the expected P50/P95 + the deadline — declared data). */
export interface LabCapabilityLatency {
  readonly expectedP50Ms: number;
  readonly expectedP95Ms: number;
  readonly deadlineMs: number;
}

/** The §16 implementation/version (the implementation identity + kind). */
export interface LabCapabilityImplementation {
  readonly implementationId: string;
  readonly implementationVersion: string;
  readonly implementationKind: LabCapabilityImplementationKind;
}

/**
 * The §16 simulator/real implementation reference IF AVAILABLE (null =
 * the honest unavailable state — never fabricated).
 */
export interface LabCapabilityImplementationReference {
  readonly implementationId: string;
  readonly implementationVersion: string;
}

/** One §16 human/provider requirement. */
export interface LabCapabilityRequirement {
  readonly requirementKind: LabCapabilityRequirementKind;
  readonly description: string;
}

/** One §16 constraint (a bounded declared string). */
export type LabCapabilityConstraint = string;

/**
 * The §16 provenance (declared data): the closed origin + the bounded
 * source note. For acquired capabilities the origin is DERIVED from the
 * fulfillment kind (provider → arena_provider, human_plane →
 * human_contribution); the acquisition linkage itself rides the record's
 * sourceVerificationId/sourceGapId columns, never this object.
 */
export interface LabCapabilityProvenance {
  readonly origin: LabCapabilityOrigin;
  readonly sourceNote: string;
}

// ---------------------------------------------------------------------------
// The §17 stage payload shapes
// ---------------------------------------------------------------------------

/** The OPAQUE strategy citation (stage 1 — recorded data, never a join). */
export interface LabCapabilityStrategyCitation {
  readonly strategyKind: LabCapabilityStrategyKind;
  readonly strategyReference: string;
}

/** The required action shape (stage 1 — the unavailable quality-preserving action). */
export interface LabCapabilityRequiredAction {
  readonly actionKind: LabCapabilityActionKind;
  readonly description: string;
  readonly qualityBar: string;
}

/** The value estimate figures (stage 3 — the honest value/cost/uncertainty basis). */
export interface LabCapabilityValueEstimateFigures {
  readonly estimatedValueUnits: number;
  readonly expectedQualityLift: number;
  readonly estimatedCostCeiling: number;
  readonly uncertainty: string;
  readonly basis: string;
}

/** The requested rights (stage 4 — what MOS asks the contract to grant). */
export interface LabCapabilityRequestedRights {
  readonly usageScope: string;
  readonly redistribution: boolean;
  readonly attributionRequired: boolean;
  readonly licenseTerms: string | null;
}

/**
 * The granted rights (stage 5 — the EXPLICIT contract-rights record for
 * acquired artifacts; null = nothing granted: an acquired capability
 * grants ONLY its explicit contract rights, never assumed).
 */
export interface LabCapabilityGrantedRights {
  readonly usageScope: string;
  readonly redistribution: boolean;
  readonly attributionRequired: boolean;
  readonly licenseTerms: string | null;
}

/** The OPAQUE human-plane citation (stage 5 — the canonical plane cited by reference, never re-modeled). */
export interface LabCapabilityHumanPlaneCitation {
  readonly planeAuthority: LabCapabilityHumanPlaneAuthority;
  readonly recordReference: string;
}

/** The OPAQUE real-test citation (stage 9 — the real authority cited by reference). */
export interface LabCapabilityRealTestCitation {
  readonly authority: LabCapabilityRealTestAuthority;
  readonly recordReference: string;
}

/** The server-derived dispatch provenance (matches the /integrations provenance contract shape exactly). */
export interface LabCapabilityDispatchProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// THE DECLARED NARROW STRUCTURAL PORT — the EXISTING /integrations
// provider contracts (the LAB-011 /ai-runtime port precedent)
// ---------------------------------------------------------------------------

/**
 * The narrow structural view of ONE registered provider adapter (the
 * /integrations RegisteredAdapterInfo shape, re-declared here so this
 * module imports NOTHING from /integrations — the /lab family
 * discipline). The real /integrations instance satisfies the port
 * structurally at the composition root.
 */
export interface LabCapabilityArenaAdapterInfo {
  readonly descriptor: {
    readonly adapterKey: string;
    readonly providerLabel: string;
    readonly description: string;
  };
  readonly capabilities: ReadonlyArray<{
    readonly capabilityKey: string;
    readonly kind: string;
    readonly operations: ReadonlyArray<string>;
    readonly description: string;
  }>;
}

/** The narrow mutation-outcome view (a subset of the /integrations outcome — extra fields flow through). */
export interface LabCapabilityArenaMutationOutcome {
  readonly ok: boolean;
  readonly providerRecordId: string | null;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
}

/**
 * THE ARENA STRUCTURAL PORT — the ONLY provider surface this module
 * knows (the LAB-011 /ai-runtime port precedent, applied to the provider
 * authority):
 *
 * - `listRegisteredAdapters` — the READ-ONLY provider-registry read (the
 *   discovery surface: which external providers are wired behind the
 *   EXISTING /integrations contracts). Arena is ONE adapter key among
 *   them — never a second authority.
 * - `executeMutation` — the governed provider call THROUGH THE EXISTING
 *   /integrations fail-closed gates (canonical ownership → live-state →
 *   capability discovery → network policy → secrets policy → credential
 *   resolution → the adapter). The provenance shape matches the
 *   /integrations server-derived provenance contract exactly.
 *
 * The port deliberately exposes NO routing, NO pricing, NO negotiation
 * and NO marketplace surface: the module holds ZERO provider-selection
 * logic — the adapter key, connection id and operation arrive as
 * CALLER-DECLARED DATA on the governed request record. The REAL
 * IntegrationsModuleApi satisfies this port structurally (wired at the
 * composition root; test doubles implement the same two methods).
 */
export interface LabCapabilitiesArenaPort {
  /** The registered provider adapters AS DATA (READ-ONLY — the discovery surface). */
  listRegisteredAdapters(): ReadonlyArray<LabCapabilityArenaAdapterInfo>;
  /**
   * One normalized MUTATION through the existing provider authority
   * (never throws for invocation-level outcomes — the honest ok=false +
   * error discipline; the fail-closed gates live in /integrations, the
   * sole provider authority).
   */
  executeMutation(
    input: {
      readonly connectionId: string;
      readonly operation: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    },
    provenance: LabCapabilityDispatchProvenance,
  ): Promise<LabCapabilityArenaMutationOutcome>;
}

// ---------------------------------------------------------------------------
// THE DECLARED QUALITY-EVALUATOR PORT (§16 — the replaceable evaluator)
// ---------------------------------------------------------------------------

/** The evaluator run request (the declared evaluator + the contract + the delivered artifact). */
export interface LabCapabilityEvaluationRequest {
  /** The evaluator declaration the capability contract declared (identity + version + the evaluation contract shape). */
  readonly declaredEvaluator: LabCapabilityQualityEvaluatorDeclaration;
  /** The capability contract's declared output schema (the shape the delivered artifact must satisfy). */
  readonly outputSchema: LabCapabilitySchema;
  /** The delivered artifact descriptor (the result's bounded jsonb data). */
  readonly deliveredArtifact: Readonly<Record<string, unknown>>;
}

/** The evaluator run outcome: the closed verdict + the bounded evidence object. */
export interface LabCapabilityEvaluationOutcome {
  readonly verdict: LabCapabilityVerdict;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/**
 * THE QUALITY-EVALUATOR PORT (§16: verification runs the declared
 * evaluator and records the verdict): the replaceable evaluator seam
 * wired at the composition root (the LAB-003 extractor-port precedent).
 * The first-party implementation performs the honest deterministic
 * shape evaluation (the delivered artifact against the declared output
 * schema + the declared evaluation contract echoed on the evidence);
 * richer evaluator backends arrive as future port implementations —
 * never silent reinterpretation of the declared data.
 */
export interface LabCapabilityQualityEvaluatorPort {
  evaluate(request: LabCapabilityEvaluationRequest): Promise<LabCapabilityEvaluationOutcome>;
}

// ---------------------------------------------------------------------------
// The record shapes (the mapped migration-067 rows)
// ---------------------------------------------------------------------------

/**
 * The derived verification state of a capability version (EVIDENCE,
 * never an asserted boolean): verified is true ONLY when a PASSING
 * verification is linked — the citation trigger makes the link itself
 * evidence, and a version with no citation is honestly unverified.
 */
export interface LabCapabilityVerificationState {
  readonly verified: boolean;
  readonly verificationId: string | null;
  readonly verdict: LabCapabilityVerdict | null;
  readonly evaluatorId: string | null;
  readonly evaluatorVersion: string | null;
  readonly verifiedAt: string | null;
}

/** One capability version record (the full §16 declared field set + the lifecycle + the linkage). */
export interface LabCapabilityVersionRecord {
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly capabilityVersionReference: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly capabilityKey: string;
  readonly displayName: string;
  readonly status: LabCapabilityVersionStatus;
  /** The §17 actor split: who inserted this capability version. */
  readonly actor: LabCapabilityActor;
  readonly inputSchema: LabCapabilitySchema;
  readonly outputSchema: LabCapabilitySchema;
  readonly constraints: ReadonlyArray<LabCapabilityConstraint>;
  readonly qualityEvaluator: LabCapabilityQualityEvaluatorDeclaration;
  readonly cost: LabCapabilityCost;
  readonly latency: LabCapabilityLatency;
  readonly origin: LabCapabilityOrigin;
  readonly provenance: LabCapabilityProvenance;
  readonly implementation: LabCapabilityImplementation;
  readonly simulatorImplementation: LabCapabilityImplementationReference | null;
  readonly realImplementation: LabCapabilityImplementationReference | null;
  readonly requirements: ReadonlyArray<LabCapabilityRequirement>;
  readonly sourceVerificationId: string | null;
  readonly sourceGapId: string | null;
  /** The DERIVED verification state (unverified versions are never presented as verified). */
  readonly verification: LabCapabilityVerificationState;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The capability read shape (the latest version of the chain). */
export type LabCapabilityRecord = LabCapabilityVersionRecord;

/** One capability-gap record (stage 1). */
export interface LabCapabilityGapRecord {
  readonly gapId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly status: LabCapabilityGapStatus;
  readonly detectionActor: LabCapabilityActor;
  readonly strategyCitation: LabCapabilityStrategyCitation;
  readonly requiredAction: LabCapabilityRequiredAction;
  readonly rationale: string;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One capability-contract record (stage 2). */
export interface LabCapabilityContractRecord {
  readonly contractId: string;
  readonly gapId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly status: LabCapabilityContractStatus;
  readonly actor: LabCapabilityActor;
  readonly inputSchema: LabCapabilitySchema;
  readonly outputSchema: LabCapabilitySchema;
  readonly constraints: ReadonlyArray<LabCapabilityConstraint>;
  readonly qualityEvaluator: LabCapabilityQualityEvaluatorDeclaration;
  readonly costCeiling: LabCapabilityCost;
  readonly latencyCeilingMs: number;
  readonly requirements: ReadonlyArray<LabCapabilityRequirement>;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One value-estimate record (stage 3). */
export interface LabCapabilityValueEstimateRecord {
  readonly estimateId: string;
  readonly contractId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly status: LabCapabilityEstimateStatus;
  readonly actor: LabCapabilityActor;
  readonly estimatedValueUnits: number;
  readonly expectedQualityLift: number;
  readonly estimatedCostCeiling: number;
  readonly uncertainty: string;
  readonly basis: string;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One governed Arena-request record (stage 4). */
export interface LabCapabilityRequestRecord {
  readonly requestId: string;
  readonly gapId: string;
  readonly contractId: string;
  readonly estimateId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly status: LabCapabilityRequestStatus;
  readonly actor: LabCapabilityActor;
  readonly adapterKey: string;
  readonly connectionId: string;
  readonly operation: string;
  readonly requestParameters: Readonly<Record<string, unknown>>;
  readonly requestedRights: LabCapabilityRequestedRights;
  readonly providerOk: boolean | null;
  readonly providerRecordId: string | null;
  readonly providerError: string | null;
  readonly dispatchedAt: string | null;
  readonly contractVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One human/provider result record (stage 5). */
export interface LabCapabilityResultRecord {
  readonly resultId: string;
  readonly requestId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly fulfillmentKind: LabCapabilityFulfillmentKind;
  readonly actor: LabCapabilityActor;
  readonly providerAdapterKey: string | null;
  readonly providerRecordId: string | null;
  readonly humanPlaneCitation: LabCapabilityHumanPlaneCitation | null;
  readonly deliveredArtifact: Readonly<Record<string, unknown>>;
  readonly grantedRights: LabCapabilityGrantedRights | null;
  readonly contractVersion: string;
  readonly createdAt: string;
}

/** One verification record (stage 6). */
export interface LabCapabilityVerificationRecord {
  readonly verificationId: string;
  readonly resultId: string;
  readonly contractId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly verdict: LabCapabilityVerdict;
  readonly actor: LabCapabilityActor;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly evaluationEvidence: Readonly<Record<string, unknown>>;
  readonly contractVersion: string;
  readonly createdAt: string;
}

/** One simulation link record (stage 8). */
export interface LabCapabilitySimulationRecord {
  readonly simulationId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly actor: LabCapabilityActor;
  readonly simulationReference: string;
  readonly outcome: LabCapabilityLinkOutcome;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly contractVersion: string;
  readonly createdAt: string;
}

/** One real-test link record (stage 9). */
export interface LabCapabilityRealTestRecord {
  readonly realTestId: string;
  readonly capabilityId: string;
  readonly capabilityVersion: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly actor: LabCapabilityActor;
  readonly realTestCitation: LabCapabilityRealTestCitation;
  readonly outcome: LabCapabilityLinkOutcome;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly contractVersion: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Module wiring
// ---------------------------------------------------------------------------

/** The tenant scope (§22 — every row client-scoped, the optional workspace anchor). */
export interface LabCapabilitiesScope {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId?: string | null;
}

/** The module deps: platform ports + the two declared structural ports (wired at the composition root). */
export interface LabCapabilitiesModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The ARENA structural port (the real /integrations instance satisfies it at the composition root). */
  readonly arena: LabCapabilitiesArenaPort;
  /** The declared quality-evaluator port (the first-party shape evaluator by default). */
  readonly evaluator: LabCapabilityQualityEvaluatorPort;
}

// ---------------------------------------------------------------------------
// The §16 declaration input (shared by insert + correct)
// ---------------------------------------------------------------------------

/**
 * The §16 capability declaration (the full declared field set minus the
 * derived fields): schemas, constraints, the quality evaluator, cost,
 * latency, the implementation/version, the OPTIONAL simulator/real
 * implementation references (null = honestly unavailable), the human/
 * provider requirements and the provenance source note. The ORIGIN is
 * derived by the module (first-party path vs the acquisition chain's
 * fulfillment kind) — never caller-asserted.
 */
export interface LabCapabilityDeclaration {
  /** The stable chain key (1-64 chars of [a-z0-9-]; must match the chain on corrections). */
  readonly capabilityKey: string;
  readonly displayName: string;
  readonly inputSchema: LabCapabilitySchema;
  readonly outputSchema: LabCapabilitySchema;
  readonly constraints: ReadonlyArray<LabCapabilityConstraint>;
  readonly qualityEvaluator: LabCapabilityQualityEvaluatorDeclaration;
  readonly cost: LabCapabilityCost;
  readonly latency: LabCapabilityLatency;
  readonly implementation: LabCapabilityImplementation;
  readonly simulatorImplementation: LabCapabilityImplementationReference | null;
  readonly realImplementation: LabCapabilityImplementationReference | null;
  readonly requirements: ReadonlyArray<LabCapabilityRequirement>;
  readonly provenanceSourceNote: string;
}

// ---------------------------------------------------------------------------
// The module API
// ---------------------------------------------------------------------------

export interface LabCapabilitiesModuleApi {
  // --- Stage 1: the capability gap ---

  /**
   * Detects a capability gap (§16: "when a candidate strategy requires an
   * unavailable quality-preserving action"). The strategy citation is
   * OPAQUE recorded data (no /lab join); detectionActor defaults to
   * 'autonomous' (the ordinary path — human detection is the optional
   * surface, never a prerequisite).
   */
  detectCapabilityGap(input: {
    readonly scope: LabCapabilitiesScope;
    readonly strategyCitation: LabCapabilityStrategyCitation;
    readonly requiredAction: LabCapabilityRequiredAction;
    readonly rationale: string;
    readonly detectionActor?: LabCapabilityActor;
  }): Promise<LabCapabilityGapRecord>;
  getCapabilityGap(scope: LabCapabilitiesScope, gapId: string): Promise<LabCapabilityGapRecord>;
  listCapabilityGaps(
    scope: LabCapabilitiesScope,
    filter?: { readonly status?: LabCapabilityGapStatus },
  ): Promise<ReadonlyArray<LabCapabilityGapRecord>>;
  /** The honest terminal advance (open/contracted → abandoned). */
  abandonCapabilityGap(scope: LabCapabilitiesScope, gapId: string): Promise<LabCapabilityGapRecord>;

  // --- Stage 2: the capability contract ---

  /**
   * Derives the capability contract from the gap (the required §16-shaped
   * contract: schemas, constraints, the REQUIRED quality evaluator,
   * cost/latency ceilings, the human/provider requirements). Advances the
   * gap open → contracted in the same transaction.
   */
  deriveCapabilityContract(input: {
    readonly scope: LabCapabilitiesScope;
    readonly gapId: string;
    readonly inputSchema: LabCapabilitySchema;
    readonly outputSchema: LabCapabilitySchema;
    readonly constraints: ReadonlyArray<LabCapabilityConstraint>;
    readonly qualityEvaluator: LabCapabilityQualityEvaluatorDeclaration;
    readonly costCeiling: LabCapabilityCost;
    readonly latencyCeilingMs: number;
    readonly requirements: ReadonlyArray<LabCapabilityRequirement>;
    readonly actor?: LabCapabilityActor;
  }): Promise<LabCapabilityContractRecord>;
  getCapabilityContract(scope: LabCapabilitiesScope, contractId: string): Promise<LabCapabilityContractRecord>;
  listCapabilityContracts(
    scope: LabCapabilitiesScope,
    filter?: { readonly gapId?: string },
  ): Promise<ReadonlyArray<LabCapabilityContractRecord>>;
  /** The honest retraction terminal (derived → withdrawn). */
  withdrawCapabilityContract(scope: LabCapabilitiesScope, contractId: string): Promise<LabCapabilityContractRecord>;

  // --- Stage 3: the value estimate ---

  /**
   * Records the value estimate for the contract (a REVISION is a NEW
   * record — the prior recorded estimate is superseded in the same
   * transaction, never rewritten).
   */
  recordCapabilityValueEstimate(input: {
    readonly scope: LabCapabilitiesScope;
    readonly contractId: string;
    readonly figures: LabCapabilityValueEstimateFigures;
    readonly actor?: LabCapabilityActor;
  }): Promise<LabCapabilityValueEstimateRecord>;
  getCapabilityValueEstimate(
    scope: LabCapabilitiesScope,
    estimateId: string,
  ): Promise<LabCapabilityValueEstimateRecord>;
  listCapabilityValueEstimates(
    scope: LabCapabilitiesScope,
    filter?: { readonly contractId?: string },
  ): Promise<ReadonlyArray<LabCapabilityValueEstimateRecord>>;

  // --- Stage 4: the governed Arena request ---

  /**
   * Creates the governed Arena request (the full chain citation gap +
   * contract + estimate + the DECLARED provider target as DATA — adapter
   * key, connection id, operation; ZERO provider-selection logic here).
   * Born pending.
   */
  createCapabilityRequest(input: {
    readonly scope: LabCapabilitiesScope;
    readonly gapId: string;
    readonly contractId: string;
    readonly estimateId: string;
    readonly adapterKey: string;
    readonly connectionId: string;
    readonly operation: string;
    readonly requestParameters: Readonly<Record<string, unknown>>;
    readonly requestedRights: LabCapabilityRequestedRights;
    readonly actor?: LabCapabilityActor;
  }): Promise<LabCapabilityRequestRecord>;
  /**
   * THE GOVERNED DISPATCH: the single pending → completed/failed advance.
   * The Arena mutation flows through the STRUCTURAL PORT (the existing
   * /integrations fail-closed gates); the provider outcome is recorded as
   * the honest echo (ok + provider record id, or the bounded error). A
   * port-level throw is caught and recorded as the honest failed state —
   * never a fabricated success.
   */
  dispatchCapabilityRequest(input: {
    readonly scope: LabCapabilitiesScope;
    readonly requestId: string;
    readonly provenance: LabCapabilityDispatchProvenance;
  }): Promise<LabCapabilityRequestRecord>;
  getCapabilityRequest(scope: LabCapabilitiesScope, requestId: string): Promise<LabCapabilityRequestRecord>;
  listCapabilityRequests(
    scope: LabCapabilitiesScope,
    filter?: { readonly gapId?: string; readonly status?: LabCapabilityRequestStatus },
  ): Promise<ReadonlyArray<LabCapabilityRequestRecord>>;
  /** The pre-outcome retraction (pending → cancelled; no provider echo fabricated). */
  cancelCapabilityRequest(scope: LabCapabilitiesScope, requestId: string): Promise<LabCapabilityRequestRecord>;

  // --- Stage 5: the human/provider result ---

  /**
   * Records the PROVIDER fulfillment (requires the request completed with
   * providerOk — the dispatch succeeded; the adapter key + provider
   * record id echo the request, never re-asserted). grantedRights null =
   * nothing granted beyond the explicit contract statement.
   */
  recordProviderCapabilityResult(input: {
    readonly scope: LabCapabilitiesScope;
    readonly requestId: string;
    readonly deliveredArtifact: Readonly<Record<string, unknown>>;
    readonly grantedRights?: LabCapabilityGrantedRights | null;
  }): Promise<LabCapabilityResultRecord>;
  /**
   * Records the HUMAN-PLANE fulfillment (the canonical Human Agent/Job/
   * Task/Execution plane cited OPAQUELY — never re-modeled). Allowed on a
   * pending OR completed request: when pending, the request advances to
   * completed in the same transaction with the provider echo honestly
   * null (fulfilled via the human plane, not a provider mutation). The
   * actor is 'human' (the plane fulfilled).
   */
  recordHumanPlaneCapabilityResult(input: {
    readonly scope: LabCapabilitiesScope;
    readonly requestId: string;
    readonly humanPlaneCitation: LabCapabilityHumanPlaneCitation;
    readonly deliveredArtifact: Readonly<Record<string, unknown>>;
    readonly grantedRights?: LabCapabilityGrantedRights | null;
  }): Promise<LabCapabilityResultRecord>;
  getCapabilityResult(scope: LabCapabilitiesScope, resultId: string): Promise<LabCapabilityResultRecord>;
  listCapabilityResults(
    scope: LabCapabilitiesScope,
    filter?: { readonly requestId?: string },
  ): Promise<ReadonlyArray<LabCapabilityResultRecord>>;

  // --- Stage 6: the verification ---

  /**
   * Runs the DECLARED quality evaluator (the cited contract's declaration)
   * against the delivered artifact and records the verdict + evidence.
   * The evaluator identity/version echo the CONTRACT's declaration; the
   * verdict comes from the closed vocabulary. A re-verification is a NEW
   * record — verifications are append-only outright.
   */
  verifyCapabilityResult(input: {
    readonly scope: LabCapabilitiesScope;
    readonly resultId: string;
    readonly actor?: LabCapabilityActor;
  }): Promise<LabCapabilityVerificationRecord>;
  getCapabilityVerification(scope: LabCapabilitiesScope, verificationId: string): Promise<LabCapabilityVerificationRecord>;
  listCapabilityVerifications(
    scope: LabCapabilitiesScope,
    filter?: { readonly resultId?: string },
  ): Promise<ReadonlyArray<LabCapabilityVerificationRecord>>;

  // --- Stage 7: the capability version registry ---

  /**
   * Inserts a capability version (the §16 registry). The ACQUISITION
   * path cites a PASSING verification (the DB citation trigger rejects
   * anything else): the module resolves the chain verification → result
   * → request, derives the source gap (the request's gap — recorded as
   * the linkage), derives the origin from the fulfillment kind
   * (provider → arena_provider, human_plane → human_contribution) and
   * advances the gap contracted → resolved in the same transaction. The
   * FIRST-PARTY path cites no verification (origin
   * first_party_declared, honestly unverified until verified evidence
   * exists). Born draft (the LAB-011 lifecycle).
   */
  insertCapabilityVersion(input: {
    readonly scope: LabCapabilitiesScope;
    readonly sourceVerificationId?: string | null;
    readonly declaration: LabCapabilityDeclaration;
    /** The §17 actor (defaults to 'autonomous' — the ordinary path). */
    readonly actor?: LabCapabilityActor;
  }): Promise<LabCapabilityVersionRecord>;
  /** The latest version of the chain (the capability read shape). */
  getCapability(scope: LabCapabilitiesScope, capabilityId: string): Promise<LabCapabilityRecord>;
  /** Resolves an opaque version reference (`<capabilityId>#v<version>`). */
  getCapabilityByReference(scope: LabCapabilitiesScope, capabilityVersionReference: string): Promise<LabCapabilityRecord>;
  listCapabilities(
    scope: LabCapabilitiesScope,
    filter?: { readonly status?: LabCapabilityVersionStatus },
  ): Promise<ReadonlyArray<LabCapabilityRecord>>;
  listCapabilityVersions(
    scope: LabCapabilitiesScope,
    capabilityId: string,
  ): Promise<ReadonlyArray<LabCapabilityVersionRecord>>;
  /** The guarded lifecycle advance (latest draft → active). */
  activateCapability(scope: LabCapabilitiesScope, capabilityId: string): Promise<LabCapabilityRecord>;
  /** The guarded lifecycle advance (latest active → retired). */
  retireCapability(scope: LabCapabilitiesScope, capabilityId: string): Promise<LabCapabilityRecord>;
  /**
   * The append-only correction (a NEW version row under the same
   * capability id, born draft — the LAB-011 correction precedent; the
   * chain key is immutable).
   */
  correctCapability(input: {
    readonly scope: LabCapabilitiesScope;
    readonly capabilityId: string;
    readonly declaration: LabCapabilityDeclaration;
    /** The §17 actor (defaults to 'autonomous' — the ordinary path). */
    readonly actor?: LabCapabilityActor;
  }): Promise<LabCapabilityVersionRecord>;

  // --- Stage 8: the simulation link ---

  /**
   * Records the OPAQUE citation of the /lab simulation run that exercised
   * the capability version + the closed outcome (the durable simulation
   * runtime stays the /lab authority — this module only links).
   */
  recordCapabilitySimulation(input: {
    readonly scope: LabCapabilitiesScope;
    readonly capabilityId: string;
    readonly capabilityVersion: number;
    readonly simulationReference: string;
    readonly outcome: LabCapabilityLinkOutcome;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly actor?: LabCapabilityActor;
  }): Promise<LabCapabilitySimulationRecord>;
  listCapabilitySimulations(
    scope: LabCapabilitiesScope,
    filter?: { readonly capabilityId?: string },
  ): Promise<ReadonlyArray<LabCapabilitySimulationRecord>>;

  // --- Stage 9: the real-test link ---

  /**
   * Records the OPAQUE citation of the real-plane authority record (the
   * existing experiments/executions/evidence/workflows authorities own
   * real tests — this module only links) + the closed outcome.
   */
  recordCapabilityRealTest(input: {
    readonly scope: LabCapabilitiesScope;
    readonly capabilityId: string;
    readonly capabilityVersion: number;
    readonly realTestCitation: LabCapabilityRealTestCitation;
    readonly outcome: LabCapabilityLinkOutcome;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly actor?: LabCapabilityActor;
  }): Promise<LabCapabilityRealTestRecord>;
  listCapabilityRealTests(
    scope: LabCapabilitiesScope,
    filter?: { readonly capabilityId?: string },
  ): Promise<ReadonlyArray<LabCapabilityRealTestRecord>>;

  // --- The Arena discovery (READ-ONLY through the structural port) ---

  /**
   * The registered provider adapters AS DATA — the READ-ONLY discovery
   * surface over the EXISTING /integrations registry (Arena is one
   * adapter key among them; there is no marketplace vocabulary and no
   * provider-selection logic anywhere in this module).
   */
  listArenaProviders(): ReadonlyArray<LabCapabilityArenaAdapterInfo>;
}

// ---------------------------------------------------------------------------
// The reference helpers (pure, exported for tests + consumers)
// ---------------------------------------------------------------------------

/** Formats the opaque capability-version reference (`<capabilityId>#v<version>`). */
export function labCapabilityVersionReference(capabilityId: string, capabilityVersion: number): string {
  return `${capabilityId}#v${capabilityVersion}`;
}

/** Parses an opaque capability-version reference (throws InvalidRequest on a malformed shape). */
export function parseLabCapabilityVersionReference(reference: string): {
  capabilityId: string;
  capabilityVersion: number;
} {
  if (typeof reference !== 'string' || !LAB_CAPABILITY_REFERENCE_PATTERN.test(reference)) {
    throw new InvalidRequestError(
      `capability version reference '${String(reference)}' must match <uuid>#v<version>`,
    );
  }
  const separator = reference.lastIndexOf('#v');
  return {
    capabilityId: reference.slice(0, separator),
    capabilityVersion: Number(reference.slice(separator + 2)),
  };
}

// ---------------------------------------------------------------------------
// The module entry points (wired at the composition root)
// ---------------------------------------------------------------------------

export { createLabCapabilitiesModule } from './internal/capabilities-module.ts';
export {
  createFirstPartyLabCapabilityEvaluator,
  /** The first-party evaluator identities (honestly labeled — the deterministic shape evaluator). */
  FIRST_PARTY_EVALUATOR_ID,
  FIRST_PARTY_EVALUATOR_VERSION,
} from './internal/quality-evaluator.ts';
/**
 * The pure contract guards (the one-level schema subset, the §16
 * declared-field fences, the §17 stage payload fences, the value
 * enforcement) — exported for unit tests and the later Lab consumers so
 * the CONTRACT semantics are part of the module surface. Pure
 * functions: no clock, no randomness, no network.
 */
export {
  assertValidLabCapabilitySchema,
  validateValueAgainstLabCapabilitySchema,
  assertValidLabCapabilityQualityEvaluator,
  assertValidLabCapabilityCost,
  assertValidLabCapabilityLatency,
  assertValidLabCapabilityImplementation,
  assertValidLabCapabilityRequirements,
  assertValidLabCapabilityConstraints,
  assertValidLabCapabilityStrategyCitation,
  assertValidLabCapabilityRequiredAction,
  assertValidLabCapabilityRequestedRights,
  assertValidLabCapabilityGrantedRights,
  assertValidLabCapabilityHumanPlaneCitation,
  assertValidLabCapabilityRealTestCitation,
} from './internal/validation.ts';
