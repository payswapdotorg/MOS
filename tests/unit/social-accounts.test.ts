/**
 * MKT-055 unit tests — the pure contract surface of the /social-accounts
 * module: the frozen vocabularies, the grant-validation pure functions
 * and the provenance structuring (no DB; the pinning proof).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-055; the dispatch
 * AC-2/AC-9):
 *   - the STATE VOCABULARY PINNING: the account lifecycle (connected →
 *     disconnected | revoked, both terminal), the grant lifecycle
 *     (pending → authorized → expired/revoked/refreshed/superseded with
 *     the exact frozen transition table), the refreshable set and the
 *     scope-kind vocabulary agree with the migration-046 CHECKs;
 *   - the GRANT-VALIDATION PURE FUNCTIONS: requested-scope guards,
 *     verbatim granted-scope + capability-tag guards, the external
 *     identity facts, the token handle shape, the expiry, the reason
 *     bounds, the provenance guard with the §21 material-shaped actor
 *     backstop, the flow-registration guard + the registry builder
 *     (duplicates and malformed registrations fail loudly);
 *   - the PROVENANCE STRUCTURING: the event composers derive the durable
 *     event rows from the server-derived provenance (the same inputs
 *     always structure the same rows), reject anchorless events and
 *     never let caller data reach the provenance block;
 *   - the WRITE-CONFLICT CLASSIFICATION: the migration-046 fence names
 *     map to the fail-closed conflict contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import type {
  SocialAccountFlowImplementation,
  SocialAccountProvenance,
} from '../../src/modules/social-accounts/public.ts';
import {
  isGrantRefreshable,
  isLegalSocialAccountTransition,
  isLegalSocialGrantTransition,
  SOCIAL_ACCOUNT_STATUSES,
  SOCIAL_ACCOUNT_TOKEN_CREDENTIAL_KIND,
  SOCIAL_ACCOUNT_TRANSITIONS,
  SOCIAL_GRANT_SCOPE_KINDS,
  SOCIAL_GRANT_STATES,
  SOCIAL_GRANT_TRANSITIONS,
} from '../../src/modules/social-accounts/public.ts';
import {
  assertValidCapabilityTagList,
  assertValidExpiresAt,
  assertValidFlowIdentity,
  assertValidGrantedScopeList,
  assertValidProvenance,
  assertValidReason,
  assertValidRequestedScopes,
  assertValidTokenSecretHandle,
  buildFlowRegistry,
  classifySocialWriteConflict,
  composeExternalRevocationReason,
  composeGrantCompletedEvent,
  composeGrantStartEvent,
  composeSocialAccountEvent,
  composeSocialAccountOwnerContext,
  MAX_EVENT_REASON_LENGTH,
  SOCIAL_ACCOUNT_EVENT_TYPE_VOCABULARY,
  SOCIAL_ACCOUNT_STATUS_VOCABULARY,
  SOCIAL_GRANT_SCOPE_KIND_VOCABULARY,
  SOCIAL_GRANT_STATE_VOCABULARY,
} from '../../src/modules/social-accounts/public.ts';

const PROVENANCE: SocialAccountProvenance = {
  actor: 'user:018f6a2e-1000-7000-8000-000000000001',
  recordedVia: 'api',
  correlationId: 'corr-1',
  causationId: null,
};

/** A minimal well-formed flow implementation for the registry tests. */
function fakeFlow(adapterKey: string): SocialAccountFlowImplementation {
  return {
    descriptor: { adapterKey, flowLabel: `Flow ${adapterKey}`, description: 'test flow' },
    buildAuthorizeUrl: async () => ({ authorizeUrl: 'https://provider.example/authorize' }),
    exchangeAuthorizationCode: async () => {
      throw new Error('not needed in this test');
    },
    refreshAuthorization: async () => {
      throw new Error('not needed in this test');
    },
    revokeAuthorization: async () => ({ revoked: true, message: null }),
  };
}

// ---------------------------------------------------------------------------
// The state vocabulary pinning
// ---------------------------------------------------------------------------

