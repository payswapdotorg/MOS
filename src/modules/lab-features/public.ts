/**
 * MarketingOS module: /lab-features
 * Authority: Multimodal Content Feature Bundle (LAB-003 — spec/
 * effective-backlog-v1.7.md LAB-003: "Extract versioned text/audio/
 * visual/metadata representations, with optional ephemeral media
 * access. Acceptance: reproducible feature identity/versioning,
 * source linkage, batch extraction, failure states, tenant
 * isolation."; dependencies satisfied: LAB-002 (merged — the
 * /lab-corpus reference-first corpus); spec/
 * architecture-v1.7-marketing-lab.md §4 "Reference-first content
 * universe" (the media-access chain: "Reference → permitted media
 * access → decode/stream → feature extraction → feature bundle";
 * "The system may retain temporary media bytes only when the
 * acquisition path and rights/policy permit it. Provider adapters
 * MUST enforce provider-specific acquisition constraints. The Lab
 * MUST NOT assume that a public URL grants permission to download,
 * cache, transform or redistribute media."; "Feature extraction
 * should persist useful derived representations so repeated
 * simulation does not require repeated media access.") and §5
 * "Multimodal Content Feature Bundle" (the versioned feature list:
 * "The exact feature set is versioned. Feature extraction is
 * reproducible where practical and records encoder/model identity.");
 * §22 multi-tenancy ("All Lab scenarios, corpora, feature bundles,
 * model artifacts, runs and calibration records remain tenant/
 * workspace scoped. Cross-tenant content may not be silently
 * incorporated into a tenant's proprietary search space.");
 * architecture-lock-v1.7 rules 5/6/7/8/29; AGENTS.md v1.7
 * "Multimodal feature bundles and Idea Graph abstractions are
 * versioned and source-linked."; EXECUTION-PLAN.md §11 (the
 * extraction-success dimension of coverage reporting).
 *
 * THE FEATURE LAYER (LAB-003's frozen scope — the Idea Graph
 * (LAB-004) and the simulator (LAB-005) consume these bundles BY
 * REFERENCE through this public surface; the /lab-corpus reference
 * stays the SOLE corpus authority and is never joined or written
 * here):
 *
 *   - THE VERSIONED FEATURE SET (§5): a CLOSED, versioned
 *     feature-set definition — contract identity
 *     'lab-features-contract-v1' + the feature-set version string
 *     'lab-featureset-v1' — holding the 27 §5 feature keys with
 *     their per-modality grouping (text/audio/visual/metadata).
 *     Every feature value carries its encoder/model identity (the
 *     deterministic first-party extractors record their honest
 *     deterministic encoder identities; a real encoder records its
 *     model identity) and either a concrete derived representation
 *     or an EXPLICIT unavailable state with a closed reason. A
 *     feature the extractor cannot derive is recorded with its
 *     honest unavailable state + reason, NEVER fabricated (the
 *     /platform-health observable-signals-only discipline).
 *   - REPRODUCIBLE FEATURE IDENTITY/VERSIONING: the bundle identity
 *     is DETERMINISTIC — a pure function of (the cited reference
 *     identity fields, the feature-set version, the extractor
 *     identity+version, the input digest), materialized as the
 *     SHA-256 identity digest over the canonical serialization.
 *     The same inputs always produce the same bundle identity and
 *     the same derived values for deterministic extractors; a
 *     re-extraction under a NEW feature-set/extractor version (or
 *     from a changed input) is a NEW bundle_version row on the SAME
 *     per-reference append-only chain — never an in-place rewrite
 *     (the LAB-001/LAB-002 version discipline).
 *   - SOURCE LINKAGE: every bundle carries the FULL citation data of
 *     its source — referenceId (opaque uuid), corpusId +
 *     corpusVersion, provider, providerContentId, canonicalUrl, the
 *     observation metadata digest it was extracted from, and the
 *     media-availability state observed at extraction time — all
 *     RECORDED DATA, never a join (the /lab and /lab-corpus
 *     by-reference discipline: NO import of /lab-corpus exists here
 *     and NO /lab-corpus table is written).
 *   - OPTIONAL EPHEMERAL MEDIA ACCESS: the extraction input carries
 *     an OPTIONAL media-access grant object validated against the
 *     CLOSED availability/posture vocabularies — ONLY
 *     'available_permitted' + a 'reference_gated' posture may open a
 *     media path; everything else fails closed BEFORE any bytes are
 *     requested (the item fails with its honest closed reason).
 *     Media bytes, when granted, ride an IN-MEMORY HANDLE through
 *     the extraction call ONLY — they are NEVER persisted (migration
 *     065 has NO bytea/binary column anywhere; the §4 structural
 *     rule). The media fetch stays behind the REPLACEABLE
 *     LabMediaFetchPort — the first-party implementation ships the
 *     HONEST PENDING STATE (no provider adapter is wired; the real
 *     provider-adapter wiring arrives with the corpus backfills).
 *   - THE EXTRACTION PORT: a replaceable, test-double-friendly port
 *     contract (the LAB-002 ingestion-seam precedent) — the
 *     first-party implementation is HONEST about what it can and
 *     cannot extract: the metadata-derived features extract
 *     deterministically from the recorded metadata snapshot; the
 *     encoder-grade features (embeddings and semantic structures)
 *     record their honest unavailable state until a real encoder is
 *     wired. Extraction failures fail closed into honest per-item
 *     outcome records, never invented success.
 *   - BATCH EXTRACTION: a batch run takes a bounded list (1-100) of
 *     reference citations + the extraction configuration; every item
 *     produces exactly ONE outcome record from the closed vocabulary
 *     (extracted / failed with its closed failure reason / skipped
 *     with its closed skip reason); the run is an append-oriented
 *     record whose summary counts are SQL-COMPUTED from the item
 *     outcome rows, never asserted separately (the CHECK fence pins
 *     the arithmetic).
 *   - FAILURE STATES: the closed failure vocabulary
 *     (media_unavailable, rights_not_permitted, unsupported_modality,
 *     extraction_error, encoder_unavailable, invalid_input,
 *     scope_mismatch — CHECK-fenced in migration 065) with the honest
 *     per-item error surface (bounded error_detail).
 *   - TENANT ISOLATION (§22): every bundle/run/outcome row is
 *     CLIENT-scoped (the hard security boundary — spec/
 *     architecture.md §4) with the optional workspace anchor, all
 *     cross-tenant reads resolve to the uniform NotFound (no
 *     existence oracle), and the cross-tenant scope-consistency
 *     triggers fence the module's own row references (bundle →
 *     creating run; item → run; item → bundle) at the DB.
 *
 * THE CORPUS ADVANCE SEAM (DISCLOSED, deliberately NOT implemented
 * here): the /lab-corpus reference's feature_bundle_version column
 * ('pending' → the LAB-003 bundle version) is the LAB-002 module's
 * OWN guarded seam. This module does NOT write any /lab-corpus
 * table; the bundles carry everything the later TL integration needs
 * to advance that column (the citable bundle reference
 * '<bundleId>#v<bundleVersion>' — the labFeaturesBundleReference
 * helper — plus the per-reference bundle chain read surface). The
 * advance path itself is the Tech Lead's composition decision at the
 * LAB-004/005 integration.
 *
 * What it is NOT (the bounded scope):
 *
 *   - NO corpus authority: references, observations and coverage
 *     reporting stay /lab-corpus's (LAB-002); this module CONSUMES
 *     citation data by reference only.
 *   - NO media retention: no media bytes, no byte column, no durable
 *     media cache — the ephemeral handle lives for the extraction
 *     call only (§4).
 *   - NO semantic invention: an unavailable feature is recorded
 *     unavailable with its closed reason — an encoder-grade value is
 *     NEVER fabricated by a deterministic stand-in.
 *   - NO shadowing: no Experiment/Decision/Evidence/Metric/
 *     Publication/Workflow/Execution record is created here; the FK
 *     anchors are exactly the tenant tables + same-module rows.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the
 * static architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { Db } from '../../platform/db/contract.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (CHECK-fenced in migration 065 — closed sets).
// ---------------------------------------------------------------------------

/** The contract vocabulary version of every feature-bundle artifact (the LAB-001 'lab-contract-v1' discipline). */
export const LAB_FEATURES_CONTRACT_VERSION = 'lab-features-contract-v1' as const;

