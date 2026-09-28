/**
 * /lab-corpus contract guards (LAB-002) — the PURE deterministic
 * validation core.
 *
 * These guards enforce the frozen corpus contract semantics (spec/
 * architecture-v1.7-marketing-lab.md §4 "Reference-first content
 * universe", §22 multi-tenancy; spec/effective-backlog-v1.7.md LAB-002
 * acceptance: "reference-first storage, provider-specific acquisition
 * policy, provenance, deduplication, observation timestamps, coverage
 * reporting, no unauthorized media retention"):
 *
 *   - the acquisition-policy discipline (per-provider permitted rights
 *     bases + the closed media-access posture — the provider-specific
 *     policy gate the ingestion path enforces);
 *   - the Content Reference field fences (§4 verbatim field set:
 *     bounded provider/provider_content_id, an http(s) canonical URL,
 *     ISO-UTC publication/observation times, the closed rights basis,
 *     bounded provenance strings, a bounded metadata snapshot object,
 *     the 64-hex metadata digest, the closed media-availability
 *     vocabulary);
 *   - the observation fences (ISO-UTC observed_at, bounded provenance
 *     strings, the digest shape, the closed availability vocabulary);
 *   - NO MEDIA-BYTES SURFACE: no guard accepts (and no record field
 *     holds) any byte-bearing media payload — the reference-first
 *     discipline is structural (migration 061 has no binary column;
 *     the validation surface cannot even express one).
 *
 * Pure functions: no clock, no randomness, no network — the unit
 * battery pins every rule.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  LAB_CORPUS_MEDIA_ACCESS_POSTURES,
  LAB_CORPUS_MEDIA_AVAILABILITIES,
  LAB_CORPUS_POLICY_VERSION,
  LAB_CORPUS_RIGHTS_BASES,
  type LabCorpusAcquisitionPolicy,
  type LabCorpusMediaAvailability,
  type LabCorpusRightsBasis,
  type RecordLabCorpusObservationInput,
  type RegisterLabCorpusReferenceInput,
} from '../public.ts';

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s]{1,2040}$/;

function isUtcIso(value: string): boolean {
  if (!ISO_UTC_PATTERN.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && !Number.isNaN(new Date(value).getTime());
}

function isHex64(value: string): boolean {
  return HEX_64_PATTERN.test(value);
}

function boundedString(resource: string, value: unknown, min: number, max: number): boolean {
  return typeof value === 'string' && value.length >= min && value.length <= max && value.length === value.trim().length;
}

/**
 * The acquisition-policy discipline (§4 "Provider adapters MUST
 * enforce provider-specific acquisition constraints" — the corpus
 * records the policy; this guard keeps the RECORD honest): the pinned
 * policy vocabulary version, 1-64 provider entries with 1-64 char
 * provider names, each holding a NON-EMPTY subset of the closed
 * rights-basis vocabulary (no duplicates) and one closed media-access
 * posture. 'metadata_only' and 'reference_gated' are the only postures
 * — a durable-media posture is unrepresentable.
 */
export function assertValidLabCorpusAcquisitionPolicy(policy: LabCorpusAcquisitionPolicy): void {
  if (policy === null || typeof policy !== 'object') {
    throw new InvalidRequestError('acquisitionPolicy must be an object');
  }
  if (policy.version !== LAB_CORPUS_POLICY_VERSION) {
    throw new InvalidRequestError(`acquisitionPolicy.version must be '${LAB_CORPUS_POLICY_VERSION}'`);
  }
  if (policy.providers === null || typeof policy.providers !== 'object' || Array.isArray(policy.providers)) {
    throw new InvalidRequestError('acquisitionPolicy.providers must be an object');
  }
  const providers = Object.keys(policy.providers);
  if (providers.length < 1 || providers.length > 64) {
    throw new InvalidRequestError('acquisitionPolicy.providers must hold 1-64 entries');
  }
  for (const provider of providers) {
    if (!PROVIDER_PATTERN.test(provider)) {
      throw new InvalidRequestError(`acquisitionPolicy.providers key '${provider}' must be 1-64 chars of [a-z0-9-]`);
    }
    const entry = (policy.providers as Record<string, unknown>)[provider];
    if (entry === null || typeof entry !== 'object') {
      throw new InvalidRequestError(`acquisitionPolicy.providers['${provider}'] must be an object`);
    }
    const permitted = (entry as { permittedBases?: unknown }).permittedBases;
    if (!Array.isArray(permitted) || permitted.length < 1 || permitted.length > LAB_CORPUS_RIGHTS_BASES.length) {
      throw new InvalidRequestError(`acquisitionPolicy.providers['${provider}'].permittedBases must be a non-empty subset of the rights-basis vocabulary`);
    }
    const seen = new Set<string>();
    for (const basis of permitted) {
      if (!LAB_CORPUS_RIGHTS_BASES.includes(basis as LabCorpusRightsBasis)) {
        throw new InvalidRequestError(`acquisitionPolicy.providers['${provider}'].permittedBases entry '${String(basis)}' is not in the closed rights-basis vocabulary`);
      }
      if (seen.has(basis)) {
        throw new InvalidRequestError(`acquisitionPolicy.providers['${provider}'].permittedBases entry '${String(basis)}' is duplicated`);
      }
      seen.add(basis);
    }
    const mediaAccess = (entry as { mediaAccess?: unknown }).mediaAccess;
    if (!LAB_CORPUS_MEDIA_ACCESS_POSTURES.includes(mediaAccess as (typeof LAB_CORPUS_MEDIA_ACCESS_POSTURES)[number])) {
      throw new InvalidRequestError(`acquisitionPolicy.providers['${provider}'].mediaAccess must be one of ${LAB_CORPUS_MEDIA_ACCESS_POSTURES.join(', ')}`);
    }
  }
}

