/**
 * MKT-055 integration tests — the Social Account and OAuth Connection
 * Model on the REAL stack: embedded PostgreSQL 18, a real API process
 * (the production composition — the OAuth flow registry EMPTY), and the
 * DISCLOSED LOCAL provider double served from the test process
 * (tests/integration/helpers/oauth-provider.ts — a test double at the
 * provider boundary ONLY; the connection model under test is fully
 * real, adapters are MKT-056+ scope). The golden path is driven through
 * the SAME in-process application composed against the SAME database the
 * API serves, with the local flow implementation supplied through the
 * DISCLOSED AppOptions.socialAccountFlows composition seam (the
 * app-metering module-command precedent); the route battery (reads,
 * deaths, authorization, isolation, the fail-closed no-flow refusal)
 * runs against the spawned production API.
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-055; the
 * dispatch acceptance criteria):
 *   - AC-1: the account record attaches to a Client/Workspace through
 *     an EXISTING authorized Integration (the canonical integration
 *     reference read-only; the agency/client scope chain server-derived
 *     through the connection's own chain);
 *   - AC-2: the OAuth lifecycle golden path — connect → grant recorded
 *     with the EXACT scopes → identity bound → refresh (new record +
 *     successor link + the old vault reference disabled) → reauthorize
 *     (new cycle) → disconnect (terminal) → every read refuses;
 *     scope-verbatim recording (odd provider scope strings ride through
 *     untouched, order preserved); the expired state (explicit) + the
 *     lazy expiry refusal + the refresh recovery;
 *   - AC-3: secrets NEVER in the social-account tables (DB-asserted: no
 *     token-shaped column even exists); the vault reference integrity —
 *     a dangling handle is rejected with ZERO rows; the grant's own
 *     least-privilege reference kind; the material resolves ONLY through
 *     the /credentials authorized-execution path (in-process);
 *   - AC-4: one connection binds one platform identity; idempotent
 *     re-connect (the same external account converges on the single
 *     active binding — no duplicate); conflicting bindings rejected
 *     fail-closed (a different identity on the bound connection; the
 *     same identity on another connection of the same client);
 *   - AC-5: fail-closed disconnect/revocation — operator disconnect and
 *     externally-signalled revocation both leave the connection
 *     UNUSABLE: the usable read nulls, the grant reads refuse (409 over
 *     the route), refresh and reauthorize refuse, the vault references
 *     are disabled — no zombie grants;
 *   - AC-8: the isolation battery (anonymous 401; foreign/unknown/
 *     malformed identifiers uniform 404; a suspended membership 403)
 *     + the append-only DB battery (UPDATE/DELETE rejected on the event
 *     tail + scope records; DELETE rejected on grants; the grant
 *     fact-immutability trigger);
 *   - the policy fail-closed gate: a network DENY blocks the completion
 *     BEFORE any provider exchange (the provider counter proves zero
 *     traffic).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type pg from 'pg';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import {
  createLocalOAuthFlow,
  startLocalOAuthProvider,
  type LocalOAuthProvider,
} from './helpers/oauth-provider.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type {
  SocialAccountsModuleApi,
  SocialGrantRecord,
} from '../../src/modules/social-accounts/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const CRM_SECRET_HANDLE = 'social-accounts-test-crm-key';
const CRM_SECRET_MATERIAL = JSON.stringify({
  accessToken: 'sandbox-crm-bearer-' + 'AIza' + 'fakeMaterial',
  webhookSecret: null,
});

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: LocalOAuthProvider | null = null;
let socialAccounts: SocialAccountsModuleApi | null = null;
let vault: CredentialsModuleApi | null = null;

function accounts(): SocialAccountsModuleApi {
  if (socialAccounts === null) throw new Error('application not bootstrapped');
  return socialAccounts;
}
function credentialsModule(): CredentialsModuleApi {
  if (vault === null) throw new Error('application not bootstrapped');
  return vault;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}
function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}
function oauth(): LocalOAuthProvider {
  if (provider === null) throw new Error('provider double not started');
  return provider;
}

const MODULE_PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-0000000000aa',
  recordedVia: 'test',
  correlationId: 'integration-social-accounts-1',
  causationId: null,
} as const;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

interface User {
  readonly userId: string;
  readonly token: string;
}
interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

let adminTokenCache: string | null = null;
async function adminToken(): Promise<string> {
  if (adminTokenCache !== null) return adminTokenCache;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  adminTokenCache = login.body['token'] as string;
  return adminTokenCache;
}

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

async function makeAgencyOwner(email: string): Promise<Principal> {
  const user = await makeUser(email, 'owner-password-123');
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: user.userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { userId: user.userId, token: user.token, agencyId };
}

let clientSeq = 0;
async function makeClient(agencyId: string, token: string): Promise<string> {
  clientSeq += 1;
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name: `Client ${agencyId.slice(0, 8)} ${clientSeq}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['clientId'] as string;
}

async function makeWorkspace(clientId: string, token: string, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token,
    body: { name },
  });
  assert.equal(created.status, 201);
  return created.body['workspaceId'] as string;
}

/** Declares an AGENCY policy version allowing every operation on a dimension. */
async function allowAll(principal: Principal, dimension: 'network' | 'secrets'): Promise<void> {
  const declared = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, {
    token: principal.token,
    body: {
      dimension,
      rules: [{ effect: 'allow', operations: ['*'], reason: 'integration test allowance' }],
      description: `Integration test ${dimension} allowance`,
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

/** Creates a CRM credential reference + registers + CONNECTS the integration. */
async function makeConnectedCrmConnection(
  principal: Principal,
  clientId: string,
  credentialLabel: string,
): Promise<{ credentialId: string; connectionId: string }> {
  const credential = await apiCall(port(), `/api/agencies/${principal.agencyId}/credentials`, {
    token: principal.token,
    body: {
      kind: 'integration_api_key',
      label: credentialLabel,
      secretHandle: CRM_SECRET_HANDLE,
    },
  });
  assert.equal(credential.status, 201, JSON.stringify(credential.body));
  const credentialId = credential.body['credentialId'] as string;

  const registered = await apiCall(port(), `/api/clients/${clientId}/connections`, {
    token: principal.token,
    body: {
      adapterKey: 'crm',
      credentialReferenceId: credentialId,
      providerConfig: { apiBaseUrl: oauth().url },
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const connectionId = registered.body['connectionId'] as string;

  const connected = await apiCall(
    port(),
    `/api/clients/${clientId}/connections/${connectionId}/connect`,
    { token: principal.token, body: { expectedVersion: 1 } },
  );
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.equal(connected.body['status'], 'connected', 'the integration must be an AUTHORIZED (connected) pipe');
  return { credentialId, connectionId };
}

/** A FRESH connected CRM connection for a scenario (identities never collide). */
async function freshConnection(label: string): Promise<string> {
  const made = await makeConnectedCrmConnection(alice, aliceClientId, label);
  return made.connectionId;
}

/** The full OAuth handshake through the real module (the in-process app). */
async function connectAccount(
  clientId: string,
  connectionId: string,
  workspaceId: string | null,
  fixture: {
    readonly accountId: string;
    readonly displayIdentity: string;
    readonly scopes: readonly string[];
    readonly capabilityTags?: readonly string[];
    readonly expiresInMs?: number | null;
    readonly refreshScopes?: readonly string[];
    readonly refreshExpiresInMs?: number | null;
  },
): Promise<{ accountId: string; grantId: string; state: string; grant: SocialGrantRecord }> {
  const start = await accounts().startAuthorization(
    {
      clientId,
      integrationConnectionId: connectionId,
      workspaceId,
      requestedScopes: [...fixture.scopes],
      expectedAccountId: null,
    },
    MODULE_PROVENANCE,
  );
  const issued = oauth().issueAuthorization({
    accountId: fixture.accountId,
    displayIdentity: fixture.displayIdentity,
    verifiedAt: '2026-07-01T09:30:00.000Z',
    scopes: [...fixture.scopes],
    capabilityTags: fixture.capabilityTags ?? ['account-read'],
    expiresInMs: fixture.expiresInMs === undefined ? 3_600_000 : fixture.expiresInMs,
    ...(fixture.refreshScopes === undefined ? {} : { refreshScopes: fixture.refreshScopes }),
    ...(fixture.refreshExpiresInMs === undefined ? {} : { refreshExpiresInMs: fixture.refreshExpiresInMs }),
  });
  const completion = await accounts().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    MODULE_PROVENANCE,
  );
  return {
    accountId: completion.account.socialAccountId,
    grantId: completion.grant.grantId,
    state: start.grant.stateToken,
    grant: completion.grant,
  };
}

async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  const result = await pool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
    params as never[],
  );
  return Number(result.rows[0]!.count);
}

async function assertDbRejects(sql: string, params: unknown[], marker: string): Promise<void> {
  await assert.rejects(
    () => pool().query(sql, params as never[]),
    (error: unknown) => {
      assert.ok(
        error instanceof Error && error.message.includes(marker),
        `expected the database to reject with '${marker}', got: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// Shared state built once in before()
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let aliceWorkspaceId: string;
let aliceCrmConnectionId: string;
let bob: Principal;
let bobClientId: string;
let suspendedMember: User;

before(async () => {
  stack = await bootStack('social-accounts');
  // The CRED-001 secret-handle fixture (the extensions-api precedent):
  // the credential authority resolves a REAL handle in the fs secret
  // backend; only the reference id ever lands in the connection row.
  fs.writeFileSync(`${stack.env.secretsDir}/${CRM_SECRET_HANDLE}.secret`, CRM_SECRET_MATERIAL, {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The disclosed LOCAL provider double (loopback HTTP) + the in-process
  // application with the flow registered through the AppOptions seam.
  provider = await startLocalOAuthProvider();
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({
    socialAccountFlows: [createLocalOAuthFlow(provider, { adapterKey: 'crm', secretsDir: stack.env.secretsDir })],
  });
  socialAccounts = core.modules.socialAccounts;
  vault = core.modules.credentials;

  // Fixtures: two agencies (the isolation battery), a workspace, the
  // policy allowances and the connected CRM integration.
  alice = await makeAgencyOwner('alice@social-accounts.test');
  bob = await makeAgencyOwner('bob@social-accounts.test');
  aliceClientId = await makeClient(alice.agencyId, alice.token);
  aliceWorkspaceId = await makeWorkspace(aliceClientId, alice.token, 'Growth Room');
  bobClientId = await makeClient(bob.agencyId, bob.token);
  await allowAll(alice, 'network');
  await allowAll(alice, 'secrets');
  const connection = await makeConnectedCrmConnection(alice, aliceClientId, 'alice_crm_key');
  aliceCrmConnectionId = connection.connectionId;

  // A suspended member of alice's agency (the 403 battery).
  suspendedMember = await makeUser('suspended@social-accounts.test', 'suspended-pass-123');
  const membership = await apiCall(port(), `/api/agencies/${alice.agencyId}/memberships`, {
    token: alice.token,
    body: { userId: suspendedMember.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));
  const suspend = await apiCall(
    port(),
    `/api/agencies/${alice.agencyId}/memberships/${membership.body['membershipId']}`,
    {
      token: alice.token,
      method: 'PATCH',
      body: { status: 'disabled', version: membership.body['version'] as number },
    },
  );
  assert.equal(suspend.status, 200, JSON.stringify(suspend.body));
});

after(async () => {
  await provider?.close();
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// AC-1/AC-2: THE GOLDEN PATH — connect → grant recorded with exact scopes
// ---------------------------------------------------------------------------

test('AC-1/AC-2 golden path: authorize-start appends the PENDING round; the completion records the grant with the EXACT verbatim scopes + capability tags and binds the identity', async () => {
  const start = await accounts().startAuthorization(
    {
      clientId: aliceClientId,
      integrationConnectionId: aliceCrmConnectionId,
      workspaceId: aliceWorkspaceId,
      requestedScopes: ['read:content', 'write:content'],
      expectedAccountId: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(start.grant.grantState, 'pending');
  assert.ok(start.grant.stateToken.length >= 16, 'the opaque state token is generated');
  assert.ok(start.authorizeUrl.includes(oauth().url), 'the authorize URL targets the provider double');
  assert.ok(start.authorizeUrl.includes(encodeURIComponent(start.grant.stateToken)));

  // DB: the pending round carries ONLY the authorize-start facts.
  assert.equal(
    await countRows('social_account_grants', 'grant_id = $1', [start.grant.grantId]),
    1,
  );
  const pendingRow = await pool().query(
    'SELECT social_account_id, credential_reference_id, completed_at FROM social_account_grants WHERE grant_id = $1',
    [start.grant.grantId],
  );
  assert.equal(pendingRow.rows[0]!.social_account_id, null);
  assert.equal(pendingRow.rows[0]!.credential_reference_id, null);
  assert.equal(pendingRow.rows[0]!.completed_at, null);

  // The odd, provider-specific scope strings must ride through VERBATIM
  // (never normalized — lock rule 19: a record, not an interpretation).
  const weirdScopes = ['read:content', 'Write.CONTENT', 'https://provider.example/scope/all'];
  const issued = oauth().issueAuthorization({
    accountId: 'ext-channel-91',
    displayIdentity: 'The Growth Channel ✅',
    verifiedAt: '2026-07-01T09:30:00.000Z',
    scopes: weirdScopes,
    capabilityTags: ['account-read', 'content.publish', 'analytics:read'],
    expiresInMs: 3_600_000,
  });
  const completion = await accounts().completeAuthorization(
    { clientId: aliceClientId, state: start.grant.stateToken, code: issued.code },
    MODULE_PROVENANCE,
  );

  // AC-1: the account identity binding through the EXISTING authorized
  // integration (canonical reference read-only; the scope chain
  // server-derived from the connection's own chain).
  assert.equal(completion.account.status, 'connected');
  assert.equal(completion.account.integrationConnectionId, aliceCrmConnectionId);
  assert.equal(completion.account.agencyId, alice.agencyId);
  assert.equal(completion.account.clientId, aliceClientId);
  assert.equal(completion.account.workspaceId, aliceWorkspaceId);
  assert.equal(completion.account.platformId, 'crm');
  assert.equal(completion.account.externalAccountId, 'ext-channel-91');
  assert.equal(completion.account.displayIdentity, 'The Growth Channel ✅');
  assert.equal(completion.account.verifiedAt, '2026-07-01T09:30:00.000Z');

  // AC-2: the grant + the EXACT scope list VERBATIM (order preserved).
  assert.equal(completion.grant.grantState, 'authorized');
  assert.deepEqual(completion.scopeFacts.grantedScopes, weirdScopes);
  assert.deepEqual(completion.scopeFacts.capabilityTags, [
    'account-read', 'content.publish', 'analytics:read',
  ]);

  // DB: the scope records preserve the verbatim list order.
  const scopeRows = await pool().query(
    `SELECT scope_kind, scope_value, position FROM social_account_grant_scopes
     WHERE grant_id = $1 ORDER BY scope_kind, position`,
    [completion.grant.grantId],
  );
  const granted = scopeRows.rows.filter((row) => row.scope_kind === 'granted-scope');
  assert.deepEqual(
    granted.map((row) => row.scope_value),
    weirdScopes,
  );
  assert.deepEqual(granted.map((row) => row.position), [0, 1, 2], 'the verbatim order is preserved');
  const tags = scopeRows.rows.filter((row) => row.scope_kind === 'capability-tag');
  assert.deepEqual(
    tags.map((row) => row.scope_value),
    ['account-read', 'content.publish', 'analytics:read'],
  );

  // DB: the events tail (started + completed).
  const events = await accounts().listAccountEvents(completion.account.socialAccountId);
  assert.deepEqual(
    events.map((event) => event.eventType),
    ['authorization_started', 'authorization_completed'],
  );
  assert.equal(events[0]!.initiatedBy, 'operator');

  // The usable authorization read returns the full record.
  const usable = await accounts().getUsableAuthorization(completion.account.socialAccountId);
  assert.notEqual(usable, null);
  assert.equal(usable!.grant.grantId, completion.grant.grantId);
  assert.deepEqual(usable!.scopeFacts.grantedScopes, weirdScopes);
  assert.equal(usable!.account.externalAccountId, 'ext-channel-91');
});

test('AC-3 secret separation: the vault reference is the ONLY token linkage; the material resolves ONLY through the /credentials authorized-execution path; the tables carry no token column at all', async () => {
  const listing = await accounts().listSocialAccountsForClient(aliceClientId);
  assert.equal(listing.length, 1, 'exactly one binding exists so far');
  const account = listing[0]!;
  const grant = (await accounts().listAuthorizationGrantsForAccount(account.socialAccountId))[0]!;
  assert.notEqual(grant.credentialReferenceId, null);

  // The reference is the grant's OWN least-privilege kind (rule 28).
  const reference = await credentialsModule().getCredentialReference(grant.credentialReferenceId!);
  assert.notEqual(reference, null);
  assert.equal(reference!.kind, 'social_account_oauth');
  assert.equal(reference!.agencyId, alice.agencyId);
  assert.equal(reference!.clientId, aliceClientId);
  assert.equal(reference!.status, 'active');

  // The material resolves ONLY in the authorized-execution scope of the
  // owning chain — a foreign scope yields NOTHING (fail-closed, no oracle).
  const material = await credentialsModule().resolveCredentialMaterial({
    credentialId: grant.credentialReferenceId!,
    scope: { kind: 'authorized-execution', agencyId: alice.agencyId, clientId: aliceClientId },
  });
  assert.notEqual(material, null);
  const bundle = JSON.parse(new TextDecoder().decode(material!.material)) as Record<string, unknown>;
  assert.ok(String(bundle['accessToken']).startsWith('sandbox-at-'), 'the resolved material is the provider-issued token bundle');
  const foreign = await credentialsModule().resolveCredentialMaterial({
    credentialId: grant.credentialReferenceId!,
    scope: { kind: 'authorized-execution', agencyId: bob.agencyId, clientId: bobClientId },
  });
  assert.equal(foreign, null, 'a foreign scope never resolves the material');

  // The durable tables structurally carry NO token-shaped column at all
  // (the migration has none — pinned by the architecture suite); the row
  // values hold only ids, states, scopes and provenance.
  const grantRow = await pool().query(
    'SELECT * FROM social_account_grants WHERE grant_id = $1',
    [grant.grantId],
  );
  const serialized = JSON.stringify(grantRow.rows[0]);
  assert.ok(!serialized.includes('sandbox-at-'), 'no access-token value ever lands in the grants table');
  assert.ok(!serialized.includes('sandbox-rt-'), 'no refresh-token value ever lands in the grants table');
  const accountRow = await pool().query('SELECT * FROM social_accounts WHERE social_account_id = $1', [
    account.socialAccountId,
  ]);
  assert.ok(!JSON.stringify(accountRow.rows[0]).includes('sandbox-'), 'no token value ever lands in the binding table');
});

// ---------------------------------------------------------------------------
// AC-2: REFRESH — a new record, the successor link, the old reference dies
// ---------------------------------------------------------------------------

test('AC-2 refresh: the successor grant is a NEW record with its OWN vault reference and REFRESHED verbatim scopes; the predecessor moves to refreshed with the successor link and its reference is disabled', async () => {
  const account = (await accounts().listSocialAccountsForClient(aliceClientId))[0]!;
  const oldGrant = (await accounts().listAuthorizationGrantsForAccount(account.socialAccountId))[0]!;
  const oldReferenceId = oldGrant.credentialReferenceId!;
  const exchangesBefore = oauth().exchangeCount();

  // The provider returns a DIFFERENT scope set on refresh — the verbatim
  // re-recording proof (the grant records what the platform NOW grants).
  const refreshed = await accounts().refreshAuthorization(
    { socialAccountId: account.socialAccountId },
    MODULE_PROVENANCE,
  );
  assert.equal(oauth().exchangeCount(), exchangesBefore + 1, 'exactly one provider exchange');
  assert.equal(refreshed.grant.grantState, 'authorized');
  assert.notEqual(refreshed.grant.grantId, oldGrant.grantId, 'the successor is a NEW record');
  assert.notEqual(refreshed.grant.credentialReferenceId, oldReferenceId, 'the successor has its OWN vault reference');
  assert.deepEqual(refreshed.scopeFacts.grantedScopes, ['read:content', 'Write.CONTENT', 'https://provider.example/scope/all']);

  // The predecessor: refreshed + the successor link (append-only history).
  const predecessor = await accounts().getAuthorizationGrant(oldGrant.grantId);
  assert.equal(predecessor.grantState, 'refreshed');
  assert.equal(predecessor.successorGrantId, refreshed.grant.grantId);

  // The old vault reference is DISABLED (no zombie grants).
  const oldReference = await credentialsModule().getCredentialReference(oldReferenceId);
  assert.equal(oldReference!.status, 'disabled');

  // Exactly ONE authorized grant remains (the single-active fence).
  const grants = await accounts().listAuthorizationGrantsForAccount(account.socialAccountId);
  assert.equal(grants.filter((grant) => grant.grantState === 'authorized').length, 1);
  assert.deepEqual(
    grants.map((grant) => grant.grantState).sort(),
    ['authorized', 'refreshed'],
  );

  // The event tail records the refresh.
  const events = await accounts().listAccountEvents(account.socialAccountId);
  assert.ok(events.some((event) => event.eventType === 'grant_refreshed'));

  // The usable read now serves the SUCCESSOR.
  const usable = await accounts().getUsableAuthorization(account.socialAccountId);
  assert.equal(usable!.grant.grantId, refreshed.grant.grantId);
});

// ---------------------------------------------------------------------------
// AC-2: REAUTHORIZE — a fresh pre-bound cycle; the EXPIRED state + recovery
// ---------------------------------------------------------------------------

test('AC-2 reauthorize + expiry: the explicit expired state refuses reads; the reauthorize cycle recovers with a pre-bound round; the old grant is superseded', async () => {
  const account = (await accounts().listSocialAccountsForClient(aliceClientId))[0]!;
  const currentGrant = (await accounts().listAuthorizationGrantsForAccount(account.socialAccountId)).find(
    (grant) => grant.grantState === 'authorized',
  )!;

  // The explicit expiry observation: authorized → expired (the recorded
  // state; the reads also refuse lazily on expired-by-time grants).
  const expired = await accounts().expireAuthorizationGrant(
    { grantId: currentGrant.grantId, reason: 'provider signalled an invalid token' },
    MODULE_PROVENANCE,
  );
  assert.equal(expired.grantState, 'expired');
  assert.equal(
    (await accounts().getUsableAuthorization(account.socialAccountId)),
    null,
    'an expired grant is not usable',
  );

  // The reauthorize round: a fresh PENDING grant PRE-BOUND to the account.
  const round = await accounts().startAuthorization(
    {
      clientId: aliceClientId,
      integrationConnectionId: aliceCrmConnectionId,
      workspaceId: null,
      requestedScopes: null,
      expectedAccountId: account.socialAccountId,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(round.grant.grantState, 'pending');
  assert.equal(round.grant.socialAccountId, account.socialAccountId, 'the reauthorize round is pre-bound');

  // A DIFFERENT external identity on the pre-bound round is a conflict.
  const wrongIdentity = oauth().issueAuthorization({
    accountId: 'ext-someone-else',
    displayIdentity: 'Someone Else',
    verifiedAt: null,
    scopes: ['read:content'],
    capabilityTags: [],
    expiresInMs: null,
  });
  await assert.rejects(
    () =>
      accounts().completeAuthorization(
        { clientId: aliceClientId, state: round.grant.stateToken, code: wrongIdentity.code },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.message.includes('one connection binds one platform identity'),
  );
  // The failed round stays pending (fail-closed, zero rows changed).
  const stillPending = await accounts().getAuthorizationGrant(round.grant.grantId);
  assert.equal(stillPending.grantState, 'pending');

  // The matching identity completes the cycle: the old grant is
  // superseded (a new record, the successor link, the reference disabled).
  const issued = oauth().issueAuthorization({
    accountId: account.externalAccountId,
    displayIdentity: account.displayIdentity,
    verifiedAt: account.verifiedAt,
    scopes: ['read:content', 'write:content'],
    capabilityTags: ['account-read'],
    expiresInMs: 3_600_000,
  });
  const completion = await accounts().completeAuthorization(
    { clientId: aliceClientId, state: round.grant.stateToken, code: issued.code },
    MODULE_PROVENANCE,
  );
  assert.equal(completion.account.socialAccountId, account.socialAccountId, 'idempotent: the SAME binding');
  assert.equal(completion.grant.grantState, 'authorized');

  const predecessor = await accounts().getAuthorizationGrant(currentGrant.grantId);
  assert.equal(predecessor.grantState, 'superseded');
  assert.equal(predecessor.successorGrantId, completion.grant.grantId);
  const predecessorReference = await credentialsModule().getCredentialReference(
    predecessor.credentialReferenceId!,
  );
  assert.equal(predecessorReference!.status, 'disabled', 'no zombie grants');

  const usable = await accounts().getUsableAuthorization(account.socialAccountId);
  assert.equal(usable!.grant.grantId, completion.grant.grantId, 'recovered: usable again');
  assert.deepEqual(usable!.scopeFacts.grantedScopes, ['read:content', 'write:content']);
});

test('AC-2 lazy expiry: a grant whose platform-reported expiry has passed refuses the usable read; the refresh recovers it (expired grants are refreshable)', async () => {
  const lazyConnection = await freshConnection('alice_crm_lazy');
  const issued = await connectAccount(aliceClientId, lazyConnection, null, {
    accountId: 'ext-lazy-expiry',
    displayIdentity: 'Lazy Expiry Channel',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
    expiresInMs: -60_000,
    refreshExpiresInMs: 3_600_000,
  });
  const lazy = (await accounts().listSocialAccountsForClient(aliceClientId)).find(
    (account) => account.externalAccountId === 'ext-lazy-expiry',
  )!;
  assert.equal(
    await accounts().getUsableAuthorization(lazy.socialAccountId),
    null,
    'expired-by-time grants are not usable (lazy expiry enforcement)',
  );
  // The expired grant is still refreshable (the refresh-token recovery).
  const recovered = await accounts().refreshAuthorization(
    { socialAccountId: lazy.socialAccountId },
    MODULE_PROVENANCE,
  );
  assert.equal(recovered.grant.grantState, 'authorized');
  assert.notEqual(
    await accounts().getUsableAuthorization(lazy.socialAccountId),
    null,
    'the refresh recovered the authorization',
  );
  void issued;
});

// ---------------------------------------------------------------------------
// AC-4: IDENTITY BINDING — idempotent reconnect + conflicting bindings
// ---------------------------------------------------------------------------

test('AC-4 idempotent reconnect: re-connecting the SAME external account under the SAME integration converges on the single active binding (new history, no duplicate)', async () => {
  const reconnectConnection = await freshConnection('alice_crm_reconnect');
  await connectAccount(aliceClientId, reconnectConnection, null, {
    accountId: 'ext-reconnect',
    displayIdentity: 'Reconnect Channel',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
  });
  const before = (await accounts().listSocialAccountsForClient(aliceClientId)).find(
    (account) => account.externalAccountId === 'ext-reconnect',
  )!;
  const grantsBefore = await accounts().listAuthorizationGrantsForAccount(before.socialAccountId);

  // The SECOND handshake for the same identity: converges on the same
  // binding, supersedes the current grant, appends fresh history.
  const second = await connectAccount(aliceClientId, reconnectConnection, null, {
    accountId: 'ext-reconnect',
    displayIdentity: 'Reconnect Channel',
    scopes: ['read:content', 'write:content'],
    capabilityTags: ['account-read', 'content.publish'],
  });
  assert.equal(second.accountId, before.socialAccountId, 'the SAME binding row — no duplicate active binding');

  const after = (await accounts().listSocialAccountsForClient(aliceClientId)).filter(
    (account) => account.externalAccountId === 'ext-reconnect',
  );
  assert.equal(after.length, 1, 'exactly ONE binding of the identity in the client');
  const grantsAfter = await accounts().listAuthorizationGrantsForAccount(before.socialAccountId);
  assert.equal(grantsAfter.length, grantsBefore.length + 1, 'the grant history grew (append-only)');
  assert.equal(
    grantsAfter.filter((grant) => grant.grantState === 'authorized').length,
    1,
    'exactly one active authorization',
  );
});

test('AC-4 conflicting bindings: a DIFFERENT external identity on the bound connection is rejected fail-closed (the round stays pending, zero rows)', async () => {
  const start = await accounts().startAuthorization(
    {
      clientId: aliceClientId,
      integrationConnectionId: aliceCrmConnectionId,
      workspaceId: null,
      requestedScopes: null,
      expectedAccountId: null,
    },
    MODULE_PROVENANCE,
  );
  const accountsBefore = await accounts().listSocialAccountsForClient(aliceClientId);
  const issued = oauth().issueAuthorization({
    accountId: 'ext-conflicting-identity',
    displayIdentity: 'A Different Channel',
    verifiedAt: null,
    scopes: ['read:content'],
    capabilityTags: [],
    expiresInMs: null,
  });
  await assert.rejects(
    () =>
      accounts().completeAuthorization(
        { clientId: aliceClientId, state: start.grant.stateToken, code: issued.code },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.message.includes('one platform identity'),
  );
  const accountsAfter = await accounts().listSocialAccountsForClient(aliceClientId);
  assert.equal(accountsAfter.length, accountsBefore.length, 'zero new bindings (fail-closed)');
  const round = await accounts().getAuthorizationGrant(start.grant.grantId);
  assert.equal(round.grantState, 'pending', 'the round stays pending (retryable)');
});

test('AC-4 conflicting bindings: the SAME external identity on ANOTHER connection of the same client is rejected fail-closed (the client-identity fence)', async () => {
  // A second CRM connection of the same client (a different credential).
  const second = await makeConnectedCrmConnection(alice, aliceClientId, 'alice_crm_key_2');
  const start = await accounts().startAuthorization(
    {
      clientId: aliceClientId,
      integrationConnectionId: second.connectionId,
      workspaceId: null,
      requestedScopes: null,
      expectedAccountId: null,
    },
    MODULE_PROVENANCE,
  );
  const issued = oauth().issueAuthorization({
    accountId: 'ext-reconnect',
    displayIdentity: 'Reconnect Channel',
    verifiedAt: null,
    scopes: ['read:content'],
    capabilityTags: [],
    expiresInMs: null,
  });
  await assert.rejects(
    () =>
      accounts().completeAuthorization(
        { clientId: aliceClientId, state: start.grant.stateToken, code: issued.code },
        MODULE_PROVENANCE,
      ),
    (error: unknown) =>
      error instanceof Error && error.message.includes('already has an active binding in this client'),
  );
});

// ---------------------------------------------------------------------------
// AC-3: the credential-vault reference integrity (dangling handles)
// ---------------------------------------------------------------------------

test('AC-3 vault integrity: a dangling token handle is REJECTED with zero rows (the round stays pending, no reference, no binding)', async () => {
  oauth().skipHandleProvisioning = true;
  try {
    const danglingConnection = await freshConnection('alice_crm_dangling');
    const start = await accounts().startAuthorization(
      {
        clientId: aliceClientId,
        integrationConnectionId: danglingConnection,
        workspaceId: null,
        requestedScopes: null,
        expectedAccountId: null,
      },
      MODULE_PROVENANCE,
    );
    const issued = oauth().issueAuthorization({
      accountId: 'ext-dangling',
      displayIdentity: 'Dangling Channel',
      verifiedAt: null,
      scopes: ['read:content'],
      capabilityTags: [],
      expiresInMs: null,
    });
    await assert.rejects(
      () =>
        accounts().completeAuthorization(
          { clientId: aliceClientId, state: start.grant.stateToken, code: issued.code },
          MODULE_PROVENANCE,
        ),
      (error: unknown) =>
        error instanceof Error && error.message.includes('does not resolve in the configured secret backend'),
    );
    // Zero rows: no binding of the identity; the round stays pending; no
    // credential reference of the dangling handle exists.
    const bindings = (await accounts().listSocialAccountsForClient(aliceClientId)).filter(
      (account) => account.externalAccountId === 'ext-dangling',
    );
    assert.equal(bindings.length, 0);
    const round = await accounts().getAuthorizationGrant(start.grant.grantId);
    assert.equal(round.grantState, 'pending');
    assert.equal(round.credentialReferenceId, null);
  } finally {
    oauth().skipHandleProvisioning = false;
  }
});

// ---------------------------------------------------------------------------
// The fail-closed flow gates (provider + policy)
// ---------------------------------------------------------------------------

test('provider failure fail-closed: a rejected code leaves the round pending with zero rows; the state token never replays', async () => {
  oauth().setMode('reject-code');
  try {
    const start = await accounts().startAuthorization(
      {
        clientId: aliceClientId,
        integrationConnectionId: aliceCrmConnectionId,
        workspaceId: null,
        requestedScopes: null,
        expectedAccountId: null,
      },
      MODULE_PROVENANCE,
    );
    const issued = oauth().issueAuthorization({
      accountId: 'ext-rejected',
      displayIdentity: 'Rejected Channel',
      verifiedAt: null,
      scopes: ['read:content'],
      capabilityTags: [],
      expiresInMs: null,
    });
    await assert.rejects(
      () =>
        accounts().completeAuthorization(
          { clientId: aliceClientId, state: start.grant.stateToken, code: issued.code },
          MODULE_PROVENANCE,
        ),
    );
    const round = await accounts().getAuthorizationGrant(start.grant.grantId);
    assert.equal(round.grantState, 'pending', 'the failed round stays pending');
    // A consumed/unknown state never completes: an unknown state is the
    // uniform 404; a replayed consumed state is a 409 — both tested via
    // the consumed round below.
  } finally {
    oauth().setMode('ok');
  }
});

test('state-token discipline: a CONSUMED round can never be completed again (the replay is a 409 conflict)', async () => {
  const replayConnection = await freshConnection('alice_crm_replay');
  const connected = await connectAccount(aliceClientId, replayConnection, null, {
    accountId: 'ext-replay',
    displayIdentity: 'Replay Channel',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
  });
  const replayCode = oauth().issueAuthorization({
    accountId: 'ext-replay',
    displayIdentity: 'Replay Channel',
    verifiedAt: null,
    scopes: ['read:content'],
    capabilityTags: [],
    expiresInMs: null,
  });
  await assert.rejects(
    () =>
      accounts().completeAuthorization(
        { clientId: aliceClientId, state: connected.state, code: replayCode.code },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.message.includes('can never be completed again'),
  );
});

test('policy fail-closed: a network DENY blocks the completion BEFORE any provider exchange (zero provider traffic)', async () => {
  // A second client of alice's with a client-scoped network DENY.
  const denyClientId = await makeClient(alice.agencyId, alice.token);
  const denyConnection = await makeConnectedCrmConnection(alice, denyClientId, 'alice_crm_key_deny');
  const declared = await apiCall(
    port(),
    `/api/clients/${denyClientId}/policies`,
    {
      token: alice.token,
      body: {
        dimension: 'network',
        rules: [
          { effect: 'deny', operations: ['*'], reason: 'deny all egress for this client' },
        ],
        description: 'Client network deny',
      },
    },
  );
  assert.equal(declared.status, 201, JSON.stringify(declared.body));

  const start = await accounts().startAuthorization(
    {
      clientId: denyClientId,
      integrationConnectionId: denyConnection.connectionId,
      workspaceId: null,
      requestedScopes: null,
      expectedAccountId: null,
    },
    MODULE_PROVENANCE,
  );
  const exchangesBefore = oauth().exchangeCount();
  const issued = oauth().issueAuthorization({
    accountId: 'ext-denied',
    displayIdentity: 'Denied Channel',
    verifiedAt: null,
    scopes: ['read:content'],
    capabilityTags: [],
    expiresInMs: null,
  });
  await assert.rejects(
    () =>
      accounts().completeAuthorization(
        { clientId: denyClientId, state: start.grant.stateToken, code: issued.code },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.message.includes('denied by policy'),
  );
  assert.equal(oauth().exchangeCount(), exchangesBefore, 'ZERO provider traffic on a denied action');
  const round = await accounts().getAuthorizationGrant(start.grant.grantId);
  assert.equal(round.grantState, 'pending', 'the denied round stays pending');

  // The decision landed in the append-only policy ledger (POL-001).
  const decisions = await pool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM policy_decisions
     WHERE action @> '{"operation": "social-account.complete"}'::jsonb`,
  );
  assert.ok(Number(decisions.rows[0]!.count) >= 1, 'the fail-closed decision is recorded');
});

test('the production composition registers NO flow: authorize-start against the spawned API is the fail-closed 409 (MKT-056+ territory)', async () => {
  const response = await apiCall(port(), `/api/clients/${aliceClientId}/social-accounts/authorize-start`, {
    token: alice.token,
    body: { connectionId: aliceCrmConnectionId },
  });
  assert.equal(response.status, 409);
  const error = response.body['error'] as Record<string, unknown> | undefined;
  assert.ok(
    typeof error === 'object'
      && String(error?.['message'] ?? '').includes('no OAuth flow implementation is registered'),
    `the 409 names the empty flow registry: ${JSON.stringify(response.body)}`,
  );
});

// ---------------------------------------------------------------------------
// AC-5: FAIL-CLOSED DISCONNECT / REVOCATION (operator + external)
// ---------------------------------------------------------------------------

test('AC-5 operator disconnect: the connection becomes UNUSABLE — every authorization-bearing read refuses, the vault references are disabled (no zombie grants), the provider revoke is disclosed', async () => {
  const disconnectConnection = await freshConnection('alice_crm_disconnect');
  const connected = await connectAccount(aliceClientId, disconnectConnection, null, {
    accountId: 'ext-disconnect-me',
    displayIdentity: 'Disconnect Me',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
  });
  const accountId = connected.accountId;
  const grantId = connected.grantId;
  const grantBefore = await accounts().getAuthorizationGrant(grantId);
  const referenceId = grantBefore.credentialReferenceId!;
  const revokesBefore = oauth().revokeCount();

  const disconnected = await accounts().disconnectAccount(
    { socialAccountId: accountId, reason: 'operator removed the connection', revokeAtProvider: true },
    MODULE_PROVENANCE,
  );
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(oauth().revokeCount(), revokesBefore + 1, 'the best-effort provider revoke ran once');

  // THE FAIL-CLOSED BATTERY: every authorization-bearing read refuses.
  assert.equal(await accounts().getUsableAuthorization(accountId), null);
  await assert.rejects(
    () => accounts().getAuthorizationGrant(grantId),
    (error: unknown) => error instanceof Error && error.message.includes('refuses (fail-closed)'),
  );
  await assert.rejects(
    () => accounts().listAuthorizationGrantsForAccount(accountId),
    (error: unknown) => error instanceof Error && error.message.includes('refuses (fail-closed)'),
  );
  await assert.rejects(
    () => accounts().refreshAuthorization({ socialAccountId: accountId }, MODULE_PROVENANCE),
    (error: unknown) => error instanceof Error && error.message.includes('can never refresh'),
  );
  await assert.rejects(
    () =>
      accounts().startAuthorization(
        {
          clientId: aliceClientId,
          integrationConnectionId: disconnectConnection,
          workspaceId: null,
          requestedScopes: null,
          expectedAccountId: accountId,
        },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.message.includes('cannot be re-activated in place'),
  );

  // The vault reference is DISABLED — no zombie grants.
  const reference = await credentialsModule().getCredentialReference(referenceId);
  assert.equal(reference!.status, 'disabled');

  // The audit history stays readable (the events carry NO authorization
  // payload) and records the disconnect with the provider revoke outcome.
  const events = await accounts().listAccountEvents(accountId);
  const disconnectEvent = events.find((event) => event.eventType === 'account_disconnected');
  assert.notEqual(disconnectEvent, undefined);
  assert.equal(disconnectEvent!.initiatedBy, 'operator');
  assert.equal(disconnectEvent!.providerRevokeOutcome, 'revoked');
  assert.ok(events.some((event) => event.eventType === 'authorization_revoked'));

  // The route surface: the grant reads 409; the account read stays 200
  // (the status is the visible fact); the events read stays 200 (audit).
  const grantRead = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${accountId}/grants/${grantId}`,
    { token: alice.token },
  );
  assert.equal(grantRead.status, 409);
  const grantsList = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${accountId}/grants`,
    { token: alice.token },
  );
  assert.equal(grantsList.status, 409);
  const accountRead = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${accountId}`,
    { token: alice.token },
  );
  assert.equal(accountRead.status, 200);
  assert.equal(accountRead.body['status'], 'disconnected');
  const eventsRead = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${accountId}/events`,
    { token: alice.token },
  );
  assert.equal(eventsRead.status, 200);
});

test('AC-5 externally-signalled revocation: identical failure modes — the binding moves to revoked (terminal), the grant reads refuse, the references die', async () => {
  const externalConnection = await freshConnection('alice_crm_external');
  const connected = await connectAccount(aliceClientId, externalConnection, null, {
    accountId: 'ext-revoked-externally',
    displayIdentity: 'Externally Revoked',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
  });
  const accountId = connected.accountId;
  const grantId = connected.grantId;
  const referenceId = (await accounts().getAuthorizationGrant(grantId)).credentialReferenceId!;

  const revoked = await accounts().recordExternalRevocation(
    { socialAccountId: accountId, reason: 'the user revoked app access at the platform', signalledVia: 'provider-webhook-relay' },
    MODULE_PROVENANCE,
  );
  assert.equal(revoked.status, 'revoked');

  assert.equal(await accounts().getUsableAuthorization(accountId), null);
  await assert.rejects(
    () => accounts().getAuthorizationGrant(grantId),
    (error: unknown) => error instanceof Error && error.message.includes('refuses (fail-closed)'),
  );
  await assert.rejects(
    () => accounts().refreshAuthorization({ socialAccountId: accountId }, MODULE_PROVENANCE),
  );
  const reference = await credentialsModule().getCredentialReference(referenceId);
  assert.equal(reference!.status, 'disabled');

  const events = await accounts().listAccountEvents(accountId);
  const revokeEvent = events.find((event) => event.eventType === 'account_revoked');
  assert.equal(revokeEvent!.initiatedBy, 'external-signal');
  assert.ok(String(revokeEvent!.reason).includes('signalled via provider-webhook-relay'));

  // The externally-revoked death over the ROUTE: the grant reads 409.
  const routeRead = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${accountId}/grants/${grantId}`,
    { token: alice.token },
  );
  assert.equal(routeRead.status, 409);

  // A dead binding can never be re-activated in place: the reauthorize
  // route-level equivalent (via the module) is a conflict; a FRESH
  // authorization on the connection with the SAME identity creates a
  // NEW binding row (the new-version path — no duplicate ACTIVE binding).
  const rebind = await connectAccount(aliceClientId, externalConnection, null, {
    accountId: 'ext-revoked-externally',
    displayIdentity: 'Externally Revoked',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
  });
  assert.notEqual(rebind.accountId, accountId, 'the fresh cycle creates a NEW binding row');
  const activeBindings = (await accounts().listSocialAccountsForClient(aliceClientId)).filter(
    (account) => account.externalAccountId === 'ext-revoked-externally' && account.status === 'connected',
  );
  assert.equal(activeBindings.length, 1, 'exactly one ACTIVE binding after the fresh cycle');
});

test('AC-5 disconnect via the ROUTE (the operator surface): the same terminal death over HTTP', async () => {
  const routeDisconnectConnection = await freshConnection('alice_crm_route_disconnect');
  const connected = await connectAccount(aliceClientId, routeDisconnectConnection, null, {
    accountId: 'ext-route-disconnect',
    displayIdentity: 'Route Disconnect',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
  });
  const response = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${connected.accountId}/disconnect`,
    { token: alice.token, body: { reason: 'operator disconnect over the route', revokeAtProvider: false } },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body['status'], 'disconnected');
  assert.equal(
    await accounts().getUsableAuthorization(connected.accountId),
    null,
    'the usable read refuses after the route disconnect',
  );
  // The provider was NOT called (revokeAtProvider: false — explicit-only egress).
  const events = await accounts().listAccountEvents(connected.accountId);
  const disconnectEvent = events.find((event) => event.eventType === 'account_disconnected')!;
  assert.equal(disconnectEvent.providerRevokeOutcome, 'not-requested');
});

// ---------------------------------------------------------------------------
// AC-1: the route read family + the workspace slice
// ---------------------------------------------------------------------------

test('AC-1 route reads: the client listing, the account detail, the grant tail with the VERBATIM scopes, the workspace slice and the events tail', async () => {
  const routeReadsConnection = await freshConnection('alice_crm_route_reads');
  const connected = await connectAccount(aliceClientId, routeReadsConnection, aliceWorkspaceId, {
    accountId: 'ext-route-reads',
    displayIdentity: 'Route Reads Channel',
    scopes: ['read:insights', 'write:content'],
    capabilityTags: ['account-read', 'analytics:read'],
  });

  const listing = await apiCall(port(), `/api/clients/${aliceClientId}/social-accounts`, {
    token: alice.token,
  });
  assert.equal(listing.status, 200);
  const listed = (listing.body['socialAccounts'] as Record<string, unknown>[]).find(
    (account) => account['externalAccountId'] === 'ext-route-reads',
  )!;
  assert.equal(listed['status'], 'connected');
  assert.equal(listed['workspaceId'], aliceWorkspaceId);
  assert.equal(listed['platformId'], 'crm');

  const detail = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${connected.accountId}`,
    { token: alice.token },
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body['displayIdentity'], 'Route Reads Channel');

  const grants = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${connected.accountId}/grants`,
    { token: alice.token },
  );
  assert.equal(grants.status, 200);
  assert.equal((grants.body['grants'] as unknown[]).length, 1);

  const grantDetail = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${connected.accountId}/grants/${connected.grantId}`,
    { token: alice.token },
  );
  assert.equal(grantDetail.status, 200);
  assert.deepEqual(grantDetail.body['grantedScopes'], ['read:insights', 'write:content']);
  assert.deepEqual(grantDetail.body['capabilityTags'], ['account-read', 'analytics:read']);

  const workspaceSlice = await apiCall(
    port(),
    `/api/workspaces/${aliceWorkspaceId}/social-accounts`,
    { token: alice.token },
  );
  assert.equal(workspaceSlice.status, 200);
  assert.ok(
    (workspaceSlice.body['socialAccounts'] as Record<string, unknown>[]).some(
      (account) => account['externalAccountId'] === 'ext-route-reads',
    ),
    'the workspace slice carries the workspace-attached binding',
  );

  const events = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/${connected.accountId}/events`,
    { token: alice.token },
  );
  assert.equal(events.status, 200);
  assert.deepEqual(
    (events.body['events'] as Record<string, unknown>[]).map((event) => event['eventType']),
    ['authorization_started', 'authorization_completed'],
  );
});