/** The versioned feature-set definition (§5: "The exact feature set is versioned") — the first frozen set. */
export const LAB_FEATURE_SET_VERSION = 'lab-featureset-v1' as const;

/** The per-modality grouping vocabulary (§5: text/audio/visual/metadata representations). */
export const LAB_FEATURE_MODALITIES = ['text', 'audio', 'visual', 'metadata'] as const;
export type LabFeatureModality = (typeof LAB_FEATURE_MODALITIES)[number];

/**
 * THE CLOSED FEATURE-KEY VOCABULARY (§5 verbatim list, 27 keys) with
 * the per-modality grouping. The map is the frozen definition of the
 * feature set: every bundle accounts for EXACTLY these keys (the
 * migration-065 feature-accounting CHECK pins the 27), and the §5
 * source phrase is recorded per key for traceability.
 */
export const LAB_FEATURE_KEYS = {
  // --- visual ---
  visual_embedding: { modality: 'visual', source: 'raw/derived visual embeddings' },
  thumbnail_representation: { modality: 'visual', source: 'thumbnail representation' },
  opening_frame_representation: { modality: 'visual', source: 'opening-frame representation' },
  pacing: { modality: 'visual', source: 'pacing' },
  scene_transitions: { modality: 'visual', source: 'scene transitions' },
  visual_composition: { modality: 'visual', source: 'visual composition' },
  // --- audio ---
  audio_embedding: { modality: 'audio', source: 'audio embeddings' },
  speaking_rate: { modality: 'audio', source: 'speaking rate' },
  emotional_trajectory: { modality: 'audio', source: 'emotional trajectory' },
  // --- text ---
  text_embedding: { modality: 'text', source: 'transcript/text embeddings' },
  title_description_hashtag_semantics: { modality: 'text', source: 'title/description/hashtag semantics' },
  hook_structure: { modality: 'text', source: 'hook structure' },
  topic_subtopic_entity: { modality: 'text', source: 'topic/subtopic/entity' },
  problem_claim: { modality: 'text', source: 'problem/claim' },
  curiosity_gap: { modality: 'text', source: 'curiosity gap' },
  narrative_structure: { modality: 'text', source: 'narrative structure' },
  information_density: { modality: 'text', source: 'information density' },
  cta_structure: { modality: 'text', source: 'CTA structure' },
  language: { modality: 'text', source: 'language' },
  // --- metadata ---
  duration: { modality: 'metadata', source: 'duration' },
  engagement: { modality: 'metadata', source: 'engagement' },
  performance_velocity: { modality: 'metadata', source: 'performance velocity' },
  age_normalized_performance: { modality: 'metadata', source: 'age-normalized performance' },
  retention_impression_metrics: { modality: 'metadata', source: 'retention/impression metrics where available' },
  creator_baseline: { modality: 'metadata', source: 'creator baseline' },
  novelty_reuse_risk: { modality: 'metadata', source: 'novelty/reuse risk' },
  product_references: { modality: 'metadata', source: 'product references' },
} as const;

