/**
 * MarketingOS module: /social-commerce-attribution
 * Authority: Social-to-Commerce Attribution (MKT-073 —
 * spec/effective-backlog-v1.6.md section E: "link content/distribution
 * experiments to store visits, product interactions and orders.
 * Dependencies: MKT-065, MKT-071, MKT-072, MKT-052. Acceptance:
 * attribution ids survive content transformations and provider
 * boundaries; causal claims remain explicitly separate.";
 * spec/architecture-v1.6.md §16 "Attribution" — THE frozen contract:
 * "Every social-to-product action can carry a mission-scoped
 * attribution reference. Preferred mechanisms include platform-native
 * links where available, UTM parameters, unique landing routes,
 * campaign identifiers, creator/content identifiers and first-party
 * conversion events. Attributed outcomes flow back as evidence/metrics;
 * attribution is never silently treated as causal proof." — plus §15
 * "Commerce loop", §17 "Budget and quota" (the commerce test budget
 * context) and §18 "Security and tenancy"; the frozen v1.6 matrix row,
 * VERBATIM: /social-commerce-attribution → /cross-platform-distribution,
 * /integrations, /metrics, /evidence, /growth-missions).
 *
 * MKT-073 implements the ATTRIBUTION REFERENCE SYSTEM that links
 * content/distribution experiments to store visits, product
 * interactions and orders — SIX record families:
 *
 *   - the ATTRIBUTION REFERENCES: the mission-scoped attribution id
 *     ('sca-<16hex>', deterministically derived from the canonical
 *     creation inputs — the identity digest is the idempotence fence)
 *     with the CLOSED §16 mechanism vocabulary (platform_native_link /
 *     utm_parameters / unique_landing_route / campaign_identifier /
 *     creator_content_identifier / first_party_conversion_event) and
 *     the honest 'unavailable' state for mechanisms a platform does
 *     not offer — never a fabricated link, never a silently skipped
 *     reference;
 *   - the LINK CONSTRUCTIONS: the concrete built link per mechanism —
 *     EACH a deterministic pure function of its inputs under
 *     'sca-link-v1' (the UTM-augmented URL, the landing route, the
 *     campaign id, the creator/content identifier, the recorded
 *     provider native link id, the first-party event contract) with
 *     the construction version, the input digest and the closed
 *     match-field vocabulary recorded;
 *   - the ATTACHMENTS: which distribution action / content
 *     transformation / experiment arm carries which reference —
 *     SURVIVING TRANSFORMATIONS: every attachment cites the ORIGINAL
 *     content identity AND every derived/transformed identity that
 *     carried the reference (the survival chain is append-extended
 *     with each transformation, so the id survives the cross-platform
 *     distribution chain);
 *   - the PROVIDER-BOUNDARY CROSSINGS: the reference entering a
 *     provider payload — the EXACT field it rode, born 'dispatched'
 *     with the single guarded advance to 'echoed' (the provider echo
 *     recorded) or 'dropped' (the honest null — a provider that drops
 *     the reference is recorded as dropping it, NEVER fabricated);
 *   - the CONVERSION EVENTS: store visit / product interaction /
 *     order — the order kind sourced ONLY from the REAL MKT-071
 *     commerce events through the existing commerce boundary (the
 *     order webhook; actual orders are the ONLY order truth — there
 *     is no simulated or caller-asserted sale channel anywhere in
 *     this module); store visits and product interactions are
 *     first-party conversion events;
 *   - the ATTRIBUTION OUTCOMES: THE JOIN (conversion event ←
 *     attribution reference → the mission/experiment/content chain)
 *     with the match provenance (which id matched, on which event
 *     field, observed at what time by which source) — the record is
 *     CO-OCCURRENCE EVIDENCE ONLY and structurally NEVER asserts
 *     causation.
 *
 * CAUSAL CLAIMS EXPLICITLY SEPARATE (the core acceptance, structural):
 * any causal language (lift, contribution, incrementality) is OUT OF
 * SCOPE for this module — no causal computation, column or vocabulary
 * exists anywhere in it; the experiment-analysis authorities own
 * causal estimation. The co-occurrence note is CHECK-fenced at the
 * database level (a causal-claiming outcome row is inexpressible) and
 * the attribution-outcome record is verified by the exported
 * co-occurrence matcher at record time — NEVER a caller-asserted
 * match.
 *
 * THE EVIDENCE FLOWBACK (§16: "Attributed outcomes flow back as
 * evidence/metrics"): the module surfaces the attribution-outcome
 * read model (the cited projection) for /metrics and /evidence
 * consumption — it does NOT write their tables (their authorities
 * stay canonical; the read model is a cited projection).
 *
 * What it is NOT (the bounded scope — the MKT-072 posture):
 *
 *   - NO second mission authority: every reference is scoped to its
 *     Growth Mission, cited OPAQUELY through the /growth-missions
 *     structural port (the mission spine stays sole);
 *   - NO second order/catalog/listing authority (lock rules 32/33):
 *     no catalog, order, listing, price or inventory record is
 *     created, mutated or shadowed here; the conversion events CITE
 *     the real commerce projections (the migration-049 projections
 *     stay the /integrations boundary's own);
 *   - NO second experiment engine: the experiment-arm citations are
 *     OPAQUE recorded data (the MKT-052-lineage spine stays sole);
 *   - NO provider call of any kind: no social provider HTTP, no
 *     commerce provider HTTP — the module records crossings as data;
 *     the webhook ingestion path (the provider boundary) lives in
 *     /integrations;
 *   - NO causal estimation, NO lift/contribution/incrementality
 *     computation, NO experiment analysis (the analysis authorities
 *     consume the read model);
 *   - NO provider credential, NO store connection of its own (§18:
 *     the commerce boundary owns those — external account/store
 *     references are opaque recorded data here).
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row registered for this
 * Work Item, VERBATIM): /social-commerce-attribution →
 * /cross-platform-distribution, /integrations, /metrics, /evidence,
 * /growth-missions. The /cross-platform-distribution direction is
 * exercised BY REFERENCE (the attachments cite the distribution
 * actions, content transformations and derived identities as OPAQUE
 * recorded data — no import, no join); the /integrations direction
 * rides the declared narrow COMMERCE-EVENT structural port (the
 * LAB-013 Arena-port precedent: the REAL /integrations instance
 * satisfies the port structurally at the composition root, so the
 * fail-closed provider/policy/credential gates stay in /integrations,
 * the sole provider authority); the /growth-missions direction rides
 * the declared narrow MISSION structural port (READ-ONLY); the
 * /metrics + /evidence directions are the flowback CONSUMPTION
 * surface (the read model is surfaced FOR them — this module imports
 * neither; the MKT-069 "imports nothing yet, disclosed in the matrix
 * note" precedent). The pursuit-scope workspace port is the DISCLOSED
 * off-matrix structural wiring (the MKT-070/MKT-072 precedent).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (sca-vocab-v1 — CHECK-fenced in migration 069;
// pinned by unit + boundary tests)
// ---------------------------------------------------------------------------

/**
 * The frozen contract identity of this module (recorded on every
 * reference row; a change to the record families, the vocabularies or
 * the fences is a NEW contract version).
 */
