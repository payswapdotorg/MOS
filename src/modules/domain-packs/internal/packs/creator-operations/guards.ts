/**
 * Creator Operations Domain Pack — the input guards (MKT-037, CREATOR-001).
 *
 * Pure validation of every pack service input, mirroring the frozen
 * migration-031 column contracts (bounded strings, closed vocabulary
 * CHECKs, the §21 material-key backstop on every JSON payload at every
 * nesting level). Exported for unit tests and for the route layer so the
 * guard semantics are part of the pack contract (the /evidence and
 * /domain-packs guard precedent). Every guard throws InvalidRequestError
 * with the full deterministic problem list BEFORE any state is touched.
 */

import { InvalidRequestError } from '../../../../../platform/errors/errors.ts';
import {
  CREATOR_ACCOUNT_STATUSES,
  CREATOR_APPROVAL_DECISIONS,
  CREATOR_CONTENT_KINDS,
  CREATOR_CONTENT_STATUSES,
  CREATOR_CONVERSATION_CHANNELS,
  CREATOR_CONVERSATION_STATUSES,
  CREATOR_FAN_STATUSES,
  CREATOR_FAN_TIERS,
  CREATOR_GATE_OPERATIONS,
  CREATOR_HUMAN_SPECIALIZATION_MIRROR,
  CREATOR_METRIC_NAMES,
  CREATOR_OBSERVATION_SUBJECT_KINDS,
  CREATOR_OFFER_KINDS,
  CREATOR_OFFER_STATUSES,
  type CreatorProvenance,
} from './contract.ts';

/** Material-shaped keys that can never appear in any pack payload (§21). */
export const CREATOR_MATERIAL_SHAPED_KEYS = [
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PLATFORM_LABEL_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ACCOUNT_HANDLE_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9_.@-]{0,127}$/;
const FAN_ALIAS_PATTERN = /^[^\s].{0,127}$/;
const EVENT_KIND_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const IDEMPOTENCY_KEY_PATTERN = /^.{1,200}$/;

const MAX_LIST_FIELDS = 32;
const MAX_PAYLOAD_JSON_BYTES = 32 * 1024;
const MIN_OBSERVED_AT_MS = 0;

/** Returns true when every nesting level of the payload is material-key free (§21). */
export function creatorPayloadHasNoMaterialKeys(payload: unknown): boolean {
  if (payload === null || payload === undefined) return true;
  if (Array.isArray(payload)) {
    return payload.every((entry) => creatorPayloadHasNoMaterialKeys(entry));
  }
  if (typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if ((CREATOR_MATERIAL_SHAPED_KEYS as readonly string[]).includes(key)) {
        return false;
      }
      if (!creatorPayloadHasNoMaterialKeys(value)) {
        return false;
      }
    }
  }
  return true;
}

function requireString(
  problems: string[],
  label: string,
  value: unknown,
  minLength: number,
  maxLength: number,
): void {
  if (typeof value !== 'string') {
    problems.push(`${label}: must be a string`);
    return;
  }
  if (value.length < minLength || value.length > maxLength) {
    problems.push(`${label}: must be ${minLength}..${maxLength} characters`);
  }
}

function requireUuid(problems: string[], label: string, value: unknown): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    problems.push(`${label}: must be a canonical lowercase UUID`);
  }
}

function requireIdempotencyKey(problems: string[], value: unknown): void {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value) || value.length === 0) {
    problems.push('idempotencyKey: must be 1..200 characters');
  }
}

function requireBoundedStringList(
  problems: string[],
  label: string,
  value: unknown,
  maxLength: number,
): void {
  if (!Array.isArray(value)) {
    problems.push(`${label}: must be an array of strings`);
    return;
  }
  if (value.length > MAX_LIST_FIELDS) {
    problems.push(`${label}: at most ${MAX_LIST_FIELDS} entries are allowed`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maxLength) {
      problems.push(`${label}: every entry must be a non-empty string of at most ${maxLength} characters`);
      return;
    }
    if (seen.has(entry)) {
      problems.push(`${label}: duplicate entry '${entry}'`);
      return;
    }
    seen.add(entry);
  }
}