export type LabFeatureKey = keyof typeof LAB_FEATURE_KEYS;

/** The closed feature-key set (exactly 27 — the migration-065 accounting fence). */
export const LAB_FEATURE_KEY_LIST = Object.keys(LAB_FEATURE_KEYS) as ReadonlyArray<LabFeatureKey>;

/**
 * The closed feature-value state vocabulary: every feature value in
 * every bundle is either 'derived' (a concrete representation + its
 * encoder identity) or 'unavailable' (an explicit honest state + its
 * closed reason). The corpus-side 'pending' sentinel is the LAB-002
 * extraction column's own state — at the bundle level a value that
 * cannot be derived is recorded with its explicit unavailable state,
 * never an invented or deferred value (the brief's
 * unavailable/pending pair collapses to the single explicit
 * unavailable state in this feature-set version: bundles are written
 * only at extraction completion, so nothing is ever left implicitly
 * pending — DISCLOSED).
 */
export const LAB_FEATURE_VALUE_STATES = ['derived', 'unavailable'] as const;
export type LabFeatureValueState = (typeof LAB_FEATURE_VALUE_STATES)[number];

/**
 * The closed feature-unavailability reason vocabulary (the honest
 * per-feature states — enforced module-side over the features jsonb):
 *   - 'encoder_unavailable'        — the feature needs an encoder/model
 *                                    this extractor version does not wire;
 *   - 'absent_from_source'         — the recorded source (metadata
 *                                    snapshot / citation) carries no
 *                                    field the feature can derive from;
 *   - 'requires_media_access'      — the feature needs media bytes and
 *                                    no validated grant opened the path;
 *   - 'requires_observation_history' — the feature needs an observation
 *                                    time series a single cited snapshot
 *                                    cannot express;
 *   - 'requires_corpus_context'    — the feature needs corpus-wide
 *                                    context owned by the later Lab
 *                                    layers (the LAB-004 Idea Graph).
 */