test('MKT-055 vocabulary pinning: the account lifecycle is connected → disconnected | revoked with BOTH terminal states', () => {
  assert.deepEqual(SOCIAL_ACCOUNT_STATUSES, ['connected', 'disconnected', 'revoked']);
  assert.deepEqual(SOCIAL_ACCOUNT_STATUS_VOCABULARY, ['connected', 'disconnected', 'revoked']);
  assert.deepEqual(SOCIAL_ACCOUNT_TRANSITIONS, {
    connected: ['disconnected', 'revoked'],
    disconnected: [],
    revoked: [],
  });
  assert.ok(isLegalSocialAccountTransition('connected', 'disconnected'));
  assert.ok(isLegalSocialAccountTransition('connected', 'revoked'));
  assert.ok(!isLegalSocialAccountTransition('disconnected', 'connected'), 'terminal — never re-activated in place');
  assert.ok(!isLegalSocialAccountTransition('revoked', 'connected'), 'terminal — never re-activated in place');
  assert.ok(!isLegalSocialAccountTransition('connected', 'connected'), 'no self transition');
  assert.ok(!isLegalSocialAccountTransition('connected', 'pending' as never), 'account states never borrow grant states');
});

test('MKT-055 vocabulary pinning: the grant lifecycle transition table is exactly the frozen table', () => {
  assert.deepEqual(SOCIAL_GRANT_STATES, [
    'pending', 'authorized', 'expired', 'revoked', 'refreshed', 'superseded',
  ]);
  assert.deepEqual(SOCIAL_GRANT_STATE_VOCABULARY, [
    'pending', 'authorized', 'expired', 'revoked', 'refreshed', 'superseded',
  ]);
  assert.deepEqual(SOCIAL_GRANT_TRANSITIONS, {
    pending: ['authorized', 'expired', 'revoked'],
    authorized: ['expired', 'revoked', 'refreshed', 'superseded'],
    expired: ['refreshed', 'superseded', 'revoked'],
    revoked: [],
    refreshed: [],
    superseded: [],
  });
  for (const [from, targets] of Object.entries(SOCIAL_GRANT_TRANSITIONS)) {
    for (const to of SOCIAL_GRANT_STATES) {
      assert.equal(
        isLegalSocialGrantTransition(from as never, to as never),
        (targets as readonly string[]).includes(to),
        `transition ${from} -> ${to} must match the frozen table`,
      );
    }
  }
  // The refreshable set: authorized + expired (the refresh-token recovery).
  assert.ok(isGrantRefreshable('authorized'));
  assert.ok(isGrantRefreshable('expired'));
  assert.ok(!isGrantRefreshable('pending'));
  assert.ok(!isGrantRefreshable('revoked'));
  assert.ok(!isGrantRefreshable('refreshed'));
  assert.ok(!isGrantRefreshable('superseded'));
});

test('MKT-055 vocabulary pinning: the scope-kind and event vocabularies are the frozen closed sets', () => {
  assert.deepEqual(SOCIAL_GRANT_SCOPE_KINDS, ['granted-scope', 'capability-tag']);
  assert.deepEqual(SOCIAL_GRANT_SCOPE_KIND_VOCABULARY, ['granted-scope', 'capability-tag']);
  assert.deepEqual(SOCIAL_ACCOUNT_EVENT_TYPE_VOCABULARY, [
    'authorization_started',
    'authorization_completed',
    'authorization_expired',
    'authorization_revoked',
    'grant_refreshed',
    'grant_superseded',
    'account_disconnected',
    'account_revoked',
  ]);
  // The grant's credential kind is its own least-privilege kind (rule 28).
  assert.equal(SOCIAL_ACCOUNT_TOKEN_CREDENTIAL_KIND, 'social_account_oauth');
});

// ---------------------------------------------------------------------------
// The grant-validation pure functions
// ---------------------------------------------------------------------------

test('MKT-055 grant validation: the requested-scope INTENT guard accepts null, a bounded list, rejects the rest', () => {
  assert.doesNotThrow(() => assertValidRequestedScopes(null));
  assert.doesNotThrow(() => assertValidRequestedScopes(['read:content', 'write:content']));
  assert.throws(() => assertValidRequestedScopes([]), InvalidRequestError);
  assert.throws(() => assertValidRequestedScopes(['read:content', '']), InvalidRequestError);
  assert.throws(
    () => assertValidRequestedScopes(Array.from({ length: 65 }, (_, i) => `scope-${i}`)),
    InvalidRequestError,
  );
  assert.throws(() => assertValidRequestedScopes(['x'.repeat(256)]), InvalidRequestError);
});

