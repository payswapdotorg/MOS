/**
 * /social-commerce-attribution pure guards (MKT-073).
 *
 * The input fences of the module commands: the vocabulary gates, the
 * bounded-scalar maps (the commerce attribution-passthrough
 * discipline), the mechanism-required construction inputs, the
 * survival-chain fence (the original content identity is carried) and
 * the canonical JSON (DEEP sorted — the deterministic identity/input
 * digests are computed over it). Everything here is PURE (no clock, no
 * randomness, no I/O) — the unit tests pin the semantics.
 */

import {
  SOCIAL_ATTRIBUTION_CARRIER_KINDS,
  SOCIAL_ATTRIBUTION_CONVERSION_KINDS,
  SOCIAL_ATTRIBUTION_MATCH_FIELDS,
  SOCIAL_ATTRIBUTION_MECHANISMS,
  SOCIAL_ATTRIBUTION_REF_PATTERN,
  isConstructibleSocialAttributionMechanism,
  isKnownSocialAttributionMechanism,
  type SocialAttributionCarrierKind,
  type SocialAttributionConstructibleMechanism,
  type SocialAttributionConversionKind,
  type SocialAttributionMatchField,
  type SocialAttributionMechanism,
} from '../public.ts';
import { isUuid } from '../../../platform/ids/ids.ts';
import { InvalidRequestError } from '../../../platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// The canonical JSON (DEEP sorted — the digest basis)
// ---------------------------------------------------------------------------

/**
 * The canonical JSON of any structured module input: object keys
 * sorted DEEPLY at every level, arrays preserved in order (the
 * lab-simulator canonical-JSON discipline — the same input always
 * hashes the same).
 */
export function canonicalSocialAttributionJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The bounded-scalar maps (the attribution-passthrough discipline)
// ---------------------------------------------------------------------------

const MAX_MAP_FIELDS = 20;
const MAX_MAP_KEY_LENGTH = 100;
const MAX_MAP_VALUE_LENGTH = 500;

/**
 * The bounded-scalar map guard (the commerce attribution-passthrough
 * discipline): at most {@link MAX_MAP_FIELDS} fields, every key
 * bounded, every value a bounded string / number / boolean / null —
 * objects and arrays are REJECTED (the matcher consumes scalars only;
 * the DB helper fence mirrors this).
 */
export function assertValidObservedFields(
  value: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const keys = Object.keys(value);
  if (keys.length > MAX_MAP_FIELDS) {
    throw new InvalidRequestError(`${label} carries more than ${MAX_MAP_FIELDS} observed fields`);
  }
  for (const key of keys) {
    if (key.length < 1 || key.length > MAX_MAP_KEY_LENGTH) {
      throw new InvalidRequestError(`${label} key '${key}' is outside the 1..${MAX_MAP_KEY_LENGTH} bound`);
    }
    const entry = value[key];
    if (entry !== null && typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      throw new InvalidRequestError(
        `${label}.${key} is not a scalar observed field (objects/arrays are rejected)`,
      );
    }
    if (typeof entry === 'string' && entry.length > MAX_MAP_VALUE_LENGTH) {
      throw new InvalidRequestError(
        `${label}.${key} exceeds the ${MAX_MAP_VALUE_LENGTH}-character observed-value bound`,
      );
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) {
      throw new InvalidRequestError(`${label}.${key} is not a finite observed value`);
    }
  }
}

/** The creation-context bound (the recorded linkage data of a reference). */
export function assertValidCreationContext(value: Readonly<Record<string, unknown>>): void {
  assertValidObservedFields(value, 'creationContext');
}

// ---------------------------------------------------------------------------
// The bounded text helpers
// ---------------------------------------------------------------------------