export const LAB_FEATURE_UNAVAILABLE_REASONS = [
  'encoder_unavailable',
  'absent_from_source',
  'requires_media_access',
  'requires_observation_history',
  'requires_corpus_context',
] as const;
export type LabFeatureUnavailableReason = (typeof LAB_FEATURE_UNAVAILABLE_REASONS)[number];

/**
 * The closed per-item outcome vocabulary (batch extraction — every
 * item produces exactly ONE outcome): 'extracted' (a bundle version
 * was produced), 'failed' (its closed failure reason recorded) or
 * 'skipped' (its closed skip reason recorded).
 */
export const LAB_FEATURE_ITEM_OUTCOMES = ['extracted', 'failed', 'skipped'] as const;
export type LabFeatureItemOutcome = (typeof LAB_FEATURE_ITEM_OUTCOMES)[number];

/**
 * THE CLOSED FAILURE VOCABULARY (the LAB-003 acceptance — CHECK-fenced
 * in migration 065): why a batch item FAILED.
 *   - 'media_unavailable'     — a presented media grant failed the
 *                               availability gate (unknown /
 *                               provider_unavailable / withdrawn) or the
 *                               media port refused on availability;
 *   - 'rights_not_permitted'  — a presented media grant failed the
 *                               posture/rights gate (available_rights_
 *                               unclear, or a metadata_only posture) or
 *                               the media port refused on rights — the
 *                               §4 public-URL-grants-NOTHING rule, fail
 *                               closed BEFORE any bytes are requested;
 *   - 'unsupported_modality'  — the extraction configuration requires a
 *                               modality group the extractor does not
 *                               serve;
 *   - 'extraction_error'      — the extractor or media port errored
 *                               during extraction (never invented
 *                               success);
 *   - 'encoder_unavailable'   — the extractor reports the encoder
 *                               required by the requested feature
 *                               selection is not wired at all;
 *   - 'invalid_input'         — the citation itself is malformed (the
 *                               honest per-item shape gate);
 *   - 'scope_mismatch'        — the citation's recorded owning client
 *                               does not match the batch scope (the
 *                               recorded-data tenant fence).
 */
export const LAB_FEATURE_FAILURE_REASONS = [
  'media_unavailable',
  'rights_not_permitted',
  'unsupported_modality',
  'extraction_error',
  'encoder_unavailable',
  'invalid_input',
  'scope_mismatch',
] as const;
export type LabFeatureFailureReason = (typeof LAB_FEATURE_FAILURE_REASONS)[number];

/**
 * The closed skip vocabulary: why a batch item was SKIPPED (no new
 * bundle version produced): 'duplicate_citation_in_batch' — the same
 * reference is cited twice in ONE batch (the second occurrence is
 * skipped); 'already_extracted' — the deterministic identity already
 * exists (re-extraction under the SAME feature-set/extractor/input
 * version is idempotent — the outcome cites the existing bundle).
 */
export const LAB_FEATURE_SKIP_REASONS = ['duplicate_citation_in_batch', 'already_extracted'] as const;
export type LabFeatureSkipReason = (typeof LAB_FEATURE_SKIP_REASONS)[number];

/**
 * The closed media-availability echo vocabulary — the §4 /lab-corpus
 * closed set, recorded as DATA on every citation and bundle (the
 * availability state observed at extraction time; this module never
 * GRANTS anything by recording it).
 */
export const LAB_FEATURE_MEDIA_AVAILABILITIES = [
  'unknown',
  'available_permitted',
  'available_rights_unclear',
  'provider_unavailable',
  'withdrawn',
] as const;
export type LabFeatureMediaAvailability = (typeof LAB_FEATURE_MEDIA_AVAILABILITIES)[number];

/**
 * The closed media-access posture vocabulary (§4 "Provider adapters
 * MUST enforce provider-specific acquisition constraints" — the
 * corpus records the posture; the adapters enforce it): ONLY
 * 'reference_gated' may open a media path (paired with
 * 'available_permitted'); 'metadata_only' fails closed.
 */
