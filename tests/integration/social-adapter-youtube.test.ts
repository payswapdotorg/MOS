/**
 * MKT-057 integration tests — the YOUTUBE social platform adapter on
 * the REAL stack: embedded PostgreSQL 18, the spawned production API
 * and IN-PROCESS applications composed through the disclosed seams.
 *
 * Two proofs, each with its own disclosed double at the provider
 * boundary ONLY (the contract HOST under test — the capability gates,
 * the strict scope pre-flight, the /policies fail-closed gates, the
 * migration-050 idempotency fence, the claim-then-fill ledger — is
 * fully REAL in both):
 *
 *   1. THE CONFORMANCE SUITE (the dispatch AC): the full 17-scenario
 *      MKT-056 battery
 *      (tests/integration/helpers/social-adapter-conformance.ts) runs
 *      against the disclosed IN-MEMORY YouTube platform double
 *      (tests/integration/helpers/youtube-platform-double.ts — the
 *      documented-API behavioral model: pageToken pagination, quota
 *      cost accounting, the resumable-upload lifecycle, restriction
 *      signals, failure injection) with the REAL Google OAuth scope
 *      URIs as the fixture grants (the documented test-only suite
 *      extension — YouTube's real scopes fall outside the default
 *      fixture vocabulary);
 *
 *   2. THE REAL ADAPTER END-TO-END (the composition-root registration
 *      proof): the application boots with NO socialPlatformAdapters
 *      seam — the PRODUCTION-composed YouTube adapter (the MKT-057
 *      composition-root registration, the platform FetchHttpCall
 *      transport) serves every operation through the module API
 *      against the disclosed COMBINED provider double
 *      (tests/integration/helpers/youtube-http-double.ts — the loopback
 *      HTTP server faithfully mirroring the documented Data API v3 +
 *      Analytics API v2 endpoints, reached through the connection's
 *      providerConfig apiBaseUrl override, the documented deployment
 *      override surface of the www.googleapis.com host).
 *
 * The battery pins: the production registration (registry data + the
 * REAL capability matrix + REAL scopes), the documented-semantics
 * mappings (channels identity/profile, search pagination + the honest
 * null engagement on search pages, videos statistics with NO share
 * count, analytics metric labels VERBATIM, the region-restriction
 * signal), the resumable-upload lifecycle (born accepted → 308 probe →
 * published/rejected/failed + the documented 400 processed rejection),
 * the seven-code taxonomy over the documented Google error envelope
 * (401 / 403 quota family with the Retry-After observation / 403
 * forbidden / 5xx / transport-refused / quota exhaustion), the quota
 * cost model, the at-most-once fence over the real adapter, the strict
 * REAL-scope pre-flight and the composition-root inertness (zero
 * provider traffic without an authorized YouTube connection).
 */

import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
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
  startYouTubeProviderDouble,
  youTubeDoubleDefaultChannel,
  type YouTubeProviderDouble,
} from './helpers/youtube-http-double.ts';
import {
  createYouTubePlatformDouble,
  YOUTUBE_FULL_SCOPES,
  YOUTUBE_READ_ONLY_SCOPES,
} from './helpers/youtube-platform-double.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'social-adapter-youtube-pipe-key';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-0000000000dd',
  recordedVia: 'test',
  correlationId: 'integration-social-adapter-youtube-1',
  causationId: null,
} as const;

/** The REAL Google OAuth scope URIs the adapter declares (the strict pre-flight vocabulary). */
const YOUTUBE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
const YOUTUBE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const YOUTUBE_ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const FULL_GRANT = [YOUTUBE_READONLY, YOUTUBE_ANALYTICS, YOUTUBE_UPLOAD] as const;
const READ_ONLY_GRANT = [YOUTUBE_READONLY] as const;

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: YouTubeProviderDouble | null = null;
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
function double(): YouTubeProviderDouble {
  if (provider === null) throw new Error('provider double not booted');
  return provider;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}
function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

