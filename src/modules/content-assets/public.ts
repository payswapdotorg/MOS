/**
 * MarketingOS module: /content-assets
 * Authority: Content Asset and Transformation Authority (MKT-064 —
 * spec/effective-backlog-v1.6.md: "versioned content assets plus
 * first-party/extension transformation execution contracts. Acceptance:
 * crop/reframe/padding/compilation/clip/caption/voice/translation/format
 * transformations retain lineage and quality observations";
 * spec/architecture-v1.6.md §10 "Transformation system": "A Content
 * Asset is an immutable versioned artifact with lineage. Transformations
 * are capabilities, not a hardcoded provider list. First-party and
 * extension implementations may provide crop/reframe, aspect-ratio
 * adaptation, padding/side-by-side or top/bottom composition, clipping,
 * compilations, sequencing, captions/subtitles, voice-over, translation/
 * dubbing, audio cleanup, background treatment, scene selection,
 * thumbnail generation, metadata rewriting and format/compression
 * optimization. Each transformation declares expected effects and
 * constraints. ... Content added as padding or compilation material is
 * itself subject to rights and provenance gates"; spec/
 * architecture-lock-v1.6.md rules 23 ("Every derived content artifact
 * retains ingredient and transformation lineage") and 24 ("Transformation
 * engines are replaceable first-party capabilities or Extensions/Apps
 * and must not become alternate MOS authorities"); spec/
 * module-dependency-matrix-v1.6.md boundary rule 5: "Content Assets
 * stores/derives artifact lineage but cannot become a rights authority").
 *
 * This module owns:
 *
 *   - the CLIENT-SCOPED durable ASSET IDENTITIES + their IMMUTABLE
 *     VERSIONED ARTIFACT RECORDS (migration 053): the version discipline
 *     (explicit versions, no floating pointers — a correction is a NEW
 *     version, which is a NEW reference), each version carrying the
 *     OPAQUE content-asset REFERENCE minted from the canonical version
 *     id ('ca:' + uuid — the MKT-063 seam target; /content-rights speaks
 *     this exact grammar), media/kind metadata, the CONTENT-ADDRESSED
 *     object-storage reference (the MKT-001 ObjectStore port — key =
 *     sha256 digest, set exactly for materialized/derived versions), the
 *     /evidence-anchored SOURCE PROVENANCE (required for source versions;
 *     a derived version's provenance IS the recorded transformation —
 *     the migration-053 provenance-shape CHECK), and the CHECK-fenced
 *     lifecycle state (draft → materialized; derived is the BIRTH state
 *     of transformation outputs — outputs are born WITH their objects
 *     and their lineage, an existing version can never be mutated into
 *     an output);
 *   - the APPEND-ONLY QUALITY OBSERVATIONS: measurable facts only
 *     (duration, dimensions, bitrate, caption coverage, language, frame
 *     rate, sample rate, byte size — the frozen ca-vocab-v1 metric
 *     vocabulary, closed so a fabricated 'score' cannot even be
 *     expressed; a re-measurement is a NEW observation row, never an
 *     in-place rewrite);
 *   - the RECORDED TRANSFORMATION REQUESTS + their IMMUTABLE INGREDIENT
 *     LINKS (input versions resolved and FROZEN at request time — the
 *     explicit-version discipline), with the transformation EXECUTION
 *     flowing through the EXISTING /executions authority
 *     (createExecution + transitionExecution through the public
 *     contract — NO second execution engine here, the MKT-054 cardinal
 *     rule) and the ENGINE as a replaceable CAPABILITY behind the
 *     TransformationEngine port (first-party engines or Extension/App
 *     engines registered as module DATA at the composition root — EMPTY
 *     in production by default, the MKT-056 discipline);
 *   - the DERIVATION SEAM COMPLETION: when a transformation completes,
 *     the output version is BORN 'derived' WITH lineage — the
 *     transformation record links input versions → output version
 *     immutably, and the module records the /content-rights INGREDIENT
 *     LINEAGE LINKS (composite ref → each ingredient ref) through the
 *     063 public contract (recordLineageLink — the conjunction
 *     semantics of the 063 gate resolve a composite's rights through
 *     exactly these links). Transformations NEVER mutate rights: the
 *     063 gate remains the SOLE rights authority (an asset whose
 *     ingredients are rights-blocked can still be TRANSFORMED here, but
 *     can never pass the publication gate — this module duplicates NO
 *     rights check and bypasses NO rights check, boundary rule 5).
 *
 * The /evidence SOURCE-PROVENANCE anchor: /evidence is NOT a frozen
 * allowance of this module's matrix row (/content-assets ──→ /executions,
 * /object-storage, /content-rights — spec/module-dependency-matrix-v1.6.md),
 * so the anchor rides as the ID-BASED reference seam (the /app-metering
 * precedent): the FK + same-Client migration-023/051-style triggers are
 * the database backstop (cross-tenant evidence linkage is rejected by
 * the database itself), the ROUTE layer resolves the evidence canonically
 * BEFORE any write (uniform NotFoundError for unknown/foreign — no
 * cross-tenant oracle), and the module surface surfaces the DB
 * backstop's rejection as the same honest NotFoundError for module-level
 * callers. /object-storage is the PLATFORM port direction of the frozen
 * row (the MKT-001 ObjectStore contract — a platform import carries no
 * matrix weight; the fs impl is retained for tests, the memory impl for
 * unit doubles).
 */

