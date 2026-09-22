/**
 * MKT-058 integration tests — the INSTAGRAM social platform adapter on
 * the REAL stack: embedded PostgreSQL 18, the spawned production API
 * and IN-PROCESS applications composed through the disclosed seams.
 *
 * Two proofs, each with its own disclosed double at the provider
 * boundary ONLY (the contract HOST under test — the capability gates,
 * the strict scope pre-flight, the /policies fail-closed gates, the
 * migration-050 idempotency fence, the claim-then-fill ledger — is
 * fully REAL in both — the MKT-057 pattern):
 *
 *   1. THE CONFORMANCE SUITE (the dispatch AC): the full 17-scenario
 *      MKT-056 battery
 *      (tests/integration/helpers/social-adapter-conformance.ts) runs
 *      against the disclosed IN-MEMORY Instagram platform double
 *      (tests/integration/helpers/instagram-platform-double.ts — the
 *      documented-API behavioral model: cursor pagination, the
 *      container lifecycle, the honest 4-of-5 capability matrix,
 *      failure injection) with the REAL Facebook Login scope names as
 *      the fixture grants (the documented test-only suite extension —
 *      Instagram's real scopes fall outside the default fixture
 *      vocabulary). The honest 4-of-5 matrix fires 16 of the 17
 *      scenarios (the restriction-signal scenario is structurally
 *      SKIPPED — the family is honestly undeclared; the
 *      capability-subset scenario EXERCISES the undeclared family's
 *      fail-closed refusal end-to-end with zero provider traffic);
 *
 *   2. THE REAL ADAPTER END-TO-END (the composition-root registration
 *      proof): the application boots with NO socialPlatformAdapters
 *      seam — the PRODUCTION-composed Instagram adapter (the MKT-058
 *      composition-root registration, the platform FetchHttpCall
 *      transport) serves every operation through the module API
 *      against the disclosed COMBINED provider double
 *      (tests/integration/helpers/instagram-http-double.ts — the
 *      loopback HTTP server faithfully mirroring the documented
 *      Instagram Graph API + Facebook Login OAuth planes): the REAL
 *      matrix + REAL scopes + inertness · the documented IG User node
 *      identity/profile (username, account_type, followers_count) ·
 *      THE ACCOUNT-TYPE HONESTY (the personal-account surface answers
 *      the documented '(#10) The user is not an Instagram Business'
 *      error semantics as honest restricted DATA — never a fabricated
 *      success) · hashtag discovery pagination + the honest null
 *      view/share engagement · the per-type documented media-insights
 *      vocabulary · the CONTAINER publish lifecycle (create → the
 *      at-most-once fence → IN_PROGRESS poll → FINISHED → media_publish
 *      → published with the media id → the PUBLISHED poll; ERROR →
 *      restricted; EXPIRED → failed) · the 24-hour publish window
 *      exhaustion · the hashtag rate window · the documented error
 *      taxonomy (code 190 / code 4 with the regain-capacity observation
 *      / code 10 / 5xx / transport-refused) · the strict REAL-scope
 *      pre-flight (zero provider traffic).
 */

import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
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
import { createLocalOAuthFlow } from './helpers/oauth-provider.ts';
import { createReferenceIntegrationStub, runSocialAdapterConformanceSuite } from './helpers/social-adapter-conformance.ts';
import {
  startInstagramProviderDouble,
  type InstagramProviderDouble,
} from './helpers/instagram-http-double.ts';
import {
  createInstagramPlatformDouble,
  INSTAGRAM_FULL_SCOPES,
  INSTAGRAM_READ_ONLY_SCOPES,
} from './helpers/instagram-platform-double.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'social-adapter-instagram-pipe-key';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-0000000000dd',
  recordedVia: 'test',
  correlationId: 'integration-social-adapter-instagram-1',
  causationId: null,
} as const;

