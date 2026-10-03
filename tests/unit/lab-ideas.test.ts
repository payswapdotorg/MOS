/**
 * LAB-004 unit tests — the PURE contract guards of /lab-ideas: the
 * closed, versioned vocabularies (the 10 §6 primitive kinds, the 8
 * edge relations, the 4 origin classes, the 6 operation kinds with
 * the kind→relation/origin pairings), the citation fences, the
 * proposed-node/edge fences, the operation fences (the per-kind
 * input-count + output-kind rules), THE RETRIEVAL DISCIPLINE (the
 * mandatory explicit origin-class filter), the deterministic
 * identity derivation (the reproducible-identity acceptance), the
 * frozen novelty formula, the deterministic clustering, the lineage
 * construction + its bound, plus the first-party decomposer's and
 * generator's honesty tables.
 *
 * The dispatch's named acceptance proofs (spec/effective-backlog-v1.7.md
 * LAB-004 "observed vs derived separation, retrieval, clustering,
 * novelty, recombination and lineage"):
 *   (a) observed vs derived separation — the vocabulary pairings +
 *       the operation-kind → origin-class fence (the DB-level fences
 *       are exercised in the integration battery);
 *   (b) retrieval — the mandatory origin-class filter + the closed
 *       kind/origin subsets + the cursor shape;
 *   (c) clustering — the frozen deterministic pure function (same
 *       nodes → the same clusters; the component keys);
 *   (d) novelty — the frozen pure formula against OBSERVED nodes
 *       only;
 *   (e) recombination — the operation fences + the first-party
 *       structural generator (real) + the pending refusals;
 *   (f) lineage — the deterministic construction + the 64-step
 *       fail-closed bound.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_IDEAS_CONTRACT_VERSION,
  LAB_IDEA_SET_VERSION,
  LAB_IDEA_CLUSTERING_VERSION,
  LAB_IDEA_NOVELTY_VERSION,
  LAB_IDEA_PRIMITIVE_KINDS,
  LAB_IDEA_EDGE_RELATIONS,
  LAB_IDEA_ORIGIN_CLASSES,
  LAB_IDEA_OPERATION_KINDS,
  LAB_IDEA_OPERATION_KIND_RELATION,
  LAB_IDEA_OPERATION_KIND_OUTPUT_ORIGIN,
  LAB_IDEAS_EVIDENCE_ORIGIN_CLASSES,
  LAB_IDEAS_MAX_LINEAGE_STEPS,
  LAB_IDEAS_MAX_OPERATION_INPUTS,
  LAB_IDEA_CLUSTERING_SIMILARITY_THRESHOLD,
  FIRST_PARTY_DECOMPOSER_ID,
  FIRST_PARTY_DECOMPOSER_VERSION,
  FIRST_PARTY_GENERATOR_ID,
  FIRST_PARTY_GENERATOR_VERSION,
  assertValidLabIdeaBundleCitation,
  assertValidLabIdeaProposedNodes,
  assertValidLabIdeaProposedEdges,
  assertValidLabIdeaOperationInput,
  assertValidLabIdeaRetrievalInput,
  computeLabIdeaIdentityDigest,
  computeLabIdeaInputDigest,
  createFirstPartyLabIdeaDecomposer,
  createFirstPartyLabIdeaGenerator,
  labIdeasCanonicalJson,
  buildLabIdeaLineage,
  labIdeaTokenSet,
  labIdeaJaccardSimilarity,
  computeLabIdeaNovelty,
  clusterLabIdeaNodes,
} from '../../src/modules/lab-ideas/public.ts';
import type {
  LabIdeaBundleCitation,
  LabIdeaLineageStep,
  LabIdeaNodeRecord,
} from '../../src/modules/lab-ideas/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const CLIENT_ID = '00000000-0000-0000-0000-000000000002';
const BUNDLE_ID = '00000000-0000-0000-0000-0000000000bb';
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

function citation(overrides: Partial<LabIdeaBundleCitation> = {}): LabIdeaBundleCitation {
  return {
    bundleId: BUNDLE_ID,
    bundleReference: `${BUNDLE_ID}#v1`,
    bundleVersion: 1,
    clientId: CLIENT_ID,
    referenceId: REFERENCE_ID,
    corpusId: CORPUS_ID,
    corpusVersion: 1,
    provider: 'youtube',
    providerContentId: 'vid-123',
    canonicalUrl: 'https://www.youtube.com/watch?v=vid-123',
    metadataDigest: DIGEST_A,
    featureSetVersion: 'lab-featureset-v1',
    extractorId: 'lab-first-party-metadata',
    extractorVersion: '1',
    bundleIdentityDigest: DIGEST_B,
    features: {
      duration: { state: 'derived', value: { valueSeconds: 61 } },
      title_description_hashtag_semantics: {
        state: 'derived',
        value: { titleTokens: 7, hashtags: ['#fitness', '#gear'] },
      },
      problem_claim: { state: 'unavailable', reason: 'encoder_unavailable' },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) The closed, versioned vocabularies.
// ---------------------------------------------------------------------------

test('LAB-004: the vocabularies are CLOSED and versioned — the 10 §6 primitives, the 8 relations, the 4 origin classes, the 6 operation kinds', () => {
  assert.equal(LAB_IDEAS_CONTRACT_VERSION, 'lab-ideas-contract-v1');
  assert.equal(LAB_IDEA_SET_VERSION, 'lab-ideaset-v1');
  assert.equal(LAB_IDEA_CLUSTERING_VERSION, 'lab-idea-clustering-v1');
  assert.equal(LAB_IDEA_NOVELTY_VERSION, 'lab-idea-novelty-v1');
  // The §6 primitive vocabulary, verbatim.
  assert.deepEqual([...LAB_IDEA_PRIMITIVE_KINDS], [
    'idea',
    'problem',
    'claim',
    'hook',
    'narrative',
    'visual_treatment',
    'audio_treatment',
    'packaging',
    'cta',
    'timing_context',
  ]);
  // The §6 supports list as relations.
  assert.deepEqual([...LAB_IDEA_EDGE_RELATIONS], [
    'supports',
    'contradicts',
    'refines',
    'combines_with',
    'mutates_from',
    'analog_to',
    'inverts',
    'fills_gap',
  ]);
  // The §6 separation, verbatim.
  assert.deepEqual([...LAB_IDEA_ORIGIN_CLASSES], [
    'observed_source',
    'derived_abstraction',
    'generated_mutation',
    'combined_strategy',
  ]);
  assert.deepEqual([...LAB_IDEA_OPERATION_KINDS], ['derive', 'recombine', 'mutate', 'analogy', 'invert', 'fill_gap']);
  // THE operation-kind pairings: relation + output origin.
  assert.deepEqual(LAB_IDEA_OPERATION_KIND_RELATION, {
    derive: 'refines',
    recombine: 'combines_with',
    mutate: 'mutates_from',
    analogy: 'analog_to',
    invert: 'inverts',
    fill_gap: 'fills_gap',
  });
  assert.deepEqual(LAB_IDEA_OPERATION_KIND_OUTPUT_ORIGIN, {
    derive: 'derived_abstraction',
    recombine: 'combined_strategy',
    mutate: 'generated_mutation',
    analogy: 'generated_mutation',
    invert: 'generated_mutation',
    fill_gap: 'generated_mutation',
  });
  // THE STRICT EVIDENCE FILTER: observed source ideas only.
  assert.deepEqual(LAB_IDEAS_EVIDENCE_ORIGIN_CLASSES, ['observed_source']);
  // The bounds.
  assert.equal(LAB_IDEAS_MAX_LINEAGE_STEPS, 64);
  assert.equal(LAB_IDEAS_MAX_OPERATION_INPUTS, 20);
  assert.equal(LAB_IDEA_CLUSTERING_SIMILARITY_THRESHOLD, 0.5);
});

// ---------------------------------------------------------------------------
// (2) The citation fences (the /lab-features by-reference discipline).
// ---------------------------------------------------------------------------

test('LAB-004: the citation fences — the full linkage field set, the citable bundle reference, the structural feature-map echo', () => {
  assertValidLabIdeaBundleCitation(citation());
  assertValidLabIdeaBundleCitation(citation({ features: {} }));
  assertValidLabIdeaBundleCitation(
    citation({
      features: Array.from({ length: 64 }, (_, i) => [`k${i}`, { state: 'unavailable', reason: 'x' }]).reduce(
        (acc, [k, v]) => ({ ...acc, [k as string]: v }),
        {},
      ),
    }),
  );
  // Malformed shapes fail closed.
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ bundleId: 'not-a-uuid' })), 'bundleId must be a uuid');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ bundleReference: 'nope' })), 'bundleReference must be the citable form');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ bundleVersion: 0 })), 'bundleVersion must be an integer 1-1000');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ clientId: 'x' })), 'clientId must be a uuid');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ referenceId: 'x' })), 'referenceId must be a uuid');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ corpusId: 'x' })), 'corpusId must be a uuid');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ corpusVersion: 0 })), 'corpusVersion must be an integer');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ provider: 'NOT-LOWER' })), 'provider must be 1-64 chars');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ providerContentId: ' x ' })), 'providerContentId must be a trimmed string');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ canonicalUrl: 'ftp://x' })), 'canonicalUrl must be an http(s) URL');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ metadataDigest: 'ZZZ' })), 'metadataDigest must be a 64-char lowercase hex');
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ bundleIdentityDigest: 'zzz' })), 'bundleIdentityDigest must be a 64-char lowercase hex');
  // The structural feature-map echo fences.
  assertInvalid(
    () => assertValidLabIdeaBundleCitation(citation({ features: null as never })), 'features must be an object',
  );
  assertInvalid(
    () =>
      assertValidLabIdeaBundleCitation(
        citation({ features: { bad: { state: 'maybe' } as never } }),
      ),
    "state must be 'derived' or 'unavailable'",
  );
  assertInvalid(
    () => assertValidLabIdeaBundleCitation(citation({ features: { bad: { state: 'derived' } as never } })),
    'derived value must carry its representation',
  );
  assertInvalid(
    () =>
      assertValidLabIdeaBundleCitation(
        citation({ features: { bad: { state: 'unavailable' } as never } }),
      ),
    'unavailable value must carry its reason',
  );
  const tooMany: Record<string, { state: 'unavailable'; reason: string }> = {};
  for (let i = 0; i < 65; i += 1) tooMany[`k${i}`] = { state: 'unavailable', reason: 'x' };
  assertInvalid(() => assertValidLabIdeaBundleCitation(citation({ features: tooMany })), 'features must hold at most 64 keys');
});

// ---------------------------------------------------------------------------
// (3) The proposed-node/edge fences.
// ---------------------------------------------------------------------------

test('LAB-004: the proposed-node fences — the closed primitive vocabulary, bounded descriptors/attributes', () => {
  assertValidLabIdeaProposedNodes([{ primitiveKind: 'hook', descriptor: 'a hook' }]);
  assertValidLabIdeaProposedNodes([]);
  assertInvalid(
    () => assertValidLabIdeaProposedNodes([{ primitiveKind: 'vibe' as never, descriptor: 'x' }]),
    'primitiveKind must be one of',
  );
  assertInvalid(
    () => assertValidLabIdeaProposedNodes([{ primitiveKind: 'hook', descriptor: ' x ' }]),
    'descriptor must be a trimmed string of 1-512 chars',
  );
  assertInvalid(
    () => assertValidLabIdeaProposedNodes([{ primitiveKind: 'hook', descriptor: 'x', attributes: null as never }]),
    'attributes must be an object',
  );
});

test('LAB-004: the proposed-edge fences — the closed relation vocabulary, in-range indices, no self-edges', () => {
  assertValidLabIdeaProposedEdges([{ relation: 'supports', fromSeq: 1, toSeq: 2 }], 2);
  assertInvalid(
    () => assertValidLabIdeaProposedEdges([{ relation: 'blocks' as never, fromSeq: 1, toSeq: 2 }], 2),
    'relation must be one of',
  );
  assertInvalid(() => assertValidLabIdeaProposedEdges([{ relation: 'supports', fromSeq: 0, toSeq: 1 }], 2), 'fromSeq must reference a proposed node');
  assertInvalid(() => assertValidLabIdeaProposedEdges([{ relation: 'supports', fromSeq: 3, toSeq: 1 }], 2), 'fromSeq must reference a proposed node');
  assertInvalid(() => assertValidLabIdeaProposedEdges([{ relation: 'supports', fromSeq: 1, toSeq: 1 }], 2), 'may not be a self-edge');
});

// ---------------------------------------------------------------------------
// (4) The operation fences (the recombination acceptance).
// ---------------------------------------------------------------------------

test('LAB-004: the operation fences — the closed kind vocabulary, the per-kind input counts, the output-kind rule', () => {
  const scope = { agencyId: '00000000-0000-0000-0000-000000000001', clientId: CLIENT_ID };
  // recombine: ≥2 inputs + the caller-declared output kind.
  assertValidLabIdeaOperationInput({
    scope,
    operationKind: 'recombine',
    inputNodeIds: [REFERENCE_ID, CORPUS_ID],
    outputPrimitiveKind: 'idea',
  });
  assertInvalid(
    () =>
      assertValidLabIdeaOperationInput({
        scope,
        operationKind: 'recombine',
        inputNodeIds: [REFERENCE_ID, CORPUS_ID],
      }),
    "operationKind 'recombine' requires outputPrimitiveKind",
  );
  assertInvalid(
    () =>
      assertValidLabIdeaOperationInput({
        scope,
        operationKind: 'recombine',
        inputNodeIds: [REFERENCE_ID, CORPUS_ID],
        outputPrimitiveKind: 'vibe' as never,
      }),
    'outputPrimitiveKind must be one of',
  );
  assertInvalid(
    () =>
      assertValidLabIdeaOperationInput({
        scope,
        operationKind: 'derive',
        inputNodeIds: [REFERENCE_ID, CORPUS_ID],
        outputPrimitiveKind: 'idea',
      }),
    'outputPrimitiveKind may only be declared for operationKind',
  );
  // The single-input kinds.
  assertValidLabIdeaOperationInput({ scope, operationKind: 'mutate', inputNodeIds: [REFERENCE_ID] });
  assertValidLabIdeaOperationInput({ scope, operationKind: 'analogy', inputNodeIds: [REFERENCE_ID] });
  assertValidLabIdeaOperationInput({ scope, operationKind: 'invert', inputNodeIds: [REFERENCE_ID] });
  assertInvalid(
    () => assertValidLabIdeaOperationInput({ scope, operationKind: 'mutate', inputNodeIds: [REFERENCE_ID, CORPUS_ID] }),
    "operationKind 'mutate' cites exactly one input node",
  );
  assertInvalid(
    () =>
      assertValidLabIdeaOperationInput({
        scope,
        operationKind: 'mutate',
        inputNodeIds: [REFERENCE_ID],
        outputPrimitiveKind: 'hook' as never,
      }),
    'outputPrimitiveKind may only be declared for operationKind',
  );
  // The multi-input kinds.
  assertValidLabIdeaOperationInput({ scope, operationKind: 'derive', inputNodeIds: [REFERENCE_ID, CORPUS_ID] });
  assertValidLabIdeaOperationInput({ scope, operationKind: 'fill_gap', inputNodeIds: [REFERENCE_ID, CORPUS_ID] });
  assertInvalid(
    () => assertValidLabIdeaOperationInput({ scope, operationKind: 'derive', inputNodeIds: [REFERENCE_ID] }),
    "operationKind 'derive' cites at least two input nodes",
  );
  // No duplicates, uuid shape, the closed vocabulary, the bound.
  assertInvalid(
    () => assertValidLabIdeaOperationInput({ scope, operationKind: 'mutate', inputNodeIds: [REFERENCE_ID, REFERENCE_ID] }),
    'inputNodeIds may not contain duplicates',
  );
  assertInvalid(
    () => assertValidLabIdeaOperationInput({ scope, operationKind: 'mutate', inputNodeIds: ['not-a-uuid'] }),
    'every inputNodeIds entry must be a uuid',
  );
  assertInvalid(
    () => assertValidLabIdeaOperationInput({ scope, operationKind: 'explode' as never, inputNodeIds: [] }),
    'operationKind must be one of',
  );
});

// ---------------------------------------------------------------------------
// (5) THE RETRIEVAL DISCIPLINE (the evidence-consumption acceptance).
// ---------------------------------------------------------------------------

test('LAB-004: THE RETRIEVAL DISCIPLINE — the origin-class filter is MANDATORY, closed, duplicate-free', () => {
  const scope = { agencyId: '00000000-0000-0000-0000-000000000001', clientId: CLIENT_ID };
  // The mandatory filter.
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: [] } as never),
    'originClasses is REQUIRED',
  );
  assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'] });
  // The strict evidence filter passes the gate.
  assertValidLabIdeaRetrievalInput({ scope, originClasses: LAB_IDEAS_EVIDENCE_ORIGIN_CLASSES });
  // The closed vocabulary.
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: ['invented' as never] }),
    'originClasses entry',
  );
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source', 'observed_source'] }),
    'originClasses may not contain duplicates',
  );
  // The optional kind subset.
  assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'], primitiveKinds: ['hook', 'claim'] });
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'], primitiveKinds: ['vibe' as never] }),
    'primitiveKinds entry',
  );
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'], primitiveKinds: [] }),
    'primitiveKinds must be a non-empty list when provided',
  );
  // The citation filters + the page bound + the cursor shape.
  assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'], citedBundleReference: `${BUNDLE_ID}#v3` });
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'], citedBundleReference: 'nope' }),
    'citedBundleReference must be the citable form',
  );
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'], citedReferenceId: 'nope' }),
    'citedReferenceId must be a uuid',
  );
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'], limit: 0 }),
    'limit must be an integer 1-100',
  );
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'], limit: 101 }),
    'limit must be an integer 1-100',
  );
  assertInvalid(
    () => assertValidLabIdeaRetrievalInput({ scope, originClasses: ['observed_source'], cursor: 'not a cursor!!' }),
    'cursor must be the opaque keyset cursor',
  );
});

// ---------------------------------------------------------------------------
// (6) The deterministic identity derivation (the reproducible identity).
// ---------------------------------------------------------------------------

test('LAB-004: the canonical JSON serialization — DEEP sorted keys, stable against insertion order', () => {
  assert.equal(labIdeasCanonicalJson({ b: 1, a: { d: 2, c: 3 } }), labIdeasCanonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(labIdeasCanonicalJson({ x: [{ z: 1, y: 2 }] }), '{"x":[{"y":2,"z":1}]}');
  // Array order is semantic (never reordered).
  assert.notEqual(labIdeasCanonicalJson({ x: [1, 2] }), labIdeasCanonicalJson({ x: [2, 1] }));
});

test('LAB-004: the INPUT + IDENTITY digests — pure functions; any consumed change differs', () => {
  const base = { citation: citation() };
  const d1 = computeLabIdeaInputDigest(base);
  assert.equal(computeLabIdeaInputDigest(base), d1);
  // The feature-map echo participates (a changed bundle → a new decomposition).
  const changedFeatures = computeLabIdeaInputDigest({
    citation: citation({ features: { ...citation().features, duration: { state: 'derived', value: { valueSeconds: 62 } } } }),
  });
  assert.notEqual(changedFeatures, d1);
  // A differently-ORDERED feature map with the same content is the same digest.
  const baseFeatures = citation().features;
  const reordered = computeLabIdeaInputDigest({
    citation: citation({
      features: {
        title_description_hashtag_semantics: baseFeatures['title_description_hashtag_semantics']!,
        problem_claim: baseFeatures['problem_claim']!,
        duration: baseFeatures['duration']!,
      },
    }),
  });
  assert.equal(reordered, d1);
  // The identity digest: the pure function over (bundle identity, idea-set version, decomposer, input digest).
  const bundleIdentity = {
    bundleId: BUNDLE_ID,
    bundleReference: `${BUNDLE_ID}#v1`,
    bundleVersion: 1,
    referenceId: REFERENCE_ID,
    corpusId: CORPUS_ID,
    corpusVersion: 1,
    provider: 'youtube',
    providerContentId: 'vid-123',
    canonicalUrl: 'https://www.youtube.com/watch?v=vid-123',
    metadataDigest: DIGEST_A,
    featureSetVersion: 'lab-featureset-v1',
    extractorId: 'lab-first-party-metadata',
    extractorVersion: '1',
    bundleIdentityDigest: DIGEST_B,
  };
  const identityBase = {
    bundleIdentity,
    ideaSetVersion: LAB_IDEA_SET_VERSION,
    decomposerIdentity: { decomposerId: FIRST_PARTY_DECOMPOSER_ID, decomposerVersion: FIRST_PARTY_DECOMPOSER_VERSION },
    inputDigest: d1,
  };
  const i1 = computeLabIdeaIdentityDigest(identityBase);
  assert.equal(computeLabIdeaIdentityDigest(identityBase), i1);
  assert.notEqual(computeLabIdeaIdentityDigest({ ...identityBase, inputDigest: 'c'.repeat(64) }), i1);
  assert.notEqual(
    computeLabIdeaIdentityDigest({ ...identityBase, decomposerIdentity: { decomposerId: FIRST_PARTY_DECOMPOSER_ID, decomposerVersion: '2' } }),
    i1,
  );
  assert.notEqual(
    computeLabIdeaIdentityDigest({ ...identityBase, bundleIdentity: { ...bundleIdentity, metadataDigest: 'd'.repeat(64) } }),
    i1,
  );
});

// ---------------------------------------------------------------------------
// (7) The frozen novelty formula.
// ---------------------------------------------------------------------------

test('LAB-004: THE NOVELTY FORMULA — the frozen tokenization, the Jaccard similarity, the pure score against OBSERVED nodes', () => {
  // The frozen tokenization: lowercase alphanumeric tokens, deduplicated, sorted.
  assert.deepEqual(labIdeaTokenSet('The THE the best-home gym!'), ['best', 'gym', 'home', 'the']);
  assert.deepEqual(labIdeaTokenSet(''), []);
  // The Jaccard similarity.
  assert.equal(labIdeaJaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(labIdeaJaccardSimilarity(['a'], ['b']), 0);
  assert.equal(labIdeaJaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'd']), 2 / 4);
  assert.equal(labIdeaJaccardSimilarity([], []), 0);
  // The pure score: 1 − max similarity over the observed same-kind set.
  const observed = [
    { nodeId: '00000000-0000-0000-0000-000000000001', descriptor: 'home gym space saving hacks' },
    { nodeId: '00000000-0000-0000-0000-000000000002', descriptor: 'cheap home gym gear' },
  ];
  const identical = computeLabIdeaNovelty({ primitiveKind: 'hook', descriptor: 'space saving home gym hacks' }, observed);
  assert.equal(identical.noveltyVersion, 'lab-idea-novelty-v1');
  assert.equal(identical.observedComparisonCount, 2);
  // tokens(identical) = {home, gym, space, saving, hacks}; tokens(observed[0]) = the same set → similarity 1 → novelty 0.
  assert.equal(identical.noveltyScore, 0);
  assert.equal(identical.nearestSimilarity, 1);
  assert.equal(identical.nearestObservedNodeId, '00000000-0000-0000-0000-000000000001');
  // A fully disjoint candidate → novelty 1.
  const disjoint = computeLabIdeaNovelty({ primitiveKind: 'hook', descriptor: 'quantum crochet patterns' }, observed);
  assert.equal(disjoint.noveltyScore, 1);
  assert.equal(disjoint.nearestSimilarity, 0);
  // The empty observed set → novelty 1 (fully novel kind space).
  const empty = computeLabIdeaNovelty({ primitiveKind: 'hook', descriptor: 'anything' }, []);
  assert.equal(empty.noveltyScore, 1);
  assert.equal(empty.observedComparisonCount, 0);
  assert.equal(empty.nearestObservedNodeId, null);
  // Deterministic: the same inputs → the same measure.
  assert.deepEqual(
    computeLabIdeaNovelty({ primitiveKind: 'hook', descriptor: 'cheap home gym gear' }, observed),
    computeLabIdeaNovelty({ primitiveKind: 'hook', descriptor: 'cheap home gym gear' }, observed),
  );
});

// ---------------------------------------------------------------------------
// (8) The deterministic clustering.
// ---------------------------------------------------------------------------

test('LAB-004: THE CLUSTERING — kind-partitioned connected components, deterministic keys, generated nodes never cluster', () => {
  const nodes = [
    { nodeId: 'n000000000000000000000000000001', primitiveKind: 'hook' as const, originClass: 'observed_source' as const, descriptor: 'space saving home gym hacks' },
    { nodeId: 'n000000000000000000000000000002', primitiveKind: 'hook' as const, originClass: 'observed_source' as const, descriptor: 'home gym space saving tricks' },
    { nodeId: 'n000000000000000000000000000003', primitiveKind: 'hook' as const, originClass: 'observed_source' as const, descriptor: 'quantum crochet patterns' },
    { nodeId: 'n000000000000000000000000000004', primitiveKind: 'claim' as const, originClass: 'observed_source' as const, descriptor: 'gear lasts years' },
    { nodeId: 'n000000000000000000000000000005', primitiveKind: 'claim' as const, originClass: 'derived_abstraction' as const, descriptor: 'gear lasts for many years' },
    { nodeId: 'n000000000000000000000000000006', primitiveKind: 'hook' as const, originClass: 'generated_mutation' as const, descriptor: 'space saving home gym hacks' },
  ];
  const assignments = clusterLabIdeaNodes(nodes);
  // Same nodes + same version → the same clusters (pure function).
  assert.deepEqual(clusterLabIdeaNodes(nodes), assignments);
  // hook space: n1~n2 (similarity ≥ 0.5) cluster; n3 singleton; the GENERATED node never clusters.
  const byNode = new Map(assignments.map((a) => [a.nodeId, a]));
  assert.equal(byNode.get('n000000000000000000000000000001')!.clusterKey, 'hook#n000000000000000000000000000001');
  assert.equal(byNode.get('n000000000000000000000000000002')!.clusterKey, 'hook#n000000000000000000000000000001');
  assert.equal(byNode.get('n000000000000000000000000000002')!.clusterSize, 2);
  assert.equal(byNode.get('n000000000000000000000000000003')!.clusterSize, 1);
  assert.equal(byNode.get('n000000000000000000000000000003')!.clusterKey, 'hook#n000000000000000000000000000003');
  // claim space: observed + derived cluster together (the evidence-bearing space).
  assert.equal(byNode.get('n000000000000000000000000000004')!.clusterKey, 'claim#n000000000000000000000000000004');
  assert.equal(byNode.get('n000000000000000000000000000005')!.clusterKey, 'claim#n000000000000000000000000000004');
  assert.equal(byNode.get('n000000000000000000000000000005')!.clusterSize, 2);
  // The generated node has NO assignment.
  assert.equal(byNode.get('n000000000000000000000000000006'), undefined);
  assert.equal(assignments.length, 5);
  // Every member row carries its primitive kind.
  for (const assignment of assignments) {
    assert.ok(['hook', 'claim'].includes(assignment.primitiveKind));
  }
});

// ---------------------------------------------------------------------------
// (9) The lineage construction (recorded DATA, bounded).
// ---------------------------------------------------------------------------

function step(seq: number, from: string, to: string, relation: LabIdeaLineageStep['relation']): LabIdeaLineageStep {
  return { seq, fromNodeId: from, toNodeId: to, relation };
}

test('LAB-004: THE LINEAGE CONSTRUCTION — the new edges first, then the inputs\' recorded chains, deduplicated, renumbered', () => {
  const inputA = 'n00000000000000000000000000000a';
  const inputB = 'n00000000000000000000000000000b';
  const output = 'n00000000000000000000000000000c';
  // Input B is itself derived from an observed node — its chain rides along.
  const lineage = buildLabIdeaLineage({
    outputNodeId: output,
    relation: 'combines_with',
    inputNodeIds: [inputA, inputB],
    inputLineages: [null, [step(1, 'n00000000000000000000000000000d', inputB, 'refines')]],
  });
  assert.deepEqual(lineage, [
    step(1, inputA, output, 'combines_with'),
    step(2, inputB, output, 'combines_with'),
    step(3, 'n00000000000000000000000000000d', inputB, 'refines'),
  ]);
  // Observed inputs carry null lineages — the chain ends at them.
  assert.deepEqual(
    buildLabIdeaLineage({ outputNodeId: output, relation: 'mutates_from', inputNodeIds: [inputA], inputLineages: [null] }),
    [step(1, inputA, output, 'mutates_from')],
  );
  // The 64-step bound fails closed (never silently truncated).
  const deep: LabIdeaLineageStep[] = [];
  for (let i = 0; i < 64; i += 1) {
    deep.push(step(i + 1, `f${i}`, `t${i}`, 'refines'));
  }
  assertInvalid(
    () =>
      buildLabIdeaLineage({
        outputNodeId: output,
        relation: 'refines',
        inputNodeIds: [inputA],
        inputLineages: [deep],
      }),
    'lineage would exceed the 64-step bound',
  );
});

// ---------------------------------------------------------------------------
// (10) The first-party decomposer honesty table.
// ---------------------------------------------------------------------------

test('LAB-004: THE FIRST-PARTY DECOMPOSER — honest derivations ONLY (a feature in its unavailable state derives NO primitive; no semantic edges)', async () => {
  const decomposer = createFirstPartyLabIdeaDecomposer();
  assert.equal(decomposer.decomposerId, FIRST_PARTY_DECOMPOSER_ID);
  assert.equal(decomposer.decomposerId, 'lab-ideas-first-party-metadata');
  assert.equal(decomposer.decomposerVersion, FIRST_PARTY_DECOMPOSER_VERSION);
  assert.equal(decomposer.ideaSetVersion, LAB_IDEA_SET_VERSION);
  // The metadata-grade derivations light up: packaging + timing_context.
  const result = await decomposer.decompose({ citation: citation() });
  assert.ok(!('reason' in result), 'the first-party decomposer succeeds on the well-formed citation');
  const success = result as unknown as { nodes: ReadonlyArray<{ primitiveKind: string; descriptor: string }>; edges: unknown[] };
  const kinds = success.nodes.map((node) => node.primitiveKind).sort();
  assert.deepEqual(kinds, ['packaging', 'timing_context']);
  // The honest descriptors: explicitly-labeled records of the derived content.
  const packaging = success.nodes.find((node) => node.primitiveKind === 'packaging')!;
  assert.ok(packaging.descriptor.startsWith('packaging (lexical)'));
  assert.ok(packaging.descriptor.includes('7-token title'));
  assert.ok(packaging.descriptor.includes('2 hashtags [#fitness #gear]'));
  const timing = success.nodes.find((node) => node.primitiveKind === 'timing_context')!;
  assert.equal(timing.descriptor, 'timing context: 61s recorded duration');
  // HONEST: zero semantic edges from the deterministic metadata decomposer.
  assert.deepEqual(success.edges, []);
  // An unavailable feature derives nothing: with only problem_claim (unavailable), NO problem/claim nodes.
  const semanticOnly = await decomposer.decompose({
    citation: citation({ features: { problem_claim: { state: 'unavailable', reason: 'encoder_unavailable' } } }),
  });
  assert.ok(!('reason' in semanticOnly));
  assert.deepEqual((semanticOnly as unknown as { nodes: ReadonlyArray<{ primitiveKind: string }> }).nodes.map((node) => node.primitiveKind), []);
  // The encoder-grade table lights up when a real representation arrives (the port seam).
  const wired = await decomposer.decompose({
    citation: citation({
      features: {
        problem_claim: { state: 'derived', value: { problem: 'no space', claim: 'folding gear fixes it' } },
        hook_structure: { state: 'derived', value: { pattern: 'question opener' } },
        speaking_rate: { state: 'derived', value: { wordsPerMinute: 165 } },
      },
    }),
  });
  assert.ok(!('reason' in wired));
  const wiredKinds = (wired as unknown as { nodes: ReadonlyArray<{ primitiveKind: string }> }).nodes.map((node) => node.primitiveKind).sort();
  assert.deepEqual(wiredKinds, ['audio_treatment', 'claim', 'hook', 'problem']);
  // A wrong-typed derived value derives NOTHING (never fabricated).
  const wrongTyped = await decomposer.decompose({
    citation: citation({ features: { problem_claim: { state: 'derived', value: { problem: 42 } } } }),
  });
  assert.ok(!('reason' in wrongTyped));
  assert.deepEqual((wrongTyped as unknown as { nodes: ReadonlyArray<{ primitiveKind: string }> }).nodes.map((node) => node.primitiveKind), []);
});

// ---------------------------------------------------------------------------
// (11) The first-party generator honesty table (REAL vs PENDING).
// ---------------------------------------------------------------------------

function node(nodeId: string, primitiveKind: LabIdeaNodeRecord['primitiveKind'], descriptor: string, originClass: LabIdeaNodeRecord['originClass'] = 'observed_source'): LabIdeaNodeRecord {
  return {
    nodeId,
    primitiveKind,
    originClass,
    descriptor,
    attributes: {},
    decompositionId: originClass === 'observed_source' ? 'd000000000000000000000000000001' : null,
    citedBundleReference: originClass === 'observed_source' ? `${BUNDLE_ID}#v1` : null,
    creatingOperationId: originClass === 'observed_source' ? null : 'o000000000000000000000000000001',
    creatingOperationKind: originClass === 'observed_source' ? null : 'derive',
    lineage: originClass === 'observed_source' ? null : [],
    noveltyScore: originClass === 'observed_source' ? null : 1,
    noveltyVersion: originClass === 'observed_source' ? null : 'lab-idea-novelty-v1',
    agencyId: '00000000-0000-0000-0000-000000000001',
    clientId: CLIENT_ID,
    workspaceId: null,
    contractVersion: 'lab-ideas-contract-v1',
    createdAt: '2026-10-04T00:00:00Z',
    updatedAt: '2026-10-04T00:00:00Z',
  };
}

test('LAB-004: THE FIRST-PARTY GENERATOR — the structural kinds are REAL, the open-ended kinds PENDING (honest, never fabricated)', async () => {
  const generator = createFirstPartyLabIdeaGenerator();
  assert.equal(generator.generatorId, FIRST_PARTY_GENERATOR_ID);
  assert.equal(generator.generatorId, 'lab-ideas-structural-first-party');
  assert.equal(generator.generatorVersion, FIRST_PARTY_GENERATOR_VERSION);
  // derive: the shared-structure abstraction (REAL, deterministic, explicitly labeled).
  const derived = await generator.generate({
    operationKind: 'derive',
    inputNodes: [
      node('n000000000000000000000000000001', 'hook', 'space saving home gym hacks'),
      node('n000000000000000000000000000002', 'hook', 'home gym space saving tricks'),
    ],
  });
  assert.equal(derived.status, 'generated');
  if (derived.status === 'generated') {
    assert.ok(derived.descriptor.startsWith('derived abstraction (structural)'));
    assert.ok(derived.descriptor.includes('shared tokens:'));
    assert.deepEqual(derived.attributes?.inputKinds, ['hook']);
  }
  // recombine: the ordered structural composition (REAL).
  const combined = await generator.generate({
    operationKind: 'recombine',
    inputNodes: [
      node('n000000000000000000000000000001', 'hook', 'space saving home gym hacks'),
      node('n000000000000000000000000000004', 'claim', 'gear lasts years'),
    ],
  });
  assert.equal(combined.status, 'generated');
  if (combined.status === 'generated') {
    assert.ok(combined.descriptor.startsWith('combined strategy (structural)'));
    assert.ok(combined.descriptor.includes('<hook> space saving home gym hacks + <claim> gear lasts years'));
    assert.deepEqual(combined.attributes?.inputKinds, ['claim', 'hook']);
  }
  // fill_gap: the recorded gap (REAL — a fact, never invented content).
  const gap = await generator.generate({
    operationKind: 'fill_gap',
    inputNodes: [
      node('n000000000000000000000000000001', 'hook', 'space saving home gym hacks'),
      node('n000000000000000000000000000002', 'hook', 'quantum crochet patterns'),
    ],
  });
  assert.equal(gap.status, 'generated');
  if (gap.status === 'generated') {
    assert.ok(gap.descriptor.startsWith('gap (structural)'));
    assert.equal(gap.attributes?.gap, true);
  }
  // The open-ended generative kinds: the honest PENDING refusals.
  for (const kind of ['mutate', 'analogy', 'invert'] as const) {
    const pending = await generator.generate({
      operationKind: kind,
      inputNodes: [node('n000000000000000000000000000001', 'hook', 'space saving home gym hacks')],
    });
    assert.equal(pending.status, 'pending');
    if (pending.status === 'pending') {
      assert.ok(pending.reason.includes(`the open-ended generative kind '${kind}' has no generator wired`));
    }
  }
});
