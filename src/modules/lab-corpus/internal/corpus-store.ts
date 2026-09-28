/**
 * /lab-corpus persistence (LAB-002 — the migration-061 tables).
 *
 * Owns EXACTLY the three own tables (the 059/060 discipline):
 *
 *   lab_corpus_versions, lab_corpus_references, lab_corpus_observations.
 *
 * NO AUTHORITY TRANSFER / NO SHADOWING (§3): no experiment, decision,
 * evidence, metric, publication, workflow or execution table is
 * written or joined here; no /lab table is written either — the /lab
 * scenario's corpus citation is an opaque string in /lab's own binding
 * jsonb. Artifact rows are append-only/immutable per the
 * migration-061 guard triggers; the reference availability advance is
 * paired with the appended observation row inside ONE transaction
 * (the migration-052 pairing pattern).
 *
 * Every read is CLIENT-scoped (the uniform tenant fence; the module
 * resolves foreign/unknown scope to the uniform NotFound — no
 * existence oracle).
 */

import type { DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  LabCorpusAcquisitionPolicy,
  LabCorpusMediaAvailability,
  LabCorpusObservationRecord,
  LabCorpusReferenceRecord,
  LabCorpusRecord,
  LabCorpusScope,
  LabCorpusStatus,
} from '../public.ts';
import { LAB_CORPUS_CONTRACT_VERSION } from '../public.ts';

// ---------------------------------------------------------------------------
// Row shapes (snake_case as returned by PostgreSQL)
// ---------------------------------------------------------------------------

