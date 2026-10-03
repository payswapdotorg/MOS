/**
 * /lab-features contract guards (LAB-003) — the PURE deterministic
 * validation + identity core.
 *
 * These guards enforce the frozen feature-bundle contract semantics
 * (spec/architecture-v1.7-marketing-lab.md §4 "Reference-first
 * content universe", §5 "Multimodal Content Feature Bundle", §22
 * multi-tenancy; spec/effective-backlog-v1.7.md LAB-003 acceptance:
 * "reproducible feature identity/versioning, source linkage, batch
 * extraction, failure states, tenant isolation"):
 *
 *   - THE CITATION FENCES (§4 source linkage): uuid-shaped ids, a
 *     bounded provider/provider_content_id/canonical URL, the
 *     64-hex metadata digest, a bounded metadata snapshot object
 *     (the durable observation — NEVER media bytes), and the closed
 *     media-availability vocabulary;
 *   - THE GRANT FENCES (the §4 media-access gate inputs): the closed
 *     availability + posture vocabularies — the gate semantics
 *     themselves (only available_permitted + reference_gated opens a
 *     path; everything else fails closed) live in the module;
 *   - THE CONFIGURATION FENCES: the closed modality requirement
 *     subset (no duplicates);
 *   - THE BATCH BOUNDS: 1-100 items;
 *   - THE VALUE-MAP DISCIPLINE (§5): exactly the closed 27-key
 *     feature set, every value either derived (with encoder
 *     identity) or unavailable (with its closed reason);
 *   - THE DETERMINISTIC IDENTITY DERIVATION: the canonical JSON
 *     serialization (DEEP sorted keys — the citation's metadata
 *     snapshot is arbitrary nested jsonb whose key order is not
 *     stable across corpus re-reads, so the one-level house digest
 *     is extended to full depth here; arrays keep their order —
 *     array order is semantic) and the two pure-function SHA-256
 *     digests (input digest over the complete extraction input;
 *     identity digest over the reference identity fields + the
 *     feature-set version + the extractor identity+version + the
 *     input digest).
 *
 * Pure functions: no clock, no randomness, no network — the unit
 * battery pins every rule.
 */

import { createHash } from 'node:crypto';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  LAB_FEATURES_BATCH_MAX_ITEMS,
  LAB_FEATURE_KEY_LIST,
  LAB_FEATURE_MODALITIES,
  LAB_FEATURE_MEDIA_ACCESS_POSTURES,
  LAB_FEATURE_MEDIA_AVAILABILITIES,
  LAB_FEATURE_UNAVAILABLE_REASONS,
  type ExtractLabFeatureBatchInput,
  type LabFeatureBatchItem,
  type LabFeatureExtractionConfiguration,
  type LabFeatureMediaAccessPosture,
  type LabFeatureMediaAvailability,
  type LabFeatureMediaGrant,
  type LabFeatureModality,
  type LabFeatureReferenceCitation,
  type LabFeatureValue,
  type LabFeatureValueMap,
} from '../public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s]{1,2040}$/;
const ENCODER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isHex64(value: string): boolean {
  return HEX_64_PATTERN.test(value);
}

function boundedString(value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max && value.length === value.trim().length;
}

// ---------------------------------------------------------------------------
// The canonical JSON serialization (the reproducibility substrate).
// ---------------------------------------------------------------------------

/**
 * The canonical JSON serialization: DEEP sorted object keys (arrays
 * keep their order — array order is semantic), then JSON.stringify.
 * The same logical value always serializes identically regardless of
 * key insertion order — the deterministic-identity discipline.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Serializes a value to its canonical JSON form (deep sorted keys). */
export function labFeaturesCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// ---------------------------------------------------------------------------
// The citation fences (§4 source linkage).
// ---------------------------------------------------------------------------

