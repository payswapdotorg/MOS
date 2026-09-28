/**
 * MarketingOS module: /lab-corpus
 * Authority: Reference-First Niche Corpus (LAB-002 — spec/
 * effective-backlog-v1.7.md LAB-002: "Build provider-neutral niche
 * corpus ingestion using content references and metadata snapshots.
 * Acceptance: reference-first storage, provider-specific acquisition
 * policy, provenance, deduplication, observation timestamps, coverage
 * reporting, no unauthorized media retention."; dependencies satisfied:
 * LAB-001 (merged — the /lab contracts), MKT-062 (merged — /research),
 * MKT-056 (merged — the adapter framework); spec/
 * architecture-v1.7-marketing-lab.md §4 "Reference-first content
 * universe": "The durable canonical corpus representation is a Content
 * Reference plus extracted feature data, not a permanent media
 * archive. Content Reference contains, where available: provider;
 * provider_content_id; canonical URL; creator/account reference;
 * publication time; observation time; rights/acquisition basis;
 * collection method/version; metadata snapshot; metadata digest; media
 * availability state; feature bundle version. The system may retain
 * temporary media bytes only when the acquisition path and
 * rights/policy permit it. Provider adapters MUST enforce
 * provider-specific acquisition constraints. The Lab MUST NOT assume
 * that a public URL grants permission to download, cache, transform or
 * redistribute media."; §22 multi-tenancy ("Cross-tenant content may
 * not be silently incorporated into a tenant's proprietary search
 * space. Public observations may be referenced only through their
 * permitted acquisition/usage path."); EXECUTION-PLAN.md §11 media/
 * corpus policy ("Default durable corpus: reference + metadata +
 * provenance + feature bundle + observation history. Temporary media
 * only through provider/rights-gated acquisition. Record coverage,
 * freshness, duplication, accessibility and extraction success.");
 * spec/frozen-manifest-v1.7.json mediaPolicy ("referenceFirst": true,
 * "permanentMediaRetentionRequired": false,
 * "mediaAccessIsProviderAndRightsGated": true,
 * "publicUrlDoesNotGrantMediaRights": true); architecture-lock-v1.7
 * rules: Lab artifacts never shadow v1.6 authorities.
 *
 * THE CORPUS LAYER (LAB-002's frozen scope — the features (LAB-003),
 * the Idea Graph (LAB-004) and the simulator (LAB-005) consume this
 * corpus BY REFERENCE through the public surface; none of their logic
 * lives here):
 *
 *   - THE VERSIONED CORPUS: a niche/platform corpus is a versioned,
 *     CLIENT-SCOPED collection (draft → active → retired; corrections
 *     are NEW version rows, never in-place rewrites — the LAB-001
 *     scenario discipline). A /lab scenario cites a corpus through the
 *     OPAQUE corpusVersion string recorded in its binding (LAB-001
 *     public.ts LabScenarioBinding.corpusVersion — 'pending' before
 *     the corpus exists): NO import of /lab exists here and NO /lab
 *     table is written — the citation is data, exactly the by-reference
 *     discipline the /lab header prescribes.
 *   - THE CONTENT REFERENCE (§4 verbatim field set): every observed
 *     content item is a REFERENCE row — provider, provider_content_id,
 *     canonical URL, creator/account reference, publication time,
 *     observation time, rights/acquisition basis, collection method/
 *     version, metadata snapshot, metadata digest, media availability
 *     state, feature bundle version ('pending' until LAB-003 extracts
 *     — the extraction-success dimension of coverage reporting).
 *   - THE DEDUPLICATION FENCE: one reference per (client, provider,
 *     provider_content_id) — the UNIQUE backstop in migration 061;
 *     re-ingestion of the same provider content is an APPENDED
 *     OBSERVATION on the existing reference (never a second row), and
 *     cross-provider duplication is REPORTED through metadata-digest
 *     collision groups in the coverage report (measured, never
 *     assumed).
 *   - THE OBSERVATION HISTORY (observation timestamps — §4): every
 *     sighting of the same content appends an immutable observation
 *     row (observed_at + collection method/version + metadata digest +
 *     media availability); the reference's current media availability
 *     advances under the guarded UPDATE trigger (identity immutable),
 *     so the LATEST state is on the reference and the FULL history is
 *     the append-only tail.
 *   - THE PROVIDER-SPECIFIC ACQUISITION POLICY (acceptance verbatim):
 *     each corpus version carries the provider policy map (permitted
 *     rights bases + the media-access posture) and the ingestion gate
 *     REFUSES a reference whose declared rights basis is not permitted
 *     for its provider under the corpus's CURRENT policy version —
 *     policy is enforced at ingestion, not retroactively.
 *   - NO UNAUTHORIZED MEDIA RETENTION (§4 structural): this module
 *     stores NO media bytes ANYWHERE — migration 061 deliberately has
 *     NO bytea/binary column and NO URL-fetched payload column; the
 *     media access path is provider/rights gated downstream (the
 *     provider adapters own the fetching under their declared
 *     constraints — Reference → permitted media access → decode/
 *     stream → feature extraction → feature bundle, §4). A public URL
 *     grants NOTHING here: it is recorded as reference data only.
 *
 * Tenant scope: every corpus/reference/observation row is CLIENT-scoped
 * (the hard security boundary — spec/architecture.md §4) with an
 * optional workspace anchor, exactly the /lab house pattern. All
 * cross-tenant reads resolve to the uniform NotFound (no existence
 * oracle). References are append-only with the current-availability
 * exception (guarded); observations are append-only outright (UPDATE
 * and DELETE rejected by migration-061 triggers).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { Db } from '../../platform/db/contract.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (CHECK-fenced in migration 061 — closed sets).
// ---------------------------------------------------------------------------

/** The contract vocabulary version of every corpus artifact (LAB-002 acceptance: versioned contracts). */
export const LAB_CORPUS_CONTRACT_VERSION = 'lab-corpus-contract-v1' as const;