// ---------------------------------------------------------------------------
// Imports (the frozen-matrix surface)
// ---------------------------------------------------------------------------

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { ObjectStore } from '../../platform/objects/contract.ts';
import type { ExecutionsModuleApi } from '../executions/public.ts';
import type {
  ContentAssetReferencePort,
  ContentRightsModuleApi,
} from '../content-rights/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (ca-vocab-v1)
// ---------------------------------------------------------------------------

/**
 * The TRANSFORMATION KIND family — the MKT-064 acceptance list VERBATIM
 * (spec/effective-backlog-v1.6.md): crop / reframe / padding /
 * compilation / clip / caption / voice / translation / format. The
 * richer architecture-v1.6.md §10 capability catalogue (aspect-ratio
 * adaptation, sequencing, audio cleanup, background treatment, scene
 * selection, thumbnail generation, metadata rewriting, compression
 * optimization) maps onto these nine frozen kinds as engine-declared
 * effects/parameters — the FAMILY is the frozen authority, the catalogue
 * is its documentation.
 */
export type TransformationKind =
  | 'crop'
  | 'reframe'
  | 'padding'
  | 'compilation'
  | 'clip'
  | 'caption'
  | 'voice'
  | 'translation'
  | 'format';

export const TRANSFORMATION_KINDS: readonly TransformationKind[] = [
  'crop',
  'reframe',
  'padding',
  'compilation',
  'clip',
  'caption',
  'voice',
  'translation',
  'format',
];

/** The frozen media-kind vocabulary (the artifact's media class). */
export type ContentMediaKind = 'video' | 'audio' | 'image' | 'text' | 'document';

export const CONTENT_MEDIA_KINDS: readonly ContentMediaKind[] = [
  'video',
  'audio',
  'image',
  'text',
  'document',
];

/**
 * The frozen asset LIFECYCLE vocabulary:
 *   - `draft`        — born state of source registrations (metadata +
 *                      provenance recorded, NO object yet);
 *   - `materialized` — an object EXISTS at the content-addressed key
 *                      (reached via the single sanctioned state move
 *                      draft → materialized);
 *   - `derived`      — the BIRTH state of transformation outputs (born
 *                      WITH the object and the lineage — an existing
 *                      version can never BECOME an output; outputs are
 *                      NEW versions, immutable at birth).
 */
export type ContentAssetLifecycleState = 'draft' | 'materialized' | 'derived';

export const CONTENT_ASSET_LIFECYCLE_STATES: readonly ContentAssetLifecycleState[] = [
  'draft',
  'materialized',
  'derived',
];

/** The frozen lifecycle-event vocabulary (the append-only tail kinds). */
export type ContentAssetLifecycleEventKind =
  | 'registration'
  | 'materialization'
  | 'derivation';

