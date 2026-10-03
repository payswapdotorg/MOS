/**
 * /lab-features persistence (LAB-003 — the migration-065 tables).
 *
 * Owns EXACTLY the three own tables (the 059/060/061/063 discipline):
 *
 *   lab_feature_batch_runs, lab_feature_bundles, lab_feature_batch_items.
 *
 * NO AUTHORITY TRANSFER / NO SHADOWING (§3): no experiment, decision,
 * evidence, metric, publication, workflow or execution table is
 * written or joined here; no /lab-corpus table is written either —
 * the source linkage columns are OPAQUE recorded citation data (the
 * corpus advance seam stays /lab-corpus's own guarded column; this
 * store never issues any SQL against lab_corpus_*).
 *
 * Bundle rows are APPEND-ONLY OUTRIGHT (UPDATE and DELETE rejected by
 * the migration-065 triggers); item outcomes are APPEND-ONLY
 * OUTRIGHT; the batch run is born 'running' and advances to
 * 'completed' exactly once with the summary counts SQL-COMPUTED from
 * the item outcome rows (never asserted separately — the CHECK fence
 * pins extracted+failed+skipped = item_count).
 *
 * Every read is CLIENT-scoped (the uniform tenant fence; the module
 * resolves foreign/unknown scope to the uniform NotFound — no
 * existence oracle).
 */

import type { DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  LabFeatureBatchItemRecord,
  LabFeatureBatchRunRecord,
  LabFeatureBundleRecord,
  LabFeatureFailureReason,
  LabFeatureItemOutcome,
  LabFeatureMediaAccessPosture,
  LabFeatureMediaAvailability,
  LabFeatureMediaFetchStatus,
  LabFeatureModality,
  LabFeatureRunStatus,
  LabFeatureSkipReason,
  LabFeatureValueMap,
  LabFeaturesScope,
} from '../public.ts';
import { LAB_FEATURES_CONTRACT_VERSION } from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case as returned by PostgreSQL)
// ---------------------------------------------------------------------------