export const SOCIAL_COMMERCE_ATTRIBUTION_CONTRACT_VERSION = 'sca-contract-v1' as const;

/**
 * The frozen vocabulary version: the mechanism vocabulary (with the
 * honest 'unavailable' state), the reference states, the crossing
 * states + the advance table, the conversion kinds/sources, the
 * attachment carrier kinds and the closed match-field vocabulary. A
 * change to ANY of them is a NEW version string.
 */
export const SOCIAL_COMMERCE_ATTRIBUTION_VOCABULARY_VERSION = 'sca-vocab-v1' as const;

/**
 * The frozen link-construction version (the deterministic formula set
 * of the pure core: the UTM assembly, the landing-route derivation,
 * the campaign-id composition, the creator/content identifier, the
 * recorded provider native link and the first-party event contract).
 */
export const SOCIAL_COMMERCE_ATTRIBUTION_LINK_VERSION = 'sca-link-v1' as const;

/**
 * The frozen co-occurrence matcher version (the pure match rules: the
 * mechanism-specific match field + the universal 'attributionRef'
 * carrier field).
 */
export const SOCIAL_COMMERCE_ATTRIBUTION_MATCH_VERSION = 'sca-match-v1' as const;

/**
 * THE CLOSED §16 MECHANISM VOCABULARY (architecture-v1.6.md §16
 * VERBATIM: "Preferred mechanisms include platform-native links where
 * available, UTM parameters, unique landing routes, campaign
 * identifiers, creator/content identifiers and first-party conversion
 * events.") WITH the honest 'unavailable' state: a platform that
 * offers no attribution mechanism for the action is recorded as
 * 'unavailable' — the module never fabricates a link for a mechanism
 * a platform does not offer (the DB fence rejects any construction,
 * attachment or crossing on an unavailable reference).
 */
export const SOCIAL_ATTRIBUTION_MECHANISMS = [
  'platform_native_link',
  'utm_parameters',
  'unique_landing_route',
  'campaign_identifier',
  'creator_content_identifier',
  'first_party_conversion_event',
  'unavailable',
] as const;

export type SocialAttributionMechanism = (typeof SOCIAL_ATTRIBUTION_MECHANISMS)[number];

export function isKnownSocialAttributionMechanism(value: string): value is SocialAttributionMechanism {
  return (SOCIAL_ATTRIBUTION_MECHANISMS as readonly string[]).includes(value);
}

/**
 * The CONSTRUCTIBLE mechanism subset — the six real §16 mechanisms.
 * 'unavailable' is deliberately EXCLUDED: an honestly unavailable
 * mechanism builds nothing, carries nothing, crosses nothing and
 * matches nothing (the migration-069 double fence).
 */