export const LAB_FEATURE_MEDIA_ACCESS_POSTURES = ['metadata_only', 'reference_gated'] as const;
export type LabFeatureMediaAccessPosture = (typeof LAB_FEATURE_MEDIA_ACCESS_POSTURES)[number];

/** The closed media-fetch status vocabulary (the honest record of what happened at the replaceable port). */
export const LAB_FEATURE_MEDIA_FETCH_STATUSES = ['not_requested', 'pending', 'granted', 'refused'] as const;
export type LabFeatureMediaFetchStatus = (typeof LAB_FEATURE_MEDIA_FETCH_STATUSES)[number];

/** The batch run lifecycle: born 'running', the single guarded advance to 'completed'. */
export const LAB_FEATURE_RUN_STATUSES = ['running', 'completed'] as const;
export type LabFeatureRunStatus = (typeof LAB_FEATURE_RUN_STATUSES)[number];

/** The upper bound of items per batch (the bounded-list fence). */
export const LAB_FEATURES_BATCH_MAX_ITEMS = 100;

/** The upper bound of bundle versions per (client, reference) chain (the append-only correction chain fence). */
export const LAB_FEATURES_MAX_BUNDLE_VERSIONS = 1000;

/**
 * The citable opaque bundle reference — the string the TL's corpus
 * advance seam writes into /lab-corpus feature_bundle_version
 * ('<bundleId>#v<bundleVersion>' — the /lab-agent-body reference
 * discipline). This module PRODUCES the reference; the advance path
 * is the TL's composition decision (DISCLOSED — not implemented
 * here).
 */
export const LAB_FEATURES_BUNDLE_REFERENCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#v[1-9][0-9]{0,3}$/;

/** Builds the citable bundle reference for a bundle record. */
export function labFeaturesBundleReference(bundleId: string, bundleVersion: number): string {
  return `${bundleId}#v${bundleVersion}`;
}

// ---------------------------------------------------------------------------
// The source citation (the /lab-corpus by-reference discipline).
// ---------------------------------------------------------------------------

/**
 * A Content Reference citation: the FULL source-linkage data one
 * extraction consumes and every bundle records — OPAQUE recorded
 * data copied from the /lab-corpus reference record by the caller
 * (the corpus backfill driver reads the reference under its own
 * scope and hands the citation over; there is NO import of
 * /lab-corpus here and NO /lab-corpus table is ever read or written
 * by this module).
 */
export interface LabFeatureReferenceCitation {
  /** The opaque /lab-corpus reference id (recorded data — never joined). */
  referenceId: string;
  /** The owning client of the cited reference, AS RECORDED at corpus time (the recorded-data tenant fence: a mismatch is the honest scope_mismatch item failure). */
  clientId: string;
  /** The corpus binding (id + version) the reference was first recorded under (recorded data). */
  corpusId: string;
  corpusVersion: number;
  provider: string;
  providerContentId: string;
  canonicalUrl: string;
  /** The observation metadata digest the extraction runs against (the /lab-corpus §4 digest, recorded data). */
  metadataDigest: string;
  /** The metadata snapshot the features are derived from (bounded, the durable observation — NEVER media bytes). */
  metadataSnapshot: Readonly<Record<string, unknown>>;
  /** The media-availability state observed at extraction time (the closed vocabulary; recorded data — it never grants rights). */
  mediaAvailability: LabFeatureMediaAvailability;
}

/**
 * The OPTIONAL media-access grant object (§4): the caller's assertion
 * that the provider/rights-gated media path may be opened for this
 * extraction. Validated against the CLOSED vocabularies BEFORE any
 * bytes are requested: ONLY availability 'available_permitted' +
 * posture 'reference_gated' opens the path; every other pairing
 * fails closed (media_unavailable / rights_not_permitted per the
 * honest gate semantics). A public URL grants NOTHING — the grant is
 * the caller's provider/rights-gated path declaration, not a URL
 * inference.
 */
export interface LabFeatureMediaGrant {
  /** The observed availability state under which the grant is presented (the closed /lab-corpus vocabulary). */
  availability: LabFeatureMediaAvailability;
  /** The provider's media-access posture under the corpus acquisition policy (the closed vocabulary). */
  posture: LabFeatureMediaAccessPosture;
}

