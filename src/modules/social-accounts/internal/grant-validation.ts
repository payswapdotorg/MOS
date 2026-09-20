/**
 * /social-accounts pure grant validation + provenance structuring
 * (MKT-055) — the unit-tested contract surface of the module.
 *
 * Everything here is PURE: no I/O, no clock, no database. The unit suite
 * pins the frozen vocabularies (the account/grant/scope/event state
 * tables), the input guards (flow-descriptor registration, requested
 * scopes, provenance with the §21 material-key backstop) and the
 * provenance-structuring composers (the server-derived event inserts).
 *
 * The module core consumes these guards before any persistence; the
 * migration-046 CHECK/trigger fences are the storage-layer mirror.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { IntegrationsConnectionOwnerContext } from '../../integrations/public.ts';
import type {
  SocialAccountEventType,
  SocialAccountFlowDescriptor,
  SocialAccountFlowIdentity,
  SocialAccountFlowImplementation,
  SocialAccountOwnerContext,
  SocialAccountProvenance,
  SocialAccountRecord,
  SocialGrantScopeKind,
} from '../public.ts';

/**
 * The structured append-only event insert (the store's append payload —
 * provenance-structured, server-derived): the exact shape the history
 * tail receives. Declared here so the pure composers and the store share
 * ONE definition.
 */
export interface SocialAccountEventInsert {
  readonly socialAccountId: string | null;
  readonly grantId: string | null;
  readonly eventType: SocialAccountEventType;
  readonly initiatedBy: 'operator' | 'external-signal';
  readonly reason: string | null;
  readonly providerRevokeOutcome:
    | 'not-requested'
    | 'revoked'
    | 'skipped-policy-denied'
    | 'failed'
    | null;
  readonly recordedActor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Shape patterns (mirrored by the migration-046 CHECKs)
// ---------------------------------------------------------------------------

/** The provider-neutral platform identity (the adapter key shape). */
const PLATFORM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The opaque external account identifier (bounded, non-empty). */
const EXTERNAL_ACCOUNT_ID_PATTERN = /^[\S].{0,254}$/;

/** The display identity (bounded, non-empty). */
const DISPLAY_IDENTITY_PATTERN = /^[\S].{0,254}$/;

/** The verbatim scope string (bounded, non-empty — NEVER normalized). */
const SCOPE_VALUE_PATTERN = /^[\S].{0,254}$/;

/** The platform-normalized capability tag (the normalized label shape). */
const CAPABILITY_TAG_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;

/** The opaque backend handle rules (the credentials-store mirror). */
const HANDLE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,97}[a-z0-9])?$/;

/** The flow-descriptor human labels. */
const FLOW_LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,99}$/;

/** The bounded reason strings. */
export const MAX_EVENT_REASON_LENGTH = 2000;

/** The requested-scope list bound. */
export const MAX_REQUESTED_SCOPES = 64;

/** The scope-record list bound (verbatim scopes + capability tags each). */
export const MAX_SCOPE_RECORDS_PER_KIND = 64;

/** The §21 material-shaped keys rejected at every level (the integrations pattern). */
const MATERIAL_SHAPED_KEYS = [
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

// ---------------------------------------------------------------------------
// The frozen vocabulary mirrors (unit-pinned; the migration-046 CHECKs
// are the storage mirror)
// ---------------------------------------------------------------------------

/** The closed account-status vocabulary (migration-046 CHECK mirror). */
export const SOCIAL_ACCOUNT_STATUS_VOCABULARY: readonly string[] = [
  'connected',
  'disconnected',
  'revoked',
];

/** The closed grant-state vocabulary (migration-046 CHECK mirror). */
export const SOCIAL_GRANT_STATE_VOCABULARY: readonly string[] = [
  'pending',
  'authorized',
  'expired',
  'revoked',
  'refreshed',
  'superseded',
];

/** The closed scope-kind vocabulary (migration-046 CHECK mirror). */
export const SOCIAL_GRANT_SCOPE_KIND_VOCABULARY: readonly string[] = [
  'granted-scope',
  'capability-tag',
];

/** The closed event-type vocabulary (migration-046 CHECK mirror). */
export const SOCIAL_ACCOUNT_EVENT_TYPE_VOCABULARY: readonly string[] = [
  'authorization_started',
  'authorization_completed',
  'authorization_expired',
  'authorization_revoked',
  'grant_refreshed',
  'grant_superseded',
  'account_disconnected',
  'account_revoked',
];

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------

/** Validates one flow registration (the MKT-023 adapter-registration guard). */
export function assertValidFlowRegistration(
  flow: SocialAccountFlowImplementation,
): void {
  const descriptor: SocialAccountFlowDescriptor = flow.descriptor;
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new InvalidRequestError('Invalid social flow registration', [
      'descriptor: must be an object',
    ]);
  }
  if (!PLATFORM_ID_PATTERN.test(descriptor.adapterKey)) {
    throw new InvalidRequestError('Invalid social flow registration', [
      'descriptor.adapterKey: must be 1-64 chars, lowercase letters/digits/dashes',
    ]);
  }
  if (typeof descriptor.flowLabel !== 'string' || !FLOW_LABEL_PATTERN.test(descriptor.flowLabel)) {
    throw new InvalidRequestError('Invalid social flow registration', [
      `descriptor.flowLabel: invalid label for adapter '${descriptor.adapterKey}'`,
    ]);
  }
  if (
    typeof descriptor.description !== 'string'
    || descriptor.description.length < 1
    || descriptor.description.length > 500
  ) {
    throw new InvalidRequestError('Invalid social flow registration', [
      `descriptor.description: must be 1-500 chars for adapter '${descriptor.adapterKey}'`,
    ]);
  }
  for (const member of [
    'buildAuthorizeUrl',
    'exchangeAuthorizationCode',
    'refreshAuthorization',
    'revokeAuthorization',
  ] as const) {
    if (typeof flow[member] !== 'function') {
      throw new InvalidRequestError('Invalid social flow registration', [
        `${member}: the flow for adapter '${descriptor.adapterKey}' must implement the member`,
      ]);
    }
  }
}