/**
 * The Content Reference citation fences: uuid-shaped referenceId/
 * clientId/corpusId, corpusVersion ≥ 1, a bounded provider +
 * providerContentId, an http(s) canonical URL ≤ 2048 chars, the
 * 64-hex lowercase metadata digest, a bounded metadata snapshot
 * object (≤ 256 keys — the durable observation, NEVER media bytes),
 * and the closed media-availability vocabulary. NO byte-bearing
 * payload is expressible anywhere on this surface.
 */
export function assertValidLabFeatureCitation(citation: LabFeatureReferenceCitation): void {
  if (citation === null || typeof citation !== 'object') {
    throw new InvalidRequestError('citation must be an object');
  }
  if (!isUuid(String(citation.referenceId))) {
    throw new InvalidRequestError('citation.referenceId must be a uuid');
  }
  if (!isUuid(String(citation.clientId))) {
    throw new InvalidRequestError('citation.clientId must be a uuid (the recorded owning client)');
  }
  if (!isUuid(String(citation.corpusId))) {
    throw new InvalidRequestError('citation.corpusId must be a uuid');
  }
  if (!Number.isInteger(citation.corpusVersion) || citation.corpusVersion < 1) {
    throw new InvalidRequestError('citation.corpusVersion must be an integer ≥ 1');
  }
  if (!PROVIDER_PATTERN.test(String(citation.provider))) {
    throw new InvalidRequestError('citation.provider must be 1-64 chars of [a-z0-9-]');
  }
  if (!boundedString(citation.providerContentId, 1, 256)) {
    throw new InvalidRequestError('citation.providerContentId must be a trimmed string of 1-256 chars');
  }
  if (typeof citation.canonicalUrl !== 'string' || !HTTP_URL_PATTERN.test(citation.canonicalUrl)) {
    throw new InvalidRequestError('citation.canonicalUrl must be an http(s) URL of at most 2048 chars');
  }
  if (!isHex64(String(citation.metadataDigest))) {
    throw new InvalidRequestError('citation.metadataDigest must be a 64-char lowercase hex SHA-256 string');
  }
  if (
    citation.metadataSnapshot === null ||
    typeof citation.metadataSnapshot !== 'object' ||
    Array.isArray(citation.metadataSnapshot)
  ) {
    throw new InvalidRequestError('citation.metadataSnapshot must be an object');
  }
  if (Object.keys(citation.metadataSnapshot).length > 256) {
    throw new InvalidRequestError('citation.metadataSnapshot must hold at most 256 keys');
  }
  if (!LAB_FEATURE_MEDIA_AVAILABILITIES.includes(citation.mediaAvailability as LabFeatureMediaAvailability)) {
    throw new InvalidRequestError(
      `citation.mediaAvailability must be one of ${LAB_FEATURE_MEDIA_AVAILABILITIES.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The grant + configuration fences (the §4 media-gate inputs).
// ---------------------------------------------------------------------------

/**
 * The media-access grant fences: the closed availability vocabulary +
 * the closed posture vocabulary (the gate SEMANTICS — only
 * available_permitted + reference_gated opens a path — are enforced
 * in the module's gate, fail closed BEFORE any bytes are requested).
 */
export function assertValidLabFeatureMediaGrant(grant: LabFeatureMediaGrant): void {
  if (grant === null || typeof grant !== 'object') {
    throw new InvalidRequestError('mediaGrant must be an object');
  }
  if (!LAB_FEATURE_MEDIA_AVAILABILITIES.includes(grant.availability as LabFeatureMediaAvailability)) {
    throw new InvalidRequestError(`mediaGrant.availability must be one of ${LAB_FEATURE_MEDIA_AVAILABILITIES.join(', ')}`);
  }
  if (!LAB_FEATURE_MEDIA_ACCESS_POSTURES.includes(grant.posture as LabFeatureMediaAccessPosture)) {
    throw new InvalidRequestError(`mediaGrant.posture must be one of ${LAB_FEATURE_MEDIA_ACCESS_POSTURES.join(', ')}`);
  }
}

/**
 * The extraction configuration fences: the optional modality
 * requirement — a duplicate-free subset of the closed modality
 * grouping vocabulary.
 */
export function assertValidLabFeatureConfiguration(configuration: LabFeatureExtractionConfiguration): void {
  if (configuration === null || typeof configuration !== 'object') {
    throw new InvalidRequestError('configuration must be an object');
  }
  if (configuration.requiredModalities !== undefined) {
    if (!Array.isArray(configuration.requiredModalities)) {
      throw new InvalidRequestError('configuration.requiredModalities must be an array when provided');
    }
    const seen = new Set<string>();
    for (const modality of configuration.requiredModalities) {
      if (!LAB_FEATURE_MODALITIES.includes(modality as LabFeatureModality)) {
        throw new InvalidRequestError(
          `configuration.requiredModalities entry '${String(modality)}' is not in the closed modality vocabulary ${LAB_FEATURE_MODALITIES.join(', ')}`,
        );
      }
      if (seen.has(modality)) {
        throw new InvalidRequestError(`configuration.requiredModalities entry '${modality}' is duplicated`);
      }
      seen.add(modality);
    }
  }
}

/**
 * The batch input fences: a scope object (module-side re-check), a
 * BOUNDED non-empty item list (1-100 — the bounded-list acceptance
 * rule) of item OBJECTS, and a valid extraction configuration.
 *
 * STRUCTURE ONLY, by design: the per-item citation and grant SEMANTICS
 * are deliberately NOT validated here. A semantically invalid citation
 * or grant is the honest per-item failed/invalid_input outcome INSIDE
 * the run (exactly ONE outcome record per item — the batch-extraction
 * acceptance), never a whole-batch rejection that would leave the
 * sibling items unrecorded. The module's per-item shape gate owns the
 * semantic fences (assertValidLabFeatureCitation +
 * assertValidLabFeatureMediaGrant); the integration battery proves the
 * split end-to-end.
 */
export function assertValidLabFeatureBatchInput(input: ExtractLabFeatureBatchInput): void {
  if (input === null || typeof input !== 'object') {
    throw new InvalidRequestError('batch input must be an object');
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > LAB_FEATURES_BATCH_MAX_ITEMS) {
    throw new InvalidRequestError(`items must be a bounded list of 1-${LAB_FEATURES_BATCH_MAX_ITEMS} citations`);
  }
  for (const item of input.items as ReadonlyArray<LabFeatureBatchItem>) {
    if (item === null || typeof item !== 'object') {
      throw new InvalidRequestError('every batch item must be an object');
    }
  }
  if (input.configuration !== undefined && input.configuration !== null) {
    assertValidLabFeatureConfiguration(input.configuration);
  }
}

// ---------------------------------------------------------------------------
// The value-map discipline (§5 — the closed feature set accounting).
// ---------------------------------------------------------------------------

/**
 * The per-key feature value discipline: the map holds EXACTLY the
 * closed 27-key set (no extra keys, no missing keys — the honest
 * accounting every bundle carries), every value is either derived
 * (with a shaped encoder identity and a bounded representation) or
 * unavailable (with its closed reason and a bounded optional
 * detail). This is the NEVER-FABRICATE fence: an unavailable value
 * cannot carry a representation and a derived value cannot omit its
 * encoder identity.
 */
export function assertValidLabFeatureValueMap(values: LabFeatureValueMap): void {
  if (values === null || typeof values !== 'object') {
    throw new InvalidRequestError('feature value map must be an object');
  }
  const expected: ReadonlyArray<string> = [...LAB_FEATURE_KEY_LIST].sort();
  const actual = Object.keys(values).sort();
  const missing = expected.filter((key) => !actual.includes(key));
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new InvalidRequestError(
      `feature value map must hold exactly the closed ${LAB_FEATURE_KEY_LIST.length}-key feature set (missing: ${
        missing.join(', ') || 'none'
      }; unexpected: ${unexpected.join(', ') || 'none'})`,
    );
  }
  const map = values as Record<string, unknown>;
  for (const key of LAB_FEATURE_KEY_LIST) {
    const value = map[key] as LabFeatureValue | undefined;
    if (value === null || typeof value !== 'object') {
      throw new InvalidRequestError(`feature '${key}' value must be an object`);
    }
    if (value.state === 'derived') {
      const encoder = (value as { encoder?: unknown }).encoder;
      if (encoder === null || typeof encoder !== 'object') {
        throw new InvalidRequestError(`derived feature '${key}' must carry its encoder identity (§5)`);
      }
      const encoderId = (encoder as { encoderId?: unknown }).encoderId;
      const encoderVersion = (encoder as { encoderVersion?: unknown }).encoderVersion;
      if (typeof encoderId !== 'string' || !ENCODER_ID_PATTERN.test(encoderId)) {
        throw new InvalidRequestError(`derived feature '${key}' encoder.encoderId must be 1-64 chars of [a-z0-9-]`);
      }
      if (typeof encoderVersion !== 'string' || encoderVersion.length < 1 || encoderVersion.length > 64) {
        throw new InvalidRequestError(`derived feature '${key}' encoder.encoderVersion must be 1-64 chars`);
      }
      if ('value' in value === false) {
        throw new InvalidRequestError(`derived feature '${key}' must carry its concrete representation`);
      }
    } else if (value.state === 'unavailable') {
      if (!LAB_FEATURE_UNAVAILABLE_REASONS.includes((value as { reason?: unknown }).reason as never)) {
        throw new InvalidRequestError(
          `unavailable feature '${key}' reason must be one of ${LAB_FEATURE_UNAVAILABLE_REASONS.join(', ')}`,
        );
      }
      if ('value' in value) {
        throw new InvalidRequestError(`unavailable feature '${key}' may not carry a representation (never fabricated)`);
      }
    } else {
      throw new InvalidRequestError(`feature '${key}' state must be 'derived' or 'unavailable'`);
    }
  }
}

// ---------------------------------------------------------------------------
// The deterministic identity derivation (reproducible identity).
// ---------------------------------------------------------------------------

/**
 * THE INPUT DIGEST: SHA-256 over the canonical JSON of the COMPLETE
 * extraction input of one item — the citation (identity fields AND
 * the metadata snapshot) + the presented media grant (when any) +
 * the extraction configuration. Any change to what the extraction
 * consumes changes the input digest (and therefore the bundle
 * identity).
 */
export function computeLabFeatureInputDigest(input: {
  citation: LabFeatureReferenceCitation;
  mediaGrant: LabFeatureMediaGrant | undefined;
  configuration: LabFeatureExtractionConfiguration;
}): string {
  return createHash('sha256')
    .update(
      labFeaturesCanonicalJson({
        citation: input.citation,
        mediaGrant: input.mediaGrant ?? null,
        configuration: {
          requiredModalities: input.configuration.requiredModalities
            ? [...input.configuration.requiredModalities].sort()
            : [],
        },
      }),
    )
    .digest('hex');
}

/**
 * THE DETERMINISTIC IDENTITY DIGEST: SHA-256 over the canonical JSON
 * of (the cited reference identity fields, the feature-set version,
 * the extractor identity+version, the input digest) — a PURE
 * FUNCTION: the same inputs always produce the same identity (the
 * idempotence fence); a changed feature-set/extractor/input version
 * produces a different identity (a NEW bundle version on the same
 * per-reference chain, never an in-place rewrite).
 */
export function computeLabFeatureIdentityDigest(input: {
  referenceIdentity: {
    referenceId: string;
    corpusId: string;
    corpusVersion: number;
    provider: string;
    providerContentId: string;
    canonicalUrl: string;
    metadataDigest: string;
  };
  featureSetVersion: string;
  extractorIdentity: { extractorId: string; extractorVersion: string };
  inputDigest: string;
}): string {
  return createHash('sha256')
    .update(
      labFeaturesCanonicalJson({
        referenceIdentity: input.referenceIdentity,
        featureSetVersion: input.featureSetVersion,
        extractorIdentity: input.extractorIdentity,
        inputDigest: input.inputDigest,
      }),
    )
    .digest('hex');
}
