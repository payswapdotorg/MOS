/**
 * MKT-065 integration tests — the /cross-platform-distribution surfaces
 * against a REAL embedded PostgreSQL 18 stack (the content-assets/
 * experiment-analysis dual-level harness: HTTP fixtures over the spawned
 * API, then module-level round-trips + DB backstop proofs against the
 * SAME database through the in-process bootstrapApplication).
 *
 * The dispatch's five NAMED tests are here verbatim:
 *   (a) one source → multiple destination variants (fan-out);
 *   (b) per-platform capability validation (a destination lacking the
 *       publish capability is rejected before any attempt, recorded with
 *       reasons);
 *   (c) destination-specific publishing through the 056 submitPublish
 *       idempotency contract (re-submits are idempotent);
 *   (d) historical lineage append-only (events rejected on UPDATE/
 *       DELETE);
 *   (e) rights-gate fail-closed (review_required and blocked never
 *       publish — and a platform connection never implies redistribution
 *       rights for third-party content).
 *
 * The platform under test is the DISCLOSED reference in-memory double at
 * the provider boundary ONLY (the MKT-056 conformance precedent): the
 * distribution module under test (the 063 gate composition, the
 * capability validation, the dispatch policy gate, the deterministic
 * idempotency keys, the migration-055 fences) is fully REAL.
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
import {
  createReferenceSocialAdapter,
  readOnlyReferenceCapabilities,
  type ReferenceSocialAdapter,
} from './helpers/reference-social-adapter.ts';
import { createReferenceIntegrationStub } from './helpers/social-adapter-conformance.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type { CrossPlatformDistributionModuleApi } from '../../src/modules/cross-platform-distribution/public.ts';
import type { DistributionPublicationRecord } from '../../src/modules/cross-platform-distribution/public.ts';
import type { ContentAssetsModuleApi } from '../../src/modules/content-assets/public.ts';
import type { ContentRightsModuleApi } from '../../src/modules/content-rights/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';
import type { IntegrationsModuleApi } from '../../src/modules/integrations/public.ts';
import type { SocialAccountsModuleApi } from '../../src/modules/social-accounts/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'cross-platform-distribution-pipe-key';
const FULL_PLATFORM_KEY = 'reference-social';
const READONLY_PLATFORM_KEY = 'reference-readonly';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-000000000065',
  recordedVia: 'test',
  correlationId: 'integration-cross-platform-distribution-1',
  causationId: null,
} as const;

const FULL_SCOPES = ['account:read', 'content:read', 'analytics:read', 'content:write'];

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: LocalOAuthProvider | null = null;
let fullAdapter: ReferenceSocialAdapter | null = null;
let readonlyAdapter: ReferenceSocialAdapter | null = null;
let distribution: CrossPlatformDistributionModuleApi | null = null;
let socialAccounts: SocialAccountsModuleApi | null = null;
let integrationsHandle: IntegrationsModuleApi | null = null;
let credentialsHandle: CredentialsModuleApi | null = null;
let contentRights: ContentRightsModuleApi | null = null;
let contentAssets: ContentAssetsModuleApi | null = null;

function module(): CrossPlatformDistributionModuleApi {
  if (distribution === null) throw new Error('application not booted');
  return distribution;
}
function social(): SocialAccountsModuleApi {
  if (socialAccounts === null) throw new Error('application not booted');
  return socialAccounts;
}
function integrationsModule(): IntegrationsModuleApi {
  if (integrationsHandle === null) throw new Error('application not booted');
  return integrationsHandle;
}
function credentialsModule(): CredentialsModuleApi {
  if (credentialsHandle === null) throw new Error('application not booted');
  return credentialsHandle;
}
function rightsModule(): ContentRightsModuleApi {
  if (contentRights === null) throw new Error('application not booted');
  return contentRights;
}
function assetsModule(): ContentAssetsModuleApi {
  if (contentAssets === null) throw new Error('application not booted');
  return contentAssets;
}
function fullPlatform(): ReferenceSocialAdapter {
  if (fullAdapter === null) throw new Error('reference adapter not constructed');
  return fullAdapter;
}
function readonlyPlatform(): ReferenceSocialAdapter {
  if (readonlyAdapter === null) throw new Error('readonly adapter not constructed');
  return readonlyAdapter;
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
  stack = await bootStack('cross_platform_distribution');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startLocalOAuthProvider();
  fullAdapter = createReferenceSocialAdapter();
  readonlyAdapter = createReferenceSocialAdapter({
    adapterKey: READONLY_PLATFORM_KEY,
    capabilities: readOnlyReferenceCapabilities(),
  });
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({
    integrationAdapters: [
      createReferenceIntegrationStub(FULL_PLATFORM_KEY),
      createReferenceIntegrationStub(READONLY_PLATFORM_KEY),
    ],
    socialAccountFlows: [
      createLocalOAuthFlow(provider, { adapterKey: FULL_PLATFORM_KEY, secretsDir: stack.env.secretsDir }),
      createLocalOAuthFlow(provider, { adapterKey: READONLY_PLATFORM_KEY, secretsDir: stack.env.secretsDir }),
    ],
    socialPlatformAdapters: [fullAdapter, readonlyAdapter],
  });
  distribution = core.modules.crossPlatformDistribution;
  socialAccounts = core.modules.socialAccounts;
  integrationsHandle = core.modules.integrations;
  credentialsHandle = core.modules.credentials;
  contentRights = core.modules.contentRights;
  contentAssets = core.modules.contentAssets;

  // The golden-path fixtures (the NAMED (a)/(c)/(d) battery): one agency
  // with allow-all policies, one owned asset, one mission anchor and two
  // connected accounts on the FULL reference platform. (ONE before hook
  // total — node:test runs multiple top-level before hooks CONCURRENTLY,
  // and the fixtures need the booted stack; the social-adapter-contract
  // precedent.)
  alice = await makeAgencyOwner('alice@crossplatformdistribution.test');
  aliceClientId = await makeClient(alice);
  await allowAll(alice, 'network');
  await allowAll(alice, 'secrets');
  aliceMissionId = await makeMission(alice);
  ownedAssetRef = await makeSourceAsset(alice.token, aliceClientId, 'Launch teaser');
  await makeRightsRecord(aliceClientId, ownedAssetRef, 'owned');
  const connectionOne = await makePlatformConnection(alice, aliceClientId, FULL_PLATFORM_KEY);
  const connectionTwo = await makePlatformConnection(alice, aliceClientId, FULL_PLATFORM_KEY);
  fullAccountOne = await connectAccount(aliceClientId, connectionOne, { accountId: 'cpd-full-1', scopes: FULL_SCOPES });
  fullAccountTwo = await connectAccount(aliceClientId, connectionTwo, { accountId: 'cpd-full-2', scopes: FULL_SCOPES });
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

let userSeq = 0;
async function makeAgencyOwner(email: string): Promise<Principal> {
  userSeq += 1;
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', { token: admin, body: { email, displayName: email.split('@')[0] } });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, { token: admin, body: { password: 'owner-pass-123' } });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: 'owner-pass-123' } });
  assert.equal(login.status, 200);
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email} ${userSeq}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { userId, token: login.body['token'] as string, agencyId };
}

let clientSeq = 0;
async function makeClient(principal: Principal): Promise<string> {
  clientSeq += 1;
  const created = await apiCall(port(), `/api/agencies/${principal.agencyId}/clients`, {
    token: principal.token,
    body: { name: `Client ${principal.agencyId.slice(0, 8)} ${clientSeq}` },
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

let evidenceSeq = 0;
async function makeEvidence(token: string, clientId: string): Promise<string> {
  evidenceSeq += 1;
  const created = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'source_fact',
      sourceSystem: 'cross-platform-distribution-test',
      sourceRef: `fixture/cpd/${evidenceSeq}`,
      observedAt: '2026-10-01T10:30:00.000Z',
      content: { kind: 'source-provenance', seq: evidenceSeq },
      quality: 'C',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['evidenceId'] as string;
}

/**
 * Registers + materializes ONE source asset version through the REAL
 * /content-assets module and returns its opaque 'ca:' ref (the 064
 * versioned record — the explicit version anchor).
 */