/** The REAL Facebook Login scope names the adapter declares (the strict pre-flight vocabulary). */
const IG_BASIC = 'instagram_basic';
const IG_CONTENT_PUBLISH = 'instagram_content_publish';
const IG_MANAGE_INSIGHTS = 'instagram_manage_insights';
const PAGES_SHOW_LIST = 'pages_show_list';
const PAGES_READ_ENGAGEMENT = 'pages_read_engagement';
const FULL_GRANT = [IG_BASIC, IG_CONTENT_PUBLISH, IG_MANAGE_INSIGHTS, PAGES_SHOW_LIST, PAGES_READ_ENGAGEMENT] as const;
const READ_ONLY_GRANT = [IG_BASIC, PAGES_SHOW_LIST, PAGES_READ_ENGAGEMENT] as const;

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: InstagramProviderDouble | null = null;
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
function double(): InstagramProviderDouble {
  if (provider === null) throw new Error('provider double not booted');
  return provider;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('social_ig_real');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startInstagramProviderDouble();
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  // NO socialPlatformAdapters seam: the PRODUCTION-composed Instagram
  // adapter (the MKT-058 composition-root registration on the platform
  // FetchHttpCall transport) serves every operation of this battery.
  const core = await bootstrapApplication({
    integrationAdapters: [createReferenceIntegrationStub('instagram')],
    socialAccountFlows: [
      createLocalOAuthFlow(provider, { adapterKey: 'instagram', secretsDir: stack.env.secretsDir }),
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

async function makeClient(principal: Principal, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${principal.agencyId}/clients`, {
    token: principal.token,
    body: { name },
  });
  assert.equal(created.status, 201);
  return created.body['clientId'] as string;
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
/** Creates + connects the Instagram-keyed integration connection (providerConfig points the REAL adapter at the double). */
async function makeInstagramConnection(
  principal: Principal,
  clientId: string,
  providerConfig: Record<string, string> = {},
): Promise<string> {
  connectionSequence += 1;
  const credential = await credentialsModule().createCredentialReference({
    agencyId: principal.agencyId,
    clientId,
    kind: 'integration_api_key',
    label: `instagram_pipe_${clientId.slice(0, 8)}_${connectionSequence}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection(
    {
      clientId,
      adapterKey: 'instagram',
      credentialReferenceId: credential.credentialId,
      // The documented deployment override surface: the Graph API base
      // URL of the connection (apiBaseUrl) points the production
      // adapter at the loopback provider double.
      providerConfig: {
        apiBaseUrl: double().url,
        platformHint: 'instagram',
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

/** The full OAuth handshake through the REAL module + the combined provider double. */
async function connectAccount(
  clientId: string,
  connectionId: string,
  fixture: {
    readonly igUserId: string;
    readonly scopes: readonly string[];
    readonly capabilityTags?: readonly string[];
  },
): Promise<string> {
  const start = await module().startAuthorization(
    { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...fixture.scopes], expectedAccountId: null },
    PROVENANCE,
  );
  const issued = double().issueAuthorization({
    accountId: fixture.igUserId,
    displayIdentity: `ig:${fixture.igUserId}`,
    verifiedAt: '2026-07-01T09:30:00.000Z',
    scopes: [...fixture.scopes],
    capabilityTags: fixture.capabilityTags ?? ['instagram-tag'],
    expiresInMs: 3_600_000,
  });
  const completion = await module().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    PROVENANCE,
  );
  return completion.account.socialAccountId;
}

const PUBLISH_REQUEST = {
  contentType: 'instagram.feed-image',
  payload: { caption: 'The documented container caption.', media_type: 'IMAGE' },
  mediaAssets: [{ assetReference: 'content-asset:ca:fixture-ig-1', mediaKind: 'image', descriptor: { filename: 'post.jpg', mime: 'image/jpeg', url: 'https://cdn.example/post.jpg' } }],
  attribution: { missionId: 'mission-ig-1', experimentId: 'exp-ig-1' },
  scheduledFor: null,
} as const;

// ---------------------------------------------------------------------------
// 1. The conformance suite (the dispatch AC — the in-memory double + REAL scopes)
// ---------------------------------------------------------------------------

test('AC: the Instagram platform double passes the MKT-056 social adapter conformance suite (the REAL Facebook Login scope fixtures; the honest 4-of-5 matrix)', async () => {
  const suiteProvider = await startInstagramProviderDouble();
  const suiteAdapter = createInstagramPlatformDouble();
  try {
    const report = await runSocialAdapterConformanceSuite({
      adapter: suiteAdapter,
      adapterHandle: suiteAdapter,
      provider: suiteProvider,
      label: 'instagram',
      fullScopes: [...INSTAGRAM_FULL_SCOPES],
      readOnlyScopes: [...INSTAGRAM_READ_ONLY_SCOPES],
    });
    assert.equal(report.failed, 0, 'the conformance battery is green');
    const names = report.scenarios.map((scenario) => scenario.name).join('\n');
    // Every scenario the honest 4-of-5 matrix makes applicable ran.
    for (const expected of [
      'registry-data + capability matrix view',
      'account identity/scope propagation',
      'content-read operations',
      'analytics-read operations',
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
    // The HONEST SUBSET: the restriction-signal scenario is structurally
    // SKIPPED (the family is undeclared — the documented surface exposes
    // no restriction-signal endpoint) and the capability-subset scenario
    // EXERCISES the undeclared family's fail-closed refusal.
    assert.ok(!names.includes('restriction-signal read'), 'the restriction-signals family is honestly UNDECLARED');
    assert.equal(report.scenarios.length, 16, '16 of the 17 scenarios fire (the restriction-signal scenario is structurally skipped for the honest 4-of-5 matrix)');
  } finally {
    await suiteProvider.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The composition-root registration (the production adapter as DATA)
// ---------------------------------------------------------------------------

test('the composition root registers the Instagram adapter as production DATA — the REAL honest 4-of-5 matrix, INERT without a connection', async () => {
  // The registration is data: the registry exposes the REAL descriptor + matrix.
  const registered = module().listRegisteredSocialAdapters();
  const instagram = registered.find((info) => info.descriptor.adapterKey === 'instagram');
  assert.ok(instagram !== undefined, 'the production composition registered the Instagram adapter');
  assert.equal(instagram.descriptor.providerLabel, 'Instagram (Instagram Graph API, Professional accounts)');
  assert.deepEqual(
    instagram.capabilities.map((capability) => [capability.family, [...capability.operations]]),
    [
      ['account', ['verifyAccountIdentity', 'getAccountProfile']],
      ['content-read', ['discoverPublicContent', 'listOwnContent', 'getContent']],
      ['analytics-read', ['readAccountAnalytics', 'readContentAnalytics']],
      ['publish', ['submitPublish', 'getPublishStatus']],
    ],
    'the REAL declared matrix (the honest 4-of-5 SUBSET with the closed vocabularies — restriction-signals undeclared)',
  );
  // The REAL Facebook Login scope names (least privilege per family).
  const scopesOf = new Map(instagram.capabilities.map((capability) => [capability.family, [...capability.requiredScopes]]));
  assert.deepEqual(scopesOf.get('account'), [IG_BASIC, PAGES_SHOW_LIST]);
  assert.deepEqual(scopesOf.get('content-read'), [IG_BASIC, PAGES_READ_ENGAGEMENT]);
  assert.deepEqual(scopesOf.get('analytics-read'), [IG_BASIC, IG_MANAGE_INSIGHTS]);
  assert.deepEqual(scopesOf.get('publish'), [IG_BASIC, IG_CONTENT_PUBLISH, PAGES_SHOW_LIST, PAGES_READ_ENGAGEMENT]);
  // The INERTNESS proof: the registered adapter performed ZERO provider
  // traffic (no authorized Instagram connection exists yet — the
  // fail-closed chain precedes every provider call).
  assert.equal(double().totalRequestCount(), 0, 'the registration alone performs ZERO provider traffic');
});

// ---------------------------------------------------------------------------
// 3. The documented-semantics mappings through the REAL adapter
// ---------------------------------------------------------------------------

test('the REAL adapter maps the documented IG User node identity/profile facts (username, account_type, followers_count; verifiedAt null; the usage-header honesty)', async () => {
  const principal = await makeAgencyOwner('ig-identity@adapter.test');
  const clientId = await makeClient(principal, 'IG Identity Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeInstagramConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-identity-1', scopes: FULL_GRANT });

  const identity = await module().verifyAccountIdentity(accountId, PROVENANCE);
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.identity.externalAccountId, 'ig-user-identity-1');
  assert.equal(identity.identity.displayIdentity, 'fixture_ig-user-identity-1');
  // The documented node exposes no identity-verification timestamp — null (disclosed).
  assert.equal(identity.identity.verifiedAt, null);
  // The documented usage headers expose percentages, not the normalized
  // shape's fields — the honest null (disclosed; the double DID send
  // the documented X-App-Usage header, asserted below).
  assert.equal(identity.rateLimit, null);
  const appUsageHeader = double().lastAppUsageHeader();
  assert.ok(appUsageHeader !== null && appUsageHeader.includes('call_count'), 'the double sent the documented X-App-Usage usage header');

  const profile = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(profile.ok, true, JSON.stringify(profile));
  assert.equal(profile.profile.externalAccountId, 'ig-user-identity-1');
  // The provider's own account-type label rides verbatim (the documented account_type field).
  assert.equal(profile.profile.accountKind, 'BUSINESS');
  assert.equal(profile.profile.followerCount, 4242);
  // The provider payload rides VERBATIM as passthrough data.
  assert.equal((profile.profile.data as { username?: string }).username, 'fixture_ig-user-identity-1');
  assert.equal((profile.profile.data as { followers_count?: number }).followers_count, 4242);

  // The capability-matrix view composes the REAL scopes against the grant.
  const view = await module().resolveAccountCapabilityMatrix(accountId);
  assert.ok(view !== null && view.registered && view.authorizationUsable);
  assert.ok(view!.scopeSatisfaction.every((entry) => entry.satisfied), 'the full REAL-scope grant satisfies every capability');
});

test('AC: the ACCOUNT-TYPE HONESTY — a personal-account surface answers the documented error semantics as DATA, never a fabricated success', async () => {
  const principal = await makeAgencyOwner('ig-personal@adapter.test');
  const clientId = await makeClient(principal, 'IG Personal Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  // A PERSONAL Instagram account: the documented surface serves
  // Business/Creator accounts ONLY. The provider answers its OWN
  // documented error semantics on every documented endpoint.
  double().registerAccount({ igUserId: 'ig-user-personal-1', accountType: 'PERSONAL' });
  const connectionId = await makeInstagramConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-personal-1', scopes: FULL_GRANT });

  // The account family: the documented '(#10) The user is not an
  // Instagram Business' eligibility error → the honest restricted DATA
  // failure (an account-level limitation — exactly the MKT-057
  // youtubeSignupRequired precedent; NEVER a fabricated capability).
  const identity = await module().verifyAccountIdentity(accountId, PROVENANCE);
  assert.equal(identity.ok, false, JSON.stringify(identity));
  assert.equal(identity.failure.code, 'restricted');
  assert.ok(identity.failure.message.includes('(#10) The user is not an Instagram Business'), 'the documented eligibility message rides verbatim');
  assert.ok(identity.failure.message.includes('code 10'), 'the documented error code is named');

  const profile = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(profile.ok, false, JSON.stringify(profile));
  assert.equal(profile.failure.code, 'restricted');
  assert.ok(profile.failure.message.includes('(#10) The user is not an Instagram Business'));

  // The publish family: the same documented account-level error on the
  // container creation — an honest FAILED attempt on the fence (the
  // failure-code recording of the provider's own refusal; the verbatim
  // message is carried on the read operations' data failures above).
  const submit = await module().submitPublish(accountId, { idempotencyKey: 'ig-personal-key-1', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed', JSON.stringify(submit.attempt));
  assert.equal(submit.attempt.failureCode, 'restricted', 'the documented account-type eligibility block is the honest restricted failure on the ledger');
  // The provider DID answer (the account-type enforcement is the
  // provider's own documented semantics — not a fabricated capability).
  assert.ok(double().requestCount('container-create') >= 1, 'the provider answered the container creation with the documented code-10 refusal');

  // The content/analytics families refuse the same honest way.
  const own = await module().listOwnContent(accountId, { pageCursor: null, limit: 10 }, PROVENANCE);
  assert.equal(own.ok, false);
  assert.equal(own.failure.code, 'restricted');
  assert.ok(own.failure.message.includes('(#10) The user is not an Instagram Business'));
  const analytics = await module().readAccountAnalytics(accountId, { windowStart: null, windowEnd: null }, PROVENANCE);
  assert.equal(analytics.ok, false);
  assert.equal(analytics.failure.code, 'restricted');
});

test('the REAL adapter maps the documented hashtag discovery pagination + the honest NULL view/share engagement; the Media edge/node carry like/comments only', async () => {
  const principal = await makeAgencyOwner('ig-content@adapter.test');
  const clientId = await makeClient(principal, 'IG Content Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeInstagramConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-content-1', scopes: FULL_GRANT });

  // Public discovery: the documented ig_hashtag_search + top_media
  // round-trip over the data[]/paging.cursors.after protocol.
  const pageOne = await module().discoverPublicContent(accountId, { query: 'growth marketing', pageCursor: null, limit: 2 }, PROVENANCE);
  assert.equal(pageOne.ok, true, JSON.stringify(pageOne));
  assert.equal(pageOne.page.records.length, 2);
  assert.equal(pageOne.page.pageCursor, 'ig-page-2', 'the documented after cursor rides the page cursor');
  // The documented media node exposes like/comments but NO view
  // count (views are Insights metrics) and NO share count.
  assert.deepEqual(
    pageOne.page.records.map((record) => record.engagement.likeCount),
    [100, 200],
    'the documented hashtag media like_count rides verbatim',
  );
  assert.deepEqual(
    pageOne.page.records.map((record) => record.engagement.commentCount),
    [10, 20],
    'the documented hashtag media comments_count rides verbatim',
  );
  for (const record of pageOne.page.records) {
    assert.equal(record.engagement.viewCount, null, 'never fabricated');
    assert.equal(record.engagement.shareCount, null, 'never fabricated');
    assert.equal(record.contentFormat, 'IMAGE');
    assert.equal(record.authorExternalAccountId, null, 'the documented hashtag media fields expose no author identity');
  }
  const pageTwo = await module().discoverPublicContent(accountId, { query: 'growth marketing', pageCursor: pageOne.page.pageCursor, limit: 2 }, PROVENANCE);
  assert.equal(pageTwo.ok, true, JSON.stringify(pageTwo));
  assert.equal(pageTwo.page.records.length, 1);
  assert.equal(pageTwo.page.pageCursor, null, 'the last page carries no cursor');

  // The own-content listing (the Media edge): the account's media.
  const own = await module().listOwnContent(accountId, { pageCursor: null, limit: 10 }, PROVENANCE);
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(own.page.records.length, 5, 'the fixture account carries 5 media (3 photos + 1 video + 1 carousel)');
  for (const record of own.page.records) {
    assert.equal(record.engagement.viewCount, null, 'views are Insights metrics, never media-node fields');
    assert.equal(record.engagement.shareCount, null);
  }

  // The single-content read: the documented Media node fields.
  const single = await module().getContent(accountId, { providerContentId: 'ig-media-ig-user-content-1-1' }, PROVENANCE);
  assert.equal(single.ok, true, JSON.stringify(single));
  assert.ok(single.record !== null);
  assert.equal(single.record!.engagement.likeCount, 100);
  assert.equal(single.record!.engagement.commentCount, 10);
  assert.equal(single.record!.engagement.viewCount, null);
  assert.equal(single.record!.engagement.shareCount, null);
  assert.equal((single.record!.data as { media_type?: string }).media_type, 'IMAGE');
  assert.ok((single.record!.data as { permalink?: string }).permalink !== undefined, 'the provider payload rides VERBATIM');

  // An unknown media id: the documented code-100 error envelope — the
  // honest restricted data failure (the node-read surface has NO
  // empty-list semantics; disclosed).
  const unknown = await module().getContent(accountId, { providerContentId: 'ig-media-unknown' }, PROVENANCE);
  assert.equal(unknown.ok, false, JSON.stringify(unknown));
  assert.equal(unknown.failure.code, 'restricted');
  assert.ok(unknown.failure.message.includes('Object does not exist'), 'the documented code-100 semantics ride verbatim');
});

test('the REAL adapter maps the documented Insights edges (labels VERBATIM, day-period slices with end_time, the per-type media metric vocabulary)', async () => {
  const principal = await makeAgencyOwner('ig-analytics@adapter.test');
  const clientId = await makeClient(principal, 'IG Analytics Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeInstagramConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-analytics-1', scopes: FULL_GRANT });

  // The account insights: the documented day-period metric vocabulary,
  // the provider labels VERBATIM, the per-slice end_time stamps, and
  // windowStart null (the provider exposes no per-slice start).
  const accountAnalytics = await module().readAccountAnalytics(
    accountId,
    { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-31T00:00:00.000Z' },
    PROVENANCE,
  );
  assert.equal(accountAnalytics.ok, true, JSON.stringify(accountAnalytics));
  assert.deepEqual(
    [...new Set(accountAnalytics.observations.map((observation) => observation.metric))].sort(),
    ['follower_count', 'impressions', 'profile_views', 'reach'],
    'the provider metric labels ride VERBATIM',
  );
  assert.equal(accountAnalytics.observations.length, 12, 'each metric carries its day slices (4 metrics x 3 slices)');
  for (const observation of accountAnalytics.observations) {
    assert.equal(observation.windowStart, null, 'the provider exposes no per-slice start — never fabricated');
    assert.ok(observation.windowEnd !== null && observation.windowEnd.includes('2026-08-'), 'the provider end_time stamp rides verbatim');
  }
  assert.equal(accountAnalytics.observations[0]!.value, 42);

  // The per-media insights: the documented per-type vocabulary (the
  // media type resolved by ONE documented media-node read).
  const photoAnalytics = await module().readContentAnalytics(
    accountId,
    { providerContentIds: ['ig-media-ig-user-analytics-1-1'], windowStart: null, windowEnd: null },
    PROVENANCE,
  );
  assert.equal(photoAnalytics.ok, true, JSON.stringify(photoAnalytics));
  assert.deepEqual(
    photoAnalytics.observations.map((observation) => observation.metric),
    ['engagement', 'impressions', 'reach', 'saved'],
    'the documented IMAGE metric set',
  );
  for (const observation of photoAnalytics.observations) {
    assert.equal(observation.windowStart, null, 'lifetime aggregates carry no window');
    assert.equal(observation.windowEnd, null);
    assert.ok(observation.data['providerContentId'] === 'ig-media-ig-user-analytics-1-1');
  }
  assert.equal(photoAnalytics.observations[0]!.value, 110);

  // The VIDEO metric set (the documented type vocabulary difference).
  const videoAnalytics = await module().readContentAnalytics(
    accountId,
    { providerContentIds: ['ig-media-ig-user-analytics-1-video'], windowStart: null, windowEnd: null },
    PROVENANCE,
  );
  assert.equal(videoAnalytics.ok, true, JSON.stringify(videoAnalytics));
  assert.deepEqual(
    videoAnalytics.observations.map((observation) => observation.metric),
    ['engagement', 'impressions', 'reach', 'saved', 'video_views'],
    'the documented VIDEO metric set (+video_views)',
  );
});

// ---------------------------------------------------------------------------
// 4. The publish lifecycle (the documented container-based two-step publish)
// ---------------------------------------------------------------------------

test('AC: the CONTAINER publish lifecycle — create → the at-most-once fence → IN_PROGRESS poll → FINISHED → media_publish → published; ERROR → restricted; EXPIRED → failed', async () => {
  const principal = await makeAgencyOwner('ig-publish@adapter.test');
  const clientId = await makeClient(principal, 'IG Publish Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeInstagramConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-publish-1', scopes: FULL_GRANT });

  // STEP ONE (create): the documented media container creation — the
  // born 'accepted' submission (the container id is the provider
  // publish identity, NO content id exists yet).
  const createsBefore = double().requestCount('container-create');
  const submit = await module().submitPublish(accountId, { idempotencyKey: 'ig-publish-key-1', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'accepted', JSON.stringify(submit));
  assert.ok(submit.attempt.providerPublishId !== null);
  assert.ok(submit.attempt.providerPublishId.startsWith('ig-container-'), 'the provider publish identity is the container id');
  assert.equal(submit.attempt.providerContentId, null);
  assert.equal(submit.attempt.failureCode, null);
  assert.equal(double().requestCount('container-create'), createsBefore + 1, 'exactly ONE container creation reached the provider');

  // THE FENCE (replay idempotency): the same key is answered from the
  // recorded attempt — ZERO provider calls.
  const replay = await module().submitPublish(accountId, { idempotencyKey: 'ig-publish-key-1', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.attempt.attemptId, submit.attempt.attemptId);
  assert.equal(double().requestCount('container-create'), createsBefore + 1, 'the replay NEVER reached the provider (the at-most-once fence)');
  assert.equal(double().requestCount('media-publish'), 0, 'the publish step never fired for the replay');

  // The IN_PROGRESS poll: the documented container status — still processing.
  const first = await module().refreshPublishStatus(accountId, submit.attempt.attemptId, PROVENANCE);
  assert.equal(first.observation.publishState, 'accepted');
  assert.equal(first.observation.providerContentId, null);

  // STEP TWO (publish): the container finishes — the poll finds
  // FINISHED and fires the documented media_publish step.
  double().advanceContainer(submit.attempt.providerPublishId!, 'FINISHED');
  const second = await module().refreshPublishStatus(accountId, submit.attempt.attemptId, PROVENANCE);
  assert.equal(second.observation.publishState, 'published');
  assert.ok((second.observation.providerContentId ?? '').startsWith('ig-media-published-'), 'the media_publish answer carries the published media id');
  assert.equal(double().requestCount('media-publish'), 1, 'the documented second step fired exactly once');
  assert.equal(second.attempt.publishState, 'accepted', 'the attempt row keeps the SUBMIT-TIME fact');

  // The PUBLISHED poll: the documented container status surface exposes
  // NO content identity ({ id, status_code } only) — providerContentId
  // is null (DISCLOSED; the publish-time observation carried it).
  const third = await module().refreshPublishStatus(accountId, submit.attempt.attemptId, PROVENANCE);
  assert.equal(third.observation.publishState, 'published');
  assert.equal(third.observation.providerContentId, null, 'the documented container status surface carries no content identity');
  assert.equal(double().requestCount('media-publish'), 1, 'an already-published container never re-fires the publish step');

  // The append-only observation history: one immutable observation per poll.
  const history = await module().listPublishStatusObservations(accountId, submit.attempt.attemptId);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((observation) => observation.publishState),
    ['accepted', 'published', 'published'],
  );

  // The ERROR container: the provider's own processing-failure status —
  // the honest 'restricted' outcome with the signal.
  const rejected = await module().submitPublish(accountId, { idempotencyKey: 'ig-publish-key-error', request: PUBLISH_REQUEST }, PROVENANCE);
  double().advanceContainer(rejected.attempt.providerPublishId!, 'ERROR', { statusText: 'The video container failed to process the media.' });
  const rejectedPoll = await module().refreshPublishStatus(accountId, rejected.attempt.attemptId, PROVENANCE);
  assert.equal(rejectedPoll.observation.publishState, 'restricted');
  assert.equal(rejectedPoll.observation.failureCode, null, 'a restricted outcome is not a taxonomy failure — the signal carries it');
  assert.equal(rejectedPoll.observation.restrictionSignals[0]!.signalKind, 'ig-container.status_code.ERROR');
  assert.equal(rejectedPoll.observation.restrictionSignals[0]!.data['status'], 'The video container failed to process the media.');

  // The EXPIRED container: the documented 24-hour container expiry —
  // the honest 'failed' outcome with the provider's own semantics.
  const expired = await module().submitPublish(accountId, { idempotencyKey: 'ig-publish-key-expired', request: PUBLISH_REQUEST }, PROVENANCE);
  double().advanceContainer(expired.attempt.providerPublishId!, 'EXPIRED');
  const expiredPoll = await module().refreshPublishStatus(accountId, expired.attempt.attemptId, PROVENANCE);
  assert.equal(expiredPoll.observation.publishState, 'failed');
  assert.ok((expiredPoll.observation.providerFailureReason ?? '').includes('status_code=EXPIRED'));
});

test('the documented 24-hour publish window exhaustion (content_publishing_limit) surfaces as rate-limited DATA on the publish step', async () => {
  const principal = await makeAgencyOwner('ig-quota@adapter.test');
  const clientId = await makeClient(principal, 'IG Quota Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeInstagramConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-quota-1', scopes: FULL_GRANT });

  // The documented quota: quota_total 1 for this battery (the
  // account-level 24h publish window; the double enforces it on the
  // media_publish step).
  double().setDailyPublishLimit(1);
  const first = await module().submitPublish(accountId, { idempotencyKey: 'ig-quota-key-1', request: PUBLISH_REQUEST }, PROVENANCE);
  double().advanceContainer(first.attempt.providerPublishId!, 'FINISHED');
  const firstPoll = await module().refreshPublishStatus(accountId, first.attempt.attemptId, PROVENANCE);
  assert.equal(firstPoll.observation.publishState, 'published', 'the first publish fits the window');

  // The SECOND publish: the window is exhausted — the documented
  // request-limit error class surfaces as the honest rate-limited DATA
  // (the observation records the failure code).
  const second = await module().submitPublish(accountId, { idempotencyKey: 'ig-quota-key-2', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(second.attempt.publishState, 'accepted', JSON.stringify(second.attempt));
  double().advanceContainer(second.attempt.providerPublishId!, 'FINISHED');
  const secondPoll = await module().refreshPublishStatus(accountId, second.attempt.attemptId, PROVENANCE);
  assert.equal(secondPoll.observation.publishState, 'accepted', 'the attempt keeps the last-known state on the failed poll');
  assert.equal(secondPoll.observation.failureCode, 'rate-limited', 'the documented 24h publish window exhaustion is honest rate-limited data');
  double().resetPublishWindow();
  double().setDailyPublishLimit(50);
});

test('the documented hashtag rate window (30 unique hashtags / 7 days) surfaces as rate-limited DATA', async () => {
  const principal = await makeAgencyOwner('ig-hashtag@adapter.test');
  const clientId = await makeClient(principal, 'IG Hashtag Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeInstagramConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-hashtag-1', scopes: FULL_GRANT });

  // The documented window: 2 unique hashtags for this battery.
  double().setHashtagWindowLimit(2);
  const first = await module().discoverPublicContent(accountId, { query: 'alpha', pageCursor: null, limit: 1 }, PROVENANCE);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await module().discoverPublicContent(accountId, { query: 'beta', pageCursor: null, limit: 1 }, PROVENANCE);
  assert.equal(second.ok, true, JSON.stringify(second));
  // A repeat query of an already-queried hashtag does not consume the window.
  const repeat = await module().discoverPublicContent(accountId, { query: 'alpha', pageCursor: null, limit: 1 }, PROVENANCE);
  assert.equal(repeat.ok, true, 'the repeat hashtag rides the documented window semantics');
  // A THIRD unique hashtag beyond the window: the documented
  // request-limit error class — honest rate-limited data.
  const exhausted = await module().discoverPublicContent(accountId, { query: 'gamma', pageCursor: null, limit: 1 }, PROVENANCE);
  assert.equal(exhausted.ok, false, JSON.stringify(exhausted));
  assert.equal(exhausted.failure.code, 'rate-limited');
  assert.ok(exhausted.failure.message.includes('unique hashtags'), 'the documented hashtag rate surface is named');
  double().resetHashtagWindow();
  double().setHashtagWindowLimit(30);
});

// ---------------------------------------------------------------------------
// 5. The seven-code taxonomy over the documented Graph API error envelope
// ---------------------------------------------------------------------------

test('the REAL adapter classifies the documented Graph API error envelope onto the frozen taxonomy (code 190 / code 4 with the regain observation / code 10 / 5xx)', async () => {
  const principal = await makeAgencyOwner('ig-taxonomy@adapter.test');
  const clientId = await makeClient(principal, 'IG Taxonomy Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeInstagramConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-taxonomy-1', scopes: FULL_GRANT });

  // Code 190 (OAuthException, HTTP 400 — the Graph token-death norm) →
  // auth-expired (the reauthorization signal).
  double().scriptFailure('user-node', { status: 400, code: 190, message: '(#190) The access token could not be decrypted', type: 'OAuthException' });
  const unauthorized = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.failure.code, 'auth-expired');
  assert.ok(unauthorized.failure.message.includes('code 190'));

  // Code 4 (the documented app-level request-limit class) with the
  // documented X-Business-Use-Case-Usage regain-capacity header →
  // rate-limited WITH the observable backoff observation.
  double().scriptFailure('user-node', { status: 400, code: 4, message: '(#4) Application request limit reached', type: 'OAuthException', retryAfterSeconds: 30 });
  const rateLimited = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.failure.code, 'rate-limited');
  assert.equal(rateLimited.failure.rateLimit?.retryAfterSeconds, 30, 'the documented regain-capacity seconds ride the rate-limit observation');
  assert.ok(rateLimited.failure.rateLimit?.backoffUntil !== null);

  // Code 10 (the documented permission/eligibility class) → restricted.
  double().scriptFailure('user-node', { status: 400, code: 10, message: '(#10) Application does not have permission for this action', type: 'OAuthException' });
  const forbidden = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.failure.code, 'restricted');
  assert.ok(forbidden.failure.message.includes('permission/account-type eligibility block'));

  // 500 (the server-error class) → provider-unavailable (the retryable transport class).
  double().scriptFailure('user-node', { status: 500, code: 2, message: 'Service temporarily unavailable', type: 'OAuthException' });
  const unavailable = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.failure.code, 'provider-unavailable');
  double().scriptFailure('user-node', null);
  const recovered = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(recovered.ok, true, 'clearing the scripting recovers');
});

test('the transport-refused provider maps to provider-unavailable (the dead data-plane base URL)', async () => {
  // A closed loopback port: the documented https-or-loopback envelope
  // permits the loopback target; the connection is refused.
  const deadServer = net.createServer();
  await new Promise<void>((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
  const deadPort = (deadServer.address() as AddressInfo).port;
  await new Promise<void>((resolve) => deadServer.close(() => resolve()));

  const principal = await makeAgencyOwner('ig-transport@adapter.test');
  const clientId = await makeClient(principal, 'IG Transport Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  // The connection's providerConfig points the data plane at the dead port.
  const connectionId = await makeInstagramConnection(principal, clientId, { apiBaseUrl: `http://127.0.0.1:${deadPort}` });
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-transport-1', scopes: FULL_GRANT });

  const outcome = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.code, 'provider-unavailable', JSON.stringify(outcome.failure));
  assert.ok(outcome.failure.message.includes('transport refused'));
});

// ---------------------------------------------------------------------------
// 6. The strict REAL-scope pre-flight over the real adapter
// ---------------------------------------------------------------------------

test('the strict scope pre-flight refuses analytics + publish on the read-only REAL-scope grant (zero provider traffic)', async () => {
  const principal = await makeAgencyOwner('ig-scopes@adapter.test');
  const clientId = await makeClient(principal, 'IG Scopes Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeInstagramConnection(principal, clientId);
  // The read-only grant: no instagram_manage_insights, no
  // instagram_content_publish — the analytics + publish families
  // require their REAL scopes.
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-scopes-1', scopes: READ_ONLY_GRANT });

  const view = await module().resolveAccountCapabilityMatrix(accountId);
  assert.ok(view !== null && view.authorizationUsable);
  const satisfaction = new Map(view!.scopeSatisfaction.map((entry) => [entry.family, entry]));
  assert.equal(satisfaction.get('account')!.satisfied, true);
  assert.equal(satisfaction.get('content-read')!.satisfied, true);
  assert.equal(satisfaction.get('analytics-read')!.satisfied, false);
  assert.deepEqual(satisfaction.get('analytics-read')!.missingScopes, [IG_MANAGE_INSIGHTS]);
  assert.equal(satisfaction.get('publish')!.satisfied, false);
  assert.deepEqual(satisfaction.get('publish')!.missingScopes, [IG_CONTENT_PUBLISH]);

  const accountInsightsBefore = double().requestCount('account-insights');
  const analytics = await module().readAccountAnalytics(accountId, { windowStart: null, windowEnd: null }, PROVENANCE);
  assert.equal(analytics.ok, false);
  assert.equal(analytics.failure.code, 'insufficient-scope');
  assert.ok(analytics.failure.message.includes(IG_MANAGE_INSIGHTS), 'the missing REAL scope is named verbatim');
  assert.equal(double().requestCount('account-insights'), accountInsightsBefore, 'zero provider traffic on the scope refusal');

  const createBefore = double().requestCount('container-create');
  const publish = await module().submitPublish(accountId, { idempotencyKey: 'ig-scope-refused-key', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(publish.duplicate, false);
  assert.equal(publish.attempt.publishState, 'failed');
  assert.equal(publish.attempt.failureCode, 'insufficient-scope', 'the pre-flight refusal is RECORDED on the fence');
  assert.equal(double().requestCount('container-create'), createBefore, 'the refused publish never reached the provider');
});

// ---------------------------------------------------------------------------
// 7. The capability-subset enforcement over the real adapter (the named AC)
// ---------------------------------------------------------------------------

test('AC: the CAPABILITY-SUBSET enforcement — the undeclared restriction-signals family refuses fail-closed with ZERO provider traffic', async () => {
  const principal = await makeAgencyOwner('ig-subset@adapter.test');
  const clientId = await makeClient(principal, 'IG Subset Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeInstagramConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { igUserId: 'ig-user-subset-1', scopes: FULL_GRANT });

  // The capability-matrix view honestly carries NO restriction-signals family.
  const view = await module().resolveAccountCapabilityMatrix(accountId);
  assert.ok(view !== null && view.registered && view.authorizationUsable);
  assert.ok(!view!.capabilities.some((capability) => capability.family === 'restriction-signals'), 'the undeclared family is absent from the account view');

  // The undeclared operation refuses fail-closed as DATA (zero policy
  // evaluation, zero credential resolution, zero provider traffic — the
  // 056 fail-closed chain's first gate).
  const totalBefore = double().totalRequestCount();
  const signals = await module().readRestrictionSignals(accountId, PROVENANCE);
  assert.equal(signals.ok, false, JSON.stringify(signals));
  assert.equal(signals.failure.code, 'unsupported-capability');
  assert.ok(signals.failure.message.includes("does not declare the 'readRestrictionSignals' operation"));
  assert.ok(signals.failure.message.includes('declared families: account, content-read, analytics-read, publish'));
  assert.equal(double().totalRequestCount(), totalBefore, 'the undeclared operation NEVER reached the provider');
});
