/**
 * /cross-platform-distribution input guards + the pure derivation helpers
 * (MKT-065 — the content-rights/content-assets validation precedent: pure
 * functions, exported through the module public entry so the guard
 * semantics are part of the module contract and unit-testable without a
 * database).
 *
 * Everything in here is PURE: no DB, no clock, no ids — the module core
 * composes these guards around its persistence steps.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  derivePublishIdempotencyKey,
  DISTRIBUTION_ASSET_REF_PATTERN,
  DISTRIBUTION_IDEMPOTENCY_KEY_PATTERN,
  DISTRIBUTION_TARGET_FORMAT_PATTERN,
  type CrossPlatformDistributionProvenance,
  type DistributionDestinationStatus,
  type DistributionTransformationPlan,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounded shape constants (mirrored by the migration-055 CHECK fences)
// ---------------------------------------------------------------------------

/** The fan-out bound: one plan dispatches to at most 32 destinations. */
export const DISTRIBUTION_MAX_DESTINATIONS = 32;

export const MAX_TRANSFORMATION_DESCRIPTION_LENGTH = 2000;
export const MAX_VARIANT_LABEL_LENGTH = 64;
export const MAX_TRANSFORMATION_OUTPUTS = 16;
export const MAX_MEASUREMENT_REF_LENGTH = 256;
export const MAX_MEASUREMENT_NOTE_LENGTH = 1000;
export const MAX_PROVENANCE_ACTOR_LENGTH = 100;
export const MAX_PROVENANCE_VIA_LENGTH = 100;
export const MAX_CORRELATION_ID_LENGTH = 100;