interface RunRow extends DbRow {
  run_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  item_count: number | string;
  extractor_id: string;
  extractor_version: string;
  feature_set_version: string;
  required_modalities: string[];
  extracted_count: number | string;
  failed_count: number | string;
  skipped_count: number | string;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface BundleRow extends DbRow {
  bundle_id: string;
  reference_id: string;
  bundle_version: number | string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  run_id: string;
  corpus_id: string;
  corpus_version: number | string;
  provider: string;
  provider_content_id: string;
  canonical_url: string;
  metadata_digest: string;
  media_availability_at_extraction: string;
  grant_posture: string;
  media_fetch_status: string;
  media_fetch_detail: string | null;
  media_fetch_bytes: number | string | null;
  feature_set_version: string;
  extractor_id: string;
  extractor_version: string;
  identity_digest: string;
  input_digest: string;
  required_modalities: string[];
  features: unknown;
  derived_feature_count: number | string;
  unavailable_feature_count: number | string;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow extends DbRow {
  item_id: string;
  run_id: string;
  bundle_id: string | null;
  agency_id: string;
  client_id: string;
  reference_id: string;
  provider: string;
  provider_content_id: string;
  seq: number | string;
  outcome: string;
  failure_reason: string | null;
  skip_reason: string | null;
  error_detail: string | null;
  identity_digest: string | null;
  contract_version: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

/** The PostgreSQL array-literal serialization (the toArrayLiteral house precedent — text[] params ride as literals with ::text[] casts). */
function toArrayLiteral(values: readonly string[]): string {
  return `{${values
    .map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join(',')}}`;
}

export function mapRunRow(r: RunRow, items: ReadonlyArray<LabFeatureBatchItemRecord> = []): LabFeatureBatchRunRecord {
  return {
    runId: r.run_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabFeatureRunStatus,
    itemCount: Number(r.item_count),
    extractorId: r.extractor_id,
    extractorVersion: r.extractor_version,
    featureSetVersion: r.feature_set_version,
    requiredModalities: r.required_modalities as LabFeatureModality[],
    extractedCount: Number(r.extracted_count),
    failedCount: Number(r.failed_count),
    skippedCount: Number(r.skipped_count),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    items,
  };
}

export function mapBundleRow(r: BundleRow): LabFeatureBundleRecord {
  return {
    bundleId: r.bundle_id,
    bundleReference: `${r.bundle_id}#v${Number(r.bundle_version)}`,
    referenceId: r.reference_id,
    bundleVersion: Number(r.bundle_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    runId: r.run_id,
    corpusId: r.corpus_id,
    corpusVersion: Number(r.corpus_version),
    provider: r.provider,
    providerContentId: r.provider_content_id,
    canonicalUrl: r.canonical_url,
    metadataDigest: r.metadata_digest,
    mediaAvailabilityAtExtraction: r.media_availability_at_extraction as LabFeatureMediaAvailability,
    grantPosture: r.grant_posture as LabFeatureMediaAccessPosture,
    mediaFetchStatus: r.media_fetch_status as LabFeatureMediaFetchStatus,
    mediaFetchDetail: r.media_fetch_detail,
    mediaFetchBytes: r.media_fetch_bytes === null ? null : Number(r.media_fetch_bytes),
    featureSetVersion: r.feature_set_version,
    extractorId: r.extractor_id,
    extractorVersion: r.extractor_version,
    identityDigest: r.identity_digest,
    inputDigest: r.input_digest,
    requiredModalities: r.required_modalities as LabFeatureModality[],
    features: r.features as LabFeatureValueMap,
    derivedFeatureCount: Number(r.derived_feature_count),
    unavailableFeatureCount: Number(r.unavailable_feature_count),
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapItemRow(r: ItemRow): LabFeatureBatchItemRecord {
  return {
    itemId: r.item_id,
    runId: r.run_id,
    bundleId: r.bundle_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    referenceId: r.reference_id,
    provider: r.provider,
    providerContentId: r.provider_content_id,
    seq: Number(r.seq),
    outcome: r.outcome as LabFeatureItemOutcome,
    failureReason: r.failure_reason as LabFeatureFailureReason | null,
    skipReason: r.skip_reason as LabFeatureSkipReason | null,
    errorDetail: r.error_detail,
    identityDigest: r.identity_digest,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface InsertRunRowInput {
  runId: string;
  scope: LabFeaturesScope;
  itemCount: number;
  extractorId: string;
  extractorVersion: string;
  featureSetVersion: string;
  requiredModalities: ReadonlyArray<LabFeatureModality>;
}

export interface InsertBundleRowInput {
  bundleId: string;
  referenceId: string;
  bundleVersion: number;
  scope: LabFeaturesScope;
  runId: string;
  corpusId: string;
  corpusVersion: number;
  provider: string;
  providerContentId: string;
  canonicalUrl: string;
  metadataDigest: string;
  mediaAvailabilityAtExtraction: LabFeatureMediaAvailability;
  grantPosture: LabFeatureMediaAccessPosture;
  mediaFetchStatus: LabFeatureMediaFetchStatus;
  mediaFetchDetail: string | undefined;
  mediaFetchBytes: number | undefined;
  featureSetVersion: string;
  extractorId: string;
  extractorVersion: string;
  identityDigest: string;
  inputDigest: string;
  requiredModalities: ReadonlyArray<LabFeatureModality>;
  features: LabFeatureValueMap;
  derivedFeatureCount: number;
  unavailableFeatureCount: number;
}

export interface InsertItemRowInput {
  itemId: string;
  runId: string;
  scope: LabFeaturesScope;
  bundleId: string | null;
  /** The citation echo — NULL when the malformed citation carries nothing echoable (invalid_input items). */
  referenceId: string | null;
  provider: string | null;
  providerContentId: string | null;
  seq: number;
  outcome: LabFeatureItemOutcome;
  failureReason: LabFeatureFailureReason | null;
  skipReason: LabFeatureSkipReason | null;
  errorDetail: string | null;
  identityDigest: string | null;
}

export class LabFeaturesStore {
  private readonly db: DbTransaction;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: DbTransaction, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  nowIso(): string {
    return this.clock.nowIso();
  }

  newId(): string {
    return this.ids.newId();
  }

  // --- batch runs ---

  async insertRun(input: InsertRunRowInput): Promise<RunRow> {
    const now = this.nowIso();
    const r = await this.db.query<RunRow>(
      `INSERT INTO lab_feature_batch_runs
         (run_id, agency_id, client_id, workspace_id, status, item_count,
          extractor_id, extractor_version, feature_set_version, required_modalities,
          extracted_count, failed_count, skipped_count, contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, $8, $9::text[], 0, 0, 0, $10, $11::timestamptz, $11::timestamptz)
       RETURNING *`,
      [
        input.runId,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.itemCount,
        input.extractorId,
        input.extractorVersion,
        input.featureSetVersion,
        toArrayLiteral([...input.requiredModalities]),
        LAB_FEATURES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  /**
   * THE COMPLETION ADVANCE: the single guarded running → completed
   * transition with the summary counts SQL-COMPUTED from the item
   * outcome rows (never asserted separately — the CHECK fence pins
   * extracted+failed+skipped = item_count).
   */
  async completeRun(runId: string): Promise<RunRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<RunRow>(
      `UPDATE lab_feature_batch_runs
          SET status = 'completed',
              extracted_count = (SELECT count(*) FROM lab_feature_batch_items WHERE run_id = $1 AND outcome = 'extracted'),
              failed_count = (SELECT count(*) FROM lab_feature_batch_items WHERE run_id = $1 AND outcome = 'failed'),
              skipped_count = (SELECT count(*) FROM lab_feature_batch_items WHERE run_id = $1 AND outcome = 'skipped'),
              updated_at = $2::timestamptz
        WHERE run_id = $1
        RETURNING *`,
      [runId, now],
    );
    return r.rows[0] ?? null;
  }

  async findRun(clientId: string, runId: string): Promise<RunRow | null> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM lab_feature_batch_runs
        WHERE client_id = $1 AND run_id = $2`,
      [clientId, runId],
    );
    return r.rows[0] ?? null;
  }

  async listRuns(clientId: string): Promise<ReadonlyArray<RunRow>> {
    const r = await this.db.query<RunRow>(
      `SELECT * FROM lab_feature_batch_runs
        WHERE client_id = $1
        ORDER BY created_at DESC, run_id`,
      [clientId],
    );
    return r.rows;
  }

  // --- bundles ---

  async insertBundle(input: InsertBundleRowInput): Promise<BundleRow> {
    const now = this.nowIso();
    const r = await this.db.query<BundleRow>(
      `INSERT INTO lab_feature_bundles
         (bundle_id, reference_id, bundle_version, agency_id, client_id, workspace_id, run_id,
          corpus_id, corpus_version, provider, provider_content_id, canonical_url, metadata_digest,
          media_availability_at_extraction, grant_posture, media_fetch_status, media_fetch_detail, media_fetch_bytes,
          feature_set_version, extractor_id, extractor_version, identity_digest, input_digest,
          required_modalities, features, derived_feature_count, unavailable_feature_count,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23,
               $24::text[], $25::jsonb, $26, $27,
               $28, $29::timestamptz, $29::timestamptz)
       RETURNING *`,
      [
        input.bundleId,
        input.referenceId,
        input.bundleVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.runId,
        input.corpusId,
        input.corpusVersion,
        input.provider,
        input.providerContentId,
        input.canonicalUrl,
        input.metadataDigest,
        input.mediaAvailabilityAtExtraction,
        input.grantPosture,
        input.mediaFetchStatus,
        input.mediaFetchDetail ?? null,
        input.mediaFetchBytes ?? null,
        input.featureSetVersion,
        input.extractorId,
        input.extractorVersion,
        input.identityDigest,
        input.inputDigest,
        toArrayLiteral([...input.requiredModalities]),
        JSON.stringify(input.features),
        input.derivedFeatureCount,
        input.unavailableFeatureCount,
        LAB_FEATURES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findBundleByIdentity(clientId: string, identityDigest: string): Promise<BundleRow | null> {
    const r = await this.db.query<BundleRow>(
      `SELECT * FROM lab_feature_bundles
        WHERE client_id = $1 AND identity_digest = $2`,
      [clientId, identityDigest],
    );
    return r.rows[0] ?? null;
  }

  async findLatestBundleVersion(clientId: string, referenceId: string): Promise<BundleRow | null> {
    const r = await this.db.query<BundleRow>(
      `SELECT * FROM lab_feature_bundles
        WHERE client_id = $1 AND reference_id = $2
        ORDER BY bundle_version DESC LIMIT 1`,
      [clientId, referenceId],
    );
    return r.rows[0] ?? null;
  }

  async findBundle(clientId: string, bundleId: string): Promise<BundleRow | null> {
    const r = await this.db.query<BundleRow>(
      `SELECT * FROM lab_feature_bundles
        WHERE client_id = $1 AND bundle_id = $2`,
      [clientId, bundleId],
    );
    return r.rows[0] ?? null;
  }

  async listBundlesByReference(clientId: string, referenceId: string): Promise<ReadonlyArray<BundleRow>> {
    const r = await this.db.query<BundleRow>(
      `SELECT * FROM lab_feature_bundles
        WHERE client_id = $1 AND reference_id = $2
        ORDER BY bundle_version DESC`,
      [clientId, referenceId],
    );
    return r.rows;
  }

  // --- item outcomes ---

  async insertItem(input: InsertItemRowInput): Promise<ItemRow> {
    const now = this.nowIso();
    const r = await this.db.query<ItemRow>(
      `INSERT INTO lab_feature_batch_items
         (item_id, run_id, bundle_id, agency_id, client_id, reference_id,
          provider, provider_content_id, seq, outcome, failure_reason, skip_reason,
          error_detail, identity_digest, contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16::timestamptz)
       RETURNING *`,
      [
        input.itemId,
        input.runId,
        input.bundleId,
        input.scope.agencyId,
        input.scope.clientId,
        input.referenceId,
        input.provider,
        input.providerContentId,
        input.seq,
        input.outcome,
        input.failureReason,
        input.skipReason,
        input.errorDetail,
        input.identityDigest,
        LAB_FEATURES_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listItems(runId: string): Promise<ReadonlyArray<ItemRow>> {
    const r = await this.db.query<ItemRow>(
      `SELECT * FROM lab_feature_batch_items
        WHERE run_id = $1
        ORDER BY seq, item_id`,
      [runId],
    );
    return r.rows;
  }
}