export const SOCIAL_ATTRIBUTION_CONSTRUCTIBLE_MECHANISMS = [
  'platform_native_link',
  'utm_parameters',
  'unique_landing_route',
  'campaign_identifier',
  'creator_content_identifier',
  'first_party_conversion_event',
] as const;

export type SocialAttributionConstructibleMechanism =
  (typeof SOCIAL_ATTRIBUTION_CONSTRUCTIBLE_MECHANISMS)[number];

export function isConstructibleSocialAttributionMechanism(
  value: string,
): value is SocialAttributionConstructibleMechanism {
  return (SOCIAL_ATTRIBUTION_CONSTRUCTIBLE_MECHANISMS as readonly string[]).includes(value);
}

/** The frozen reference lifecycle: born 'active'; the single guarded advance to 'retired'. */
export const SOCIAL_ATTRIBUTION_REFERENCE_STATUSES = ['active', 'retired'] as const;

export type SocialAttributionReferenceStatus = (typeof SOCIAL_ATTRIBUTION_REFERENCE_STATUSES)[number];

/** The frozen crossing lifecycle: born 'dispatched'; the single guarded advance to 'echoed' | 'dropped'. */
export const SOCIAL_ATTRIBUTION_CROSSING_STATUSES = ['dispatched', 'echoed', 'dropped'] as const;

export type SocialAttributionCrossingStatus = (typeof SOCIAL_ATTRIBUTION_CROSSING_STATUSES)[number];

/** The closed conversion-kind vocabulary (the objective's three outcome surfaces). */
export const SOCIAL_ATTRIBUTION_CONVERSION_KINDS = [
  'store_visit',
  'product_interaction',
  'order',
] as const;

export type SocialAttributionConversionKind = (typeof SOCIAL_ATTRIBUTION_CONVERSION_KINDS)[number];

/** The closed conversion-source vocabulary (the order-truth fence's two sources). */
export const SOCIAL_ATTRIBUTION_CONVERSION_SOURCES = ['order_webhook', 'first_party_event'] as const;

export type SocialAttributionConversionSource = (typeof SOCIAL_ATTRIBUTION_CONVERSION_SOURCES)[number];

/** The closed attachment carrier-kind vocabulary (the linkage surfaces). */
export const SOCIAL_ATTRIBUTION_CARRIER_KINDS = [
  'distribution_action',
  'content_transformation',
  'experiment_arm',
] as const;

export type SocialAttributionCarrierKind = (typeof SOCIAL_ATTRIBUTION_CARRIER_KINDS)[number];

/**
 * THE CLOSED MATCH-FIELD VOCABULARY — the observed-field names of the
 * commerce attribution passthrough (the provider-side field convention
 * the migration-049 projections carry verbatim): the field each
 * mechanism's constructed link rides on the conversion event.
 */
export const SOCIAL_ATTRIBUTION_MATCH_FIELDS = [
  'utmContent',
  'landingRoute',
  'campaignId',
  'creatorContentRef',
  'nativeLinkId',
  'attributionRef',
] as const;

export type SocialAttributionMatchField = (typeof SOCIAL_ATTRIBUTION_MATCH_FIELDS)[number];

/**
 * THE PINNED CO-OCCURRENCE NOTE (the causal-separation discipline,
 * structural): the literal EVERY attribution-outcome row carries —
 * CHECK-fenced at the database level, so a causal-claiming outcome
 * row is inexpressible. Lift, contribution and incrementality are OUT
 * OF SCOPE for this module; the experiment-analysis authorities own
 * causal estimation.
 */
export const SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE =
  'co-occurrence evidence only — never causal proof' as const;

/** The stable attribution id grammar: 'sca-' + 16 lowercase hex. */
export const SOCIAL_ATTRIBUTION_REF_PATTERN = /^sca-[0-9a-f]{16}$/;

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every module command (the
 * GrowthMissionProvenance precedent): built exclusively from the
 * authenticated principal, the ambient correlation context and the
 * recording surface — never from a request body.
 */
export interface SocialCommerceAttributionProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface SocialCommerceAttributionRecordedProvenance
  extends SocialCommerceAttributionProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The record types (the migration-069 storage shapes)
// ---------------------------------------------------------------------------

/** One persisted attribution reference (the mission-scoped attribution id). */
export interface SocialAttributionReferenceRecord {
  readonly attributionReferenceId: string;
  /** The Growth Mission this reference is scoped to (OPAQUE citation — the mission spine stays sole). */
  readonly missionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** THE STABLE ATTRIBUTION ID ('sca-<16hex>') — survives transformations and provider boundaries. */
  readonly attributionRef: string;
  /** The deterministic identity digest (the idempotence fence). */
  readonly identityDigest: string;
  readonly mechanism: SocialAttributionMechanism;
  readonly purpose: string;
  /** The bounded creation context (the recorded linkage data — opaque ids, never a join). */
  readonly creationContext: Readonly<Record<string, unknown>>;
  readonly status: SocialAttributionReferenceStatus;
  readonly retiredReason: string | null;
  readonly contractVersion: string;
  readonly vocabularyVersion: string;
  readonly provenance: SocialCommerceAttributionRecordedProvenance;
}