test('MKT-055 grant validation: the VERBATIM granted-scope list guard accepts any bounded non-empty strings — never normalizes', () => {
  assert.doesNotThrow(() => assertValidGrantedScopeList([]));
  // Verbatim recording: odd capitalization, separators and unicode ride
  // through untouched (a RECORD, never an interpretation).
  assert.doesNotThrow(() =>
    assertValidGrantedScopeList(['https://provider.example/read', 'Write.CONTENT', 'scope:all']),
  );
  assert.throws(() => assertValidGrantedScopeList(['']), InvalidRequestError);
  assert.throws(() => assertValidGrantedScopeList(['ok', 'x'.repeat(256)]), InvalidRequestError);
  assert.throws(
    () => assertValidGrantedScopeList(Array.from({ length: 65 }, (_, i) => `s${i}`)),
    InvalidRequestError,
  );
});

test('MKT-055 grant validation: the capability-tag guard accepts normalized labels, rejects the rest', () => {
  assert.doesNotThrow(() => assertValidCapabilityTagList(['account-read', 'content.publish', 'analytics:read']));
  assert.throws(() => assertValidCapabilityTagList(['Account-Read']), InvalidRequestError);
  assert.throws(() => assertValidCapabilityTagList(['account read']), InvalidRequestError);
  assert.throws(() => assertValidCapabilityTagList(['']), InvalidRequestError);
  assert.throws(() => assertValidCapabilityTagList(['x'.repeat(65)]), InvalidRequestError);
});

test('MKT-055 grant validation: the external identity facts guard (recorded verbatim)', () => {
  assert.doesNotThrow(() =>
    assertValidFlowIdentity({
      externalAccountId: 'UC-x8f29dka_91',
      displayIdentity: 'Some Channel ✅',
      verifiedAt: '2026-07-01T10:00:00.000Z',
    }),
  );
  assert.doesNotThrow(() =>
    assertValidFlowIdentity({ externalAccountId: 'acct-1', displayIdentity: 'd', verifiedAt: null }),
  );
  assert.throws(() => assertValidFlowIdentity({ externalAccountId: '', displayIdentity: 'd', verifiedAt: null }), InvalidRequestError);
  assert.throws(() => assertValidFlowIdentity({ externalAccountId: 'x'.repeat(256), displayIdentity: 'd', verifiedAt: null }), InvalidRequestError);
  assert.throws(() => assertValidFlowIdentity({ externalAccountId: 'a', displayIdentity: 'x'.repeat(257), verifiedAt: null }), InvalidRequestError);
  assert.throws(() => assertValidFlowIdentity({ externalAccountId: 'a', displayIdentity: 'd', verifiedAt: 'not-a-date' }), InvalidRequestError);
});

test('MKT-055 grant validation: the token handle, expiry and reason guards', () => {
  // The opaque backend handle shape (the credentials-store mirror).
  assert.doesNotThrow(() => assertValidTokenSecretHandle('sa-oauth-1'));
  assert.throws(() => assertValidTokenSecretHandle('Bad_Handle'), InvalidRequestError);
  assert.throws(() => assertValidTokenSecretHandle(''), InvalidRequestError);
  assert.throws(() => assertValidTokenSecretHandle('x'.repeat(100)), InvalidRequestError);
  // Expiry: null or a valid ISO timestamp.
  assert.doesNotThrow(() => assertValidExpiresAt(null));
  assert.doesNotThrow(() => assertValidExpiresAt('2026-08-01T00:00:00.000Z'));
  assert.throws(() => assertValidExpiresAt('soon'), InvalidRequestError);
  // Reason bounds.
  assert.doesNotThrow(() => assertValidReason(null));
  assert.doesNotThrow(() => assertValidReason('operator removed the connection'));
  assert.throws(() => assertValidReason(''), InvalidRequestError);
  assert.throws(() => assertValidReason('x'.repeat(MAX_EVENT_REASON_LENGTH + 1)), InvalidRequestError);
});

test('MKT-055 grant validation: the external-revocation reason composer embeds the signal source and fails CLOSED on a composed over-budget string (BEFORE any side effect)', () => {
  // The signal source is embedded for disclosure.
  assert.equal(
    composeExternalRevocationReason('provider-webhook-relay', null),
    'external revocation signalled via provider-webhook-relay',
  );
  assert.equal(
    composeExternalRevocationReason('adapter-poll', 'the user revoked app access'),
    'external revocation signalled via adapter-poll: the user revoked app access',
  );
  // A bounded reason composes within the event budget.
  const longestLegalSignal = 'a'.repeat(64);
  const longestLegalReason = 'x'.repeat(MAX_EVENT_REASON_LENGTH - longestLegalSignal.length - 'external revocation signalled via '.length - ': '.length);
  const composed = composeExternalRevocationReason(longestLegalSignal, longestLegalReason);
  assert.equal(composed.length, MAX_EVENT_REASON_LENGTH);
  // One more character in the reason overflows the COMPOSED string — the
  // rejection fires in the composer (pure, before any vault disablement
  // or durable death step), never mid-transaction.
  assert.throws(
    () => composeExternalRevocationReason(longestLegalSignal, longestLegalReason + 'y'),
    InvalidRequestError,
  );
});

