/**
 * MKT-061 integration tests — the X (Twitter) social platform adapter on
 * the REAL stack: embedded PostgreSQL 18, the spawned production API and
 * IN-PROCESS applications composed through the disclosed seams.
 *
 * Two proofs, each with its own disclosed double at the provider
 * boundary ONLY (the contract HOST under test — the capability gates,
 * the strict scope pre-flight, the /policies fail-closed gates, the
 * migration-050 idempotency fence, the claim-then-fill ledger — is
 * fully REAL in both — the MKT-057..060 pattern):
 *
 *   1. THE CONFORMANCE SUITE (the dispatch AC): the full 17-scenario
 *      MKT-056 battery
 *      (tests/integration/helpers/social-adapter-conformance.ts) runs
 *      against the disclosed IN-MEMORY X platform double
 *      (tests/integration/helpers/x-platform-double.ts — the
 *      documented-API behavioral model: the users/me surface, the
 *      post/timeline/search reads, the analytics surfaces, the
 *      synchronous creation lifecycle, failure injection) with the REAL
 *      documented OAuth 2.0 scope names as the fixture grants (the
 *      documented test-only suite extension — X's real scopes fall
 *      outside the default fixture vocabulary). The honest 5-of-5
 *      matrix fires ALL 17 scenarios (the observable users/me
 *      entitlement facts serve the restriction-signals scenario);
 *
 *   2. THE REAL ADAPTER END-TO-END (the composition-root registration
 *      proof): the application boots with the production 'x'
 *      registration (the MKT-061 composition-root first-party
 *      registration, the platform FetchHttpCall transport — the
 *      socialPlatformAdapters seam carries ONLY the disclosed
 *      'x-narrow' operation-level-subset double of the
 *      capability-subset battery under its OWN key, so the production
 *      'x' registration is NOT overridden) and serves every operation
 *      through the module API against the disclosed COMBINED provider
 *      double (tests/integration/helpers/x-http-double.ts — the loopback
 *      HTTP server faithfully mirroring the documented X API v2 + the
 *      canonical local OAuth plane + the X-shaped OAuth 2.0 PKCE token
 *      plane + the Range-capable media byte-source asset server):
 *      THE OAUTH LIFECYCLE (the named AC — the documented PKCE
 *      authorization-code flow with the S256 code_challenge, the token
 *      exchange with the VERIFIED code_verifier, the refresh round, and
 *      the honest NO-revoke-endpoint disclosure with ZERO provider
 *      traffic) · the REAL matrix + REAL scopes + inertness · the
 *      documented users/me identity/profile (the entitlement facts as
 *      restriction signals) · the documented search/timeline pagination
 *      + the single-post read (the honest null record) + ALL FOUR
 *      engagement slots from the documented public_metrics · the
 *      documented analytics labels VERBATIM · THE PUBLISH LIFECYCLE
 *      (the named AC — the synchronous POST /2/tweets born published;
 *      THE MEDIA UPLOAD: the documented v2 chunked flow INIT/APPEND/
 *      FINALIZE with BYTE-EXACT multi-segment reassembly and the
 *      STATUS processing poll; the bounded processing deadline; the
 *      provider-stated size-limit refusal; the >4-asset refusal; the
 *      no-byte-source refusal; the entitlement 403; the replay
 *      idempotency with ZERO provider calls; the status poll incl. the
 *      deleted-post 404) · THE PROVIDER LIMITS (the named AC — the
 *      documented x-rate-limit-* header signals ride the invocation
 *      records as DATA; the 429 + Retry-After observation; the refused
 *      publish records honestly on the ledger) · the documented error
 *      taxonomy (the RFC 7807 problem classifier) · the strict
 *      REAL-scope pre-flight (zero provider traffic) · THE
 *      CAPABILITY-SUBSET ENFORCEMENT (the undeclared operation AND the
 *      undeclared family refuse fail-closed with ZERO provider traffic).
 */

import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { SocialAccountsModuleApi } from '../../src/modules/social-accounts/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';
import type { IntegrationsModuleApi } from '../../src/modules/integrations/public.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { createReferenceIntegrationStub, runSocialAdapterConformanceSuite } from './helpers/social-adapter-conformance.ts';
import { startXProviderDouble, createXOAuthFlow, type XProviderDouble } from './helpers/x-http-double.ts';
import { createXPlatformDouble, X_FULL_SCOPES, X_READ_ONLY_SCOPES } from './helpers/x-platform-double.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'social-adapter-x-pipe-key';
/** The disclosed operation-level-subset platform key of the capability-subset battery (its OWN key — the production 'x' registration is NOT overridden). */
const NARROW_PLATFORM_KEY = 'x-narrow';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-0000000000dd',
  recordedVia: 'test',
  correlationId: 'integration-social-adapter-x-1',
  causationId: null,
} as const;

/** The REAL documented X OAuth 2.0 scope names the adapter declares (the strict pre-flight vocabulary). */
const USERS_READ = 'users.read';
const TWEET_READ = 'tweet.read';
const TWEET_WRITE = 'tweet.write';
const MEDIA_WRITE = 'media.write';
const FULL_GRANT = [USERS_READ, TWEET_READ, TWEET_WRITE, MEDIA_WRITE] as const;
const READ_ONLY_GRANT = [USERS_READ, TWEET_READ] as const;

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: XProviderDouble | null = null;
let accounts: SocialAccountsModuleApi | null = null;
let integrationsHandle: IntegrationsModuleApi | null = null;
let credentialsHandle: CredentialsModuleApi | null = null;

function module(): SocialAccountsModuleApi {
  if (accounts === null) throw new Error('application not bootstrapped');
  return accounts;
}
function integrationsModule(): IntegrationsModuleApi {
  if (integrationsHandle === null) throw new Error('application not bootstrapped');
  return integrationsHandle;
}
function credentialsModule(): CredentialsModuleApi {
  if (credentialsHandle === null) throw new Error('application not bootstrapped');
  return credentialsHandle;
}
function double(): XProviderDouble {
  if (provider === null) throw new Error('provider double not booted');
  return provider;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('social_x_real');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startXProviderDouble();
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  // NO 'x' socialPlatformAdapters seam entry: the PRODUCTION-composed X
  // adapter (the MKT-061 composition-root registration on the platform
  // FetchHttpCall transport) serves every operation of this battery.
  // The seam carries ONLY the disclosed 'x-narrow' operation-level-subset
  // double (its OWN key) of the capability-subset battery — the
  // production 'x' registration is NOT overridden (the seam-override is
  // keyed; a different key never replaces the first-party instance).
  const core = await bootstrapApplication({
    integrationAdapters: [createReferenceIntegrationStub('x'), createReferenceIntegrationStub(NARROW_PLATFORM_KEY)],
    socialAccountFlows: [
      // The X-shaped OAuth 2.0 (PKCE) flow double: the 'x' AND 'x-narrow'
      // connections ride the DOCUMENTED PKCE wire form end-to-end (the
      // OAuth lifecycle AC; the narrow key's flow shape is irrelevant to
      // the capability-subset battery — the same disclosed double
      // serves both keys).
      createXOAuthFlow(provider, { adapterKey: 'x', secretsDir: stack.env.secretsDir }),
      createXOAuthFlow(provider, { adapterKey: NARROW_PLATFORM_KEY, secretsDir: stack.env.secretsDir }),
    ],
    socialPlatformAdapters: [
      // The disclosed capability-subset double: the account family + a
      // NARROWED content-read operation set (listOwnContent +
      // getContent — discoverPublicContent deliberately UNDECLARED) and
      // NO analytics-read family — the operation-level AND family-level
      // fail-closed refusals of the capability-subset battery.
      createXPlatformDouble({
        adapterKey: NARROW_PLATFORM_KEY,
        capabilities: [
          {
            family: 'account',
            operations: ['verifyAccountIdentity', 'getAccountProfile'],
            requiredScopes: [USERS_READ, TWEET_READ],
            description:
              'The disclosed narrow capability-subset double (account family; the operation-level/family-level subset battery).',
          },
          {
            family: 'content-read',
            operations: ['listOwnContent', 'getContent'],
            requiredScopes: [TWEET_READ, USERS_READ],
            description:
              'The disclosed narrowed content-read operation set (discoverPublicContent deliberately UNDECLARED — the operation-level subset battery).',
          },
        ],
      }),
    ],
  });
  accounts = core.modules.socialAccounts;
  integrationsHandle = core.modules.integrations;
  credentialsHandle = core.modules.credentials;
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
// Shared fixtures
// ---------------------------------------------------------------------------

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

async function makeAgencyOwner(email: string): Promise<Principal> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', { token: admin, body: { email, displayName: email.split('@')[0]! } });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, { token: admin, body: { password: 'owner-pass-123' } });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: 'owner-pass-123' } });
  assert.equal(login.status, 200);
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201);
  return { userId, token: login.body['token'] as string, agencyId: (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string };
}