/** One append-only link-construction record (the concrete built link). */
export interface SocialAttributionLinkConstructionRecord {
  readonly linkConstructionId: string;
  readonly attributionReferenceId: string;
  readonly constructionVersion: string;
  readonly mechanism: SocialAttributionConstructibleMechanism;
  /** The bounded construction inputs (the pure formula's declared data). */
  readonly constructionInput: Readonly<Record<string, unknown>>;
  /** The deterministic input digest (the construction idempotence fence). */
  readonly inputDigest: string;
  /** THE CONCRETE BUILT LINK (the UTM URL / the landing route / the campaign id / ...). */
  readonly constructedLink: string;
  readonly matchField: SocialAttributionMatchField;
  readonly matchValue: string;
  readonly provenance: SocialCommerceAttributionRecordedProvenance;
}

/** One append-only attachment record (the transformation-survival surface). */
export interface SocialAttributionAttachmentRecord {
  readonly attachmentId: string;
  readonly attributionReferenceId: string;
  readonly carrierKind: SocialAttributionCarrierKind;
  /** The OPAQUE carrier citation (the distribution action / transformation / experiment arm). */
  readonly carrierRef: string;
  /** THE ORIGINAL content identity the reference attached to at mint time. */
  readonly originalContentRef: string;
  /** EVERY derived/transformed content identity that carried the reference (the survival chain). */
  readonly carriedContentRefs: readonly string[];
  readonly reason: string;
  readonly provenance: SocialCommerceAttributionRecordedProvenance;
}

/** One provider-boundary crossing record (born 'dispatched'; the single guarded advance). */
export interface SocialAttributionCrossingRecord {
  readonly crossingId: string;
  readonly attributionReferenceId: string;
  readonly linkConstructionId: string;
  readonly providerKey: string;
  /** THE EXACT FIELD the reference rode in the provider payload. */
  readonly payloadField: string;
  readonly dispatchedValue: string;
  readonly crossingState: SocialAttributionCrossingStatus;
  /** The provider echo (recorded when the provider returned it; the honest null on 'dropped'). */
  readonly echoValue: string | null;
  readonly echoObservedAt: string | null;
  readonly advanceReason: string | null;
  readonly provenance: SocialCommerceAttributionRecordedProvenance;
}

/** One append-only conversion-event record (store visit / product interaction / order). */
export interface SocialAttributionConversionEventRecord {
  readonly conversionEventId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly conversionKind: SocialAttributionConversionKind;
  readonly eventSource: SocialAttributionConversionSource;
  /** The REAL commerce-event citation (orders ONLY — the migration-049 projection id). */
  readonly commerceEventId: string | null;
  readonly storeConnectionId: string | null;
  readonly providerEventId: string | null;
  readonly subjectRef: string | null;
  readonly occurredAt: string | null;
  readonly observedAt: string;
  /** The observed reference fields the co-occurrence matcher runs over. */
  readonly observedFields: Readonly<Record<string, unknown>>;
  readonly provenance: SocialCommerceAttributionRecordedProvenance;
}

/**
 * One append-only attribution-outcome record (THE JOIN — co-occurrence
 * evidence with the match provenance; NEVER a causal claim).
 */
export interface SocialAttributionOutcomeRecord {
  readonly attributionOutcomeId: string;
  readonly conversionEventId: string;
  readonly attributionReferenceId: string;
  readonly linkConstructionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly mechanism: SocialAttributionConstructibleMechanism;
  readonly matchedField: SocialAttributionMatchField;
  readonly matchedValue: string;
  /** The full match provenance (which id matched, on which field, observed when, by which source). */
  readonly matchProvenance: Readonly<Record<string, unknown>>;
  /** The pinned co-occurrence note (CHECK-fenced — the causal-separation discipline). */
  readonly coOccurrenceNote: string;
  /** The evidence/metrics flowback citation (the cited projection shape). */
  readonly flowbackCitation: Readonly<Record<string, unknown>>;
  readonly provenance: SocialCommerceAttributionRecordedProvenance;
}

/**
 * THE FLOWBACK READ MODEL (§16: "Attributed outcomes flow back as
 * evidence/metrics"): the cited projection the /metrics and /evidence
 * consumers read — the outcome joined with its conversion event, its
 * reference and the mission/experiment/content chain, carrying the
 * match provenance and the pinned non-causal framing. A PROJECTION
 * ONLY: this module writes neither /metrics nor /evidence tables.
 */