export const CONTENT_ASSET_LIFECYCLE_EVENT_KINDS: readonly ContentAssetLifecycleEventKind[] = [
  'registration',
  'materialization',
  'derivation',
];

/** The frozen transformation-status vocabulary (the record's own lifecycle). */
export type ContentTransformationStatus = 'requested' | 'completed' | 'failed';

export const CONTENT_TRANSFORMATION_STATUSES: readonly ContentTransformationStatus[] = [
  'requested',
  'completed',
  'failed',
];

/**
 * The frozen QUALITY-METRIC vocabulary — the transformation family's
 * measurable facts (duration, dimensions, bitrate, caption coverage,
 * language, frame rate, sample rate, byte size). CLOSED by design:
 * OBSERVATIONS only, never fabricated scores — a 'score' metric cannot
 * even be expressed through this vocabulary.
 */
export type ContentQualityMetric =
  | 'duration_ms'
  | 'width_px'
  | 'height_px'
  | 'bitrate_kbps'
  | 'caption_coverage_ratio'
  | 'language'
  | 'fps'
  | 'sample_rate_hz'
  | 'byte_size';

export const CONTENT_QUALITY_METRICS: readonly ContentQualityMetric[] = [
  'duration_ms',
  'width_px',
  'height_px',
  'bitrate_kbps',
  'caption_coverage_ratio',
  'language',
  'fps',
  'sample_rate_hz',
  'byte_size',
];

/** The vocabulary version tag (mirrors the cr-vocab-v1 discipline). */
export const CONTENT_ASSETS_VOCABULARY_VERSION = 'ca-vocab-v1';

/** The maximum number of ingredients one transformation may declare. */
export const MAX_TRANSFORMATION_INGREDIENTS = 16;

// ---------------------------------------------------------------------------
// Provenance (the server-derived discipline)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance carried on every content-assets write (never
 * request fields — the route layer derives actor/via/correlation from
 * the authenticated principal and the ambient correlation context).
 */
export interface ContentAssetsProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** The provenance shape as recorded durably (recordedAt server-derived). */
export interface ContentAssetsRecordedProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The content-asset reference grammar (the MKT-063 seam completion)
// ---------------------------------------------------------------------------

/**
 * The OPAQUE CONTENT-ASSET REFERENCE grammar — the MKT-063 seam, now
 * OWNED by real records: every version record mints its ref from its
 * canonical id ('ca:' + the version uuid). The minting/parsing pair is
 * the interop contract: /content-rights carries these refs as opaque
 * grammar-fenced data (migration 051); this module is the mint authority
 * and the resolution target.
 */
export const CONTENT_ASSET_REF_PATTERN =
  /^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Mints one opaque content-asset ref from a canonical version id. */
export function mintContentAssetRef(versionId: string): string {
  return `ca:${versionId}`;
}

/**
 * Parses one opaque content-asset ref back to the canonical version id
 * (null when the ref is not of the minted grammar — an opaque foreign
 * ref is not this module's concern and is never an error).
 */
export function parseContentAssetRef(assetRef: string): string | null {
  const match = CONTENT_ASSET_REF_PATTERN.exec(assetRef);
  return match === null ? null : assetRef.slice('ca:'.length);
}

// ---------------------------------------------------------------------------
// The durable record shapes
// ---------------------------------------------------------------------------

/**
 * Immutable storage shape of one logical ASSET identity — the stable
 * handle the version records hang off. Owns NO artifact bytes and NO
 * metadata (the version records own those); the identity exists so the
 * per-asset version sequence has a fence (explicit versions, no floating
 * pointers).
 */
export interface ContentAssetIdentityRecord {
  readonly assetId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly provenance: ContentAssetsRecordedProvenance;
}

/**
 * Immutable storage shape of one persisted CONTENT ASSET VERSION — the
 * versioned artifact record. Identity, scope, ref, media/kind metadata
 * and provenance are IMMUTABLE (DB-backstopped); the ONLY sanctioned
 * mutation is the lifecycle state move draft → materialized (setting the
 * object reference trio and advancing the CAS version in the same
 * statement); DELETE is rejected outright — a correction is a NEW
 * version, which is a NEW reference.
 */
