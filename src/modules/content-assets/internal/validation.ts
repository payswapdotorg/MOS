/**
 * /content-assets input guards (MKT-064) — the pure validation core.
 *
 * Fail-closed by rejection BEFORE any write: vocabulary membership,
 * grammar, shape, bounds and the server-derived provenance discipline
 * (the /content-rights validation precedent). Every guard throws
 * InvalidRequestError (malformed input) — unknown/foreign ids are the
 * ROUTE layer's uniform NotFoundError concern, never a validation
 * concern.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type {
  ContentAssetsProvenance,
  ContentMediaKind,
  ContentQualityMetric,
  ContentTransformationStatus,
  TransformationKind,
} from '../public.ts';
import {
  CONTENT_ASSET_LIFECYCLE_EVENT_KINDS,
  CONTENT_ASSET_LIFECYCLE_STATES,
  CONTENT_MEDIA_KINDS,
  CONTENT_QUALITY_METRICS,
  CONTENT_TRANSFORMATION_STATUSES,
  MAX_TRANSFORMATION_INGREDIENTS,
  TRANSFORMATION_KINDS,
} from '../public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_PATTERN = /^.{1,100}$/s;
const VIA_PATTERN = /^.{1,100}$/s;
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{1,98}\/[A-Za-z0-9][A-Za-z0-9.+-]{0,98}$/;
const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** The bounded size of a transformation parameters/output-spec JSON object. */
export const MAX_JSON_PAYLOAD_BYTES = 32 * 1024;
/** The bounded size of one materialized object payload. */
export const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

/** Vocabulary membership guards (closed sets — never caller freedom). */
export function isKnownTransformationKind(value: string): value is TransformationKind {
  return (TRANSFORMATION_KINDS as readonly string[]).includes(value);
}
export function isKnownContentMediaKind(value: string): value is ContentMediaKind {
  return (CONTENT_MEDIA_KINDS as readonly string[]).includes(value);
}
export function isKnownContentQualityMetric(value: string): value is ContentQualityMetric {
  return (CONTENT_QUALITY_METRICS as readonly string[]).includes(value);
}
export function isKnownContentTransformationStatus(value: string): value is ContentTransformationStatus {
  return (CONTENT_TRANSFORMATION_STATUSES as readonly string[]).includes(value);
}
export function isKnownContentAssetLifecycleState(value: string): value is (typeof CONTENT_ASSET_LIFECYCLE_STATES)[number] {
  return (CONTENT_ASSET_LIFECYCLE_STATES as readonly string[]).includes(value);
}
export function isKnownContentAssetLifecycleEventKind(value: string): value is (typeof CONTENT_ASSET_LIFECYCLE_EVENT_KINDS)[number] {
  return (CONTENT_ASSET_LIFECYCLE_EVENT_KINDS as readonly string[]).includes(value);
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidRequestError(`${field} must be a canonical UUID (found '${value}')`);
  }
}

/** The server-derived provenance discipline (never request fields). */
export function assertValidContentAssetsProvenance(
  provenance: ContentAssetsProvenance,
): void {
  if (provenance === null || typeof provenance !== 'object') {
    throw new InvalidRequestError('provenance is required (server-derived)');
  }
  if (typeof provenance.actor !== 'string' || !ACTOR_PATTERN.test(provenance.actor)) {
    throw new InvalidRequestError('provenance.actor must be a bounded non-empty string (1-100 chars)');
  }
  if (typeof provenance.recordedVia !== 'string' || !VIA_PATTERN.test(provenance.recordedVia)) {
    throw new InvalidRequestError('provenance.recordedVia must be a bounded non-empty string (1-100 chars)');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.length === 0
      || provenance.correlationId.length > 128) {
    throw new InvalidRequestError('provenance.correlationId must be a bounded non-empty string (1-128 chars)');
  }
  if (provenance.causationId !== null
      && (typeof provenance.causationId !== 'string' || provenance.causationId.length === 0
          || provenance.causationId.length > 128)) {
    throw new InvalidRequestError('provenance.causationId must be null or a bounded non-empty string (1-128 chars)');
  }
}