// ---------------------------------------------------------------------------
// The versioned feature values (§5) — the derived representations.
// ---------------------------------------------------------------------------

/** The encoder/model identity every derived feature value records (§5: "records encoder/model identity"). */
export interface LabFeatureEncoderIdentity {
  /** The encoder identity (e.g. 'lab-features-metadata' — a deterministic extractor, honestly labeled; or a real encoder's model identity). */
  encoderId: string;
  /** The encoder version. */
  encoderVersion: string;
}

/** One DERIVED feature value: a concrete representation + its encoder identity. */
export interface LabFeatureDerivedValue {
  state: 'derived';
  encoder: LabFeatureEncoderIdentity;
  /** The concrete derived representation (a bounded JSON value — deterministic extractors produce deterministic shapes). */
  value: unknown;
}

/** One UNAVAILABLE feature value: the explicit honest state + its closed reason (+ optional detail). */
export interface LabFeatureUnavailableValue {
  state: 'unavailable';
  reason: LabFeatureUnavailableReason;
  detail?: string | undefined;
}

export type LabFeatureValue = LabFeatureDerivedValue | LabFeatureUnavailableValue;

/** The per-key feature value map of one bundle (exactly the closed 27-key set). */
export type LabFeatureValueMap = Readonly<Record<LabFeatureKey, LabFeatureValue>>;

// ---------------------------------------------------------------------------
// The replaceable ports (the LAB-002 ingestion-seam precedent).
// ---------------------------------------------------------------------------

/**
 * The in-memory media handle (§4 the temporary-media-bytes rule):
 * when a validated grant opens the provider/rights-gated path and
 * the replaceable fetch port returns bytes, they ride THIS handle
 * through the extraction call ONLY — the module never persists them
 * (there is structurally no byte column anywhere in migration 065)
 * and discards the handle when the call returns.
 */
export interface LabMediaHandle {
  /** The granted byte length (derived access metadata — the only byte fact ever recorded). */
  byteLength: number;
  /** Reads the ephemeral bytes (in-memory; valid for the extraction call only). */
  readAll(): Uint8Array;
}

/** The media-fetch outcome at the replaceable port (the honest states). */
export type LabMediaFetchOutcome =
  | { status: 'pending'; detail: string }
  | { status: 'granted'; handle: LabMediaHandle }
  | { status: 'refused'; reason: 'media_unavailable' | 'rights_not_permitted'; detail: string };

/**
 * THE MEDIA-FETCH PORT (§4 "Media access is an adapter"): the
 * provider/rights-gated fetch boundary. The MODULE runs the grant
 * gate FIRST (fail closed before any bytes are requested); only a
 * validated grant reaches this port. The first-party implementation
 * ships the HONEST PENDING STATE (no provider adapter wired — the
 * real wiring arrives with the corpus backfills); test doubles and
 * the future provider adapters satisfy the same contract.
 */
export interface LabMediaFetchPort {
  fetchMedia(input: {
    citation: LabFeatureReferenceCitation;
    grant: LabFeatureMediaGrant;
  }): Promise<LabMediaFetchOutcome>;
}

/**
 * The extraction input handed to the extractor port: the citation,
 * the validated grant + the media-fetch outcome (with the in-memory
 * handle when bytes were granted — ephemeral, this call only), and
 * the extraction configuration.
 */
export interface LabFeatureExtractionInput {
  citation: LabFeatureReferenceCitation;
  /** Undefined when no grant was presented (metadata-only extraction). */
  grant: LabFeatureMediaGrant | undefined;
  /** Undefined when no grant was presented or the path was not opened. */
  mediaFetch: LabMediaFetchOutcome | undefined;
  configuration: LabFeatureExtractionConfiguration;
}

/**
 * The extractor's per-item result: the per-key value map (exactly the
 * closed 27-key set) + the honest media-path record (what the
 * extractor observed at the fetch port — recorded on the bundle).
 */
export interface LabFeatureExtractionResult {
  values: LabFeatureValueMap;
  mediaFetchStatus: LabFeatureMediaFetchStatus;
  mediaFetchDetail: string | undefined;
  mediaFetchBytes: number | undefined;
}

/** The extractor's terminal item failure (fail closed — never invented success). */
export interface LabFeatureExtractionFailure {
  reason: LabFeatureFailureReason;
  detail: string;
}