export interface ContentAssetVersionRecord {
  readonly versionId: string;
  readonly assetId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The explicit version number (one-based, monotonic per asset). */
  readonly version: number;
  /** The OPAQUE content-asset reference (the MKT-063 seam target). */
  readonly assetRef: string;
  readonly mediaKind: ContentMediaKind;
  readonly displayName: string;
  readonly contentType: string;
  readonly lifecycleState: ContentAssetLifecycleState;
  /** The content-addressed object-storage key (null exactly for drafts). */
  readonly objectKey: string | null;
  readonly objectDigest: string | null;
  readonly objectSize: number | null;
  /**
   * The /evidence-anchored SOURCE PROVENANCE — required for source
   * versions (draft/materialized); null for derived versions (the
   * recorded transformation IS a derived version's provenance — the
   * migration-053 provenance-shape CHECK).
   */
  readonly sourceEvidenceRef: string | null;
  readonly provenance: ContentAssetsRecordedProvenance;
  readonly versionCas: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One append-only lifecycle event (the 063 event-tail discipline). */
export interface ContentAssetLifecycleEventRecord {
  readonly eventId: string;
  readonly versionId: string;
  readonly eventKind: ContentAssetLifecycleEventKind;
  readonly fromState: ContentAssetLifecycleState | null;
  readonly toState: ContentAssetLifecycleState;
  readonly reason: string;
  readonly provenance: ContentAssetsRecordedProvenance;
}

/** One append-only QUALITY OBSERVATION (a measured fact, never a score). */
export interface ContentQualityObservationRecord {
  readonly observationId: string;
  readonly versionId: string;
  readonly metric: ContentQualityMetric;
  readonly metricValueNumeric: number | null;
  readonly metricValueText: string | null;
  readonly observedAt: string;
  readonly provenance: ContentAssetsRecordedProvenance;
}

/** The resolved ingredient of one transformation (the frozen input link). */
export interface ContentTransformationIngredientRecord {
  readonly ingredientId: string;
  readonly transformationId: string;
  readonly inputVersionId: string;
  /** The input version's opaque ref, frozen at request time. */
  readonly inputAssetRef: string;
  readonly inputVersionNumber: number;
  readonly position: number;
  readonly provenance: ContentAssetsRecordedProvenance;
}

/**
 * Immutable storage shape of one persisted TRANSFORMATION record: the
 * kind (the frozen family), the per-kind parameters + output spec
 * (bounded JSON objects), the resolved ENGINE identity (frozen at
 * request time — the registry is module DATA, empty in production by
 * default), the EXECUTION reference (the work flows through the
 * EXISTING /executions authority — no second engine here) and the
 * output version link set ONCE at completion. The requested →
 * completed/failed moves are the ONLY sanctioned updates (CAS-guarded);
 * kind, parameters, output spec, engine and ingredients are immutable
 * forever.
 */
export interface ContentTransformationRecord {
  readonly transformationId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly transformationKind: TransformationKind;
  readonly engineId: string;
  readonly status: ContentTransformationStatus;
  readonly executionRef: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly outputSpec: Readonly<Record<string, unknown>>;
  readonly outputVersionId: string | null;
  readonly completedAt: string | null;
  readonly failureReason: string | null;
  readonly provenance: ContentAssetsRecordedProvenance;
  readonly versionCas: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The canonical ownership resolution (the route-layer uniform-404 input). */
export interface ContentAssetsOwnership {
  readonly scope: {
    readonly kind: 'content_asset_version';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly versionId: string;
  };
  readonly version: ContentAssetVersionRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// The transformation engine port (the first-party/extension capability seam)
// ---------------------------------------------------------------------------

/**
 * One resolved ingredient handed to an engine (the explicit version):
 * the module fetches the object bytes from the content-addressed
 * ObjectStore port BEFORE the engine runs, so engines stay PURE
 * byte-transformation capabilities (no store access, no IO of their
 * own — "Transformations are capabilities", architecture-v1.6.md §10).
 */
export interface TransformationEngineIngredient {
  readonly versionId: string;
  readonly assetRef: string;
  readonly mediaKind: ContentMediaKind;
  readonly displayName: string;
  /** The content-addressed object-storage key (non-null: draft ingredients are rejected at request time). */
  readonly objectKey: string;
  readonly objectSize: number | null;
  /** The ingredient's object bytes (fetched by the module through the ObjectStore port). */
  readonly bytes: Uint8Array;
}

/** The engine input: the request's frozen facts (kind, parameters, output spec, ingredients). */
export interface TransformationEngineInput {
  readonly transformationId: string;
  readonly kind: TransformationKind;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly outputSpec: Readonly<Record<string, unknown>>;
  readonly ingredients: readonly TransformationEngineIngredient[];
}

/**
 * One measured output fact an engine reports (the OBSERVATION
 * discipline: only facts the engine actually measured/derived for the
 * output — e.g. the output byte size; a fabricated 'score' is
 * unrepresentable through the closed metric vocabulary).
 */
export interface TransformationEngineObservation {
  readonly metric: ContentQualityMetric;
  readonly numericValue: number | null;
  readonly textValue: string | null;
}

/** The engine output: the output bytes + the measured facts. */
export interface TransformationEngineOutput {
  readonly outputBytes: Uint8Array;
  readonly outputContentType: string;
  readonly qualityObservations: readonly TransformationEngineObservation[];
}

/**
 * The execution kind an engine's work runs as on the /executions
 * authority: deterministic first-party capabilities, AI-backed engines,
 * or Extension/App-provided engines. (Human work enters the content
 * pipeline through REGISTRATION — human-created content is registered as
 * source assets with the same evidence-anchored provenance, never
 * through a transformation engine.)
 */
export type TransformationEngineExecutionKind = 'deterministic' | 'ai' | 'extension';

/**
 * THE TRANSFORMATION ENGINE PORT — "Transformations are capabilities,
 * not a hardcoded provider list" (architecture-v1.6.md §10): every
 * engine (first-party double, future real media-processing capability,
 * or Extension/App bridge) declares its identity, the kinds it supports,
 * its EXPECTED EFFECTS and CONSTRAINTS ("Each transformation declares
 * expected effects and constraints" — declared up front, retained on
 * every request resolution so the recorded choice is auditable), and
 * executes ONE transformation as a pure input → output computation over
 * the resolved ingredient objects. Engines are registered as MODULE DATA
 * at the composition root (the /notification-delivery adapter precedent)
 * and the production registry is EMPTY by default (the MKT-056
 * discipline): a kind with no registered engine fails closed at request
 * time — never a silent fallback, never a hardcoded provider.
 */
export interface TransformationEngine {
  /** The stable engine identity (e.g. 'first-party:passthrough'). */
  readonly engineId: string;
  readonly supportedKinds: readonly TransformationKind[];
  /** The declared expected effects (bounded descriptors). */
  readonly declaredEffects: readonly string[];
  /** The declared constraints (bounded descriptors). */
  readonly declaredConstraints: readonly string[];
  readonly executionKind: TransformationEngineExecutionKind;
  /** Executes ONE transformation over the resolved ingredients. */
  execute(input: TransformationEngineInput): Promise<TransformationEngineOutput>;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ContentAssetsModuleApi {
  /**
   * Registers ONE asset VERSION (the immutable artifact record). With
   * `assetId` null a NEW logical asset is created (version 1); with a
   * known asset id the NEXT explicit version is created (monotonic,
   * DB-fenced) — the version discipline: a correction is a NEW version,
   * which is a NEW reference, never an in-place rewrite. Source versions
   * REQUIRE the /evidence-anchored source provenance (the FK +
   * same-Client trigger backstop; the route layer resolves the evidence
   * canonically first — uniform NotFoundError for unknown/foreign).
   * Born 'draft' (no object yet — materializeAssetVersion stores the
   * object and records the single sanctioned state move).
   */
  registerAssetVersion(
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      /** The logical asset to version (null = create a new asset identity). */
      readonly assetId: string | null;
      readonly mediaKind: ContentMediaKind;
      readonly displayName: string;
      readonly contentType: string;
      readonly sourceEvidenceRef: string;
    },
    provenance: ContentAssetsProvenance,
  ): Promise<ContentAssetVersionRecord>;