/**
 * The Content Reference field fences (§4 verbatim field set): bounded
 * provider and provider_content_id, an http(s) canonical URL ≤ 2048
 * chars, an optional bounded creator reference, an optional ISO-UTC
 * publication time (never in the future — the observation may not
 * precede the content's existence claim), the closed rights basis,
 * bounded provenance strings (collection method/version), a bounded
 * metadata snapshot object (≤ 256 keys, the durable observation — NOT
 * media), the 64-hex lowercase metadata digest, and the closed
 * media-availability vocabulary.
 */
export function assertValidLabCorpusReferenceInput(input: RegisterLabCorpusReferenceInput, nowIso: string): void {
  if (input === null || typeof input !== 'object') {
    throw new InvalidRequestError('reference input must be an object');
  }
  if (!PROVIDER_PATTERN.test(String(input.provider))) {
    throw new InvalidRequestError('provider must be 1-64 chars of [a-z0-9-]');
  }
  if (!boundedString('providerContentId', input.providerContentId, 1, 256)) {
    throw new InvalidRequestError('providerContentId must be a trimmed string of 1-256 chars');
  }
  if (typeof input.canonicalUrl !== 'string' || !HTTP_URL_PATTERN.test(input.canonicalUrl)) {
    throw new InvalidRequestError('canonicalUrl must be an http(s) URL of at most 2048 chars');
  }
  if (input.creatorRef !== undefined && input.creatorRef !== null && !boundedString('creatorRef', input.creatorRef, 1, 256)) {
    throw new InvalidRequestError('creatorRef must be null or a trimmed string of 1-256 chars');
  }
  if (input.publicationTime !== undefined && input.publicationTime !== null) {
    if (!isUtcIso(String(input.publicationTime))) {
      throw new InvalidRequestError('publicationTime must be an ISO 8601 UTC timestamp');
    }
    if (Date.parse(String(input.publicationTime)) > Date.parse(nowIso)) {
      throw new InvalidRequestError('publicationTime may not be in the future');
    }
  }
  if (!LAB_CORPUS_RIGHTS_BASES.includes(input.rightsBasis as LabCorpusRightsBasis)) {
    throw new InvalidRequestError(`rightsBasis must be one of ${LAB_CORPUS_RIGHTS_BASES.join(', ')}`);
  }
  if (!boundedString('collectionMethod', input.collectionMethod, 1, 64)) {
    throw new InvalidRequestError('collectionMethod must be a trimmed string of 1-64 chars');
  }
  if (!boundedString('collectionVersion', input.collectionVersion, 1, 64)) {
    throw new InvalidRequestError('collectionVersion must be a trimmed string of 1-64 chars');
  }
  if (input.metadataSnapshot === null || typeof input.metadataSnapshot !== 'object' || Array.isArray(input.metadataSnapshot)) {
    throw new InvalidRequestError('metadataSnapshot must be an object');
  }
  if (Object.keys(input.metadataSnapshot).length > 256) {
    throw new InvalidRequestError('metadataSnapshot must hold at most 256 keys');
  }
  if (!isHex64(String(input.metadataDigest))) {
    throw new InvalidRequestError('metadataDigest must be a 64-char lowercase hex SHA-256 string');
  }
  const availability = input.mediaAvailability ?? 'unknown';
  if (!LAB_CORPUS_MEDIA_AVAILABILITIES.includes(availability as LabCorpusMediaAvailability)) {
    throw new InvalidRequestError(`mediaAvailability must be one of ${LAB_CORPUS_MEDIA_AVAILABILITIES.join(', ')}`);
  }
}

/**
 * The observation fences (§4 observation timestamps): an optional
 * ISO-UTC observed_at (never in the future — an observation is a
 * record of a past sighting), bounded provenance strings, the digest
 * shape, and the closed availability vocabulary.
 */
export function assertValidLabCorpusObservationInput(input: RecordLabCorpusObservationInput, nowIso: string): void {
  if (input === null || typeof input !== 'object') {
    throw new InvalidRequestError('observation input must be an object');
  }
  if (input.observedAt !== undefined && input.observedAt !== null) {
    if (!isUtcIso(String(input.observedAt))) {
      throw new InvalidRequestError('observedAt must be an ISO 8601 UTC timestamp');
    }
    if (Date.parse(String(input.observedAt)) > Date.parse(nowIso)) {
      throw new InvalidRequestError('observedAt may not be in the future');
    }
  }
  if (!boundedString('collectionMethod', input.collectionMethod, 1, 64)) {
    throw new InvalidRequestError('collectionMethod must be a trimmed string of 1-64 chars');
  }
  if (!boundedString('collectionVersion', input.collectionVersion, 1, 64)) {
    throw new InvalidRequestError('collectionVersion must be a trimmed string of 1-64 chars');
  }
  if (!isHex64(String(input.metadataDigest))) {
    throw new InvalidRequestError('metadataDigest must be a 64-char lowercase hex SHA-256 string');
  }
  if (!LAB_CORPUS_MEDIA_AVAILABILITIES.includes(input.mediaAvailability as LabCorpusMediaAvailability)) {
    throw new InvalidRequestError(`mediaAvailability must be one of ${LAB_CORPUS_MEDIA_AVAILABILITIES.join(', ')}`);
  }
}
