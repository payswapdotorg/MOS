/**
 * LAB-003 integration tests — the /lab-features Multimodal Content
 * Feature Bundle against a REAL embedded PostgreSQL stack (the
 * LAB-001/LAB-002 module-level harness: real PgDb + real users/
 * agencies/clients public contracts + the REAL /lab-corpus module for
 * the advance-seam proof, the features module under test composed
 * exactly as the composition root wires it — platform ports + the
 * two replaceable Lab ports).
 *
 * The acceptance battery (spec/effective-backlog-v1.7.md LAB-003:
 * "reproducible feature identity/versioning, source linkage, batch
 * extraction, failure states, tenant isolation"):
 *   (a) reproducible feature identity/versioning — the deterministic
 *       identity digest (same input → same identity, across module
 *       instances), idempotent re-extraction
 *       (skipped/already_extracted citing the existing bundle) and
 *       the append-only per-reference version chain (a changed input
 *       is a NEW bundle version, never an in-place rewrite);
 *   (b) source linkage — every bundle carries the FULL citation data
 *       (referenceId, corpus binding, provider, providerContentId,
 *       canonicalUrl, the metadata digest, the availability observed
 *       at extraction time) as recorded data;
 *   (c) batch extraction — the bounded batch, exactly ONE outcome per
 *       item, the SQL-computed summary counts (the CHECK fence) and
 *       the append-only outcome tail;
 *   (d) failure states — the closed failure vocabulary exercised
 *       end-to-end (invalid_input, scope_mismatch,
 *       unsupported_modality, media_unavailable, rights_not_permitted,
 *       encoder_unavailable, extraction_error) + the closed skip
 *       vocabulary (duplicate_citation_in_batch, already_extracted);
 *   (e) the optional ephemeral media access — the fail-closed grant
 *       gate BEFORE any bytes (the pending first-party port + a
 *       byte-granting test double proving the in-memory handle rides
 *       the call and NOTHING persists: no binary column exists on
 *       any lab_feature_* table, asserted directly);
 *   (f) tenant isolation (§22) — the uniform NotFound for foreign
 *       scope (no existence oracle), the recorded-client
 *       scope_mismatch fence and the DB-level cross-tenant injection
 *       triggers;
 *   (g) the DB backstops — bundle/item append-only outright, the run
 *       guard, the feature-accounting CHECK;
 *   (h) THE CORPUS ADVANCE SEAM (DISCLOSED, not implemented): a REAL
 *       /lab-corpus reference extracted by this module keeps its
 *       feature_bundle_version 'pending' — the advance is the TL's
 *       LAB-004/005 integration, and the bundle reference this module
 *       produces is exactly what that integration would write.
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
import { createWorkspacesModule } from '../../src/modules/workspaces/public.ts';
import { createLabCorpusModule } from '../../src/modules/lab-corpus/public.ts';
import {
  createLabFeaturesModule,
  createFirstPartyLabFeatureExtractor,
  createPendingLabMediaFetchPort,
  LAB_FEATURES_CONTRACT_VERSION,
  LAB_FEATURE_SET_VERSION,
  FIRST_PARTY_EXTRACTOR_ID,
  FIRST_PARTY_EXTRACTOR_VERSION,
  computeLabFeatureIdentityDigest,
  computeLabFeatureInputDigest,
} from '../../src/modules/lab-features/public.ts';
import type {
  LabFeaturesModuleApi,
  LabFeaturesScope,
  LabFeatureBatchItem,
  LabFeatureReferenceCitation,
  LabFeatureExtractor,
  LabMediaFetchPort,
  LabMediaFetchOutcome,
  LabFeatureValueMap,
} from '../../src/modules/lab-features/public.ts';
import { NotFoundError } from '../../src/platform/errors/errors.ts';

let stack: IntegrationStack | null = null;
let db: PgDb | null = null;
let clock: SystemClock | null = null;
let ids: CryptoIdGenerator | null = null;

let features: LabFeaturesModuleApi = null as unknown as LabFeaturesModuleApi;
let corpus: ReturnType<typeof createLabCorpusModule> = null as unknown as ReturnType<typeof createLabCorpusModule>;
let users: ReturnType<typeof createUsersModule> = null as unknown as ReturnType<typeof createUsersModule>;
let agencies: ReturnType<typeof createAgenciesModule> = null as unknown as ReturnType<typeof createAgenciesModule>;
let clients: ReturnType<typeof createClientsModule> = null as unknown as ReturnType<typeof createClientsModule>;
let workspaces: ReturnType<typeof createWorkspacesModule> = null as unknown as ReturnType<typeof createWorkspacesModule>;

const aliceScope: LabFeaturesScope = { agencyId: '', clientId: '' };
const bobScope: LabFeaturesScope = { agencyId: '', clientId: '' };
let aliceWorkspaceId: string | null = null;

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

function citation(overrides: Partial<LabFeatureReferenceCitation> = {}): LabFeatureReferenceCitation {
  return {
    referenceId: '00000000-0000-0000-0000-0000000000aa',
    clientId: aliceScope.clientId,
    corpusId: '00000000-0000-0000-0000-000000000003',
    corpusVersion: 1,
    provider: 'youtube',
    providerContentId: 'vid-123',
    canonicalUrl: 'https://www.youtube.com/watch?v=vid-123',
    metadataDigest: DIGEST_A,
    metadataSnapshot: {
      title: '3 Genius Home Gym Hacks #fitness',
      description: 'Save space and money #gear',
      durationSeconds: 61,
      viewCount: 12_000,
      likeCount: 340,
      language: 'en',
    },
    mediaAvailability: 'unknown',
    ...overrides,
  };
}

function batch(items: ReadonlyArray<LabFeatureBatchItem>): Parameters<LabFeaturesModuleApi['extractBatch']>[0] {
  return { scope: aliceScope, items };
}

/** A byte-granting test-double media port (the in-memory handle discipline). */
function grantingMediaPort(): LabMediaFetchPort {
  return {
    async fetchMedia(): Promise<LabMediaFetchOutcome> {
      const bytes = new Uint8Array(2048);
      return { status: 'granted', handle: { byteLength: bytes.byteLength, readAll: () => bytes } };
    },
  };
}

