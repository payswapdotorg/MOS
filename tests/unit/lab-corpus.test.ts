/**
 * LAB-002 unit tests — the PURE contract guards of /lab-corpus: the
 * acquisition-policy discipline (§4 provider-specific constraints),
 * the Content Reference field fences (§4 verbatim field set), the
 * observation fences (§4 observation timestamps) and the frozen
 * vocabulary constants (the closed lifecycle/rights-basis/
 * availability/posture vocabularies).
 *
 * The dispatch's named acceptance proofs (spec/effective-backlog-v1.7.md
 * LAB-002):
 *   (a) reference-first storage — the public surface exposes ONLY
 *       reference/metadata/provenance fields; NO field can hold media
 *       bytes (the structural no-media discipline);
 *   (b) provider-specific acquisition policy — the per-provider
 *       permitted-bases gate with the closed media-access postures;
 *   (c) provenance — the bounded collection method/version pair;
 *   (d) deduplication — the ingest input carries the (provider,
 *       provider_content_id) identity the integration battery proves
 *       UNIQUE-fenced at the DB;
 *   (e) observation timestamps — the ISO-UTC, never-future observed_at
 *       fence;
 *   (f) coverage reporting — the report surface type is part of the
 *       public contract (the integration battery computes it against
 *       the real schema);
 *   (g) no unauthorized media retention — the validation surface can
 *       not even EXPRESSION a media payload (no byte-bearing field
 *       exists on any input).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_CORPUS_CONTRACT_VERSION,
  LAB_CORPUS_MEDIA_ACCESS_POSTURES,
  LAB_CORPUS_MEDIA_AVAILABILITIES,
  LAB_CORPUS_POLICY_VERSION,
  LAB_CORPUS_RIGHTS_BASES,
  LAB_CORPUS_STATUSES,
  assertValidLabCorpusAcquisitionPolicy,
  assertValidLabCorpusObservationInput,
  assertValidLabCorpusReferenceInput,
} from '../../src/modules/lab-corpus/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import type { RegisterLabCorpusReferenceInput, LabCorpusAcquisitionPolicy } from '../../src/modules/lab-corpus/public.ts';

const NOW = '2026-09-28T20:00:00.000Z';
const DIGEST = 'a'.repeat(64);

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

function validPolicy(): LabCorpusAcquisitionPolicy {
  return {
    version: LAB_CORPUS_POLICY_VERSION,
    providers: {
      youtube: { permittedBases: ['public_reference', 'provider_api_terms'], mediaAccess: 'reference_gated' },
      tiktok: { permittedBases: ['public_reference'], mediaAccess: 'metadata_only' },
    },
  };
}

function validReferenceInput(): RegisterLabCorpusReferenceInput {
  return {
    scope: { agencyId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' },
    corpusId: '00000000-0000-0000-0000-000000000003',
    provider: 'youtube',
    providerContentId: 'vid-123',
    canonicalUrl: 'https://www.youtube.com/watch?v=vid-123',
    creatorRef: '@creator',
    publicationTime: '2026-01-15T10:00:00.000Z',
    rightsBasis: 'public_reference',
    collectionMethod: 'mkt-062-web-research',
    collectionVersion: 'v1',
    metadataSnapshot: { title: 'A video', durationSeconds: 61 },
    metadataDigest: DIGEST,
    mediaAvailability: 'unknown',
  };
}

// ---------------------------------------------------------------------------
// (a) The frozen vocabularies and version constants.
// ---------------------------------------------------------------------------

test('LAB-002: the frozen corpus vocabularies are the closed sets (lifecycle, rights bases, availability, postures)', () => {
  assert.equal(LAB_CORPUS_CONTRACT_VERSION, 'lab-corpus-contract-v1');
  assert.deepEqual(LAB_CORPUS_STATUSES, ['draft', 'active', 'retired']);
  assert.deepEqual(LAB_CORPUS_RIGHTS_BASES, ['public_reference', 'provider_api_terms', 'explicit_license', 'creator_grant']);
  assert.deepEqual(LAB_CORPUS_MEDIA_AVAILABILITIES, ['unknown', 'available_permitted', 'available_rights_unclear', 'provider_unavailable', 'withdrawn']);
  assert.deepEqual(LAB_CORPUS_MEDIA_ACCESS_POSTURES, ['metadata_only', 'reference_gated']);
});

// ---------------------------------------------------------------------------
// (b) The acquisition-policy discipline.
// ---------------------------------------------------------------------------

test('LAB-002: a valid per-provider acquisition policy passes (permitted bases + the closed media-access posture)', () => {
  assertValidLabCorpusAcquisitionPolicy(validPolicy());
});

test('LAB-002: the policy version is pinned — any other vocabulary version is rejected', () => {
  const policy = validPolicy();
  (policy as { version: string }).version = 'some-future-policy';
  assertInvalid(() => assertValidLabCorpusAcquisitionPolicy(policy), 'lab-corpus-policy-v1');
});

test('LAB-002: an empty provider map, an unknown rights basis and a duplicated basis are rejected', () => {
  const empty = validPolicy();
  (empty as { providers: Record<string, unknown> }).providers = {};
  assertInvalid(() => assertValidLabCorpusAcquisitionPolicy(empty), '1-64 entries');

  const unknown = validPolicy();
  (unknown as { providers: Record<string, unknown> }).providers = { youtube: { permittedBases: ['steal_it'], mediaAccess: 'metadata_only' } };
  assertInvalid(() => assertValidLabCorpusAcquisitionPolicy(unknown), 'closed rights-basis vocabulary');

  const duplicated = validPolicy();
  (duplicated as { providers: Record<string, unknown> }).providers = { youtube: { permittedBases: ['public_reference', 'public_reference'], mediaAccess: 'metadata_only' } };
  assertInvalid(() => assertValidLabCorpusAcquisitionPolicy(duplicated), 'duplicated');
});

test('LAB-002: a durable-media posture is unrepresentable — only metadata_only/reference_gated pass, anything else is rejected', () => {
  const policy = validPolicy();
  (policy as unknown as { providers: Record<string, { permittedBases: string[]; mediaAccess: string }> }).providers = {
    youtube: { permittedBases: ['public_reference'], mediaAccess: 'keep_media_bytes_forever' },
  };
  assertInvalid(() => assertValidLabCorpusAcquisitionPolicy(policy), 'mediaAccess');
});

// ---------------------------------------------------------------------------
// (c)/(d) The Content Reference field fences (provenance + dedup identity).
// ---------------------------------------------------------------------------

test('LAB-002: a valid §4 Content Reference input passes (the verbatim field set)', () => {
  assertValidLabCorpusReferenceInput(validReferenceInput(), NOW);
});

test('LAB-002: malformed provider/content id/URL/digest fields are rejected', () => {
  const bad = validReferenceInput();
  (bad as { provider: string }).provider = 'YouTube';
  assertInvalid(() => assertValidLabCorpusReferenceInput(bad, NOW), 'provider');

  const badId = validReferenceInput();
  (badId as { providerContentId: string }).providerContentId = ' '.repeat(300);
  assertInvalid(() => assertValidLabCorpusReferenceInput(badId, NOW), 'providerContentId');

  const badUrl = validReferenceInput();
  (badUrl as { canonicalUrl: string }).canonicalUrl = 'ftp://not-http.example/x';
  assertInvalid(() => assertValidLabCorpusReferenceInput(badUrl, NOW), 'canonicalUrl');

  const badDigest = validReferenceInput();
  (badDigest as { metadataDigest: string }).metadataDigest = 'XYZ-not-hex';
  assertInvalid(() => assertValidLabCorpusReferenceInput(badDigest, NOW), 'metadataDigest');
});

test('LAB-002: an unknown rights basis or availability is rejected (closed vocabularies)', () => {
  const badBasis = validReferenceInput();
  (badBasis as { rightsBasis: string }).rightsBasis = 'found_it_on_the_internet';
  assertInvalid(() => assertValidLabCorpusReferenceInput(badBasis, NOW), 'rightsBasis');

  const badAvailability = validReferenceInput();
  (badAvailability as { mediaAvailability: string }).mediaAvailability = 'available_no_questions_asked';
  assertInvalid(() => assertValidLabCorpusReferenceInput(badAvailability, NOW), 'mediaAvailability');
});

test('LAB-002: a publication time in the future is rejected (the observation may not precede the content existence claim)', () => {
  const future = validReferenceInput();
  (future as { publicationTime: string }).publicationTime = '2027-01-01T00:00:00.000Z';
  assertInvalid(() => assertValidLabCorpusReferenceInput(future, NOW), 'publicationTime may not be in the future');
});

test('LAB-002: provenance is bounded — empty or oversized collection method/version strings are rejected', () => {
  const emptyMethod = validReferenceInput();
  (emptyMethod as { collectionMethod: string }).collectionMethod = '  ';
  assertInvalid(() => assertValidLabCorpusReferenceInput(emptyMethod, NOW), 'collectionMethod');

  const longVersion = validReferenceInput();
  (longVersion as { collectionVersion: string }).collectionVersion = 'v'.repeat(65);
  assertInvalid(() => assertValidLabCorpusReferenceInput(longVersion, NOW), 'collectionVersion');
});

// ---------------------------------------------------------------------------
// (e) The observation fences (observation timestamps).
// ---------------------------------------------------------------------------

test('LAB-002: a valid observation input passes and observedAt defaults to the module clock (the optional fence)', () => {
  const input = {
    scope: { agencyId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' },
    referenceId: '00000000-0000-0000-0000-000000000004',
    collectionMethod: 'mkt-062-web-research',
    collectionVersion: 'v1',
    metadataDigest: DIGEST,
    mediaAvailability: 'available_permitted' as const,
  };
  assertValidLabCorpusObservationInput(input, NOW);
  assertValidLabCorpusObservationInput({ ...input, observedAt: NOW }, NOW);
});

test('LAB-002: a non-ISO or future observedAt is rejected (an observation is a record of a PAST sighting)', () => {
  const malformed = {
    scope: { agencyId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' },
    referenceId: '00000000-0000-0000-0000-000000000004',
    observedAt: '2026-09-28 20:00:00',
    collectionMethod: 'm',
    collectionVersion: 'v1',
    metadataDigest: DIGEST,
    mediaAvailability: 'unknown' as const,
  };
  assertInvalid(() => assertValidLabCorpusObservationInput(malformed, NOW), 'observedAt');

  const future = { ...malformed, observedAt: '2026-09-28T21:00:00.000Z' };
  assertInvalid(() => assertValidLabCorpusObservationInput(future, NOW), 'future');
});

// ---------------------------------------------------------------------------
// (g) No unauthorized media retention — the structural no-media surface.
// ---------------------------------------------------------------------------

test('LAB-002: the reference/observation input surface exposes NO byte-bearing media field (reference-first storage)', () => {
  const referenceKeys = Object.keys(validReferenceInput()).sort();
  // The exact closed §4 field set — no byte-bearing surface exists.
  assert.deepEqual(referenceKeys, [
    'canonicalUrl',
    'collectionMethod',
    'collectionVersion',
    'corpusId',
    'creatorRef',
    'mediaAvailability',
    'metadataDigest',
    'metadataSnapshot',
    'provider',
    'providerContentId',
    'publicationTime',
    'rightsBasis',
    'scope',
  ]);
  for (const key of referenceKeys) {
    assert.ok(!/bytes|payload|binary|base64|dataurl/i.test(key), `input field '${key}' must not be a media-bytes surface`);
  }
  assert.ok(referenceKeys.includes('metadataSnapshot'), 'the durable observation is the metadata snapshot');
  assert.ok(referenceKeys.includes('metadataDigest'), 'the dedup/coverage measurement key is the digest');
});