/**
 * Builds the validated flow registry (a Map keyed by adapterKey).
 * Construction of the module FAILS LOUDLY on duplicate keys or malformed
 * registrations (the MKT-023 buildAdapterRegistry precedent).
 */
export function buildFlowRegistry(
  flows: readonly SocialAccountFlowImplementation[],
): ReadonlyMap<string, SocialAccountFlowImplementation> {
  const registry = new Map<string, SocialAccountFlowImplementation>();
  for (const flow of flows) {
    assertValidFlowRegistration(flow);
    if (registry.has(flow.descriptor.adapterKey)) {
      throw new InvalidRequestError('Invalid social flow registration', [
        `adapterKey: '${flow.descriptor.adapterKey}' is registered more than once`,
      ]);
    }
    registry.set(flow.descriptor.adapterKey, flow);
  }
  return registry;
}

/** Validates the requested-scope list of an authorize-start round (INTENT data). */
export function assertValidRequestedScopes(
  scopes: readonly string[] | null,
): void {
  if (scopes === null) return;
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > MAX_REQUESTED_SCOPES) {
    throw new InvalidRequestError('Invalid requested scopes', [
      `requestedScopes: must be null or 1-${MAX_REQUESTED_SCOPES} verbatim scope strings`,
    ]);
  }
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !SCOPE_VALUE_PATTERN.test(scope)) {
      throw new InvalidRequestError('Invalid requested scopes', [
        'requestedScopes: each entry must be a non-empty bounded string (1-255 chars)',
      ]);
    }
  }
}

/** Validates the EXACT granted scope list of an exchange outcome (verbatim recording). */
export function assertValidGrantedScopeList(
  scopes: readonly string[],
): void {
  if (!Array.isArray(scopes) || scopes.length > MAX_SCOPE_RECORDS_PER_KIND) {
    throw new InvalidRequestError('Invalid granted scope list', [
      `grantedScopes: must be at most ${MAX_SCOPE_RECORDS_PER_KIND} verbatim entries`,
    ]);
  }
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !SCOPE_VALUE_PATTERN.test(scope)) {
      throw new InvalidRequestError('Invalid granted scope list', [
        'grantedScopes: each entry must be a non-empty bounded string (1-255 chars)',
      ]);
    }
  }
}

/** Validates the platform-normalized capability tags of an exchange outcome. */
export function assertValidCapabilityTagList(
  tags: readonly string[],
): void {
  if (!Array.isArray(tags) || tags.length > MAX_SCOPE_RECORDS_PER_KIND) {
    throw new InvalidRequestError('Invalid capability tag list', [
      `capabilityTags: must be at most ${MAX_SCOPE_RECORDS_PER_KIND} normalized tags`,
    ]);
  }
  for (const tag of tags) {
    if (typeof tag !== 'string' || !CAPABILITY_TAG_PATTERN.test(tag)) {
      throw new InvalidRequestError('Invalid capability tag list', [
        'capabilityTags: each entry must be a normalized label (lowercase letters/digits/dots/dashes/colons/underscores, 1-64 chars)',
      ]);
    }
  }
}