function boundedText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new InvalidRequestError(`${label} must be a string of ${min}..${max} characters`);
  }
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new InvalidRequestError(`${label} must be a canonical lowercase UUID`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The reference creation guard
// ---------------------------------------------------------------------------

export interface AttributionReferenceCreationInput {
  readonly missionId: string;
  readonly pursuitWorkspaceId: string;
  readonly mechanism: SocialAttributionMechanism;
  readonly purpose: string;
  readonly creationContext: Readonly<Record<string, unknown>>;
}

export function assertValidReferenceCreation(
  input: AttributionReferenceCreationInput,
): void {
  requireUuid(input.missionId, 'missionId');
  requireUuid(input.pursuitWorkspaceId, 'pursuitWorkspaceId');
  if (!isKnownSocialAttributionMechanism(input.mechanism)) {
    throw new InvalidRequestError(
      `mechanism '${String(input.mechanism)}' is outside the closed §16 mechanism vocabulary`,
    );
  }
  boundedText(input.purpose, 'purpose', 1, 4000);
  assertValidCreationContext(input.creationContext);
}

// ---------------------------------------------------------------------------
// The link-construction input guard (the mechanism-required fields)
// ---------------------------------------------------------------------------

const BASE_URL_PATTERN = /^https?:\/\/[A-Za-z0-9._~:/#[\]@!$&'()*+,;=%-]{1,500}$/;
const UTM_TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const PROVIDER_LINK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CREATOR_CONTENT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/**
 * The construction-input guard: the mechanism must be CONSTRUCTIBLE
 * ('unavailable' builds nothing) and the mechanism-required fields must
 * be present and bounded (the pure formula fails closed on a missing
 * input; this guard produces the honest bounded error first).
 */
export function assertValidLinkConstruction(
  attributionRef: string,
  input: {
    readonly mechanism: unknown;
    readonly baseUrl?: unknown;
    readonly utmSource?: unknown;
    readonly utmMedium?: unknown;
    readonly providerLinkId?: unknown;
    readonly creatorRef?: unknown;
    readonly contentRef?: unknown;
    readonly eventName?: unknown;
  },
): asserts input is {
  readonly mechanism: SocialAttributionConstructibleMechanism;
  readonly baseUrl?: string | null;
  readonly utmSource?: string | null;
  readonly utmMedium?: string | null;
  readonly providerLinkId?: string | null;
  readonly creatorRef?: string | null;
  readonly contentRef?: string | null;
  readonly eventName?: string | null;
} {
  if (!SOCIAL_ATTRIBUTION_REF_PATTERN.test(attributionRef)) {
    throw new InvalidRequestError('the reference attribution id must match ^sca-[0-9a-f]{16}$');
  }
  if (!isConstructibleSocialAttributionMechanism(String(input.mechanism))) {
    throw new InvalidRequestError(
      `the mechanism '${String(input.mechanism)}' is not constructible — the honest 'unavailable' state builds nothing (never a fabricated link)`,
    );
  }
  const mechanism = input.mechanism as SocialAttributionConstructibleMechanism;
  switch (mechanism) {
    case 'utm_parameters': {
      if (typeof input.baseUrl !== 'string' || !BASE_URL_PATTERN.test(input.baseUrl)) {
        throw new InvalidRequestError(
          'utm_parameters requires a bare http(s) baseUrl of 1..500 characters without a query string',
        );
      }
      if (input.baseUrl.includes('?')) {
        throw new InvalidRequestError('the utm_parameters baseUrl must carry no query string');
      }
      if (input.utmSource !== undefined && input.utmSource !== null && (typeof input.utmSource !== 'string' || !UTM_TOKEN_PATTERN.test(input.utmSource))) {
        throw new InvalidRequestError('utmSource must match ^[A-Za-z0-9._-]{1,64}$');
      }
      if (input.utmMedium !== undefined && input.utmMedium !== null && (typeof input.utmMedium !== 'string' || !UTM_TOKEN_PATTERN.test(input.utmMedium))) {
        throw new InvalidRequestError('utmMedium must match ^[A-Za-z0-9._-]{1,64}$');
      }
      break;
    }
    case 'platform_native_link': {
      if (typeof input.providerLinkId !== 'string' || !PROVIDER_LINK_ID_PATTERN.test(input.providerLinkId)) {
        throw new InvalidRequestError(
          'platform_native_link requires the provider-assigned native link id (the recorded data — ^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$)',
        );
      }
      break;
    }
    case 'creator_content_identifier': {
      if (typeof input.creatorRef !== 'string' || !CREATOR_CONTENT_REF_PATTERN.test(input.creatorRef)) {
        throw new InvalidRequestError('creator_content_identifier requires a bounded creatorRef');
      }
      if (typeof input.contentRef !== 'string' || !CREATOR_CONTENT_REF_PATTERN.test(input.contentRef)) {
        throw new InvalidRequestError('creator_content_identifier requires a bounded contentRef');
      }
      break;
    }
    case 'first_party_conversion_event': {
      if (input.eventName !== undefined && input.eventName !== null && (typeof input.eventName !== 'string' || !EVENT_NAME_PATTERN.test(input.eventName))) {
        throw new InvalidRequestError('eventName must match ^[a-z][a-z0-9_]{0,99}$');
      }
      break;
    }
    case 'unique_landing_route':
    case 'campaign_identifier':
      break;
  }
}

// ---------------------------------------------------------------------------
// The attachment guard (the survival-chain fence)
// ---------------------------------------------------------------------------

const CARRIER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;

export function assertValidAttachment(
  input: {
    readonly carrierKind: unknown;
    readonly carrierRef: unknown;
    readonly originalContentRef: unknown;
    readonly carriedContentRefs: unknown;
    readonly reason: unknown;
  },
): asserts input is {
  readonly carrierKind: SocialAttributionCarrierKind;
  readonly carrierRef: string;
  readonly originalContentRef: string;
  readonly carriedContentRefs: readonly string[];
  readonly reason: string;
} {
  if (!(SOCIAL_ATTRIBUTION_CARRIER_KINDS as readonly string[]).includes(String(input.carrierKind))) {
    throw new InvalidRequestError(
      `carrierKind '${String(input.carrierKind)}' is outside the closed carrier vocabulary`,
    );
  }
  if (typeof input.carrierRef !== 'string' || !CARRIER_REF_PATTERN.test(input.carrierRef)) {
    throw new InvalidRequestError('carrierRef must be a bounded citation of 1..300 characters');
  }
  if (typeof input.originalContentRef !== 'string' || !CARRIER_REF_PATTERN.test(input.originalContentRef)) {
    throw new InvalidRequestError('originalContentRef must be a bounded content identity of 1..300 characters');
  }
  if (!Array.isArray(input.carriedContentRefs) || input.carriedContentRefs.length < 1 || input.carriedContentRefs.length > 50) {
    throw new InvalidRequestError('carriedContentRefs must be an array of 1..50 content identities');
  }
  const original = input.originalContentRef as string;
  let carriedOriginal = false;
  for (const entry of input.carriedContentRefs) {
    if (typeof entry !== 'string' || !CARRIER_REF_PATTERN.test(entry)) {
      throw new InvalidRequestError('every carried content identity must be a bounded string of 1..300 characters');
    }
    if (entry === original) carriedOriginal = true;
  }
  if (!carriedOriginal) {
    throw new InvalidRequestError(
      'the survival chain must CARRY the ORIGINAL content identity — an attachment that dropped it is inexpressible',
    );
  }
  boundedText(input.reason, 'reason', 1, 4000);
}

// ---------------------------------------------------------------------------
// The crossing guards
// ---------------------------------------------------------------------------

const PROVIDER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PAYLOAD_FIELD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,199}$/;

export function assertValidCrossingRecording(
  input: {
    readonly providerKey: unknown;
    readonly payloadField: unknown;
    readonly dispatchedValue: unknown;
  },
): asserts input is {
  readonly providerKey: string;
  readonly payloadField: string;
  readonly dispatchedValue: string;
} {
  if (typeof input.providerKey !== 'string' || !PROVIDER_KEY_PATTERN.test(input.providerKey)) {
    throw new InvalidRequestError('providerKey must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$');
  }
  if (typeof input.payloadField !== 'string' || !PAYLOAD_FIELD_PATTERN.test(input.payloadField)) {
    throw new InvalidRequestError('payloadField must be a bounded field path of 1..200 characters');
  }
  boundedText(input.dispatchedValue, 'dispatchedValue', 1, 1000);
}

export function assertValidCrossingAdvance(
  input: {
    readonly toState: unknown;
    readonly echoValue: unknown;
    readonly reason: unknown;
  },
): asserts input is {
  readonly toState: 'echoed' | 'dropped';
  readonly echoValue: string | null;
  readonly reason: string;
} {
  if (input.toState !== 'echoed' && input.toState !== 'dropped') {
    throw new InvalidRequestError("the crossing advance target must be 'echoed' or 'dropped'");
  }
  boundedText(input.reason, 'reason', 1, 4000);
  if (input.toState === 'echoed') {
    boundedText(input.echoValue, 'echoValue', 1, 1000);
  } else if (input.echoValue !== undefined && input.echoValue !== null) {
    throw new InvalidRequestError(
      "a 'dropped' crossing carries the honest null echo — a dropped reference is never fabricated into an echo",
    );
  }
}

// ---------------------------------------------------------------------------
// The conversion-event guards
// ---------------------------------------------------------------------------

export function assertValidFirstPartyConversion(
  input: {
    readonly pursuitWorkspaceId: unknown;
    readonly conversionKind: unknown;
    readonly subjectRef?: unknown;
    readonly occurredAt?: unknown;
    readonly observedFields: unknown;
  },
): asserts input is {
  readonly pursuitWorkspaceId: string;
  readonly conversionKind: 'store_visit' | 'product_interaction';
  readonly subjectRef?: string | null;
  readonly occurredAt?: string | null;
  readonly observedFields: Readonly<Record<string, unknown>>;
} {
  requireUuid(input.pursuitWorkspaceId, 'pursuitWorkspaceId');
  if (input.conversionKind !== 'store_visit' && input.conversionKind !== 'product_interaction') {
    throw new InvalidRequestError(
      "a first-party conversion event is a 'store_visit' or a 'product_interaction' — the order kind comes from the real commerce boundary only (the order-truth fence)",
    );
  }
  if (input.subjectRef !== undefined && input.subjectRef !== null) {
    boundedText(input.subjectRef, 'subjectRef', 1, 300);
  }
  if (input.occurredAt !== undefined && input.occurredAt !== null) {
    boundedText(input.occurredAt, 'occurredAt', 1, 64);
  }
  if (typeof input.observedFields !== 'object' || input.observedFields === null || Array.isArray(input.observedFields)) {
    throw new InvalidRequestError('observedFields must be a JSON object of scalar observed fields');
  }
  assertValidObservedFields(input.observedFields as Record<string, unknown>, 'observedFields');
}

// ---------------------------------------------------------------------------
// The vocabulary re-assertions (the shared command fences)
// ---------------------------------------------------------------------------

export function assertKnownMechanism(mechanism: string): asserts mechanism is SocialAttributionMechanism {
  if (!isKnownSocialAttributionMechanism(mechanism)) {
    throw new InvalidRequestError(`mechanism '${mechanism}' is outside the closed §16 mechanism vocabulary`);
  }
}

export function assertKnownConversionKind(kind: string): asserts kind is SocialAttributionConversionKind {
  if (!(SOCIAL_ATTRIBUTION_CONVERSION_KINDS as readonly string[]).includes(kind)) {
    throw new InvalidRequestError(`conversion kind '${kind}' is outside the closed conversion vocabulary`);
  }
}

export function assertKnownMatchField(field: string): asserts field is SocialAttributionMatchField {
  if (!(SOCIAL_ATTRIBUTION_MATCH_FIELDS as readonly string[]).includes(field)) {
    throw new InvalidRequestError(`match field '${field}' is outside the closed match-field vocabulary`);
  }
}

export { boundedText as assertBoundedText, requireUuid as assertUuid };

// The unused-import backstop (SOCIAL_ATTRIBUTION_MECHANISMS is the
// vocabulary constant re-asserted through isKnownSocialAttributionMechanism;
// the import keeps the frozen vocabulary pinned at this layer).
void SOCIAL_ATTRIBUTION_MECHANISMS;