/** A refusing test-double media port (the provider-side constraints — §4). */
function refusingMediaPort(reason: 'media_unavailable' | 'rights_not_permitted'): LabMediaFetchPort {
  return {
    async fetchMedia(): Promise<LabMediaFetchOutcome> {
      return { status: 'refused', reason, detail: `test-double refusal: ${reason}` };
    },
  };
}

/** A throwing extractor test double (the extraction_error path). */
function throwingExtractor(): LabFeatureExtractor {
  const base = createFirstPartyLabFeatureExtractor();
  return {
    ...base,
    async extract(): Promise<never> {
      throw new Error('test-double extractor failure');
    },
  };
}

/** A terminal-failure extractor test double (the encoder_unavailable item path). */
function encoderUnavailableExtractor(): LabFeatureExtractor {
  const base = createFirstPartyLabFeatureExtractor();
  return {
    ...base,
    async extract() {
      return { reason: 'encoder_unavailable' as const, detail: 'test-double: the requested encoder is not wired' };
    },
  };
}

before(async () => {
  stack = await bootStack('lab_features');
  db = new PgDb(stack.env.databaseUrl, 4);
  clock = new SystemClock();
  ids = new CryptoIdGenerator();
  users = createUsersModule({ db, clock, ids });
  agencies = createAgenciesModule({ db, clock, ids, users });
  clients = createClientsModule({ db, clock, ids, agencies });
  workspaces = createWorkspacesModule({ db, clock, ids, clients });
  corpus = createLabCorpusModule({ db, clock, ids });
  features = createLabFeaturesModule({
    db,
    clock,
    ids,
    extractor: createFirstPartyLabFeatureExtractor(),
    mediaFetch: createPendingLabMediaFetchPort(),
  });

  const aliceUser = await users.createUser({ email: 'alice@labfeatures.test', displayName: 'Alice' });
  const aliceAgency = await agencies.createAgency({ name: 'Alice Agency', slug: 'alice-features', ownerUserId: aliceUser.userId, actorId: null });
  const aliceClient = await clients.createClient({ agencyId: aliceAgency.agency.agencyId, name: 'Alice Client', slug: 'alice-client', actorId: null });
  aliceScope.agencyId = aliceAgency.agency.agencyId;
  aliceScope.clientId = aliceClient.clientId;
  const workspace = await workspaces.createWorkspace({ clientId: aliceClient.clientId, name: 'Alice WS', slug: undefined, actorId: null });
  aliceWorkspaceId = workspace.workspaceId;

  const bobUser = await users.createUser({ email: 'bob@labfeatures.test', displayName: 'Bob' });
  const bobAgency = await agencies.createAgency({ name: 'Bob Agency', slug: 'bob-features', ownerUserId: bobUser.userId, actorId: null });
  const bobClient = await clients.createClient({ agencyId: bobAgency.agency.agencyId, name: 'Bob Client', slug: 'bob-client', actorId: null });
  bobScope.agencyId = bobAgency.agency.agencyId;
  bobScope.clientId = bobClient.clientId;
});