/** Validates the external account identity facts of an exchange outcome (verbatim recording). */
export function assertValidFlowIdentity(identity: SocialAccountFlowIdentity): void {
  if (identity === null || typeof identity !== 'object') {
    throw new InvalidRequestError('Invalid external account identity', [
      'identity: must be an object',
    ]);
  }
  if (
    typeof identity.externalAccountId !== 'string'
    || !EXTERNAL_ACCOUNT_ID_PATTERN.test(identity.externalAccountId)
  ) {
    throw new InvalidRequestError('Invalid external account identity', [
      'identity.externalAccountId: must be a non-empty bounded string (1-255 chars)',
    ]);
  }
  if (
    typeof identity.displayIdentity !== 'string'
    || !DISPLAY_IDENTITY_PATTERN.test(identity.displayIdentity)
  ) {
    throw new InvalidRequestError('Invalid external account identity', [
      'identity.displayIdentity: must be a non-empty bounded string (1-255 chars)',
    ]);
  }
  if (
    identity.verifiedAt !== null
    && (typeof identity.verifiedAt !== 'string'
      || Number.isNaN(Date.parse(identity.verifiedAt)))
  ) {
    throw new InvalidRequestError('Invalid external account identity', [
      'identity.verifiedAt: must be null or a valid ISO timestamp',
    ]);
  }
}

/** Validates the opaque token secret handle returned by a flow exchange. */
export function assertValidTokenSecretHandle(handle: string): void {
  if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) {
    throw new InvalidRequestError('Invalid token secret handle', [
      'tokenSecretHandle: must be a valid opaque backend label (1-99 chars, lowercase letters/digits/dashes)',
    ]);
  }
}

/** Validates the platform-reported token expiry (ISO or null). */
export function assertValidExpiresAt(expiresAt: string | null): void {
  if (expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) {
    throw new InvalidRequestError('Invalid token expiry', [
      'expiresAt: must be null or a valid ISO timestamp',
    ]);
  }
}

/**
 * Composes the reason recorded on externally-signalled revocation events:
 * the signal source is embedded (disclosure) and the COMPOSED string is
 * validated against the event reason budget BEFORE any side effect runs
 * (an over-budget composition is a fail-closed 422 — it must never fire
 * mid-death after vault references were already disabled).
 */
export function composeExternalRevocationReason(
  signalledVia: string,
  reason: string | null,
): string {
  const composed = reason === null
    ? `external revocation signalled via ${signalledVia}`
    : `external revocation signalled via ${signalledVia}: ${reason}`;
  assertValidReason(composed);
  return composed;
}

/** Validates the bounded reason of a lifecycle command. */
export function assertValidReason(reason: string | null): void {
  if (
    reason !== null
    && (typeof reason !== 'string'
      || reason.length < 1
      || reason.length > MAX_EVENT_REASON_LENGTH)
  ) {
    throw new InvalidRequestError('Invalid reason', [
      `reason: must be null or 1-${MAX_EVENT_REASON_LENGTH} characters`,
    ]);
  }
}

/**
 * Validates SERVER-DERIVED provenance (the /integrations
 * assertValidProvenance pattern): the actor/via labels are bounded, the
 * correlation identity is present, and NO material-shaped value may ride
 * in the actor/via strings (the §21 backstop).
 */
export function assertValidProvenance(provenance: SocialAccountProvenance): void {
  if (provenance === null || typeof provenance !== 'object') {
    throw new InvalidRequestError('Invalid provenance', ['provenance: must be an object']);
  }
  if (
    typeof provenance.actor !== 'string'
    || provenance.actor.length < 1
    || provenance.actor.length > 100
    || MATERIAL_SHAPED_KEYS.some((key) => provenance.actor.toLowerCase().includes(key))
  ) {
    throw new InvalidRequestError('Invalid provenance', [
      'actor: must be 1-100 chars and not material-shaped (§21)',
    ]);
  }
  if (
    typeof provenance.recordedVia !== 'string'
    || provenance.recordedVia.length < 1
    || provenance.recordedVia.length > 100
  ) {
    throw new InvalidRequestError('Invalid provenance', [
      'recordedVia: must be 1-100 chars',
    ]);
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.length < 1) {
    throw new InvalidRequestError('Invalid provenance', [
      'correlationId: must be present',
    ]);
  }
  if (
    provenance.causationId !== null
    && (typeof provenance.causationId !== 'string' || provenance.causationId.length < 1)
  ) {
    throw new InvalidRequestError('Invalid provenance', [
      'causationId: must be null or a non-empty string',
    ]);
  }
}