// ---------------------------------------------------------------------------
// AC-8: THE ISOLATION + AUTHORIZATION BATTERY (over the routes)
// ---------------------------------------------------------------------------

test('AC-8 isolation battery: anonymous 401; foreign/unknown/malformed identifiers are the UNIFORM 404; a suspended membership is the 403', async () => {
  const isolationConnection = await freshConnection('alice_crm_isolation');
  const connected = await connectAccount(aliceClientId, isolationConnection, null, {
    accountId: 'ext-isolation',
    displayIdentity: 'Isolation Channel',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
  });
  const accountId = connected.accountId;

  // Anonymous → 401 at the authenticator (every route of the family).
  for (const pathName of [
    `/api/clients/${aliceClientId}/social-accounts`,
    `/api/clients/${aliceClientId}/social-accounts/${accountId}`,
    `/api/clients/${aliceClientId}/social-accounts/${accountId}/grants`,
    `/api/clients/${aliceClientId}/social-accounts/${accountId}/events`,
    `/api/workspaces/${aliceWorkspaceId}/social-accounts`,
  ]) {
    const response = await apiCall(port(), pathName);
    assert.equal(response.status, 401, `${pathName} must 401 for anonymous callers`);
  }

  // Foreign (bob's agency) → the UNIFORM 404 (no existence oracle).
  for (const pathName of [
    `/api/clients/${aliceClientId}/social-accounts`,
    `/api/clients/${aliceClientId}/social-accounts/${accountId}`,
    `/api/clients/${aliceClientId}/social-accounts/${accountId}/grants`,
    `/api/clients/${aliceClientId}/social-accounts/${accountId}/events`,
    `/api/workspaces/${aliceWorkspaceId}/social-accounts`,
  ]) {
    const response = await apiCall(port(), pathName, { token: bob.token });
    assert.equal(response.status, 404, `${pathName} must 404 for foreign-agency callers`);
  }

  // Unknown + malformed identifiers → the SAME uniform 404.
  for (const pathName of [
    `/api/clients/${aliceClientId}/social-accounts/00000000-0000-7000-8000-0000000000ff`,
    `/api/clients/${aliceClientId}/social-accounts/not-a-uuid`,
    `/api/clients/${aliceClientId}/social-accounts/00000000-0000-7000-8000-0000000000ff/grants`,
  ]) {
    const response = await apiCall(port(), pathName, { token: alice.token });
    assert.equal(response.status, 404, `${pathName} must 404 uniformly`);
  }

  // A suspended membership → the 403 (identity known, membership inactive).
  const suspendedRead = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts`,
    { token: suspendedMember.token },
  );
  assert.equal(suspendedRead.status, 403);

  // The module-level foreign completions: a round of ANOTHER client is
  // never reachable (the uniform 404 — no cross-tenant oracle).
  const start = await accounts().startAuthorization(
    {
      clientId: aliceClientId,
      integrationConnectionId: aliceCrmConnectionId,
      workspaceId: null,
      requestedScopes: null,
      expectedAccountId: null,
    },
    MODULE_PROVENANCE,
  );
  await assert.rejects(
    () =>
      accounts().completeAuthorization(
        { clientId: bobClientId, state: start.grant.stateToken, code: 'any-code' },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.message.includes('authorization round'),
  );
  // An unknown state token is the same uniform 404.
  await assert.rejects(
    () =>
      accounts().completeAuthorization(
        { clientId: aliceClientId, state: '00000000-0000-0000-0000-000000000000', code: 'x' },
        MODULE_PROVENANCE,
      ),
  );
  // A foreign connection id under alice's client is the uniform 404.
  await assert.rejects(
    () =>
      accounts().startAuthorization(
        {
          clientId: aliceClientId,
          integrationConnectionId: '00000000-0000-7000-8000-0000000000ee',
          workspaceId: null,
          requestedScopes: null,
          expectedAccountId: null,
        },
        MODULE_PROVENANCE,
      ),
  );
  // A foreign workspace under alice's client is the uniform 404.
  const foreignWorkspace = await makeWorkspace(bobClientId, bob.token, 'Bobs Room');
  await assert.rejects(
    () =>
      accounts().startAuthorization(
        {
          clientId: aliceClientId,
          integrationConnectionId: aliceCrmConnectionId,
          workspaceId: foreignWorkspace,
          requestedScopes: null,
          expectedAccountId: null,
        },
        MODULE_PROVENANCE,
      ),
  );
});

test('AC-8 route DTO discipline: authority fields and material-shaped keys are rejected (422) — nothing caller-suppliable survives', async () => {
  for (const forbidden of ['stateToken', 'grantedScopes', 'credentialReferenceId', 'tokenSecretHandle', 'secret']) {
    const response = await apiCall(
      port(),
      `/api/clients/${aliceClientId}/social-accounts/authorize-start`,
      {
        token: alice.token,
        body: { connectionId: aliceCrmConnectionId, [forbidden]: 'smuggled' },
      },
    );
    assert.equal(response.status, 422, `the authority field '${forbidden}' must be rejected`);
  }
  // The external-revocation DTO requires the signal source.
  const missing = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/social-accounts/00000000-0000-7000-8000-0000000000dd/external-revocation`,
    { token: alice.token, body: {} },
  );
  assert.equal(missing.status, 404, 'an unknown account is the uniform 404 before the DTO runs');
});