test('MKT-055 grant validation: the provenance guard — server-derived shape with the §21 material-shaped actor backstop', () => {
  assert.doesNotThrow(() => assertValidProvenance(PROVENANCE));
  assert.throws(() => assertValidProvenance({ ...PROVENANCE, actor: '' }), InvalidRequestError);
  assert.throws(
    () => assertValidProvenance({ ...PROVENANCE, actor: 'user:x'.repeat(50) }),
    InvalidRequestError,
  );
  // §21 backstop: material-shaped actors are rejected outright.
  assert.throws(() => assertValidProvenance({ ...PROVENANCE, actor: 'token:abc123' }), InvalidRequestError);
  assert.throws(() => assertValidProvenance({ ...PROVENANCE, actor: 'service:password-reset' }), InvalidRequestError);
  assert.throws(() => assertValidProvenance({ ...PROVENANCE, recordedVia: '' }), InvalidRequestError);
  assert.throws(() => assertValidProvenance({ ...PROVENANCE, correlationId: '' }), InvalidRequestError);
});

test('MKT-055 grant validation: the flow-registration guard + the registry builder fail loudly on duplicates and malformed registrations', () => {
  const registry = buildFlowRegistry([fakeFlow('crm'), fakeFlow('creator-platform')]);
  assert.equal(registry.size, 2);
  assert.ok(registry.has('crm'));
  assert.ok(registry.has('creator-platform'));
  // Duplicate adapter keys fail construction.
  assert.throws(() => buildFlowRegistry([fakeFlow('crm'), fakeFlow('crm')]), InvalidRequestError);
  // Malformed descriptors fail construction.
  assert.throws(
    () => buildFlowRegistry([fakeFlow('Bad_Key')]),
    InvalidRequestError,
  );
  const missingMember = fakeFlow('crm') as unknown as { exchangeAuthorizationCode: unknown };
  delete missingMember.exchangeAuthorizationCode;
  assert.throws(() => buildFlowRegistry([missingMember as unknown as SocialAccountFlowImplementation]), InvalidRequestError);
  // Empty registry is legal (the production composition until MKT-056+).
  assert.equal(buildFlowRegistry([]).size, 0);
});

// ---------------------------------------------------------------------------
// The provenance structuring (the event composers)
// ---------------------------------------------------------------------------

test('MKT-055 provenance structuring: the event composers derive identical durable rows from identical inputs (purity)', () => {
  const start = composeGrantStartEvent(
    { socialAccountId: null, grantId: 'grant-1' },
    PROVENANCE,
  );
  const startAgain = composeGrantStartEvent(
    { socialAccountId: null, grantId: 'grant-1' },
    PROVENANCE,
  );
  assert.deepEqual(start, startAgain);
  assert.equal(start.eventType, 'authorization_started');
  assert.equal(start.grantId, 'grant-1');
  assert.equal(start.initiatedBy, 'operator');
  assert.equal(start.recordedActor, PROVENANCE.actor);
  assert.equal(start.recordedVia, PROVENANCE.recordedVia);
  assert.equal(start.correlationId, PROVENANCE.correlationId);

  const completed = composeGrantCompletedEvent(
    { socialAccountId: 'account-1', grantId: 'grant-1' },
    { ...PROVENANCE, causationId: 'corr-0' },
  );
  assert.equal(completed.eventType, 'authorization_completed');
  assert.equal(completed.socialAccountId, 'account-1');
  assert.equal(completed.causationId, 'corr-0');

  // The generic composer: every event type + the provider-revoke disclosure.
  const disconnected = composeSocialAccountEvent(
    {
      socialAccountId: 'account-1',
      grantId: null,
      eventType: 'account_disconnected',
      initiatedBy: 'operator',
      reason: 'operator removed the connection',
      providerRevokeOutcome: 'revoked',
    },
    PROVENANCE,
  );
  assert.equal(disconnected.providerRevokeOutcome, 'revoked');
  const external = composeSocialAccountEvent(
    {
      socialAccountId: 'account-1',
      grantId: null,
      eventType: 'account_revoked',
      initiatedBy: 'external-signal',
      reason: null,
      providerRevokeOutcome: null,
    },
    PROVENANCE,
  );
  assert.equal(external.initiatedBy, 'external-signal');
  assert.equal(external.providerRevokeOutcome, null);

  // An anchorless event is refused (every event anchors to an account,
  // a grant or both).
  assert.throws(
    () =>
      composeSocialAccountEvent(
        {
          socialAccountId: null,
          grantId: null,
          eventType: 'account_disconnected',
          initiatedBy: 'operator',
          reason: null,
          providerRevokeOutcome: null,
        },
        PROVENANCE,
      ),
    InvalidRequestError,
  );
  // The composer validates the reason + the provenance it structures.
  assert.throws(
    () =>
      composeSocialAccountEvent(
        {
          socialAccountId: 'account-1',
          grantId: null,
          eventType: 'account_disconnected',
          initiatedBy: 'operator',
          reason: 'x'.repeat(MAX_EVENT_REASON_LENGTH + 1),
          providerRevokeOutcome: null,
        },
        PROVENANCE,
      ),
    InvalidRequestError,
  );
});