/** The corpus acquisition-policy vocabulary version. */
export const LAB_CORPUS_POLICY_VERSION = 'lab-corpus-policy-v1' as const;

/**
 * The closed corpus lifecycle (the LAB-001 scenario discipline): a
 * corpus is DRAFT while being composed and ingested, ACTIVE once
 * frozen for scenario binding, RETIRED once deprecated (existing
 * references keep their recorded corpus version; new ingestion is
 * refused). Corrections to an ACTIVE corpus are NEW versions, never
 * in-place rewrites.
 */
export const LAB_CORPUS_STATUSES = ['draft', 'active', 'retired'] as const;
export type LabCorpusStatus = (typeof LAB_CORPUS_STATUSES)[number];

/**
 * The closed rights/acquisition-basis vocabulary (§4 "rights/
 * acquisition basis" — the DECLARED basis under which a content
 * reference was observed; the provider policy map fences which bases
 * are permitted per provider). 'public_reference' is metadata-only
 * observation of a public item (NO media rights implied);
 * 'provider_api_terms' is observation under the provider's API terms;
 * 'explicit_license' is a recorded license; 'creator_grant' is a
 * direct creator permission.
 */
export const LAB_CORPUS_RIGHTS_BASES = [
  'public_reference',
  'provider_api_terms',
  'explicit_license',
  'creator_grant',
] as const;
export type LabCorpusRightsBasis = (typeof LAB_CORPUS_RIGHTS_BASES)[number];

/**
 * The closed media-availability vocabulary (§4 "media availability
 * state"). 'unknown' is the honest default before any availability
 * observation; 'available_permitted' means the provider reports the
 * media available AND the declared basis permits gated access (the
 * ONLY state downstream media access may proceed from — and even then
 * only through the provider adapter's own constraints);
 * 'available_rights_unclear' means available but the basis does not
 * clearly permit access (fails closed downstream);
 * 'provider_unavailable' and 'withdrawn' are the provider-side
 * negatives. This column RECORDS state; it never GRANTS rights.
 */
