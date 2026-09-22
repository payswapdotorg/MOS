/**
 * MKT-059 integration tests — the FACEBOOK PAGES social platform adapter
 * on the REAL stack: embedded PostgreSQL 18, the spawned production API
 * and IN-PROCESS applications composed through the disclosed seams.
 *
 * Two proofs, each with its own disclosed double at the provider
 * boundary ONLY (the contract HOST under test — the capability gates,
 * the strict scope pre-flight, the /policies fail-closed gates, the
 * migration-050 idempotency fence, the claim-then-fill ledger — is
 * fully REAL in both — the MKT-057/MKT-058 pattern):
 *
 *   1. THE CONFORMANCE SUITE (the dispatch AC): the full 17-scenario
 *      MKT-056 battery
 *      (tests/integration/helpers/social-adapter-conformance.ts) runs
 *      against the disclosed IN-MEMORY Facebook Pages platform double
 *      (tests/integration/helpers/facebook-pages-platform-double.ts —
 *      the documented-API behavioral model: the /me/accounts
 *      page-resolution echo, cursor pagination, the scheduled/unpublished
 *      post lifecycle, the honest 4-of-5 capability matrix, failure
 *      injection) with the REAL Facebook Login scope names as the
 *      fixture grants (the documented test-only suite extension —
 *      Facebook Pages' real scopes fall outside the default fixture
 *      vocabulary). The honest 4-of-5 matrix fires 16 of the 17
 *      scenarios (the restriction-signal scenario is structurally
 *      SKIPPED — the family is honestly undeclared; the
 *      capability-subset scenario EXERCISES the undeclared family's
 *      fail-closed refusal end-to-end with zero provider traffic);
 *
 *   2. THE REAL ADAPTER END-TO-END (the composition-root registration
 *      proof): the application boots with NO socialPlatformAdapters
 *      seam — the PRODUCTION-composed Facebook Pages adapter (the
 *      MKT-059 composition-root registration, the platform FetchHttpCall
 *      transport) serves every operation through the module API against
 *      the disclosed COMBINED provider double
 *      (tests/integration/helpers/facebook-pages-http-double.ts — the
 *      loopback HTTP server faithfully mirroring the documented Facebook
 *      Graph API Pages + Facebook Login OAuth planes): the REAL matrix +
 *      REAL scopes + inertness · the documented /me/accounts → page +
 *      page-token resolution and the Page node identity/profile · THE
 *      ACCOUNT-TYPE HONESTY (a user without a Page resolves ZERO
 *      accounts through the documented surface — never a fabricated
 *      success) · THE PAGE-ROLE/TASK HONESTY (the task-restricted Page
 *      role answers the documented code-200 permissions-error semantics
 *      as DATA) · the feed/posts pagination + the honest null view
 *      engagement · the documented Page/post insights vocabularies ·
 *      THE PUBLISH LIFECYCLE (the immediate synchronous publish → born
 *      published; the SCHEDULED post → born accepted → the scheduled
 *      window arrival → published; the video processing window; the
 *      replay idempotency with ZERO provider calls) · the documented
 *      Pages BUC rate surface (code 80001 + the regain-capacity
 *      observation as DATA) · the documented error taxonomy (code 190 /
 *      code 4 with the regain observation / code 10 / 5xx /
 *      transport-refused) · the strict REAL-scope pre-flight (zero
 *      provider traffic) · the capability-subset enforcement (zero
 *      provider traffic).
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
import { createLocalOAuthFlow } from './helpers/oauth-provider.ts';
import { createReferenceIntegrationStub, runSocialAdapterConformanceSuite } from './helpers/social-adapter-conformance.ts';
import {
  startFacebookPagesProviderDouble,
  type FacebookPagesProviderDouble,
} from './helpers/facebook-pages-http-double.ts';
import {
  createFacebookPagesPlatformDouble,
  FACEBOOK_PAGES_FULL_SCOPES,
  FACEBOOK_PAGES_READ_ONLY_SCOPES,
} from './helpers/facebook-pages-platform-double.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'social-adapter-facebook-pages-pipe-key';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-0000000000ee',
  recordedVia: 'test',
  correlationId: 'integration-social-adapter-facebook-pages-1',
  causationId: null,
} as const;

/** The REAL Facebook Login scope names the adapter declares (the strict pre-flight vocabulary). */
const PAGES_SHOW_LIST = 'pages_show_list';
const PAGES_READ_ENGAGEMENT = 'pages_read_engagement';
const PAGES_READ_USER_CONTENT = 'pages_read_user_content';
const PAGES_MANAGE_POSTS = 'pages_manage_posts';
const READ_INSIGHTS = 'read_insights';
const FULL_GRANT = [PAGES_SHOW_LIST, PAGES_READ_ENGAGEMENT, PAGES_READ_USER_CONTENT, PAGES_MANAGE_POSTS, READ_INSIGHTS] as const;
const READ_ONLY_GRANT = [PAGES_SHOW_LIST, PAGES_READ_ENGAGEMENT, PAGES_READ_USER_CONTENT, READ_INSIGHTS] as const;

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: FacebookPagesProviderDouble | null = null;
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
function double(): FacebookPagesProviderDouble {
  if (provider === null) throw new Error('provider double not booted');
  return provider;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('social_fb_pages_real');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startFacebookPagesProviderDouble();
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  // NO socialPlatformAdapters seam: the PRODUCTION-composed Facebook
  // Pages adapter (the MKT-059 composition-root registration on the
  // platform FetchHttpCall transport) serves every operation of this
  // battery.
  const core = await bootstrapApplication({
    integrationAdapters: [createReferenceIntegrationStub('facebook-pages')],
    socialAccountFlows: [
      createLocalOAuthFlow(provider, { adapterKey: 'facebook-pages', secretsDir: stack.env.secretsDir }),
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
/** Creates + connects the facebook-pages-keyed integration connection (providerConfig points the REAL adapter at the double). */
async function makeFacebookPagesConnection(
  principal: Principal,
  clientId: string,
  providerConfig: Record<string, string> = {},
): Promise<string> {
  connectionSequence += 1;
  const credential = await credentialsModule().createCredentialReference({
    agencyId: principal.agencyId,
    clientId,
    kind: 'integration_api_key',
    // NOTE: the credential-label grammar carries no dashes — the
    // platform key's dashes are slugified (the conformance-suite
    // precedent).
    label: `fb_pages_pipe_${clientId.slice(0, 8)}_${connectionSequence}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection(
    {
      clientId,
      adapterKey: 'facebook-pages',
      credentialReferenceId: credential.credentialId,
      // The documented deployment override surface: the Graph API base
      // URL of the connection (apiBaseUrl) points the production
      // adapter at the loopback provider double.
      providerConfig: {
        apiBaseUrl: double().url,
        platformHint: 'facebook-pages',
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
    readonly pageId: string;
    readonly scopes: readonly string[];
    readonly capabilityTags?: readonly string[];
  },
): Promise<string> {
  const start = await module().startAuthorization(
    { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...fixture.scopes], expectedAccountId: null },
    PROVENANCE,
  );
  const issued = double().issueAuthorization({
    accountId: fixture.pageId,
    displayIdentity: `fb-page:${fixture.pageId}`,
    verifiedAt: '2026-07-01T09:30:00.000Z',
    scopes: [...fixture.scopes],
    capabilityTags: fixture.capabilityTags ?? ['facebook-pages-tag'],
    expiresInMs: 3_600_000,
  });
  const completion = await module().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    PROVENANCE,
  );
  return completion.account.socialAccountId;
}

const PUBLISH_REQUEST = {
  contentType: 'facebook-pages.feed-post',
  payload: { message: 'The documented Page feed post message.', link: 'https://example.com/page-post' },
  mediaAssets: [] as const,
  attribution: { missionId: 'mission-fb-1', experimentId: 'exp-fb-1' },
  scheduledFor: null,
} as const;

// ---------------------------------------------------------------------------
// 1. The conformance suite (the dispatch AC — the in-memory double + REAL scopes)
// ---------------------------------------------------------------------------

test('AC: the Facebook Pages platform double passes the MKT-056 social adapter conformance suite (the REAL Facebook Login scope fixtures; the honest 4-of-5 matrix)', async () => {
  const suiteProvider = await startFacebookPagesProviderDouble();
  const suiteAdapter = createFacebookPagesPlatformDouble();
  try {
    const report = await runSocialAdapterConformanceSuite({
      adapter: suiteAdapter,
      adapterHandle: suiteAdapter,
      provider: suiteProvider,
      label: 'facebook-pages',
      fullScopes: [...FACEBOOK_PAGES_FULL_SCOPES],
      readOnlyScopes: [...FACEBOOK_PAGES_READ_ONLY_SCOPES],
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
    // SKIPPED (the family is undeclared — the documented Pages surface
    // exposes no restriction-signal endpoint) and the
    // capability-subset scenario EXERCISES the undeclared family's
    // fail-closed refusal.
    assert.ok(!names.includes('restriction-signal read'), 'the restriction-signals family is honestly UNDECLARED');
    assert.equal(report.scenarios.length, 16, '16 of the 17 scenarios fire (the restriction-signal scenario is structurally skipped for the honest 4-of-5 matrix)');
  } finally {
    await suiteProvider.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The composition-root registration (the production adapter as DATA)
// ---------------------------------------------------------------------------

test('the composition root registers the Facebook Pages adapter as production DATA — the REAL honest 4-of-5 matrix, INERT without a connection', async () => {
  // The registration is data: the registry exposes the REAL descriptor + matrix.
  const registered = module().listRegisteredSocialAdapters();
  const facebookPages = registered.find((info) => info.descriptor.adapterKey === 'facebook-pages');
  assert.ok(facebookPages !== undefined, 'the production composition registered the Facebook Pages adapter');
  assert.equal(facebookPages.descriptor.providerLabel, 'Facebook Pages (Graph API Pages surface)');
  assert.deepEqual(
    facebookPages.capabilities.map((capability) => [capability.family, [...capability.operations]]),
    [
      ['account', ['verifyAccountIdentity', 'getAccountProfile']],
      ['content-read', ['discoverPublicContent', 'listOwnContent', 'getContent']],
      ['analytics-read', ['readAccountAnalytics', 'readContentAnalytics']],
      ['publish', ['submitPublish', 'getPublishStatus']],
    ],
    'the REAL declared matrix (the honest 4-of-5 SUBSET with the closed vocabularies — restriction-signals undeclared)',
  );
  // The REAL Facebook Login scope names (least privilege per family).
  const scopesOf = new Map(facebookPages.capabilities.map((capability) => [capability.family, [...capability.requiredScopes]]));
  assert.deepEqual(scopesOf.get('account'), [PAGES_SHOW_LIST]);
  assert.deepEqual(scopesOf.get('content-read'), [PAGES_READ_ENGAGEMENT, PAGES_READ_USER_CONTENT, PAGES_SHOW_LIST]);
  assert.deepEqual(scopesOf.get('analytics-read'), [PAGES_READ_ENGAGEMENT, READ_INSIGHTS, PAGES_SHOW_LIST]);
  assert.deepEqual(scopesOf.get('publish'), [PAGES_MANAGE_POSTS, PAGES_READ_ENGAGEMENT, PAGES_SHOW_LIST]);
  // The INERTNESS proof: the registered adapter performed ZERO provider
  // traffic (no authorized facebook-pages connection exists yet — the
  // fail-closed chain precedes every provider call).
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
  principal = await makeAgencyOwner('fb-pages-owner@marketingos.test');
  clientId = (await apiCall(port(), `/api/agencies/${principal.agencyId}/clients`, {
    token: principal.token,
    body: { name: 'Facebook Pages Client' },
  })).body['clientId'] as string;
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeFacebookPagesConnection(principal, clientId);
  accountId = await connectAccount(clientId, connectionId, {
    pageId: 'fb-page-main-1',
    scopes: FULL_GRANT,
  });
  return { principal, clientId, accountId };
}

test('the REAL adapter maps the documented /me/accounts → page + page-token resolution and the Page node identity/profile facts (name, category, followers_count; verifiedAt null; the usage-header honesty)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // verifyAccountIdentity = the documented /me/accounts page resolution.
  const identity = await module().verifyAccountIdentity(account, PROVENANCE);
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.identity.externalAccountId, 'fb-page-main-1');
  assert.equal(identity.identity.displayIdentity, 'Page of fb-page-main-1');
  assert.equal(identity.identity.verifiedAt, null, 'the documented surface exposes no verification timestamp');
  // getAccountProfile = the resolution + the documented Page node read.
  const profile = await module().readAccountProfile(account, PROVENANCE);
  assert.equal(profile.ok, true, JSON.stringify(profile));
  assert.equal(profile.profile.externalAccountId, 'fb-page-main-1');
  assert.equal(profile.profile.displayIdentity, 'Page of fb-page-main-1');
  assert.equal(profile.profile.accountKind, 'Marketing Agency', "the provider's own Page category label rides verbatim");
  assert.equal(profile.profile.followerCount, 1337);
  assert.deepEqual(
    { followers: profile.profile.data['followers_count'], fans: profile.profile.data['fan_count'] },
    { followers: 1337, fans: 2048 },
    'the documented Page node fields ride VERBATIM as passthrough',
  );
  // The documented page-resolution call verifiably happened (the
  // /me/accounts endpoint received the requests).
  assert.ok(double().requestCount('accounts') >= 2, 'the documented /me/accounts page resolution verifiably ran');
  // The honest usage-header fidelity: the double verifiably sends the
  // documented X-App-Usage percentages; the adapter verifiably reports
  // the honest null (percentages do not map onto the observation shape).
  assert.ok(double().lastAppUsageHeader() !== null);
  assert.equal(profile.rateLimit, null, 'the documented usage headers are percentages — the honest null, never fabricated integers');
});

test('AC: the ACCOUNT-TYPE HONESTY — a user WITHOUT a Page resolves ZERO accounts through the documented /me/accounts surface; every operation refuses as DATA, never a fabricated success', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  // The no-page fixture: the documented /me/accounts answer is the
  // EMPTY data[] list (zero accounts — the user has no Page).
  double().registerAccount({ pageId: 'fb-page-nopage-1', accountType: 'no-page' });
  const connectionId = await makeFacebookPagesConnection(owner, client);
  const noPageAccount = await connectAccount(client, connectionId, {
    pageId: 'fb-page-nopage-1',
    scopes: FULL_GRANT,
  });
  const accountsBefore = double().requestCount('accounts');
  // EVERY declared family refuses through the documented surface —
  // identity, profile, discovery, listing, single read, analytics AND
  // publish — as honest restricted DATA (never a fabricated success).
  for (const [label, outcome] of [
    ['verifyAccountIdentity', await module().verifyAccountIdentity(noPageAccount, PROVENANCE)],
    ['readAccountProfile', await module().readAccountProfile(noPageAccount, PROVENANCE)],
    ['discoverPublicContent', await module().discoverPublicContent(noPageAccount, { query: 'page content', pageCursor: null, limit: 5 }, PROVENANCE)],
    ['listOwnContent', await module().listOwnContent(noPageAccount, { pageCursor: null, limit: 5 }, PROVENANCE)],
    ['getContent', await module().getContent(noPageAccount, { providerContentId: 'unknown-post-1' }, PROVENANCE)],
    ['readAccountAnalytics', await module().readAccountAnalytics(noPageAccount, { windowStart: null, windowEnd: null }, PROVENANCE)],
  ] as const) {
    assert.ok(!outcome.ok, `${label} refuses for the zero-page account`);
    assert.equal(outcome.failure.code, 'restricted', `${label} surfaces the documented eligibility answer as restricted DATA`);
    assert.ok(
      outcome.failure.message.includes('zero-account') || outcome.failure.message.includes('not among the Pages'),
      `${label} carries the documented /me/accounts honesty`,
    );
  }
  // The publish path: the attempt records the honest restricted refusal
  // (the frozen host ledger maps an adapter data failure onto the failed
  // state with the taxonomy code — the honest recorded refusal).
  const submit = await module().submitPublish(
    noPageAccount,
    {
      idempotencyKey: 'fb-nopage-publish-1',
      request: {
        contentType: 'facebook-pages.feed-post',
        payload: { message: 'Never published — no Page.' },
        mediaAssets: [],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed');
  assert.equal(submit.attempt.failureCode, 'restricted', 'the documented account-type eligibility block is the honest restricted failure on the ledger');
  // The provider verifiably answered through the documented surface
  // (the /me/accounts resolution ran and answered the empty list).
  assert.ok(double().requestCount('accounts') > accountsBefore, 'the provider verifiably answered the documented resolution calls');
  assert.equal(double().requestCount('feed-publish'), 0, 'no publish ever reached the provider');
});

test('the PAGE-ROLE/TASK HONESTY — a task-restricted Page role surfaces the documented code-200 permissions-error semantics as DATA (never adapter-side role policy)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  // The task-restricted fixture: the user's Page role carries the
  // ANALYZE + ADVERTISE tasks only (no CREATE_CONTENT / MANAGE /
  // MODERATE) — the page token resolves, but the task-gated surfaces
  // answer the provider's OWN documented error semantics.
  double().registerAccount({ pageId: 'fb-page-taskrestricted-1', accountType: 'task-restricted' });
  const connectionId = await makeFacebookPagesConnection(owner, client);
  const taskAccount = await connectAccount(client, connectionId, {
    pageId: 'fb-page-taskrestricted-1',
    scopes: FULL_GRANT,
  });
  // The account family stays GREEN (the page resolution succeeds — the
  // role facts ride the /me/accounts answer verbatim).
  const identity = await module().verifyAccountIdentity(taskAccount, PROVENANCE);
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.identity.externalAccountId, 'fb-page-taskrestricted-1');
  // The ANALYZE-gated insights stay GREEN (the documented insights task).
  const analytics = await module().readAccountAnalytics(taskAccount, { windowStart: null, windowEnd: null }, PROVENANCE);
  assert.equal(analytics.ok, true, JSON.stringify(analytics));
  assert.ok(analytics.observations.length > 0);
  // The task-gated content reads answer the documented code-200
  // permissions-error semantics as restricted DATA.
  const feed = await module().discoverPublicContent(taskAccount, { query: 'anything', pageCursor: null, limit: 5 }, PROVENANCE);
  assert.ok(!feed.ok);
  assert.equal(feed.failure.code, 'restricted');
  assert.ok(feed.failure.message.includes('code 200'), 'the documented code-200 permissions-error class rides the message');
  // The task-gated publish answers the same documented semantics; the
  // attempt records the honest restricted refusal (the frozen host
  // ledger maps the adapter data failure onto the failed state with
  // the taxonomy code).
  const submit = await module().submitPublish(
    taskAccount,
    {
      idempotencyKey: 'fb-taskrestricted-publish-1',
      request: {
        contentType: 'facebook-pages.feed-post',
        payload: { message: 'Never published — the role lacks CREATE_CONTENT.' },
        mediaAssets: [],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed');
  assert.equal(submit.attempt.failureCode, 'restricted', 'the documented Page-role/task refusal is the honest restricted failure on the ledger');
  assert.ok(
    String(submit.attempt.providerFailureReason ?? '').includes('200') || submit.attempt.failureCode === 'restricted',
    'the refusal is carried as data',
  );
});

test('the REAL adapter maps the documented feed/posts pagination + the engagement facts (the reactions/comments summaries + shares; the honest NULL view count; the author identities)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // The feed edge (the public discovery surface: the Page's own posts +
  // the visitor posts; the caller query honestly unused — the documented
  // edge carries no query parameter).
  const discovery = await module().discoverPublicContent(account, { query: 'growth marketing', pageCursor: null, limit: 4 }, PROVENANCE);
  assert.equal(discovery.ok, true, JSON.stringify(discovery));
  assert.ok(discovery.page.records.length > 0);
  // The documented Page feed carries the Page's own posts AND the
  // visitor/user posts (the public discovery surface — other authors'
  // posts on the Page).
  const feedAuthors = new Set(discovery.page.records.map((record) => record.authorExternalAccountId));
  assert.ok(feedAuthors.has('fb-page-main-1'), 'the Page\'s own posts ride the feed');
  assert.ok(feedAuthors.has('visitor-fb-page-main-1-0'), 'the visitor/user posts ride the feed (the discovery surface)');
  const feedRecord = discovery.page.records.find((record) => record.authorExternalAccountId === 'visitor-fb-page-main-1-0')!;
  assert.equal(feedRecord.engagement.viewCount, null, 'the Post node exposes NO view count — null, never fabricated');
  assert.equal(feedRecord.engagement.likeCount, 20, 'the reactions summary total rides as the like-count fact');
  assert.equal(feedRecord.engagement.commentCount, 4, 'the comments summary total rides as the comment-count fact');
  assert.equal(feedRecord.engagement.shareCount, 2, 'the shares count rides as the share-count fact');
  assert.ok(discovery.page.pageCursor !== null, 'the documented data[]/paging.cursors.after pagination carries the next-page cursor');
  const discoveryPageTwo = await module().discoverPublicContent(account, { query: 'growth marketing', pageCursor: discovery.page.pageCursor, limit: 4 }, PROVENANCE);
  assert.equal(discoveryPageTwo.ok, true);
  assert.notEqual(discoveryPageTwo.page.records[0]?.providerContentId, discovery.page.records[0]?.providerContentId);
  // The posts edge (the own-content listing: the Page's own published posts).
  const own = await module().listOwnContent(account, { pageCursor: null, limit: 2 }, PROVENANCE);
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.ok(own.page.records.length > 0);
  const ownRecord = own.page.records[0]!;
  assert.equal(ownRecord.authorExternalAccountId, 'fb-page-main-1', 'the own posts carry the Page author identity');
  assert.equal(ownRecord.engagement.viewCount, null);
  assert.equal(ownRecord.engagement.likeCount, 50);
  assert.equal(ownRecord.engagement.commentCount, 5);
  assert.equal(ownRecord.engagement.shareCount, 3);
  // The single-content read (the Post node).
  const single = await module().getContent(account, { providerContentId: ownRecord.providerContentId }, PROVENANCE);
  assert.equal(single.ok, true, JSON.stringify(single));
  assert.ok(single.record !== null);
  assert.equal(single.record!.providerContentId, ownRecord.providerContentId);
  assert.deepEqual(single.record!.engagement, ownRecord.engagement);
  // An unknown content id answers the documented code-100 envelope as
  // the honest restricted data failure.
  const unknown = await module().getContent(account, { providerContentId: 'not-a-real-post' }, PROVENANCE);
  assert.ok(!unknown.ok);
  assert.equal(unknown.failure.code, 'restricted');
  assert.ok(unknown.failure.message.includes('code 100'));
});

test('the REAL adapter maps the documented Page insights edges (labels VERBATIM, day-period slices with end_time, the lifetime post aggregates)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // The account report: the documented live day-period metric
  // vocabulary, provider labels VERBATIM, per-slice end_time stamps.
  const accountAnalytics = await module().readAccountAnalytics(
    account,
    { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-31T00:00:00.000Z' },
    PROVENANCE,
  );
  assert.equal(accountAnalytics.ok, true, JSON.stringify(accountAnalytics));
  const metricNames = new Set(accountAnalytics.observations.map((observation) => observation.metric));
  for (const expected of ['page_impressions', 'page_post_engagements', 'page_views_total', 'page_fans']) {
    assert.ok(metricNames.has(expected), `the documented Page metric '${expected}' rides VERBATIM`);
  }
  for (const observation of accountAnalytics.observations) {
    assert.equal(observation.windowStart, null, 'the provider exposes no per-slice start — null, never fabricated');
    assert.ok(
      observation.windowEnd === '2026-08-05T00:00:00.000Z' ||
        observation.windowEnd === '2026-08-04T00:00:00.000Z' ||
        observation.windowEnd === '2026-08-03T00:00:00.000Z',
      'the day-period slices carry the provider end_time stamps verbatim',
    );
  }
  const observedEnds = new Set(accountAnalytics.observations.map((observation) => observation.windowEnd));
  assert.equal(observedEnds.size, 3, 'the three documented day slices ride per metric');
  // The per-content report: the documented live lifetime metric
  // vocabulary (the basic post_impressions metric is deprecated above
  // Graph API v25 — the live vocabulary is requested instead).
  const own = await module().listOwnContent(account, { pageCursor: null, limit: 1 }, PROVENANCE);
  assert.equal(own.ok, true);
  const contentAnalytics = await module().readContentAnalytics(
    account,
    { providerContentIds: [own.page.records[0]!.providerContentId], windowStart: null, windowEnd: null },
    PROVENANCE,
  );
  assert.equal(contentAnalytics.ok, true, JSON.stringify(contentAnalytics));
  const postMetricNames = new Set(contentAnalytics.observations.map((observation) => observation.metric));
  for (const expected of ['post_clicks', 'post_impressions_organic', 'post_impressions_paid', 'post_reactions_like_total']) {
    assert.ok(postMetricNames.has(expected), `the documented post metric '${expected}' rides VERBATIM`);
  }
  for (const observation of contentAnalytics.observations) {
    assert.equal(observation.windowStart, null, 'the lifetime aggregates carry no window');
    assert.equal(observation.windowEnd, null);
  }
});

// ---------------------------------------------------------------------------
// 4. The publish lifecycle (the dispatch AC)
// ---------------------------------------------------------------------------

test('AC: the PUBLISH LIFECYCLE — the immediate synchronous publish (born published); the SCHEDULED post (born accepted → the scheduled-window arrival → published); the replay idempotency (ZERO provider calls)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // (a) The IMMEDIATE feed publish is synchronous on the documented
  // surface — the born 'published' submission with the post id as BOTH
  // the provider publish identity and the content identity.
  const publishRequestsBefore = double().requestCount('feed-publish');
  const immediate = await module().submitPublish(account, { idempotencyKey: 'fb-immediate-1', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(immediate.duplicate, false);
  assert.equal(immediate.attempt.publishState, 'published', JSON.stringify(immediate));
  assert.ok(immediate.attempt.providerPublishId !== null);
  assert.equal(immediate.attempt.providerContentId, immediate.attempt.providerPublishId, 'the post id is BOTH the publish and the content identity on the synchronous surface');
  assert.equal(immediate.attempt.failureCode, null);
  assert.equal(double().requestCount('feed-publish'), publishRequestsBefore + 1, 'exactly ONE documented feed POST');
  // The REPLAY idempotency: same key → the fence answers from the
  // recorded attempt, ZERO provider calls.
  const replay = await module().submitPublish(account, { idempotencyKey: 'fb-immediate-1', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(replay.duplicate, true, 'the replayed key is answered from the fence');
  assert.equal(replay.attempt.attemptId, immediate.attempt.attemptId, 'the SAME attempt row');
  assert.equal(double().requestCount('feed-publish'), publishRequestsBefore + 1, 'ZERO provider calls on replay');
  // The status poll of the live post observes the documented
  // is_published=true semantics.
  const livePoll = await module().refreshPublishStatus(account, immediate.attempt.attemptId, PROVENANCE);
  assert.equal(livePoll.observation.publishState, 'published');
  assert.equal(livePoll.observation.providerContentId, immediate.attempt.providerPublishId);

  // (b) The SCHEDULED post: born accepted (published=false +
  // scheduled_publish_time) → the poll observes the pending window →
  // the scheduled window ARRIVES (the double advances the post) → the
  // poll observes published with the content identity.
  const scheduledRequest = {
    contentType: 'facebook-pages.feed-post',
    payload: { message: 'The documented scheduled Page post.' },
    mediaAssets: [] as const,
    attribution: { missionId: 'mission-fb-2' },
    scheduledFor: '2026-08-02T12:00:00.000Z',
  } as const;
  const scheduled = await module().submitPublish(account, { idempotencyKey: 'fb-scheduled-1', request: scheduledRequest }, PROVENANCE);
  assert.equal(scheduled.duplicate, false);
  assert.equal(scheduled.attempt.publishState, 'accepted', JSON.stringify(scheduled));
  assert.ok(scheduled.attempt.providerPublishId !== null);
  assert.equal(scheduled.attempt.providerContentId, null, 'the scheduled window is pending — no content identity yet');
  // The poll BEFORE the window: the honest still-accepted answer.
  const pendingPoll = await module().refreshPublishStatus(account, scheduled.attempt.attemptId, PROVENANCE);
  assert.equal(pendingPoll.observation.publishState, 'accepted', JSON.stringify(pendingPoll));
  assert.equal(pendingPoll.observation.providerContentId, null);
  // The scheduled window ARRIVES (the documented is_published flip).
  double().advancePost(scheduled.attempt.providerPublishId!);
  const publishedPoll = await module().refreshPublishStatus(account, scheduled.attempt.attemptId, PROVENANCE);
  assert.equal(publishedPoll.observation.publishState, 'published');
  assert.equal(publishedPoll.observation.providerContentId, scheduled.attempt.providerPublishId, 'the post id becomes the content identity when the window arrives');
  assert.equal(publishedPoll.attempt.publishState, 'accepted', 'the attempt row keeps the SUBMIT-TIME fact');
  // The append-only observation history carries both answers.
  const history = await module().listPublishStatusObservations(account, scheduled.attempt.attemptId);
  assert.equal(history.length, 2, 'one immutable observation per poll');
  // The replay of the scheduled key: ZERO provider calls (the fence).
  const scheduledReplay = await module().submitPublish(account, { idempotencyKey: 'fb-scheduled-1', request: scheduledRequest }, PROVENANCE);
  assert.equal(scheduledReplay.duplicate, true);
  assert.equal(scheduledReplay.attempt.attemptId, scheduled.attempt.attemptId);

  // (c) The VIDEO publish rides the documented video processing window:
  // born accepted (the video id) → the poll observes processing → the
  // video becomes ready → the poll observes published.
  const videoRequest = {
    contentType: 'facebook-pages.video',
    payload: { description: 'The documented Page video.', file_url: 'https://cdn.example/video.mp4' },
    mediaAssets: [] as const,
    attribution: {},
    scheduledFor: null,
  } as const;
  const video = await module().submitPublish(account, { idempotencyKey: 'fb-video-1', request: videoRequest }, PROVENANCE);
  assert.equal(video.duplicate, false);
  assert.equal(video.attempt.publishState, 'accepted', JSON.stringify(video));
  assert.ok(video.attempt.providerPublishId !== null);
  const videoPendingPoll = await module().refreshPublishStatus(account, video.attempt.attemptId, PROVENANCE);
  assert.equal(videoPendingPoll.observation.publishState, 'accepted', 'the video is still processing');
  double().advanceVideo(video.attempt.providerPublishId!, 'ready');
  const videoPublishedPoll = await module().refreshPublishStatus(account, video.attempt.attemptId, PROVENANCE);
  assert.equal(videoPublishedPoll.observation.publishState, 'published');
  assert.equal(videoPublishedPoll.observation.providerContentId, video.attempt.providerPublishId);

  // (d) The video processing failure: the honest 'failed' outcome with
  // the provider's own status as the failure reason.
  const failingVideo = await module().submitPublish(account, { idempotencyKey: 'fb-video-error-1', request: videoRequest }, PROVENANCE);
  assert.equal(failingVideo.attempt.publishState, 'accepted');
  double().advanceVideo(failingVideo.attempt.providerPublishId!, 'error');
  const errorPoll = await module().refreshPublishStatus(account, failingVideo.attempt.attemptId, PROVENANCE);
  assert.equal(errorPoll.observation.publishState, 'failed');
  assert.ok(errorPoll.observation.providerFailureReason !== null);
  assert.ok(String(errorPoll.observation.providerFailureReason).includes('video_status=error'));

  // (e) The documented provider-side validation: a feed publish with
  // neither message nor link answers the code-100 invalid-parameter
  // family as honest restricted DATA (the attempt records it).
  const invalid = await module().submitPublish(
    account,
    {
      idempotencyKey: 'fb-invalid-1',
      request: { contentType: 'facebook-pages.feed-post', payload: {}, mediaAssets: [], attribution: {}, scheduledFor: null },
    },
    PROVENANCE,
  );
  assert.equal(invalid.attempt.publishState, 'failed');
  assert.equal(invalid.attempt.failureCode, 'restricted');
});

test('the scheduled PHOTO publish rides the documented temporary=true semantics (the scheduled-unpublished photo path)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const photosBefore = double().requestCount('photo-publish');
  const photoRequest = {
    contentType: 'facebook-pages.photo',
    payload: { caption: 'The documented scheduled photo.' },
    mediaAssets: [
      {
        assetReference: 'content-asset:ca:fixture-fb-photo-1',
        mediaKind: 'image',
        descriptor: { filename: 'photo.jpg', mime: 'image/jpeg', url: 'https://cdn.example/photo.jpg' },
      },
    ] as const,
    attribution: {},
    scheduledFor: '2026-08-03T12:00:00.000Z',
  } as const;
  const photo = await module().submitPublish(account, { idempotencyKey: 'fb-photo-scheduled-1', request: photoRequest }, PROVENANCE);
  assert.equal(photo.duplicate, false);
  assert.equal(photo.attempt.publishState, 'accepted', JSON.stringify(photo));
  assert.equal(double().requestCount('photo-publish'), photosBefore + 1);
  // The documented scheduled-photo parameter set verifiably rode the
  // POST (published=false + scheduled_publish_time + temporary=true +
  // the media-asset URL descriptor as url): the recorded provider post
  // is born unpublished with the scheduled stamp.
  const posts = double().postsOf('fb-page-main-1');
  const scheduledPhotoPost = posts.find((post) => post.postId === photo.attempt.providerPublishId);
  assert.ok(scheduledPhotoPost !== undefined, 'the scheduled photo post is recorded on the provider surface');
  assert.equal(scheduledPhotoPost.isPublished, false, 'the scheduled photo post is born unpublished');
  assert.equal(scheduledPhotoPost.scheduledPublishTime, Math.floor(Date.parse('2026-08-03T12:00:00.000Z') / 1000));
});

// ---------------------------------------------------------------------------
// 5. The policy/rate-limit handling as data (the dispatch AC)
// ---------------------------------------------------------------------------

test('AC: the documented Pages BUC rate surface (code 80001 + the regain-capacity observation) rides the invocation record as DATA — never an exception escape', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  // A dedicated page for the BUC battery (the documented Pages BUC
  // accounting: every Page-token call counts against the per-page
  // rolling-window budget; the exhaustion answers the documented
  // code-80001 envelope with the regain-capacity header).
  const connectionId = await makeFacebookPagesConnection(owner, client);
  const bucAccount = await connectAccount(client, connectionId, {
    pageId: 'fb-page-buc-1',
    scopes: FULL_GRANT,
  });
  double().resetBucWindow();
  double().setBucCallLimit(2);
  try {
    // Two Page-token calls fit the budget (each readAccountProfile =
    // the /me/accounts resolution (uncounted) + the Page-node read
    // (counted)).
    const first = await module().readAccountProfile(bucAccount, PROVENANCE);
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await module().readAccountProfile(bucAccount, PROVENANCE);
    assert.equal(second.ok, true, JSON.stringify(second));
    // The THIRD Page-token call exhausts the budget: the documented
    // code-80001 envelope + the observable regain-capacity seconds —
    // as honest rate-limited DATA with the observation, NEVER an
    // exception escape.
    const exhausted = await module().readAccountProfile(bucAccount, PROVENANCE);
    assert.ok(!exhausted.ok, 'the exhausted BUC budget surfaces as data');
    assert.equal(exhausted.failure.code, 'rate-limited');
    assert.ok(exhausted.failure.message.includes('80001'), 'the documented Page-level code 80001 rides the message');
    assert.ok(exhausted.failure.rateLimit !== null, 'the observable rate-limit observation rides the invocation record');
    assert.equal(exhausted.failure.rateLimit!.retryAfterSeconds, 180, 'the documented regain-capacity seconds ride the observation');
    assert.ok(exhausted.failure.rateLimit!.backoffUntil !== null, 'the backoff-until stamp derives from the regain seconds');
    // The publish path under the exhausted budget: the attempt records
    // the honest rate-limited refusal (never an exception).
    const submit = await module().submitPublish(
      bucAccount,
      {
        idempotencyKey: 'fb-buc-publish-1',
        request: { contentType: 'facebook-pages.feed-post', payload: { message: 'Refused by the BUC budget.' }, mediaAssets: [], attribution: {}, scheduledFor: null },
      },
      PROVENANCE,
    );
    assert.equal(submit.duplicate, false);
    assert.equal(submit.attempt.publishState, 'failed');
    assert.equal(submit.attempt.failureCode, 'rate-limited');
  } finally {
    // Restore the default budget for the remaining batteries.
    double().resetBucWindow();
    double().setBucCallLimit(4800 * 100);
  }
});

// ---------------------------------------------------------------------------
// 6. The documented error taxonomy (the envelope-code classifier)
// ---------------------------------------------------------------------------

test('the REAL adapter classifies the documented Graph API error envelope onto the frozen taxonomy (code 190 / code 4 with the regain observation / code 10 / 5xx)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const cases: readonly {
    readonly label: string;
    readonly failure: { status: number; code: number; message: string; type: string; retryAfterSeconds?: number };
    readonly expected: 'auth-expired' | 'rate-limited' | 'restricted' | 'provider-unavailable';
    readonly expectsObservation?: boolean;
  }[] = [
    {
      label: 'code 190 (the token class) → auth-expired',
      failure: { status: 400, code: 190, message: 'The access token is invalid.', type: 'OAuthException' },
      expected: 'auth-expired',
    },
    {
      label: 'code 4 + the regain-capacity header → rate-limited WITH the observation',
      failure: { status: 400, code: 4, message: '(#4) Application request limit reached.', type: 'OAuthException', retryAfterSeconds: 42 },
      expected: 'rate-limited',
      expectsObservation: true,
    },
    {
      label: 'code 32 (the Page BUC class, User-token Page calls) → rate-limited',
      failure: { status: 400, code: 32, message: '(#32) Page request limit reached.', type: 'OAuthException' },
      expected: 'rate-limited',
    },
    {
      label: 'code 10 (the permission/eligibility class) → restricted',
      failure: { status: 400, code: 10, message: '(#10) The user does not have permission.', type: 'OAuthException' },
      expected: 'restricted',
    },
    {
      label: '5xx → provider-unavailable',
      failure: { status: 500, code: 1, message: 'Internal server error.', type: 'GraphMethodException' },
      expected: 'provider-unavailable',
    },
  ];
  for (const { label, failure, expected, expectsObservation } of cases) {
    double().scriptFailure('page-node', failure);
    const outcome = await module().readAccountProfile(account, PROVENANCE);
    double().scriptFailure('page-node', null);
    assert.ok(!outcome.ok, label);
    assert.equal(outcome.failure.code, expected, label);
    if (expectsObservation) {
      assert.ok(outcome.failure.rateLimit !== null, `${label} — the observation rides the failure`);
      assert.equal(outcome.failure.rateLimit!.retryAfterSeconds, 42, `${label} — the documented regain seconds`);
    }
    // Clearing the scripting recovers.
    const recovered = await module().readAccountProfile(account, PROVENANCE);
    assert.equal(recovered.ok, true, `${label} — clearing the scripting recovers`);
  }
});

test('the transport-refused provider maps to provider-unavailable (the dead data-plane base URL)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  // A connection whose apiBaseUrl points at a dead loopback port — the
  // documented deployment override surface carries the failure.
  const connectionId = await makeFacebookPagesConnection(owner, client, { apiBaseUrl: 'http://127.0.0.1:9' });
  const deadAccount = await connectAccount(client, connectionId, {
    pageId: 'fb-page-dead-1',
    scopes: FULL_GRANT,
  });
  const outcome = await module().readAccountProfile(deadAccount, PROVENANCE);
  assert.ok(!outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.failure.code, 'provider-unavailable');
  assert.ok(outcome.failure.message.includes('transport refused') || outcome.failure.message.includes('not processed'));
});

// ---------------------------------------------------------------------------
// 7. The strict scope pre-flight + the capability-subset enforcement (the dispatch ACs)
// ---------------------------------------------------------------------------

test('the strict scope pre-flight refuses publish on the read-only REAL-scope grant (zero provider traffic)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  const connectionId = await makeFacebookPagesConnection(owner, client);
  const readOnlyAccount = await connectAccount(client, connectionId, {
    pageId: 'fb-page-readonly-1',
    scopes: READ_ONLY_GRANT,
  });
  // The capability view honestly reports the publish family unsatisfied.
  const view = await module().resolveAccountCapabilityMatrix(readOnlyAccount);
  assert.ok(view !== null);
  const publishSatisfaction = view!.scopeSatisfaction.find((entry) => entry.family === 'publish');
  assert.ok(publishSatisfaction !== undefined);
  assert.deepEqual(publishSatisfaction!.missingScopes, [PAGES_MANAGE_POSTS]);
  // The publish submit refuses pre-flight with the scope named verbatim.
  const before = double().totalRequestCount();
  const submit = await module().submitPublish(
    readOnlyAccount,
    {
      idempotencyKey: 'fb-readonly-publish-1',
      request: { contentType: 'facebook-pages.feed-post', payload: { message: 'Refused pre-flight.' }, mediaAssets: [], attribution: {}, scheduledFor: null },
    },
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

test('AC: the CAPABILITY-SUBSET enforcement — the undeclared restriction-signals family refuses fail-closed with ZERO provider traffic', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const before = double().totalRequestCount();
  const outcome = await module().readRestrictionSignals(account, PROVENANCE);
  assert.ok(!outcome.ok, 'the undeclared family refuses');
  assert.equal(outcome.failure.code, 'unsupported-capability');
  assert.ok(outcome.failure.message.includes('restriction-signals') || outcome.failure.message.includes('capability'));
  assert.equal(double().totalRequestCount(), before, 'ZERO provider traffic for the undeclared family');
});