export interface SocialAttributionOutcomeReadModelRow {
  readonly outcomeId: string;
  readonly conversionEvent: {
    readonly conversionEventId: string;
    readonly conversionKind: SocialAttributionConversionKind;
    readonly eventSource: SocialAttributionConversionSource;
    readonly commerceEventId: string | null;
    readonly observedAt: string;
  };
  readonly attributionReference: {
    readonly attributionReferenceId: string;
    readonly attributionRef: string;
    readonly mechanism: SocialAttributionMechanism;
    readonly missionId: string;
    readonly status: SocialAttributionReferenceStatus;
  };
  readonly matchProvenance: Readonly<Record<string, unknown>>;
  readonly coOccurrenceNote: string;
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The pure core (sca-link-v1 — re-exported from internal/link-core.ts;
// deterministic, no clock, no randomness, no I/O)
// ---------------------------------------------------------------------------

/**
 * The construction input of ONE built link (the declared data the pure
 * formula consumes; the mechanism-required fields are validated by the
 * guards and the formula itself fails closed on a missing input).
 */
export interface SocialAttributionLinkConstructionInput {
  readonly mechanism: SocialAttributionConstructibleMechanism;
  readonly attributionRef: string;
  readonly missionId: string;
  /** utm_parameters: the bare base URL (http/https, no query string). */
  readonly baseUrl?: string | null;
  /** utm_parameters: the utm_source value (default 'mos'). */
  readonly utmSource?: string | null;
  /** utm_parameters: the utm_medium value (default 'social'). */
  readonly utmMedium?: string | null;
  /** platform_native_link: the provider-assigned native link id (recorded data). */
  readonly providerLinkId?: string | null;
  /** creator_content_identifier: the creator reference. */
  readonly creatorRef?: string | null;
  /** creator_content_identifier: the content reference. */
  readonly contentRef?: string | null;
  /** first_party_conversion_event: the declared first-party event name (default 'mos_conversion'). */
  readonly eventName?: string | null;
}

/** The construction output: the concrete built link + its match contract. */
export interface SocialAttributionConstructedLink {
  /** The concrete built link (the UTM-augmented URL / the landing route / the campaign id / ...). */
  readonly link: string;
  /** The closed observed-field name the reference rides on the conversion event. */
  readonly matchField: SocialAttributionMatchField;
  /** The exact value the observed field must carry for this construction to match. */
  readonly matchValue: string;
}

/** The construction outcome: the built link, or the honest bounded error. */
export type SocialAttributionLinkConstructionResult =
  | { readonly ok: true; readonly built: SocialAttributionConstructedLink }
  | { readonly ok: false; readonly error: string };

/**
 * The observed-link shape the co-occurrence matcher consumes (the
 * link-construction record's match contract + the reference's stable
 * attribution id).
 */
export interface SocialAttributionObservableLink {
  readonly linkConstructionId: string;
  readonly mechanism: SocialAttributionConstructibleMechanism;
  readonly matchField: SocialAttributionMatchField;
  readonly matchValue: string;
  readonly attributionRef: string;
}

/** The verified match the matcher returns (the co-occurrence evidence). */
export interface SocialAttributionVerifiedMatch {
  readonly linkConstructionId: string;
  readonly mechanism: SocialAttributionConstructibleMechanism;
  readonly matchedField: SocialAttributionMatchField;
  readonly matchedValue: string;
}

/** The matcher outcome: the verified match, or null (no co-occurrence evidence). */
export type SocialAttributionMatchResult = SocialAttributionVerifiedMatch | null;

// ---------------------------------------------------------------------------
// The declared structural ports (wired at the composition root over the
// REAL public-contract instances — the LAB-013 Arena-port precedent)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /growth-missions public contract this
 * module consumes (READ-ONLY — the frozen-row direction): the raw
 * mission row for scope resolution. The real GrowthMissionsModuleApi
 * satisfies this structurally; /growth-missions remains the ONLY
 * mission authority and is NEVER mutated from here.
 */
export interface SocialAttributionMissionPort {
  getGrowthMission(missionId: string): Promise<{
    readonly missionId: string;
    readonly agencyId: string;
    readonly status: string;
  } | null>;
}

/**
 * The DISCLOSED off-matrix pursuit-scope port (the MKT-070/MKT-072
 * precedent): the canonical workspace → client → agency ownership
 * chain, READ-ONLY. The real /workspaces public-contract instance is
 * wired at the composition root.
 */
export interface SocialAttributionWorkspacePort {
  resolveWorkspace(workspaceId: string): Promise<{
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly status: string;
  } | null>;
}

/**
 * The narrow COMMERCE-EVENT structural port (the frozen-row
 * /integrations direction — the LAB-013 Arena-port precedent): the
 * client's ALREADY-INGESTED normalized commerce-event projections with
 * the attribution passthrough VERBATIM. The REAL /integrations
 * instance satisfies this structurally at the composition root — the
 * fail-closed provider/policy/credential gates stay in /integrations,
 * the sole provider authority; this module holds NO provider
 * credential and NO store connection of its own.
 */
export interface SocialAttributionCommerceEventSnapshot {
  readonly commerceEventId: string;
  readonly clientId: string;
  readonly connectionId: string;
  readonly adapterKey: string;
  readonly providerEventId: string;
  readonly eventKind: string;
  readonly providerSubjectId: string;
  /** The provider's attribution/reference fields VERBATIM (may be empty). */
  readonly attribution: Readonly<Record<string, unknown>>;
  readonly receivedAt: string;
}

export interface SocialAttributionCommerceEventPort {
  /** The client's ingested commerce events (newest first, bounded). */
  listCommerceEventsForClient(
    clientId: string,
  ): Promise<readonly SocialAttributionCommerceEventSnapshot[]>;
}

// ---------------------------------------------------------------------------
// The module API
// ---------------------------------------------------------------------------

export interface SocialCommerceAttributionModuleApi {
  // --- The attribution references ---

  /**
   * MINTS one mission-scoped attribution reference (§16: "Every
   * social-to-product action can carry a mission-scoped attribution
   * reference"):
   *
   *   1. resolves the mission through the /growth-missions structural
   *      port (READ-ONLY — the mission authority stays sole): unknown
   *      mission → the uniform 404 (no existence oracle);
   *   2. resolves the PURSUIT SCOPE through the workspace port: an
   *      unknown workspace, or a workspace of ANOTHER agency than the
   *      mission, is the uniform 404; a disabled workspace is an
   *      honest ConflictError;
   *   3. derives the STABLE ATTRIBUTION ID deterministically: the
   *      identity digest is SHA-256 over the canonical creation inputs
   *      (contract version + mission + mechanism + purpose + context),
   *      and the attribution id is its first 16 hex — 'sca-<16hex>';
   *   4. appends the reference row IDEMPOTENTLY: the same canonical
   *      inputs converge on the SAME reference (the identity-digest
   *      fence — no silent duplicate, no silent rewrite).
   *
   * The honest 'unavailable' mechanism state is a FIRST-CLASS input: a
   * platform that offers no attribution mechanism for the action is
   * recorded as such (the DB fence later rejects any construction,
   * attachment or crossing on it — never a fabricated link).
   */
  createAttributionReference(
    input: {
      readonly missionId: string;
      readonly pursuitWorkspaceId: string;
      readonly mechanism: SocialAttributionMechanism;
      /** The declared purpose of this reference (1..4000 chars). */
      readonly purpose: string;
      /**
       * The bounded creation context (the recorded linkage data: the
       * content anchor / experiment arm the reference was minted for —
       * opaque ids, at most 10 scalar fields).
       */
      readonly creationContext?: Readonly<Record<string, unknown>>;
    },
    provenance: SocialCommerceAttributionProvenance,
  ): Promise<SocialAttributionReferenceRecord>;

  /** Raw reference record by id (append-only history is always readable). */
  getAttributionReference(attributionReferenceId: string): Promise<SocialAttributionReferenceRecord | null>;

  /** The mission's references (oldest first). Null when the mission is unknown. */
  listAttributionReferencesForMission(
    missionId: string,
  ): Promise<readonly SocialAttributionReferenceRecord[] | null>;

  /** The client's references (newest first, bounded). */
  listAttributionReferencesForClient(
    clientId: string,
  ): Promise<readonly SocialAttributionReferenceRecord[]>;

  /**
   * RECORDS the single guarded retirement advance (active → retired,
   * reason REQUIRED; no reopen, no resurrection — the DB trigger is
   * the backstop). A retired reference accepts no new linkage at the
   * module layer; its history and outcomes stay readable.
   */
  retireAttributionReference(
    input: {
      readonly attributionReferenceId: string;
      /** The REQUIRED reason (1..4000 chars). */
      readonly reason: string;
    },
    provenance: SocialCommerceAttributionProvenance,
  ): Promise<SocialAttributionReferenceRecord>;

  // --- The link constructions ---

  /**
   * BUILDS + RECORDS one link construction — the concrete built link
   * per mechanism, a DETERMINISTIC PURE FUNCTION of its inputs under
   * 'sca-link-v1' (no clock, no randomness, no I/O in the formula).
   * Requires an ACTIVE reference of a CONSTRUCTIBLE mechanism (an
   * honestly 'unavailable' reference is an honest ConflictError —
   * never a fabricated link; the DB fence is the backstop). The
   * construction is IDEMPOTENT per (reference, input digest) — the
   * same inputs converge on the SAME construction record.
   */
  constructAttributionLink(
    input: {
      readonly attributionReferenceId: string;
      /** The mechanism-required construction inputs (validated per mechanism). */
      readonly construction: SocialAttributionLinkConstructionInput;
    },
    provenance: SocialCommerceAttributionProvenance,
  ): Promise<SocialAttributionLinkConstructionRecord>;

  /** The reference's constructions (oldest first). Null when the reference is unknown. */
  listLinkConstructionsForReference(
    attributionReferenceId: string,
  ): Promise<readonly SocialAttributionLinkConstructionRecord[] | null>;

  // --- The attachments (the transformation-survival surface) ---

  /**
   * RECORDS one attachment — which distribution action / content
   * transformation / experiment arm carries which reference.
   * SURVIVING TRANSFORMATIONS (the core acceptance): the attachment
   * cites the ORIGINAL content identity AND every derived/transformed
   * identity that carried the reference (the survival chain must
   * CARRY the original — the DB helper fence makes an attachment that
   * dropped it inexpressible). Each transformation EXTENDS the chain
   * as a NEW append-only attachment record, so the id survives the
   * cross-platform distribution chain. The carrier citations are
   * OPAQUE recorded data (no /cross-platform-distribution join, no
   * /content-assets join, no /experiments join). Requires an ACTIVE
   * reference of a constructible mechanism.
   */
  recordAttributionAttachment(
    input: {
      readonly attributionReferenceId: string;
      readonly carrierKind: SocialAttributionCarrierKind;
      readonly carrierRef: string;
      /** The ORIGINAL content identity (the head of the survival chain). */
      readonly originalContentRef: string;
      /** EVERY derived/transformed identity that carried the reference (1..50, MUST carry the original). */
      readonly carriedContentRefs: readonly string[];
      /** The REQUIRED reason this attachment is recorded (1..4000 chars). */
      readonly reason: string;
    },
    provenance: SocialCommerceAttributionProvenance,
  ): Promise<SocialAttributionAttachmentRecord>;

  /** The reference's attachments (oldest first). Null when the reference is unknown. */
  listAttachmentsForReference(
    attributionReferenceId: string,
  ): Promise<readonly SocialAttributionAttachmentRecord[] | null>;

  // --- The provider-boundary crossings ---

  /**
   * RECORDS one provider-boundary crossing — the reference entering a
   * provider payload: the constructed link that rode it, the provider
   * key, THE EXACT FIELD it rode and the dispatched value. Born
   * 'dispatched'. Requires an ACTIVE reference; the cited construction
   * must be the reference's OWN (the DB citation fence is the
   * backstop). NO provider call happens here (the crossing is recorded
   * data — the provider boundary lives elsewhere).
   */
  recordProviderBoundaryCrossing(
    input: {
      readonly attributionReferenceId: string;
      readonly linkConstructionId: string;
      readonly providerKey: string;
      readonly payloadField: string;
      readonly dispatchedValue: string;
    },
    provenance: SocialCommerceAttributionProvenance,
  ): Promise<SocialAttributionCrossingRecord>;

  /**
   * RECORDS the single guarded crossing advance (the honest provider
   * boundary):
   *   - 'echoed': the provider returned the reference — the echo value
   *     + the observation time + the reason are recorded;
   *   - 'dropped': the provider dropped it — the honest null echo, the
   *     reason REQUIRED (a dropped reference is NEVER fabricated into
   *     an echo).
   * The advance is single-shot (a second attempt is an honest
   * ConflictError; the DB trigger is the backstop).
   */
  advanceProviderBoundaryCrossing(
    input: {
      readonly crossingId: string;
      readonly toState: 'echoed' | 'dropped';
      /** The provider echo value (REQUIRED on 'echoed'; must be null on 'dropped'). */
      readonly echoValue: string | null;
      /** The REQUIRED reason of the advance (1..4000 chars). */
      readonly reason: string;
    },
    provenance: SocialCommerceAttributionProvenance,
  ): Promise<SocialAttributionCrossingRecord>;

  /** The reference's crossings (oldest first). Null when the reference is unknown. */
  listProviderCrossingsForReference(
    attributionReferenceId: string,
  ): Promise<readonly SocialAttributionCrossingRecord[] | null>;

  // --- The conversion events ---

  /**
   * RECORDS one ORDER conversion event — sourced from the REAL MKT-071
   * commerce events through the existing commerce boundary (the
   * commerce-event structural port): the pursuit workspace resolves the
   * client scope server-side (the same pursuit-scope chain as the
   * reference creation), and the cited commerce event must be one of
   * that client's INGESTED order-kind projections (the uniform 404
   * otherwise — never a traversal oracle); ACTUAL ORDERS ARE THE ONLY
   * ORDER TRUTH (there is no caller-asserted order channel anywhere in
   * this module). The observed reference fields are the commerce
   * event's attribution passthrough VERBATIM (the co-occurrence
   * matcher runs over them).
   */
  recordOrderConversionEvent(
    input: {
      readonly pursuitWorkspaceId: string;
      readonly commerceEventId: string;
    },
    provenance: SocialCommerceAttributionProvenance,
  ): Promise<SocialAttributionConversionEventRecord>;

  /**
   * RECORDS one FIRST-PARTY conversion event (§16: "first-party
   * conversion events") — a store visit or a product interaction
   * observed by MOS's own instrumentation (e.g. the landing-route hit,
   * the product interaction): the pursuit workspace resolves the
   * client scope server-side, and the caller declares the kind and the
   * OBSERVED REFERENCE FIELDS (bounded scalar fields only — the same
   * discipline as the commerce attribution passthrough). An order kind
   * is honestly refused here (the order-truth fence: orders come from
   * the real commerce boundary ONLY — recordOrderConversionEvent).
   */
  recordFirstPartyConversionEvent(
    input: {
      readonly pursuitWorkspaceId: string;
      readonly conversionKind: 'store_visit' | 'product_interaction';
      readonly subjectRef?: string | null;
      /** The source's occurrence time (null when unknown). */
      readonly occurredAt?: string | null;
      /** The observed reference fields (at most 20 scalar fields). */
      readonly observedFields: Readonly<Record<string, unknown>>;
    },
    provenance: SocialCommerceAttributionProvenance,
  ): Promise<SocialAttributionConversionEventRecord>;

  /** Raw conversion event by id (append-only history is always readable). */
  getConversionEvent(conversionEventId: string): Promise<SocialAttributionConversionEventRecord | null>;

  /** The client's conversion events (newest first, bounded). */
  listConversionEventsForClient(
    clientId: string,
  ): Promise<readonly SocialAttributionConversionEventRecord[]>;

  // --- The attribution outcomes (the join) ---

  /**
   * RECORDS one attribution outcome — THE JOIN, VERIFIED BY THE
   * CO-OCCURRENCE MATCHER (never a caller-asserted match):
   *
   *   1. resolves the conversion event and the reference (the uniform
   *      404 on unknown/foreign scope — no existence oracle);
   *   2. requires the SAME client scope on both (the uniform 404
   *      otherwise);
   *   3. runs the exported co-occurrence matcher over the conversion
   *      event's observed reference fields against the reference's
   *      constructed links — NO verified match is an honest
   *      ConflictError (the co-occurrence is NOT evidenced; the
   *      outcome row is inexpressible);
   *   4. appends the outcome row with the MATCH PROVENANCE (which id
   *      matched, on which event field, observed at what time by which
   *      source) and the CHECK-FENCED CO-OCCURRENCE NOTE.
   *
   * The record is CO-OCCURRENCE EVIDENCE ONLY — it structurally NEVER
   * asserts causation (no lift/contribution/incrementality vocabulary
   * exists anywhere in this module; the experiment-analysis
   * authorities own causal estimation).
   */
  recordAttributionOutcome(
    input: {
      readonly conversionEventId: string;
      readonly attributionReferenceId: string;
    },
    provenance: SocialCommerceAttributionProvenance,
  ): Promise<SocialAttributionOutcomeRecord>;

  /** The reference's outcomes (oldest first). Null when the reference is unknown. */
  listAttributionOutcomesForReference(
    attributionReferenceId: string,
  ): Promise<readonly SocialAttributionOutcomeRecord[] | null>;

  /** The mission's outcomes (oldest first). Null when the mission is unknown. */
  listAttributionOutcomesForMission(
    missionId: string,
  ): Promise<readonly SocialAttributionOutcomeRecord[] | null>;

  /**
   * THE EVIDENCE FLOWBACK READ MODEL (§16: "Attributed outcomes flow
   * back as evidence/metrics"): the cited projection for /metrics and
   * /evidence consumption — the client's outcomes joined with their
   * conversion events and references, carrying the match provenance
   * and the pinned non-causal framing. A READ-ONLY PROJECTION: this
   * module writes neither /metrics nor /evidence tables (their
   * authorities stay canonical).
   */
  listAttributionOutcomeReadModel(
    clientId: string,
  ): Promise<readonly SocialAttributionOutcomeReadModelRow[]>;
}

// ---------------------------------------------------------------------------
// The module deps + the factory re-exports
// ---------------------------------------------------------------------------

/**
 * The module deps: platform ports + the three declared structural
 * ports (wired at the composition root over the REAL public-contract
 * instances — the /growth-missions mission port, the DISCLOSED
 * off-matrix pursuit-scope workspace port (the MKT-070/MKT-072
 * precedent) and the /integrations commerce-event port).
 */
export interface SocialCommerceAttributionModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly missions: SocialAttributionMissionPort;
  readonly workspaces: SocialAttributionWorkspacePort;
  readonly commerceEvents: SocialAttributionCommerceEventPort;
}

export { createSocialCommerceAttributionModule } from './internal/attribution-module.ts';
export { SocialCommerceAttributionStore } from './internal/attribution-store.ts';
export {
  buildAttributionLink,
  deriveAttributionIdentity,
} from './internal/link-core.ts';
export { matchAttributionLinks } from './internal/link-core.ts';
export { canonicalSocialAttributionJson } from './internal/validation.ts';