/** Guard: registerAssetVersion input (born-draft source versions). */
export function assertValidRegisterAssetVersionInput(input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly assetId: string | null;
  readonly mediaKind: string;
  readonly displayName: string;
  readonly contentType: string;
  readonly sourceEvidenceRef: string;
}): void {
  requireUuid(input.agencyId, 'agencyId');
  requireUuid(input.clientId, 'clientId');
  if (input.workspaceId !== null) {
    requireUuid(input.workspaceId, 'workspaceId');
  }
  if (input.assetId !== null) {
    requireUuid(input.assetId, 'assetId');
  }
  if (!isKnownContentMediaKind(input.mediaKind)) {
    throw new InvalidRequestError(
      `mediaKind must be one of the frozen content-media vocabulary (${CONTENT_MEDIA_KINDS.join(' | ')}), found '${input.mediaKind}'`,
    );
  }
  if (typeof input.displayName !== 'string' || input.displayName.length === 0
      || input.displayName.length > 200) {
    throw new InvalidRequestError('displayName must be a bounded non-empty string (1-200 chars)');
  }
  if (typeof input.contentType !== 'string' || !CONTENT_TYPE_PATTERN.test(input.contentType)) {
    throw new InvalidRequestError(
      `contentType must be a bounded MIME-type-shaped string (e.g. 'video/mp4'), found '${input.contentType}'`,
    );
  }
  // The /evidence-anchored source provenance is REQUIRED for source
  // versions (the migration-053 provenance-shape CHECK is the persisted
  // mirror; the DB same-Client trigger is the backstop).
  requireUuid(input.sourceEvidenceRef, 'sourceEvidenceRef');
}

/** Guard: materializeAssetVersion input. */
export function assertValidMaterializeInput(input: {
  readonly versionId: string;
  readonly bytes: Uint8Array;
}): void {
  requireUuid(input.versionId, 'versionId');
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new InvalidRequestError('bytes must be a non-empty Uint8Array payload');
  }
  if (input.bytes.byteLength > MAX_OBJECT_BYTES) {
    throw new InvalidRequestError(
      `bytes exceeds the maximum object payload size (${MAX_OBJECT_BYTES} bytes — the bounded inline-object contract of this surface)`,
    );
  }
}

/** Guard: recordQualityObservation input (the observation discipline). */
export function assertValidQualityObservationInput(input: {
  readonly versionId: string;
  readonly metric: string;
  readonly numericValue: number | null;
  readonly textValue: string | null;
}): void {
  requireUuid(input.versionId, 'versionId');
  if (!isKnownContentQualityMetric(input.metric)) {
    throw new InvalidRequestError(
      `metric must be one of the frozen quality-metric vocabulary (${CONTENT_QUALITY_METRICS.join(' | ')}) — observations only, a fabricated 'score' is not representable; found '${input.metric}'`,
    );
  }
  if (input.metric === 'language') {
    if (typeof input.textValue !== 'string' || !LANGUAGE_TAG_PATTERN.test(input.textValue)) {
      throw new InvalidRequestError(
        "the 'language' metric carries a bounded BCP-47-shaped text tag (e.g. 'en', 'pt-BR')",
      );
    }
    if (input.numericValue !== null) {
      throw new InvalidRequestError("the 'language' metric carries a text value only");
    }
    return;
  }
  if (typeof input.numericValue !== 'number' || !Number.isFinite(input.numericValue)
      || input.numericValue < 0) {
    throw new InvalidRequestError(
      `the '${input.metric}' metric carries a non-negative finite numeric value`,
    );
  }
  if (input.numericValue > Number.MAX_SAFE_INTEGER) {
    throw new InvalidRequestError(`the '${input.metric}' metric value exceeds the safe integer range`);
  }
  if (input.metric === 'caption_coverage_ratio' && input.numericValue > 1) {
    throw new InvalidRequestError("the 'caption_coverage_ratio' metric is a ratio bounded to [0, 1]");
  }
  if (input.textValue !== null) {
    throw new InvalidRequestError(`the '${input.metric}' metric carries a numeric value only`);
  }
}

/**
 * Guard: one bounded JSON object payload (transformation parameters /
 * output spec). JSON-serializable, object-shaped, bounded — the §21
 * discipline is the route layer's (material-shaped keys never reach
 * here as request bodies do not pass through this guard set; the
 * payload stays opaque engine data).
 */
export function assertValidJsonPayload(
  value: Readonly<Record<string, unknown>>,
  field: string,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError(`${field} must be a JSON object`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new InvalidRequestError(`${field} must be JSON-serializable`);
  }
  if (serialized === undefined) {
    throw new InvalidRequestError(`${field} must be JSON-serializable`);
  }
  if (serialized.length > MAX_JSON_PAYLOAD_BYTES) {
    throw new InvalidRequestError(
      `${field} exceeds the maximum serialized size (${MAX_JSON_PAYLOAD_BYTES} bytes)`,
    );
  }
}

