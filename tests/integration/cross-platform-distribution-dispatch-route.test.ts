/**
 * MKT-066 — the disclosed MKT-065 HTTP dispatch-route defect fix: the
 * ROUTE-LEVEL dispatch integration tests (dispatch through the HTTP
 * route, NOT the module API — the gap that let the defect survive).
 *
 * The defect (disclosed at the UX-004 station verification, reproduced
 * from main): POST /api/clients/:clientId/cross-platform-distribution/
 * plans/:planId/dispatch returned 422 "audit event rejected by the
 * append guard" AFTER the module had durably dispatched the plan — the
 * route's audit emit passed the `outcomes` ARRAY in the audit details
 * while the append guard (audit-store's assertValidAuditEvent) requires
 * scalar detail values. The plan was left dispatched despite the 422,
 * and the repo's integration tests dispatched through the module API, so
 * the HTTP-route defect was never exercised.
 *
 * The fix: serialize the outcomes array into the audit details
 * deterministically as the fan-out-ordered comma-joined status string
 * (the notification-delivery receiptOutcomes / field-agents
 * specializations join(',') precedent — position corresponds to fan-out
 * order, lossless over the ordered outcome list).
 *
 * HARNESS DISCLOSURE: the battery runs against the REAL router + HTTP
 * pipeline (buildApiRouter + createHttpServer — the same route code the
 * spawned entrypoint serves) booted IN-PROCESS with the disclosed
 * composition-seam adapters, because the spawned production composition
 * registers NO platform in BOTH the integration-adapter registry and the
 * social-adapter registry on this base (the integration registry holds
 * meta-ads/google-ads/generic-analytics/crm/commerce-cms/creator-platform;
 * the social registry holds youtube/instagram/facebook-pages — disjoint
 * sets), so a full PUBLISHING dispatch through the spawned process is
 * not yet expressible on main (an honest environment limit, disclosed in
 * the runbook). Every route call below is a real HTTP request through
 * the real pipeline (auth → owner → authorize → validate → execute →
 * emit → respond) against the real embedded-PostgreSQL state.
 *
 * The dispatch's three NAMED route-level paths are here verbatim:
 *   1. THE HAPPY PATH — dispatch through the HTTP route: audit emitted
 *      with the SCALAR outcomes detail, truthful 200, the plan durably
 *      dispatched with real publications;
 *   2. THE AUDIT-APPEND-FAILURE PATH — the audit append is forced to
 *      fail the way the house tests force such guards (a temporary DB
 *      rejection trigger on the audit trail): the response can NEVER be
 *      a false success while the durable publication state stays
 *      truthful and readable (the response and the durable state cannot
 *      disagree about dispatch success);
 *   3. THE REPLAY/IDEMPOTENCY PATH — re-dispatching through the route
 *      converges deterministically (replayed outcomes from the 056
 *      fence, ZERO provider traffic, a fresh audit row for the new plan
 *      version).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type pg from 'pg';
import {
  apiCall,
  bootStack,
  shutdownStack,
  type IntegrationStack,
} from './helpers/harness.ts';
import {
  createLocalOAuthFlow,
  startLocalOAuthProvider,
  type LocalOAuthProvider,
} from './helpers/oauth-provider.ts';
import {
  createReferenceSocialAdapter,
  type ReferenceSocialAdapter,
} from './helpers/reference-social-adapter.ts';
import { createReferenceIntegrationStub } from './helpers/social-adapter-conformance.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import { buildApiRouter } from '../../src/api/routes.ts';
import { createHttpServer, type HttpServerHandle } from '../../src/platform/http/server.ts';
import type { ContentAssetsModuleApi } from '../../src/modules/content-assets/public.ts';
import type { ContentRightsModuleApi } from '../../src/modules/content-rights/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';
import type { IntegrationsModuleApi } from '../../src/modules/integrations/public.ts';
import type { SocialAccountsModuleApi } from '../../src/modules/social-accounts/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'dispatch-route-pipe-key';
const FULL_PLATFORM_KEY = 'reference-social';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-000000000066',
  recordedVia: 'test',
  correlationId: 'integration-dispatch-route-1',
  causationId: null,
} as const;

const FULL_SCOPES = ['account:read', 'content:read', 'analytics:read', 'content:write'];

let stack: IntegrationStack | null = null;
let serverHandle: HttpServerHandle | null = null;
let provider: LocalOAuthProvider | null = null;
let fullAdapter: ReferenceSocialAdapter | null = null;
let socialAccounts: SocialAccountsModuleApi | null = null;
let integrationsHandle: IntegrationsModuleApi | null = null;
let credentialsHandle: CredentialsModuleApi | null = null;
let contentRights: ContentRightsModuleApi | null = null;
let contentAssets: ContentAssetsModuleApi | null = null;

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
function port(): number {
  if (serverHandle === null) throw new Error('route server not booted');
  return serverHandle.port;
}
function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

// ---------------------------------------------------------------------------
// The shared fixtures (the cross-platform-distribution harness pattern)
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
      sourceSystem: 'dispatch-route-test',
      sourceRef: `fixture/dr/${evidenceSeq}`,
      observedAt: '2026-10-01T10:30:00.000Z',
      content: { kind: 'source-provenance', seq: evidenceSeq },
      quality: 'C',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['evidenceId'] as string;
}

async function currentAgencyId(clientId: string): Promise<string> {
  const row = await pool().query<{ agency_id: string }>(
    'SELECT agency_id FROM clients WHERE client_id = $1',
    [clientId],
  );
  return row.rows[0]!.agency_id;
}

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

let connectionSeq = 0;
async function makePlatformConnection(
  principal: Principal,
  clientId: string,
): Promise<string> {
  connectionSeq += 1;
  const credential = await credentialsModule().createCredentialReference({
    agencyId: principal.agencyId,
    clientId,
    kind: 'integration_api_key',
    label: `dr_pipe_${clientId.slice(0, 8)}_${connectionSeq}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection(
    {
      clientId,
      adapterKey: FULL_PLATFORM_KEY,
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

async function connectAccount(
  clientId: string,
  connectionId: string,
  accountId: string,
): Promise<string> {
  const start = await social().startAuthorization(
    { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...FULL_SCOPES], expectedAccountId: null },
    PROVENANCE,
  );
  const issued = provider!.issueAuthorization({
    accountId,
    displayIdentity: `dr:${accountId}`,
    verifiedAt: '2026-10-01T09:30:00.000Z',
    scopes: [...FULL_SCOPES],
    capabilityTags: ['adapter-tag'],
    expiresInMs: 3_600_000,
  });
  const completed = await social().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    PROVENANCE,
  );
  return completed.account.socialAccountId;
}

/** Creates one distribution plan through the REAL HTTP planning route. */
async function makePlan(
  token: string,
  clientId: string,
  assetRef: string,
  socialAccountIds: readonly string[],
): Promise<string> {
  const created = await apiCall(
    port(),
    `/api/clients/${clientId}/cross-platform-distribution/plans`,
    {
      token,
      body: {
        sourceAssetRef: assetRef,
        transformationDescription: 'Direct source distribution (the route-fix fixture)',
        transformationOutputs: [],
        destinationVariants: socialAccountIds.map((socialAccountId, index) => ({
          socialAccountId,
          targetFormat: `route-fix-format-${index + 1}`,
          assetRef,
          publishRequest: {
            contentType: 'reference-post',
            payload: { title: `Dispatch route fixture ${index + 1}` },
            attribution: {},
          },
        })),
      },
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body['plan'] as Record<string, unknown>)['planId'] as string;
}

async function dispatchRoute(token: string, clientId: string, planId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await apiCall(
    port(),
    `/api/clients/${clientId}/cross-platform-distribution/plans/${planId}/dispatch`,
    { token, body: {} },
  );
  return { status: response.status, body: response.body as Record<string, unknown> };
}

async function planRow(planId: string): Promise<{ plan_state: string; version: number }> {
  const result = await pool().query<{ plan_state: string; version: number }>(
    'SELECT plan_state, version FROM distribution_plans WHERE plan_id = $1',
    [planId],
  );
  return result.rows[0]!;
}

async function auditRows(planId: string): Promise<readonly { details: Record<string, unknown>; idempotency_key: string | null }[]> {
  const result = await pool().query<{ details: Record<string, unknown>; idempotency_key: string | null }>(
    `SELECT details, idempotency_key FROM audit_events
     WHERE action = 'distribution.dispatched' AND target_id = $1
     ORDER BY occurred_at, event_id`,
    [planId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Boot + fixtures
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let assetRef: string;
let accountOne: string;
let accountTwo: string;

before(async () => {
  stack = await bootStack('dispatch_route');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  provider = await startLocalOAuthProvider();
  fullAdapter = createReferenceSocialAdapter();
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  process.env.MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL = BOOTSTRAP_EMAIL;
  process.env.MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD = BOOTSTRAP_PASSWORD;
  const core = await bootstrapApplication({
    integrationAdapters: [createReferenceIntegrationStub(FULL_PLATFORM_KEY)],
    socialAccountFlows: [
      createLocalOAuthFlow(provider, { adapterKey: FULL_PLATFORM_KEY, secretsDir: stack.env.secretsDir }),
    ],
    socialPlatformAdapters: [fullAdapter],
  });
  socialAccounts = core.modules.socialAccounts;
  integrationsHandle = core.modules.integrations;
  credentialsHandle = core.modules.credentials;
  contentRights = core.modules.contentRights;
  contentAssets = core.modules.contentAssets;

  // THE REAL ROUTE PIPELINE: the same router + HTTP server the spawned
  // entrypoint serves, booted in-process with the disclosed seam
  // adapters (see the harness disclosure in the header).
  const router = buildApiRouter(core.services, core.modules);
  const routeServer = createHttpServer({
    router,
    logger: core.services.observability.loggerFactory.forModule('dispatch-route.test'),
    clock: core.services.clock,
    ids: core.services.ids,
    maxBodyBytes: core.services.config.httpMaxBodyBytes,
  });
  serverHandle = await routeServer.listen('127.0.0.1', 0);

  alice = await makeAgencyOwner('alice@dispatchroute.test');
  aliceClientId = await makeClient(alice);
  await allowAll(alice, 'network');
  await allowAll(alice, 'secrets');
  assetRef = await makeSourceAsset(alice.token, aliceClientId, 'Dispatch route fixture asset');
  const agencyId = await currentAgencyId(aliceClientId);
  const rightsRecord = await rightsModule().registerContentRights(
    {
      agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      contentAssetRef: assetRef,
      assetKind: 'source',
      sourceEvidenceRef: await makeEvidence(alice.token, aliceClientId),
      licenceLabel: null,
      licenceEvidenceRef: null,
      validUntil: null,
    },
    PROVENANCE,
  );
  await rightsModule().recordRightsTransition(
    {
      rightsRecordId: rightsRecord.rightsRecordId,
      eventKind: 'determination',
      toState: 'owned',
      reason: 'the operator declared ownership of the source asset (fixture)',
      clearance: null,
    },
    PROVENANCE,
  );
  const connectionOne = await makePlatformConnection(alice, aliceClientId);
  const connectionTwo = await makePlatformConnection(alice, aliceClientId);
  accountOne = await connectAccount(aliceClientId, connectionOne, 'dr-account-1');
  accountTwo = await connectAccount(aliceClientId, connectionTwo, 'dr-account-2');
});

after(async () => {
  await serverHandle?.close();
  await provider?.close();
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// 1. THE HAPPY PATH — dispatch through the HTTP route (the defect surface)
// ---------------------------------------------------------------------------

test('MKT-065 route fix (happy): the HTTP dispatch succeeds truthfully — audit emitted with the SCALAR outcomes detail, 200, plan dispatched', async () => {
  const planId = await makePlan(alice.token, aliceClientId, assetRef, [accountOne, accountTwo]);

  // The reference platform's fresh submits report 'published' (a
  // terminal provider outcome for the audit-detail proof).
  fullAdapter!.setNextSubmitState('published');

  // The reference adapter's submit count BEFORE the dispatch (the
  // replay/idempotency baseline).
  const submitsBefore = fullAdapter!.callCount('submitPublish');

  const dispatch = await dispatchRoute(alice.token, aliceClientId, planId);
  assert.equal(dispatch.status, 200, JSON.stringify(dispatch.body));

  // The response is TRUTHFUL: the plan + destinations + publications the
  // module durably produced.
  const plan = dispatch.body['plan'] as Record<string, unknown>;
  assert.equal(plan['planState'], 'dispatched');
  const destinations = dispatch.body['destinations'] as Record<string, unknown>[];
  assert.equal(destinations.length, 2);
  const publications = dispatch.body['publications'] as Record<string, unknown>[];
  assert.equal(publications.length, 2);
  for (const destination of destinations) {
    assert.equal(destination['destinationStatus'], 'published');
  }

  // The durable state agrees with the response.
  const row = await planRow(planId);
  assert.equal(row.plan_state, 'dispatched');

  // THE AUDIT ROW EXISTS and carries the outcomes as a SCALAR detail —
  // the exact defect surface: before the fix the array-typed detail was
  // rejected by the append guard (422) AFTER the durable dispatch.
  const audits = await auditRows(planId);
  assert.equal(audits.length, 1, 'exactly one audit event for the dispatch');
  const outcomes = audits[0]!.details['outcomes'];
  assert.equal(typeof outcomes, 'string', 'the outcomes detail is a serialized scalar');
  assert.equal(outcomes, 'published,published');
  assert.equal(audits[0]!.details['planState'], 'dispatched');
  // Every detail value is a JSON scalar (the append-guard discipline).
  for (const value of Object.values(audits[0]!.details)) {
    assert.ok(typeof value !== 'object' || value === null, 'audit details are scalars');
  }

  // Two provider submits happened (one per destination).
  assert.equal(fullAdapter!.callCount('submitPublish') - submitsBefore, 2);
});

// ---------------------------------------------------------------------------
// 2. THE AUDIT-APPEND-FAILURE PATH — no false success, truthful state
// ---------------------------------------------------------------------------

test('MKT-065 route fix (audit-failure truthfulness): a forced audit append failure can NEVER produce a false success — the durable publication state stays truthful', async () => {
  const planId = await makePlan(alice.token, aliceClientId, assetRef, [accountOne, accountTwo]);

  // Force the audit append to fail the way the house tests force such
  // guards: a temporary DB rejection trigger on the audit trail for this
  // exact action (the audit-immutability test precedent of trigger-level
  // injection — the guard failure is real, the module dispatch is real).
  await pool().query(`
    CREATE OR REPLACE FUNCTION dispatch_audit_force_fail() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = 'distribution.dispatched' AND NEW.target_id = '${planId}' THEN
        RAISE EXCEPTION 'forced audit append failure (dispatch-route fixture)';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool().query(
    'DROP TRIGGER IF EXISTS dispatch_audit_force_fail_trigger ON audit_events',
  );
  await pool().query(`
    CREATE TRIGGER dispatch_audit_force_fail_trigger
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION dispatch_audit_force_fail();
  `);

  try {
    const dispatch = await dispatchRoute(alice.token, aliceClientId, planId);
    // NO FALSE SUCCESS: the response is a server error, never a 200 that
    // claims completion without its audit row (the pipeline ordering
    // guarantee: a material action that CLAIMS completion has already
    // persisted its audit row — an audit failure FAILS the request).
    assert.notEqual(dispatch.status, 200);
    assert.ok(dispatch.status >= 500, `the audit failure surfaces as a failed response (got ${dispatch.status})`);

    // The DURABLE publication state remains TRUTHFUL and readable: the
    // module had dispatched before the emit step, and the operator can
    // read the truth back through the GET route (the response made no
    // success claim, so response and durable state cannot disagree about
    // dispatch success — the 200 path above is the only success claim).
    const row = await planRow(planId);
    assert.equal(row.plan_state, 'dispatched', 'the durable state is truthful');
    const readBack = await apiCall(
      port(),
      `/api/clients/${aliceClientId}/cross-platform-distribution/plans/${planId}`,
      { token: alice.token },
    );
    assert.equal(readBack.status, 200);
    const readPlan = readBack.body['plan'] as Record<string, unknown>;
    assert.equal(readPlan['planState'], 'dispatched');
    const readPublications = readBack.body['publications'] as unknown[];
    assert.equal(readPublications.length, 2, 'the publications are durably recorded');

    // NO AUDIT ROW was silently emitted for the failed append.
    const audits = await auditRows(planId);
    assert.equal(audits.length, 0, 'no audit row exists for the failed append');
  } finally {
    // Remove the injection — the retry path below must run with the real
    // guard intact.
    await pool().query('DROP TRIGGER IF EXISTS dispatch_audit_force_fail_trigger ON audit_events');
    await pool().query('DROP FUNCTION IF EXISTS dispatch_audit_force_fail()');
  }

  // The RETRY after the audit failure converges: the re-dispatch replays
  // the recorded outcomes from the 056 fence (zero provider traffic for
  // the attempted destinations) and completes truthfully with its audit
  // row — retry/idempotency remains deterministic.
  const submitsBeforeRetry = fullAdapter!.callCount('submitPublish');
  const retry = await dispatchRoute(alice.token, aliceClientId, planId);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(fullAdapter!.callCount('submitPublish') - submitsBeforeRetry, 0, 'the replay made ZERO provider calls');
  const retryAudits = await auditRows(planId);
  assert.equal(retryAudits.length, 1, 'the retried dispatch emitted its audit row');
});

// ---------------------------------------------------------------------------
// 3. THE REPLAY/IDEMPOTENCY PATH — deterministic convergence
// ---------------------------------------------------------------------------

test('MKT-065 route fix (replay determinism): re-dispatching through the HTTP route converges deterministically', async () => {
  const planId = await makePlan(alice.token, aliceClientId, assetRef, [accountOne, accountTwo]);

  fullAdapter!.setNextSubmitState('published');
  const first = await dispatchRoute(alice.token, aliceClientId, planId);
  assert.equal(first.status, 200);
  const firstPublications = (first.body['publications'] as Record<string, unknown>[]).map(
    (publication) => publication['publishAttemptId'],
  );
  const firstRow = await planRow(planId);
  const firstAudit = await auditRows(planId);
  assert.equal(firstAudit.length, 1);

  // The REPLAY: the same route, the same plan — deterministic convergence.
  const submitsBefore = fullAdapter!.callCount('submitPublish');
  const second = await dispatchRoute(alice.token, aliceClientId, planId);
  assert.equal(second.status, 200, JSON.stringify(second.body));

  // ZERO provider traffic for the attempted destinations (the 056 fence).
  assert.equal(fullAdapter!.callCount('submitPublish') - submitsBefore, 0);

  // The outcomes CONVERGE: the same publish attempts (the at-most-once
  // identity), the same destination statuses.
  const secondPublications = (second.body['publications'] as Record<string, unknown>[]).map(
    (publication) => publication['publishAttemptId'],
  );
  assert.deepEqual([...secondPublications].sort(), [...firstPublications].sort());
  const destinations = second.body['destinations'] as Record<string, unknown>[];
  assert.deepEqual(
    destinations.map((destination) => destination['destinationStatus']),
    ['published', 'published'],
  );

  // The plan lifecycle converged (dispatched → dispatching → dispatched)
  // and a FRESH audit row records the new version (the deterministic
  // idempotency key carries the plan version).
  const secondRow = await planRow(planId);
  assert.equal(secondRow.plan_state, 'dispatched');
  assert.ok(secondRow.version > firstRow.version, 'the re-dispatch advanced the plan version');
  const secondAudit = await auditRows(planId);
  assert.equal(secondAudit.length, 2, 'each dispatch recorded its own audit event');
  assert.notEqual(secondAudit[0]!.idempotency_key, secondAudit[1]!.idempotency_key);
  assert.equal(secondAudit[1]!.details['outcomes'], 'published,published');
});