after(async () => {
  if (db !== null) await db.close();
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// (a) Reproducible feature identity/versioning + the version chain.
// ---------------------------------------------------------------------------

test('LAB-003: the batch extraction happy path — the honest feature accounting (27 keys), the source linkage and the deterministic identity', async () => {
  const run = await features.extractBatch(batch([{ citation: citation() }]));
  assert.equal(run.status, 'completed');
  assert.equal(run.itemCount, 1);
  assert.equal(run.extractedCount, 1);
  assert.equal(run.failedCount, 0);
  assert.equal(run.skippedCount, 0);
  assert.equal(run.contractVersion, LAB_FEATURES_CONTRACT_VERSION);
  assert.equal(run.featureSetVersion, LAB_FEATURE_SET_VERSION);
  assert.equal(run.extractorId, FIRST_PARTY_EXTRACTOR_ID);
  assert.equal(run.extractorVersion, FIRST_PARTY_EXTRACTOR_VERSION);

  const item = run.items[0]!;
  assert.equal(item.outcome, 'extracted');
  assert.equal(item.seq, 1);
  assert.equal(item.failureReason, null);
  assert.equal(item.skipReason, null);
  assert.ok(item.bundleId !== null);

  const bundle = await features.getBundle(aliceScope, item.bundleId!);
  // THE FEATURE ACCOUNTING: exactly the closed 27-key set.
  assert.equal(bundle.derivedFeatureCount + bundle.unavailableFeatureCount, 27);
  assert.equal(Object.keys(bundle.features).length, 27);
  const values = bundle.features as LabFeatureValueMap;
  // The honest deterministic derivations from the recorded snapshot.
  assert.equal((values['duration'] as { state: string }).state, 'derived');
  assert.equal((values['engagement'] as { state: string }).state, 'derived');
  assert.equal((values['title_description_hashtag_semantics'] as { state: string }).state, 'derived');
  assert.equal((values['language'] as { state: string }).state, 'derived');
  // The honest unavailable states (encoder/media/history/corpus grades).
  assert.equal((values['text_embedding'] as { state: string; reason: string }).reason, 'encoder_unavailable');
  assert.equal((values['pacing'] as { state: string; reason: string }).reason, 'requires_media_access');
  assert.equal((values['performance_velocity'] as { state: string; reason: string }).reason, 'requires_observation_history');
  assert.equal((values['novelty_reuse_risk'] as { state: string; reason: string }).reason, 'requires_corpus_context');

  // THE SOURCE LINKAGE (recorded citation data, never a join).
  assert.equal(bundle.referenceId, citation().referenceId);
  assert.equal(bundle.corpusId, citation().corpusId);
  assert.equal(bundle.corpusVersion, 1);
  assert.equal(bundle.provider, 'youtube');
  assert.equal(bundle.providerContentId, 'vid-123');
  assert.equal(bundle.canonicalUrl, 'https://www.youtube.com/watch?v=vid-123');
  assert.equal(bundle.metadataDigest, DIGEST_A);
  assert.equal(bundle.mediaAvailabilityAtExtraction, 'unknown');
  assert.equal(bundle.grantPosture, 'metadata_only');
  assert.equal(bundle.mediaFetchStatus, 'not_requested');

  // THE DETERMINISTIC IDENTITY: the recorded digest equals the pure function.
  const expectedInputDigest = computeLabFeatureInputDigest({ citation: citation(), mediaGrant: undefined, configuration: {} });
  const expectedIdentity = computeLabFeatureIdentityDigest({
    referenceIdentity: {
      referenceId: citation().referenceId,
      corpusId: citation().corpusId,
      corpusVersion: 1,
      provider: 'youtube',
      providerContentId: 'vid-123',
      canonicalUrl: 'https://www.youtube.com/watch?v=vid-123',
      metadataDigest: DIGEST_A,
    },
    featureSetVersion: LAB_FEATURE_SET_VERSION,
    extractorIdentity: { extractorId: FIRST_PARTY_EXTRACTOR_ID, extractorVersion: FIRST_PARTY_EXTRACTOR_VERSION },
    inputDigest: expectedInputDigest,
  });
  assert.equal(bundle.inputDigest, expectedInputDigest);
  assert.equal(bundle.identityDigest, expectedIdentity);
  assert.equal(bundle.bundleVersion, 1);
  assert.equal(bundle.bundleReference, `${bundle.bundleId}#v1`);
});

test('LAB-003: idempotent re-extraction — the same deterministic identity is skipped/already_extracted citing the existing bundle (a NEW module instance reproduces the same identity)', async () => {
  // A SECOND module instance (the pure-function proof: identity does not
  // depend on instance state).
  const features2 = createLabFeaturesModule({
    db: db!,
    clock: clock!,
    ids: ids!,
    extractor: createFirstPartyLabFeatureExtractor(),
    mediaFetch: createPendingLabMediaFetchPort(),
  });
  const run = await features2.extractBatch(batch([{ citation: citation() }]));
  assert.equal(run.extractedCount, 0);
  assert.equal(run.skippedCount, 1);
  const item = run.items[0]!;
  assert.equal(item.outcome, 'skipped');
  assert.equal(item.skipReason, 'already_extracted');
  assert.ok(item.bundleId !== null);
  const bundle = await features.getBundle(aliceScope, item.bundleId!);
  assert.equal(bundle.bundleVersion, 1, 'no second row — the deterministic identity is the idempotence fence');

  // The chain read (the corpus advance seam surface): one version so far.
  const chain = await features.listBundles(aliceScope, citation().referenceId);
  assert.equal(chain.length, 1);
  assert.equal(chain[0]!.bundleReference, `${item.bundleId}#v1`);
});

test('LAB-003: the append-only version chain — a changed input (a new observation digest) is a NEW bundle version, never an in-place rewrite', async () => {
  const changed = citation({
    metadataDigest: DIGEST_B,
    metadataSnapshot: { ...citation().metadataSnapshot, viewCount: 15_000 },
  });
  const run = await features.extractBatch(batch([{ citation: changed }]));
  assert.equal(run.extractedCount, 1);
  const item = run.items[0]!;
  const bundle2 = await features.getBundle(aliceScope, item.bundleId!);
  assert.equal(bundle2.bundleVersion, 2, 'the changed input appends version 2 on the same reference chain');
  assert.equal(bundle2.metadataDigest, DIGEST_B);

  const chain = await features.listBundles(aliceScope, citation().referenceId);
  assert.equal(chain.length, 2);
  assert.equal(chain[0]!.bundleVersion, 2, 'newest first');
  assert.equal(chain[1]!.bundleVersion, 1);
  // Version 1 stays intact (never rewritten).
  const stillV1 = await features.getBundle(aliceScope, chain[1]!.bundleId);
  assert.equal(stillV1.metadataDigest, DIGEST_A);
  assert.equal((stillV1.features as LabFeatureValueMap)['engagement'] !== undefined, true);
});

// ---------------------------------------------------------------------------
// (b) The failure states + the skip vocabulary (the closed vocabulary battery).
// ---------------------------------------------------------------------------

test('LAB-003: the closed failure vocabulary end-to-end — invalid_input, scope_mismatch, unsupported_modality, the media gate and the duplicates', async () => {
  const malformed = { citation: { ...citation(), provider: 'BAD' } };
  const foreign = { citation: citation({ clientId: bobScope.clientId, referenceId: '00000000-0000-0000-0000-0000000000f1', providerContentId: 'foreign-1' }) };
  const needsAudio = { citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000f2', providerContentId: 'needs-audio-1' }) };
  const unknownAvailability = { citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000f3', providerContentId: 'unknown-avail-1' }), mediaGrant: { availability: 'unknown' as const, posture: 'reference_gated' as const } };
  const withdrawn = { citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000f4', providerContentId: 'withdrawn-1' }), mediaGrant: { availability: 'withdrawn' as const, posture: 'reference_gated' as const } };
  const rightsUnclear = { citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000f5', providerContentId: 'rights-unclear-1' }), mediaGrant: { availability: 'available_rights_unclear' as const, posture: 'reference_gated' as const } };
  const metadataOnlyPosture = { citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000f6', providerContentId: 'metadata-only-1' }), mediaGrant: { availability: 'available_permitted' as const, posture: 'metadata_only' as const } };
  const duplicate = { citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000f7', providerContentId: 'dup-1' }) };

  const run = await features.extractBatch({
    scope: aliceScope,
    items: [
      malformed as LabFeatureBatchItem,
      foreign,
      needsAudio,
      unknownAvailability,
      withdrawn,
      rightsUnclear,
      metadataOnlyPosture,
      duplicate,
      duplicate,
    ],
    configuration: { requiredModalities: ['audio'] },
  });
  assert.equal(run.itemCount, 9);
  assert.equal(run.extractedCount, 0);
  assert.equal(run.failedCount, 8);
  assert.equal(run.skippedCount, 1);
  // Exactly ONE outcome per item, in the deterministic batch order.
  assert.deepEqual(
    run.items.map((item) => [item.seq, item.outcome, item.failureReason ?? item.skipReason]),
    [
      [1, 'failed', 'invalid_input'],
      [2, 'failed', 'scope_mismatch'],
      [3, 'failed', 'unsupported_modality'],
      [4, 'failed', 'media_unavailable'],
      [5, 'failed', 'media_unavailable'],
      [6, 'failed', 'rights_not_permitted'],
      [7, 'failed', 'rights_not_permitted'],
      [8, 'failed', 'unsupported_modality'],
      [9, 'skipped', 'duplicate_citation_in_batch'],
    ],
  );
  // The honest error surface carries the bounded detail.
  for (const item of run.items.filter((i) => i.outcome === 'failed')) {
    assert.ok(item.errorDetail !== null && item.errorDetail.length > 0);
    assert.equal(item.bundleId, null);
  }
  // The invalid_input item's echo is honestly null for the malformed field.
  assert.equal(run.items[0]!.provider, null);
  // The scope_mismatch item never wrote a bundle row for the foreign reference.
  assert.equal(await db!.query('SELECT count(*)::int AS n FROM lab_feature_bundles WHERE reference_id = $1', ['00000000-0000-0000-0000-0000000000f1']).then((r) => r.rows[0]!.n), 0);
  // NOTE: items 3 + 8 both fail unsupported_modality: the required-modality
  // gate is per-item and the duplicate gate runs BEFORE the modality gate,
  // so item 8 (the first of the duplicate pair) failed the modality gate
  // and item 9 (the second) skipped as the duplicate.
});

test('LAB-003: the extractor-port failure paths — a thrown error is extraction_error; a terminal encoder failure is encoder_unavailable (never invented success)', async () => {
  const throwing = createLabFeaturesModule({
    db: db!,
    clock: clock!,
    ids: ids!,
    extractor: throwingExtractor(),
    mediaFetch: createPendingLabMediaFetchPort(),
  });
  const run1 = await throwing.extractBatch(batch([{ citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000e1', providerContentId: 'throw-1', metadataDigest: DIGEST_C }) }]));
  assert.equal(run1.items[0]!.outcome, 'failed');
  assert.equal(run1.items[0]!.failureReason, 'extraction_error');
  assert.ok(run1.items[0]!.errorDetail!.includes('test-double extractor failure'));

  const noEncoder = createLabFeaturesModule({
    db: db!,
    clock: clock!,
    ids: ids!,
    extractor: encoderUnavailableExtractor(),
    mediaFetch: createPendingLabMediaFetchPort(),
  });
  const run2 = await noEncoder.extractBatch(batch([{ citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000e2', providerContentId: 'no-encoder-1', metadataDigest: DIGEST_C }) }]));
  assert.equal(run2.items[0]!.outcome, 'failed');
  assert.equal(run2.items[0]!.failureReason, 'encoder_unavailable');
});

// ---------------------------------------------------------------------------
// (c) The optional ephemeral media access — the gate, the pending port, the granted handle.
// ---------------------------------------------------------------------------

test('LAB-003: the pending first-party media port — a validated grant opens the path, the honest pending state is recorded, media-grade features stay honestly unavailable', async () => {
  const run = await features.extractBatch(batch([{
    citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000a1', providerContentId: 'media-pending-1', mediaAvailability: 'available_permitted', metadataDigest: DIGEST_C }),
    mediaGrant: { availability: 'available_permitted', posture: 'reference_gated' },
  }]));
  assert.equal(run.extractedCount, 1);
  const bundle = await features.getBundle(aliceScope, run.items[0]!.bundleId!);
  assert.equal(bundle.grantPosture, 'reference_gated');
  assert.equal(bundle.mediaFetchStatus, 'pending');
  assert.equal(bundle.mediaFetchBytes, null);
  assert.ok(bundle.mediaFetchDetail!.includes('no provider media adapter is wired'));
  // The metadata-grade features still derived; the media-grade honest.
  const values = bundle.features as LabFeatureValueMap;
  assert.equal((values['duration'] as { state: string }).state, 'derived');
  assert.equal((values['pacing'] as { state: string; reason: string }).reason, 'encoder_unavailable', 'the path opened but no decoder is wired — the honest state');
});

test('LAB-003: a granted byte handle rides the extraction call ONLY — the byte length is recorded, NO bytes persist anywhere (the schema proof)', async () => {
  const granting = createLabFeaturesModule({
    db: db!,
    clock: clock!,
    ids: ids!,
    extractor: createFirstPartyLabFeatureExtractor(),
    mediaFetch: grantingMediaPort(),
  });
  const run = await granting.extractBatch(batch([{
    citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000a2', providerContentId: 'media-granted-1', mediaAvailability: 'available_permitted', metadataDigest: DIGEST_C }),
    mediaGrant: { availability: 'available_permitted', posture: 'reference_gated' },
  }]));
  assert.equal(run.extractedCount, 1);
  const bundle = await features.getBundle(aliceScope, run.items[0]!.bundleId!);
  assert.equal(bundle.mediaFetchStatus, 'granted');
  assert.equal(bundle.mediaFetchBytes, 2048);
  // The media-grade features stay honestly unavailable (no decoder wired).
  assert.equal((bundle.features as LabFeatureValueMap)['visual_composition'] !== undefined, true);

  // THE STRUCTURAL NO-MEDIA PROOF: no binary column exists on any
  // lab_feature_* table (information_schema) — the bytes cannot have
  // persisted even if the extractor had tried.
  const columns = await db!.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_name LIKE 'lab\\_feature\\_%'`,
  );
  assert.ok(columns.rows.length > 0);
  for (const column of columns.rows) {
    assert.ok(
      !['bytea', 'blob', 'binary', 'bytea[]'].includes(column.data_type),
      `no binary column may exist on ${column.table_name}.${column.column_name} (found ${column.data_type})`,
    );
  }
});

test('LAB-003: a port refusal fails the item with the port reason (the provider-side constraints, §4)', async () => {
  const refusing = createLabFeaturesModule({
    db: db!,
    clock: clock!,
    ids: ids!,
    extractor: createFirstPartyLabFeatureExtractor(),
    mediaFetch: refusingMediaPort('rights_not_permitted'),
  });
  const run = await refusing.extractBatch(batch([{
    citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000a3', providerContentId: 'media-refused-1', metadataDigest: DIGEST_C }),
    mediaGrant: { availability: 'available_permitted', posture: 'reference_gated' },
  }]));
  assert.equal(run.failedCount, 1);
  assert.equal(run.items[0]!.failureReason, 'rights_not_permitted');
  assert.ok(run.items[0]!.errorDetail!.includes('test-double refusal'));
});

// ---------------------------------------------------------------------------
// (d) Tenant isolation (§22) + the DB backstops.
// ---------------------------------------------------------------------------

test('LAB-003: tenant isolation — the uniform NotFound for foreign scope, no existence oracle', async () => {
  const aliceRun = await features.extractBatch(batch([{ citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000b1', providerContentId: 'iso-1', metadataDigest: DIGEST_C }) }]));
  const bundleId = aliceRun.items[0]!.bundleId!;
  // Bob cannot read Alice's bundle or run — the uniform NotFound.
  await assert.rejects(() => features.getBundle(bobScope, bundleId), NotFoundError);
  await assert.rejects(() => features.getBatchRun(bobScope, aliceRun.runId), NotFoundError);
  await assert.rejects(() => features.getBundle(bobScope, '00000000-0000-0000-0000-0000000000zz'), NotFoundError);
  // Bob's list surfaces are empty for Alice's reference (no oracle).
  assert.equal((await features.listBundles(bobScope, citation({ referenceId: '00000000-0000-0000-0000-0000000000b1', providerContentId: 'iso-1' }).referenceId)).length, 0);
  assert.equal((await features.listBatchRuns(bobScope)).length, 0);
  // Bob CAN extract his own reference under his own scope (with a
  // recorded client that matches).
  const bobRun = await features.extractBatch({
    scope: bobScope,
    items: [{ citation: citation({ clientId: bobScope.clientId, referenceId: '00000000-0000-0000-0000-0000000000b2', providerContentId: 'bob-1', metadataDigest: DIGEST_C }) }],
  });
  assert.equal(bobRun.extractedCount, 1);
  // A workspace-anchored batch records the workspace on the bundle.
  const wsRun = await features.extractBatch({
    scope: { ...aliceScope, workspaceId: aliceWorkspaceId },
    items: [{ citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000b3', providerContentId: 'ws-1', metadataDigest: DIGEST_C }) }],
  });
  const wsBundle = await features.getBundle({ ...aliceScope, workspaceId: aliceWorkspaceId }, wsRun.items[0]!.bundleId!);
  assert.equal(wsBundle.workspaceId, aliceWorkspaceId);
});

test('LAB-003: the DB backstops — bundles and item outcomes are append-only outright; the run guard fences identity; the scope triggers reject cross-tenant injection', async () => {
  const run = await features.extractBatch(batch([{ citation: citation({ referenceId: '00000000-0000-0000-0000-0000000000d1', providerContentId: 'db-1', metadataDigest: DIGEST_C }) }]));
  const bundleId = run.items[0]!.bundleId!;
  const itemId = run.items[0]!.itemId;
  // Bundles: UPDATE + DELETE both rejected.
  await assert.rejects(() => db!.query(`UPDATE lab_feature_bundles SET derived_feature_count = 0 WHERE bundle_id = $1`, [bundleId]));
  await assert.rejects(() => db!.query(`DELETE FROM lab_feature_bundles WHERE bundle_id = $1`, [bundleId]));
  // Item outcomes: UPDATE + DELETE both rejected.
  await assert.rejects(() => db!.query(`UPDATE lab_feature_batch_items SET outcome = 'skipped' WHERE item_id = $1`, [itemId]));
  await assert.rejects(() => db!.query(`DELETE FROM lab_feature_batch_items WHERE item_id = $1`, [itemId]));
  // The run guard: identity columns immutable; the reopen transition rejected.
  await assert.rejects(() => db!.query(`UPDATE lab_feature_batch_runs SET item_count = 99 WHERE run_id = $1`, [run.runId]));
  await assert.rejects(() => db!.query(`UPDATE lab_feature_batch_runs SET status = 'running' WHERE run_id = $1`, [run.runId]));
  // The scope-consistency trigger: a cross-tenant bundle injection is rejected.
  await assert.rejects(() =>
    db!.query(
      `INSERT INTO lab_feature_bundles
         (bundle_id, reference_id, bundle_version, agency_id, client_id, workspace_id, run_id,
          corpus_id, corpus_version, provider, provider_content_id, canonical_url, metadata_digest,
          media_availability_at_extraction, grant_posture, media_fetch_status,
          feature_set_version, extractor_id, extractor_version, identity_digest, input_digest,
          required_modalities, features, derived_feature_count, unavailable_feature_count,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, NULL, $5,
               $6, 1, 'youtube', 'inject-1', 'https://x.test/1', $7,
               'unknown', 'metadata_only', 'not_requested',
               'lab-featureset-v1', 'x', '1', $8, $8,
               '{}', '{}', 0, 27,
               'lab-features-contract-v1', now(), now())`,
      [
        '00000000-0000-0000-0000-0000000000d9',
        '00000000-0000-0000-0000-0000000000d1',
        bobScope.agencyId,
        bobScope.clientId,
        run.runId,
        citation().corpusId,
        DIGEST_C,
        'e'.repeat(64),
      ],
    ),
    /must match its creating run client/,
  );
  // The feature-accounting CHECK: 26 ≠ 27 is rejected.
  await assert.rejects(() =>
    db!.query(
      `INSERT INTO lab_feature_bundles
         (bundle_id, reference_id, bundle_version, agency_id, client_id, workspace_id, run_id,
          corpus_id, corpus_version, provider, provider_content_id, canonical_url, metadata_digest,
          media_availability_at_extraction, grant_posture, media_fetch_status,
          feature_set_version, extractor_id, extractor_version, identity_digest, input_digest,
          required_modalities, features, derived_feature_count, unavailable_feature_count,
          contract_version, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, NULL, $5,
               $6, 1, 'youtube', 'check-1', 'https://x.test/2', $7,
               'unknown', 'metadata_only', 'not_requested',
               'lab-featureset-v1', 'x', '1', $8, $8,
               '{}', '{}', 0, 26,
               'lab-features-contract-v1', now(), now())`,
      [
        '00000000-0000-0000-0000-0000000000d8',
        '00000000-0000-0000-0000-0000000000d1',
        aliceScope.agencyId,
        aliceScope.clientId,
        run.runId,
        citation().corpusId,
        DIGEST_C,
        'f'.repeat(64),
      ],
    ),
    /feature_accounting/,
  );
});

test('LAB-003: the batch summary counts are SQL-computed from the item outcomes — the CHECK fence pins the arithmetic', async () => {
  // A mixed batch: one extractable, one invalid, one duplicate of the first.
  const good = citation({ referenceId: '00000000-0000-0000-0000-0000000000c1', providerContentId: 'counts-1', metadataDigest: DIGEST_C });
  const run = await features.extractBatch(batch([
    { citation: good },
    { citation: { ...good, provider: 'BAD' } },
    { citation: good },
  ]));
  assert.equal(run.itemCount, 3);
  assert.equal(run.extractedCount, 1);
  assert.equal(run.failedCount, 1);
  assert.equal(run.skippedCount, 1);
  assert.equal(run.extractedCount + run.failedCount + run.skippedCount, run.itemCount);
  // The stored counts match a fresh aggregate over the outcome rows.
  const aggregate = await db!.query<{ extracted: number; failed: number; skipped: number }>(
    `SELECT count(*) FILTER (WHERE outcome = 'extracted')::int AS extracted,
            count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
            count(*) FILTER (WHERE outcome = 'skipped')::int AS skipped
       FROM lab_feature_batch_items WHERE run_id = $1`,
    [run.runId],
  );
  assert.equal(aggregate.rows[0]!.extracted, run.extractedCount);
  assert.equal(aggregate.rows[0]!.failed, run.failedCount);
  assert.equal(aggregate.rows[0]!.skipped, run.skippedCount);
  // An attempt to write inconsistent counts is CHECK-rejected.
  await assert.rejects(() =>
    db!.query(`UPDATE lab_feature_batch_runs SET failed_count = 99 WHERE run_id = $1`, [run.runId]),
    /counts_sum/,
  );
});

// ---------------------------------------------------------------------------
// (e) THE CORPUS ADVANCE SEAM (DISCLOSED, not implemented): the real
// /lab-corpus reference keeps its 'pending' feature_bundle_version.
// ---------------------------------------------------------------------------

test('LAB-003: THE CORPUS ADVANCE SEAM — a REAL /lab-corpus reference extracted here keeps feature_bundle_version \'pending\' (the advance is the TL\'s integration, the bundle reference is produced)', async () => {
  // A real corpus + reference through the REAL /lab-corpus module.
  const created = await corpus.createCorpus({
    scope: { agencyId: aliceScope.agencyId, clientId: aliceScope.clientId, workspaceId: null },
    niche: 'home fitness equipment',
    platform: 'youtube',
    acquisitionPolicy: {
      version: 'lab-corpus-policy-v1',
      providers: {
        youtube: { permittedBases: ['public_reference', 'provider_api_terms'], mediaAccess: 'reference_gated' },
      },
    },
  });
  const reference = await corpus.registerReference({
    scope: { agencyId: aliceScope.agencyId, clientId: aliceScope.clientId, workspaceId: null },
    corpusId: created.corpusId,
    provider: 'youtube',
    providerContentId: 'advance-seam-1',
    canonicalUrl: 'https://www.youtube.com/watch?v=advance-seam-1',
    creatorRef: '@creator',
    publicationTime: '2026-01-15T10:00:00.000Z',
    rightsBasis: 'public_reference',
    collectionMethod: 'mkt-062-web-research',
    collectionVersion: 'v1',
    metadataSnapshot: { title: 'Advance seam', durationSeconds: 90, viewCount: 500 },
    metadataDigest: '1'.repeat(64),
    mediaAvailability: 'available_permitted',
  });
  assert.equal(reference.featureBundleVersion, 'pending');

  // The citation copied from the real reference record (by reference).
  const run = await features.extractBatch(batch([{
    citation: {
      referenceId: reference.referenceId,
      clientId: reference.clientId,
      corpusId: reference.corpusId,
      corpusVersion: reference.corpusVersion,
      provider: reference.provider,
      providerContentId: reference.providerContentId,
      canonicalUrl: reference.canonicalUrl,
      metadataDigest: reference.metadataDigest,
      metadataSnapshot: reference.metadataSnapshot,
      mediaAvailability: reference.mediaAvailability,
    },
  }]));
  assert.equal(run.extractedCount, 1);
  const bundle = await features.getBundle(aliceScope, run.items[0]!.bundleId!);
  assert.equal(bundle.mediaAvailabilityAtExtraction, 'available_permitted');

  // The seam stays UNTOUCHED: the real reference's column still 'pending'.
  const refreshed = await corpus.getReference(
    { agencyId: aliceScope.agencyId, clientId: aliceScope.clientId, workspaceId: null },
    reference.referenceId,
  );
  assert.equal(refreshed.featureBundleVersion, 'pending', 'the corpus advance seam is NOT implemented by this module (the TL\'s LAB-004/005 integration)');

  // The bundles carry everything the advance needs: the citable
  // reference + the per-reference chain read.
  const chain = await features.listBundles(aliceScope, reference.referenceId);
  assert.equal(chain.length, 1);
  assert.equal(chain[0]!.bundleReference, `${bundle.bundleId}#v1`);
  assert.match(chain[0]!.bundleReference, /^[0-9a-f-]{36}#v1$/);
});