async function makeSourceAsset(token: string, clientId: string, displayName: string): Promise<string> {
  const agencyId = await currentAgencyId(clientId);
  const evidenceRef = await makeEvidence(token, clientId);
  const version = await assetsModule().registerAssetVersion(
    {
      agencyId,
      clientId,
      workspaceId: null,
      assetId: null,
      mediaKind: 'video',
      displayName,
      contentType: 'video/mp4',
      sourceEvidenceRef: evidenceRef,
    },
    PROVENANCE,
  );
  await assetsModule().materializeAssetVersion(
    { versionId: version.versionId, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
    PROVENANCE,
  );
  return version.assetRef;
}

/** Resolves the owning agency of a client through the raw DB (a fixture helper). */
async function currentAgencyId(clientId: string): Promise<string> {
  const row = await pool().query<{ agency_id: string }>(
    'SELECT agency_id FROM clients WHERE client_id = $1',
    [clientId],
  );
  return row.rows[0]!.agency_id;
}

/**
 * Registers + determines ONE rights record through the REAL /content-rights
 * module (the 063 authority) and returns the rights record id. With state
 * 'undetermined' the record is registered and LEFT in its born 'unknown'
 * state (the honest review_required posture).
 */
async function makeRightsRecord(
  clientId: string,
  assetRef: string,
  state: 'owned' | 'blocked' | 'undetermined',
): Promise<string> {
  const agencyId = await currentAgencyId(clientId);
  const admin = await adminToken();
  const evidenceRef = await makeEvidence(admin, clientId);
  const record = await rightsModule().registerContentRights(
    {
      agencyId,
      clientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: evidenceRef,
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    PROVENANCE,
  );
  if (state === 'owned') {
    await rightsModule().recordRightsTransition(
      {
        rightsRecordId: record.rightsRecordId,
        eventKind: 'determination',
        toState: 'owned',
        reason: 'the client produced this asset (fixture)',
        clearance: null,
      },
      PROVENANCE,
    );
  } else if (state === 'blocked') {
    await rightsModule().recordRightsTransition(
      {
        rightsRecordId: record.rightsRecordId,
        eventKind: 'determination',
        toState: 'blocked',
        reason: 'a recorded rights claim blocks this asset (fixture)',
        clearance: null,
      },
      PROVENANCE,
    );
  }
  // 'undetermined': the record stays in its born 'unknown' state — the
  // honest review_required posture.
  return record.rightsRecordId;
}

let connectionSeq = 0;
/** Creates + connects one platform integration connection through the IN-PROCESS modules. */
async function makePlatformConnection(
  principal: Principal,
  clientId: string,
  adapterKey: string,
): Promise<string> {
  connectionSeq += 1;
  const credential = await credentialsModule().createCredentialReference({
    agencyId: principal.agencyId,
    clientId,
    kind: 'integration_api_key',
    label: `cpd_pipe_${clientId.slice(0, 8)}_${connectionSeq}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection(
    {
      clientId,
      adapterKey,
      credentialReferenceId: credential.credentialId,
      providerConfig: { apiBaseUrl: provider!.url },
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

/** The full OAuth handshake through the real module + the flow double. */
async function connectAccount(
  clientId: string,
  connectionId: string,
  fixture: { readonly accountId: string; readonly scopes: readonly string[] },
): Promise<string> {
  const start = await social().startAuthorization(
    { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...fixture.scopes], expectedAccountId: null },
    PROVENANCE,
  );
  const issued = provider!.issueAuthorization({
    accountId: fixture.accountId,
    displayIdentity: `cpd:${fixture.accountId}`,
    verifiedAt: '2026-10-01T09:30:00.000Z',
    scopes: [...fixture.scopes],
    capabilityTags: ['adapter-tag'],
    expiresInMs: 3_600_000,
  });
  const completion = await social().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    PROVENANCE,
  );
  return completion.account.socialAccountId;
}

/** Creates one mission through the REAL /growth-missions routes (the read-only anchor authority). */
async function makeMission(principal: Principal): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${principal.agencyId}/growth-missions`, {
    token: principal.token,
    body: {
      objective: 'Grow the audience for the launch campaign',
      objectiveFamily: 'audience_growth',
      marketContext: { audience: 'qualified users', geography: 'global' },
      targetMetrics: [
        { metric: 'primary_outcome', comparator: '>=', targetValue: 1000, unit: 'count', intermediate: false },
      ],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body['mission'] as Record<string, unknown>)['missionId'] as string;
}

interface PlanDestinationSpec {
  readonly socialAccountId: string;
  readonly targetFormat: string;
  readonly assetRef: string;
  readonly title?: string;
}

/** Creates one distribution plan through the REAL module (the planning surface). */
async function makePlan(input: {
  readonly agencyId: string;
  readonly clientId: string;
  readonly sourceAssetRef: string;
  readonly missionId: string | null;
  readonly destinations: readonly PlanDestinationSpec[];
}) {
  return module().createDistributionPlan(
    {
      agencyId: input.agencyId,
      clientId: input.clientId,
      workspaceId: null,
      missionId: input.missionId,
      sourceAssetRef: input.sourceAssetRef,
      transformationPlan: {
        description: 'Direct source distribution (no derived outputs in this fixture)',
        outputs: [],
      },
      destinations: input.destinations.map((destination) => ({
        socialAccountId: destination.socialAccountId,
        targetFormat: destination.targetFormat,
        assetRef: destination.assetRef,
        publishRequest: {
          contentType: 'reference-post',
          payload: { title: destination.title ?? `Launch ${destination.targetFormat}` },
          attribution: input.missionId === null ? {} : { missionId: input.missionId },
          scheduledFor: null,
        },
      })),
    },
    PROVENANCE,
  );
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
// Shared state (the golden-path fixtures — created in the single before
// hook above)
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let aliceMissionId: string;
let ownedAssetRef: string;
let fullAccountOne: string;
let fullAccountTwo: string;

// ---------------------------------------------------------------------------
// THE NAMED TEST (a): one source → multiple destination variants (fan-out)
// ---------------------------------------------------------------------------

test('NAMED (a): one source fans out to MULTIPLE destination variants — each with its own format, gate evaluation, capability validation and publication record', async () => {
  fullPlatform().setNextSubmitState('published');
  const plan = await makePlan({
    agencyId: alice.agencyId,
    clientId: aliceClientId,
    sourceAssetRef: ownedAssetRef,
    missionId: aliceMissionId,
    destinations: [
      { socialAccountId: fullAccountOne, targetFormat: 'short_video_vertical', assetRef: ownedAssetRef, title: 'Launch vertical' },
      { socialAccountId: fullAccountOne, targetFormat: 'square_image', assetRef: ownedAssetRef, title: 'Launch square' },
      { socialAccountId: fullAccountTwo, targetFormat: 'horizontal_clip', assetRef: ownedAssetRef, title: 'Launch horizontal' },
    ],
  });

  // The planning facts: born planned, the derived deterministic keys, the
  // mission anchor, the digest.
  assert.equal(plan.plan.planState, 'planned');
  assert.equal(plan.plan.missionId, aliceMissionId);
  assert.equal(plan.destinations.length, 3);
  assert.ok(plan.plan.inputDigest.length >= 16);
  for (const [index, destination] of plan.destinations.entries()) {
    assert.equal(destination.destinationStatus, 'planned');
    assert.equal(destination.position, index + 1);
    assert.ok(destination.idempotencyKey.startsWith('cpd:'));
    assert.ok(destination.idempotencyKey.endsWith(destination.destinationId));
    assert.equal(destination.platformId, FULL_PLATFORM_KEY);
    // The destination-specific request is frozen with the versioned media asset.
    assert.equal(destination.publishRequest.mediaAssets.length, 1);
    assert.equal(destination.publishRequest.mediaAssets[0]!.assetReference, ownedAssetRef);
  }
  // The distinct idempotency keys (one per destination — the at-most-once
  // identities never collide).
  assert.equal(new Set(plan.destinations.map((destination) => destination.idempotencyKey)).size, 3);
  // The plan_created lineage event.
  assert.equal(plan.events.length, 1);
  assert.equal(plan.events[0]!.eventKind, 'plan_created');

  // THE FAN-OUT DISPATCH: all three destinations publish in one command.
  const dispatched = await module().dispatchDistributionPlan({ planId: plan.plan.planId }, PROVENANCE);
  assert.equal(dispatched.plan.planState, 'dispatched');
  assert.equal(dispatched.destinations.length, 3);
  for (const destination of dispatched.destinations) {
    assert.equal(destination.destinationStatus, 'published', `destination ${destination.destinationId} published`);
  }
  // Three DISTINCT publication records with provider refs.
  assert.equal(dispatched.publications.length, 3);
  assert.equal(new Set(dispatched.publications.map((publication) => publication.publishAttemptId)).size, 3);
  for (const publication of dispatched.publications) {
    assert.equal(publication.publishState, 'published');
    assert.equal(publication.duplicate, false);
    assert.ok(publication.providerPublishId !== null);
    assert.ok(publication.providerContentId !== null);
    assert.ok(publication.publishedAt !== null);
  }
  // THE FULL LINEAGE TAIL: plan_created + dispatch_started + 3 ×
  // (gate_evaluation + capability_resolution + policy_evaluation +
  // publication_attempt) + dispatch_completed — every event with the
  // full structured payload.
  const kinds = dispatched.events.map((event) => event.eventKind);
  assert.deepEqual(kinds, [
    'plan_created',
    'dispatch_started',
    'gate_evaluation', 'capability_resolution', 'policy_evaluation', 'publication_attempt',
    'gate_evaluation', 'capability_resolution', 'policy_evaluation', 'publication_attempt',
    'gate_evaluation', 'capability_resolution', 'policy_evaluation', 'publication_attempt',
    'dispatch_completed',
  ]);
  // The gapless per-plan sequence.
  for (const [index, event] of dispatched.events.entries()) {
    assert.equal(event.eventSeq, index + 1);
  }
  // Every gate evaluation ALLOWED (the owned asset passes the 063 gate
  // per destination) with the policy decision id recorded.
  for (const event of dispatched.events.filter((entry) => entry.eventKind === 'gate_evaluation')) {
    assert.equal((event.payload as Record<string, unknown>)['outcome'], 'allow');
    assert.ok(typeof (event.payload as Record<string, unknown>)['policyDecisionId'] === 'string');
    assert.equal((event.payload as Record<string, unknown>)['destinationPlatform'], FULL_PLATFORM_KEY);
  }
  // Every capability resolution allowed through the REAL 056 matrix.
  for (const event of dispatched.events.filter((entry) => entry.eventKind === 'capability_resolution')) {
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload['allowed'], true);
    assert.equal(payload['socialPlatformAdapterRegistered'], true);
    assert.equal(payload['integrationAdapterRegistered'], true);
    assert.equal(payload['publishCapabilityDeclared'], true);
    assert.equal(payload['publishOperationDeclared'], true);
    assert.equal(payload['publishScopesSatisfied'], true);
    assert.deepEqual(payload['rejectionCodes'], []);
  }
  // Every dispatch policy evaluation allowed (the decision id rides the
  // policy ledger).
  for (const event of dispatched.events.filter((entry) => entry.eventKind === 'policy_evaluation')) {
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload['outcome'], 'allow');
    assert.ok(typeof payload['decisionId'] === 'string');
  }
  // The dispatch completion summary carries the per-destination outcomes.
  const completion = dispatched.events.at(-1)!;
  assert.equal(completion.eventKind, 'dispatch_completed');
  assert.deepEqual((completion.payload as Record<string, unknown>)['outcomes'], [
    { destinationId: dispatched.destinations[0]!.destinationId, destinationStatus: 'published' },
    { destinationId: dispatched.destinations[1]!.destinationId, destinationStatus: 'published' },
    { destinationId: dispatched.destinations[2]!.destinationId, destinationStatus: 'published' },
  ]);

  // THE MISSION AUTHORITY IS UNTOUCHED (the read-only anchor): the
  // mission is still in its born state after the dispatch.
  const mission = await apiCall(port(), `/api/growth-missions/${aliceMissionId}`, { token: alice.token });
  assert.equal(mission.status, 200);
  assert.equal((mission.body['mission'] as Record<string, unknown>)['status'], 'draft');

  // The HTTP surface round-trips the same composed detail.
  const response = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/cross-platform-distribution/plans/${plan.plan.planId}`,
    { token: alice.token },
  );
  assert.equal(response.status, 200);
  assert.equal((response.body['plan'] as Record<string, unknown>)['planId'], plan.plan.planId);
  assert.equal(response.body['vocabularyVersion'], 'cpd-vocab-v1');
  assert.equal((response.body['events'] as unknown[]).length, 15);

  // A measurement reference appends to the §5 Measurement tail.
  const measurement = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/cross-platform-distribution/plans/${plan.plan.planId}/measurements`,
    {
      token: alice.token,
      body: { measurementRef: `metrics:engagement:${plan.plan.planId}`, note: 'post-publish engagement window' },
    },
  );
  assert.equal(measurement.status, 201, JSON.stringify(measurement.body));
  assert.equal((measurement.body['event'] as Record<string, unknown>)['eventKind'], 'measurement_reference');

  // Reuse the plan for the NAMED (c) idempotency battery below.
  fanOutPlanId = plan.plan.planId;
});

let fanOutPlanId: string | null = null;

// ---------------------------------------------------------------------------
// THE NAMED TEST (b): per-platform capability validation
// ---------------------------------------------------------------------------

test('NAMED (b): a destination lacking the publish capability is REJECTED before any attempt — recorded with reasons, never attempted blind', async () => {
  // One connected account on the READ-ONLY platform (the account +
  // authorization are perfectly healthy; the PLATFORM declares no
  // publish family — capability parity is never assumed).
  const readonlyConnection = await makePlatformConnection(alice, aliceClientId, READONLY_PLATFORM_KEY);
  const readonlyAccount = await connectAccount(aliceClientId, readonlyConnection, {
    accountId: 'cpd-readonly-1',
    scopes: FULL_SCOPES,
  });

  const plan = await makePlan({
    agencyId: alice.agencyId,
    clientId: aliceClientId,
    sourceAssetRef: ownedAssetRef,
    missionId: null,
    destinations: [
      { socialAccountId: readonlyAccount, targetFormat: 'short_video_vertical', assetRef: ownedAssetRef },
    ],
  });

  const submitsBefore = fullPlatform().callCount('submitPublish');
  const readonlySubmitsBefore = readonlyPlatform().callCount('submitPublish');

  const dispatched = await module().dispatchDistributionPlan({ planId: plan.plan.planId }, PROVENANCE);
  assert.equal(dispatched.plan.planState, 'dispatched');
  // The destination is capability_rejected — never attempted.
  assert.equal(dispatched.destinations[0]!.destinationStatus, 'capability_rejected');
  assert.equal(dispatched.publications.length, 0, 'NO publication record exists for a capability-rejected destination');
  // ZERO provider traffic (both platforms untouched by this dispatch).
  assert.equal(fullPlatform().callCount('submitPublish'), submitsBefore);
  assert.equal(readonlyPlatform().callCount('submitPublish'), readonlySubmitsBefore, 'never attempted blind');
  // The capability_resolution event records the failure WITH reasons.
  const capabilityEvent = dispatched.events.find((event) => event.eventKind === 'capability_resolution');
  assert.ok(capabilityEvent !== undefined);
  const payload = capabilityEvent.payload as Record<string, unknown>;
  assert.equal(payload['allowed'], false);
  assert.equal(payload['publishCapabilityDeclared'], false, 'the read-only platform declares no publish family');
  assert.deepEqual(payload['rejectionCodes'], ['publish_capability_undeclared']);
  // The gate evaluation still ran FIRST (the §5 chain order — rights
  // before platform capability) and ALLOWED (the owned asset).
  const gateEvent = dispatched.events.find((event) => event.eventKind === 'gate_evaluation');
  assert.ok(gateEvent !== undefined);
  assert.equal((gateEvent.payload as Record<string, unknown>)['outcome'], 'allow');
  // No publication_attempt event exists for the destination.
  assert.equal(dispatched.events.filter((event) => event.eventKind === 'publication_attempt').length, 0);
});

// ---------------------------------------------------------------------------
// THE NAMED TEST (c): destination-specific publishing through the 056
// submitPublish idempotency contract (re-submits are idempotent)
// ---------------------------------------------------------------------------

test('NAMED (c): re-dispatch converges on the 056 idempotency fence — duplicate replays with ZERO provider traffic', async () => {
  assert.ok(fanOutPlanId !== null, 'the NAMED (a) fan-out plan exists');
  const before = await module().getDistributionPlanDetail(fanOutPlanId);
  assert.ok(before !== null);
  const submitsBefore = fullPlatform().callCount('submitPublish');
  const attemptsBefore = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM social_publish_attempts',
  );

  // THE RE-DISPATCH: the same command, the same deterministic keys.
  const reDispatched = await module().dispatchDistributionPlan({ planId: fanOutPlanId }, PROVENANCE);
  assert.equal(reDispatched.plan.planState, 'dispatched');
  // All three destinations keep their recorded outcomes.
  for (const destination of reDispatched.destinations) {
    assert.equal(destination.destinationStatus, 'published');
  }
  // The publications converge: the SAME 056 attempts (the immutable
  // submit-time link rows keep the FIRST submit's facts — the duplicate
  // flag of the REPLAY rides the appended publication_attempt events,
  // asserted below).
  assert.equal(reDispatched.publications.length, 3);
  for (const publication of reDispatched.publications) {
    const original: DistributionPublicationRecord | undefined = before!.publications.find(
      (entry: DistributionPublicationRecord) => entry.destinationId === publication.destinationId,
    );
    assert.ok(original !== undefined);
    assert.equal(publication.publishAttemptId, original.publishAttemptId, 'the same 056 ledger attempt');
    assert.equal(publication.publicationId, original.publicationId, 'the same immutable publication link row');
  }
  // ZERO new provider calls and ZERO new ledger rows.
  assert.equal(fullPlatform().callCount('submitPublish'), submitsBefore, 'the fence answered every replay — zero provider traffic');
  const attemptsAfter = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM social_publish_attempts',
  );
  assert.equal(attemptsAfter.rows[0]!.count, attemptsBefore.rows[0]!.count, 'no new 056 ledger rows');
  // The lineage appends the honest duplicate publication_attempt events
  // (the replay trail) — and nothing else for attempted destinations.
  const appendedKinds = reDispatched.events.slice(before!.events.length).map((event) => event.eventKind);
  assert.deepEqual(appendedKinds, [
    'dispatch_started',
    'publication_attempt',
    'publication_attempt',
    'publication_attempt',
    'dispatch_completed',
  ]);
  for (const event of reDispatched.events.filter(
    (entry) => entry.eventKind === 'publication_attempt' && entry.eventSeq > before!.events.length,
  )) {
    assert.equal((event.payload as Record<string, unknown>)['duplicate'], true);
  }
  // The recorded history is NEVER rewritten: the first 15 + the
  // measurement events are byte-identical.
  for (const [index, event] of before!.events.entries()) {
    assert.deepEqual(reDispatched.events[index], event);
  }
});

// ---------------------------------------------------------------------------
// THE NAMED TEST (d): historical lineage append-only
// ---------------------------------------------------------------------------

test('NAMED (d): the historical lineage is append-only — UPDATE and DELETE are rejected by the database itself', async () => {
  assert.ok(fanOutPlanId !== null);
  const detail = await module().getDistributionPlanDetail(fanOutPlanId);
  assert.ok(detail !== null);
  const firstEvent = detail.events[0]!;
  const firstPublication = detail.publications[0]!;
  const firstDestination = detail.destinations[0]!;

  // The event tail rejects UPDATE and DELETE.
  await assertDbRejects(
    'UPDATE distribution_events SET payload = $1::jsonb WHERE event_id = $2',
    [JSON.stringify({ forged: true }), firstEvent.eventId],
    'is append-only',
  );
  await assertDbRejects(
    'DELETE FROM distribution_events WHERE event_id = $1',
    [firstEvent.eventId],
    'is append-only',
  );
  // The publication link rows reject UPDATE and DELETE.
  await assertDbRejects(
    'UPDATE distribution_publications SET publish_state = $1 WHERE publication_id = $2',
    ['failed', firstPublication.publicationId],
    'is append-only',
  );
  await assertDbRejects(
    'DELETE FROM distribution_publications WHERE publication_id = $1',
    [firstPublication.publicationId],
    'is append-only',
  );
  // The plan and destination records reject DELETE and identity rewrites.
  await assertDbRejects(
    'DELETE FROM distribution_plans WHERE plan_id = $1',
    [fanOutPlanId],
    'cannot be deleted',
  );
  await assertDbRejects(
    'DELETE FROM distribution_destinations WHERE destination_id = $1',
    [firstDestination.destinationId],
    'cannot be deleted',
  );
  await assertDbRejects(
    'UPDATE distribution_destinations SET target_format = $1 WHERE destination_id = $2',
    ['forged-format', firstDestination.destinationId],
    'identity and request columns are immutable',
  );
  await assertDbRejects(
    'UPDATE distribution_plans SET source_asset_ref = $1 WHERE plan_id = $2',
    ['ca:00000000-0000-0000-0000-000000000000', fanOutPlanId],
    'identity and provenance columns are immutable',
  );
  // The destination outcome pointer NEVER returns to the born state.
  await assertDbRejects(
    'UPDATE distribution_destinations SET destination_status = $1, version = version + 1 WHERE destination_id = $2',
    ['planned', firstDestination.destinationId],
    'never re-entered',
  );
  // The gapless sequence fence: a forged out-of-order event is rejected.
  await assertDbRejects(
    `INSERT INTO distribution_events
       (event_id, plan_id, destination_id, client_id, event_seq, event_kind, payload,
        recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
     VALUES ($1, $2, NULL, $3, 1, 'measurement_reference', '{}'::jsonb, 'forger', 'sql', 'forged', NULL, now())`,
    ['00000000-0000-0000-0000-0000000000dd', fanOutPlanId, detail.plan.clientId],
    'duplicate key value violates unique constraint',
  );
});

// ---------------------------------------------------------------------------
// THE NAMED TEST (e): rights-gate fail-closed
// ---------------------------------------------------------------------------

test('NAMED (e): review_required and blocked NEVER publish — and a platform connection never implies redistribution rights for third-party content', async () => {
  // --- The REVIEW-REQUIRED case: the asset's rights record is registered
  //     but LEFT in its born 'unknown' state (an undetermined third-party
  //     asset) — the gate returns review_required and the destination
  //     NEVER publishes, even though the account is connected, fully
  //     scoped and platform-capable.
  const undeterminedAsset = await makeSourceAsset(alice.token, aliceClientId, 'Third-party clip (unclear rights)');
  await makeRightsRecord(aliceClientId, undeterminedAsset, 'undetermined');
  const reviewPlan = await makePlan({
    agencyId: alice.agencyId,
    clientId: aliceClientId,
    sourceAssetRef: undeterminedAsset,
    missionId: null,
    destinations: [
      { socialAccountId: fullAccountOne, targetFormat: 'short_video_vertical', assetRef: undeterminedAsset },
    ],
  });
  let submitsBefore = fullPlatform().callCount('submitPublish');
  let dispatched = await module().dispatchDistributionPlan({ planId: reviewPlan.plan.planId }, PROVENANCE);
  assert.equal(dispatched.destinations[0]!.destinationStatus, 'rights_review_required');
  assert.equal(dispatched.publications.length, 0, 'review_required NEVER publishes');
  assert.equal(fullPlatform().callCount('submitPublish'), submitsBefore, 'zero provider traffic');
  const reviewGate = dispatched.events.find((event) => event.eventKind === 'gate_evaluation')!;
  assert.equal((reviewGate.payload as Record<string, unknown>)['outcome'], 'review_required');
  assert.ok(
    ((reviewGate.payload as Record<string, unknown>)['reasons'] as { code: string }[]).some(
      (reason) => reason.code === 'rights_state_unknown',
    ),
    'the recorded reasons carry the rights-state code',
  );

  // --- The BLOCKED case: a recorded blocked rights state.
  const blockedAsset = await makeSourceAsset(alice.token, aliceClientId, 'Blocked asset');
  await makeRightsRecord(aliceClientId, blockedAsset, 'blocked');
  const blockedPlan = await makePlan({
    agencyId: alice.agencyId,
    clientId: aliceClientId,
    sourceAssetRef: blockedAsset,
    missionId: null,
    destinations: [
      { socialAccountId: fullAccountOne, targetFormat: 'square_image', assetRef: blockedAsset },
    ],
  });
  submitsBefore = fullPlatform().callCount('submitPublish');
  dispatched = await module().dispatchDistributionPlan({ planId: blockedPlan.plan.planId }, PROVENANCE);
  assert.equal(dispatched.destinations[0]!.destinationStatus, 'rights_blocked');
  assert.equal(dispatched.publications.length, 0, 'blocked NEVER publishes');
  assert.equal(fullPlatform().callCount('submitPublish'), submitsBefore, 'zero provider traffic');
  const blockedGate = dispatched.events.find((event) => event.eventKind === 'gate_evaluation')!;
  assert.equal((blockedGate.payload as Record<string, unknown>)['outcome'], 'blocked');

  // --- THE THIRD-PARTY CONTENT case (§5 verbatim): an asset with NO
  //     rights record AT ALL — the account is CONNECTED and the platform
  //     is fully publish-capable, but a platform connection NEVER implies
  //     rights to redistribute content that originated elsewhere: an
  //     absent evaluation is BLOCKED.
  const thirdPartyAsset = await makeSourceAsset(alice.token, aliceClientId, 'Someone else content');
  const thirdPartyPlan = await makePlan({
    agencyId: alice.agencyId,
    clientId: aliceClientId,
    sourceAssetRef: thirdPartyAsset,
    missionId: null,
    destinations: [
      { socialAccountId: fullAccountTwo, targetFormat: 'horizontal_clip', assetRef: thirdPartyAsset },
    ],
  });
  submitsBefore = fullPlatform().callCount('submitPublish');
  dispatched = await module().dispatchDistributionPlan({ planId: thirdPartyPlan.plan.planId }, PROVENANCE);
  assert.equal(dispatched.destinations[0]!.destinationStatus, 'rights_blocked');
  assert.equal(dispatched.publications.length, 0, 'no rights record → never publishes');
  assert.equal(fullPlatform().callCount('submitPublish'), submitsBefore, 'the connected account was never called');
  const absentGate = dispatched.events.find((event) => event.eventKind === 'gate_evaluation')!;
  assert.equal((absentGate.payload as Record<string, unknown>)['outcome'], 'blocked');
  assert.ok(
    ((absentGate.payload as Record<string, unknown>)['reasons'] as { code: string }[]).some(
      (reason) => reason.code === 'no_rights_record',
    ),
    'the absent evaluation is recorded as no_rights_record',
  );

  // --- THE HUMAN-CLEARANCE RECOVERY: after the recorded human clearance
  //     (the ONLY review → cleared path through the 063 authority), a
  //     re-dispatch re-evaluates honestly and publishes — the
  //     fail-closed-to-cleared lifecycle with full lineage.
  const undeterminedRecord = await rightsModule().getRightsRecordForAsset(aliceClientId, undeterminedAsset);
  assert.ok(undeterminedRecord !== null);
  await rightsModule().recordRightsTransition(
    {
      rightsRecordId: undeterminedRecord.rightsRecordId,
      eventKind: 'determination',
      toState: 'review',
      reason: 'operator routed the unclear asset to legal review (fixture)',
      clearance: null,
    },
    PROVENANCE,
  );
  await rightsModule().recordRightsTransition(
    {
      rightsRecordId: undeterminedRecord.rightsRecordId,
      eventKind: 'human_clearance',
      toState: 'cleared',
      reason: 'legal review completed',
      clearance: { rationale: 'The licence permits cross-platform redistribution (fixture).', evidenceRef: null },
    },
    PROVENANCE,
  );
  fullPlatform().setNextSubmitState('published');
  const recovered = await module().dispatchDistributionPlan({ planId: reviewPlan.plan.planId }, PROVENANCE);
  assert.equal(recovered.destinations[0]!.destinationStatus, 'published', 'the cleared asset publishes on re-dispatch');
  assert.equal(recovered.publications.length, 1);
  // The lineage keeps BOTH the review_required verdict and the publish
  // (the history is append-only; the re-evaluation is a new event).
  const gateOutcomes = recovered.events
    .filter((event) => event.eventKind === 'gate_evaluation')
    .map((event) => (event.payload as Record<string, unknown>)['outcome']);
  assert.deepEqual(gateOutcomes, ['review_required', 'allow']);
});

// ---------------------------------------------------------------------------
// The dispatch policy gate (fail-closed through /policies)
// ---------------------------------------------------------------------------

test('the dispatch policy gate fails closed — a deny on content.distribution.dispatch blocks the destination with the decision recorded', async () => {
  // An agency whose network policy allows the rights destination gate +
  // the adapter operations but DENIES the distribution dispatch.
  const carol = await makeAgencyOwner('carol-policy@crossplatformdistribution.test');
  const carolClientId = await makeClient(carol);
  await allowAll(carol, 'secrets');
  const declared = await apiCall(port(), `/api/agencies/${carol.agencyId}/policies`, {
    token: carol.token,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: [
            'integration.connect',
            'social-account.complete',
            'content.rights.publication.reference-social',
            'social-adapter.publish',
            'social-adapter.credential',
          ],
          reason: 'the connection, rights gate and adapter operations stay allowed',
        },
        { effect: 'deny', operations: ['content.distribution.dispatch'], reason: 'distribution paused by operator policy' },
      ],
      description: 'Selective network policy: dispatch denied, everything else allowed',
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));

  const assetRef = await makeSourceAsset(carol.token, carolClientId, 'Carol asset');
  await makeRightsRecord(carolClientId, assetRef, 'owned');
  const connection = await makePlatformConnection(carol, carolClientId, FULL_PLATFORM_KEY);
  const account = await connectAccount(carolClientId, connection, { accountId: 'cpd-policy-1', scopes: FULL_SCOPES });

  const plan = await makePlan({
    agencyId: carol.agencyId,
    clientId: carolClientId,
    sourceAssetRef: assetRef,
    missionId: null,
    destinations: [
      { socialAccountId: account, targetFormat: 'short_video_vertical', assetRef },
    ],
  });
  const submitsBefore = fullPlatform().callCount('submitPublish');
  const dispatched = await module().dispatchDistributionPlan({ planId: plan.plan.planId }, PROVENANCE);
  // The rights gate ALLOWED (owned asset + the destination policy rule),
  // the capability validation ALLOWED, the DISPATCH POLICY GATE denied.
  assert.equal(dispatched.destinations[0]!.destinationStatus, 'policy_blocked');
  assert.equal(dispatched.publications.length, 0);
  assert.equal(fullPlatform().callCount('submitPublish'), submitsBefore, 'zero provider traffic behind a policy block');
  const gateEvent = dispatched.events.find((event) => event.eventKind === 'gate_evaluation')!;
  assert.equal((gateEvent.payload as Record<string, unknown>)['outcome'], 'allow');
  const capabilityEvent = dispatched.events.find((event) => event.eventKind === 'capability_resolution')!;
  assert.equal((capabilityEvent.payload as Record<string, unknown>)['allowed'], true);
  const policyEvent = dispatched.events.find((event) => event.eventKind === 'policy_evaluation')!;
  const policyPayload = policyEvent.payload as Record<string, unknown>;
  assert.equal(policyPayload['outcome'], 'deny');
  assert.ok(typeof policyPayload['decisionId'] === 'string', 'the policy decision id rides the policy ledger');
});