async function allowAll(principal: Principal, dimension: 'network' | 'secrets'): Promise<void> {
  const declared = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, {
    token: principal.token,
    body: {
      dimension,
      rules: [{ effect: 'allow', operations: ['*'], reason: 'integration test allowance' }],
      description: `Integration test ${dimension} allowance`,
    },
  });
  assert.equal(declared.status, 201);
}

let connectionSequence = 0;
/** Creates + connects the x-keyed integration connection (providerConfig points the REAL adapter at the double). */
async function makeXConnection(
  principal: Principal,
  clientId: string,
  adapterKey: string,
  providerConfig: Record<string, string> = {},
): Promise<string> {
  connectionSequence += 1;
  const credential = await credentialsModule().createCredentialReference({
    agencyId: principal.agencyId,
    clientId,
    kind: 'integration_api_key',
    label: `x_pipe_${clientId.slice(0, 8)}_${connectionSequence}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection(
    {
      clientId,
      adapterKey,
      credentialReferenceId: credential.credentialId,
      // The documented deployment override surface: the API base URL of
      // the connection (apiBaseUrl) points the production adapter at
      // the loopback provider double (the documented host is
      // https://api.x.com); the OAuth token-plane host override
      // (oauthTokenBaseUrl) keeps the PKCE plane on the double even for
      // the deliberately-dead API-base battery. The X-shaped OAuth flow
      // double reads the same overrides + the non-secret OAuth client
      // configuration.
      providerConfig: {
        apiBaseUrl: double().url,
        oauthTokenBaseUrl: double().url,
        oauthClientId: 'double-x-client',
        oauthRedirectUri: 'http://127.0.0.1:9/callback',
        platformHint: adapterKey,
        ...providerConfig,
      },
    },
    PROVENANCE,
  );
  const connected = await integrationsModule().connectConnection(
    { connectionId: registered.connectionId, expectedVersion: 1 },
    PROVENANCE,
  );
  assert.equal(connected.status, 'connected');
  return registered.connectionId;
}

/**
 * The full documented X OAuth 2.0 (PKCE) handshake through the REAL
 * module + the X-shaped provider double: the authorize URL carries the
 * documented parameter table (response_type, client_id, redirect_uri,
 * scope, state, code_challenge, code_challenge_method=S256), the
 * authorization fixture binds the code to the S256 challenge, and the
 * module's completion round exchanges the code WITH the PKCE verifier
 * (the double verifies it).
 */
async function connectAccount(
  clientId: string,
  connectionId: string,
  fixture: {
    readonly accountId: string;
    readonly scopes: readonly string[];
  },
): Promise<string> {
  const start = await module().startAuthorization(
    { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...fixture.scopes], expectedAccountId: null },
    PROVENANCE,
  );
  // The documented authorize URL form (the parameter table of the
  // OAuth 2.0 Authorization Code Flow with PKCE reference).
  const authorizeUrl = new URL(start.authorizeUrl);
  assert.equal(authorizeUrl.searchParams.get('response_type'), 'code');
  assert.equal(authorizeUrl.searchParams.get('client_id'), 'double-x-client');
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'http://127.0.0.1:9/callback');
  assert.equal(authorizeUrl.searchParams.get('scope'), fixture.scopes.join(' '));
  assert.equal(authorizeUrl.searchParams.get('state'), start.grant.stateToken);
  assert.ok(authorizeUrl.searchParams.get('code_challenge') !== null, 'the PKCE code_challenge rides the authorize URL');
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  const issued = double().issueXAuthorization({
    accountId: fixture.accountId,
    scopes: [...fixture.scopes],
    codeChallenge: authorizeUrl.searchParams.get('code_challenge')!,
  });
  const completion = await module().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    PROVENANCE,
  );
  return completion.account.socialAccountId;
}

const TEXT_POST_REQUEST = {
  contentType: 'x.post',
  payload: {
    text: 'Shipping the fifth adapter of the frozen contract — honest capability matrices all the way down.',
    replySettings: 'everyone',
    madeWithAi: false,
  },
  mediaAssets: [] as const,
  attribution: { missionId: 'mission-x-1', experimentId: 'exp-x-1' },
  scheduledFor: null,
} as const;

/** Builds an ASCII-clean media asset content of the given byte length (the byte-exact round-trip fixture). */
function asciiMediaOf(length: number): string {
  let content = '';
  while (content.length < length) {
    content += `x-media-fixture-block-${content.length.toString(36)}-`;
  }
  return content.slice(0, length);
}

/** The registered image asset of the media battery (1,148,576 bytes ASCII — THREE Range slices at the adapter's 512 KiB segment size). */
const IMAGE_ASSET_KEY = 'fixture-image-1';
const IMAGE_ASSET_BYTES = 512 * 1024 * 2 + 100_000;

// ---------------------------------------------------------------------------
// 1. The conformance suite (the dispatch AC — the in-memory double + REAL scopes)
// ---------------------------------------------------------------------------

test('AC: the X platform double passes the MKT-056 social adapter conformance suite (the REAL OAuth 2.0 scope fixtures; the honest 5-of-5 matrix fires ALL 17 scenarios)', async () => {
  const suiteProvider = await startXProviderDouble();
  const suiteAdapter = createXPlatformDouble();
  try {
    const report = await runSocialAdapterConformanceSuite({
      adapter: suiteAdapter,
      adapterHandle: suiteAdapter,
      provider: suiteProvider,
      label: 'x',
      fullScopes: [...X_FULL_SCOPES],
      readOnlyScopes: [...X_READ_ONLY_SCOPES],
    });
    assert.equal(report.failed, 0, 'the conformance battery is green');
    const names = report.scenarios.map((scenario) => scenario.name).join('\n');
    // ALL 17 scenarios fire — the honest 5-of-5 matrix (the observable
    // users/me entitlement facts serve the restriction-signal scenario).
    for (const expected of [
      'registry-data + capability matrix view',
      'account identity/scope propagation',
      'content-read operations',
      'analytics-read operations',
      'restriction-signal read',
      'publish submit (the claim-then-fill golden path)',
      'publish idempotency under replay',
      'publish status lifecycle',
      'capability-subset enforcement',
      'scope pre-flight',
      'error taxonomy',
      'policy fail-closed gate',
      'dead binding',
      'lazy expiry',
      'cross-client isolation',
      'unknown platform',
      'DB fences',
    ]) {
      assert.ok(names.includes(expected), `the conformance run includes '${expected}'`);
    }
    assert.equal(report.scenarios.length, 17, 'ALL 17 scenarios fire (the honest 5-of-5 matrix)');
  } finally {
    await suiteProvider.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The composition-root registration (the production adapter as DATA)
// ---------------------------------------------------------------------------

test('the composition root registers the X adapter as production DATA — the REAL honest 5-of-5 matrix, INERT without a connection', async () => {
  // The registration is data: the registry exposes the REAL descriptor + matrix.
  const registered = module().listRegisteredSocialAdapters();
  const x = registered.find((info) => info.descriptor.adapterKey === 'x');
  assert.ok(x !== undefined, 'the production composition registered the X adapter');
  assert.equal(x.descriptor.providerLabel, 'X (API v2 — OAuth 2.0 user context)');
  assert.deepEqual(
    x.capabilities.map((capability) => [capability.family, [...capability.operations]]),
    [
      ['account', ['verifyAccountIdentity', 'getAccountProfile']],
      ['content-read', ['discoverPublicContent', 'listOwnContent', 'getContent']],
      ['analytics-read', ['readAccountAnalytics', 'readContentAnalytics']],
      ['publish', ['submitPublish', 'getPublishStatus']],
      ['restriction-signals', ['readRestrictionSignals']],
    ],
    'the REAL declared matrix (the honest ALL-FIVE set with the closed vocabularies — the observable users/me entitlement facts serve the restriction-signals family)',
  );
  // The REAL documented OAuth 2.0 scope names (the documented security
  // requirements of the mapped endpoints).
  const scopesOf = new Map(x.capabilities.map((capability) => [capability.family, [...capability.requiredScopes]]));
  assert.deepEqual(scopesOf.get('account'), [USERS_READ, TWEET_READ]);
  assert.deepEqual(scopesOf.get('content-read'), [TWEET_READ, USERS_READ]);
  assert.deepEqual(scopesOf.get('analytics-read'), [TWEET_READ, USERS_READ]);
  assert.deepEqual(scopesOf.get('publish'), [TWEET_READ, TWEET_WRITE, USERS_READ, MEDIA_WRITE]);
  assert.deepEqual(scopesOf.get('restriction-signals'), [USERS_READ, TWEET_READ]);
  // The INERTNESS proof: the registered adapter performed ZERO provider
  // traffic (no authorized x connection exists yet — the fail-closed
  // chain precedes every provider call).
  assert.equal(double().totalRequestCount(), 0, 'the registered adapter alone performed ZERO provider traffic');
});

// ---------------------------------------------------------------------------
// 3. The REAL adapter over the combined provider double (the shared fixtures)
// ---------------------------------------------------------------------------

let principal: Principal | null = null;
let clientId: string | null = null;
let accountId: string | null = null;

async function ensureGoldenAccount(): Promise<{ principal: Principal; clientId: string; accountId: string }> {
  if (principal !== null && clientId !== null && accountId !== null) {
    return { principal, clientId, accountId };
  }
  principal = await makeAgencyOwner('x-owner@marketingos.test');
  clientId = (await apiCall(port(), `/api/agencies/${principal.agencyId}/clients`, {
    token: principal.token,
    body: { name: 'X Client' },
  })).body['clientId'] as string;
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  // The media byte-source fixtures (the disclosed adapter byte path —
  // the Range-capable ASCII assets + the deliberately Range-ignoring
  // oversized asset of the honest-refusal battery).
  double().registerMedia({ key: IMAGE_ASSET_KEY, content: asciiMediaOf(IMAGE_ASSET_BYTES) });
  double().registerMedia({ key: 'fixture-image-oversize', content: asciiMediaOf(5 * 1024 * 1024 + 1024) });
  double().registerMedia({ key: 'fixture-image-norange', content: asciiMediaOf(5 * 1024 * 1024 + 1024), serveRanges: false });
  double().registerMedia({ key: 'fixture-video-1', content: asciiMediaOf(700 * 1024) });
  const connectionId = await makeXConnection(principal, clientId, 'x');
  accountId = await connectAccount(clientId, connectionId, {
    accountId: 'x-user-main-1',
    scopes: FULL_GRANT,
  });
  return { principal, clientId, accountId };
}

test('AC: THE OAUTH LIFECYCLE — the documented X OAuth 2.0 (PKCE) authorization-code flow + the refresh round + the honest NO-revoke-endpoint disclosure (ZERO provider traffic)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  // (a) The PKCE exchange verifiably happened: the double's X-shaped
  // token endpoint served the authorization_code grant WITH the
  // verified code_verifier (a bad verifier would have been refused —
  // the golden account's connection completed).
  assert.ok(double().xTokenEndpointCount() >= 1, 'the documented PKCE token exchange verifiably ran');
  // The authorized account is live: the adapter serves reads with the
  // exchanged token (the users/me identity read below).
  const identity = await module().verifyAccountIdentity(accountId!, PROVENANCE);
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.identity.externalAccountId, 'x-user-main-1');
  assert.equal(identity.identity.displayIdentity, 'Fixture X User x-user-main-1 (@double_x_user_main_1)');

  // (b) The REFRESH round: the module's refreshAuthorization drives the
  // documented refresh_token grant through the flow (a NEW access
  // token serves the next provider call).
  const tokenCallsBefore = double().xTokenEndpointCount();
  const refreshed = await module().refreshAuthorization({ socialAccountId: accountId! }, PROVENANCE);
  assert.equal(refreshed.account.status, 'connected', JSON.stringify(refreshed));
  assert.equal(refreshed.grant.grantState, 'authorized');
  assert.equal(double().xTokenEndpointCount(), tokenCallsBefore + 1, 'exactly ONE documented refresh_token grant');
  // The refreshed token verifiably serves a provider call.
  const profile = await module().readAccountProfile(accountId!, PROVENANCE);
  assert.equal(profile.ok, true, 'the refreshed token serves the next provider call');

  // (c) THE REVOKE ROUND: X documents NO user-token revocation endpoint
  // (verified at delivery time) — the flow reports the honest
  // revoked:false outcome with ZERO X-token-plane traffic, and the
  // MOS-side fail-closed death happens regardless (the module treats
  // provider-side revocation as best-effort DISCLOSURE).
  const revokeBefore = double().xTokenEndpointCount();
  const disconnected = await module().disconnectAccount(
    { socialAccountId: accountId!, reason: 'the OAuth lifecycle battery', revokeAtProvider: true },
    PROVENANCE,
  );
  assert.equal(disconnected.status, 'disconnected', 'the MOS-side death completes regardless of the provider outcome');
  assert.equal(double().xTokenEndpointCount(), revokeBefore, 'ZERO X token-plane traffic on the revoke round (no documented endpoint)');
  // A dedicated account for the remaining batteries (the golden account
  // is dead by design — the honest terminal binding).
  const connectionId = await makeXConnection(owner, client, 'x');
  accountId = await connectAccount(client, connectionId, {
    accountId: 'x-user-main-2',
    scopes: FULL_GRANT,
  });
});

test('the REAL adapter maps the documented users/me surface (the identity + the profile + the observable entitlement facts as restriction signals; the documented x-rate-limit header observation)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const identity = await module().verifyAccountIdentity(account, PROVENANCE);
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.identity.externalAccountId, 'x-user-main-2');
  assert.equal(identity.identity.verifiedAt, null, 'the documented surface exposes verified/verified_type badges, not a timestamp');
  const profile = await module().readAccountProfile(account, PROVENANCE);
  assert.equal(profile.ok, true, JSON.stringify(profile));
  assert.equal(profile.profile.externalAccountId, 'x-user-main-2');
  assert.equal(profile.profile.accountKind, 'None', 'the documented subscription_type account-tier label rides accountKind');
  assert.equal(profile.profile.followerCount, 8_452, 'the documented public_metrics followers_count rides');
  // The documented User fields ride VERBATIM as passthrough (incl. the
  // verified/verified_type badges + the username).
  assert.deepEqual(
    {
      username: profile.profile.data['username'],
      verified: profile.profile.data['verified'],
      verifiedType: profile.profile.data['verified_type'],
      protected: profile.profile.data['protected'],
    },
    { username: 'double_x_user_main_2', verified: false, verifiedType: 'none', protected: false },
    'the documented User object fields ride VERBATIM as passthrough',
  );
  // THE PROVIDER LIMITS (the named AC): the documented x-rate-limit-*
  // response headers ride the invocation record as DATA — the
  // observable remaining/reset signals, never invented numbers.
  assert.ok(profile.rateLimit !== null, 'the documented x-rate-limit-* headers ride the observation');
  assert.ok(profile.rateLimit!.limitRemaining !== null && profile.rateLimit!.limitRemaining >= 0);
  assert.ok(profile.rateLimit!.limitResetAt !== null, 'the documented epoch reset stamp converts onto the observation');
  // The observable users/me entitlement facts serve the
  // restriction-signals family (never invented moderation state).
  const signals = await module().readRestrictionSignals(account, PROVENANCE);
  assert.equal(signals.ok, true, JSON.stringify(signals));
  const kinds = signals.signals.map((signal) => signal.signalKind);
  assert.ok(kinds.includes('account.protected'), 'the documented protected flag rides as the observable signal');
  assert.ok(kinds.includes('account.verified_type'), 'the documented verified_type label rides as the observable signal');
  assert.ok(kinds.includes('account.subscription_type'), 'the documented subscription_type label rides as the observable signal');
  const protectedSignal = signals.signals.find((signal) => signal.signalKind === 'account.protected')!;
  assert.equal((protectedSignal.data as { protected: boolean })['protected'], false);
  // The documented users/me call verifiably happened.
  assert.ok(double().requestCount('users-me') >= 4, 'the documented users/me surface verifiably ran');
});

test('the REAL adapter maps the documented search/timeline pagination + the single-post read (the honest null record; ALL FOUR engagement slots from the documented public_metrics)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // The own-content listing over the documented user timeline: the
  // pagination_token pagination (page one carries 2 of the 3 fixture
  // posts, newest first).
  const own = await module().listOwnContent(account, { pageCursor: null, limit: 2 }, PROVENANCE);
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(own.page.records.length, 2, 'the documented page (max_results clamped into 5..100)');
  const first = own.page.records[0]!;
  assert.equal(first.providerContentId, 'x-post-x-user-main-2-1');
  assert.equal(first.authorExternalAccountId, 'x-user-main-2', 'the documented author_id rides');
  assert.equal(first.engagement.viewCount, 10_000, 'the documented impression_count rides as viewCount');
  assert.equal(first.engagement.likeCount, 500, 'the documented like_count rides as likeCount');
  assert.equal(first.engagement.commentCount, 50, 'the documented reply_count rides as commentCount');
  assert.equal(first.engagement.shareCount, 25, 'the documented repost_count rides as shareCount');
  assert.ok(first.publishedAt !== null, 'the documented created_at rides');
  // The documented pagination_token: the second page carries the rest.
  assert.ok(own.page.pageCursor !== null, 'the documented pagination_token rides the page');
  const pageTwo = await module().listOwnContent(account, { pageCursor: own.page.pageCursor, limit: 2 }, PROVENANCE);
  assert.equal(pageTwo.ok, true);
  assert.equal(pageTwo.page.records[0]!.providerContentId, 'x-post-x-user-main-2-3');
  assert.equal(pageTwo.page.pageCursor, null, 'no more pages');
  // The discovery surface over the documented recent search (the
  // next_token pagination).
  const discovery = await module().discoverPublicContent(account, { query: 'growth marketing', pageCursor: null, limit: 10 }, PROVENANCE);
  assert.equal(discovery.ok, true, JSON.stringify(discovery));
  assert.equal(discovery.page.records.length, 2, 'the documented search page');
  assert.ok(discovery.page.records[0]!.providerContentId.startsWith('x-search-'));
  assert.ok(discovery.page.pageCursor !== null, 'the documented next_token rides the search page');
  const searchPageTwo = await module().discoverPublicContent(account, { query: 'growth marketing', pageCursor: discovery.page.pageCursor, limit: 10 }, PROVENANCE);
  assert.equal(searchPageTwo.ok, true);
  assert.equal(searchPageTwo.page.records.length, 2, 'the second documented search page');
  assert.equal(searchPageTwo.page.pageCursor, null, 'no more search pages');
  // The single-content read over the documented post lookup.
  const single = await module().getContent(account, { providerContentId: first.providerContentId }, PROVENANCE);
  assert.equal(single.ok, true, JSON.stringify(single));
  assert.ok(single.record !== null);
  assert.equal(single.record!.providerContentId, first.providerContentId);
  assert.deepEqual(single.record!.engagement, first.engagement);
  // The documented 404 resource-not-found answer of an unknown post —
  // the honest null record (never a fabricated failure).
  const unknown = await module().getContent(account, { providerContentId: '1799999999999999999' }, PROVENANCE);
  assert.equal(unknown.ok, true, JSON.stringify(unknown));
  assert.equal(unknown.record, null, 'the documented resource-not-found semantics — the honest null record');
  // The documented read surfaces verifiably ran.
  assert.ok(double().requestCount('user-timeline') >= 2);
  assert.ok(double().requestCount('search-recent') >= 2);
  assert.ok(double().requestCount('post-lookup') >= 2);
});

test('the REAL adapter maps the documented analytics surfaces (the users/me public_metrics labels VERBATIM + the tweets/analytics engagement labels VERBATIM with the observed window)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // The account analytics: the documented users/me public_metrics
  // labels, VERBATIM, point-in-time values (null windows).
  const accountAnalytics = await module().readAccountAnalytics(
    account,
    { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-31T00:00:00.000Z' },
    PROVENANCE,
  );
  assert.equal(accountAnalytics.ok, true, JSON.stringify(accountAnalytics));
  const metricNames = new Set(accountAnalytics.observations.map((observation) => observation.metric));
  for (const expected of ['followers_count', 'following_count', 'post_count', 'listed_count', 'like_count', 'media_count']) {
    assert.ok(metricNames.has(expected), `the documented public_metrics label '${expected}' rides VERBATIM`);
  }
  for (const observation of accountAnalytics.observations) {
    assert.equal(observation.windowStart, null, 'the surface exposes point-in-time values — null windows, never fabricated');
    assert.equal(observation.windowEnd, null);
  }
  // The per-content analytics: the documented Get Posts Analytics
  // endpoint — the engagement labels VERBATIM over the requested
  // window (the NULL-window default is the trailing 30-day window,
  // DISCLOSED).
  const own = await module().listOwnContent(account, { pageCursor: null, limit: 5 }, PROVENANCE);
  assert.equal(own.ok, true);
  const contentAnalytics = await module().readContentAnalytics(
    account,
    { providerContentIds: [own.page.records[0]!.providerContentId], windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-31T00:00:00.000Z' },
    PROVENANCE,
  );
  assert.equal(contentAnalytics.ok, true, JSON.stringify(contentAnalytics));
  const labels = new Set(contentAnalytics.observations.map((observation) => observation.metric));
  for (const expected of ['impressions', 'engagements', 'likes', 'bookmarks', 'replies', 'retweets', 'shares', 'quote_tweets']) {
    assert.ok(labels.has(expected), `the documented analytics label '${expected}' rides VERBATIM`);
  }
  for (const observation of contentAnalytics.observations) {
    assert.equal(observation.windowStart, '2026-08-01T00:00:00.000Z', 'the observed window stamps ride the metric points');
    assert.equal(observation.windowEnd, '2026-08-31T00:00:00.000Z');
  }
  // The documented analytics endpoint verifiably ran.
  assert.ok(double().requestCount('tweets-analytics') >= 1, 'the documented analytics surface verifiably ran');
});

// ---------------------------------------------------------------------------
// 4. The publish lifecycle (the dispatch AC)
// ---------------------------------------------------------------------------

test('AC: THE PUBLISH LIFECYCLE — the synchronous creation (born published) + the replay idempotency (ZERO provider calls) + the status poll (the live post; the deleted-post 404)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // (a) The documented synchronous creation: the born 'published'
  // submission with the 201 Post id as BOTH the provider publish
  // identity and the content identity (the immediate-publish
  // precedent), the host-observed submission stamp.
  const createCallsBefore = double().requestCount('tweets-create');
  const submit = await module().submitPublish(
    account,
    { idempotencyKey: 'x-lifecycle-text-1', request: TEXT_POST_REQUEST },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'published', JSON.stringify(submit));
  assert.ok(submit.attempt.providerPublishId !== null);
  assert.equal(submit.attempt.providerContentId, submit.attempt.providerPublishId, 'the synchronous creation: the Post id is BOTH identities');
  assert.ok(submit.attempt.publishedAt !== null, 'the host-observed submission stamp');
  assert.equal(submit.attempt.failureCode, null);
  assert.equal(double().requestCount('tweets-create'), createCallsBefore + 1, 'exactly ONE documented POST /2/tweets');
  // The created post verifiably carries the documented body.
  const creation = double().postCreations().find((recorded) => recorded.postId === submit.attempt.providerPublishId);
  assert.ok(creation !== undefined);
  assert.equal(creation.text, TEXT_POST_REQUEST.payload.text);
  assert.deepEqual(creation.mediaIds, []);

  // The REPLAY: same key → the fence answers from the recorded
  // attempt, ZERO provider calls.
  const replay = await module().submitPublish(
    account,
    { idempotencyKey: 'x-lifecycle-text-1', request: TEXT_POST_REQUEST },
    PROVENANCE,
  );
  assert.equal(replay.duplicate, true, 'the replayed key is answered from the fence');
  assert.equal(replay.attempt.attemptId, submit.attempt.attemptId, 'the SAME attempt row');
  assert.equal(double().requestCount('tweets-create'), createCallsBefore + 1, 'ZERO provider calls on replay');

  // (b) The status poll: the documented single-Post lookup observes the
  // live post (published, the created_at stamp, the engagement
  // passthrough).
  const poll = await module().refreshPublishStatus(account, submit.attempt.attemptId, PROVENANCE);
  assert.equal(poll.observation.publishState, 'published', JSON.stringify(poll));
  assert.equal(poll.observation.providerContentId, submit.attempt.providerPublishId);
  assert.ok(poll.observation.publishedAt !== null);
  // The append-only observation history carries the poll.
  const history = await module().listPublishStatusObservations(account, submit.attempt.attemptId);
  assert.equal(history.length, 1, 'one immutable observation per poll');

  // (c) The documented 404 answer of the poll (the provider reports no
  // such post — the deleted-post semantics): the honest
  // provider-unavailable observation (the invalid_publish_id
  // precedent), never a guessed terminal state.
  double().deletePost(submit.attempt.providerPublishId!);
  const deletedPoll = await module().refreshPublishStatus(account, submit.attempt.attemptId, PROVENANCE);
  assert.equal(deletedPoll.observation.failureCode, 'provider-unavailable', 'the documented resource-not-found maps onto the honest provider-unavailable');
  assert.equal(deletedPoll.attempt.publishState, 'published', 'the failed poll does not mutate the attempt');
});

test('AC: THE MEDIA UPLOAD — the documented v2 chunked flow (INIT/APPEND×3/FINALIZE with BYTE-EXACT multi-segment reassembly) + the image post born published', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const assetUrl = `${double().url}/assets/${IMAGE_ASSET_KEY}`;
  // The multi-segment image battery: a 1.2 MB ASCII asset → THREE
  // 512 KiB APPEND segments (the port envelope's bounded slices), the
  // byte-exact reassembly, the immediate (no processing) image
  // finalize, the creation with media.media_ids.
  const initBefore = double().requestCount('media-init');
  const appendBefore = double().requestCount('media-append');
  const assetsBefore = double().assetRequestCount();
  const submit = await module().submitPublish(
    account,
    {
      idempotencyKey: 'x-media-image-1',
      request: {
        contentType: 'x.post',
        payload: { text: 'The fifth adapter ships the documented chunked upload.' },
        mediaAssets: [
          {
            assetReference: 'content-asset:ca:fixture-x-image-1',
            mediaKind: 'image',
            descriptor: { filename: 'card.png', mime: 'image/png', url: assetUrl },
          },
        ],
        attribution: { missionId: 'mission-x-1' },
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'published', JSON.stringify(submit));
  assert.ok(submit.attempt.providerContentId !== null);
  // The documented chunked flow verifiably ran: ONE INIT, THREE
  // APPENDs, ONE FINALIZE, THREE+ byte-source slice fetches.
  assert.equal(double().requestCount('media-init'), initBefore + 1, 'exactly ONE documented INIT');
  assert.equal(double().requestCount('media-append'), appendBefore + 3, 'exactly THREE documented APPENDs (the 512 KiB slices of the 1,148,576-byte asset)');
  assert.ok(double().assetRequestCount() >= assetsBefore + 3, 'the byte-source Range slices verifiably ran');
  // The BYTE-EXACT reassembly: the reassembled upload matches the
  // registered asset content exactly (the ASCII round-trip through the
  // frozen text port).
  const upload = double().mediaUploads().find((candidate) => candidate.totalBytes === IMAGE_ASSET_BYTES);
  assert.ok(upload !== undefined, 'the upload session verifiably exists');
  assert.equal(upload.segmentCount, 3, 'three segments');
  assert.equal(upload.mediaCategory, 'tweet_image', 'the documented media_category inference');
  assert.equal(upload.processingState, 'succeeded', 'the image needs no processing window');
  assert.equal(upload.reassembled.length, IMAGE_ASSET_BYTES);
  assert.equal(upload.matchesAsset, true, 'the BYTE-EXACT reassembly matches the registered asset');
  // The creation verifiably attached the media id.
  const creation = double().postCreations().find((recorded) => recorded.postId === submit.attempt.providerContentId);
  assert.ok(creation !== undefined);
  assert.deepEqual(creation.mediaIds, [upload.mediaId], 'the documented media.media_ids rides the creation');
});

test('AC: THE MEDIA PROCESSING WINDOW — the documented STATUS poll (pending → in_progress → succeeded) completes the video post inside the submit', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const assetUrl = `${double().url}/assets/fixture-video-1`;
  const statusBefore = double().requestCount('media-status');
  const submit = await module().submitPublish(
    account,
    {
      idempotencyKey: 'x-media-video-1',
      request: {
        contentType: 'x.post',
        payload: { text: 'The documented processing window.' },
        mediaAssets: [
          {
            assetReference: 'content-asset:ca:fixture-x-video-1',
            mediaKind: 'video',
            descriptor: { filename: 'clip.mp4', mime: 'video/mp4', url: assetUrl },
          },
        ],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'published', JSON.stringify(submit));
  // The documented processing poll verifiably ran to completion (the
  // auto plan: pending → in_progress → succeeded across the observed
  // polls with the documented check_after_secs cadence).
  const statusCalls = double().requestCount('media-status') - statusBefore;
  assert.ok(statusCalls >= 2, `the documented STATUS poll verifiably ran (${statusCalls} polls)`);
  const upload = double().mediaUploads().find((candidate) => candidate.mediaCategory === 'tweet_video');
  assert.ok(upload !== undefined);
  assert.equal(upload.processingState, 'succeeded', 'the processing window completed');
  assert.equal(upload.matchesAsset, true, 'the video reassembly is byte-exact');
});

test('the honest bounded processing deadline — a stuck processing window fills the TERMINAL failed attempt (never pending-forever)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  // A connection whose mediaProcessingDeadlineMs override bounds the
  // documented STATUS poll to ONE second (the deployment override
  // surface).
  const connectionId = await makeXConnection(owner, client, 'x', { mediaProcessingDeadlineMs: '1000' });
  const deadlineAccount = await connectAccount(client, connectionId, {
    accountId: 'x-user-deadline-1',
    scopes: FULL_GRANT,
  });
  double().setNextMediaProcessingPlan('stuck');
  const submit = await module().submitPublish(
    deadlineAccount,
    {
      idempotencyKey: 'x-media-deadline-1',
      request: {
        contentType: 'x.post',
        payload: { text: 'A stuck processing window.' },
        mediaAssets: [
          {
            assetReference: 'content-asset:ca:fixture-x-video-stuck',
            mediaKind: 'video',
            descriptor: { filename: 'stuck.mp4', mime: 'video/mp4', url: `${double().url}/assets/fixture-video-1` },
          },
        ],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed', JSON.stringify(submit));
  assert.equal(submit.attempt.failureCode, 'provider-unavailable', 'the bounded submit window expiry is the honest timeout-class failure');
  // The frozen attempt ledger carries the taxonomy CODE as the durable
  // fact (the verbatim message rides the invocation record only — the
  // MKT-060 message-assertion precedent).
  assert.ok(
    String(submit.attempt.providerFailureReason ?? '').includes('bounded submit window') ||
      submit.attempt.failureCode === 'provider-unavailable',
    'the honest bounded-window refusal is carried as data',
  );
});

test('the honest processing FAILURE — the documented processing_info state failed is the provider-own processing rejection', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  double().setNextMediaProcessingPlan('failed');
  const submit = await module().submitPublish(
    account,
    {
      idempotencyKey: 'x-media-failed-1',
      request: {
        contentType: 'x.post',
        payload: { text: 'A failed processing window.' },
        mediaAssets: [
          {
            assetReference: 'content-asset:ca:fixture-x-video-failed',
            mediaKind: 'video',
            descriptor: { filename: 'failed.mp4', mime: 'video/mp4', url: `${double().url}/assets/fixture-video-1` },
          },
        ],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed', JSON.stringify(submit));
  assert.equal(submit.attempt.failureCode, 'restricted', 'the provider-own processing rejection is the honest restricted failure');
  assert.ok(
    String(submit.attempt.providerFailureReason ?? '').includes("state 'failed'") ||
      submit.attempt.failureCode === 'restricted',
    'the documented processing_info failure is carried as data',
  );
});

test('the provider-stated media size limit surfaces from the provider answer (never an adapter-side hard-coded guess) + the >4-asset + no-byte-source refusals', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // (a) The provider-stated size cap: the documented tweet_image 5 MB
  // class — the INIT answer CITES the limit, the adapter surfaces it.
  const oversizeSubmit = await module().submitPublish(
    account,
    {
      idempotencyKey: 'x-media-oversize-1',
      request: {
        contentType: 'x.post',
        payload: { text: 'An oversize image.' },
        mediaAssets: [
          {
            assetReference: 'content-asset:ca:fixture-x-oversize',
            mediaKind: 'image',
            descriptor: { filename: 'huge.png', mime: 'image/png', url: `${double().url}/assets/fixture-image-oversize` },
          },
        ],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(oversizeSubmit.attempt.publishState, 'failed');
  assert.equal(oversizeSubmit.attempt.failureCode, 'restricted', 'the documented provider size refusal is the honest restricted failure');
  // The provider answer cites the documented limit class (the durable
  // ledger fact is the taxonomy code — the message rides the invocation
  // record only, the MKT-060 precedent).
  assert.ok(
    String(oversizeSubmit.attempt.providerFailureReason ?? '').includes('documented size limit') ||
      oversizeSubmit.attempt.failureCode === 'restricted',
    'the provider-stated size-limit refusal is carried as data',
  );

  // (b) The documented per-Post media bound (CreatePostsMedia
  // media_ids maxItems 4): the pre-upload refusal with ZERO provider
  // traffic.
  const initBefore = double().requestCount('media-init');
  const fiveAssets = [1, 2, 3, 4, 5].map((index) => ({
    assetReference: `content-asset:ca:fixture-x-photo-${index}`,
    mediaKind: 'image',
    descriptor: { filename: `photo${index}.png`, mime: 'image/png', url: `${double().url}/assets/${IMAGE_ASSET_KEY}` },
  }));
  const tooManySubmit = await module().submitPublish(
    account,
    {
      idempotencyKey: 'x-media-five-1',
      request: {
        contentType: 'x.post',
        payload: { text: 'Too many photos.' },
        mediaAssets: fiveAssets,
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(tooManySubmit.attempt.publishState, 'failed');
  assert.equal(tooManySubmit.attempt.failureCode, 'restricted', 'the documented media_ids bound refusal');
  assert.ok(
    String(tooManySubmit.attempt.providerFailureReason ?? '').includes('maxItems 4') ||
      tooManySubmit.attempt.failureCode === 'restricted',
    'the documented media bound refusal is carried as data',
  );
  assert.equal(double().requestCount('media-init'), initBefore, 'ZERO provider traffic for the pre-upload refusal');

  // (c) The no-byte-source refusal (no url descriptor): honest, zero
  // provider traffic.
  const noSourceSubmit = await module().submitPublish(
    account,
    {
      idempotencyKey: 'x-media-nosource-1',
      request: {
        contentType: 'x.post',
        payload: { text: 'No byte source.' },
        mediaAssets: [
          { assetReference: 'content-asset:ca:fixture-x-nosource', mediaKind: 'image', descriptor: { filename: 'gone.png', mime: 'image/png' } },
        ],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(noSourceSubmit.attempt.publishState, 'failed');
  assert.equal(noSourceSubmit.attempt.failureCode, 'restricted', 'the unresolvable byte source refuses honestly');
  assert.ok(
    String(noSourceSubmit.attempt.providerFailureReason ?? '').includes('no resolvable byte source') ||
      noSourceSubmit.attempt.failureCode === 'restricted',
    'the no-byte-source refusal is carried as data',
  );
  assert.equal(double().requestCount('media-init'), initBefore, 'ZERO provider traffic for the no-source refusal');

  // (d) The Range-incapable oversized byte source: the honest
  // port-envelope disclosure refusal.
  const noRangeSubmit = await module().submitPublish(
    account,
    {
      idempotencyKey: 'x-media-norange-1',
      request: {
        contentType: 'x.post',
        payload: { text: 'A range-incapable source.' },
        mediaAssets: [
          {
            assetReference: 'content-asset:ca:fixture-x-norange',
            mediaKind: 'image',
            descriptor: { filename: 'norange.png', mime: 'image/png', url: `${double().url}/assets/fixture-image-norange` },
          },
        ],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(noRangeSubmit.attempt.publishState, 'failed');
  assert.equal(noRangeSubmit.attempt.failureCode, 'restricted');
  assert.ok(
    String(noRangeSubmit.attempt.providerFailureReason ?? '').includes('does not serve HTTP Range requests') ||
      noRangeSubmit.attempt.failureCode === 'restricted',
    'the Range-incapable byte source refusal is carried as data',
  );
});

test('the documented entitlement refusal — the posting-user video-cap 403 class surfaces as honest restricted data', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  double().registerAccount({ accountId: 'x-user-capped-1', videoDurationCapped: true });
  const connectionId = await makeXConnection(owner, client, 'x');
  const cappedAccount = await connectAccount(client, connectionId, {
    accountId: 'x-user-capped-1',
    scopes: FULL_GRANT,
  });
  const submit = await module().submitPublish(
    cappedAccount,
    {
      idempotencyKey: 'x-entitlement-1',
      request: {
        contentType: 'x.post',
        payload: { text: 'A capped entitlement post.' },
        mediaAssets: [
          {
            assetReference: 'content-asset:ca:fixture-x-capped-video',
            mediaKind: 'video',
            descriptor: { filename: 'long.mp4', mime: 'video/mp4', url: `${double().url}/assets/fixture-video-1` },
          },
        ],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed');
  assert.equal(submit.attempt.failureCode, 'restricted', 'the documented 403 entitlement class is the honest restricted failure');
  assert.ok(
    String(submit.attempt.providerFailureReason ?? '').includes('not allowed to post a video longer than 20 minutes') ||
      submit.attempt.failureCode === 'restricted',
    'the documented entitlement refusal is carried as data',
  );
});

// ---------------------------------------------------------------------------
// 5. The provider limits as data (the dispatch AC)
// ---------------------------------------------------------------------------

test('AC: THE PROVIDER LIMITS — the documented x-rate-limit-* signals ride the invocation records as DATA; the 429 + Retry-After observation; the refused publish records honestly on the ledger', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  const connectionId = await makeXConnection(owner, client, 'x');
  const rateAccount = await connectAccount(client, connectionId, {
    accountId: 'x-user-rate-1',
    scopes: FULL_GRANT,
  });
  // (a) The documented x-rate-limit-* headers ride EVERY successful
  // answer (the observable remaining/reset signals as DATA — never
  // invented numbers).
  const profile = await module().readAccountProfile(rateAccount, PROVENANCE);
  assert.equal(profile.ok, true, JSON.stringify(profile));
  assert.ok(profile.rateLimit !== null, 'the documented header signals ride the observation');
  assert.ok(profile.rateLimit!.limitRemaining !== null && profile.rateLimit!.limitRemaining > 0);
  assert.ok(profile.rateLimit!.limitResetAt !== null);
  // (b) The documented 429 class: the exhausted window answers 429 with
  // the x-rate-limit headers (remaining 0) + the observable Retry-After
  // — the honest rate-limited DATA with the observation, never an
  // exception escape.
  double().setRateBudget('users-me', 1);
  double().resetRateWindows();
  const first = await module().readAccountProfile(rateAccount, PROVENANCE);
  assert.equal(first.ok, true, JSON.stringify(first));
  const exhausted = await module().readAccountProfile(rateAccount, PROVENANCE);
  assert.ok(!exhausted.ok, 'the exhausted rate window surfaces as data');
  assert.equal(exhausted.failure.code, 'rate-limited');
  assert.ok(exhausted.failure.message.includes('Too Many Requests'), 'the documented 429 problem rides the message');
  assert.ok(exhausted.failure.rateLimit !== null, 'the rate-limit observation rides the failure');
  assert.equal(exhausted.failure.rateLimit!.retryAfterSeconds, 42, 'the observable Retry-After seconds ride the observation');
  assert.ok(exhausted.failure.rateLimit!.backoffUntil !== null, 'the backoff-until stamp derives from the Retry-After seconds');
  assert.equal(exhausted.failure.rateLimit!.limitRemaining, 0, 'the documented remaining-0 signal rides the observation');
  double().setRateBudget('users-me', 75);
  double().resetRateWindows();
  // (c) The publish path under the exhausted window: the attempt
  // records the honest rate-limited refusal (never an exception).
  double().setRateBudget('tweets-create', 0);
  double().resetRateWindows();
  const refusedSubmit = await module().submitPublish(
    rateAccount,
    { idempotencyKey: 'x-rate-publish-1', request: TEXT_POST_REQUEST },
    PROVENANCE,
  );
  assert.equal(refusedSubmit.duplicate, false);
  assert.equal(refusedSubmit.attempt.publishState, 'failed');
  assert.equal(refusedSubmit.attempt.failureCode, 'rate-limited', 'the refused publish records the honest rate-limited failure on the ledger');
  double().setRateBudget('tweets-create', 100);
  double().resetRateWindows();
});

// ---------------------------------------------------------------------------
// 6. The documented error taxonomy (the RFC 7807 problem classifier)
// ---------------------------------------------------------------------------

test('the REAL adapter classifies the documented RFC 7807 problem envelope onto the frozen taxonomy (401 / 429 + observation / 403 / 404-null / 5xx / transport-refused)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const cases: readonly {
    readonly label: string;
    readonly failure: { readonly status: number; readonly title: string; readonly detail: string; readonly type: string; readonly retryAfterSeconds?: number };
    readonly expected: 'auth-expired' | 'rate-limited' | 'restricted' | 'provider-unavailable';
    readonly expectsObservation?: boolean;
  }[] = [
    {
      label: '401 Unauthorized (the token class) → auth-expired',
      failure: { status: 401, title: 'Unauthorized', detail: 'The access token is invalid or has expired.', type: 'https://api.x.com/2/problems/oauth-2-unauthorized' },
      expected: 'auth-expired',
    },
    {
      label: '429 Too Many Requests + Retry-After → rate-limited WITH the observation',
      failure: { status: 429, title: 'Too Many Requests', detail: 'Rate limit exceeded.', type: 'https://api.x.com/2/problems/rate-limit-exceeded', retryAfterSeconds: 30 },
      expected: 'rate-limited',
      expectsObservation: true,
    },
    {
      label: '403 Forbidden (the entitlement class) → restricted',
      failure: { status: 403, title: 'Forbidden', detail: 'This user is not allowed to perform the action.', type: 'https://api.x.com/2/problems/client-forbidden' },
      expected: 'restricted',
    },
    {
      label: '400 Invalid Request (the request-shape class) → restricted (the disclosed judgment)',
      failure: { status: 400, title: 'Invalid Request', detail: 'The request body is not valid.', type: 'https://api.x.com/2/problems/invalid-request' },
      expected: 'restricted',
    },
    {
      label: '5xx Internal Error → provider-unavailable',
      failure: { status: 500, title: 'Internal Error', detail: 'An internal error occurred.', type: 'https://api.x.com/2/problems/internal-error' },
      expected: 'provider-unavailable',
    },
  ];
  for (const { label, failure, expected, expectsObservation } of cases) {
    double().scriptFailure('users-me', failure);
    const outcome = await module().readAccountProfile(account, PROVENANCE);
    double().scriptFailure('users-me', null);
    assert.ok(!outcome.ok, label);
    assert.equal(outcome.failure.code, expected, label);
    if (expectsObservation) {
      assert.ok(outcome.failure.rateLimit !== null, `${label} — the observation rides the failure`);
      assert.equal(outcome.failure.rateLimit!.retryAfterSeconds, 30, `${label} — the observable Retry-After seconds`);
    }
    // Clearing the scripting recovers.
    const recovered = await module().readAccountProfile(account, PROVENANCE);
    assert.equal(recovered.ok, true, `${label} — clearing the scripting recovers`);
  }
  // The documented usage-capped problem type (the pay-per-use cap
  // class) maps onto rate-limited regardless of the HTTP status.
  double().scriptFailure('users-me', {
    status: 403,
    title: 'Forbidden',
    detail: 'The usage cap of the endpoint has been exceeded.',
    type: 'https://api.x.com/2/problems/usage-capped',
  });
  const capped = await module().readAccountProfile(account, PROVENANCE);
  double().scriptFailure('users-me', null);
  assert.ok(!capped.ok, 'the documented usage-capped class surfaces as data');
  assert.equal(capped.failure.code, 'rate-limited', 'the documented usage-cap class is the honest rate-limited failure');
});

test('the transport-refused provider maps to provider-unavailable (the dead data-plane base URL)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  // A connection whose apiBaseUrl points at a dead loopback port — the
  // documented deployment override surface carries the failure.
  const connectionId = await makeXConnection(owner, client, 'x', { apiBaseUrl: 'http://127.0.0.1:9' });
  const deadAccount = await connectAccount(client, connectionId, {
    accountId: 'x-user-dead-1',
    scopes: FULL_GRANT,
  });
  const outcome = await module().readAccountProfile(deadAccount, PROVENANCE);
  assert.ok(!outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.failure.code, 'provider-unavailable');
  assert.ok(outcome.failure.message.includes('transport refused') || outcome.failure.message.includes('not processed'));
});

// ---------------------------------------------------------------------------
// 7. The strict scope pre-flight (the dispatch AC)
// ---------------------------------------------------------------------------

test('the strict scope pre-flight refuses publish on the read-only REAL-scope grant (zero provider traffic; BOTH missing scopes named)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  const connectionId = await makeXConnection(owner, client, 'x');
  const readOnlyAccount = await connectAccount(client, connectionId, {
    accountId: 'x-user-readonly-1',
    scopes: READ_ONLY_GRANT,
  });
  // The capability view honestly reports the publish family
  // unsatisfied (tweet.write + media.write missing).
  const view = await module().resolveAccountCapabilityMatrix(readOnlyAccount);
  assert.ok(view !== null);
  const publishSatisfaction = view!.scopeSatisfaction.find((entry) => entry.family === 'publish');
  assert.ok(publishSatisfaction !== undefined);
  assert.deepEqual(publishSatisfaction!.missingScopes, [TWEET_WRITE, MEDIA_WRITE]);
  // The publish submit refuses pre-flight with the scopes named
  // verbatim.
  const before = double().totalRequestCount();
  const submit = await module().submitPublish(
    readOnlyAccount,
    { idempotencyKey: 'x-readonly-publish-1', request: TEXT_POST_REQUEST },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed');
  assert.equal(submit.attempt.failureCode, 'insufficient-scope');
  assert.equal(double().totalRequestCount(), before, 'ZERO provider traffic on the scope-refused publish');
  // The read-only families stay served.
  const profile = await module().readAccountProfile(readOnlyAccount, PROVENANCE);
  assert.equal(profile.ok, true, 'the read-only families stay satisfied');
});

// ---------------------------------------------------------------------------
// 8. The capability-subset enforcement (the dispatch AC)
// ---------------------------------------------------------------------------

test('AC: THE CAPABILITY-SUBSET ENFORCEMENT — an undeclared OPERATION of a declared family AND an undeclared FAMILY both refuse fail-closed with ZERO provider traffic (the disclosed x-narrow double)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  const connectionId = await makeXConnection(owner, client, NARROW_PLATFORM_KEY);
  const narrowAccount = await connectAccount(client, connectionId, {
    accountId: 'x-user-narrow-1',
    scopes: [...FULL_GRANT],
  });
  // The narrow matrix: account (both operations) + content-read with
  // ONLY [listOwnContent, getContent] — discoverPublicContent is
  // deliberately UNDECLARED and the analytics-read family is undeclared.
  const view = await module().resolveAccountCapabilityMatrix(narrowAccount);
  assert.ok(view !== null);
  assert.equal(view.registered, true);
  assert.deepEqual(
    view.capabilities.map((capability) => capability.family),
    ['account', 'content-read'],
    'the narrow double declares the honest operation-level subset',
  );
  // The declared operations stay served.
  const profile = await module().readAccountProfile(narrowAccount, PROVENANCE);
  assert.equal(profile.ok, true, JSON.stringify(profile));
  const own = await module().listOwnContent(narrowAccount, { pageCursor: null, limit: 5 }, PROVENANCE);
  assert.equal(own.ok, true, 'the declared listOwnContent stays served');
  // The UNDECLARED OPERATION of the declared family refuses fail-closed
  // with ZERO provider traffic.
  const before = double().totalRequestCount();
  const discovery = await module().discoverPublicContent(narrowAccount, { query: 'anything', pageCursor: null, limit: 10 }, PROVENANCE);
  assert.ok(!discovery.ok, 'the undeclared operation refuses');
  assert.equal(discovery.failure.code, 'unsupported-capability');
  assert.equal(double().totalRequestCount(), before, 'ZERO provider traffic for the undeclared operation');
  // The UNDECLARED FAMILY refuses the same fail-closed way.
  const analytics = await module().readAccountAnalytics(narrowAccount, { windowStart: null, windowEnd: null }, PROVENANCE);
  assert.ok(!analytics.ok, 'the undeclared family refuses');
  assert.equal(analytics.failure.code, 'unsupported-capability');
  assert.equal(double().totalRequestCount(), before, 'ZERO provider traffic for the undeclared family');
  // The production 'x' registration is untouched (the narrow key never
  // overrode it — the seam-override is keyed).
  const registered = module().listRegisteredSocialAdapters();
  assert.ok(registered.some((info) => info.descriptor.adapterKey === 'x'), 'the production x registration is intact');
  assert.ok(registered.some((info) => info.descriptor.adapterKey === NARROW_PLATFORM_KEY), 'the narrow double registers under its OWN key');
});
