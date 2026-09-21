/**
 * /content-rights input guards + the pure grammar/limit constants
 * (MKT-063 — the notification-delivery validation precedent: pure
 * functions, exported through the module public entry so the guard
 * semantics are part of the module contract and unit-testable without a
 * database).
 *
 * Everything in here is PURE: no DB, no clock, no ids — the module core
 * composes these guards around its persistence steps.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  isKnownContentRightsAssetKind,
  isKnownContentRightsEventKind,
  isKnownContentRightsPermission,
  isKnownContentRightsState,
  isLegalContentRightsTransition,
  type ContentRightsProvenance,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounded shape constants (mirrored by the migration-051 CHECK fences)
// ---------------------------------------------------------------------------

/**
 * The CONTENT-ASSET REFERENCE grammar — the MKT-064 id-based seam: an
 * opaque, path-safe reference (the occurrence-key grammar precedent;
 * no whitespace, no slashes, no scheme — safe in a URL path segment
 * and in a policy attribute).
 */
export const CONTENT_ASSET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The DESTINATION PLATFORM KEY grammar: an opaque adapter-plane key
 * (lowercase letters, digits, underscore, hyphen — the
 * /social-accounts adapter-key precedent; platform-specific rules live
 * behind the adapter plane, never here).
 */
export const PLATFORM_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** The lineage-traversal depth bound (fail-closed: deeper graphs BLOCK, they never loop). */
export const MAX_LINEAGE_DEPTH = 16;

export const MAX_CONTENT_ASSET_REF_LENGTH = 128;
export const MAX_LICENCE_LABEL_LENGTH = 500;
export const MAX_REASON_LENGTH = 2000;
export const MAX_RATIONALE_LENGTH = 4000;
export const MAX_PROVENANCE_ACTOR_LENGTH = 100;
export const MAX_PROVENANCE_VIA_LENGTH = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// The input guards (fail-closed by rejection — before any write)
// ---------------------------------------------------------------------------

/**
 * Validates one registerContentRights input against the frozen
 * vocabularies and the bounded shapes (the migration-051 CHECKs
 * mirrored in pure form so a malformed input NEVER reaches the
 * database). Throws InvalidRequestError with every problem listed —
 * fail-closed by rejection.
 */
export function assertValidRegisterContentRightsInput(input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly contentAssetRef: string;
  readonly assetKind: 'source' | 'composite';
  readonly sourceEvidenceRef: string;
  readonly licenceLabel: string | null;
  readonly licenceEvidenceRef: string | null;
  readonly validUntil: string | null;
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
  if (
    typeof input.contentAssetRef !== 'string' ||
    !CONTENT_ASSET_REF_PATTERN.test(input.contentAssetRef)
  ) {
    problems.push(
      `contentAssetRef: the opaque content-asset reference (the MKT-064 seam) must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_CONTENT_ASSET_REF_LENGTH - 1}}$`,
    );
  }
  if (!isKnownContentRightsAssetKind(String(input.assetKind))) {
    problems.push(
      `assetKind '${String(input.assetKind)}' is not part of the frozen asset-kind vocabulary (cr-vocab-v1: source | composite)`,
    );
  }
  if (typeof input.sourceEvidenceRef !== 'string' || !isUuid(input.sourceEvidenceRef)) {
    problems.push(
      'sourceEvidenceRef: the /evidence record anchoring where the asset/claim came from is REQUIRED (a valid evidence id)',
    );
  }
  if (input.licenceLabel !== null) {
    if (
      typeof input.licenceLabel !== 'string' ||
      input.licenceLabel.trim() === '' ||
      input.licenceLabel.length > MAX_LICENCE_LABEL_LENGTH
    ) {
      problems.push(`licenceLabel: null or a bounded licence descriptor of 1..${MAX_LICENCE_LABEL_LENGTH} characters`);
    }
  }
  if (input.licenceEvidenceRef !== null) {
    if (typeof input.licenceEvidenceRef !== 'string' || !isUuid(input.licenceEvidenceRef)) {
      problems.push('licenceEvidenceRef: null or a valid /evidence record id');
    }
  }
  if (input.validUntil !== null) {
    if (typeof input.validUntil !== 'string' || Number.isNaN(Date.parse(input.validUntil))) {
      problems.push('validUntil: null or an ISO-8601 timestamp (the licence validity horizon)');
    }
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('malformed content-rights registration input (fail-closed)', problems);
  }
}

/**
 * Validates one recordRightsTransition input: the kind must be frozen,
 * the declared target state must be frozen, the reason REQUIRED and
 * bounded, and the clearance payload REQUIRED EXACTLY when kind =
 * 'human_clearance' (the fail-closed human-action spine — there is no
 * clearance-free path into `cleared`).
 */