/**
 * THE EXTRACTION PORT (a replaceable, test-double-friendly contract —
 * the LAB-002 ingestion-seam precedent): one extraction of one cited
 * reference under the pinned feature-set version. The extractor
 * declares its identity (part of the deterministic bundle identity)
 * and the modality groups it serves (the unsupported_modality gate
 * input); the FIRST-PARTY implementation is honest about what it can
 * and cannot extract.
 */
export interface LabFeatureExtractor {
  readonly extractorId: string;
  readonly extractorVersion: string;
  /** The feature-set version this extractor serves (must equal the module's pinned version). */
  readonly featureSetVersion: string;
  /** The modality groups this extractor has derivation logic for (the requiredModalities gate). */
  readonly supportedModalities: ReadonlyArray<LabFeatureModality>;
  extract(input: LabFeatureExtractionInput): Promise<LabFeatureExtractionResult | LabFeatureExtractionFailure>;
}

// ---------------------------------------------------------------------------
// The batch extraction API shapes.
// ---------------------------------------------------------------------------

/**
 * The extraction configuration (versioned with the bundle identity):
 * the closed modality REQUIREMENT — when provided, a modality group
 * outside the extractor's supported set fails the item honestly
 * (unsupported_modality) BEFORE extraction; the default (no
 * requirement) proceeds with honest per-feature unavailable states.
 */
export interface LabFeatureExtractionConfiguration {
  requiredModalities?: ReadonlyArray<LabFeatureModality> | undefined;
}

/** One batch item: a reference citation + its OPTIONAL media-access grant. */
export interface LabFeatureBatchItem {
  citation: LabFeatureReferenceCitation;
  mediaGrant?: LabFeatureMediaGrant | undefined;
}

/** The batch extraction input: a bounded list (1-100) of citations + the configuration. */
export interface ExtractLabFeatureBatchInput {
  scope: LabFeaturesScope;
  items: ReadonlyArray<LabFeatureBatchItem>;
  configuration?: LabFeatureExtractionConfiguration | undefined;
}

// ---------------------------------------------------------------------------
// The records (the public read shapes).
// ---------------------------------------------------------------------------

/** A versioned FEATURE-BUNDLE record: one extraction of one content reference under one feature-set version. */
export interface LabFeatureBundleRecord {
  bundleId: string;
  /** The citable bundle reference ('<bundleId>#v<bundleVersion>' — the corpus advance seam input). */
  bundleReference: string;
  referenceId: string;
  bundleVersion: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  /** The creating batch run. */
  runId: string;
  // --- THE SOURCE LINKAGE (recorded citation data, never a join) ---
  corpusId: string;
  corpusVersion: number;
  provider: string;
  providerContentId: string;
  canonicalUrl: string;
  metadataDigest: string;
  mediaAvailabilityAtExtraction: LabFeatureMediaAvailability;
  grantPosture: LabFeatureMediaAccessPosture;
  // --- THE HONEST MEDIA-PATH RECORD (never the bytes) ---
  mediaFetchStatus: LabFeatureMediaFetchStatus;
  mediaFetchDetail: string | null;
  mediaFetchBytes: number | null;
  // --- THE VERSIONED FEATURE SET + EXTRACTOR IDENTITY ---
  featureSetVersion: string;
  extractorId: string;
  extractorVersion: string;
  /** THE DETERMINISTIC IDENTITY (the pure-function digest — same inputs, same identity, ever). */
  identityDigest: string;
  inputDigest: string;
  requiredModalities: ReadonlyArray<LabFeatureModality>;
  /** The per-key derived/unavailable values (exactly the closed 27-key set). */
  features: LabFeatureValueMap;
  derivedFeatureCount: number;
  unavailableFeatureCount: number;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

/** One append-only per-item outcome record (exactly one per batch item). */
export interface LabFeatureBatchItemRecord {
  itemId: string;
  runId: string;
  /** The bundle this item produced (null for failed items / bundle-less skips). */
  bundleId: string | null;
  agencyId: string;
  clientId: string;
  referenceId: string;
  provider: string;
  providerContentId: string;
  /** The item position in the batch (deterministic ordering). */
  seq: number;
  outcome: LabFeatureItemOutcome;
  failureReason: LabFeatureFailureReason | null;
  skipReason: LabFeatureSkipReason | null;
  errorDetail: string | null;
  identityDigest: string | null;
  contractVersion: string;
  createdAt: string;
}

/** The append-oriented batch extraction run record (summary counts SQL-computed from the item outcomes). */
export interface LabFeatureBatchRunRecord {
  runId: string;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  status: LabFeatureRunStatus;
  itemCount: number;
  extractorId: string;
  extractorVersion: string;
  featureSetVersion: string;
  requiredModalities: ReadonlyArray<LabFeatureModality>;
  extractedCount: number;
  failedCount: number;
  skippedCount: number;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
  /** The item outcome tail (carried on every read — the honest per-item surface). */
  items: ReadonlyArray<LabFeatureBatchItemRecord>;
}

// ---------------------------------------------------------------------------
// The module ports (deps) and public API.
// ---------------------------------------------------------------------------

/** Module dependencies (platform ports + the two replaceable Lab ports — the frozen /lab-features row consumes NO other module). */
export interface LabFeaturesModuleDeps {
  db: Db;
  clock: Clock;
  ids: IdGenerator;
  extractor: LabFeatureExtractor;
  mediaFetch: LabMediaFetchPort;
}

/** The scope every feature artifact is created/read under (the uniform NotFound for foreign/unknown scope — no existence oracle). */
export interface LabFeaturesScope {
  agencyId: string;
  clientId: string;
  workspaceId?: string | null;
}

/** The /lab-features module public API — the frozen surface consumed by LAB-004 (Idea Graph), LAB-005 (simulator) and the TL's corpus advance integration BY REFERENCE. */
export interface LabFeaturesModuleApi {
  /**
   * THE BATCH EXTRACTION ENTRY: a bounded list (1-100) of reference
   * citations + the extraction configuration. Every item produces
   * exactly ONE outcome record; the run's summary counts are
   * SQL-computed from the item outcomes. Returns the completed run
   * with its item tail (the bundles readable through getBundle /
   * listBundles).
   */
  extractBatch(input: ExtractLabFeatureBatchInput): Promise<LabFeatureBatchRunRecord>;