  /**
   * THE MATERIALIZATION MOVE (draft → materialized): stores the object
   * bytes through the content-addressed ObjectStore port and records the
   * SINGLE sanctioned lifecycle state move + its append-only event in
   * ONE transaction (CAS: the version must still be 'draft' — the
   * losing side of a race is the honest ConflictError). A materialized
   * or derived version cannot re-materialize (immutable version
   * discipline). The object store is content-addressed and idempotent —
   * an object stored for a failed transaction converges to the same key
   * on retry and is never orphaned semantically.
   */
  materializeAssetVersion(
    input: {
      readonly versionId: string;
      readonly bytes: Uint8Array;
    },
    provenance: ContentAssetsProvenance,
  ): Promise<{
    readonly record: ContentAssetVersionRecord;
    readonly event: ContentAssetLifecycleEventRecord;
  }>;

  /**
   * Appends ONE immutable quality OBSERVATION for a version (a measured
   * fact from the frozen metric vocabulary — duration, dimensions,
   * bitrate, caption coverage, language, fps, sample rate, byte size;
   * a re-measurement is a NEW row, never a rewrite). There is
   * deliberately NO score surface: the closed vocabulary cannot express
   * one (observations, never fabricated scores).
   */
  recordQualityObservation(
    input: {
      readonly versionId: string;
      readonly metric: ContentQualityMetric;
      readonly numericValue: number | null;
      readonly textValue: string | null;
    },
    provenance: ContentAssetsProvenance,
  ): Promise<ContentQualityObservationRecord>;