export function assertValidTransitionInput(input: {
  readonly rightsRecordId: string;
  readonly eventKind: string;
  readonly toState: string;
  readonly reason: string;
  readonly clearance: {
    readonly rationale: string;
    readonly evidenceRef: string | null;
  } | null;
}): void {
  const problems: string[] = [];

  if (typeof input.rightsRecordId !== 'string' || !isUuid(input.rightsRecordId)) {
    problems.push('rightsRecordId: a valid rights record id is required');
  }
  if (!isKnownContentRightsEventKind(String(input.eventKind))) {
    problems.push(
      `eventKind '${String(input.eventKind)}' is not part of the frozen transition-event vocabulary (cr-vocab-v1)`,
    );
  }
  if (!isKnownContentRightsState(String(input.toState))) {
    problems.push(
      `toState '${String(input.toState)}' is not part of the frozen rights-state vocabulary (cr-vocab-v1)`,
    );
  }
  if (
    typeof input.reason !== 'string' ||
    input.reason.trim() === '' ||
    input.reason.length > MAX_REASON_LENGTH
  ) {
    problems.push(`reason: the REQUIRED bounded transition reason of 1..${MAX_REASON_LENGTH} characters`);
  }

  if (String(input.eventKind) === 'human_clearance') {
    if (input.clearance === null) {
      problems.push(
        'clearance: REQUIRED for a human_clearance transition (review -> cleared happens ONLY through an explicit recorded human clearance — actor identity + rationale)',
      );
    } else {
      if (
        typeof input.clearance.rationale !== 'string' ||
        input.clearance.rationale.trim() === '' ||
        input.clearance.rationale.length > MAX_RATIONALE_LENGTH
      ) {
        problems.push(`clearance.rationale: the REQUIRED bounded clearance rationale of 1..${MAX_RATIONALE_LENGTH} characters`);
      }
      if (
        input.clearance.evidenceRef !== null &&
        (typeof input.clearance.evidenceRef !== 'string' || !isUuid(input.clearance.evidenceRef))
      ) {
        problems.push('clearance.evidenceRef: null or a valid /evidence record id (fair-use reasoning rides as review evidence)');
      }
    }
  } else if (input.clearance !== null) {
    problems.push(
      'clearance: ONLY a human_clearance transition carries a clearance payload (no other event kind may record one)',
    );
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('malformed content-rights transition input (fail-closed)', problems);
  }
}

/** Validates one recordPlatformPermission input. */
export function assertValidPermissionInput(input: {
  readonly rightsRecordId: string;
  readonly platformKey: string;
  readonly permission: string;
  readonly evidenceRef: string;
}): void {
  const problems: string[] = [];

  if (typeof input.rightsRecordId !== 'string' || !isUuid(input.rightsRecordId)) {
    problems.push('rightsRecordId: a valid rights record id is required');
  }
  if (typeof input.platformKey !== 'string' || !PLATFORM_KEY_PATTERN.test(input.platformKey)) {
    problems.push(
      'platformKey: the destination platform key must match ^[a-z][a-z0-9_-]{0,31}$ (the opaque adapter-plane key)',
    );
  }
  if (!isKnownContentRightsPermission(String(input.permission))) {
    problems.push(
      `permission '${String(input.permission)}' is not part of the frozen platform-permission vocabulary (cr-vocab-v1: permitted | not_permitted)`,
    );
  }
  if (typeof input.evidenceRef !== 'string' || !isUuid(input.evidenceRef)) {
    problems.push(
      'evidenceRef: the /evidence record backing THIS permission claim is REQUIRED (a valid evidence id)',
    );
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('malformed content-rights permission input (fail-closed)', problems);
  }
}

/** Validates one recordLineageLink input. */
export function assertValidLineageInput(input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly compositeAssetRef: string;
  readonly ingredientAssetRef: string;
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
  if (
    typeof input.compositeAssetRef !== 'string' ||
    !CONTENT_ASSET_REF_PATTERN.test(input.compositeAssetRef)
  ) {
    problems.push(
      `compositeAssetRef: the composite's opaque asset reference must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_CONTENT_ASSET_REF_LENGTH - 1}}$`,
    );
  }
  if (
    typeof input.ingredientAssetRef !== 'string' ||
    !CONTENT_ASSET_REF_PATTERN.test(input.ingredientAssetRef)
  ) {
    problems.push(
      `ingredientAssetRef: the ingredient's opaque asset reference must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_CONTENT_ASSET_REF_LENGTH - 1}}$`,
    );
  }
  if (
    typeof input.compositeAssetRef === 'string' &&
    typeof input.ingredientAssetRef === 'string' &&
    input.compositeAssetRef === input.ingredientAssetRef
  ) {
    problems.push('ingredientAssetRef: an asset cannot be its own ingredient (self-links are rejected)');
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('malformed content-rights lineage input (fail-closed)', problems);
  }
}

