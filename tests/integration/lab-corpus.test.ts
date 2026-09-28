/**
 * LAB-002 integration tests — the /lab-corpus Reference-First Niche
 * Corpus against a REAL embedded PostgreSQL stack (the LAB-001
 * module-level harness: real PgDb + real users/agencies/clients public
 * contracts, the corpus module under test composed exactly as the
 * composition root wires it — platform ports only).
 *
 * The acceptance battery (spec/effective-backlog-v1.7.md LAB-002):
 *   (a) reference-first storage — every registered reference carries
 *       the §4 verbatim field set and NO media bytes anywhere (the
 *       schema itself is the proof: no binary column exists on any
 *       lab_corpus_* table, asserted directly);
 *   (b) provider-specific acquisition policy — ingestion under an
 *       undeclared provider or an unpermitted rights basis is refused;
 *   (c) provenance — the collection method/version pair rides every
 *       reference AND every observation;
 *   (d) deduplication — re-ingestion of the same (provider, content
 *       id) appends an observation on the SAME reference row (the
 *       UNIQUE fence is also proven at the DB level);
 *   (e) observation timestamps — the append-only observation tail
 *       grows monotonically and the current availability advances only
 *       through appended observations;
 *   (f) coverage reporting — totals, by-provider, by-availability,
 *       extraction pending/extracted, digest-collision groups and the
 *       oldest/newest observation window over the real schema;
 *   (g) no unauthorized media retention — UPDATE/DELETE backstops:
 *       observations are append-only outright, reference identity is
 *       immutable (only the availability/feature-bundle columns
 *       advance), corpus history is append-only;
 * plus the tenant-isolation fence (§22 — Bob's client can never read
 * or ingest into Alice's corpus: uniform NotFound, no existence
 * oracle) and the versioned-contract pin (lab-corpus-contract-v1).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootStack,
  shutdownStack,
  type IntegrationStack,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { createUsersModule } from '../../src/modules/users/public.ts';
import { createAgenciesModule } from '../../src/modules/agencies/public.ts';
import { createClientsModule } from '../../src/modules/clients/public.ts';
import { createLabCorpusModule, LAB_CORPUS_CONTRACT_VERSION } from '../../src/modules/lab-corpus/public.ts';
import type { LabCorpusModuleApi, LabCorpusScope, RegisterLabCorpusReferenceInput, LabCorpusAcquisitionPolicy } from '../../src/modules/lab-corpus/public.ts';
import { NotFoundError, InvalidRequestError } from '../../src/platform/errors/errors.ts';

let stack: IntegrationStack | null = null;
let db: PgDb | null = null;
let corpus: LabCorpusModuleApi = null as unknown as LabCorpusModuleApi;

const aliceScope: LabCorpusScope = { agencyId: '', clientId: '' };
const bobScope: LabCorpusScope = { agencyId: '', clientId: '' };

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function policy(): LabCorpusAcquisitionPolicy {
  return {
    version: 'lab-corpus-policy-v1',
    providers: {
      youtube: { permittedBases: ['public_reference', 'provider_api_terms'], mediaAccess: 'reference_gated' },
      tiktok: { permittedBases: ['public_reference'], mediaAccess: 'metadata_only' },
    },
  };
}

function refInput(overrides: Partial<RegisterLabCorpusReferenceInput> = {}): RegisterLabCorpusReferenceInput {
  return {
    scope: aliceScope,
    corpusId: '',
    provider: 'youtube',
    providerContentId: 'vid-1',
    canonicalUrl: 'https://www.youtube.com/watch?v=vid-1',
    creatorRef: '@creator',
    publicationTime: '2026-01-15T10:00:00.000Z',
    rightsBasis: 'public_reference',
    collectionMethod: 'mkt-062-web-research',
    collectionVersion: 'v1',
    metadataSnapshot: { title: 'A video', durationSeconds: 61 },
    metadataDigest: DIGEST_A,
    mediaAvailability: 'unknown',
    ...overrides,
  };
}

async function makeCorpus(scope: LabCorpusScope, niche = 'home fitness equipment'): Promise<string> {
  const created = await corpus.createCorpus({ scope, niche, platform: 'youtube', acquisitionPolicy: policy() });
  return created.corpusId;
}

before(async () => {
  stack = await bootStack('lab_corpus');
  db = new PgDb(stack.env.databaseUrl, 4);
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const users = createUsersModule({ db, clock, ids });
  const agencies = createAgenciesModule({ db, clock, ids, users });
  const clients = createClientsModule({ db, clock, ids, agencies });
  corpus = createLabCorpusModule({ db, clock, ids });

  // The tenant fixtures: Alice's agency + client, Bob's agency + client.
  const aliceUser = await users.createUser({ email: 'alice@labcorpus.test', displayName: 'Alice' });
  const aliceAgency = await agencies.createAgency({ name: 'Alice Agency', slug: 'alice-corpus', ownerUserId: aliceUser.userId, actorId: null });
  const aliceClient = await clients.createClient({ agencyId: aliceAgency.agency.agencyId, name: 'Alice Client', slug: 'alice-client', actorId: null });
  aliceScope.agencyId = aliceAgency.agency.agencyId;
  aliceScope.clientId = aliceClient.clientId;

  const bobUser = await users.createUser({ email: 'bob@labcorpus.test', displayName: 'Bob' });
  const bobAgency = await agencies.createAgency({ name: 'Bob Agency', slug: 'bob-corpus', ownerUserId: bobUser.userId, actorId: null });
  const bobClient = await clients.createClient({ agencyId: bobAgency.agency.agencyId, name: 'Bob Client', slug: 'bob-client', actorId: null });
  bobScope.agencyId = bobAgency.agency.agencyId;
  bobScope.clientId = bobClient.clientId;
});

after(async () => {
  if (db !== null) await db.close();
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// (a)+(versioned contracts) Corpus lifecycle and the version pin.
// ---------------------------------------------------------------------------

test('LAB-002: the corpus lifecycle draft → active → retired with append-only version corrections (the LAB-001 scenario discipline)', async () => {
  const corpusId = await makeCorpus(aliceScope);

  const draft = await corpus.getCorpus(aliceScope, corpusId);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.corpusVersion, 1);
  assert.equal(draft.contractVersion, LAB_CORPUS_CONTRACT_VERSION);

  const active = await corpus.activateCorpus(aliceScope, corpusId);
  assert.equal(active.status, 'active');

  // The correction appends v2 as draft (the re-activation gate per version).
  const corrected = await corpus.correctCorpus(aliceScope, corpusId, { niche: 'home fitness equipment v2' });
  assert.equal(corrected.corpusVersion, 2);
  assert.equal(corrected.status, 'draft');
  assert.equal(corrected.niche, 'home fitness equipment v2');
  // v1 keeps its own recorded status (history is append-only).
  const v1 = await corpus.getCorpus(aliceScope, corpusId);
  assert.equal(v1.corpusVersion, 2, 'getCorpus resolves the LATEST version');

  await corpus.activateCorpus(aliceScope, corpusId);
  const retired = await corpus.retireCorpus(aliceScope, corpusId);
  assert.equal(retired.status, 'retired');

  // No resurrection / no skipping: the frozen transitions.
  await assert.rejects(() => corpus.activateCorpus(aliceScope, corpusId), (error: unknown) => {
    assert.ok(error instanceof InvalidRequestError);
    return true;
  });
});

test('LAB-002: a retired corpus refuses new ingestion (existing references keep their recorded version)', async () => {
  const corpusId = await makeCorpus(aliceScope, 'retirement niche');
  await corpus.activateCorpus(aliceScope, corpusId);
  await corpus.retireCorpus(aliceScope, corpusId);
  await assert.rejects(
    () => corpus.registerReference(refInput({ corpusId })),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(String((error as InvalidRequestError).message).includes('retired'));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (a)+(c)+(d) Provider-neutral ingestion, the §4 field set, the dedup fence.
// ---------------------------------------------------------------------------

test('LAB-002: registerReference persists the §4 verbatim Content Reference field set with observation #1 of the tail', async () => {
  const corpusId = await makeCorpus(aliceScope, 'ingestion niche');
  const reference = await corpus.registerReference(refInput({ corpusId }));

  assert.equal(reference.provider, 'youtube');
  assert.equal(reference.providerContentId, 'vid-1');
  assert.equal(reference.canonicalUrl, 'https://www.youtube.com/watch?v=vid-1');
  assert.equal(reference.creatorRef, '@creator');
  assert.equal(reference.publicationTime, '2026-01-15T10:00:00.000Z');
  assert.ok(reference.observationTime >= '2026-09-28', 'the observation timestamp is the ingest instant');
  assert.equal(reference.rightsBasis, 'public_reference');
  assert.equal(reference.collectionMethod, 'mkt-062-web-research');
  assert.equal(reference.collectionVersion, 'v1');
  assert.deepEqual(reference.metadataSnapshot, { title: 'A video', durationSeconds: 61 });
  assert.equal(reference.metadataDigest, DIGEST_A);
  assert.equal(reference.mediaAvailability, 'unknown');
  assert.equal(reference.featureBundleVersion, 'pending', 'the extraction-success dimension starts pending (LAB-003 owns the extraction)');
  assert.equal(reference.contractVersion, LAB_CORPUS_CONTRACT_VERSION);
  assert.equal(reference.corpusId, corpusId);
  assert.equal(reference.corpusVersion, 1, 'the reference pins the corpus version at registration');

  const observations = await corpus.listObservations(aliceScope, reference.referenceId);
  assert.equal(observations.length, 1, 'the first sighting is observation #1 (the tail is complete from birth)');
  assert.equal(observations[0]!.collectionMethod, 'mkt-062-web-research');
  assert.equal(observations[0]!.mediaAvailability, 'unknown');
});

test('LAB-002: THE DEDUP FENCE — re-ingestion of the same (provider, content id) appends an observation on the SAME reference row', async () => {
  const corpusId = await makeCorpus(aliceScope, 'dedup niche');
  const first = await corpus.registerReference(refInput({ corpusId, providerContentId: 'vid-dedup' }));
  const second = await corpus.registerReference(refInput({ corpusId, providerContentId: 'vid-dedup', mediaAvailability: 'available_permitted' }));

  assert.equal(second.referenceId, first.referenceId, 'one reference per (client, provider, provider_content_id), EVER');
  assert.equal(second.mediaAvailability, 'available_permitted', 'the current availability advanced with the re-ingestion sighting');

  const observations = await corpus.listObservations(aliceScope, first.referenceId);
  assert.equal(observations.length, 2, 're-ingestion is an APPENDED observation, never a second row');
  assert.equal(observations[0]!.mediaAvailability, 'unknown');
  assert.equal(observations[1]!.mediaAvailability, 'available_permitted');
});

test('LAB-002: the DB-level dedup backstop — a second reference row for the same provider content is rejected by the UNIQUE fence', async () => {
  const corpusId = await makeCorpus(aliceScope, 'db dedup niche');
  const reference = await corpus.registerReference(refInput({ corpusId, providerContentId: 'vid-unique-fence' }));
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO lab_corpus_references
           (reference_id, corpus_id, corpus_version, agency_id, client_id,
            provider, provider_content_id, canonical_url, observation_time,
            rights_basis, collection_method, collection_version,
            metadata_snapshot, metadata_digest, media_availability,
            contract_version, created_at, updated_at)
         VALUES ($1, $2, 1, $3, $4, 'youtube', 'vid-unique-fence',
                 'https://www.youtube.com/watch?v=x', now(),
                 'public_reference', 'm', 'v1', '{}'::jsonb, $5, 'unknown',
                 'lab-corpus-contract-v1', now(), now())`,
        [reference.referenceId.replace(/.$/, '0'), corpusId, aliceScope.agencyId, aliceScope.clientId, DIGEST_B],
      ),
    (error: unknown) => String(error).includes('duplicate key'),
  );
});

// ---------------------------------------------------------------------------
// (b) The provider-specific acquisition policy gate.
// ---------------------------------------------------------------------------

test('LAB-002: ingestion under an UNDECLARED provider or an UNPERMITTED rights basis is refused', async () => {
  const corpusId = await makeCorpus(aliceScope, 'policy niche');

  await assert.rejects(
    () => corpus.registerReference(refInput({ corpusId, provider: 'vimeo' })),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(String((error as InvalidRequestError).message).includes('not declared in the corpus acquisition policy'));
      return true;
    },
  );

  // tiktok is declared with ONLY 'public_reference' — 'explicit_license' is unpermitted.
  await assert.rejects(
    () => corpus.registerReference(refInput({ corpusId, provider: 'tiktok', rightsBasis: 'explicit_license' })),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(String((error as InvalidRequestError).message).includes('not permitted for provider'));
      return true;
    },
  );

  // The permitted combination passes.
  const ok = await corpus.registerReference(refInput({ corpusId, provider: 'tiktok', rightsBasis: 'public_reference', providerContentId: 'tk-1', canonicalUrl: 'https://www.tiktok.com/@x/video/1' }));
  assert.equal(ok.provider, 'tiktok');
});

// ---------------------------------------------------------------------------
// (e) Observation timestamps — the append-only tail.
// ---------------------------------------------------------------------------

test('LAB-002: recordObservation appends the tail and advances the current availability (the pairing discipline)', async () => {
  const corpusId = await makeCorpus(aliceScope, 'observation niche');
  const reference = await corpus.registerReference(refInput({ corpusId, providerContentId: 'vid-obs' }));

  const observed = await corpus.recordObservation({
    scope: aliceScope,
    referenceId: reference.referenceId,
    collectionMethod: 'mkt-056-youtube-adapter',
    collectionVersion: 'v2',
    metadataDigest: DIGEST_A,
    mediaAvailability: 'provider_unavailable',
  });
  assert.ok(observed.observedAt >= reference.observationTime, 'observedAt defaults to the module clock (never before the first sighting)');

  const refreshed = await corpus.getReference(aliceScope, reference.referenceId);
  assert.equal(refreshed.mediaAvailability, 'provider_unavailable', 'the LATEST sighting state is on the reference');

  const tail = await corpus.listObservations(aliceScope, reference.referenceId);
  assert.equal(tail.length, 2, 'the registration sighting + the appended observation');
  assert.ok(tail[0]!.observedAt <= tail[1]!.observedAt, 'the observation tail is time-ordered');
});

// ---------------------------------------------------------------------------
// (f) Coverage reporting over the real schema.
// ---------------------------------------------------------------------------

test('LAB-002: the coverage report measures coverage/freshness/duplication/accessibility/extraction (EXECUTION-PLAN §11)', async () => {
  const corpusId = await makeCorpus(aliceScope, 'coverage niche');
  await corpus.registerReference(refInput({ corpusId, provider: 'youtube', providerContentId: 'cov-1', metadataDigest: DIGEST_A, mediaAvailability: 'available_permitted' }));
  await corpus.registerReference(refInput({ corpusId, provider: 'tiktok', providerContentId: 'cov-2', canonicalUrl: 'https://www.tiktok.com/@x/video/2', rightsBasis: 'public_reference', metadataDigest: DIGEST_A }));
  await corpus.registerReference(refInput({ corpusId, provider: 'youtube', providerContentId: 'cov-3', metadataDigest: DIGEST_B, mediaAvailability: 'provider_unavailable' }));
  // Re-ingest cov-2 once — a third observation on the same reference.
  await corpus.registerReference(refInput({ corpusId, provider: 'tiktok', providerContentId: 'cov-2', canonicalUrl: 'https://www.tiktok.com/@x/video/2', rightsBasis: 'public_reference', metadataDigest: DIGEST_A, mediaAvailability: 'withdrawn' }));

  const report = await corpus.coverageReport(aliceScope, corpusId);
  assert.equal(report.totalReferences, 3, 'coverage: three distinct provider content items');
  assert.deepEqual(report.byProvider, { youtube: 2, tiktok: 1 });
  assert.deepEqual(report.byMediaAvailability, { available_permitted: 1, provider_unavailable: 1, withdrawn: 1 }, 'accessibility: only OBSERVED availability states appear (zero-count states are absent — measured, never assumed)');
  assert.equal(report.extractedReferences, 0, 'extraction success: nothing extracted yet (LAB-003 pending)');
  assert.equal(report.pendingExtractionReferences, 3);
  assert.equal(report.digestCollisionGroups, 1, 'duplication: cov-1 + cov-2 share the same metadata digest (cross-provider duplicate group)');
  assert.equal(report.totalObservations, 4, 'freshness: 4 sightings total (cov-2 observed twice)');
  assert.ok(report.oldestObservationAt !== null && report.newestObservationAt !== null);
  assert.ok(report.oldestObservationAt! <= report.newestObservationAt!);
  assert.equal(report.corpusVersion, 1);
  assert.ok(report.computedAt >= '2026-09-28');
});

// ---------------------------------------------------------------------------
// (§22) Tenant isolation — the uniform NotFound fence.
// ---------------------------------------------------------------------------

test("LAB-002: tenant isolation — Bob can never read or ingest into Alice's corpus (uniform NotFound, no existence oracle)", async () => {
  const corpusId = await makeCorpus(aliceScope, 'isolation niche');
  const reference = await corpus.registerReference(refInput({ corpusId, providerContentId: 'vid-iso' }));

  await assert.rejects(() => corpus.getCorpus(bobScope, corpusId), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    return true;
  });
  await assert.rejects(
    () => corpus.registerReference(refInput({ scope: bobScope, corpusId, providerContentId: 'vid-bob' })),
    (error: unknown) => {
      assert.ok(error instanceof NotFoundError, 'foreign-scope ingestion resolves to the uniform NotFound before any write');
      return true;
    },
  );
  await assert.rejects(() => corpus.getReference(bobScope, reference.referenceId), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    return true;
  });
  await assert.rejects(() => corpus.listObservations(bobScope, reference.referenceId), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    return true;
  });
  await assert.rejects(() => corpus.coverageReport(bobScope, corpusId), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    return true;
  });

  const bobList = await corpus.listCorpora(bobScope);
  assert.equal(bobList.length, 0, "Bob's corpus list never reveals Alice's corpora");
});

// ---------------------------------------------------------------------------
// (g) No unauthorized media retention — the DB backstops.
// ---------------------------------------------------------------------------

test('LAB-002: observations are append-only OUTRIGHT (UPDATE and DELETE rejected by the migration-061 triggers)', async () => {
  const corpusId = await makeCorpus(aliceScope, 'append-only niche');
  const reference = await corpus.registerReference(refInput({ corpusId, providerContentId: 'vid-appendonly' }));
  const observationId = (await corpus.listObservations(aliceScope, reference.referenceId))[0]!.observationId;

  await assert.rejects(
    () => db!.query(`UPDATE lab_corpus_observations SET media_availability = 'available_permitted' WHERE observation_id = $1`, [observationId]),
    (error: unknown) => String(error).includes('append-only'),
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM lab_corpus_observations WHERE observation_id = $1`, [observationId]),
    (error: unknown) => String(error).includes('append-only'),
  );
});

test('LAB-002: reference identity is immutable — only the availability/feature-bundle columns may advance (guarded UPDATE trigger)', async () => {
  const corpusId = await makeCorpus(aliceScope, 'immutable niche');
  const reference = await corpus.registerReference(refInput({ corpusId, providerContentId: 'vid-immutable' }));

  await assert.rejects(
    () => db!.query(`UPDATE lab_corpus_references SET canonical_url = 'https://example.com/changed' WHERE reference_id = $1`, [reference.referenceId]),
    (error: unknown) => String(error).includes('immutable'),
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM lab_corpus_references WHERE reference_id = $1`, [reference.referenceId]),
    (error: unknown) => String(error).includes('append-only'),
  );
  // The sanctioned advance pair still works at the DB level (the module
  // performs exactly this update with the paired observation insert).
  const advanced = await db!.query(
    `UPDATE lab_corpus_references SET feature_bundle_version = 'lab-feature-v1', updated_at = now() WHERE reference_id = $1 RETURNING reference_id`,
    [reference.referenceId],
  );
  assert.equal(advanced.rowCount, 1, 'the LAB-003 extraction seam (feature_bundle_version) is the sanctioned advance');
});

test('LAB-002: NO MEDIA BYTES ANYWHERE — no binary/bytea column exists on any lab_corpus_* table (the schema is the proof)', async () => {
  const r = await db!.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_name IN ('lab_corpus_versions', 'lab_corpus_references', 'lab_corpus_observations')
        AND data_type IN ('bytea', 'blob', 'binary', 'varbinary')`,
  );
  assert.equal(r.rows.length, 0, 'the durable corpus is references + metadata + provenance + observation history ONLY (§4 reference-first)');
});

test('LAB-002: the cross-tenant scope-consistency backstops reject mismatched clients at the DB level (§22)', async () => {
  const corpusId = await makeCorpus(aliceScope, 'scope fence niche');
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO lab_corpus_references
           (reference_id, corpus_id, corpus_version, agency_id, client_id,
            provider, provider_content_id, canonical_url, observation_time,
            rights_basis, collection_method, collection_version,
            metadata_snapshot, metadata_digest, media_availability,
            contract_version, created_at, updated_at)
         VALUES ($1, $2, 1, $3, $4, 'youtube', 'scope-fence-1',
                 'https://www.youtube.com/watch?v=sf', now(),
                 'public_reference', 'm', 'v1', '{}'::jsonb, $5, 'unknown',
                 'lab-corpus-contract-v1', now(), now())`,
        [aliceScope.agencyId, corpusId, aliceScope.agencyId, bobScope.clientId, DIGEST_B],
      ),
    (error: unknown) => String(error).includes('cross-tenant'),
  );
});