before(async () => {
  stack = await bootStack('social_yt_real');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startYouTubeProviderDouble();
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  // NO socialPlatformAdapters seam: the PRODUCTION-composed YouTube
  // adapter (the MKT-057 composition-root registration on the platform
  // FetchHttpCall transport) serves every operation of this battery.
  const core = await bootstrapApplication({
    integrationAdapters: [createReferenceIntegrationStub('youtube')],
    socialAccountFlows: [
      createLocalOAuthFlow(provider, { adapterKey: 'youtube', secretsDir: stack.env.secretsDir }),
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
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  return { userId, token: login.body['token'] as string, agencyId: (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string };
}

async function makeClient(principal: Principal, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${principal.agencyId}/clients`, {
    token: principal.token,
    body: { name },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
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
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

let connectionSequence = 0;
/** Creates + connects the YouTube-keyed integration connection (providerConfig points the REAL adapter at the double). */
async function makeYouTubeConnection(
  principal: Principal,
  clientId: string,
  providerConfig: Record<string, string> = {},
): Promise<string> {
  connectionSequence += 1;
  const credential = await credentialsModule().createCredentialReference({
    agencyId: principal.agencyId,
    clientId,
    kind: 'integration_api_key',
    label: `youtube_pipe_${clientId.slice(0, 8)}_${connectionSequence}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection(
    {
      clientId,
      adapterKey: 'youtube',
      credentialReferenceId: credential.credentialId,
      // The documented deployment override surface: the data-plane base
      // URL of the connection (apiBaseUrl + analyticsApiBaseUrl) points
      // the production adapter at the loopback provider double.
      providerConfig: {
        apiBaseUrl: double().url,
        analyticsApiBaseUrl: double().url,
        platformHint: 'youtube',
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
    readonly channelId: string;
    readonly scopes: readonly string[];
    readonly capabilityTags?: readonly string[];
  },
): Promise<string> {
  const start = await module().startAuthorization(
    { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...fixture.scopes], expectedAccountId: null },
    PROVENANCE,
  );
  const issued = double().issueAuthorization({
    accountId: fixture.channelId,
    displayIdentity: `yt:${fixture.channelId}`,
    verifiedAt: '2026-07-01T09:30:00.000Z',
    scopes: [...fixture.scopes],
    capabilityTags: fixture.capabilityTags ?? ['youtube-tag'],
    expiresInMs: 3_600_000,
  });
  const completion = await module().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    PROVENANCE,
  );
  return completion.account.socialAccountId;
}

const PUBLISH_REQUEST = {
  contentType: 'youtube.video',
  payload: {
    title: 'The documented snippet title',
    description: 'The normalized publish request mapped onto the video resource metadata.',
    tags: ['marketing', 'growth'],
    categoryId: '22',
    privacyStatus: 'public',
    selfDeclaredMadeForKids: false,
  },
  mediaAssets: [{ assetReference: 'content-asset:ca:fixture-1', mediaKind: 'video', descriptor: { filename: 'clip.mp4', mime: 'video/mp4' } }],
  attribution: { missionId: 'mission-yt-1', experimentId: 'exp-yt-1' },
  scheduledFor: null,
} as const;

// ---------------------------------------------------------------------------
// 1. The conformance suite (the dispatch AC — the in-memory double + REAL scopes)
// ---------------------------------------------------------------------------

test('AC: the YouTube platform double passes the full 17-scenario social adapter conformance suite (the REAL Google scope fixtures)', async () => {
  const suiteProvider = await startYouTubeProviderDouble();
  const suiteAdapter = createYouTubePlatformDouble();
  try {
    const report = await runSocialAdapterConformanceSuite({
      adapter: suiteAdapter,
      adapterHandle: suiteAdapter,
      provider: suiteProvider,
      label: 'youtube',
      fullScopes: [...YOUTUBE_FULL_SCOPES],
      readOnlyScopes: [...YOUTUBE_READ_ONLY_SCOPES],
    });
    assert.equal(report.failed, 0);
    const names = report.scenarios.map((scenario) => scenario.name).join('\n');
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
    assert.equal(report.scenarios.length, 17, 'the full battery ran');
  } finally {
    await suiteProvider.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The composition-root registration (the production adapter as DATA)
// ---------------------------------------------------------------------------

test('the composition root registers the YouTube adapter as production DATA — the REAL capability matrix, INERT without a connection', async () => {
  // The registration is data: the registry exposes the REAL descriptor + matrix.
  const registered = module().listRegisteredSocialAdapters();
  const youtube = registered.find((info) => info.descriptor.adapterKey === 'youtube');
  assert.ok(youtube !== undefined, 'the production composition registered the YouTube adapter');
  assert.equal(youtube.descriptor.providerLabel, 'YouTube (Data API v3 + Analytics API v2)');
  assert.deepEqual(
    youtube.capabilities.map((capability) => [capability.family, [...capability.operations]]),
    [
      ['account', ['verifyAccountIdentity', 'getAccountProfile']],
      ['content-read', ['discoverPublicContent', 'listOwnContent', 'getContent']],
      ['analytics-read', ['readAccountAnalytics', 'readContentAnalytics']],
      ['publish', ['submitPublish', 'getPublishStatus']],
      ['restriction-signals', ['readRestrictionSignals']],
    ],
    'the REAL declared matrix (the honest SUBSET with the closed vocabularies)',
  );
  // The REAL Google OAuth scope URIs (least privilege per family).
  const scopesOf = new Map(youtube.capabilities.map((capability) => [capability.family, [...capability.requiredScopes]]));
  assert.deepEqual(scopesOf.get('account'), [YOUTUBE_READONLY]);
  assert.deepEqual(scopesOf.get('content-read'), [YOUTUBE_READONLY]);
  assert.deepEqual(scopesOf.get('analytics-read'), [YOUTUBE_ANALYTICS]);
  assert.deepEqual(scopesOf.get('publish'), [YOUTUBE_UPLOAD]);
  assert.deepEqual(scopesOf.get('restriction-signals'), [YOUTUBE_READONLY]);
  // The INERTNESS proof: the registered adapter performed ZERO provider
  // traffic (no authorized YouTube connection exists yet — the
  // fail-closed chain precedes every provider call).
  assert.equal(double().totalRequestCount(), 0, 'the registration alone performs ZERO provider traffic');
});

// ---------------------------------------------------------------------------
// 3. The documented-semantics mappings through the REAL adapter
// ---------------------------------------------------------------------------

test('the REAL adapter maps the documented channels.list identity/profile facts (mine=true, verifiedAt null, statistics passthrough)', async () => {
  const principal = await makeAgencyOwner('yt-identity@adapter.test');
  const clientId = await makeClient(principal, 'YT Identity Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-identity'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-identity', scopes: FULL_GRANT });

  const identity = await module().verifyAccountIdentity(accountId, PROVENANCE);
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.identity.externalAccountId, 'yt-channel-identity');
  assert.equal(identity.identity.displayIdentity, 'Fixture Channel yt-channel-identity');
  // The Data API exposes no identity-verification timestamp — null (disclosed).
  assert.equal(identity.identity.verifiedAt, null);
  assert.equal(identity.rateLimit, null, 'successful YouTube calls expose NO quota headers (the documented quota is project-side)');

  const profile = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(profile.ok, true, JSON.stringify(profile));
  assert.equal(profile.profile.externalAccountId, 'yt-channel-identity');
  assert.equal(profile.profile.accountKind, 'youtube#channel');
  assert.equal(profile.profile.followerCount, 4242);
  // The provider payload rides VERBATIM as passthrough data.
  assert.equal((profile.profile.data as { id?: string }).id, 'yt-channel-identity');
  assert.equal(
    (profile.profile.data as { statistics?: { subscriberCount?: string } }).statistics?.subscriberCount,
    '4242',
    'the documented statistics ride verbatim',
  );

  // The capability-matrix view composes the REAL scopes against the grant.
  const view = await module().resolveAccountCapabilityMatrix(accountId);
  assert.ok(view !== null && view.registered && view.authorizationUsable);
  assert.ok(view!.scopeSatisfaction.every((entry) => entry.satisfied), 'the full REAL-scope grant satisfies every capability');
});

test('the REAL adapter maps the documented search pagination + the honest NULL engagement on search pages; videos.list carries the statistics (NO share count)', async () => {
  const principal = await makeAgencyOwner('yt-content@adapter.test');
  const clientId = await makeClient(principal, 'YT Content Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-content'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-content', scopes: FULL_GRANT });

  // Public discovery: the documented pageToken/nextPageToken round-trip.
  const pageOne = await module().discoverPublicContent(accountId, { query: 'growth marketing', pageCursor: null, limit: 2 }, PROVENANCE);
  assert.equal(pageOne.ok, true, JSON.stringify(pageOne));
  assert.equal(pageOne.page.records.length, 2);
  assert.equal(pageOne.page.pageCursor, 'yt-page-2', 'the documented nextPageToken rides the cursor');
  // The documented search limitation: search results carry NO statistics.
  for (const record of pageOne.page.records) {
    assert.deepEqual(
      record.engagement,
      { viewCount: null, likeCount: null, commentCount: null, shareCount: null },
      'search pages expose no engagement facts — never fabricated',
    );
    assert.equal(record.contentFormat, 'youtube#video');
  }
  const pageTwo = await module().discoverPublicContent(accountId, { query: 'growth marketing', pageCursor: pageOne.page.pageCursor, limit: 2 }, PROVENANCE);
  assert.equal(pageTwo.ok, true, JSON.stringify(pageTwo));
  assert.equal(pageTwo.page.records.length, 1);
  assert.equal(pageTwo.page.pageCursor, null, 'the last page carries no cursor');

  // The own-content listing (channelId search): the public videos.
  const own = await module().listOwnContent(accountId, { pageCursor: null, limit: 10 }, PROVENANCE);
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(own.page.records.length, 4, 'the fixture channel carries 4 public videos (3 + the region-restricted one)');
  for (const record of own.page.records) {
    assert.equal(record.authorExternalAccountId, 'yt-channel-content');
    assert.deepEqual(record.engagement, { viewCount: null, likeCount: null, commentCount: null, shareCount: null });
  }

  // The single-content read: the documented statistics part.
  const single = await module().getContent(accountId, { providerContentId: 'yt-video-yt-channel-content-1' }, PROVENANCE);
  assert.equal(single.ok, true, JSON.stringify(single));
  assert.ok(single.record !== null);
  assert.equal(single.record!.engagement.viewCount, 1000);
  assert.equal(single.record!.engagement.likeCount, 100);
  assert.equal(single.record!.engagement.commentCount, 10);
  // The documented Data API statistics expose NO share count.
  assert.equal(single.record!.engagement.shareCount, null, 'shareCount is always null (shares are an Analytics metric only)');
  assert.equal((single.record!.data as { status?: { uploadStatus?: string } }).status?.uploadStatus, 'processed');

  // An unknown video id: the documented EMPTY items list — the honest null record.
  const unknown = await module().getContent(accountId, { providerContentId: 'yt-video-unknown' }, PROVENANCE);
  assert.equal(unknown.ok, true, JSON.stringify(unknown));
  assert.equal(unknown.record, null, 'the honest null record — never a fabricated failure');
});

test('the REAL adapter maps the documented Analytics reports (labels VERBATIM, per-video filters, the empty-window honesty)', async () => {
  const principal = await makeAgencyOwner('yt-analytics@adapter.test');
  const clientId = await makeClient(principal, 'YT Analytics Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-analytics'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-analytics', scopes: FULL_GRANT });

  const accountAnalytics = await module().readAccountAnalytics(
    accountId,
    { windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-08-31T00:00:00.000Z' },
    PROVENANCE,
  );
  assert.equal(accountAnalytics.ok, true, JSON.stringify(accountAnalytics));
  assert.deepEqual(
    accountAnalytics.observations.map((observation) => observation.metric),
    ['views', 'subscribersGained', 'subscribersLost', 'estimatedMinutesWatched'],
    'the provider metric labels ride VERBATIM',
  );
  assert.equal(accountAnalytics.observations[0]!.value, 12345);
  assert.equal(accountAnalytics.observations[0]!.windowStart, '2026-08-01T00:00:00.000Z');

  // Per-video analytics (the documented filters=video==<id> form, one
  // report per id) — a null window defaults to the wide documented window.
  const contentAnalytics = await module().readContentAnalytics(
    accountId,
    { providerContentIds: ['yt-video-yt-channel-analytics-1'], windowStart: null, windowEnd: null },
    PROVENANCE,
  );
  assert.equal(contentAnalytics.ok, true, JSON.stringify(contentAnalytics));
  assert.deepEqual(
    contentAnalytics.observations.map((observation) => observation.metric),
    ['views', 'likes', 'comments', 'shares', 'estimatedMinutesWatched'],
    "'shares' is observable as an Analytics metric (it is NOT in the Data API statistics)",
  );
  assert.ok(contentAnalytics.observations.every((observation) => observation.data['providerContentId'] === 'yt-video-yt-channel-analytics-1'));
  assert.equal(contentAnalytics.observations[0]!.windowStart, '2005-01-01T00:00:00.000Z', 'the null window defaulted to the wide documented window');
});

test('the REAL adapter surfaces ONLY the provider-exposed restriction signals (the regionRestriction surface)', async () => {
  const principal = await makeAgencyOwner('yt-signals@adapter.test');
  const clientId = await makeClient(principal, 'YT Signals Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-signals'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-signals', scopes: FULL_GRANT });

  const signals = await module().readRestrictionSignals(accountId, PROVENANCE);
  assert.equal(signals.ok, true, JSON.stringify(signals));
  assert.equal(signals.signals.length, 1, 'ONLY the observable region-restriction fact (hidden moderation state never invented)');
  assert.equal(signals.signals[0]!.signalKind, 'video.regionRestriction');
  assert.deepEqual(signals.signals[0]!.data, { videoId: 'yt-video-yt-channel-signals-geo', allowed: null, blocked: ['DE', 'JP'] });
});

// ---------------------------------------------------------------------------
// 4. The publish lifecycle (the documented resumable upload protocol)
// ---------------------------------------------------------------------------

test('the REAL adapter runs the documented resumable-upload lifecycle: born accepted → 308 probe → published; the fence holds at-most-once', async () => {
  const principal = await makeAgencyOwner('yt-publish@adapter.test');
  const clientId = await makeClient(principal, 'YT Publish Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-publish'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-publish', scopes: FULL_GRANT });

  const submitsBefore = double().requestCount('insert');
  const submit = await module().submitPublish(accountId, { idempotencyKey: 'yt-publish-key-1', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(submit.duplicate, false);
  // The born upload session: 'accepted' (the documented async
  // processing), the session id as the provider publish identity, NO
  // content id yet.
  assert.equal(submit.attempt.publishState, 'accepted', JSON.stringify(submit));
  assert.ok(submit.attempt.providerPublishId !== null);
  assert.equal(submit.attempt.providerContentId, null);
  assert.equal(submit.attempt.failureCode, null);
  assert.equal(double().requestCount('insert'), submitsBefore + 1, 'exactly ONE initiation reached the provider');

  // The idempotent replay: the fence answers, ZERO provider traffic.
  const replay = await module().submitPublish(accountId, { idempotencyKey: 'yt-publish-key-1', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.attempt.attemptId, submit.attempt.attemptId);
  assert.equal(double().requestCount('insert'), submitsBefore + 1, 'the replay NEVER reached the provider (the at-most-once fence)');

  // The session probe BEFORE completion: the documented 308 Resume
  // Incomplete — the honest still-processing answer.
  const first = await module().refreshPublishStatus(accountId, submit.attempt.attemptId, PROVENANCE);
  assert.equal(first.observation.publishState, 'accepted');

  // The provider-side processing completes: the poll observes
  // 'published' with the video id; the attempt keeps the submit-time fact.
  double().advanceUploadSession(submit.attempt.providerPublishId!, 'published', { videoId: 'yt-video-published-1' });
  const second = await module().refreshPublishStatus(accountId, submit.attempt.attemptId, PROVENANCE);
  assert.equal(second.observation.publishState, 'published');
  assert.equal(second.observation.providerContentId, 'yt-video-published-1');
  assert.equal(second.attempt.publishState, 'accepted', 'the attempt row keeps the SUBMIT-TIME fact');
  const history = await module().listPublishStatusObservations(accountId, submit.attempt.attemptId);
  assert.equal(history.length, 2, 'one immutable observation per poll');
});

test('the rejected upload maps to restricted with the documented rejectionReason signal; the failed upload to failed', async () => {
  const principal = await makeAgencyOwner('yt-rejected@adapter.test');
  const clientId = await makeClient(principal, 'YT Rejected Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-rejected'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-rejected', scopes: FULL_GRANT });

  // The rejected upload (the documented uploadStatus=rejected + rejectionReason).
  const rejected = await module().submitPublish(accountId, { idempotencyKey: 'yt-rejected-key', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(rejected.attempt.publishState, 'accepted');
  double().advanceUploadSession(rejected.attempt.providerPublishId!, 'rejected', { rejectionReason: 'inappropriate' });
  const rejectedPoll = await module().refreshPublishStatus(accountId, rejected.attempt.attemptId, PROVENANCE);
  assert.equal(rejectedPoll.observation.publishState, 'restricted');
  assert.equal(rejectedPoll.observation.failureCode, null, 'a restricted outcome is not a taxonomy failure — the signals carry it');
  assert.equal(rejectedPoll.observation.restrictionSignals[0]!.signalKind, 'video.uploadStatus.rejected');
  assert.equal(rejectedPoll.observation.restrictionSignals[0]!.data['rejectionReason'], 'inappropriate');

  // The failed upload (the documented uploadStatus=failed).
  const failed = await module().submitPublish(accountId, { idempotencyKey: 'yt-failed-key', request: PUBLISH_REQUEST }, PROVENANCE);
  double().advanceUploadSession(failed.attempt.providerPublishId!, 'failed');
  const failedPoll = await module().refreshPublishStatus(accountId, failed.attempt.attemptId, PROVENANCE);
  assert.equal(failedPoll.observation.publishState, 'failed');
  assert.ok((failedPoll.observation.providerFailureReason ?? '').includes('uploadStatus=failed'));
});

test('the documented 400 metadata refusal surfaces as the honest restricted data failure (the frozen ledger CHECK forbids the null-code processed rejection)', async () => {
  const principal = await makeAgencyOwner('yt-metadata@adapter.test');
  const clientId = await makeClient(principal, 'YT Metadata Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-metadata'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-metadata', scopes: FULL_GRANT });

  // A video resource WITHOUT a title: the documented provider-side
  // validation answers 400 invalidVideoMetadata. The frozen taxonomy
  // has no malformed-request code and the frozen migration-050 CHECK
  // (failed ⇒ failure_code NOT NULL) forbids the null-code processed-
  // rejection row on the ATTEMPT ledger — the adapter surfaces the
  // honest 'restricted' data failure with the verbatim envelope in the
  // message; the provider's own reason is observable at the provider
  // boundary (the double recorded the refused initiation).
  const insertBefore = double().requestCount('insert');
  const submit = await module().submitPublish(
    accountId,
    {
      idempotencyKey: 'yt-metadata-key',
      request: {
        contentType: 'youtube.video',
        payload: { description: 'No title — the documented 400 battery.' },
        mediaAssets: [],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed');
  assert.equal(submit.attempt.failureCode, 'restricted', 'the classifier’s disclosed 4xx mapping — non-retryable provider-side refusal');
  assert.equal(submit.attempt.providerPublishId, null, 'no upload session exists for the refused metadata');
  assert.equal(double().requestCount('insert'), insertBefore + 1, 'the provider validated and refused the initiation');
  // The ledger row: failed + the taxonomy code (the frozen CHECK fence holds).
  const row = await pool().query<{ publish_state: string; failure_code: string | null; provider_publish_id: string | null }>(
    'SELECT publish_state, failure_code, provider_publish_id FROM social_publish_attempts WHERE attempt_id = $1',
    [submit.attempt.attemptId],
  );
  assert.equal(row.rows[0]!.publish_state, 'failed');
  assert.equal(row.rows[0]!.failure_code, 'restricted');
  assert.equal(row.rows[0]!.provider_publish_id, null);
});

// ---------------------------------------------------------------------------
// 5. The seven-code taxonomy over the documented Google error envelope
// ---------------------------------------------------------------------------

test('the REAL adapter classifies the documented error envelope onto the frozen taxonomy (401 / 403 quota family with observation / 403 forbidden / 5xx)', async () => {
  const principal = await makeAgencyOwner('yt-taxonomy@adapter.test');
  const clientId = await makeClient(principal, 'YT Taxonomy Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-taxonomy'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-taxonomy', scopes: FULL_GRANT });

  // 401 unauthorized → auth-expired (the reauthorization signal).
  double().scriptFailure('channels', { status: 401, reason: 'unauthorized', message: 'The request uses an invalid authorization token.', retryAfterSeconds: null });
  const unauthorized = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.failure.code, 'auth-expired');
  assert.ok(unauthorized.failure.message.includes('unauthorized'));

  // 403 rateLimitExceeded + Retry-After → rate-limited WITH the observable backoff observation.
  double().scriptFailure('channels', { status: 403, reason: 'rateLimitExceeded', message: 'Rate limit exceeded.', retryAfterSeconds: 30 });
  const rateLimited = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.failure.code, 'rate-limited');
  assert.equal(rateLimited.failure.rateLimit?.retryAfterSeconds, 30, 'the Retry-After header rides the rate-limit observation');
  assert.ok(rateLimited.failure.rateLimit?.backoffUntil !== null);

  // 403 forbidden → restricted (the provider signalled an eligibility block).
  double().scriptFailure('channels', { status: 403, reason: 'forbidden', message: 'Access forbidden.', retryAfterSeconds: null });
  const forbidden = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.failure.code, 'restricted');

  // 503 backendError → provider-unavailable (the retryable transport class).
  double().scriptFailure('channels', { status: 503, reason: 'backendError', message: 'The service is unavailable.', retryAfterSeconds: null });
  const unavailable = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.failure.code, 'provider-unavailable');
  double().scriptFailure('channels', null);
  const recovered = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(recovered.ok, true, 'clearing the scripting recovers');
});

test('the documented quota-cost accounting drives the 403 quotaExceeded exhaustion (rate-limited, no fabricated backoff)', async () => {
  const principal = await makeAgencyOwner('yt-quota@adapter.test');
  const clientId = await makeClient(principal, 'YT Quota Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-quota'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-quota', scopes: FULL_GRANT });

  // The documented cost model: search.list costs 100 units; a budget of
  // 100 admits exactly one search then the next call exhausts it.
  double().resetQuota();
  double().setDailyQuotaUnits(100);
  const firstSearch = await module().discoverPublicContent(accountId, { query: 'quota', pageCursor: null, limit: 1 }, PROVENANCE);
  assert.equal(firstSearch.ok, true, JSON.stringify(firstSearch));
  assert.equal(double().consumedQuotaUnits(), 100);
  const exhausted = await module().discoverPublicContent(accountId, { query: 'quota', pageCursor: null, limit: 1 }, PROVENANCE);
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.failure.code, 'rate-limited');
  assert.ok(exhausted.failure.message.includes('quotaExceeded'), 'the documented quota reason rides verbatim');
  // The daily quota sends NO Retry-After — the honest null backoff.
  assert.equal(exhausted.failure.rateLimit?.retryAfterSeconds, null);
  double().setDailyQuotaUnits(10_000);
  double().resetQuota();
});

test('the transport-refused provider maps to provider-unavailable (the dead data-plane base URL)', async () => {
  // A closed loopback port: the documented https-or-loopback envelope
  // permits the loopback target; the connection is refused.
  const deadServer = net.createServer();
  await new Promise<void>((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
  const deadPort = (deadServer.address() as AddressInfo).port;
  await new Promise<void>((resolve) => deadServer.close(() => resolve()));

  const principal = await makeAgencyOwner('yt-transport@adapter.test');
  const clientId = await makeClient(principal, 'YT Transport Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-transport'));
  // The connection's providerConfig points the data plane at the dead port.
  const connectionId = await makeYouTubeConnection(principal, clientId, { apiBaseUrl: `http://127.0.0.1:${deadPort}` });
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-transport', scopes: FULL_GRANT });

  const outcome = await module().readAccountProfile(accountId, PROVENANCE);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure.code, 'provider-unavailable', JSON.stringify(outcome.failure));
  assert.ok(outcome.failure.message.includes('transport refused'));
});

test('the documented 403 youtubeSignupRequired eligibility answer maps to restricted (the account cannot use the YouTube surface)', async () => {
  const principal = await makeAgencyOwner('yt-signup@adapter.test');
  const clientId = await makeClient(principal, 'YT Signup Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  // NO channel registered for this account: the documented eligibility answer.
  const connectionId = await makeYouTubeConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-signupless', scopes: FULL_GRANT });

  const identity = await module().verifyAccountIdentity(accountId, PROVENANCE);
  assert.equal(identity.ok, false, JSON.stringify(identity));
  assert.equal(identity.failure.code, 'restricted');
  assert.ok(identity.failure.message.includes('youtubeSignupRequired'), 'the documented eligibility reason rides verbatim');
});

// ---------------------------------------------------------------------------
// 6. The strict REAL-scope pre-flight over the real adapter
// ---------------------------------------------------------------------------

test('the strict scope pre-flight refuses analytics + publish on the read-only REAL-scope grant (zero provider traffic)', async () => {
  const principal = await makeAgencyOwner('yt-scopes@adapter.test');
  const clientId = await makeClient(principal, 'YT Scopes Client');
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  double().registerChannel(youTubeDoubleDefaultChannel('yt-channel-scopes'));
  const connectionId = await makeYouTubeConnection(principal, clientId);
  // The read-only grant: only youtube.readonly — analytics + publish
  // require their REAL scopes (yt-analytics.readonly / youtube.upload).
  const accountId = await connectAccount(clientId, connectionId, { channelId: 'yt-channel-scopes', scopes: READ_ONLY_GRANT });

  const view = await module().resolveAccountCapabilityMatrix(accountId);
  assert.ok(view !== null && view.authorizationUsable);
  const satisfaction = new Map(view!.scopeSatisfaction.map((entry) => [entry.family, entry]));
  assert.equal(satisfaction.get('account')!.satisfied, true);
  assert.equal(satisfaction.get('content-read')!.satisfied, true);
  assert.equal(satisfaction.get('restriction-signals')!.satisfied, true);
  assert.deepEqual(satisfaction.get('analytics-read')!.missingScopes, [YOUTUBE_ANALYTICS]);
  assert.deepEqual(satisfaction.get('publish')!.missingScopes, [YOUTUBE_UPLOAD]);

  const analyticsBefore = double().requestCount('analytics');
  const analytics = await module().readAccountAnalytics(accountId, { windowStart: null, windowEnd: null }, PROVENANCE);
  assert.equal(analytics.ok, false);
  assert.equal(analytics.failure.code, 'insufficient-scope');
  assert.ok(analytics.failure.message.includes(YOUTUBE_ANALYTICS), 'the missing REAL scope is named verbatim');
  assert.equal(double().requestCount('analytics'), analyticsBefore, 'zero provider traffic on the scope refusal');

  const publishBefore = double().requestCount('insert');
  const publish = await module().submitPublish(accountId, { idempotencyKey: 'yt-scope-refused-key', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(publish.duplicate, false);
  assert.equal(publish.attempt.publishState, 'failed');
  assert.equal(publish.attempt.failureCode, 'insufficient-scope', 'the pre-flight refusal is RECORDED on the fence');
  assert.equal(double().requestCount('insert'), publishBefore, 'the refused publish never reached the provider');
});