function requirePayloadObject(
  problems: string[],
  label: string,
  value: unknown,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${label}: must be a JSON object`);
    return;
  }
  if (!creatorPayloadHasNoMaterialKeys(value)) {
    problems.push(`${label}: material-shaped keys are rejected at every nesting level (§21)`);
    return;
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > MAX_PAYLOAD_JSON_BYTES) {
    problems.push(`${label}: must serialize to at most ${MAX_PAYLOAD_JSON_BYTES} bytes`);
  }
}

function requireIsoTimestamp(problems: string[], label: string, value: unknown): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    problems.push(`${label}: must be an ISO-8601 timestamp`);
    return;
  }
  if (Date.parse(value) < MIN_OBSERVED_AT_MS) {
    problems.push(`${label}: must be a non-negative timestamp`);
  }
}

function requireEnum<T extends string>(
  problems: string[],
  label: string,
  value: unknown,
  vocabulary: readonly T[],
): void {
  if (typeof value !== 'string' || !(vocabulary as readonly string[]).includes(value)) {
    problems.push(`${label}: '${String(value)}' is not one of the frozen vocabulary (${vocabulary.join(', ')})`);
  }
}

// ---------------------------------------------------------------------------
// Provenance (server-derived shape validation)
// ---------------------------------------------------------------------------

/**
 * Validates the SERVER-DERIVED provenance shape (built by server code;
 * guards the composition site, never a request DTO).
 */
export function assertValidCreatorProvenance(provenance: CreatorProvenance): void {
  const problems: string[] = [];
  requireString(problems, 'provenance.actor', provenance.actor, 1, 128);
  requireString(problems, 'provenance.recordedVia', provenance.recordedVia, 1, 128);
  requireString(problems, 'provenance.correlationId', provenance.correlationId, 1, 128);
  if (provenance.causationId !== null) {
    requireString(problems, 'provenance.causationId', provenance.causationId, 1, 128);
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('creator provenance rejected by the guard', problems);
  }
}

// ---------------------------------------------------------------------------
// Subject record inputs
// ---------------------------------------------------------------------------

export function assertValidCreatorProfileInput(input: {
  clientId: unknown;
  displayName: unknown;
  handle: unknown;
  niches: unknown;
  bio: unknown;
  attributes: unknown;
  idempotencyKey: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'clientId', input.clientId);
  requireString(problems, 'displayName', input.displayName, 1, 200);
  if (typeof input.handle !== 'string' || !HANDLE_PATTERN.test(input.handle)) {
    problems.push('handle: must match ^[a-z0-9][a-z0-9_.-]{0,63}$');
  }
  requireBoundedStringList(problems, 'niches', input.niches, 64);
  requireString(problems, 'bio', input.bio, 0, 2000);
  requirePayloadObject(problems, 'attributes', input.attributes);
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (problems.length > 0) {
    throw new InvalidRequestError('creator profile record rejected by the guard', problems);
  }
}

export function assertValidCreatorAccountInput(input: {
  profileId: unknown;
  platformLabel: unknown;
  accountHandle: unknown;
  metadata: unknown;
  idempotencyKey: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'profileId', input.profileId);
  if (typeof input.platformLabel !== 'string' || !PLATFORM_LABEL_PATTERN.test(input.platformLabel)) {
    problems.push('platformLabel: must match ^[a-z0-9][a-z0-9_.-]{0,63}$');
  }
  if (typeof input.accountHandle !== 'string' || !ACCOUNT_HANDLE_PATTERN.test(input.accountHandle)) {
    problems.push('accountHandle: must match ^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$');
  }
  requirePayloadObject(problems, 'metadata', input.metadata);
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (problems.length > 0) {
    throw new InvalidRequestError('creator account record rejected by the guard', problems);
  }
}

export function assertValidCreatorFanInput(input: {
  accountId: unknown;
  fanAlias: unknown;
  tier: unknown;
  tags: unknown;
  attributes: unknown;
  idempotencyKey: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'accountId', input.accountId);
  if (typeof input.fanAlias !== 'string' || !FAN_ALIAS_PATTERN.test(input.fanAlias)) {
    problems.push('fanAlias: must be 1..128 characters and start with a non-space');
  }
  requireEnum(problems, 'tier', input.tier, CREATOR_FAN_TIERS);
  requireBoundedStringList(problems, 'tags', input.tags, 64);
  requirePayloadObject(problems, 'attributes', input.attributes);
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (problems.length > 0) {
    throw new InvalidRequestError('creator fan record rejected by the guard', problems);
  }
}

export function assertValidCreatorConversationInput(input: {
  accountId: unknown;
  fanId: unknown;
  channel: unknown;
  topic: unknown;
  attributes: unknown;
  idempotencyKey: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'accountId', input.accountId);
  requireUuid(problems, 'fanId', input.fanId);
  requireEnum(problems, 'channel', input.channel, CREATOR_CONVERSATION_CHANNELS);
  requireString(problems, 'topic', input.topic, 0, 200);
  requirePayloadObject(problems, 'attributes', input.attributes);
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (problems.length > 0) {
    throw new InvalidRequestError('creator conversation record rejected by the guard', problems);
  }
}

export function assertValidCreatorMessageInput(input: {
  conversationId: unknown;
  body: unknown;
  idempotencyKey: unknown;
  approvalId: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'conversationId', input.conversationId);
  requireString(problems, 'body', input.body, 1, 4000);
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (input.approvalId !== null) {
    requireUuid(problems, 'approvalId', input.approvalId);
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('creator message rejected by the guard', problems);
  }
}

export function assertValidCreatorContentAssetInput(input: {
  profileId: unknown;
  title: unknown;
  contentKind: unknown;
  plannedPlatforms: unknown;
  brief: unknown;
  attributes: unknown;
  idempotencyKey: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'profileId', input.profileId);
  requireString(problems, 'title', input.title, 1, 200);
  requireEnum(problems, 'contentKind', input.contentKind, CREATOR_CONTENT_KINDS);
  requireBoundedStringList(problems, 'plannedPlatforms', input.plannedPlatforms, 64);
  requireString(problems, 'brief', input.brief, 0, 4000);
  requirePayloadObject(problems, 'attributes', input.attributes);
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (problems.length > 0) {
    throw new InvalidRequestError('creator content asset record rejected by the guard', problems);
  }
}

export function assertValidCreatorOfferInput(input: {
  profileId: unknown;
  title: unknown;
  offerKind: unknown;
  priceCents: unknown;
  currency: unknown;
  terms: unknown;
  attributes: unknown;
  idempotencyKey: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'profileId', input.profileId);
  requireString(problems, 'title', input.title, 1, 200);
  requireEnum(problems, 'offerKind', input.offerKind, CREATOR_OFFER_KINDS);
  if (
    typeof input.priceCents !== 'number' ||
    !Number.isSafeInteger(input.priceCents) ||
    input.priceCents < 0 ||
    input.priceCents > Number.MAX_SAFE_INTEGER
  ) {
    problems.push('priceCents: must be a non-negative safe integer (cents)');
  }
  if (typeof input.currency !== 'string' || !CURRENCY_PATTERN.test(input.currency)) {
    problems.push('currency: must be an ISO-4217-style 3-letter code');
  }
  requireString(problems, 'terms', input.terms, 0, 2000);
  requirePayloadObject(problems, 'attributes', input.attributes);
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (problems.length > 0) {
    throw new InvalidRequestError('creator offer record rejected by the guard', problems);
  }
}

export function assertValidCreatorApprovalInput(input: {
  clientId: unknown;
  action: unknown;
  resourceId: unknown;
  decision: unknown;
  approverUserId: unknown;
  approverSpecializations: unknown;
  notes: unknown;
  idempotencyKey: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'clientId', input.clientId);
  requireEnum(problems, 'action', input.action, CREATOR_GATE_OPERATIONS);
  requireUuid(problems, 'resourceId', input.resourceId);
  requireEnum(problems, 'decision', input.decision, CREATOR_APPROVAL_DECISIONS);
  requireUuid(problems, 'approverUserId', input.approverUserId);
  if (!Array.isArray(input.approverSpecializations)) {
    problems.push('approverSpecializations: must be an array of Human Agent specializations');
  } else {
    if (input.approverSpecializations.length > MAX_LIST_FIELDS) {
      problems.push(`approverSpecializations: at most ${MAX_LIST_FIELDS} entries are allowed`);
    }
    for (const entry of input.approverSpecializations) {
      if (
        typeof entry !== 'string' ||
        !(CREATOR_HUMAN_SPECIALIZATION_MIRROR as readonly string[]).includes(entry)
      ) {
        problems.push(`approverSpecializations: '${String(entry)}' is not a frozen Human Agent specialization`);
        break;
      }
    }
  }
  requireString(problems, 'notes', input.notes, 0, 2000);
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (problems.length > 0) {
    throw new InvalidRequestError('creator operation approval rejected by the guard', problems);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle transition inputs
// ---------------------------------------------------------------------------

export function assertValidCreatorStatusInput(
  label: string,
  input: { id: unknown; status: unknown; expectedVersion: unknown },
  statuses: readonly string[],
): void {
  const problems: string[] = [];
  requireUuid(problems, `${label}.id`, input.id);
  requireEnum(problems, `${label}.status`, input.status, statuses as readonly string[]);
  if (
    typeof input.expectedVersion !== 'number' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    problems.push(`${label}.expectedVersion: must be a positive integer (CAS token)`);
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(`creator ${label} transition rejected by the guard`, problems);
  }
}

export function assertValidCreatorAccountStatusInput(input: {
  accountId: unknown;
  status: unknown;
  expectedVersion: unknown;
}): void {
  assertValidCreatorStatusInput(
    'account',
    { id: input.accountId, status: input.status, expectedVersion: input.expectedVersion },
    CREATOR_ACCOUNT_STATUSES,
  );
}

export function assertValidCreatorFanStatusInput(input: {
  fanId: unknown;
  status: unknown;
  expectedVersion: unknown;
}): void {
  assertValidCreatorStatusInput(
    'fan',
    { id: input.fanId, status: input.status, expectedVersion: input.expectedVersion },
    CREATOR_FAN_STATUSES,
  );
}

export function assertValidCreatorConversationStatusInput(input: {
  conversationId: unknown;
  status: unknown;
  expectedVersion: unknown;
}): void {
  assertValidCreatorStatusInput(
    'conversation',
    { id: input.conversationId, status: input.status, expectedVersion: input.expectedVersion },
    CREATOR_CONVERSATION_STATUSES,
  );
}

export function assertValidCreatorOfferStatusInput(input: {
  offerId: unknown;
  status: unknown;
  expectedVersion: unknown;
}): void {
  assertValidCreatorStatusInput(
    'offer',
    { id: input.offerId, status: input.status, expectedVersion: input.expectedVersion },
    CREATOR_OFFER_STATUSES,
  );
}

/**
 * The content transition guard: vocabulary + CAS token + the CREATOR-AC-06
 * provenance contract (provenance REQUIRED iff the target status is
 * 'published' — the gated side effect; approvalId allowed only for the
 * published edge).
 */
export function assertValidCreatorContentTransitionInput(input: {
  assetId: unknown;
  status: unknown;
  expectedVersion: unknown;
  approvalId: unknown;
  provenance: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'assetId', input.assetId);
  requireEnum(problems, 'status', input.status, CREATOR_CONTENT_STATUSES);
  if (
    typeof input.expectedVersion !== 'number' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    problems.push('expectedVersion: must be a positive integer (CAS token)');
  }
  if (input.status === 'published') {
    if (input.provenance === null || input.provenance === undefined) {
      problems.push(
        "provenance: REQUIRED for the 'published' edge (the approval-gated side effect composes the policy decision provenance)",
      );
    }
    if (input.approvalId !== null && input.approvalId !== undefined) {
      requireUuid(problems, 'approvalId', input.approvalId);
    }
  } else {
    if (input.provenance !== null && input.provenance !== undefined) {
      problems.push("provenance: only the 'published' edge composes provenance (the gated side effect)");
    }
    if (input.approvalId !== null && input.approvalId !== undefined) {
      problems.push("approvalId: only the 'published' edge presents an approval record");
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('creator content asset transition rejected by the guard', problems);
  }
}

// ---------------------------------------------------------------------------
// The observation mapping input (CREATOR-AC-02)
// ---------------------------------------------------------------------------

export function assertValidCreatorObservationInput(input: {
  clientId: unknown;
  workspaceId: unknown;
  subjectKind: unknown;
  subjectRef: unknown;
  eventKind: unknown;
  content: unknown;
  observedAt: unknown;
  quality: unknown;
  metric: unknown;
  idempotencyKey: unknown;
}): void {
  const problems: string[] = [];
  requireUuid(problems, 'clientId', input.clientId);
  if (input.workspaceId !== null) {
    requireUuid(problems, 'workspaceId', input.workspaceId);
  }
  requireEnum(problems, 'subjectKind', input.subjectKind, CREATOR_OBSERVATION_SUBJECT_KINDS);
  if (input.subjectRef !== null) {
    requireString(problems, 'subjectRef', input.subjectRef, 1, 128);
  }
  if (typeof input.eventKind !== 'string' || !EVENT_KIND_PATTERN.test(input.eventKind)) {
    problems.push('eventKind: must match ^[a-z][a-z0-9_]{1,63}$');
  }
  requirePayloadObject(problems, 'content', input.content);
  requireIsoTimestamp(problems, 'observedAt', input.observedAt);
  requireEnum(problems, 'quality', input.quality, ['A', 'B', 'C', 'D', 'E', 'F']);
  if (input.metric !== null) {
    const metric = input.metric as Record<string, unknown>;
    if (metric === null || typeof metric !== 'object' || Array.isArray(metric)) {
      problems.push('metric: must be a metric mapping object or null');
    } else {
      requireEnum(problems, 'metric.name', metric['name'], CREATOR_METRIC_NAMES);
      if (
        typeof metric['value'] !== 'number' ||
        !Number.isFinite(metric['value']) ||
        Math.abs(metric['value']) > Number.MAX_SAFE_INTEGER
      ) {
        problems.push('metric.value: must be a finite number');
      }
      requireString(problems, 'metric.unit', metric['unit'], 1, 32);
      const dimensions = metric['dimensions'];
      if (dimensions === null || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
        problems.push('metric.dimensions: must be an object of scalar dimension values');
      } else {
        const entries = Object.entries(dimensions as Record<string, unknown>);
        if (entries.length > 32) {
          problems.push('metric.dimensions: at most 32 dimensions are allowed');
        }
        for (const [key, value] of entries) {
          if (key.length === 0 || key.length > 64) {
            problems.push('metric.dimensions: keys must be 1..64 characters');
            break;
          }
          if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            problems.push(`metric.dimensions.${key}: dimension values must be string | number | boolean`);
            break;
          }
          if (typeof value === 'string' && value.length > 256) {
            problems.push(`metric.dimensions.${key}: string dimension values must be at most 256 characters`);
            break;
          }
        }
      }
      if (metric['aggregationMethod'] !== null && metric['aggregationMethod'] !== undefined) {
        requireString(problems, 'metric.aggregationMethod', metric['aggregationMethod'], 1, 64);
      }
    }
  }
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (problems.length > 0) {
    throw new InvalidRequestError('creator observation rejected by the guard', problems);
  }
}

// ---------------------------------------------------------------------------
// The TaskProfile provisioning input (CREATOR-AC-03)
// ---------------------------------------------------------------------------

export function assertValidCreatorTaskProfileProvisionInput(input: {
  scope: unknown;
  idempotencyKey: unknown;
}): void {
  const problems: string[] = [];
  const scope = input.scope as Record<string, unknown> | null;
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    problems.push('scope: must be the canonical workspace/client/agency scope');
  } else {
    requireUuid(problems, 'scope.workspaceId', scope['workspaceId']);
    requireUuid(problems, 'scope.clientId', scope['clientId']);
    requireUuid(problems, 'scope.agencyId', scope['agencyId']);
  }
  requireIdempotencyKey(problems, input.idempotencyKey);
  if (problems.length > 0) {
    throw new InvalidRequestError('creator task profile provisioning rejected by the guard', problems);
  }
}