/**
 * The request-level problems of a transformation request (the floating-
 * version rejection lives HERE: every ingredient names an EXPLICIT
 * (assetId, version) pair — a request without exact versions is
 * rejected before any write).
 */
export function transformationRequestProblems(input: {
  readonly workspaceId: string;
  readonly transformationKind: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly outputSpec: Readonly<Record<string, unknown>>;
  readonly ingredients: readonly {
    readonly assetId: string;
    readonly version: number;
  }[];
  readonly engineId: string | null;
}): string[] {
  const problems: string[] = [];
  if (!UUID_PATTERN.test(input.workspaceId)) {
    problems.push('workspaceId must be a canonical UUID (the execution authority is workspace-scoped)');
  }
  if (!isKnownTransformationKind(input.transformationKind)) {
    problems.push(
      `transformationKind must be one of the frozen family (${TRANSFORMATION_KINDS.join(' | ')}), found '${input.transformationKind}'`,
    );
  }
  if (input.ingredients.length === 0) {
    problems.push('a transformation requires at least one ingredient (explicit versions)');
  }
  if (input.ingredients.length > MAX_TRANSFORMATION_INGREDIENTS) {
    problems.push(
      `a transformation declares at most ${MAX_TRANSFORMATION_INGREDIENTS} ingredients, found ${input.ingredients.length}`,
    );
  }
  const seen = new Set<string>();
  for (const [index, ingredient] of input.ingredients.entries()) {
    if (typeof ingredient.assetId !== 'string' || !UUID_PATTERN.test(ingredient.assetId)) {
      problems.push(`ingredient ${index} assetId must be a canonical UUID`);
    }
    if (typeof ingredient.version !== 'number' || !Number.isInteger(ingredient.version)
        || ingredient.version < 1) {
      problems.push(
        `ingredient ${index} version must be an EXPLICIT one-based integer version number (floating 'latest' pointers are rejected — the version discipline)`,
      );
    }
    const key = `${ingredient.assetId}:${ingredient.version}`;
    if (seen.has(key)) {
      problems.push(`ingredient ${index} duplicates (asset ${ingredient.assetId}, version ${ingredient.version}) — the same version is one ingredient`);
    }
    seen.add(key);
  }
  if (input.engineId !== null
      && (typeof input.engineId !== 'string' || input.engineId.length === 0
          || input.engineId.length > 100)) {
    problems.push('engineId must be null or a bounded non-empty string (1-100 chars)');
  }
  return problems;
}

/** Guard: requestTransformation input (composition of the sub-guards). */
export function assertValidRequestTransformationInput(input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly transformationKind: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly outputSpec: Readonly<Record<string, unknown>>;
  readonly ingredients: readonly {
    readonly assetId: string;
    readonly version: number;
  }[];
  readonly engineId: string | null;
}): void {
  requireUuid(input.agencyId, 'agencyId');
  requireUuid(input.clientId, 'clientId');
  assertValidJsonPayload(input.parameters, 'parameters');
  assertValidJsonPayload(input.outputSpec, 'outputSpec');
  const problems = transformationRequestProblems(input);
  if (problems.length > 0) {
    throw new InvalidRequestError(problems.join('; '));
  }
}

/** Guard: executeTransformation input. */
export function assertValidExecuteTransformationInput(input: {
  readonly transformationId: string;
}): void {
  requireUuid(input.transformationId, 'transformationId');
}

/** Guard: the output-spec metadata keys the module itself interprets. */
export function assertValidOutputSpecMetadata(outputSpec: Readonly<Record<string, unknown>>): void {
  const mediaKind = outputSpec['mediaKind'];
  if (typeof mediaKind !== 'string' || !isKnownContentMediaKind(mediaKind)) {
    throw new InvalidRequestError(
      `outputSpec.mediaKind must be one of the frozen content-media vocabulary (${CONTENT_MEDIA_KINDS.join(' | ')}) — the intended output's media class, found '${String(mediaKind)}'`,
    );
  }
  const displayName = outputSpec['displayName'];
  if (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 200) {
    throw new InvalidRequestError('outputSpec.displayName must be a bounded non-empty string (1-200 chars)');
  }
}