export const LAB_CORPUS_MEDIA_AVAILABILITIES = [
  'unknown',
  'available_permitted',
  'available_rights_unclear',
  'provider_unavailable',
  'withdrawn',
] as const;
export type LabCorpusMediaAvailability = (typeof LAB_CORPUS_MEDIA_AVAILABILITIES)[number];

/**
 * The closed media-access posture per provider (§4 "Provider adapters
 * MUST enforce provider-specific acquisition constraints" — the corpus
 * records the posture; the adapters enforce it):
 * 'metadata_only' — NO media access path exists for this provider
 * under this corpus (reference + metadata only);
 * 'reference_gated' — media access is permitted ONLY through the
 * provider/rights-gated adapter path (never a durable copy here).
 */
export const LAB_CORPUS_MEDIA_ACCESS_POSTURES = ['metadata_only', 'reference_gated'] as const;
export type LabCorpusMediaAccessPosture = (typeof LAB_CORPUS_MEDIA_ACCESS_POSTURES)[number];

/**
 * The feature-bundle sentinel recorded on every reference until
 * LAB-003 (Multimodal Content Feature Bundle) extracts features
 * (§5: "Feature extraction should persist useful derived
 * representations so repeated simulation does not require repeated
 * media access") — the pending/extracted pair IS the extraction-
 * success dimension of coverage reporting.
 */
export const LAB_CORPUS_FEATURE_BUNDLE_PENDING = 'pending' as const;

/** The upper bound of corpus versions per corpus (the append-only correction chain fence). */
export const LAB_CORPUS_MAX_VERSIONS = 1000;

/** The SHA-256 metadata digest length (hex characters). */
export const LAB_CORPUS_METADATA_DIGEST_LENGTH = 64;

// ---------------------------------------------------------------------------
// The provider-specific acquisition policy (per corpus version).
// ---------------------------------------------------------------------------

/**
 * The per-provider acquisition policy entry (§4): which rights bases
 * are permitted for the provider, and the media-access posture. The
 * ingestion gate refuses references whose declared basis is not in the
 * provider's permitted set (enforced at registerReference time against
 * the corpus's CURRENT policy version — the CHECK-fenced data backstop
 * is the rights_basis vocabulary; the cross-field policy gate is the
 * module's honest error surface).
 */
export interface LabCorpusProviderPolicy {
  /** The permitted rights bases under which this provider's content may be referenced (non-empty). */
  permittedBases: ReadonlyArray<LabCorpusRightsBasis>;
  /** The media-access posture (metadata_only or reference_gated — never a durable-media grant). */
  mediaAccess: LabCorpusMediaAccessPosture;
}

/** The corpus-wide acquisition policy map (versioned with the corpus). */
export interface LabCorpusAcquisitionPolicy {
  /** The policy vocabulary version (pinned 'lab-corpus-policy-v1'). */
  version: string;
  /** The per-provider policy map (provider → policy; ≥ 1 entry). */
  providers: Readonly<Record<string, LabCorpusProviderPolicy>>;
}

// ---------------------------------------------------------------------------
// The Content Reference (§4 verbatim field set).
// ---------------------------------------------------------------------------

/**
 * A Content Reference: the durable, reference-first record of one
 * observed content item (§4). NO media bytes ever ride this record —
 * the media path is provider/rights gated downstream (the adapter
 * chain Reference → permitted media access → decode/stream → feature
 * extraction → feature bundle).
 */