  /** Reads one batch run (with its item outcome tail) — the uniform NotFound for foreign/unknown scope. */
  getBatchRun(scope: LabFeaturesScope, runId: string): Promise<LabFeatureBatchRunRecord>;

  /** Lists the client's batch runs (newest first). */
  listBatchRuns(scope: LabFeaturesScope): Promise<ReadonlyArray<LabFeatureBatchRunRecord>>;

  /** Reads one feature bundle — the uniform NotFound for foreign/unknown scope. */
  getBundle(scope: LabFeaturesScope, bundleId: string): Promise<LabFeatureBundleRecord>;

  /**
   * Lists the bundles for one cited reference — THE CORPUS ADVANCE
   * SEAM READ (the per-reference append-only version chain, newest
   * version first; the TL's LAB-004/005 integration resolves the
   * bundle reference to write into /lab-corpus feature_bundle_version
   * through this surface — the advance itself is NOT implemented
   * here, by design).
   */
  listBundles(scope: LabFeaturesScope, referenceId: string): Promise<ReadonlyArray<LabFeatureBundleRecord>>;
}

export { createLabFeaturesModule } from './internal/features-module.ts';
export {
  createFirstPartyLabFeatureExtractor,
  /** The first-party deterministic encoder identities (honestly labeled — NOT embedding models). */
  FIRST_PARTY_EXTRACTOR_ID,
  FIRST_PARTY_EXTRACTOR_VERSION,
} from './internal/feature-extractor.ts';
export { createPendingLabMediaFetchPort } from './internal/media-fetch-port.ts';
/**
 * The pure contract guards (the feature-set discipline, the citation/
 * grant fences, the deterministic identity derivation, the batch
 * bounds) — exported for unit tests and the later Lab modules so the
 * CONTRACT semantics are part of the module surface. Pure functions:
 * no clock, no randomness, no network.
 */
export {
  assertValidLabFeatureCitation,
  assertValidLabFeatureMediaGrant,
  assertValidLabFeatureConfiguration,
  assertValidLabFeatureBatchInput,
  assertValidLabFeatureValueMap,
  computeLabFeatureInputDigest,
  computeLabFeatureIdentityDigest,
  labFeaturesCanonicalJson,
} from './internal/validation.ts';
