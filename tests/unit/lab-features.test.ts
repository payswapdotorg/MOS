/**
 * LAB-003 unit tests — the PURE contract guards of /lab-features: the
 * closed, versioned feature-set definition (§5: the 27 keys with the
 * per-modality grouping), the citation/grant/configuration fences, the
 * batch bounds, the value-map NEVER-FABRICATE discipline and the
 * DETERMINISTIC identity derivation (the reproducible-identity
 * acceptance), plus the first-party extractor's honest derivation
 * table (what it CAN derive deterministically vs what it honestly
 * records unavailable, never fabricated).
 *
 * The dispatch's named acceptance proofs (spec/effective-backlog-v1.7.md
 * LAB-003 "reproducible feature identity/versioning, source linkage,
 * batch extraction, failure states, tenant isolation"):
 *   (a) reproducible identity — the pure-function input/identity
 *       digests (same inputs → same digests; ANY identity-relevant
 *       change → a different digest);
 *   (b) source linkage — the citation fences carry the full linkage
 *       field set as recorded data;
 *   (c) batch extraction — the 1-100 bounded list + the closed
 *       outcome/skip vocabularies;
 *   (d) failure states — the closed failure vocabulary + the closed
 *       feature-unavailable reason vocabulary;
 *   (e) tenant isolation — the scope fences (the recorded-client
 *       scope_mismatch gate is exercised in the integration battery);
 *   (f) the honest extractor — the deterministic derivations from the
 *       recorded snapshot + the honest unavailable states for the
 *       encoder/media/history/corpus-grade features.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_FEATURES_BATCH_MAX_ITEMS,
  LAB_FEATURES_BUNDLE_REFERENCE_PATTERN,
  LAB_FEATURES_CONTRACT_VERSION,
  LAB_FEATURE_KEYS,
  LAB_FEATURE_KEY_LIST,
  LAB_FEATURE_MODALITIES,
  LAB_FEATURE_FAILURE_REASONS,
  LAB_FEATURE_ITEM_OUTCOMES,
  LAB_FEATURE_MEDIA_ACCESS_POSTURES,
  LAB_FEATURE_MEDIA_AVAILABILITIES,
  LAB_FEATURE_MEDIA_FETCH_STATUSES,
  LAB_FEATURE_RUN_STATUSES,
  LAB_FEATURE_SKIP_REASONS,
  LAB_FEATURE_UNAVAILABLE_REASONS,
  LAB_FEATURE_VALUE_STATES,
  LAB_FEATURE_SET_VERSION,
  FIRST_PARTY_EXTRACTOR_ID,
  FIRST_PARTY_EXTRACTOR_VERSION,
  assertValidLabFeatureBatchInput,
  assertValidLabFeatureCitation,
  assertValidLabFeatureConfiguration,
  assertValidLabFeatureMediaGrant,
  assertValidLabFeatureValueMap,
  computeLabFeatureIdentityDigest,
  computeLabFeatureInputDigest,
  createFirstPartyLabFeatureExtractor,
  labFeaturesBundleReference,
  labFeaturesCanonicalJson,
} from '../../src/modules/lab-features/public.ts';
import type {
  LabFeatureBatchItem,
  LabFeatureExtractionInput,
  LabFeatureReferenceCitation,
  LabFeatureValueMap,
} from '../../src/modules/lab-features/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const CLIENT_ID = '00000000-0000-0000-0000-000000000002';
const REFERENCE_ID = '00000000-0000-0000-0000-0000000000aa';
const CORPUS_ID = '00000000-0000-0000-0000-000000000003';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function assertInvalid(fn: () => void, fragment: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InvalidRequestError, `expected InvalidRequestError containing '${fragment}'`);
  assert.ok(
    String((caught as InvalidRequestError).message).includes(fragment),
    `message "${String((caught as InvalidRequestError).message)}" should contain '${fragment}'`,
  );
}

function validCitation(overrides: Partial<LabFeatureReferenceCitation> = {}): LabFeatureReferenceCitation {
  return {
    referenceId: REFERENCE_ID,
    clientId: CLIENT_ID,
    corpusId: CORPUS_ID,
    corpusVersion: 1,
    provider: 'youtube',
    providerContentId: 'vid-123',
    canonicalUrl: 'https://www.youtube.com/watch?v=vid-123',
    metadataDigest: DIGEST_A,
    metadataSnapshot: { title: 'A video', durationSeconds: 61 },
    mediaAvailability: 'unknown',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) The closed, versioned feature-set definition (§5).
// ---------------------------------------------------------------------------

test('LAB-003: the feature-set vocabulary is CLOSED and versioned — exactly the 27 §5 keys with the 4-modality grouping', () => {
  assert.equal(LAB_FEATURES_CONTRACT_VERSION, 'lab-features-contract-v1');
  assert.equal(LAB_FEATURE_SET_VERSION, 'lab-featureset-v1');
  assert.equal(LAB_FEATURE_KEY_LIST.length, 27);
  // Every key maps to exactly one modality group and carries its §5
  // source phrase (the frozen definition).
  const byModality: Record<string, string[]> = {};
  for (const key of LAB_FEATURE_KEY_LIST) {
    const entry = LAB_FEATURE_KEYS[key];
    assert.ok(entry.modality === 'text' || entry.modality === 'audio' || entry.modality === 'visual' || entry.modality === 'metadata');
    assert.ok(typeof entry.source === 'string' && entry.source.length > 0);
    (byModality[entry.modality] ??= []).push(key);
  }
  assert.deepEqual([...LAB_FEATURE_MODALITIES], ['text', 'audio', 'visual', 'metadata']);
  // The §5 list is fully covered: every source phrase is distinct and
  // the grouping is a partition (no key in two groups).
  const allKeys = Object.values(byModality).flat();
  assert.equal(new Set(allKeys).size, 27);
  // The frozen vocabularies.
  assert.deepEqual([...LAB_FEATURE_VALUE_STATES], ['derived', 'unavailable']);
  assert.deepEqual([...LAB_FEATURE_ITEM_OUTCOMES], ['extracted', 'failed', 'skipped']);
  assert.deepEqual([...LAB_FEATURE_FAILURE_REASONS], [
    'media_unavailable',
    'rights_not_permitted',
    'unsupported_modality',
    'extraction_error',
    'encoder_unavailable',
    'invalid_input',
    'scope_mismatch',
  ]);
  assert.deepEqual([...LAB_FEATURE_SKIP_REASONS], ['duplicate_citation_in_batch', 'already_extracted']);
  assert.deepEqual([...LAB_FEATURE_UNAVAILABLE_REASONS], [
    'encoder_unavailable',
    'absent_from_source',
    'requires_media_access',
    'requires_observation_history',
    'requires_corpus_context',
  ]);
  assert.deepEqual([...LAB_FEATURE_MEDIA_AVAILABILITIES], [
    'unknown',
    'available_permitted',
    'available_rights_unclear',
    'provider_unavailable',
    'withdrawn',
  ]);
  assert.deepEqual([...LAB_FEATURE_MEDIA_ACCESS_POSTURES], ['metadata_only', 'reference_gated']);
  assert.deepEqual([...LAB_FEATURE_MEDIA_FETCH_STATUSES], ['not_requested', 'pending', 'granted', 'refused']);
  assert.deepEqual([...LAB_FEATURE_RUN_STATUSES], ['running', 'completed']);
  assert.equal(LAB_FEATURES_BATCH_MAX_ITEMS, 100);
});

test('LAB-003: the citable bundle reference pattern (the corpus advance seam input — the /lab-agent-body reference discipline)', () => {
  const reference = labFeaturesBundleReference('01234567-89ab-cdef-0123-456789abcdef', 3);
  assert.equal(reference, '01234567-89ab-cdef-0123-456789abcdef#v3');
  assert.ok(LAB_FEATURES_BUNDLE_REFERENCE_PATTERN.test(reference));
  assert.ok(!LAB_FEATURES_BUNDLE_REFERENCE_PATTERN.test('not-a-reference'));
  assert.ok(!LAB_FEATURES_BUNDLE_REFERENCE_PATTERN.test('01234567-89ab-cdef-0123-456789abcdef#v0'));
});

// ---------------------------------------------------------------------------
// (2) The citation fences (§4 source linkage — recorded data only).
// ---------------------------------------------------------------------------

test('LAB-003: the citation fences — the full linkage field set, bounded, closed vocabularies, NO media-bytes surface', () => {
  assertValidLabFeatureCitation(validCitation());
  assertValidLabFeatureCitation(validCitation({ metadataSnapshot: {} }));
  // Malformed shapes fail closed.
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ referenceId: 'not-a-uuid' })), 'referenceId must be a uuid');
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ clientId: 'not-a-uuid' })), 'clientId must be a uuid');
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ corpusId: 'not-a-uuid' })), 'corpusId must be a uuid');
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ corpusVersion: 0 })), 'corpusVersion must be an integer');
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ provider: 'NOT-LOWER' })), 'provider must be 1-64 chars of [a-z0-9-]');
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ providerContentId: ' x ' })), 'providerContentId must be a trimmed string');
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ canonicalUrl: 'ftp://x' })), 'canonicalUrl must be an http(s) URL');
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ metadataDigest: 'ZZZ' })), 'metadataDigest must be a 64-char lowercase hex');
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ metadataSnapshot: null as never })), 'metadataSnapshot must be an object');
  assertInvalid(
    () => assertValidLabFeatureCitation(validCitation({ metadataSnapshot: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, i])) })),
    'metadataSnapshot must hold at most 256 keys',
  );
  assertInvalid(() => assertValidLabFeatureCitation(validCitation({ mediaAvailability: 'available' as never })), 'mediaAvailability must be one of');
  // The snapshot value surface carries ONLY json fields — there is no
  // byte-bearing parameter anywhere on the citation (the structural
  // no-media discipline; the DB-level no-binary proof is the boundary
  // test's).
});

// ---------------------------------------------------------------------------
// (3) The grant + configuration fences (the §4 media-gate inputs).
// ---------------------------------------------------------------------------

test('LAB-003: the media-grant fences — the closed availability + posture vocabularies (the gate semantics fail closed in the module)', () => {
  assertValidLabFeatureMediaGrant({ availability: 'available_permitted', posture: 'reference_gated' });
  assertValidLabFeatureMediaGrant({ availability: 'withdrawn', posture: 'metadata_only' });
  assertInvalid(() => assertValidLabFeatureMediaGrant({ availability: 'available' as never, posture: 'reference_gated' }), 'availability must be one of');
  assertInvalid(() => assertValidLabFeatureMediaGrant({ availability: 'unknown', posture: 'gated' as never }), 'posture must be one of');
});

test('LAB-003: the configuration fences — the closed modality requirement, duplicate-free', () => {
  assertValidLabFeatureConfiguration({});
  assertValidLabFeatureConfiguration({ requiredModalities: [] });
  assertValidLabFeatureConfiguration({ requiredModalities: ['text', 'metadata'] });
  assertInvalid(() => assertValidLabFeatureConfiguration({ requiredModalities: ['vibes' as never] }), 'not in the closed modality vocabulary');
  assertInvalid(() => assertValidLabFeatureConfiguration({ requiredModalities: ['text', 'text'] }), 'duplicated');
});

// ---------------------------------------------------------------------------
// (4) The batch bounds.
// ---------------------------------------------------------------------------

test('LAB-003: the batch bounds — a bounded list of 1-100 citations', () => {
  const scope = { agencyId: '00000000-0000-0000-0000-000000000001', clientId: CLIENT_ID };
  assertValidLabFeatureBatchInput({ scope, items: [{ citation: validCitation() }] });
  const hundred = Array.from({ length: 100 }, () => ({ citation: validCitation() }));
  assertValidLabFeatureBatchInput({ scope, items: hundred });
  assertInvalid(() => assertValidLabFeatureBatchInput({ scope, items: [] }), 'items must be a bounded list of 1-100');
  const hundredOne = Array.from({ length: 101 }, () => ({ citation: validCitation() }));
  assertInvalid(() => assertValidLabFeatureBatchInput({ scope, items: hundredOne }), 'items must be a bounded list of 1-100');
  // STRUCTURE ONLY at the batch gate: a semantically invalid citation
  // is NOT a whole-batch rejection — it is the honest per-item
  // failed/invalid_input outcome INSIDE the run (exactly one outcome
  // per item, proved end-to-end in the integration battery); the batch
  // gate owns the list shape and the item-object shape only.
  assertValidLabFeatureBatchInput({ scope, items: [{ citation: validCitation({ provider: 'BAD' }) }] });
  assertValidLabFeatureBatchInput({ scope, items: [{ citation: validCitation(), mediaGrant: { availability: 'banana' as never, posture: 'nope' as never } }] });
  assertInvalid(
    () => assertValidLabFeatureBatchInput({ scope, items: ['not an object'] as unknown as LabFeatureBatchItem[] }),
    'every batch item must be an object',
  );
});

// ---------------------------------------------------------------------------
// (5) The deterministic identity derivation (the reproducible-identity acceptance).
// ---------------------------------------------------------------------------

test('LAB-003: the canonical JSON serialization — DEEP sorted keys, stable against insertion order', () => {
  assert.equal(labFeaturesCanonicalJson({ b: 1, a: { d: 2, c: 3 } }), labFeaturesCanonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(labFeaturesCanonicalJson({ x: [{ z: 1, y: 2 }] }), '{"x":[{"y":2,"z":1}]}');
  // Array order is semantic (never reordered).
  assert.notEqual(labFeaturesCanonicalJson({ x: [1, 2] }), labFeaturesCanonicalJson({ x: [2, 1] }));
});

test('LAB-003: the INPUT digest — the same extraction input always produces the same digest; any consumed change differs', () => {
  const configuration = { requiredModalities: ['text' as const] };
  const base = { citation: validCitation(), mediaGrant: undefined, configuration };
  const d1 = computeLabFeatureInputDigest(base);
  assert.equal(comLabFeatureInputDigestAgain(base), d1);
  // The grant participates.
  const withGrant = computeLabFeatureInputDigest({ ...base, mediaGrant: { availability: 'available_permitted', posture: 'reference_gated' } });
  assert.notEqual(withGrant, d1);
  // The snapshot participates.
  const changedSnapshot = computeLabFeatureInputDigest({
    ...base,
    citation: validCitation({ metadataSnapshot: { title: 'A video', durationSeconds: 62 } }),
  });
  assert.notEqual(changedSnapshot, d1);
  // The configuration participates.
  const changedConfig = computeLabFeatureInputDigest({ ...base, configuration: {} });
  assert.notEqual(changedConfig, d1);
  // A differently-ORDERED snapshot with the same content is the same digest.
  const reordered = computeLabFeatureInputDigest({
    ...base,
    citation: validCitation({ metadataSnapshot: { durationSeconds: 61, title: 'A video' } }),
  });
  assert.equal(reordered, d1);
});

function comLabFeatureInputDigestAgain(input: Parameters<typeof computeLabFeatureInputDigest>[0]): string {
  return computeLabFeatureInputDigest(input);
}

test('LAB-003: the IDENTITY digest — a pure function of (reference identity fields, feature-set version, extractor identity, input digest)', () => {
  const referenceIdentity = {
    referenceId: REFERENCE_ID,
    corpusId: CORPUS_ID,
    corpusVersion: 1,
    provider: 'youtube',
    providerContentId: 'vid-123',
    canonicalUrl: 'https://www.youtube.com/watch?v=vid-123',
    metadataDigest: DIGEST_A,
  };
  const base = {
    referenceIdentity,
    featureSetVersion: LAB_FEATURE_SET_VERSION,
    extractorIdentity: { extractorId: FIRST_PARTY_EXTRACTOR_ID, extractorVersion: FIRST_PARTY_EXTRACTOR_VERSION },
    inputDigest: DIGEST_B,
  };
  const d1 = computeLabFeatureIdentityDigest(base);
  assert.equal(computeLabFeatureIdentityDigest(base), d1);
  // A changed metadata digest (a new observation) → a new identity.
  assert.notEqual(
    computeLabFeatureIdentityDigest({ ...base, referenceIdentity: { ...referenceIdentity, metadataDigest: 'c'.repeat(64) } }),
    d1,
  );
  // A new feature-set version → a new identity.
  assert.notEqual(computeLabFeatureIdentityDigest({ ...base, featureSetVersion: 'lab-featureset-v2' }), d1);
  // A new extractor version → a new identity.
  assert.notEqual(
    computeLabFeatureIdentityDigest({ ...base, extractorIdentity: { extractorId: FIRST_PARTY_EXTRACTOR_ID, extractorVersion: '2' } }),
    d1,
  );
  // A new input digest (changed grant/config/snapshot) → a new identity.
  assert.notEqual(computeLabFeatureIdentityDigest({ ...base, inputDigest: 'd'.repeat(64) }), d1);
  // A changed canonical URL → a new identity.
  assert.notEqual(
    computeLabFeatureIdentityDigest({ ...base, referenceIdentity: { ...referenceIdentity, canonicalUrl: 'https://www.youtube.com/watch?v=other' } }),
    d1,
  );
});

// ---------------------------------------------------------------------------
// (6) The value-map NEVER-FABRICATE discipline.
// ---------------------------------------------------------------------------

function fullUnavailableMap(): LabFeatureValueMap {
  const map: Record<string, { state: 'unavailable'; reason: 'encoder_unavailable' }> = {};
  for (const key of LAB_FEATURE_KEY_LIST) map[key] = { state: 'unavailable', reason: 'encoder_unavailable' };
  return map as LabFeatureValueMap;
}

test('LAB-003: the value-map discipline — exactly the closed 27-key set; derived values carry encoder identity; unavailable values carry their closed reason and NO representation', () => {
  const full = fullUnavailableMap();
  assertValidLabFeatureValueMap(full);
  // Missing a key → rejected.
  const missing = { ...(full as Record<string, unknown>) };
  delete missing['duration'];
  assertInvalid(() => assertValidLabFeatureValueMap(missing as unknown as LabFeatureValueMap), 'missing: duration');
  // An unexpected key → rejected.
  const extra = { ...(full as Record<string, unknown>), invented_feature: { state: 'unavailable', reason: 'encoder_unavailable' } };
  assertInvalid(() => assertValidLabFeatureValueMap(extra as unknown as LabFeatureValueMap), 'unexpected: invented_feature');
  // A derived value without encoder identity → rejected.
  const noEncoder = { ...(full as Record<string, unknown>), duration: { state: 'derived', value: 61 } };
  assertInvalid(() => assertValidLabFeatureValueMap(noEncoder as unknown as LabFeatureValueMap), 'must carry its encoder identity');
  // A derived value with a malformed encoder id → rejected.
  const badEncoder = { ...(full as Record<string, unknown>), duration: { state: 'derived', encoder: { encoderId: 'BAD ID', encoderVersion: '1' }, value: 61 } };
  assertInvalid(() => assertValidLabFeatureValueMap(badEncoder as unknown as LabFeatureValueMap), 'encoder.encoderId must be 1-64 chars of [a-z0-9-]');
  // An unavailable value with an open reason → rejected.
  const badReason = { ...(full as Record<string, unknown>), duration: { state: 'unavailable', reason: 'because' as never } };
  assertInvalid(() => assertValidLabFeatureValueMap(badReason as unknown as LabFeatureValueMap), 'reason must be one of');
  // An unavailable value carrying a representation → rejected (never fabricated).
  const fabricated = { ...(full as Record<string, unknown>), duration: { state: 'unavailable', reason: 'absent_from_source', value: 61 } };
  assertInvalid(() => assertValidLabFeatureValueMap(fabricated as unknown as LabFeatureValueMap), 'may not carry a representation');
  // A derived value with encoder identity + representation → accepted.
  const derived = { ...(full as Record<string, unknown>), duration: { state: 'derived', encoder: { encoderId: 'lab-features-metadata', encoderVersion: '1' }, value: { valueSeconds: 61 } } };
  assertValidLabFeatureValueMap(derived as unknown as LabFeatureValueMap);
  // An unknown state → rejected.
  const badState = { ...(full as Record<string, unknown>), duration: { state: 'pending-ish' } };
  assertInvalid(() => assertValidLabFeatureValueMap(badState as unknown as LabFeatureValueMap), "state must be 'derived' or 'unavailable'");
});

// ---------------------------------------------------------------------------
// (7) The first-party extractor — the honest derivation table.
// ---------------------------------------------------------------------------

function extractionInput(overrides: Partial<LabFeatureExtractionInput> = {}): LabFeatureExtractionInput {
  return {
    citation: validCitation(),
    grant: undefined,
    mediaFetch: undefined,
    configuration: {},
    ...overrides,
  };
}

test('LAB-003: the first-party extractor derives the metadata-grade features DETERMINISTICALLY from the recorded snapshot', async () => {
  const extractor = createFirstPartyLabFeatureExtractor();
  assert.equal(extractor.extractorId, FIRST_PARTY_EXTRACTOR_ID);
  assert.equal(extractor.featureSetVersion, LAB_FEATURE_SET_VERSION);
  assert.deepEqual([...extractor.supportedModalities], ['metadata', 'text']);
  const input = extractionInput({
    citation: validCitation({
      metadataSnapshot: {
        title: '3 Genius Home Gym Hacks #fitness #homegym',
        description: 'Save space and money #gear',
        durationSeconds: 61,
        viewCount: 12000,
        likeCount: 340,
        commentCount: 21,
        impressionCount: 40_000,
        language: 'en',
        products: [{ name: 'Adjustable Dumbbell', id: 'p-1' }],
      },
    }),
  });
  const result = await extractor.extract(input);
  assert.ok('values' in result);
  const values = result.values as LabFeatureValueMap;
  // The deterministic metadata derivations (source-attributed).
  const duration = values['duration'] as { state: string; encoder: { encoderId: string }; value: { valueSeconds: number; sourceField: string } };
  assert.equal(duration.state, 'derived');
  assert.equal(duration.encoder.encoderId, 'lab-features-metadata');
  assert.equal(duration.value.valueSeconds, 61);
  const engagement = values['engagement'] as { state: string; value: { counters: Record<string, number> } };
  assert.equal(engagement.state, 'derived');
  assert.deepEqual(engagement.value.counters, { viewCount: 12000, likeCount: 340, commentCount: 21 });
  const retention = values['retention_impression_metrics'] as { state: string; value: { metrics: Record<string, number> } };
  assert.equal(retention.state, 'derived');
  assert.equal(retention.value.metrics.impressionCount, 40_000);
  const language = values['language'] as { state: string; value: { language: string; sourceField: string } };
  assert.equal(language.state, 'derived');
  assert.equal(language.value.language, 'en');
  const products = values['product_references'] as { state: string; value: { references: Array<Record<string, unknown>> } };
  assert.equal(products.state, 'derived');
  assert.equal(products.value.references.length, 1);
  // The deterministic LEXICAL representation (honestly labeled — never an embedding).
  const lexical = values['title_description_hashtag_semantics'] as {
    state: string;
    encoder: { encoderId: string };
    value: { titleTokens: number; hashtags: string[]; hashtagCount: number };
  };
  assert.equal(lexical.state, 'derived');
  assert.equal(lexical.encoder.encoderId, 'lab-features-lexical');
  assert.deepEqual(lexical.value.hashtags, ['#fitness', '#homegym', '#gear']);
  assert.equal(lexical.value.hashtagCount, 3);
  // The deterministic derivation is a PURE FUNCTION: the same input → the same values.
  const again = await extractor.extract(extractionInput({
    citation: validCitation({
      metadataSnapshot: {
        products: [{ id: 'p-1', name: 'Adjustable Dumbbell' }],
        language: 'en',
        impressionCount: 40_000,
        commentCount: 21,
        likeCount: 340,
        viewCount: 12000,
        durationSeconds: 61,
        description: 'Save space and money #gear',
        title: '3 Genius Home Gym Hacks #fitness #homegym',
      },
    }),
  }));
  assert.ok('values' in again);
  assert.deepEqual(again.values, values);
});

test('LAB-003: the first-party extractor records the HONEST unavailable states — encoder/media/history/corpus grades, never fabricated', async () => {
  const extractor = createFirstPartyLabFeatureExtractor();
  const result = await extractor.extract(extractionInput());
  assert.ok('values' in result);
  const values = result.values as LabFeatureValueMap;
  // Encoder-grade (no real encoder wired): the embeddings + the semantic structures.
  for (const key of ['visual_embedding', 'audio_embedding', 'text_embedding', 'hook_structure', 'topic_subtopic_entity', 'problem_claim', 'curiosity_gap', 'narrative_structure', 'information_density', 'cta_structure'] as const) {
    const value = values[key] as { state: string; reason: string };
    assert.equal(value.state, 'unavailable', `${key} must be unavailable`);
    assert.equal(value.reason, 'encoder_unavailable', `${key} must carry the encoder_unavailable reason`);
  }
  // Media-grade with NO granted path: requires_media_access.
  for (const key of ['thumbnail_representation', 'opening_frame_representation', 'pacing', 'scene_transitions', 'visual_composition', 'speaking_rate', 'emotional_trajectory'] as const) {
    const value = values[key] as { state: string; reason: string };
    assert.equal(value.reason, 'requires_media_access', `${key} must carry the requires_media_access reason when no grant opened the path`);
  }
  // History-grade: a single cited snapshot cannot express them.
  for (const key of ['performance_velocity', 'age_normalized_performance', 'creator_baseline'] as const) {
    const value = values[key] as { state: string; reason: string };
    assert.equal(value.reason, 'requires_observation_history');
  }
  // Corpus-grade: the LAB-004 Idea Graph layer owns it.
  const novelty = values['novelty_reuse_risk'] as { state: string; reason: string };
  assert.equal(novelty.reason, 'requires_corpus_context');
  // Fields ABSENT from the snapshot → absent_from_source (never guessed).
  const emptyResult = await extractor.extract(extractionInput({ citation: validCitation({ metadataSnapshot: {} }) }));
  assert.ok('values' in emptyResult);
  const emptyValues = emptyResult.values as LabFeatureValueMap;
  assert.equal((emptyValues['duration'] as { reason: string }).reason, 'absent_from_source');
  assert.equal((emptyValues['engagement'] as { reason: string }).reason, 'absent_from_source');
  assert.equal((emptyValues['title_description_hashtag_semantics'] as { reason: string }).reason, 'absent_from_source');
  assert.equal((emptyValues['retention_impression_metrics'] as { reason: string }).reason, 'absent_from_source');
  assert.equal((emptyValues['product_references'] as { reason: string }).reason, 'absent_from_source');
  // Language with no declared field is encoder-grade honest (never a script heuristic guess).
  assert.equal((emptyValues['language'] as { reason: string }).reason, 'encoder_unavailable');
  // Wrong-typed snapshot fields are treated as ABSENT (the disclosed coarse interpretation).
  const wrongTyped = await extractor.extract(extractionInput({ citation: validCitation({ metadataSnapshot: { durationSeconds: 'an hour' } }) }));
  assert.ok('values' in wrongTyped);
  assert.equal(((wrongTyped.values as unknown as LabFeatureValueMap)['duration'] as { reason: string }).reason, 'absent_from_source');
  // EVERY value map the extractor produces passes the closed-set validation.
  assertValidLabFeatureValueMap(values);
  assertValidLabFeatureValueMap(emptyValues);
});

test('LAB-003: the first-party extractor reports the media path honestly (not_requested / pending / granted) and never fabricates media-grade values', async () => {
  const extractor = createFirstPartyLabFeatureExtractor();
  // No grant → not_requested.
  const none = await extractor.extract(extractionInput());
  assert.ok('values' in none);
  assert.equal(none.mediaFetchStatus, 'not_requested');
  // A granted path (test-double fetch outcome) → the handle rides through, the media-grade features stay encoder-unavailable.
  const granted = await extractor.extract(extractionInput({
    grant: { availability: 'available_permitted', posture: 'reference_gated' },
    mediaFetch: {
      status: 'granted',
      handle: { byteLength: 1024, readAll: () => new Uint8Array(1024) },
    },
  }));
  assert.ok('values' in granted);
  assert.equal(granted.mediaFetchStatus, 'granted');
  assert.equal(granted.mediaFetchBytes, 1024);
  const pacing = (granted.values as unknown as LabFeatureValueMap)['pacing'] as { state: string; reason: string };
  assert.equal(pacing.state, 'unavailable');
  assert.equal(pacing.reason, 'encoder_unavailable', 'with bytes granted but no decoder wired, the honest reason is encoder_unavailable');
  // The pending path → pending status.
  const pending = await extractor.extract(extractionInput({
    grant: { availability: 'available_permitted', posture: 'reference_gated' },
    mediaFetch: { status: 'pending', detail: 'no adapter wired' },
  }));
  assert.ok('values' in pending);
  assert.equal(pending.mediaFetchStatus, 'pending');
  // A refused fetch outcome is representable (the module fails the item before the extractor — the port-contract totality).
  const refused = await extractor.extract(extractionInput({
    grant: { availability: 'available_permitted', posture: 'reference_gated' },
    mediaFetch: { status: 'refused', reason: 'rights_not_permitted', detail: 'provider constraints' },
  }));
  assert.ok('values' in refused);
  assert.equal(refused.mediaFetchStatus, 'refused');
});