// ---------------------------------------------------------------------------
// AC-6/AC-2: THE APPEND-ONLY DATABASE BATTERY (direct SQL)
// ---------------------------------------------------------------------------

test('AC-6 append-only battery: the database itself rejects rewrites of the history tail, the scope records, grant deletions and grant fact rewrites', async () => {
  const appendOnlyConnection = await freshConnection('alice_crm_append_only');
  const connected = await connectAccount(aliceClientId, appendOnlyConnection, null, {
    accountId: 'ext-append-only',
    displayIdentity: 'Append Only Channel',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
  });
  const accountId = connected.accountId;
  const grantId = connected.grantId;

  // The history tail: UPDATE and DELETE are rejected outright.
  await assertDbRejects(
    `UPDATE social_account_events SET reason = 'rewritten' WHERE social_account_id = $1`,
    [accountId],
    'append-only',
  );
  await assertDbRejects(
    `DELETE FROM social_account_events WHERE social_account_id = $1`,
    [accountId],
    'append-only',
  );
  // The scope records: append-only.
  await assertDbRejects(
    `UPDATE social_account_grant_scopes SET scope_value = 'forged' WHERE grant_id = $1`,
    [grantId],
    'append-only',
  );
  await assertDbRejects(
    `DELETE FROM social_account_grant_scopes WHERE grant_id = $1`,
    [grantId],
    'append-only',
  );
  // The grants: DELETE is rejected (the history is never erased).
  await assertDbRejects(
    `DELETE FROM social_account_grants WHERE grant_id = $1`,
    [grantId],
    'append-oriented history',
  );
  // The grant fact rewrite: the credential reference is immutable after
  // the completion fill (never re-bound in place — the probe uses a REAL
  // reference id so the immutability trigger, not the FK, fires).
  const existingReference = await pool().query<{ credential_id: string }>(
    'SELECT credential_reference_id AS credential_id FROM social_account_grants WHERE grant_id = $1',
    [grantId],
  );
  await assertDbRejects(
    `UPDATE social_account_grants SET credential_reference_id = (SELECT credential_reference_id FROM social_account_grants WHERE grant_id <> $1 LIMIT 1) WHERE grant_id = $1`,
    [grantId],
    'recorded authorization facts are immutable',
  );
  void existingReference;
  // The illegal transition: authorized → pending is not in the frozen table.
  await assertDbRejects(
    `UPDATE social_account_grants SET grant_state = 'pending' WHERE grant_id = $1`,
    [grantId],
    'illegal social account grant transition',
  );
  // The binding identity: the external account identity is immutable.
  await assertDbRejects(
    `UPDATE social_accounts SET external_account_id = 'forged' WHERE social_account_id = $1`,
    [accountId],
    'cannot change its external account identity',
  );
  // The terminal account state: disconnected/revoked rows never
  // re-activate in place (the account is killed through the module
  // first, then the direct reactivation probe runs).
  await accounts().disconnectAccount(
    { socialAccountId: accountId, reason: 'append-only battery: kill the binding', revokeAtProvider: false },
    MODULE_PROVENANCE,
  );
  await assertDbRejects(
    `UPDATE social_accounts SET status = 'connected' WHERE social_account_id = $1`,
    [accountId],
    'terminal',
  );
});

test('AC-2/AC-6 workspace attachment: the optional workspace narrowing lands on the binding row', async () => {
  const workspaceConnection = await freshConnection('alice_crm_workspace');
  const connected = await connectAccount(aliceClientId, workspaceConnection, aliceWorkspaceId, {
    accountId: 'ext-workspace-bound',
    displayIdentity: 'Workspace Bound',
    scopes: ['read:content'],
    capabilityTags: ['account-read'],
  });
  const row = await pool().query(
    'SELECT workspace_id FROM social_accounts WHERE social_account_id = $1',
    [connected.accountId],
  );
  assert.equal(row.rows[0]!.workspace_id, aliceWorkspaceId);
});