/** Validates one evaluatePublicationGate input. */
export function assertValidGateInput(input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly assetRef: string;
  readonly destinationPlatform: string;
}): void {
  const problems: string[] = [];

  if (typeof input.agencyId !== 'string' || !isUuid(input.agencyId)) {
    problems.push('agencyId: a valid agency id is required (server-derived tenant scope)');
  }
  if (typeof input.clientId !== 'string' || !isUuid(input.clientId)) {
    problems.push('clientId: a valid client id is required (server-derived tenant scope)');
  }
  if (typeof input.assetRef !== 'string' || !CONTENT_ASSET_REF_PATTERN.test(input.assetRef)) {
    problems.push(
      `assetRef: the opaque content-asset reference must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_CONTENT_ASSET_REF_LENGTH - 1}}$`,
    );
  }
  if (
    typeof input.destinationPlatform !== 'string' ||
    !PLATFORM_KEY_PATTERN.test(input.destinationPlatform)
  ) {
    problems.push(
      'destinationPlatform: the destination platform key must match ^[a-z][a-z0-9_-]{0,31}$ (the opaque adapter-plane key)',
    );
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('malformed publication-gate input (fail-closed)', problems);
  }
}

/**
 * Validates the SERVER-DERIVED provenance shape (never a request field —
 * the routes build it from the authenticated principal + the ambient
 * correlation context).
 */
export function assertValidContentRightsProvenance(
  provenance: ContentRightsProvenance,
): void {
  const problems: string[] = [];
  if (
    typeof provenance.actor !== 'string' ||
    provenance.actor.trim() === '' ||
    provenance.actor.length > MAX_PROVENANCE_ACTOR_LENGTH
  ) {
    problems.push(`actor: a server-derived actor label of 1..${MAX_PROVENANCE_ACTOR_LENGTH} characters`);
  }
  if (
    typeof provenance.recordedVia !== 'string' ||
    provenance.recordedVia.trim() === '' ||
    provenance.recordedVia.length > MAX_PROVENANCE_VIA_LENGTH
  ) {
    problems.push(`recordedVia: a server-derived surface label of 1..${MAX_PROVENANCE_VIA_LENGTH} characters`);
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.trim() === '') {
    problems.push('correlationId: required');
  }
  if (
    provenance.causationId !== null &&
    (typeof provenance.causationId !== 'string' || provenance.causationId.trim() === '')
  ) {
    problems.push('causationId: null or a non-empty correlation reference');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('malformed content-rights provenance (fail-closed)', problems);
  }
}

/**
 * The transition-legality guard composed with the input guard: given the
 * record's CURRENT state and the requested event (kind + declared
 * target), either the (from, to, kind) triple is a legal row of the
 * frozen table — or the guard names the problem (used by
 * recordRightsTransition BEFORE any write; the migration-051 CHECK is
 * the persisted mirror).
 */
export function transitionProblems(
  current: 'owned' | 'license' | 'platform_permitted' | 'cleared' | 'review' | 'blocked' | 'unknown',
  requested: {
    readonly eventKind: string;
    readonly toState: string;
  },
): readonly string[] {
  if (!isKnownContentRightsState(String(current))) {
    return ['the record state is not part of the frozen vocabulary'];
  }
  if (!isKnownContentRightsEventKind(String(requested.eventKind))) {
    return [`eventKind '${String(requested.eventKind)}' is not part of the frozen transition-event vocabulary`];
  }
  if (!isKnownContentRightsState(String(requested.toState))) {
    return [`toState '${String(requested.toState)}' is not part of the frozen rights-state vocabulary`];
  }
  if (
    !isLegalContentRightsTransition({
      from: current,
      to: requested.toState as 'owned' | 'license' | 'platform_permitted' | 'cleared' | 'review' | 'blocked' | 'unknown',
      kind: requested.eventKind as 'determination' | 'human_clearance' | 'contestation' | 'revocation' | 'review_denial' | 're_review_request',
    })
  ) {
    return [
      `the transition ${current} -> ${String(requested.toState)} (${String(requested.eventKind)}) is not a row of the frozen content-rights transition table — fail-closed by rejection (cleared is reachable ONLY from review via human_clearance)`,
    ];
  }
  return [];
}