// ---------------------------------------------------------------------------
// Cross-client isolation (the hard-boundary posture)
// ---------------------------------------------------------------------------

test('cross-client isolation: foreign plans, accounts and assets are the uniform 404; no cross-tenant oracle', async () => {
  const bob = await makeAgencyOwner('bob-isolation@crossplatformdistribution.test');
  const bobClientId = await makeClient(bob);
  const bobAssetRef = await makeSourceAsset(bob.token, bobClientId, 'Bob asset');

  // Bob's plan referencing ALICE's social account over Bob's OWN asset →
  // uniform NotFoundError (the account resolves through canonical
  // ownership — a foreign binding is never a traversal oracle).
  await assert.rejects(
    () =>
      makePlan({
        agencyId: bob.agencyId,
        clientId: bobClientId,
        sourceAssetRef: bobAssetRef,
        missionId: null,
        destinations: [
          { socialAccountId: fullAccountOne, targetFormat: 'short_video_vertical', assetRef: bobAssetRef },
        ],
      }),
    (error: unknown) => error instanceof Error && error.name === 'NotFoundError',
    'a foreign account reference is the uniform 404',
  );

  // Bob's plan referencing ALICE's asset (the source ref) → uniform
  // NotFoundError (the source resolves canonically BEFORE any
  // destination work — a foreign asset is never a traversal oracle).
  await assert.rejects(
    () =>
      module().createDistributionPlan(
        {
          agencyId: bob.agencyId,
          clientId: bobClientId,
          workspaceId: null,
          missionId: null,
          sourceAssetRef: ownedAssetRef,
          transformationPlan: { description: 'direct', outputs: [] },
          destinations: [
            {
              socialAccountId: '00000000-0000-0000-0000-0000000000aa',
              targetFormat: 'short_video_vertical',
              assetRef: ownedAssetRef,
              publishRequest: { contentType: 'reference-post', payload: {}, attribution: {}, scheduledFor: null },
            },
          ],
        },
        PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.name === 'NotFoundError',
    'a foreign asset reference is the uniform 404',
  );

  // Alice's plan is INVISIBLE to Bob over HTTP (uniform 404 — the same
  // status as an unknown id).
  assert.ok(fanOutPlanId !== null);
  const foreignRead = await apiCall(
    port(),
    `/api/clients/${bobClientId}/cross-platform-distribution/plans/${fanOutPlanId}`,
    { token: bob.token },
  );
  assert.equal(foreignRead.status, 404);
  const foreignDispatch = await apiCall(
    port(),
    `/api/clients/${bobClientId}/cross-platform-distribution/plans/${fanOutPlanId}/dispatch`,
    { token: bob.token, body: {} },
  );
  assert.equal(foreignDispatch.status, 404);

  // The ownership resolution is null for foreign/unknown ids (the
  // route-layer input).
  assert.equal(await module().resolveDistributionPlanOwnership('not-a-uuid'), null);
  const unknownId = await pool().query<{ plan_id: string }>('SELECT plan_id FROM distribution_plans LIMIT 1');
  assert.equal(await module().resolveDistributionPlanOwnership(unknownId.rows[0]!.plan_id) === null, false);
});

// ---------------------------------------------------------------------------
// The planning-input discipline (fail-closed by rejection)
// ---------------------------------------------------------------------------

test('the planning guards: a floating asset ref and an off-chain destination ref are rejected BEFORE any write', async () => {
  // A destination referencing an asset that is neither the source nor a
  // declared transformation output → the §5 chain closure (409).
  const otherAsset = await makeSourceAsset(alice.token, aliceClientId, 'Off-chain asset');
  await assert.rejects(
    () =>
      module().createDistributionPlan(
        {
          agencyId: alice.agencyId,
          clientId: aliceClientId,
          workspaceId: null,
          missionId: null,
          sourceAssetRef: ownedAssetRef,
          transformationPlan: { description: 'direct', outputs: [] },
          destinations: [
            {
              socialAccountId: fullAccountOne,
              targetFormat: 'short_video_vertical',
              assetRef: otherAsset,
              publishRequest: { contentType: 'reference-post', payload: {}, attribution: {}, scheduledFor: null },
            },
          ],
        },
        PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.name === 'ConflictError',
    'an off-chain destination ref is rejected (the §5 chain closure)',
  );

  // An unknown source ref → uniform NotFoundError (never a floating pointer).
  await assert.rejects(
    () =>
      module().createDistributionPlan(
        {
          agencyId: alice.agencyId,
          clientId: aliceClientId,
          workspaceId: null,
          missionId: null,
          sourceAssetRef: 'ca:00000000-0000-0000-0000-0000000000ff',
          transformationPlan: { description: 'direct', outputs: [] },
          destinations: [
            {
              socialAccountId: fullAccountOne,
              targetFormat: 'short_video_vertical',
              assetRef: 'ca:00000000-0000-0000-0000-0000000000ff',
              publishRequest: { contentType: 'reference-post', payload: {}, attribution: {}, scheduledFor: null },
            },
          ],
        },
        PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.name === 'NotFoundError',
    'an unknown source ref is the uniform 404',
  );

  // A planning duplicate (the same account + format) → the variant fence.
  await assert.rejects(
    () =>
      module().createDistributionPlan(
        {
          agencyId: alice.agencyId,
          clientId: aliceClientId,
          workspaceId: null,
          missionId: null,
          sourceAssetRef: ownedAssetRef,
          transformationPlan: { description: 'direct', outputs: [] },
          destinations: [
            {
              socialAccountId: fullAccountOne,
              targetFormat: 'short_video_vertical',
              assetRef: ownedAssetRef,
              publishRequest: { contentType: 'reference-post', payload: {}, attribution: {}, scheduledFor: null },
            },
            {
              socialAccountId: fullAccountOne,
              targetFormat: 'short_video_vertical',
              assetRef: ownedAssetRef,
              publishRequest: { contentType: 'reference-post', payload: {}, attribution: {}, scheduledFor: null },
            },
          ],
        },
        PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.name === 'InvalidRequestError',
    'the planning-duplicate fence rejects the second identical variant',
  );

  // The HTTP strict-validation gate: an authority field never reaches the
  // module (400, zero rows).
  const rowsBefore = await pool().query<{ count: string }>('SELECT count(*)::text AS count FROM distribution_plans');
  const rejected = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/cross-platform-distribution/plans`,
    {
      token: alice.token,
      body: {
        sourceAssetRef: ownedAssetRef,
        transformationDescription: 'direct',
        transformationOutputs: [],
        destinationVariants: [
          {
            socialAccountId: fullAccountOne,
            targetFormat: 'short_video_vertical',
            assetRef: ownedAssetRef,
            publishRequest: { contentType: 'reference-post', payload: {}, attribution: {} },
            planId: '00000000-0000-0000-0000-000000000000', // a forged authority field
          },
        ],
      },
    },
  );
  assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
  const rowsAfter = await pool().query<{ count: string }>('SELECT count(*)::text AS count FROM distribution_plans');
  assert.equal(rowsAfter.rows[0]!.count, rowsBefore.rows[0]!.count, 'ZERO rows from the rejected request');
});