test('MKT-055 provenance structuring: the canonical owner-context composition derives the scope from the INTEGRATION chain only', () => {
  const account = {
    socialAccountId: 'account-1',
    integrationConnectionId: 'conn-1',
    agencyId: 'agency-1',
    clientId: 'client-1',
    workspaceId: null,
    platformId: 'crm',
    externalAccountId: 'ext-1',
    displayIdentity: 'A Channel',
    verifiedAt: null,
    status: 'connected' as const,
    version: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
  const integrationOwnership = {
    scope: { kind: 'integration' as const, agencyId: 'agency-1', clientId: 'client-1', connectionId: 'conn-1' },
    connection: {
      connectionId: 'conn-1',
      clientId: 'client-1',
      agencyId: 'agency-1',
      adapterKey: 'crm',
      providerLabel: 'CRM',
      status: 'connected' as const,
      health: 'healthy' as const,
      credentialReferenceId: 'cred-0',
      providerConfig: {},
      rateLimit: null,
      lastError: null,
      lastCheckedAt: null,
      createdBy: null,
      version: 3,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
    clientOwnership: {
      scope: { kind: 'client' as const, agencyId: 'agency-1', clientId: 'client-1' },
      client: { clientId: 'client-1', agencyId: 'agency-1', status: 'active' },
    },
    resolvedAt: '2026-07-01T00:00:01.000Z',
  };
  const composed = composeSocialAccountOwnerContext(account, integrationOwnership, '2026-07-02T00:00:00.000Z');
  assert.deepEqual(composed.scope, {
    kind: 'social-account',
    agencyId: 'agency-1',
    clientId: 'client-1',
    socialAccountId: 'account-1',
  });
  assert.equal(composed.account, account);
  assert.equal(composed.integrationConnection, integrationOwnership.connection);
  assert.equal(composed.clientOwnership, integrationOwnership.clientOwnership);
  assert.equal(composed.resolvedAt, '2026-07-02T00:00:00.000Z');
  // Purity: the same inputs compose the same context.
  assert.deepEqual(
    composeSocialAccountOwnerContext(account, integrationOwnership, '2026-07-02T00:00:00.000Z'),
    composed,
  );
});

// ---------------------------------------------------------------------------
// The write-conflict classification
// ---------------------------------------------------------------------------

test('MKT-055 write-conflict classification: the migration-046 fence names map to the fail-closed conflict contract', () => {
  assert.equal(
    classifySocialWriteConflict(new Error('duplicate key value violates unique constraint "social_accounts_connection_active_fence"')),
    'connection-already-bound',
  );
  assert.equal(
    classifySocialWriteConflict(new Error('duplicate key value violates unique constraint "social_accounts_identity_active_fence"')),
    'identity-already-bound-in-client',
  );
  assert.equal(
    classifySocialWriteConflict(new Error('duplicate key value violates unique constraint "social_account_grants_authorized_fence"')),
    'account-already-authorized',
  );
  assert.equal(
    classifySocialWriteConflict(new Error('duplicate key value violates unique constraint "social_account_grants_state_token_unique"')),
    'state-token-collision',
  );
  assert.equal(classifySocialWriteConflict(new Error('some other database error')), null);
  assert.equal(classifySocialWriteConflict(new Error(''),), null);
});
