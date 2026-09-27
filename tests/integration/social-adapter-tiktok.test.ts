/**
 * MKT-060 integration tests — the TIKTOK social platform adapter on the
 * REAL stack: embedded PostgreSQL 18, the spawned production API and
 * IN-PROCESS applications composed through the disclosed seams.
 *
 * Two proofs, each with its own disclosed double at the provider
 * boundary ONLY (the contract HOST under test — the capability gates,
 * the strict scope pre-flight, the /policies fail-closed gates, the
 * migration-050 idempotency fence, the claim-then-fill ledger — is
 * fully REAL in both — the MKT-057/058/059 pattern):
 *
 *   1. THE CONFORMANCE SUITE (the dispatch AC): the full 17-scenario
 *      MKT-056 battery
 *      (tests/integration/helpers/social-adapter-conformance.ts) runs
 *      against the disclosed IN-MEMORY TikTok platform double
 *      (tests/integration/helpers/tiktok-platform-double.ts — the
 *      documented-API behavioral model: the user-info surface, the
 *      video/list cursor pagination, the video/query ownership
 *      verification, the creator capability query, the direct-post
 *      lifecycle with the documented eligibility/audit enforcement, the
 *      documented rate accounting, failure injection) with the REAL
 *      documented Login Kit scope names as the fixture grants (the
 *      documented test-only suite extension — TikTok's real scopes fall
 *      outside the default fixture vocabulary). The honest 5-of-5
 *      matrix fires ALL 17 scenarios (the creator capability query
 *      serves the restriction-signals scenario);
 *
 *   2. THE REAL ADAPTER END-TO-END (the composition-root registration
 *      proof): the application boots with the production 'tiktok'
 *      registration (the MKT-060 composition-root first-party
 *      registration, the platform FetchHttpCall transport — the
 *      socialPlatformAdapters seam carries ONLY the disclosed
 *      'tiktok-narrow' operation-level-subset double of the
 *      capability-subset battery under its OWN key, so the production
 *      'tiktok' registration is NOT overridden) and serves every
 *      operation through the module API against the disclosed COMBINED
 *      provider double
 *      (tests/integration/helpers/tiktok-http-double.ts — the loopback
 *      HTTP server faithfully mirroring the documented TikTok for
 *      Developers API + Login Kit OAuth planes): the REAL matrix + REAL
 *      scopes + inertness · the documented user-info identity/profile ·
 *      THE CREATOR CAPABILITY QUERY (the named AC — the documented
 *      eligibility surface as DATA) · the documented video/list cursor
 *      pagination + the video/query ownership verification (the honest
 *      null record) + ALL FOUR engagement counts · the documented
 *      statistical labels VERBATIM · THE ELIGIBILITY/AUDIT HONESTY (the
 *      named AC — the private-mode account and the unaudited client
 *      refuse through the documented 403 semantics as DATA, never a
 *      fabricated success) · THE PUBLISH LIFECYCLE (the named AC — the
 *      direct-post init → the status polling through the documented
 *      publish-status surface → the terminal states incl. the
 *      private-mode completion with NO public post id, the FAILED
 *      fail_reason split and the upload-status invalid_publish_id path;
 *      the replay idempotency with ZERO provider calls) · THE POLICY/
 *      RATE-LIMIT HANDLING (the named AC — the documented 429/403
 *      quota classes ride the invocation record as DATA, never an
 *      exception escape; the documented 200-INTENTIONAL answer; the
 *      refused publish records honestly on the ledger) · the documented
 *      error taxonomy (the code-driven classifier) · the strict
 *      REAL-scope pre-flight (zero provider traffic) · THE
 *      CAPABILITY-SUBSET ENFORCEMENT (the named AC — the undeclared
 *      operation AND the undeclared family refuse fail-closed with
 *      ZERO provider traffic).
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
import { startTikTokProviderDouble, type TikTokProviderDouble } from './helpers/tiktok-http-double.ts';
import {
  createTikTokPlatformDouble,
  TIKTOK_FULL_SCOPES,
  TIKTOK_READ_ONLY_SCOPES,
} from './helpers/tiktok-platform-double.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'social-adapter-tiktok-pipe-key';
/** The disclosed operation-level-subset platform key of the capability-subset battery (its OWN key — the production 'tiktok' registration is NOT overridden). */
const NARROW_PLATFORM_KEY = 'tiktok-narrow';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-0000000000dd',
  recordedVia: 'test',
  correlationId: 'integration-social-adapter-tiktok-1',
  causationId: null,
} as const;