/** The §21 material-key backstop (the adapter-contract precedent). */
const MATERIAL_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|private[-_]?key|client[-_]?secret|access[-_]?key|credential|auth[-_]?header|bearer)/i;
const MATERIAL_VALUE_HINT_PATTERN = /^(ey[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/]{40,}={0,2}|sk-[A-Za-z0-9]{16,})$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isBoundedObject(value: unknown, label: string, problems: string[], depth = 0): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${label}: must be an object`);
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) {
    problems.push(`${label}: at most 100 keys per object level`);
    return;
  }
  if (depth > 8) {
    problems.push(`${label}: nesting deeper than 8 levels is refused`);
    return;
  }
  for (const [key, entryValue] of entries) {
    if (MATERIAL_KEY_PATTERN.test(key)) {
      problems.push(`${label}.${key}: material-shaped keys are refused (§21)`);
      continue;
    }
    if (typeof entryValue === 'string' && MATERIAL_VALUE_HINT_PATTERN.test(entryValue)) {
      problems.push(`${label}.${key}: material-shaped values are refused (§21)`);
      continue;
    }
    if (entryValue !== null && typeof entryValue === 'object' && !Array.isArray(entryValue)) {
      isBoundedObject(entryValue, `${label}.${key}`, problems, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// The provenance guard
// ---------------------------------------------------------------------------

/** Validates the server-derived provenance shape (fail-closed by rejection). */
export function assertValidCrossPlatformDistributionProvenance(
  provenance: CrossPlatformDistributionProvenance,
): void {
  const problems: string[] = [];
  if (
    typeof provenance?.actor !== 'string' ||
    provenance.actor.length === 0 ||
    provenance.actor.length > MAX_PROVENANCE_ACTOR_LENGTH
  ) {
    problems.push('provenance.actor: a bounded actor label is required (server-derived)');
  }
  if (
    typeof provenance?.recordedVia !== 'string' ||
    provenance.recordedVia.length === 0 ||
    provenance.recordedVia.length > MAX_PROVENANCE_VIA_LENGTH
  ) {
    problems.push('provenance.recordedVia: a bounded recording-surface label is required (server-derived)');
  }
  if (
    typeof provenance?.correlationId !== 'string' ||
    provenance.correlationId.length === 0 ||
    provenance.correlationId.length > MAX_CORRELATION_ID_LENGTH
  ) {
    problems.push('provenance.correlationId: a bounded correlation id is required (server-derived)');
  }
  if (
    provenance?.causationId !== null &&
    provenance?.causationId !== undefined &&
    (typeof provenance.causationId !== 'string' ||
      provenance.causationId.length === 0 ||
      provenance.causationId.length > MAX_CORRELATION_ID_LENGTH)
  ) {
    problems.push('provenance.causationId: null or a bounded causation id');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('invalid distribution provenance', problems);
  }
}

// ---------------------------------------------------------------------------
// The planning-input guard
// ---------------------------------------------------------------------------

/**
 * Validates one createDistributionPlan input against the frozen
 * vocabularies and the bounded shapes (the migration-055 CHECKs mirrored
 * in pure form so a malformed input NEVER reaches the database — a
 * floating asset pointer, a material-shaped payload key or an over-bound
 * fan-out is rejected before any write). Throws InvalidRequestError with
 * every problem listed — fail-closed by rejection.
 */
export function assertValidCreateDistributionPlanInput(input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly missionId: string | null;
  readonly sourceAssetRef: string;
  readonly transformationPlan: DistributionTransformationPlan;
  readonly destinations: readonly {
    readonly socialAccountId: string;
    readonly targetFormat: string;
    readonly assetRef: string;
    readonly publishRequest: {
      readonly contentType: string;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly attribution: Readonly<Record<string, unknown>>;
      readonly scheduledFor: string | null;
    };
  }[];
}): void {
  const problems: string[] = [];

  if (typeof input.agencyId !== 'string' || !isUuid(input.agencyId)) {
    problems.push('agencyId: a valid agency id is required (server-derived tenant scope)');
  }
  if (typeof input.clientId !== 'string' || !isUuid(input.clientId)) {
    problems.push('clientId: a valid client id is required (server-derived tenant scope)');
  }
  if (input.workspaceId !== null && (typeof input.workspaceId !== 'string' || !isUuid(input.workspaceId))) {
    problems.push('workspaceId: null or a valid workspace id');
  }
  if (input.missionId !== null && (typeof input.missionId !== 'string' || !isUuid(input.missionId))) {
    problems.push('missionId: null or a valid /growth-missions record id (the read-only mission anchor)');
  }
  if (
    typeof input.sourceAssetRef !== 'string' ||
    !DISTRIBUTION_ASSET_REF_PATTERN.test(input.sourceAssetRef)
  ) {
    problems.push(
      "sourceAssetRef: the opaque 064 'ca:' content-asset reference is REQUIRED (explicit versioned records — never a floating pointer)",
    );
  }

  // The transformation plan (the declared mapping to versioned outputs).
  const plan = input.transformationPlan;
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    problems.push('transformationPlan: the declared transformation plan object is REQUIRED');
  } else {
    if (
      typeof plan.description !== 'string' ||
      plan.description.trim() === '' ||
      plan.description.length > MAX_TRANSFORMATION_DESCRIPTION_LENGTH
    ) {
      problems.push(
        `transformationPlan.description: a bounded description of 1..${MAX_TRANSFORMATION_DESCRIPTION_LENGTH} characters`,
      );
    }
    if (!Array.isArray(plan.outputs)) {
      problems.push('transformationPlan.outputs: an array of versioned output declarations');
    } else if (plan.outputs.length > MAX_TRANSFORMATION_OUTPUTS) {
      problems.push(`transformationPlan.outputs: at most ${MAX_TRANSFORMATION_OUTPUTS} outputs`);
    } else {
      for (const [index, output] of plan.outputs.entries()) {
        if (output === null || typeof output !== 'object') {
          problems.push(`transformationPlan.outputs[${index}]: must be an output declaration`);
          continue;
        }
        if (
          typeof output.assetRef !== 'string' ||
          !DISTRIBUTION_ASSET_REF_PATTERN.test(output.assetRef)
        ) {
          problems.push(
            `transformationPlan.outputs[${index}].assetRef: the opaque 064 'ca:' reference of the versioned derived output (never a floating pointer)`,
          );
        }
        if (
          typeof output.variantLabel !== 'string' ||
          output.variantLabel.trim() === '' ||
          output.variantLabel.length > MAX_VARIANT_LABEL_LENGTH
        ) {
          problems.push(
            `transformationPlan.outputs[${index}].variantLabel: a bounded variant label of 1..${MAX_VARIANT_LABEL_LENGTH} characters`,
          );
        }
      }
      const refs = plan.outputs.map((output) => output?.assetRef).filter((ref) => typeof ref === 'string');
      if (new Set(refs).size !== refs.length) {
        problems.push('transformationPlan.outputs: duplicate output asset refs are refused');
      }
    }
  }

  // The destination variants (the fan-out).
  if (!Array.isArray(input.destinations) || input.destinations.length === 0) {
    problems.push('destinations: at least one destination variant is required (the fan-out)');
  } else if (input.destinations.length > DISTRIBUTION_MAX_DESTINATIONS) {
    problems.push(`destinations: at most ${DISTRIBUTION_MAX_DESTINATIONS} destinations per plan`);
  } else {
    for (const [index, destination] of input.destinations.entries()) {
      const label = `destinations[${index}]`;
      if (destination === null || typeof destination !== 'object') {
        problems.push(`${label}: must be a destination declaration`);
        continue;
      }
      if (typeof destination.socialAccountId !== 'string' || !isUuid(destination.socialAccountId)) {
        problems.push(`${label}.socialAccountId: a valid /social-accounts binding id`);
      }
      if (
        typeof destination.targetFormat !== 'string' ||
        !DISTRIBUTION_TARGET_FORMAT_PATTERN.test(destination.targetFormat)
      ) {
        problems.push(
          `${label}.targetFormat: the destination-specific target format must match ^[a-z0-9][a-z0-9._-]{0,63}$`,
        );
      }
      if (
        typeof destination.assetRef !== 'string' ||
        !DISTRIBUTION_ASSET_REF_PATTERN.test(destination.assetRef)
      ) {
        problems.push(
          `${label}.assetRef: the versioned 064 'ca:' reference this destination publishes (the source or a declared output)`,
        );
      }
      const request = destination.publishRequest;
      if (request === null || typeof request !== 'object') {
        problems.push(`${label}.publishRequest: the destination-specific publish request object is REQUIRED`);
        continue;
      }
      if (
        typeof request.contentType !== 'string' ||
        !CONTENT_TYPE_PATTERN.test(request.contentType)
      ) {
        problems.push(
          `${label}.publishRequest.contentType: the 056 content-type label must match ^[a-z0-9][a-z0-9._-]{0,63}$`,
        );
      }
      isBoundedObject(request.payload, `${label}.publishRequest.payload`, problems);
      isBoundedObject(request.attribution, `${label}.publishRequest.attribution`, problems);
      if (request.scheduledFor !== null && request.scheduledFor !== undefined) {
        if (typeof request.scheduledFor !== 'string' || !ISO_TIMESTAMP_PATTERN.test(request.scheduledFor)) {
          problems.push(`${label}.publishRequest.scheduledFor: null or an ISO-8601 timestamp`);
        }
      }
    }
    // The (account, target format) planning-duplicate fence (the
    // migration-055 variant fence mirror).
    const pairs = new Set<string>();
    for (const destination of input.destinations) {
      if (
        typeof destination?.socialAccountId === 'string' &&
        typeof destination?.targetFormat === 'string'
      ) {
        const pair = `${destination.socialAccountId}:${destination.targetFormat}`;
        if (pairs.has(pair)) {
          problems.push(
            'destinations: one variant per (account, target format) — a planning duplicate is refused',
          );
          break;
        }
        pairs.add(pair);
      }
    }
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('invalid distribution plan', problems);
  }
}

// ---------------------------------------------------------------------------
// The dispatch + measurement guards
// ---------------------------------------------------------------------------

/** Validates one dispatchDistributionPlan input. */
export function assertValidDispatchInput(input: { readonly planId: string }): void {
  const problems: string[] = [];
  if (typeof input?.planId !== 'string' || !isUuid(input.planId)) {
    problems.push('planId: a valid distribution plan id');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('invalid distribution dispatch', problems);
  }
}

/** Validates one recordMeasurementReference input. */
export function assertValidMeasurementReferenceInput(input: {
  readonly planId: string;
  readonly destinationId: string | null;
  readonly measurementRef: string;
  readonly note: string | null;
}): void {
  const problems: string[] = [];
  if (typeof input?.planId !== 'string' || !isUuid(input.planId)) {
    problems.push('planId: a valid distribution plan id');
  }
  if (
    input?.destinationId !== null &&
    input?.destinationId !== undefined &&
    (typeof input.destinationId !== 'string' || !isUuid(input.destinationId))
  ) {
    problems.push('destinationId: null or a valid destination id');
  }
  if (
    typeof input?.measurementRef !== 'string' ||
    input.measurementRef.trim() === '' ||
    input.measurementRef.length > MAX_MEASUREMENT_REF_LENGTH
  ) {
    problems.push(
      `measurementRef: the opaque measurement reference (resolved by the mission/operator layer) is REQUIRED, bounded to 1..${MAX_MEASUREMENT_REF_LENGTH} characters`,
    );
  }
  if (input?.note !== null && input?.note !== undefined) {
    if (typeof input.note !== 'string' || input.note.length > MAX_MEASUREMENT_NOTE_LENGTH) {
      problems.push(`note: null or a bounded note of at most ${MAX_MEASUREMENT_NOTE_LENGTH} characters`);
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('invalid distribution measurement reference', problems);
  }
}

// ---------------------------------------------------------------------------
// The pure derivation helpers
// ---------------------------------------------------------------------------

/**
 * PURE: the destination outcome derived from the 056 attempt state (the
 * publish-state mirror — 'submitted' stays the honest UNKNOWN
 * 'publishing'; the terminal states map verbatim).
 */
export function destinationStatusOfPublishState(
  publishState: 'submitted' | 'accepted' | 'published' | 'failed' | 'restricted',
): DistributionDestinationStatus {
  if (publishState === 'submitted') return 'publishing';
  return publishState;
}

/**
 * PURE: the canonical deterministic digest of one plan declaration (the
 * same inputs produce the same digest — the planning reproducibility
 * anchor; keys sorted, no whitespace, the bounded declared shapes only).
 * Two independent FNV-1a lanes over the canonical JSON (the
 * experiment-analysis digest precedent — pure, deterministic,
 * fixed-width; the FULL declaration rides the row as jsonb, the digest is
 * the equality token).
 */
export function computeDistributionPlanInputDigest(input: {
  readonly sourceAssetRef: string;
  readonly transformationPlan: DistributionTransformationPlan;
  readonly destinations: readonly {
    readonly socialAccountId: string;
    readonly targetFormat: string;
    readonly assetRef: string;
    readonly publishRequest: {
      readonly contentType: string;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly attribution: Readonly<Record<string, unknown>>;
      readonly scheduledFor: string | null;
    };
  }[];
}): string {
  const canonical = {
    sourceAssetRef: input.sourceAssetRef,
    transformationPlan: {
      description: input.transformationPlan.description,
      outputs: input.transformationPlan.outputs.map((output) => ({
        assetRef: output.assetRef,
        variantLabel: output.variantLabel,
      })),
    },
    destinations: input.destinations.map((destination) => ({
      socialAccountId: destination.socialAccountId,
      targetFormat: destination.targetFormat,
      assetRef: destination.assetRef,
      publishRequest: {
        contentType: destination.publishRequest.contentType,
        payload: destination.publishRequest.payload,
        attribution: destination.publishRequest.attribution,
        scheduledFor: destination.publishRequest.scheduledFor,
      },
    })),
  };
  const json = JSON.stringify(canonical, canonicalJsonReplacer);
  return `${fnv1a(json, 0x811c9dc5)}${fnv1a(json, 0x01000193)}`;
}

/** One FNV-1a 32-bit lane over the text (pure, fixed-width hex). */
function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The canonical JSON replacer: sorted object keys, stable arrays. */
function canonicalJsonReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      out[key] = entryValue;
    }
    return out;
  }
  return value;
}

/**
 * PURE: asserts the derived idempotency key of a destination satisfies
 * the 056 grammar (the migration-050 mirror — the module never submits a
 * key the ledger would refuse).
 */
export function assertDerivedIdempotencyKeyWellFormed(planId: string, destinationId: string): void {
  const key = derivePublishIdempotencyKey(planId, destinationId);
  if (!DISTRIBUTION_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new InvalidRequestError('invalid derived publish idempotency key', [
      `the derived key '${key}' does not satisfy the 056 idempotency-key grammar`,
    ]);
  }
}