interface CorpusRow extends DbRow {
  corpus_id: string;
  corpus_version: number;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  status: string;
  niche: string;
  platform: string;
  acquisition_policy: unknown;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface ReferenceRow extends DbRow {
  reference_id: string;
  corpus_id: string;
  corpus_version: number;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  provider: string;
  provider_content_id: string;
  canonical_url: string;
  creator_ref: string | null;
  publication_time: Date | null;
  observation_time: Date;
  rights_basis: string;
  collection_method: string;
  collection_version: string;
  metadata_snapshot: unknown;
  metadata_digest: string;
  media_availability: string;
  feature_bundle_version: string;
  contract_version: string;
  created_at: Date;
  updated_at: Date;
}

interface ObservationRow extends DbRow {
  observation_id: string;
  reference_id: string;
  agency_id: string;
  client_id: string;
  observed_at: Date;
  collection_method: string;
  collection_version: string;
  metadata_digest: string;
  media_availability: string;
  contract_version: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

export function mapCorpusRow(r: CorpusRow): LabCorpusRecord {
  return {
    corpusId: r.corpus_id,
    corpusVersion: Number(r.corpus_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    status: r.status as LabCorpusStatus,
    niche: r.niche,
    platform: r.platform,
    acquisitionPolicy: r.acquisition_policy as LabCorpusAcquisitionPolicy,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapReferenceRow(r: ReferenceRow): LabCorpusReferenceRecord {
  return {
    referenceId: r.reference_id,
    corpusId: r.corpus_id,
    corpusVersion: Number(r.corpus_version),
    agencyId: r.agency_id,
    clientId: r.client_id,
    workspaceId: r.workspace_id,
    provider: r.provider,
    providerContentId: r.provider_content_id,
    canonicalUrl: r.canonical_url,
    creatorRef: r.creator_ref,
    publicationTime: r.publication_time === null ? null : toIso(r.publication_time),
    observationTime: toIso(r.observation_time),
    rightsBasis: r.rights_basis as LabCorpusReferenceRecord['rightsBasis'],
    collectionMethod: r.collection_method,
    collectionVersion: r.collection_version,
    metadataSnapshot: r.metadata_snapshot as LabCorpusReferenceRecord['metadataSnapshot'],
    metadataDigest: r.metadata_digest,
    mediaAvailability: r.media_availability as LabCorpusMediaAvailability,
    featureBundleVersion: r.feature_bundle_version,
    contractVersion: r.contract_version,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

export function mapObservationRow(r: ObservationRow): LabCorpusObservationRecord {
  return {
    observationId: r.observation_id,
    referenceId: r.reference_id,
    agencyId: r.agency_id,
    clientId: r.client_id,
    observedAt: toIso(r.observed_at),
    collectionMethod: r.collection_method,
    collectionVersion: r.collection_version,
    metadataDigest: r.metadata_digest,
    mediaAvailability: r.media_availability as LabCorpusMediaAvailability,
    contractVersion: r.contract_version,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface InsertCorpusRowInput {
  corpusId: string;
  corpusVersion: number;
  scope: LabCorpusScope;
  status: LabCorpusStatus;
  niche: string;
  platform: string;
  acquisitionPolicy: LabCorpusAcquisitionPolicy;
}

export interface InsertReferenceRowInput {
  referenceId: string;
  corpusId: string;
  corpusVersion: number;
  scope: LabCorpusScope;
  provider: string;
  providerContentId: string;
  canonicalUrl: string;
  creatorRef: string | null;
  publicationTime: string | null;
  observationTime: string;
  rightsBasis: string;
  collectionMethod: string;
  collectionVersion: string;
  metadataSnapshot: Readonly<Record<string, unknown>>;
  metadataDigest: string;
  mediaAvailability: LabCorpusMediaAvailability;
}

export interface InsertObservationRowInput {
  observationId: string;
  referenceId: string;
  scope: LabCorpusScope;
  observedAt: string;
  collectionMethod: string;
  collectionVersion: string;
  metadataDigest: string;
  mediaAvailability: LabCorpusMediaAvailability;
}

export class LabCorpusStore {
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

  // --- corpus versions ---

  async insertCorpus(input: InsertCorpusRowInput): Promise<CorpusRow> {
    const now = this.nowIso();
    const r = await this.db.query<CorpusRow>(
      `INSERT INTO lab_corpus_versions
         (corpus_id, corpus_version, agency_id, client_id, workspace_id, status,
          niche, platform, acquisition_policy, contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz, $11::timestamptz)
       RETURNING *`,
      [
        input.corpusId,
        input.corpusVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.status,
        input.niche,
        input.platform,
        JSON.stringify(input.acquisitionPolicy),
        LAB_CORPUS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findLatestCorpusVersion(clientId: string, corpusId: string): Promise<CorpusRow | null> {
    const r = await this.db.query<CorpusRow>(
      `SELECT * FROM lab_corpus_versions
        WHERE client_id = $1 AND corpus_id = $2
        ORDER BY corpus_version DESC LIMIT 1`,
      [clientId, corpusId],
    );
    return r.rows[0] ?? null;
  }

  async listLatestCorpora(clientId: string): Promise<ReadonlyArray<CorpusRow>> {
    const r = await this.db.query<CorpusRow>(
      `SELECT DISTINCT ON (corpus_id) *
         FROM lab_corpus_versions
        WHERE client_id = $1
        ORDER BY corpus_id, corpus_version DESC`,
      [clientId],
    );
    return r.rows;
  }

  async updateCorpusStatus(clientId: string, corpusId: string, corpusVersion: number, status: LabCorpusStatus): Promise<CorpusRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<CorpusRow>(
      `UPDATE lab_corpus_versions
          SET status = $4, updated_at = $5::timestamptz
        WHERE client_id = $1 AND corpus_id = $2 AND corpus_version = $3
        RETURNING *`,
      [clientId, corpusId, corpusVersion, status, now],
    );
    return r.rows[0] ?? null;
  }

  // --- references ---

  async findReferenceByProviderContentId(clientId: string, provider: string, providerContentId: string): Promise<ReferenceRow | null> {
    const r = await this.db.query<ReferenceRow>(
      `SELECT * FROM lab_corpus_references
        WHERE client_id = $1 AND provider = $2 AND provider_content_id = $3`,
      [clientId, provider, providerContentId],
    );
    return r.rows[0] ?? null;
  }

  async insertReference(input: InsertReferenceRowInput): Promise<ReferenceRow> {
    const now = this.nowIso();
    const r = await this.db.query<ReferenceRow>(
      `INSERT INTO lab_corpus_references
         (reference_id, corpus_id, corpus_version, agency_id, client_id, workspace_id,
          provider, provider_content_id, canonical_url, creator_ref, publication_time,
          observation_time, rights_basis, collection_method, collection_version,
          metadata_snapshot, metadata_digest, media_availability, feature_bundle_version,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz,
               $12::timestamptz, $13, $14, $15, $16::jsonb, $17, $18, 'pending',
               $19, $20::timestamptz, $20::timestamptz)
       RETURNING *`,
      [
        input.referenceId,
        input.corpusId,
        input.corpusVersion,
        input.scope.agencyId,
        input.scope.clientId,
        input.scope.workspaceId ?? null,
        input.provider,
        input.providerContentId,
        input.canonicalUrl,
        input.creatorRef,
        input.publicationTime,
        input.observationTime,
        input.rightsBasis,
        input.collectionMethod,
        input.collectionVersion,
        JSON.stringify(input.metadataSnapshot),
        input.metadataDigest,
        input.mediaAvailability,
        LAB_CORPUS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async findReference(clientId: string, referenceId: string): Promise<ReferenceRow | null> {
    const r = await this.db.query<ReferenceRow>(
      `SELECT * FROM lab_corpus_references
        WHERE client_id = $1 AND reference_id = $2`,
      [clientId, referenceId],
    );
    return r.rows[0] ?? null;
  }

  async listReferences(clientId: string, corpusId?: string, provider?: string): Promise<ReadonlyArray<ReferenceRow>> {
    const conditions = ['client_id = $1'];
    const params: Array<string | number> = [clientId];
    if (corpusId !== undefined) {
      params.push(corpusId);
      conditions.push(`corpus_id = $${params.length}`);
    }
    if (provider !== undefined) {
      params.push(provider);
      conditions.push(`provider = $${params.length}`);
    }
    const r = await this.db.query<ReferenceRow>(
      `SELECT * FROM lab_corpus_references
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at, reference_id`,
      params,
    );
    return r.rows;
  }

  /** Advances the reference's CURRENT availability (the guarded column pair — identity stays immutable). */
  async updateReferenceAvailability(referenceId: string, mediaAvailability: LabCorpusMediaAvailability): Promise<ReferenceRow | null> {
    const now = this.nowIso();
    const r = await this.db.query<ReferenceRow>(
      `UPDATE lab_corpus_references
          SET media_availability = $2, updated_at = $3::timestamptz
        WHERE reference_id = $1
        RETURNING *`,
      [referenceId, mediaAvailability, now],
    );
    return r.rows[0] ?? null;
  }

  // --- observations ---

  async insertObservation(input: InsertObservationRowInput): Promise<ObservationRow> {
    const now = this.nowIso();
    const r = await this.db.query<ObservationRow>(
      `INSERT INTO lab_corpus_observations
         (observation_id, reference_id, agency_id, client_id, observed_at,
          collection_method, collection_version, metadata_digest, media_availability,
          contract_version, created_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11::timestamptz)
       RETURNING *`,
      [
        input.observationId,
        input.referenceId,
        input.scope.agencyId,
        input.scope.clientId,
        input.observedAt,
        input.collectionMethod,
        input.collectionVersion,
        input.metadataDigest,
        input.mediaAvailability,
        LAB_CORPUS_CONTRACT_VERSION,
        now,
      ],
    );
    return r.rows[0]!;
  }

  async listObservations(clientId: string, referenceId: string): Promise<ReadonlyArray<ObservationRow>> {
    const r = await this.db.query<ObservationRow>(
      `SELECT * FROM lab_corpus_observations
        WHERE client_id = $1 AND reference_id = $2
        ORDER BY observed_at, observation_id`,
      [clientId, referenceId],
    );
    return r.rows;
  }

  // --- coverage reporting (EXECUTION-PLAN §11: coverage, freshness, duplication, accessibility, extraction success) ---

  async countReferencesByFacet(clientId: string, corpusId: string, facet: 'provider' | 'media_availability'): Promise<ReadonlyArray<{ key: string; n: string | number }>> {
    const r = await this.db.query<{ key: string; n: string | number }>(
      `SELECT ${facet} AS key, count(*)::text AS n
         FROM lab_corpus_references
        WHERE client_id = $1 AND corpus_id = $2
        GROUP BY ${facet}`,
      [clientId, corpusId],
    );
    return r.rows;
  }

  async countExtractionStates(clientId: string, corpusId: string): Promise<{ extracted: number; pending: number }> {
    const r = await this.db.query<{ extracted: string; pending: string }>(
      `SELECT
         count(*) FILTER (WHERE feature_bundle_version <> 'pending')::text AS extracted,
         count(*) FILTER (WHERE feature_bundle_version = 'pending')::text AS pending
       FROM lab_corpus_references
        WHERE client_id = $1 AND corpus_id = $2`,
      [clientId, corpusId],
    );
    const row = r.rows[0];
    return { extracted: Number(row?.extracted ?? 0), pending: Number(row?.pending ?? 0) };
  }

  async countDigestCollisionGroups(clientId: string, corpusId: string): Promise<number> {
    const r = await this.db.query<{ groups: string }>(
      `SELECT count(*)::text AS groups
         FROM (
           SELECT metadata_digest
             FROM lab_corpus_references
            WHERE client_id = $1 AND corpus_id = $2
            GROUP BY metadata_digest
           HAVING count(*) > 1
         ) AS collision_groups`,
      [clientId, corpusId],
    );
    return Number(r.rows[0]?.groups ?? 0);
  }

  async observationWindow(clientId: string, corpusId: string): Promise<{ total: number; oldest: Date | null; newest: Date | null }> {
    const r = await this.db.query<{ total: string; oldest: Date | null; newest: Date | null }>(
      `SELECT count(*)::text AS total,
              min(o.observed_at) AS oldest,
              max(o.observed_at) AS newest
         FROM lab_corpus_observations o
         JOIN lab_corpus_references r ON r.reference_id = o.reference_id
        WHERE r.client_id = $1 AND r.corpus_id = $2`,
      [clientId, corpusId],
    );
    const row = r.rows[0];
    return { total: Number(row?.total ?? 0), oldest: row?.oldest ?? null, newest: row?.newest ?? null };
  }
}