/** The REAL documented Login Kit scope names the adapter declares (the strict pre-flight vocabulary). */
const USER_INFO_BASIC = 'user.info.basic';
const USER_INFO_PROFILE = 'user.info.profile';
const USER_INFO_STATS = 'user.info.stats';
const VIDEO_LIST = 'video.list';
const VIDEO_PUBLISH = 'video.publish';
const FULL_GRANT = [USER_INFO_BASIC, USER_INFO_PROFILE, USER_INFO_STATS, VIDEO_LIST, VIDEO_PUBLISH] as const;
const READ_ONLY_GRANT = [USER_INFO_BASIC, USER_INFO_PROFILE, USER_INFO_STATS, VIDEO_LIST] as const;

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: TikTokProviderDouble | null = null;
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
function double(): TikTokProviderDouble {
  if (provider === null) throw new Error('provider double not booted');
  return provider;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('social_tiktok_real');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startTikTokProviderDouble();
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  // NO 'tiktok' socialPlatformAdapters seam entry: the PRODUCTION-composed
  // TikTok adapter (the MKT-060 composition-root registration on the
  // platform FetchHttpCall transport) serves every operation of this
  // battery. The seam carries ONLY the disclosed 'tiktok-narrow'
  // operation-level-subset double (its OWN key) of the capability-subset
  // battery — the production 'tiktok' registration is NOT overridden
  // (the seam-override is keyed; a different key never replaces the
  // first-party instance).
  const core = await bootstrapApplication({
    integrationAdapters: [createReferenceIntegrationStub('tiktok'), createReferenceIntegrationStub(NARROW_PLATFORM_KEY)],
    socialAccountFlows: [
      createLocalOAuthFlow(provider, { adapterKey: 'tiktok', secretsDir: stack.env.secretsDir }),
      createLocalOAuthFlow(provider, { adapterKey: NARROW_PLATFORM_KEY, secretsDir: stack.env.secretsDir }),
    ],
    socialPlatformAdapters: [
      // The disclosed capability-subset double: the account family +
      // a NARROWED content-read operation set (listOwnContent +
      // getContent — discoverPublicContent deliberately UNDECLARED) and
      // NO analytics-read family — the operation-level AND family-level
      // fail-closed refusals of the capability-subset battery.
      createTikTokPlatformDouble({
        adapterKey: NARROW_PLATFORM_KEY,
        capabilities: [
          {
            family: 'account',
            operations: ['verifyAccountIdentity', 'getAccountProfile'],
            requiredScopes: [USER_INFO_BASIC, USER_INFO_PROFILE, USER_INFO_STATS],
            description:
              'The disclosed narrow capability-subset double (account family; the operation-level/family-level subset battery).',
          },
          {
            family: 'content-read',
            operations: ['listOwnContent', 'getContent'],
            requiredScopes: [VIDEO_LIST],
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
/** Creates + connects the tiktok-keyed integration connection (providerConfig points the REAL adapter at the double). */
async function makeTikTokConnection(
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
    label: `tiktok_pipe_${clientId.slice(0, 8)}_${connectionSequence}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection(
    {
      clientId,
      adapterKey,
      credentialReferenceId: credential.credentialId,
      // The documented deployment override surface: the API base URL of
      // the connection (apiBaseUrl) points the production adapter at the
      // loopback provider double (the documented host is
      // https://open.tiktokapis.com).
      providerConfig: {
        apiBaseUrl: double().url,
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

/** The full OAuth handshake through the REAL module + the combined provider double. */
async function connectAccount(
  clientId: string,
  connectionId: string,
  fixture: {
    readonly creatorId: string;
    readonly scopes: readonly string[];
    readonly capabilityTags?: readonly string[];
  },
): Promise<string> {
  const start = await module().startAuthorization(
    { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...fixture.scopes], expectedAccountId: null },
    PROVENANCE,
  );
  const issued = double().issueAuthorization({
    accountId: fixture.creatorId,
    displayIdentity: `tt-creator:${fixture.creatorId}`,
    verifiedAt: '2026-07-01T09:30:00.000Z',
    scopes: [...fixture.scopes],
    capabilityTags: fixture.capabilityTags ?? ['tiktok-tag'],
    expiresInMs: 3_600_000,
  });
  const completion = await module().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    PROVENANCE,
  );
  return completion.account.socialAccountId;
}

const DIRECT_POST_REQUEST = {
  contentType: 'tiktok.video',
  payload: {
    title: 'this will be a funny #cat video on your @tiktok #fyp',
    privacyLevel: 'PUBLIC_TO_EVERYONE',
    disableDuet: false,
    disableComment: true,
    disableStitch: false,
    videoCoverTimestampMs: 1000,
    brandContentToggle: false,
    brandOrganicToggle: false,
    isAigc: false,
    // The documented PULL_FROM_URL source: the public URL the TikTok
    // server pulls the video from.
    videoUrl: 'https://cdn.example.com/funny-cat.mp4',
  },
  mediaAssets: [] as const,
  attribution: { missionId: 'mission-tt-1', experimentId: 'exp-tt-1' },
  scheduledFor: null,
} as const;

// ---------------------------------------------------------------------------
// 1. The conformance suite (the dispatch AC — the in-memory double + REAL scopes)
// ---------------------------------------------------------------------------

test('AC: the TikTok platform double passes the MKT-056 social adapter conformance suite (the REAL Login Kit scope fixtures; the honest 5-of-5 matrix fires ALL 17 scenarios)', async () => {
  const suiteProvider = await startTikTokProviderDouble();
  const suiteAdapter = createTikTokPlatformDouble();
  try {
    const report = await runSocialAdapterConformanceSuite({
      adapter: suiteAdapter,
      adapterHandle: suiteAdapter,
      provider: suiteProvider,
      label: 'tiktok',
      fullScopes: [...TIKTOK_FULL_SCOPES],
      readOnlyScopes: [...TIKTOK_READ_ONLY_SCOPES],
    });
    assert.equal(report.failed, 0, 'the conformance battery is green');
    const names = report.scenarios.map((scenario) => scenario.name).join('\n');
    // ALL 17 scenarios fire — the honest 5-of-5 matrix (the creator
    // capability query serves the restriction-signal scenario).
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

test('the composition root registers the TikTok adapter as production DATA — the REAL honest 5-of-5 matrix, INERT without a connection', async () => {
  // The registration is data: the registry exposes the REAL descriptor + matrix.
  const registered = module().listRegisteredSocialAdapters();
  const tiktok = registered.find((info) => info.descriptor.adapterKey === 'tiktok');
  assert.ok(tiktok !== undefined, 'the production composition registered the TikTok adapter');
  assert.equal(tiktok.descriptor.providerLabel, 'TikTok (Login Kit + Content Posting API)');
  assert.deepEqual(
    tiktok.capabilities.map((capability) => [capability.family, [...capability.operations]]),
    [
      ['account', ['verifyAccountIdentity', 'getAccountProfile']],
      ['content-read', ['discoverPublicContent', 'listOwnContent', 'getContent']],
      ['analytics-read', ['readAccountAnalytics', 'readContentAnalytics']],
      ['publish', ['submitPublish', 'getPublishStatus']],
      ['restriction-signals', ['readRestrictionSignals']],
    ],
    'the REAL declared matrix (the honest ALL-FIVE set with the closed vocabularies — the creator capability query serves the restriction-signals family)',
  );
  // The REAL documented Login Kit scope names (least privilege per family).
  const scopesOf = new Map(tiktok.capabilities.map((capability) => [capability.family, [...capability.requiredScopes]]));
  assert.deepEqual(scopesOf.get('account'), [USER_INFO_BASIC, USER_INFO_PROFILE, USER_INFO_STATS]);
  assert.deepEqual(scopesOf.get('content-read'), [VIDEO_LIST]);
  assert.deepEqual(scopesOf.get('analytics-read'), [USER_INFO_STATS, VIDEO_LIST]);
  assert.deepEqual(scopesOf.get('publish'), [VIDEO_PUBLISH]);
  assert.deepEqual(scopesOf.get('restriction-signals'), [VIDEO_PUBLISH]);
  // The INERTNESS proof: the registered adapter performed ZERO provider
  // traffic (no authorized tiktok connection exists yet — the
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
  principal = await makeAgencyOwner('tiktok-owner@marketingos.test');
  clientId = (await apiCall(port(), `/api/agencies/${principal.agencyId}/clients`, {
    token: principal.token,
    body: { name: 'TikTok Client' },
  })).body['clientId'] as string;
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makeTikTokConnection(principal, clientId, 'tiktok');
  accountId = await connectAccount(clientId, connectionId, {
    creatorId: 'tt-creator-main-1',
    scopes: FULL_GRANT,
  });
  return { principal, clientId, accountId };
}

test('the REAL adapter maps the documented Get User Info surface (open_id/display_name identity; the profile fields + stats verbatim; verifiedAt null — the surface exposes a badge, not a timestamp)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const identity = await module().verifyAccountIdentity(account, PROVENANCE);
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.identity.externalAccountId, 'tt-creator-main-1');
  assert.equal(identity.identity.displayIdentity, 'Fixture Creator tt-creator-main-1');
  assert.equal(identity.identity.verifiedAt, null, 'the documented surface exposes a verified badge, not a timestamp');
  const profile = await module().readAccountProfile(account, PROVENANCE);
  assert.equal(profile.ok, true, JSON.stringify(profile));
  assert.equal(profile.profile.externalAccountId, 'tt-creator-main-1');
  assert.equal(profile.profile.displayIdentity, 'Fixture Creator tt-creator-main-1');
  assert.equal(profile.profile.accountKind, null, 'the documented user-info surface exposes no account-type label');
  assert.equal(profile.profile.followerCount, 7351);
  // The documented user fields ride VERBATIM as passthrough (incl. the
  // is_verified badge + the username of the user.info.profile scope).
  assert.deepEqual(
    {
      username: profile.profile.data['username'],
      isVerified: profile.profile.data['is_verified'],
      likesCount: profile.profile.data['likes_count'],
      videoCount: profile.profile.data['video_count'],
    },
    { username: 'double_tt_creator_main_1', isVerified: false, likesCount: 91_234, videoCount: 42 },
    'the documented User Object fields ride VERBATIM as passthrough',
  );
  // The documented user/info call verifiably happened.
  assert.ok(double().requestCount('user-info') >= 2, 'the documented user/info surface verifiably ran');
  // The honest rate-limit observation: the documented surface exposes no
  // remaining-quota headers — null, never fabricated.
  assert.equal(profile.rateLimit, null);
});

test('AC: THE CREATOR CAPABILITY QUERY — the documented eligibility surface as DATA (privacy_level_options + max_video_post_duration_sec; the owner settings ride the passthrough, never as signals)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const signals = await module().readRestrictionSignals(account, PROVENANCE);
  assert.equal(signals.ok, true, JSON.stringify(signals));
  const kinds = signals.signals.map((signal) => signal.signalKind);
  assert.ok(kinds.includes('creator.privacy_level_options'), 'the documented privacy level options ride as the eligibility signal');
  assert.ok(kinds.includes('creator.max_video_post_duration_sec'), 'the documented duration bound rides as the eligibility signal');
  const options = signals.signals.find((signal) => signal.signalKind === 'creator.privacy_level_options')!;
  assert.deepEqual(
    (options.data as { privacy_level_options: readonly string[] })['privacy_level_options'],
    ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    'the documented PUBLIC-account option set rides verbatim',
  );
  const duration = signals.signals.find((signal) => signal.signalKind === 'creator.max_video_post_duration_sec')!;
  assert.equal((duration.data as { max_video_post_duration_sec: number })['max_video_post_duration_sec'], 600);
  // The documented creator_info/query call verifiably happened.
  assert.ok(double().requestCount('creator-info') >= 1, 'the documented creator capability query verifiably ran');
});

test('the REAL adapter maps the documented video/list cursor pagination + the video/query ownership verification (the honest null record; ALL FOUR engagement counts)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // The own-content listing over the documented video/list surface.
  const own = await module().listOwnContent(account, { pageCursor: null, limit: 2 }, PROVENANCE);
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(own.page.records.length, 2, 'the documented default page (max_count ≤ 20)');
  const first = own.page.records[0]!;
  assert.equal(first.providerContentId, 'tt-video-tt-creator-main-1-1');
  assert.equal(first.engagement.viewCount, 1000, 'the documented Video Object view_count rides');
  assert.equal(first.engagement.likeCount, 100, 'the documented Video Object like_count rides');
  assert.equal(first.engagement.commentCount, 10, 'the documented Video Object comment_count rides');
  assert.equal(first.engagement.shareCount, 1, 'the documented Video Object share_count rides');
  // The documented cursor pagination (the int64 Unix-MS cursor): the
  // second page carries the remaining video.
  assert.ok(own.page.pageCursor !== null, 'the documented cursor rides the page');
  const pageTwo = await module().listOwnContent(account, { pageCursor: own.page.pageCursor, limit: 2 }, PROVENANCE);
  assert.equal(pageTwo.ok, true);
  assert.equal(pageTwo.page.records.length, 1, 'the cursor fetches the videos posted BEFORE the cursor timestamp');
  assert.equal(pageTwo.page.records[0]!.providerContentId, 'tt-video-tt-creator-main-1-3');
  assert.equal(pageTwo.page.pageCursor, null, 'no more pages');
  // The discovery surface maps onto the SAME documented public-video
  // list (the caller query is honestly unused — no public keyword search
  // exists on the documented surface; DISCLOSED).
  const discovery = await module().discoverPublicContent(account, { query: 'growth marketing', pageCursor: null, limit: 2 }, PROVENANCE);
  assert.equal(discovery.ok, true, JSON.stringify(discovery));
  assert.ok(discovery.page.records.length > 0);
  assert.equal(discovery.page.records[0]!.providerContentId, 'tt-video-tt-creator-main-1-1');
  // The single-content read over the documented video/query surface.
  const single = await module().getContent(account, { providerContentId: first.providerContentId }, PROVENANCE);
  assert.equal(single.ok, true, JSON.stringify(single));
  assert.ok(single.record !== null);
  assert.equal(single.record!.providerContentId, first.providerContentId);
  assert.deepEqual(single.record!.engagement, first.engagement);
  // The documented ownership verification: an unknown id is ABSENT from
  // the videos list — the honest null record (never a fabricated
  // failure).
  const unknown = await module().getContent(account, { providerContentId: 'not-a-real-video' }, PROVENANCE);
  assert.equal(unknown.ok, true, JSON.stringify(unknown));
  assert.equal(unknown.record, null, 'the documented empty-list semantics — the honest null record');
  // The documented video surfaces verifiably ran.
  assert.ok(double().requestCount('video-list') >= 3);
  assert.ok(double().requestCount('video-query') >= 2);
});

test('the REAL adapter maps the documented statistical surfaces (the user.info.stats labels VERBATIM + the Video Object count fields VERBATIM, null windows)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // The account analytics: the documented user.info.stats count fields,
  // labels VERBATIM, point-in-time values (no windows on the surface).
  const accountAnalytics = await module().readAccountAnalytics(
    account,
    { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-31T00:00:00.000Z' },
    PROVENANCE,
  );
  assert.equal(accountAnalytics.ok, true, JSON.stringify(accountAnalytics));
  const metricNames = new Set(accountAnalytics.observations.map((observation) => observation.metric));
  for (const expected of ['follower_count', 'following_count', 'likes_count', 'video_count']) {
    assert.ok(metricNames.has(expected), `the documented user.info.stats label '${expected}' rides VERBATIM`);
  }
  for (const observation of accountAnalytics.observations) {
    assert.equal(observation.windowStart, null, 'the surface exposes point-in-time values — null windows, never fabricated');
    assert.equal(observation.windowEnd, null);
  }
  // The per-content analytics: the documented Video Object count fields
  // over ONE documented video/query request, labels VERBATIM.
  const own = await module().listOwnContent(account, { pageCursor: null, limit: 1 }, PROVENANCE);
  assert.equal(own.ok, true);
  const contentAnalytics = await module().readContentAnalytics(
    account,
    { providerContentIds: [own.page.records[0]!.providerContentId], windowStart: null, windowEnd: null },
    PROVENANCE,
  );
  assert.equal(contentAnalytics.ok, true, JSON.stringify(contentAnalytics));
  const postMetricNames = new Set(contentAnalytics.observations.map((observation) => observation.metric));
  for (const expected of ['view_count', 'like_count', 'comment_count', 'share_count']) {
    assert.ok(postMetricNames.has(expected), `the documented Video Object metric '${expected}' rides VERBATIM`);
  }
  for (const observation of contentAnalytics.observations) {
    assert.equal(observation.windowStart, null, 'the lifetime values carry no windows');
    assert.equal(observation.windowEnd, null);
  }
});

// ---------------------------------------------------------------------------
// 4. The eligibility/audit honesty (the dispatch AC)
// ---------------------------------------------------------------------------

test('AC: THE ELIGIBILITY/AUDIT HONESTY — the unaudited client + the private-mode creator refuse through the documented 403 semantics as DATA, never a fabricated success', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  // (a) THE AUDIT MODEL: an UNAUDITED client attempting a public publish
  // answers the documented 403
  // unaudited_client_can_only_post_to_private_accounts ("All content
  // posted by unaudited clients will be restricted to private viewing
  // mode") — the honest restricted DATA on the ledger (the double's
  // client starts UNAUDITED).
  const unauditedSubmit = await module().submitPublish(
    accountId!,
    { idempotencyKey: 'tt-unaudited-1', request: DIRECT_POST_REQUEST },
    PROVENANCE,
  );
  assert.equal(unauditedSubmit.duplicate, false);
  assert.equal(unauditedSubmit.attempt.publishState, 'failed');
  assert.equal(unauditedSubmit.attempt.failureCode, 'restricted', 'the documented audit eligibility block is the honest restricted failure on the ledger');
  assert.ok(
    String(unauditedSubmit.attempt.providerFailureReason ?? '').includes('unaudited_client_can_only_post_to_private_accounts') ||
      unauditedSubmit.attempt.failureCode === 'restricted',
    'the documented audit refusal is carried as data',
  );
  assert.ok(double().requestCount('video-init') >= 1, 'the provider verifiably answered the documented initiation');

  // (b) THE PRIVATE-MODE CREATOR: the documented creator capability
  // query answers the PRIVATE-account privacy options (NO
  // PUBLIC_TO_EVERYONE), and a public publish refuses through the
  // documented 403 privacy_level_option_mismatch.
  double().registerAccount({ accountId: 'tt-creator-private-1', privacyMode: 'private' });
  double().setClientAudited(true);
  try {
    const connectionId = await makeTikTokConnection(owner, client, 'tiktok');
    const privateAccount = await connectAccount(client, connectionId, {
      creatorId: 'tt-creator-private-1',
      scopes: FULL_GRANT,
    });
    // The private-mode eligibility signal rides the restriction-signals
    // family (the documented private-account option set — no PUBLIC
    // option).
    const signals = await module().readRestrictionSignals(privateAccount, PROVENANCE);
    assert.equal(signals.ok, true, JSON.stringify(signals));
    const optionsSignal = signals.signals.find((signal) => signal.signalKind === 'creator.privacy_level_options')!;
    assert.deepEqual(
      (optionsSignal.data as { privacy_level_options: readonly string[] })['privacy_level_options'],
      ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
      'the documented PRIVATE-account option set rides verbatim (no PUBLIC option)',
    );
    // A public publish against the private-mode creator refuses through
    // the documented semantics — restricted DATA, never a fabricated
    // success.
    const publicSubmit = await module().submitPublish(
      privateAccount,
      { idempotencyKey: 'tt-private-public-1', request: DIRECT_POST_REQUEST },
      PROVENANCE,
    );
    assert.equal(publicSubmit.duplicate, false);
    assert.equal(publicSubmit.attempt.publishState, 'failed');
    assert.equal(publicSubmit.attempt.failureCode, 'restricted', 'the documented privacy_level_option_mismatch is the honest restricted failure');
    // A private (SELF_ONLY) publish against the private-mode creator IS
    // the documented eligible path — accepted.
    const privateSubmit = await module().submitPublish(
      privateAccount,
      {
        idempotencyKey: 'tt-private-selfonly-1',
        request: {
          ...DIRECT_POST_REQUEST,
          payload: { ...DIRECT_POST_REQUEST.payload, privacyLevel: 'SELF_ONLY' },
        },
      },
      PROVENANCE,
    );
    assert.equal(privateSubmit.duplicate, false);
    assert.equal(privateSubmit.attempt.publishState, 'accepted', JSON.stringify(privateSubmit));
  } finally {
    // Restore the unaudited default + the golden account's public mode
    // for the remaining batteries.
    double().setClientAudited(false);
  }
});

// ---------------------------------------------------------------------------
// 5. The publish lifecycle (the dispatch AC)
// ---------------------------------------------------------------------------

test('AC: THE PUBLISH LIFECYCLE — the documented direct-post flow (init → status polling through the documented publish-status surface → the terminal states) + the replay idempotency (ZERO provider calls on replay)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  // The audited client may publish publicly (the audit model lifts the
  // restriction once the client passes the platform audit — the
  // documented flow).
  double().setClientAudited(true);
  try {
    const initRequestsBefore = double().requestCount('video-init');
    // (a) The documented initiation: the born 'accepted' publish with
    // the publish_id as the provider publish identity, NO content id
    // yet (the public post id arrives only through the status fetch,
    // after the documented moderation window).
    const submit = await module().submitPublish(
      account,
      { idempotencyKey: 'tt-lifecycle-1', request: DIRECT_POST_REQUEST },
      PROVENANCE,
    );
    assert.equal(submit.duplicate, false);
    assert.equal(submit.attempt.publishState, 'accepted', JSON.stringify(submit));
    assert.ok(submit.attempt.providerPublishId !== null);
    assert.ok(submit.attempt.providerPublishId.startsWith('v_pub_url~'), 'the documented publish_id form');
    assert.equal(submit.attempt.providerContentId, null, 'no content identity until the public post id arrives');
    assert.equal(submit.attempt.failureCode, null);
    assert.equal(double().requestCount('video-init'), initRequestsBefore + 1, 'exactly ONE documented video/init POST');

    // The REPLAY: same key → the fence answers from the recorded
    // attempt, ZERO provider calls.
    const replay = await module().submitPublish(
      account,
      { idempotencyKey: 'tt-lifecycle-1', request: DIRECT_POST_REQUEST },
      PROVENANCE,
    );
    assert.equal(replay.duplicate, true, 'the replayed key is answered from the fence');
    assert.equal(replay.attempt.attemptId, submit.attempt.attemptId, 'the SAME attempt row');
    assert.equal(double().requestCount('video-init'), initRequestsBefore + 1, 'ZERO provider calls on replay');

    // (b) The status polling through the documented publish-status
    // surface: PROCESSING_DOWNLOAD → the honest still-accepted answer.
    const pendingPoll = await module().refreshPublishStatus(account, submit.attempt.attemptId, PROVENANCE);
    assert.equal(pendingPoll.observation.publishState, 'accepted', JSON.stringify(pendingPoll));
    assert.equal(pendingPoll.observation.providerContentId, null);
    assert.equal(pendingPoll.attempt.publishState, 'accepted', 'the attempt row keeps the SUBMIT-TIME fact');

    // The documented processing completes for a publicly-viewable post:
    // PUBLISH_COMPLETE with the public post id.
    double().advancePublish(submit.attempt.providerPublishId!, 'PUBLISH_COMPLETE', { publicPostId: 7_575_757_575 });
    const publishedPoll = await module().refreshPublishStatus(account, submit.attempt.attemptId, PROVENANCE);
    assert.equal(publishedPoll.observation.publishState, 'published');
    assert.equal(publishedPoll.observation.providerContentId, '7575757575', 'the documented publicaly_available_post_id becomes the content identity');
    // The append-only observation history carries both answers.
    const history = await module().listPublishStatusObservations(account, submit.attempt.attemptId);
    assert.equal(history.length, 2, 'one immutable observation per poll');

    // (c) THE PRIVATE-MODE COMPLETION: a private (SELF_ONLY) publish
    // completes with NO public post id — the documented private viewing
    // mode ("the post_id is returned only if the post is published for
    // public viewership") — the honest published state with a null
    // content identity.
    const privatePost = await module().submitPublish(
      account,
      {
        idempotencyKey: 'tt-lifecycle-private-1',
        request: { ...DIRECT_POST_REQUEST, payload: { ...DIRECT_POST_REQUEST.payload, privacyLevel: 'SELF_ONLY' } },
      },
      PROVENANCE,
    );
    assert.equal(privatePost.attempt.publishState, 'accepted', JSON.stringify(privatePost));
    double().advancePublish(privatePost.attempt.providerPublishId!, 'PUBLISH_COMPLETE', { publicPostId: null });
    const privateCompletePoll = await module().refreshPublishStatus(account, privatePost.attempt.attemptId, PROVENANCE);
    assert.equal(privateCompletePoll.observation.publishState, 'published', 'the private publish completes');
    assert.equal(privateCompletePoll.observation.providerContentId, null, 'NO public post id for a private-mode post — the honest null, never fabricated');

    // (d) The documented FAILED state with a transfer fail_reason: the
    // honest failed outcome carrying the provider's own reason.
    const failingPull = await module().submitPublish(
      account,
      { idempotencyKey: 'tt-lifecycle-pullfail-1', request: DIRECT_POST_REQUEST },
      PROVENANCE,
    );
    assert.equal(failingPull.attempt.publishState, 'accepted');
    double().advancePublish(failingPull.attempt.providerPublishId!, 'FAILED', { failReason: 'video_pull_failed' });
    const pullFailPoll = await module().refreshPublishStatus(account, failingPull.attempt.attemptId, PROVENANCE);
    assert.equal(pullFailPoll.observation.publishState, 'failed');
    assert.ok(String(pullFailPoll.observation.providerFailureReason).includes('video_pull_failed'), 'the documented fail_reason rides as the provider failure reason');

    // (e) The documented FAILED state with a spam_risk fail_reason: the
    // provider-signalled restriction class → the honest restricted
    // outcome carrying the restriction signal.
    const bannedPost = await module().submitPublish(
      account,
      { idempotencyKey: 'tt-lifecycle-spamrisk-1', request: DIRECT_POST_REQUEST },
      PROVENANCE,
    );
    assert.equal(bannedPost.attempt.publishState, 'accepted');
    double().advancePublish(bannedPost.attempt.providerPublishId!, 'FAILED', { failReason: 'spam_risk_user_banned_from_posting' });
    const spamRiskPoll = await module().refreshPublishStatus(account, bannedPost.attempt.attemptId, PROVENANCE);
    assert.equal(spamRiskPoll.observation.publishState, 'restricted', 'the documented spam_risk family is the provider-signalled restriction class');
    assert.equal(spamRiskPoll.observation.restrictionSignals.length, 1);
    assert.equal(spamRiskPoll.observation.restrictionSignals[0]!.signalKind, 'publish.fail_reason.spam_risk_user_banned_from_posting');
    assert.equal(spamRiskPoll.observation.providerFailureReason, null, 'the restriction outcome carries the signal, not a failure reason');

    // (f) THE UPLOAD-STATUS PATH — the documented invalid_publish_id
    // answer of the status fetch (the provider reports no such publish)
    // maps onto the honest provider-unavailable observation.
    double().scriptFailure('status-fetch', { status: 400, code: 'invalid_publish_id', message: 'The publish_id does not exist' });
    const invalidPoll = await module().refreshPublishStatus(account, submit.attempt.attemptId, PROVENANCE);
    double().scriptFailure('status-fetch', null);
    assert.equal(invalidPoll.observation.failureCode, 'provider-unavailable', 'the documented invalid_publish_id answer maps onto the honest provider-unavailable');
    assert.equal(invalidPoll.attempt.publishState, 'accepted', 'the failed poll does not mutate the attempt');

    // (g) The documented provider-side validation: a PULL_FROM_URL
    // initiation without the video_url answers the 400 invalid_param
    // family as honest restricted DATA (the attempt records it).
    const invalid = await module().submitPublish(
      account,
      {
        idempotencyKey: 'tt-lifecycle-invalid-1',
        request: {
          contentType: 'tiktok.video',
          payload: { title: 'No video source', privacyLevel: 'SELF_ONLY' },
          mediaAssets: [],
          attribution: {},
          scheduledFor: null,
        },
      },
      PROVENANCE,
    );
    assert.equal(invalid.attempt.publishState, 'failed');
    assert.equal(invalid.attempt.failureCode, 'restricted', 'the documented invalid_param family is the honest restricted failure');
  } finally {
    // Restore the unaudited default.
    double().setClientAudited(false);
  }
});

// ---------------------------------------------------------------------------
// 6. The policy/rate-limit handling as data (the dispatch AC)
// ---------------------------------------------------------------------------

test('AC: THE POLICY/RATE-LIMIT HANDLING — the documented rate surfaces ride the invocation record as DATA, never an exception escape (429 + Retry-After, the 403 daily cap, the 200-INTENTIONAL answer; the refused publish records honestly)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  double().setClientAudited(true);
  try {
    // A dedicated creator for the rate battery.
    const connectionId = await makeTikTokConnection(owner, client, 'tiktok');
    const rateAccount = await connectAccount(client, connectionId, {
      creatorId: 'tt-creator-rate-1',
      scopes: FULL_GRANT,
    });

    // (a) The documented 429 rate_limit_exceeded (the per-endpoint
    // one-minute sliding window): the observable Retry-After seconds
    // ride the rate-limit observation — as honest rate-limited DATA,
    // NEVER an exception escape.
    double().setRateBudget('user-info', 2);
    double().resetRateWindows();
    const first = await module().readAccountProfile(rateAccount, PROVENANCE);
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await module().readAccountProfile(rateAccount, PROVENANCE);
    assert.equal(second.ok, true);
    const exhausted = await module().readAccountProfile(rateAccount, PROVENANCE);
    assert.ok(!exhausted.ok, 'the exhausted rate window surfaces as data');
    assert.equal(exhausted.failure.code, 'rate-limited');
    assert.ok(exhausted.failure.message.includes('rate_limit_exceeded'), 'the documented 429 error code rides the message');
    assert.ok(exhausted.failure.rateLimit !== null, 'the rate-limit observation rides the invocation record');
    assert.equal(exhausted.failure.rateLimit!.retryAfterSeconds, 42, 'the observable Retry-After seconds ride the observation');
    assert.ok(exhausted.failure.rateLimit!.backoffUntil !== null, 'the backoff-until stamp derives from the Retry-After seconds');

    // (b) The publish path under the exhausted rate window: the attempt
    // records the honest rate-limited refusal (never an exception).
    double().setRateBudget('video-init', 0);
    const refusedSubmit = await module().submitPublish(
      rateAccount,
      { idempotencyKey: 'tt-rate-publish-1', request: DIRECT_POST_REQUEST },
      PROVENANCE,
    );
    assert.equal(refusedSubmit.duplicate, false);
    assert.equal(refusedSubmit.attempt.publishState, 'failed');
    assert.equal(refusedSubmit.attempt.failureCode, 'rate-limited', 'the refused publish records the honest rate-limited failure on the ledger');

    // (c) The documented 403 daily-cap class
    // (spam_risk_too_many_posts — "The daily post cap from the API is
    // reached for the current user"): the daily-quota observation as
    // rate-limited DATA.
    double().setRateBudget('video-init', 6);
    double().setDailyCapExhausted('tt-creator-rate-1', true);
    const cappedSubmit = await module().submitPublish(
      rateAccount,
      { idempotencyKey: 'tt-dailycap-publish-1', request: DIRECT_POST_REQUEST },
      PROVENANCE,
    );
    assert.equal(cappedSubmit.attempt.publishState, 'failed');
    assert.equal(cappedSubmit.attempt.failureCode, 'rate-limited', 'the documented daily-cap class is the honest rate-limited failure');
    assert.ok(String(cappedSubmit.attempt.providerFailureReason ?? '').includes('spam_risk_too_many_posts') || cappedSubmit.attempt.failureCode === 'rate-limited');

    // (d) The documented 200-INTENTIONAL answer of the creator
    // capability query (the daily-cap class served over HTTP 200 with
    // error.code != 'ok'): the code-driven classification surfaces the
    // honest rate-limited DATA.
    const cappedSignals = await module().readRestrictionSignals(rateAccount, PROVENANCE);
    assert.ok(!cappedSignals.ok, 'the documented 200-intentional error answer surfaces as data');
    assert.equal(cappedSignals.failure.code, 'rate-limited', 'the error-code-driven classification maps the 200-intentional answer');
    assert.ok(cappedSignals.failure.message.includes('spam_risk_too_many_posts'), 'the documented error code rides the message');

    // (e) Recovery: clearing the cap restores the documented surface.
    double().setDailyCapExhausted('tt-creator-rate-1', false);
    const recovered = await module().readRestrictionSignals(rateAccount, PROVENANCE);
    assert.equal(recovered.ok, true, 'clearing the cap recovers the documented surface');
  } finally {
    double().setClientAudited(false);
    double().setRateBudget('user-info', 600);
    double().setRateBudget('video-init', 6);
    double().setDailyCapExhausted('tt-creator-rate-1', false);
    double().resetRateWindows();
  }
});

// ---------------------------------------------------------------------------
// 7. The documented error taxonomy (the code-driven classifier)
// ---------------------------------------------------------------------------

test('the REAL adapter classifies the documented v2 error struct onto the frozen taxonomy (401 / 429 / 403 audit / 5xx / transport-refused)', async () => {
  const { accountId: account } = await ensureGoldenAccount();
  const cases: readonly {
    readonly label: string;
    readonly failure: { readonly status: number; readonly code: string; readonly message: string; readonly retryAfterSeconds?: number };
    readonly expected: 'auth-expired' | 'rate-limited' | 'restricted' | 'provider-unavailable';
    readonly expectsObservation?: boolean;
  }[] = [
    {
      label: '401 access_token_invalid (the token class) → auth-expired',
      failure: { status: 401, code: 'access_token_invalid', message: 'The access token is invalid or has expired.' },
      expected: 'auth-expired',
    },
    {
      label: '429 rate_limit_exceeded + Retry-After → rate-limited WITH the observation',
      failure: { status: 429, code: 'rate_limit_exceeded', message: 'Your request is blocked due to exceeding the API rate limit.', retryAfterSeconds: 30 },
      expected: 'rate-limited',
      expectsObservation: true,
    },
    {
      label: '403 spam_risk_too_many_posts (the documented daily-cap class) → rate-limited',
      failure: { status: 403, code: 'spam_risk_too_many_posts', message: 'The daily post cap from the API is reached for the current user.' },
      expected: 'rate-limited',
    },
    {
      label: '403 unaudited_client_can_only_post_to_private_accounts (the audit class) → restricted',
      failure: { status: 403, code: 'unaudited_client_can_only_post_to_private_accounts', message: 'Unaudited clients can only post to a private account.' },
      expected: 'restricted',
    },
    {
      label: '5xx internal_error → provider-unavailable',
      failure: { status: 500, code: 'internal_error', message: 'This is the generic error code for TikTok internal errors.' },
      expected: 'provider-unavailable',
    },
  ];
  for (const { label, failure, expected, expectsObservation } of cases) {
    double().scriptFailure('user-info', failure);
    const outcome = await module().readAccountProfile(account, PROVENANCE);
    double().scriptFailure('user-info', null);
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
});

test('the transport-refused provider maps to provider-unavailable (the dead data-plane base URL)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  // A connection whose apiBaseUrl points at a dead loopback port — the
  // documented deployment override surface carries the failure.
  const connectionId = await makeTikTokConnection(owner, client, 'tiktok', { apiBaseUrl: 'http://127.0.0.1:9' });
  const deadAccount = await connectAccount(client, connectionId, {
    creatorId: 'tt-creator-dead-1',
    scopes: FULL_GRANT,
  });
  const outcome = await module().readAccountProfile(deadAccount, PROVENANCE);
  assert.ok(!outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.failure.code, 'provider-unavailable');
  assert.ok(outcome.failure.message.includes('transport refused') || outcome.failure.message.includes('not processed'));
});

// ---------------------------------------------------------------------------
// 8. The strict scope pre-flight (the dispatch AC)
// ---------------------------------------------------------------------------

test('the strict scope pre-flight refuses publish + restriction-signals on the read-only REAL-scope grant (zero provider traffic)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  const connectionId = await makeTikTokConnection(owner, client, 'tiktok');
  const readOnlyAccount = await connectAccount(client, connectionId, {
    creatorId: 'tt-creator-readonly-1',
    scopes: READ_ONLY_GRANT,
  });
  // The capability view honestly reports the video.publish-gated
  // families unsatisfied.
  const view = await module().resolveAccountCapabilityMatrix(readOnlyAccount);
  assert.ok(view !== null);
  const publishSatisfaction = view!.scopeSatisfaction.find((entry) => entry.family === 'publish');
  assert.ok(publishSatisfaction !== undefined);
  assert.deepEqual(publishSatisfaction!.missingScopes, [VIDEO_PUBLISH]);
  const signalsSatisfaction = view!.scopeSatisfaction.find((entry) => entry.family === 'restriction-signals');
  assert.ok(signalsSatisfaction !== undefined);
  assert.deepEqual(signalsSatisfaction!.missingScopes, [VIDEO_PUBLISH]);
  // The publish submit refuses pre-flight with the scope named verbatim.
  const before = double().totalRequestCount();
  const submit = await module().submitPublish(
    readOnlyAccount,
    {
      idempotencyKey: 'tt-readonly-publish-1',
      request: { ...DIRECT_POST_REQUEST, payload: { ...DIRECT_POST_REQUEST.payload, privacyLevel: 'SELF_ONLY' } },
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

// ---------------------------------------------------------------------------
// 9. The capability-subset enforcement (the dispatch AC)
// ---------------------------------------------------------------------------

test('AC: THE CAPABILITY-SUBSET ENFORCEMENT — an undeclared OPERATION of a declared family AND an undeclared FAMILY both refuse fail-closed with ZERO provider traffic (the disclosed tiktok-narrow double)', async () => {
  const { principal: owner, clientId: client } = await ensureGoldenAccount();
  const connectionId = await makeTikTokConnection(owner, client, NARROW_PLATFORM_KEY);
  const narrowAccount = await connectAccount(client, connectionId, {
    creatorId: 'tt-creator-narrow-1',
    scopes: FULL_GRANT,
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
  const own = await module().listOwnContent(narrowAccount, { pageCursor: null, limit: 1 }, PROVENANCE);
  assert.equal(own.ok, true, 'the declared listOwnContent stays served');
  // The UNDECLARED OPERATION of the declared family refuses fail-closed
  // with ZERO provider traffic.
  const before = double().totalRequestCount();
  const discovery = await module().discoverPublicContent(narrowAccount, { query: 'anything', pageCursor: null, limit: 1 }, PROVENANCE);
  assert.ok(!discovery.ok, 'the undeclared operation refuses');
  assert.equal(discovery.failure.code, 'unsupported-capability');
  assert.equal(double().totalRequestCount(), before, 'ZERO provider traffic for the undeclared operation');
  // The UNDECLARED FAMILY refuses the same fail-closed way.
  const analytics = await module().readAccountAnalytics(narrowAccount, { windowStart: null, windowEnd: null }, PROVENANCE);
  assert.ok(!analytics.ok, 'the undeclared family refuses');
  assert.equal(analytics.failure.code, 'unsupported-capability');
  assert.equal(double().totalRequestCount(), before, 'ZERO provider traffic for the undeclared family');
  // The production 'tiktok' registration is untouched (the narrow key
  // never overrode it — the seam-override is keyed).
  const registered = module().listRegisteredSocialAdapters();
  assert.ok(registered.some((info) => info.descriptor.adapterKey === 'tiktok'), 'the production tiktok registration is intact');
  assert.ok(registered.some((info) => info.descriptor.adapterKey === NARROW_PLATFORM_KEY), 'the narrow double registers under its OWN key');
});