// ---------------------------------------------------------------------------
// The canonical owner-context composition (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * Pure composition of the canonical social-account owner context from
 * the ALREADY-RESOLVED /integrations connection owner context and the
 * binding record. Purity is asserted by unit tests — the same inputs
 * always compose the same context. The scope derives entirely from the
 * INTEGRATION CONNECTION's client chain (the hard security boundary); no
 * caller-supplied value can reach it.
 */
export function composeSocialAccountOwnerContext(
  account: SocialAccountRecord,
  integrationOwnership: IntegrationsConnectionOwnerContext,
  resolvedAt: string,
): SocialAccountOwnerContext {
  return {
    scope: {
      kind: 'social-account',
      agencyId: integrationOwnership.clientOwnership.scope.agencyId,
      clientId: account.clientId,
      socialAccountId: account.socialAccountId,
    },
    account,
    integrationConnection: integrationOwnership.connection,
    clientOwnership: integrationOwnership.clientOwnership,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// The provenance-structuring composers (server-derived event inserts)
// ---------------------------------------------------------------------------

/**
 * The structured append-only event insert (provenance structuring — the
 * unit-tested pure composer): derives the durable event row from the
 * lifecycle fact, the initiation source and the SERVER-DERIVED
 * provenance. The returned object is exactly what the store appends —
 * nothing caller-supplied survives structuring beyond the bounded reason.
 */
export function composeSocialAccountEvent(
  input: {
    readonly socialAccountId: string | null;
    readonly grantId: string | null;
    readonly eventType: SocialAccountEventType;
    readonly initiatedBy: 'operator' | 'external-signal';
    readonly reason: string | null;
    readonly providerRevokeOutcome: SocialAccountEventInsert['providerRevokeOutcome'];
  },
  provenance: SocialAccountProvenance,
): SocialAccountEventInsert {
  assertValidProvenance(provenance);
  assertValidReason(input.reason);
  if (input.socialAccountId === null && input.grantId === null) {
    throw new InvalidRequestError('Invalid event', [
      'an event must anchor to an account, a grant or both',
    ]);
  }
  return {
    socialAccountId: input.socialAccountId,
    grantId: input.grantId,
    eventType: input.eventType,
    initiatedBy: input.initiatedBy,
    reason: input.reason,
    providerRevokeOutcome: input.providerRevokeOutcome,
    recordedActor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    causationId: provenance.causationId,
  };
}

/** The authorization_started event insert of one authorize-start round. */
export function composeGrantStartEvent(
  input: {
    readonly socialAccountId: string | null;
    readonly grantId: string;
  },
  provenance: SocialAccountProvenance,
): SocialAccountEventInsert {
  return composeSocialAccountEvent(
    {
      socialAccountId: input.socialAccountId,
      grantId: input.grantId,
      eventType: 'authorization_started',
      initiatedBy: 'operator',
      reason: null,
      providerRevokeOutcome: null,
    },
    provenance,
  );
}

/** The authorization_completed event insert of one completion fill. */
export function composeGrantCompletedEvent(
  input: {
    readonly socialAccountId: string;
    readonly grantId: string;
  },
  provenance: SocialAccountProvenance,
): SocialAccountEventInsert {
  return composeSocialAccountEvent(
    {
      socialAccountId: input.socialAccountId,
      grantId: input.grantId,
      eventType: 'authorization_completed',
      initiatedBy: 'operator',
      reason: null,
      providerRevokeOutcome: null,
    },
    provenance,
  );
}

/** True when a scope kind is in the frozen two-kind vocabulary. */
export function isSocialGrantScopeKind(kind: string): kind is SocialGrantScopeKind {
  return (SOCIAL_GRANT_SCOPE_KIND_VOCABULARY as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// The write-conflict classification (the store's error mapping)
// ---------------------------------------------------------------------------

/**
 * Classifies a store write failure into the module's fail-closed error
 * contract: the partial-unique fence hits (the connection-active fence,
 * the client-identity fence, the authorized-grant fence and the
 * state-token fence) map to ConflictError; everything else is
 * transparent. Returns the human fence name or null.
 */
export function classifySocialWriteConflict(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('social_accounts_connection_active_fence')) {
    return 'connection-already-bound';
  }
  if (message.includes('social_accounts_identity_active_fence')) {
    return 'identity-already-bound-in-client';
  }
  if (message.includes('social_account_grants_authorized_fence')) {
    return 'account-already-authorized';
  }
  if (message.includes('social_account_grants_state_token_unique')) {
    return 'state-token-collision';
  }
  return null;
}