  /**
   * REQUESTS one transformation: validates the KIND (the frozen
   * family), the per-kind parameters + output spec (bounded JSON
   * objects), the EXPLICIT input ingredient versions (each ingredient
   * names (assetId, version) — a floating 'latest' pointer is rejected
   * before any write), and the output metadata declared in the output
   * spec; resolves the ENGINE from the registered registry (by the
   * optional declared engineId, else the first engine supporting the
   * kind — a kind with NO registered engine fails closed, the MKT-056
   * discipline); creates the EXECUTION through the EXISTING /executions
   * authority (external-request task link
   * `content-transformation:<id>`, the engine's declared execution
   * kind, pooled-worker runtime class, deterministic §8 idempotency
   * key); and records the transformation row (born 'requested') + the
   * IMMUTABLE ingredient links (the resolved versions and their refs
   * FROZEN at request time — later re-registrations can never silently
   * re-point a recorded transformation). Draft ingredients are rejected
   * (an engine cannot read bytes that do not exist). RIGHTS ARE NOT
   * CHECKED HERE AND NEVER WILL BE (boundary rule 5): an asset whose
   * ingredients are rights-blocked can still be transformed — the 063
   * publication gate stays the sole rights authority.
   */
  requestTransformation(
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string;
      readonly transformationKind: TransformationKind;
      readonly parameters: Readonly<Record<string, unknown>>;
      readonly outputSpec: Readonly<Record<string, unknown>>;
      readonly ingredients: readonly {
        readonly assetId: string;
        /** The EXPLICIT version number (required — no floating pointers). */
        readonly version: number;
      }[];
      /** The declared engine choice (null = first registered for the kind). */
      readonly engineId: string | null;
    },
    provenance: ContentAssetsProvenance,
  ): Promise<{
    readonly transformation: ContentTransformationRecord;
    readonly executionId: string;
    readonly ingredients: readonly ContentTransformationIngredientRecord[];
  }>;