export interface LabCorpusReferenceRecord {
  referenceId: string;
  /** The corpus (id + version) the reference was FIRST recorded under (immutable binding). */
  corpusId: string;
  corpusVersion: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  provider: string;
  providerContentId: string;
  canonicalUrl: string;
  /** The creator/account reference (opaque provider handle; null when unavailable — §4 "where available"). */
  creatorRef: string | null;
  /** The content publication time (ISO 8601 UTC; null when unavailable). */
  publicationTime: string | null;
  /** The FIRST observation time (ISO 8601 UTC). */
  observationTime: string;
  /** The declared rights/acquisition basis (closed vocabulary; fenced by the corpus provider policy). */
  rightsBasis: LabCorpusRightsBasis;
  /** The collection method identity (opaque, versioned data — provenance). */
  collectionMethod: string;
  /** The collection method version (opaque, versioned data — provenance). */
  collectionVersion: string;
  /** The metadata snapshot (bounded jsonb — the durable observation, NOT the media). */
  metadataSnapshot: Readonly<Record<string, unknown>>;
  /** The metadata digest (lowercase hex SHA-256 of the canonical metadata snapshot serialization). */
  metadataDigest: string;
  /** The CURRENT media availability state (closed vocabulary; advances only through appended observations). */
  mediaAvailability: LabCorpusMediaAvailability;
  /** The feature bundle version ('pending' until LAB-003 extracts; then the opaque LAB-003 version). */
  featureBundleVersion: string;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

/** One appended observation of an existing reference (the observation-timestamp tail — §4). */
export interface LabCorpusObservationRecord {
  observationId: string;
  referenceId: string;
  agencyId: string;
  clientId: string;
  observedAt: string;
  collectionMethod: string;
  collectionVersion: string;
  metadataDigest: string;
  mediaAvailability: LabCorpusMediaAvailability;
  contractVersion: string;
}

// ---------------------------------------------------------------------------
// The versioned corpus.
// ---------------------------------------------------------------------------

/** A Lab Corpus: the versioned niche/platform collection definition (the LAB-001 scenario discipline). */
export interface LabCorpusRecord {
  corpusId: string;
  corpusVersion: number;
  agencyId: string;
  clientId: string;
  workspaceId: string | null;
  status: LabCorpusStatus;
  /** The niche declaration (free-form, versioned with the corpus — mirrors the /lab scenario binding). */
  niche: string;
  /** The platform declaration (recorded as declared data; the closed platform vocabulary is resolved downstream). */
  platform: string;
  /** The provider-specific acquisition policy map (versioned with the corpus). */
  acquisitionPolicy: LabCorpusAcquisitionPolicy;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Coverage reporting (EXECUTION-PLAN §11: coverage, freshness,
// duplication, accessibility, extraction success — measured, never assumed).
// ---------------------------------------------------------------------------

/**
 * The coverage report of one corpus (computed over ALL versions of the
 * corpus id — the content universe accumulates; corrections are policy/
 * niche versions, not content rewrites):
 *   - coverage: totalReferences + byProvider;
 *   - freshness: oldest/newest observation timestamps + totalObservations;
 *   - duplication: digestCollisionGroups (cross-provider duplicate
 *     groups measured by metadata-digest equality — the within-provider
 *     duplicate is impossible by the dedup fence);
 *   - accessibility: byMediaAvailability;
 *   - extraction success: extractedReferences vs pendingExtractionReferences.
 */
export interface LabCorpusCoverageReport {
  corpusId: string;
  /** The corpus version the report was computed against (the newest version at computation time). */
  corpusVersion: number;
  computedAt: string;
  totalReferences: number;
  byProvider: Readonly<Record<string, number>>;
  byMediaAvailability: Readonly<Record<string, number>>;
  extractedReferences: number;
  pendingExtractionReferences: number;
  digestCollisionGroups: number;
  totalObservations: number;
  oldestObservationAt: string | null;
  newestObservationAt: string | null;
}

// ---------------------------------------------------------------------------
// The module ports (deps) and public API.
// ---------------------------------------------------------------------------

/** Module dependencies (platform ports only — the frozen row consumes NO v1.6 authority module, the /lab precedent). */
export interface LabCorpusModuleDeps {
  db: Db;
  clock: Clock;
  ids: IdGenerator;
}

/** The scope every corpus artifact is created/read under (the uniform NotFound for foreign scope — no existence oracle). */
export interface LabCorpusScope {
  agencyId: string;
  clientId: string;
  workspaceId?: string | null;
}

/** Corpus creation input (the version-1 record; the module assigns ids/versions/timestamps). */
export interface CreateLabCorpusInput {
  scope: LabCorpusScope;
  niche: string;
  platform: string;
  acquisitionPolicy: LabCorpusAcquisitionPolicy;
}

/**
 * The provider-neutral ingestion input (§4 verbatim Content Reference
 * field set — the adapters deliver this data; the corpus never calls a
 * provider). registerReference is IDEMPOTENT per (client, provider,
 * provider_content_id): re-ingestion appends an observation to the
 * EXISTING reference and returns it (the dedup fence).
 */
export interface RegisterLabCorpusReferenceInput {
  scope: LabCorpusScope;
  corpusId: string;
  provider: string;
  providerContentId: string;
  canonicalUrl: string;
  creatorRef?: string | null;
  publicationTime?: string | null;
  rightsBasis: LabCorpusRightsBasis;
  collectionMethod: string;
  collectionVersion: string;
  metadataSnapshot: Readonly<Record<string, unknown>>;
  metadataDigest: string;
  /** The availability observed at ingestion (defaults 'unknown'). */
  mediaAvailability?: LabCorpusMediaAvailability;
}

/** Observation append input (an observation of a content item already referenced). */
export interface RecordLabCorpusObservationInput {
  scope: LabCorpusScope;
  referenceId: string;
  observedAt?: string;
  collectionMethod: string;
  collectionVersion: string;
  metadataDigest: string;
  mediaAvailability: LabCorpusMediaAvailability;
}

/** The /lab-corpus module public API — the frozen surface consumed by LAB-003 (features), LAB-004 (Idea Graph) and LAB-005 (simulator) BY REFERENCE. */
export interface LabCorpusModuleApi {
  // --- Corpus lifecycle (the versioned collection) ---
  createCorpus(input: CreateLabCorpusInput): Promise<LabCorpusRecord>;
  getCorpus(scope: LabCorpusScope, corpusId: string): Promise<LabCorpusRecord>;
  listCorpora(scope: LabCorpusScope): Promise<ReadonlyArray<LabCorpusRecord>>;
  /** Activates a DRAFT corpus (the scenario-binding gate). */
  activateCorpus(scope: LabCorpusScope, corpusId: string): Promise<LabCorpusRecord>;
  /** Retires an ACTIVE corpus (new ingestion refused; existing references keep their recorded version). */
  retireCorpus(scope: LabCorpusScope, corpusId: string): Promise<LabCorpusRecord>;
  /** Appends a corrected corpus version (the append-only correction path — returns the NEW version record). */
  correctCorpus(
    scope: LabCorpusScope,
    corpusId: string,
    correction: { niche?: string; platform?: string; acquisitionPolicy?: LabCorpusAcquisitionPolicy },
  ): Promise<LabCorpusRecord>;

  // --- Provider-neutral ingestion (the dedup fence + the policy gate) ---
  registerReference(input: RegisterLabCorpusReferenceInput): Promise<LabCorpusReferenceRecord>;
  getReference(scope: LabCorpusScope, referenceId: string): Promise<LabCorpusReferenceRecord>;
  listReferences(scope: LabCorpusScope, corpusId?: string, provider?: string): Promise<ReadonlyArray<LabCorpusReferenceRecord>>;

  // --- Observation history (observation timestamps — §4) ---
  recordObservation(input: RecordLabCorpusObservationInput): Promise<LabCorpusObservationRecord>;
  listObservations(scope: LabCorpusScope, referenceId: string): Promise<ReadonlyArray<LabCorpusObservationRecord>>;

  // --- Coverage reporting (§11: coverage/freshness/duplication/accessibility/extraction) ---
  coverageReport(scope: LabCorpusScope, corpusId: string): Promise<LabCorpusCoverageReport>;
}

export { createLabCorpusModule } from './internal/corpus-module.ts';
/**
 * The pure contract guards (acquisition-policy discipline, reference
 * field fences, observation fences, digest shape) — exported for unit
 * tests and the later Lab modules so the CONTRACT semantics are part
 * of the module surface. Pure functions: no clock, no randomness, no
 * network.
 */
export {
  assertValidLabCorpusAcquisitionPolicy,
  assertValidLabCorpusReferenceInput,
  assertValidLabCorpusObservationInput,
} from './internal/validation.ts';
