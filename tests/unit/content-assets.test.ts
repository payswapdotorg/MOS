/**
 * MKT-064 unit tests — the frozen Content Assets vocabularies, the
 * content-asset ref grammar (the 063 seam interop), the pure lifecycle
 * math, the engine resolution math, the quality-observation discipline
 * and the input/provenance guards (pure functions, no DB).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-064: "versioned content
 * assets plus first-party/extension transformation execution contracts.
 * Acceptance: crop/reframe/padding/compilation/clip/caption/voice/
 * translation/format transformations retain lineage and quality
 * observations"; spec/architecture-v1.6.md §10; spec/
 * architecture-lock-v1.6.md rules 23/24; spec/
 * module-dependency-matrix-v1.6.md boundary rule 5):
 *   - the vocabularies are frozen and versioned (ca-vocab-v1): the
 *     transformation kinds (the MKT-064 acceptance list VERBATIM), the
 *     media kinds, the lifecycle states, the lifecycle event kinds, the
 *     transformation statuses and the quality metrics (the closed
 *     observation vocabulary — a fabricated 'score' is not
 *     representable);
 *   - THE REF GRAMMAR (the 063 seam interop): every minted ref parses
 *     back to its canonical version id; the mint/parse pair round-trips;
 *     foreign refs parse to null (opaque, never an error);
 *   - THE LIFECYCLE MATH: draft → materialized is the ONLY legal move;
 *     derived is a birth state (an existing version can never become a
 *     transformation output — every other pair is rejected);
 *   - THE ENGINE RESOLUTION (the capability seam): the declared engine
 *     must exist AND support the kind; the default resolves the first
 *     supporting engine; a kind with NO registered engine resolves null
 *     (fail-closed — the MKT-056 discipline);
 *   - the input guards reject every malformed shape (unknown vocabulary
 *     value, malformed uuid/MIME type, oversized fields, the
 *     floating-version rejection, duplicate ingredients, bounded JSON
 *     payloads) fail-closed BEFORE any write, and the provenance guard
 *     enforces the server-derived discipline;
 *   - THE OBSERVATION DISCIPLINE: 'language' carries a text tag only;
 *     every other metric a non-negative number; caption coverage is a
 *     ratio bounded to [0, 1]; the value shapes are mutually exclusive;
 *   - the first-party engine DOUBLES implement the real contract
 *     shapes: the passthrough no-op returns the single ingredient's
 *     bytes verbatim; the format/crop doubles reject multi-ingredient
 *     and malformed-parameter inputs and produce deterministic
 *     synthetic outputs (no real media processing — disclosed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import {
  CONTENT_ASSET_REF_PATTERN,
  CONTENT_ASSET_LIFECYCLE_EVENT_KINDS,
  CONTENT_ASSET_LIFECYCLE_STATES,
  CONTENT_ASSETS_VOCABULARY_VERSION,
  CONTENT_MEDIA_KINDS,
  CONTENT_QUALITY_METRICS,
  CONTENT_TRANSFORMATION_STATUSES,
  MAX_TRANSFORMATION_INGREDIENTS,
  TRANSFORMATION_KINDS,
  createContentAssetReferencePort,
  isLegalContentAssetLifecycleMove,
  mintContentAssetRef,
  parseContentAssetRef,
  resolveTransformationEngine,
  type ContentAssetsModuleApi,
  type TransformationEngine,
} from '../../src/modules/content-assets/public.ts';
import {
  assertValidContentAssetsProvenance,
  assertValidJsonPayload,
  assertValidMaterializeInput,
  assertValidOutputSpecMetadata,
  assertValidQualityObservationInput,
  assertValidRegisterAssetVersionInput,
  assertValidRequestTransformationInput,
  MAX_OBJECT_BYTES,
  transformationRequestProblems,
} from '../../src/modules/content-assets/public.ts';
import {
  createCropTransformationEngine,
  createFormatTransformationEngine,
  createPassthroughTransformationEngine,
} from '../../src/modules/content-assets/public.ts';
import type { ContentAssetReferencePort } from '../../src/modules/content-rights/public.ts';

const PROVENANCE = {
  actor: 'user:11111111-1111-4111-8111-111111111111',
  recordedVia: 'test',
  correlationId: 'unit-content-assets-1',
  causationId: null,
} as const;

const UUID_A = '0b6bd3a6-1f2a-4c3d-9e8f-0a1b2c3d4e5f';
const UUID_B = '1c7ce4b7-2f3a-4d4e-8f90-1b2c3d4e5f60';
const UUID_C = '2d8df5c8-3a4b-4e5f-90a1-2c3d4e5f6071';

// ---------------------------------------------------------------------------
// The frozen vocabularies (ca-vocab-v1)
// ---------------------------------------------------------------------------

test('MKT-064: the transformation kind family is the acceptance list VERBATIM (frozen, versioned)', () => {
  assert.deepEqual(TRANSFORMATION_KINDS, [
    'crop', 'reframe', 'padding', 'compilation', 'clip',
    'caption', 'voice', 'translation', 'format',
  ]);
  assert.equal(CONTENT_ASSETS_VOCABULARY_VERSION, 'ca-vocab-v1');
});

test('MKT-064: the media, lifecycle, event, status and metric vocabularies are frozen closed sets', () => {
  assert.deepEqual(CONTENT_MEDIA_KINDS, ['video', 'audio', 'image', 'text', 'document']);
  assert.deepEqual(CONTENT_ASSET_LIFECYCLE_STATES, ['draft', 'materialized', 'derived']);
  assert.deepEqual(CONTENT_ASSET_LIFECYCLE_EVENT_KINDS, [
    'registration', 'materialization', 'derivation',
  ]);
  assert.deepEqual(CONTENT_TRANSFORMATION_STATUSES, ['requested', 'completed', 'failed']);
  assert.deepEqual(CONTENT_QUALITY_METRICS, [
    'duration_ms', 'width_px', 'height_px', 'bitrate_kbps',
    'caption_coverage_ratio', 'language', 'fps', 'sample_rate_hz', 'byte_size',
  ]);
  // The observation discipline: a 'score' metric is NOT representable —
  // the closed vocabulary cannot even express one.
  assert.ok(!(CONTENT_QUALITY_METRICS as readonly string[]).includes('score'));
  assert.ok(!(CONTENT_QUALITY_METRICS as readonly string[]).includes('quality_score'));
});

// ---------------------------------------------------------------------------
// The content-asset ref grammar (the 063 seam interop)
// ---------------------------------------------------------------------------

test('MKT-064: the mint/parse pair round-trips the canonical version id (the 063 seam target)', () => {
  const ref = mintContentAssetRef(UUID_A);
  assert.equal(ref, `ca:${UUID_A}`);
  // The minted ref satisfies BOTH this module's grammar AND the 063
  // migration-051 opaque ref grammar (the interop contract).
  assert.match(ref, CONTENT_ASSET_REF_PATTERN);
  assert.match(ref, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  assert.equal(parseContentAssetRef(ref), UUID_A);
  // Distinct ids mint distinct refs (the ref IS the version identity).
  assert.notEqual(mintContentAssetRef(UUID_A), mintContentAssetRef(UUID_B));
});

test('MKT-064: a foreign or malformed ref parses to null (opaque, never an error)', () => {
  assert.equal(parseContentAssetRef('not-a-ref'), null);
  assert.equal(parseContentAssetRef('ca:not-a-uuid'), null);
  assert.equal(parseContentAssetRef(UUID_A), null);
  assert.equal(parseContentAssetRef(''), null);
  assert.equal(parseContentAssetRef('ca:ABC-Not-Hex'), null);
});

// ---------------------------------------------------------------------------
// The lifecycle math (the version discipline)
// ---------------------------------------------------------------------------

test('MKT-064: draft → materialized is the ONLY legal lifecycle move; derived is a birth state', () => {
  const states = CONTENT_ASSET_LIFECYCLE_STATES;
  let legalPairs = 0;
  for (const from of states) {
    for (const to of states) {
      const legal = isLegalContentAssetLifecycleMove(from, to);
      if (legal) {
        legalPairs += 1;
        assert.equal(from, 'draft');
        assert.equal(to, 'materialized');
      }
    }
  }
  assert.equal(legalPairs, 1, 'exactly ONE legal lifecycle move exists (draft → materialized)');
  // The explicit rejections: an existing version can never BECOME a
  // transformation output (outputs are NEW versions born 'derived').
  assert.equal(isLegalContentAssetLifecycleMove('materialized', 'derived'), false);
  assert.equal(isLegalContentAssetLifecycleMove('derived', 'materialized'), false);
  assert.equal(isLegalContentAssetLifecycleMove('draft', 'derived'), false);
  assert.equal(isLegalContentAssetLifecycleMove('materialized', 'draft'), false);
  assert.equal(isLegalContentAssetLifecycleMove('derived', 'draft'), false);
});

// ---------------------------------------------------------------------------
// The engine resolution (the capability seam — the MKT-056 discipline)
// ---------------------------------------------------------------------------

function engineDouble(id: string, kinds: readonly string[]): TransformationEngine {
  return {
    engineId: id,
    supportedKinds: kinds as TransformationEngine['supportedKinds'],
    declaredEffects: ['test double'],
    declaredConstraints: ['test double'],
    executionKind: 'deterministic',
    async execute() {
      throw new Error('not invoked by the resolution tests');
    },
  };
}

test('MKT-064: the engine resolution is declared-choice-first, first-supporting default, null when unserved (fail-closed)', () => {
  const engines = [
    engineDouble('first-party:format', ['format']),
    engineDouble('first-party:passthrough', TRANSFORMATION_KINDS),
  ];
  // The declared engine must exist AND support the kind.
  assert.equal(resolveTransformationEngine(engines, 'format', 'first-party:format')?.engineId, 'first-party:format');
  assert.equal(resolveTransformationEngine(engines, 'crop', 'first-party:format'), null, 'a declared engine that does not support the kind is NOT usable');
  assert.equal(resolveTransformationEngine(engines, 'crop', 'first-party:missing'), null);
  // The default: the FIRST engine supporting the kind.
  assert.equal(resolveTransformationEngine(engines, 'crop', null)?.engineId, 'first-party:passthrough');
  // A kind with NO registered engine resolves null (fail-closed — no
  // silent fallback, no hardcoded provider).
  assert.equal(resolveTransformationEngine([], 'crop', null), null);
  assert.equal(resolveTransformationEngine([engineDouble('first-party:format', ['format'])], 'voice', null), null);
});

// ---------------------------------------------------------------------------
// The input guards (fail-closed BEFORE any write)
// ---------------------------------------------------------------------------

const REGISTER_INPUT = {
  agencyId: UUID_A,
  clientId: UUID_B,
  workspaceId: null,
  assetId: null,
  mediaKind: 'video',
  displayName: 'Launch teaser',
  contentType: 'video/mp4',
  sourceEvidenceRef: UUID_C,
} as const;

test('MKT-064: the register guard accepts the canonical shape and rejects every malformed one', () => {
  assertValidRegisterAssetVersionInput(REGISTER_INPUT);
  assert.throws(
    () => assertValidRegisterAssetVersionInput({ ...REGISTER_INPUT, mediaKind: 'hologram' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidRegisterAssetVersionInput({ ...REGISTER_INPUT, displayName: '' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidRegisterAssetVersionInput({ ...REGISTER_INPUT, displayName: 'x'.repeat(201) }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidRegisterAssetVersionInput({ ...REGISTER_INPUT, contentType: 'not-a-mime' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidRegisterAssetVersionInput({ ...REGISTER_INPUT, sourceEvidenceRef: 'nope' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidRegisterAssetVersionInput({ ...REGISTER_INPUT, agencyId: 'nope' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidRegisterAssetVersionInput({ ...REGISTER_INPUT, workspaceId: 'nope' }),
    InvalidRequestError,
  );
});

test('MKT-064: the materialize guard enforces non-empty bounded bytes', () => {
  assertValidMaterializeInput({ versionId: UUID_A, bytes: new Uint8Array([1, 2, 3]) });
  assert.throws(() => assertValidMaterializeInput({ versionId: UUID_A, bytes: new Uint8Array() }), InvalidRequestError);
  assert.throws(
    () => assertValidMaterializeInput({ versionId: UUID_A, bytes: new Uint8Array(MAX_OBJECT_BYTES + 1) }),
    InvalidRequestError,
  );
  assert.throws(() => assertValidMaterializeInput({ versionId: 'nope', bytes: new Uint8Array([1]) }), InvalidRequestError);
});

test('MKT-064: THE OBSERVATION DISCIPLINE — text/numeric shape exclusivity, ratios, non-negativity, closed vocabulary', () => {
  assertValidQualityObservationInput({ versionId: UUID_A, metric: 'duration_ms', numericValue: 12500, textValue: null });
  assertValidQualityObservationInput({ versionId: UUID_A, metric: 'language', numericValue: null, textValue: 'pt-BR' });
  assertValidQualityObservationInput({ versionId: UUID_A, metric: 'caption_coverage_ratio', numericValue: 0.87, textValue: null });
  // The closed vocabulary: an unknown metric (a fabricated 'score') is
  // rejected outright.
  assert.throws(
    () => assertValidQualityObservationInput({ versionId: UUID_A, metric: 'quality_score', numericValue: 5, textValue: null }),
    InvalidRequestError,
  );
  // 'language' carries a text tag only.
  assert.throws(
    () => assertValidQualityObservationInput({ versionId: UUID_A, metric: 'language', numericValue: 1, textValue: null }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidQualityObservationInput({ versionId: UUID_A, metric: 'language', numericValue: null, textValue: 'not a tag!!' }),
    InvalidRequestError,
  );
  // Every other metric carries a non-negative finite number.
  assert.throws(
    () => assertValidQualityObservationInput({ versionId: UUID_A, metric: 'duration_ms', numericValue: null, textValue: 'long' }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidQualityObservationInput({ versionId: UUID_A, metric: 'duration_ms', numericValue: -1, textValue: null }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidQualityObservationInput({ versionId: UUID_A, metric: 'duration_ms', numericValue: Number.POSITIVE_INFINITY, textValue: null }),
    InvalidRequestError,
  );
  // The caption-coverage ratio is bounded to [0, 1].
  assert.throws(
    () => assertValidQualityObservationInput({ versionId: UUID_A, metric: 'caption_coverage_ratio', numericValue: 1.5, textValue: null }),
    InvalidRequestError,
  );
});

test('MKT-064: THE FLOATING-VERSION REJECTION — every ingredient names an EXPLICIT one-based version', () => {
  const base = {
    agencyId: UUID_A,
    clientId: UUID_B,
    workspaceId: UUID_C,
    transformationKind: 'compilation',
    parameters: {},
    outputSpec: {},
    engineId: null,
  } as const;
  // The canonical multi-ingredient request.
  assertValidRequestTransformationInput({
    ...base,
    ingredients: [
      { assetId: UUID_A, version: 1 },
      { assetId: UUID_B, version: 3 },
    ],
  });
  // The floating pointers: no version (undefined is not even
  // expressible through the typed contract — the guard rejects the
  // malformed shapes that reach it).
  const problems0 = transformationRequestProblems({
    workspaceId: UUID_C,
    transformationKind: 'compilation',
    parameters: {},
    outputSpec: {},
    ingredients: [{ assetId: UUID_A, version: undefined as unknown as number }],
    engineId: null,
  });
  assert.ok(problems0.some((problem) => problem.includes('EXPLICIT one-based integer version')));
  // Version 0 and negative versions are floating/malformed.
  for (const badVersion of [0, -1, 1.5]) {
    const problems = transformationRequestProblems({
      workspaceId: UUID_C,
      transformationKind: 'compilation',
      parameters: {},
      outputSpec: {},
      ingredients: [{ assetId: UUID_A, version: badVersion }],
      engineId: null,
    });
    assert.ok(problems.length > 0, `version ${badVersion} is rejected`);
  }
  // No ingredients at all is rejected.
  assert.ok(transformationRequestProblems({
    workspaceId: UUID_C,
    transformationKind: 'compilation',
    parameters: {},
    outputSpec: {},
    ingredients: [],
    engineId: null,
  }).some((problem) => problem.includes('at least one ingredient')));
  // The ingredient bound.
  const tooMany = Array.from({ length: MAX_TRANSFORMATION_INGREDIENTS + 1 }, (_, i) => ({
    assetId: `${UUID_A.slice(0, 35)}${i.toString(16).padStart(1, '0')}`.slice(0, 36),
    version: 1,
  }));
  assert.ok(transformationRequestProblems({
    workspaceId: UUID_C,
    transformationKind: 'compilation',
    parameters: {},
    outputSpec: {},
    ingredients: tooMany,
    engineId: null,
  }).some((problem) => problem.includes(`at most ${MAX_TRANSFORMATION_INGREDIENTS} ingredients`)));
  // Duplicate ingredients are rejected.
  assert.ok(transformationRequestProblems({
    workspaceId: UUID_C,
    transformationKind: 'compilation',
    parameters: {},
    outputSpec: {},
    ingredients: [
      { assetId: UUID_A, version: 1 },
      { assetId: UUID_A, version: 1 },
    ],
    engineId: null,
  }).some((problem) => problem.includes('duplicates')));
  // An unknown kind is rejected.
  assert.throws(
    () => assertValidRequestTransformationInput({
      ...base,
      transformationKind: 'upscale' as never,
      ingredients: [{ assetId: UUID_A, version: 1 }],
    }),
    InvalidRequestError,
  );
  // A malformed workspace id is rejected (the execution authority is
  // workspace-scoped).
  assert.throws(
    () => assertValidRequestTransformationInput({
      ...base,
      workspaceId: 'nope',
      ingredients: [{ assetId: UUID_A, version: 1 }],
    }),
    InvalidRequestError,
  );
});

test('MKT-064: the JSON payload guard enforces bounded object payloads', () => {
  assertValidJsonPayload({ target_format: 'mp4' }, 'parameters');
  assert.throws(() => assertValidJsonPayload([1, 2] as unknown as Record<string, unknown>, 'parameters'), InvalidRequestError);
  assert.throws(() => assertValidJsonPayload(null as unknown as Record<string, unknown>, 'parameters'), InvalidRequestError);
  const oversized = { blob: 'x'.repeat(33 * 1024) };
  assert.throws(() => assertValidJsonPayload(oversized, 'parameters'), InvalidRequestError);
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.throws(() => assertValidJsonPayload(cyclic, 'parameters'), InvalidRequestError);
});

test('MKT-064: the output-spec metadata guard requires the frozen media kind + a bounded display name', () => {
  assertValidOutputSpecMetadata({ mediaKind: 'video', displayName: 'Reframed 9:16' });
  assert.throws(() => assertValidOutputSpecMetadata({ mediaKind: 'hologram', displayName: 'x' }), InvalidRequestError);
  assert.throws(() => assertValidOutputSpecMetadata({ mediaKind: 'video' }), InvalidRequestError);
  assert.throws(() => assertValidOutputSpecMetadata({ mediaKind: 'video', displayName: '' }), InvalidRequestError);
});

test('MKT-064: the provenance guard enforces the server-derived discipline', () => {
  assertValidContentAssetsProvenance(PROVENANCE);
  assert.throws(() => assertValidContentAssetsProvenance({ ...PROVENANCE, actor: '' }), InvalidRequestError);
  assert.throws(() => assertValidContentAssetsProvenance({ ...PROVENANCE, actor: 'x'.repeat(101) }), InvalidRequestError);
  assert.throws(() => assertValidContentAssetsProvenance({ ...PROVENANCE, recordedVia: '' }), InvalidRequestError);
  assert.throws(() => assertValidContentAssetsProvenance({ ...PROVENANCE, correlationId: '' }), InvalidRequestError);
  assert.throws(
    () => assertValidContentAssetsProvenance({ ...PROVENANCE, causationId: 'x'.repeat(129) }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidContentAssetsProvenance(null as unknown as typeof PROVENANCE),
    InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// The first-party engine doubles (the real contract shapes)
// ---------------------------------------------------------------------------

test('MKT-064: the passthrough double is a true no-op — the single ingredient bytes are the output', async () => {
  const engine = createPassthroughTransformationEngine();
  assert.equal(engine.engineId, 'first-party:passthrough');
  assert.deepEqual(engine.supportedKinds, [...TRANSFORMATION_KINDS]);
  assert.equal(engine.executionKind, 'deterministic');
  const bytes = new Uint8Array([104, 101, 108, 108, 111]);
  const output = await engine.execute({
    transformationId: UUID_A,
    kind: 'format',
    parameters: {},
    outputSpec: {},
    ingredients: [{
      versionId: UUID_B,
      assetRef: mintContentAssetRef(UUID_B),
      mediaKind: 'video' as const,
      displayName: 'source',
      objectKey: 'a'.repeat(64),
      objectSize: bytes.byteLength,
      bytes,
    }],
  });
  assert.deepEqual(output.outputBytes, bytes, 'the passthrough output is the input VERBATIM');
  assert.deepEqual(output.qualityObservations, []);
});

test('MKT-064: the format/crop doubles produce deterministic synthetic outputs and reject malformed inputs', async () => {
  const format = createFormatTransformationEngine();
  assert.deepEqual(format.supportedKinds, ['format']);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const ingredient = {
    versionId: UUID_B,
    assetRef: mintContentAssetRef(UUID_B),
    mediaKind: 'video' as const,
    displayName: 'source',
    objectKey: 'a'.repeat(64),
    objectSize: bytes.byteLength,
    bytes,
  };
  const output = await format.execute({
    transformationId: UUID_A,
    kind: 'format',
    parameters: { target_format: 'mp4' },
    outputSpec: {},
    ingredients: [ingredient],
  });
  // The deterministic synthetic container: a bounded header + the source
  // bytes (disclosed: NOT a real transcoder).
  const header = new TextDecoder().decode(output.outputBytes).split('\n')[0]!;
  assert.ok(header.includes('mos-tx-double:format'));
  assert.ok(header.includes('target=mp4'));
  assert.ok(output.outputBytes.byteLength > bytes.byteLength);
  assert.ok(output.outputBytes.slice(output.outputBytes.byteLength - 4).every((b, i) => b === bytes[i]));

  // The declared parameter is required and bounded.
  await assert.rejects(
    () => format.execute({
      transformationId: UUID_A,
      kind: 'format',
      parameters: {},
      outputSpec: {},
      ingredients: [ingredient],
    }),
    InvalidRequestError,
  );
  await assert.rejects(
    () => format.execute({
      transformationId: UUID_A,
      kind: 'format',
      parameters: { target_format: 'x'.repeat(65) },
      outputSpec: {},
      ingredients: [ingredient],
    }),
    InvalidRequestError,
  );
  // A multi-ingredient passthrough-style request is rejected by the
  // single-ingredient constraint.
  await assert.rejects(
    () => format.execute({
      transformationId: UUID_A,
      kind: 'format',
      parameters: { target_format: 'mp4' },
      outputSpec: {},
      ingredients: [ingredient, ingredient],
    }),
    InvalidRequestError,
  );

  const crop = createCropTransformationEngine();
  assert.deepEqual(crop.supportedKinds, ['crop']);
  const cropOutput = await crop.execute({
    transformationId: UUID_A,
    kind: 'crop',
    parameters: { x: 10, y: 20, width: 640, height: 480 },
    outputSpec: {},
    ingredients: [ingredient],
  });
  const cropHeader = new TextDecoder().decode(cropOutput.outputBytes).split('\n')[0]!;
  assert.ok(cropHeader.includes('mos-tx-double:crop'));
  assert.ok(cropHeader.includes('rect=10,20,640,480'));
  await assert.rejects(
    () => crop.execute({
      transformationId: UUID_A,
      kind: 'crop',
      parameters: { x: -1, y: 0, width: 10, height: 10 },
      outputSpec: {},
      ingredients: [ingredient],
    }),
    InvalidRequestError,
  );
  await assert.rejects(
    () => crop.execute({
      transformationId: UUID_A,
      kind: 'crop',
      parameters: { x: 0, y: 0, width: 0, height: 10 },
      outputSpec: {},
      ingredients: [ingredient],
    }),
    InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// The 063 seam satisfaction (the typed port)
// ---------------------------------------------------------------------------

test('MKT-064: the ContentAssetReferencePort factory satisfies the 063 typed seam', async () => {
  const calls: string[] = [];
  const api = {
    async resolveAssetRef(clientId: string, assetRef: string) {
      calls.push(`${clientId}:${assetRef}`);
      return assetRef === mintContentAssetRef(UUID_A)
        ? ({
            versionId: UUID_A,
            assetId: UUID_B,
            agencyId: UUID_C,
            clientId,
            workspaceId: null,
            version: 1,
            assetRef,
            mediaKind: 'video' as const,
            displayName: 'x',
            contentType: 'video/mp4',
            lifecycleState: 'materialized',
            objectKey: 'a'.repeat(64),
            objectDigest: 'a'.repeat(64),
            objectSize: 1,
            sourceEvidenceRef: UUID_B,
            provenance: {
              actor: 'user:x',
              recordedVia: 'test',
              correlationId: 'c',
              causationId: null,
              recordedAt: '2026-01-01T00:00:00.000Z',
            },
            versionCas: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          })
        : null;
    },
  } as unknown as ContentAssetsModuleApi;
  const port: ContentAssetReferencePort = createContentAssetReferencePort(api);
  const present = await port.resolveContentAssetRef(UUID_B, mintContentAssetRef(UUID_A));
  assert.deepEqual(present, { exists: true });
  const absent = await port.resolveContentAssetRef(UUID_B, mintContentAssetRef(UUID_C));
  assert.deepEqual(absent, { exists: false });
  assert.deepEqual(calls, [`${UUID_B}:${mintContentAssetRef(UUID_A)}`, `${UUID_B}:${mintContentAssetRef(UUID_C)}`]);
});