  /**
   * EXECUTES one requested transformation (the module-side runner —
   * the transformation's work, flowing through the EXISTING execution
   * authority): transitions the referenced execution
   * created → queued → starting → running through the /executions
   * public contract (idempotency keys + CAS versions), runs the
   * FROZEN engine choice over the resolved ingredient objects, stores
   * the output bytes through the content-addressed ObjectStore port,
   * creates the OUTPUT ASSET VERSION born 'derived' (born WITH its
   * object and its lineage — a new logical asset, version 1), records
   * the engine's measured output quality observations + the module's
   * own byte_size observation, records the /content-rights INGREDIENT
   * LINEAGE LINKS (composite ref → each ingredient ref, through the
   * 063 public contract — the conjunction seam; idempotent by
   * convergence on replay), completes the transformation record
   * (requested → completed, the output version link set ONCE), and
   * transitions the execution running → succeeded. On failure: the
   * execution transitions running → failed (safe classification — the
   * module's writes are post-engine and transactional) and the
   * transformation record moves requested → failed with the bounded
   * failure reason. A COMPLETED transformation converges on replay
   * (replayed=true, the recorded outcome); a FAILED transformation is
   * settled — a retry is a NEW transformation request (the §6
   * no-second-identity discipline).
   */
  executeTransformation(
    input: {
      readonly transformationId: string;
    },
    provenance: ContentAssetsProvenance,
  ): Promise<{
    readonly transformation: ContentTransformationRecord;
    readonly executionId: string;
    readonly output: ContentAssetVersionRecord | null;
    readonly replayed: boolean;
  }>;

  /** Raw version by id (module/route internal reads). */
  getAssetVersion(versionId: string): Promise<ContentAssetVersionRecord | null>;

  /**
   * Resolves one version by its OPAQUE content-asset ref within a
   * client (null when unknown/foreign — the ref is the MKT-063 seam
   * target; this is the resolution the ContentAssetReferencePort
   * exposes to /content-rights and future consumers).
   */
  resolveAssetRef(clientId: string, assetRef: string): Promise<ContentAssetVersionRecord | null>;

  /**
   * Canonical ownership resolution: the version record + its owning
   * chain. Null when the version does not exist OR belongs to another
   * tenant — callers surface a uniform 404 so foreign, unknown and
   * malformed identifiers are indistinguishable (hard-boundary
   * posture).
   */
  resolveContentAssetsOwnership(versionId: string): Promise<ContentAssetsOwnership | null>;

  /** The client's asset versions, newest first (bounded, server-chosen limit). */
  listAssetVersionsForClient(clientId: string): Promise<readonly ContentAssetVersionRecord[]>;

  /** The versions of one logical asset (explicit version order, oldest first). Null when the asset is unknown. */
  listVersionsOfAsset(assetId: string): Promise<readonly ContentAssetVersionRecord[] | null>;

  /** The append-only lifecycle event tail of one version (oldest first). Null when the version is unknown. */
  listLifecycleEvents(versionId: string): Promise<readonly ContentAssetLifecycleEventRecord[] | null>;

  /** The append-only quality-observation tail of one version (oldest first). Null when the version is unknown. */
  listQualityObservations(
    versionId: string,
  ): Promise<readonly ContentQualityObservationRecord[] | null>;

  /** Raw transformation by id (module/route internal reads). */
  getTransformation(transformationId: string): Promise<ContentTransformationRecord | null>;

  /** The client's transformations, newest first (bounded, server-chosen limit). */
  listTransformationsForClient(clientId: string): Promise<readonly ContentTransformationRecord[]>;

  /** The immutable ingredient links of one transformation (position order). Null when the transformation is unknown. */
  listTransformationIngredients(
    transformationId: string,
  ): Promise<readonly ContentTransformationIngredientRecord[] | null>;
}

export interface ContentAssetsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The MKT-001 ObjectStore port — the frozen row's /object-storage
   * direction (a PLATFORM port: content-addressed, immutable keys; the
   * filesystem impl is retained for tests, the memory impl for unit
   * doubles; an S3-class adapter can be wired later without touching
   * this consumer).
   */
  readonly objects: ObjectStore;
  /**
   * Frozen matrix: /content-assets ──→ /executions (the transformation
   * EXECUTION flows through the existing authority — createExecution +
   * transitionExecution through the public contract; NO second engine).
   */
  readonly executions: ExecutionsModuleApi;
  /**
   * Frozen matrix: /content-assets ──→ /content-rights (the derivation
   * seam: recordLineageLink when the module derives assets — the 063
   * conjunction grammar; NEVER a rights mutation, NEVER a gate call:
   * transforming an asset never checks or changes rights).
   */
  readonly contentRights: ContentRightsModuleApi;
  /**
   * The registered TRANSFORMATION ENGINES (module DATA — the
   * first-party/extension capability seam). EMPTY by default in
   * production (the MKT-056 discipline); tests and future Work Items
   * wire engines through the composition root options.
   */
  readonly engines: readonly TransformationEngine[];
}

// ---------------------------------------------------------------------------
// The MKT-063 seam satisfaction (the typed port declared by /content-rights)
// ---------------------------------------------------------------------------

/**
 * THE CONTENT-ASSET REFERENCE PORT — the OTHER side of the seam
 * /content-rights declared in its public contract (ContentAssetReferencePort):
 * this module mints refs from its own canonical version ids and owns
 * the real records those refs resolve to. The factory below satisfies
 * the 063 typed port exactly; /content-rights itself holds no port
 * parameter today (its deps predate the seam and it never calls it —
 * disclosed there); future consumers (MKT-065 cross-platform
 * distribution) resolve asset refs through THIS adapter.
 */
export function createContentAssetReferencePort(
  api: ContentAssetsModuleApi,
): ContentAssetReferencePort {
  return {
    async resolveContentAssetRef(clientId, assetRef) {
      const version = await api.resolveAssetRef(clientId, assetRef);
      return { exists: version !== null };
    },
  };
}

// ---------------------------------------------------------------------------
// The pure guard + evaluation core (exported for unit tests — the input
// discipline is part of the module contract)
// ---------------------------------------------------------------------------

/**
 * PURE: is the (from, to) pair a legal lifecycle move? The ONLY
 * sanctioned move is draft → materialized ('derived' is a BIRTH state —
 * an existing version can never become a transformation output). The
 * migration-053 disciplined trigger is the persisted mirror.
 */
export function isLegalContentAssetLifecycleMove(
  from: ContentAssetLifecycleState,
  to: ContentAssetLifecycleState,
): boolean {
  return from === 'draft' && to === 'materialized';
}

/**
 * PURE: the engine resolution over a registry — by declared engineId
 * (which must exist AND support the kind), else the FIRST engine
 * supporting the kind. Null when no engine serves the kind (the
 * fail-closed MKT-056 posture: a kind with no registered engine is
 * requested nowhere, executed nowhere).
 */
export function resolveTransformationEngine(
  engines: readonly TransformationEngine[],
  kind: TransformationKind,
  declaredEngineId: string | null,
): TransformationEngine | null {
  if (declaredEngineId !== null) {
    const declared = engines.find((engine) => engine.engineId === declaredEngineId);
    if (declared === undefined || !declared.supportedKinds.includes(kind)) {
      return null;
    }
    return declared;
  }
  return engines.find((engine) => engine.supportedKinds.includes(kind)) ?? null;
}

export { createContentAssetsModule } from './internal/module.ts';
/**
 * The input guards (vocabulary/shape/provenance validation —
 * fail-closed by rejection BEFORE any write) and the grammar constants,
 * exported for unit tests and future server-side callers so the guard
 * semantics are part of the module contract. Pure functions.
 */
export {
  assertValidContentAssetsProvenance,
  assertValidRegisterAssetVersionInput,
  assertValidMaterializeInput,
  assertValidQualityObservationInput,
  assertValidRequestTransformationInput,
  assertValidExecuteTransformationInput,
  assertValidJsonPayload,
  MAX_JSON_PAYLOAD_BYTES,
  MAX_OBJECT_BYTES,
  transformationRequestProblems,
} from './internal/validation.ts';
/**
 * The first-party ENGINE DOUBLES (the disclosed test doubles behind the
 * real port contract — re-exported through the public entry so tests
 * and the composition root construct them without touching module
 * internals; production registers NONE of them by default — the
 * MKT-056 discipline).
 */
export {
  createPassthroughTransformationEngine,
  createFormatTransformationEngine,
  createCropTransformationEngine,
} from './internal/engines/transformation-engines.ts';
