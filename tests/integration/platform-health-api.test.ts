/**
 * MKT-066 integration tests — the /platform-health surfaces against a
 * REAL embedded PostgreSQL 18 stack (the content-intelligence/
 * cross-platform-distribution dual-level harness: HTTP fixtures over the
 * spawned API, then module-level round-trips + DB backstop proofs
 * against the SAME database through the in-process bootstrapApplication).
 *
 * The dispatch's five NAMED tests are exercised END-TO-END over the real
 * observable surfaces:
 *   (a) baseline-relative anomaly detection — a real /metrics observation
 *       history deviating from the account's OWN baseline produces the
 *       anomaly state; a cold-start account produces the honest
 *       insufficient-baseline disclosure;
 *   (b) observable-signals-only discipline — an account with NO
 *       observable records produces no verdict beyond the honest
 *       empty-observable posture (a provider notice with no observable
 *       record cannot produce a verdict), and a real 056 restricted
 *       publish outcome produces the restricted state;
 *   (c) reason codes + confidence/uncertainty + the FK-anchored evidence
 *       basis behind the verdict (the /metrics observation links + the
 *       /evidence anchors of the consumed observations);
 *   (d) compliant response recommendations from the §11 maneuver list as
 *       data (no anti-abuse/evasion action);
 *   (e) the closed nine-state vocabulary on the read surface.
 *
 * Plus the route discipline battery: uniform 404s, the owner|admin POST
 * gate, the authority-field rejection, client isolation, and the
 * append-only DB backstops.
 *
 * The platform under test is the DISCLOSED reference in-memory double at
 * the provider boundary ONLY (the MKT-056 conformance precedent): the
 * platform-health module under test (the observable-signal composition
 * through the five frozen-row public contracts, the deterministic
 * baseline calculation, the migration-058 fences) is fully REAL.
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
  type ReferenceSocialAdapter,
} from './helpers/reference-social-adapter.ts';
import { createReferenceIntegrationStub } from './helpers/social-adapter-conformance.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type { PlatformHealthModuleApi } from '../../src/modules/platform-health/public.ts';
import type { SocialAccountsModuleApi } from '../../src/modules/social-accounts/public.ts';
import type { IntegrationsModuleApi } from '../../src/modules/integrations/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'platform-health-pipe-key';
const FULL_PLATFORM_KEY = 'reference-social';
const CONTROL_PLATFORM_KEY = 'reference-readonly';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-000000000066',
  recordedVia: 'test',
  correlationId: 'integration-platform-health-1',
  causationId: null,
} as const;

const FULL_SCOPES = ['account:read', 'content:read', 'analytics:read', 'content:write'];

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: LocalOAuthProvider | null = null;
let fullAdapter: ReferenceSocialAdapter | null = null;
let controlAdapter: ReferenceSocialAdapter | null = null;
let platformHealth: PlatformHealthModuleApi | null = null;
let socialAccounts: SocialAccountsModuleApi | null = null;
let integrationsHandle: IntegrationsModuleApi | null = null;
let credentialsHandle: CredentialsModuleApi | null = null;

function ph(): PlatformHealthModuleApi {
  if (platformHealth === null) throw new Error('application not booted');
  return platformHealth;
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
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}
function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

// ---------------------------------------------------------------------------
// The shared fixtures
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

let connectionSeq = 0;
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
    label: `ph_pipe_${clientId.slice(0, 8)}_${connectionSeq}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection({
    clientId,
    adapterKey,
    credentialReferenceId: credential.credentialId,
    providerConfig: { apiBaseUrl: provider!.url },
  },
  PROVENANCE);
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
  options: { accountId: string; scopes: readonly string[] },
): Promise<string> {
  const start = await social().startAuthorization(
    { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...options.scopes], expectedAccountId: null },
    PROVENANCE,
  );
  const issued = provider!.issueAuthorization({
    accountId: options.accountId,
    displayIdentity: `ph:${options.accountId}`,
    verifiedAt: '2026-09-01T09:30:00.000Z',
    scopes: [...options.scopes],
    capabilityTags: ['adapter-tag'],
    expiresInMs: 3_600_000,
  });
  const completed = await social().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    PROVENANCE,
  );
  return completed.account.socialAccountId;
}

let metricSeq = 0;
/** Appends ONE /metrics observation of the account's series through the REAL HTTP surface. */
async function appendSeriesPoint(
  token: string,
  clientId: string,
  platform: string,
  socialAccountId: string,
  value: number,
  observedAt: string,
  evidenceRef?: string,
): Promise<string> {
  metricSeq += 1;
  const appended = await apiCall(port(), `/api/clients/${clientId}/metrics`, {
    token,
    body: {
      metricName: 'social.reach',
      dimensions: { platform, social_account_id: socialAccountId },
      value,
      unit: 'count',
      sourceSystem: 'reference-social',
      sourceRef: `ph-fixture/${metricSeq}`,
      observedAt,
      quality: 'ok',
      ...(evidenceRef === undefined ? {} : { evidenceRef }),
    },
  });
  assert.equal(appended.status, 201, JSON.stringify(appended.body));
  return appended.body['observationId'] as string;
}

async function makeEvidence(token: string, clientId: string): Promise<string> {
  metricSeq += 1;
  const created = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'source_fact',
      sourceSystem: 'platform-health-test',
      sourceRef: `fixture/ph/${metricSeq}`,
      observedAt: '2026-09-01T10:30:00.000Z',
      content: { kind: 'series-anchor', seq: metricSeq },
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

/** One real publish attempt through the 056 submit contract (the module API). */
async function submitPublish(
  socialAccountId: string,
  idempotencyKey: string,
): Promise<void> {
  await social().submitPublish(
    socialAccountId,
    {
      idempotencyKey,
      request: {
        contentType: 'reference-post',
        payload: { title: 'platform health fixture' },
        mediaAssets: [],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );
}

// ---------------------------------------------------------------------------
// Boot + fixtures
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let bob: Principal;
let bobClientId: string;
let mainAccountId: string;
let controlAccountId: string;
let coldStartAccountId: string;
let bareAccountId: string;

before(async () => {
  stack = await bootStack('platform_health');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startLocalOAuthProvider();
  fullAdapter = createReferenceSocialAdapter();
  controlAdapter = createReferenceSocialAdapter({
    adapterKey: CONTROL_PLATFORM_KEY,
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
      createReferenceIntegrationStub(CONTROL_PLATFORM_KEY),
    ],
    socialAccountFlows: [
      createLocalOAuthFlow(provider, { adapterKey: FULL_PLATFORM_KEY, secretsDir: stack.env.secretsDir }),
      createLocalOAuthFlow(provider, { adapterKey: CONTROL_PLATFORM_KEY, secretsDir: stack.env.secretsDir }),
    ],
    socialPlatformAdapters: [fullAdapter, controlAdapter],
  });
  platformHealth = core.modules.platformHealth;
  socialAccounts = core.modules.socialAccounts;
  integrationsHandle = core.modules.integrations;
  credentialsHandle = core.modules.credentials;

  // The fixtures: Alice's client with a MAIN account (reference-social)
  // and a CONTROL account (reference-readonly — another platform for the
  // §11 cross-platform control comparison), plus a COLD-START account
  // with no observable records; Bob's client for the isolation battery.
  alice = await makeAgencyOwner('alice@platformhealth.test');
  aliceClientId = await makeClient(alice);
  await allowAll(alice, 'network');
  await allowAll(alice, 'secrets');
  const mainConnection = await makePlatformConnection(alice, aliceClientId, FULL_PLATFORM_KEY);
  const controlConnection = await makePlatformConnection(alice, aliceClientId, CONTROL_PLATFORM_KEY);
  const coldConnection = await makePlatformConnection(alice, aliceClientId, FULL_PLATFORM_KEY);
  mainAccountId = await connectAccount(aliceClientId, mainConnection, { accountId: 'ph-main-1', scopes: FULL_SCOPES });
  controlAccountId = await connectAccount(aliceClientId, controlConnection, { accountId: 'ph-ctl-1', scopes: FULL_SCOPES });
  coldStartAccountId = await connectAccount(aliceClientId, coldConnection, { accountId: 'ph-cold-1', scopes: FULL_SCOPES });
  const bareConnection = await makePlatformConnection(alice, aliceClientId, FULL_PLATFORM_KEY);
  bareAccountId = await connectAccount(aliceClientId, bareConnection, { accountId: 'ph-bare-1', scopes: FULL_SCOPES });

  // The cold-start fixture: TWO series points (a thin history — fewer
  // than the three prior observations a baseline needs, but a real
  // observable record tail exists).
  await appendSeriesPoint(alice.token, aliceClientId, FULL_PLATFORM_KEY, coldStartAccountId, 900, '2026-09-12T10:00:00.000Z');
  await appendSeriesPoint(alice.token, aliceClientId, FULL_PLATFORM_KEY, coldStartAccountId, 920, '2026-09-13T10:00:00.000Z');

  bob = await makeAgencyOwner('bob@platformhealth.test');
  bobClientId = await makeClient(bob);
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
// (a) The baseline-relative anomaly detection — END-TO-END over real
//     /metrics observations
// ---------------------------------------------------------------------------

test('MKT-066 (a): a real baseline deviation produces the suspected_distribution_anomaly state over HTTP', async () => {
  // The account's OWN history: five healthy days, then a sustained collapse.
  const evidenceRef = await makeEvidence(alice.token, aliceClientId);
  const priorOne = await appendSeriesPoint(alice.token, aliceClientId, FULL_PLATFORM_KEY, mainAccountId, 1000, '2026-09-10T10:00:00.000Z', evidenceRef);
  await appendSeriesPoint(alice.token, aliceClientId, FULL_PLATFORM_KEY, mainAccountId, 1100, '2026-09-11T10:00:00.000Z', evidenceRef);
  await appendSeriesPoint(alice.token, aliceClientId, FULL_PLATFORM_KEY, mainAccountId, 950, '2026-09-12T10:00:00.000Z', evidenceRef);
  await appendSeriesPoint(alice.token, aliceClientId, FULL_PLATFORM_KEY, mainAccountId, 120, '2026-09-13T10:00:00.000Z', evidenceRef);
  await appendSeriesPoint(alice.token, aliceClientId, FULL_PLATFORM_KEY, mainAccountId, 90, '2026-09-14T10:00:00.000Z', evidenceRef);

  const evaluation = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${mainAccountId}/evaluations`,
    { token: alice.token, body: {} },
  );
  assert.equal(evaluation.status, 201, JSON.stringify(evaluation.body));
  const record = evaluation.body['evaluation'] as Record<string, unknown>;
  assert.equal(record['state'], 'suspected_distribution_anomaly');
  assert.ok((record['reasonCodes'] as string[]).includes('observed_metric_deviation_below_baseline'));
  assert.equal(record['confidence'], 'low'); // no control deviation yet
  // The evidence basis names the consumed /metrics observation records.
  const metricIds = evaluation.body['metricObservationIds'] as string[];
  assert.ok(metricIds.includes(priorOne));
  assert.equal(metricIds.length, 5);
  // The /evidence anchors of the consumed observations are FK-linked.
  const evidenceIds = evaluation.body['evidenceIds'] as string[];
  assert.deepEqual(evidenceIds, [evidenceRef]);
});

test('MKT-066 (a): a healthy cross-platform control sharpens the anomaly to medium confidence', async () => {
  // The CONTROL account (another platform) holds a STABLE series.
  await appendSeriesPoint(alice.token, aliceClientId, CONTROL_PLATFORM_KEY, controlAccountId, 800, '2026-09-10T10:00:00.000Z');
  await appendSeriesPoint(alice.token, aliceClientId, CONTROL_PLATFORM_KEY, controlAccountId, 850, '2026-09-11T10:00:00.000Z');
  await appendSeriesPoint(alice.token, aliceClientId, CONTROL_PLATFORM_KEY, controlAccountId, 780, '2026-09-12T10:00:00.000Z');
  await appendSeriesPoint(alice.token, aliceClientId, CONTROL_PLATFORM_KEY, controlAccountId, 820, '2026-09-13T10:00:00.000Z');
  await appendSeriesPoint(alice.token, aliceClientId, CONTROL_PLATFORM_KEY, controlAccountId, 810, '2026-09-14T10:00:00.000Z');

  const evaluation = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${mainAccountId}/evaluations`,
    { token: alice.token, body: {} },
  );
  assert.equal(evaluation.status, 201);
  const record = evaluation.body['evaluation'] as Record<string, unknown>;
  assert.equal(record['state'], 'suspected_distribution_anomaly');
  assert.equal(record['confidence'], 'medium');
  assert.ok((record['reasonCodes'] as string[]).includes('cross_platform_control_divergence'));
});

test('MKT-066 (a): cold-start produces the honest insufficient-baseline disclosure — never a fabricated verdict', async () => {
  const evaluation = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${coldStartAccountId}/evaluations`,
    { token: alice.token, body: {} },
  );
  assert.equal(evaluation.status, 201);
  const record = evaluation.body['evaluation'] as Record<string, unknown>;
  assert.equal(record['state'], 'healthy');
  assert.equal(record['confidence'], 'low');
  assert.ok((record['reasonCodes'] as string[]).includes('insufficient_baseline'));
  assert.ok((record['uncertainty'] as string).includes('insufficient baseline for anomaly detection'));
});

// ---------------------------------------------------------------------------
// (b) The observable-signals-only discipline — END-TO-END
// ---------------------------------------------------------------------------

test('MKT-066 (b): a provider notice with NO observable record cannot produce a verdict — the empty-observable posture', async () => {
  // The operator HEARD about a moderation action, but NOTHING is recorded
  // on any observable surface for the bare account: no publish attempts,
  // no metric series, no restriction signals. The evaluation input is
  // exactly { clientId, socialAccountId } — there is NO route, field or
  // parameter to smuggle a claim through, so the verdict cannot invent
  // the claimed moderation state.
  const evaluation = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${bareAccountId}/evaluations`,
    { token: alice.token, body: {} },
  );
  assert.equal(evaluation.status, 201);
  const record = evaluation.body['evaluation'] as Record<string, unknown>;
  assert.equal(record['state'], 'healthy');
  assert.equal(record['confidence'], 'low');
  assert.ok((record['reasonCodes'] as string[]).includes('no_observable_records'));
  assert.ok((record['uncertainty'] as string).includes('no observable records in the composed window'));
  // The §11 observability disclosure ships on every view.
  assert.ok(
    String(record['observabilityDisclosure']).includes('hidden platform moderation state is never invented'),
  );
});

test('MKT-066 (b): a real 056 restricted publish outcome produces the restricted state (platform-CONFIRMED)', async () => {
  // The reference platform scripts a restricted submit: the 056 attempt
  // lands 'restricted' carrying the provider-exposed signal
  // REFERENCE_ELIGIBILITY_HOLD — a platform-confirmed restriction record.
  fullAdapter!.setNextSubmitState('restricted');
  await submitPublish(mainAccountId, 'ph-restricted-1');
  fullAdapter!.setNextSubmitState('accepted');

  const evaluation = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${mainAccountId}/evaluations`,
    { token: alice.token, body: {} },
  );
  assert.equal(evaluation.status, 201);
  const record = evaluation.body['evaluation'] as Record<string, unknown>;
  // The platform-confirmed restriction PRECEDES the metric anomaly
  // (lock rule 26: restricted requires the confirmed record).
  assert.equal(record['state'], 'restricted');
  assert.equal(record['confidence'], 'high');
  const reasons = record['reasonCodes'] as string[];
  assert.ok(reasons.includes('restricted_publish_outcome_observed'));
  assert.ok(reasons.includes('platform_confirmed_restriction_signal'));
  // The 056 attempt is FK-linked behind the verdict.
  const attemptIds = evaluation.body['publishAttemptIds'] as string[];
  assert.equal(attemptIds.length, 1);
});

// ---------------------------------------------------------------------------
// (c) Reason codes + confidence/uncertainty + the evidence basis — END-TO-END
// ---------------------------------------------------------------------------

test('MKT-066 (c): the evaluation read-back carries the full honest basis (reasons, confidence, uncertainty, evidence links)', async () => {
  const list = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${mainAccountId}/evaluations`,
    { token: alice.token },
  );
  assert.equal(list.status, 200);
  const evaluations = list.body['evaluations'] as Record<string, unknown>[];
  assert.ok(evaluations.length >= 3, 'the append-only evaluation tail is readable');
  const newest = evaluations[evaluations.length - 1]!;
  assert.ok(newest['reasonCodes'] !== undefined);
  assert.ok(newest['confidence'] !== undefined);
  assert.ok(newest['uncertainty'] !== undefined);
  assert.ok(Array.isArray(newest['evidenceBasis']));
  assert.ok(newest['signalsConsidered'] !== undefined);

  // The single-evaluation read resolves the FK-anchored basis.
  const evaluationId = newest['evaluationId'] as string;
  const single = await apiCall(port(), `/api/platform-health/evaluations/${evaluationId}`, {
    token: alice.token,
  });
  assert.equal(single.status, 200);
  assert.equal(single.body['evaluationId'], undefined); // the detail shape
  assert.ok((single.body['evaluation'] as Record<string, unknown>)['evaluationId'] === evaluationId);
  assert.ok(Array.isArray(single.body['metricObservationIds']));

  // Module-level ownership resolution composes the owning chain.
  const ownership = await ph().resolveEvaluationOwnership(evaluationId);
  assert.ok(ownership !== null);
  assert.equal(ownership.scope.clientId, aliceClientId);
  assert.equal(ownership.scope.agencyId, await currentAgencyId(aliceClientId));
});

// ---------------------------------------------------------------------------
// (d) The compliant §11 maneuver recommendations — END-TO-END
// ---------------------------------------------------------------------------

test('MKT-066 (d): the recommendations ride every verdict as §11 maneuver data — no anti-abuse/evasion action', async () => {
  const evaluation = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${mainAccountId}/evaluations`,
    { token: alice.token, body: {} },
  );
  assert.equal(evaluation.status, 201);
  const record = evaluation.body['evaluation'] as Record<string, unknown>;
  const recommendations = record['recommendations'] as Record<string, string>[];
  // restricted → pause + appeal/review + human interaction + preserve goal.
  assert.deepEqual(
    recommendations.map((entry) => entry['maneuver']).sort(),
    [
      'pause_risky_strategy',
      'platform_appeal_or_review',
      'preserve_goal_change_route',
      'request_human_interaction',
    ],
  );
  for (const recommendation of recommendations) {
    assert.ok(recommendation['description'] !== undefined);
    assert.ok(recommendation['rationale'] !== undefined);
  }
});

// ---------------------------------------------------------------------------
// (e) The closed nine-state vocabulary on the read surface
// ---------------------------------------------------------------------------

test('MKT-066 (e): every persisted evaluated_state is one of the frozen nine (DB CHECK backstop)', async () => {
  const states = await pool().query<{ evaluated_state: string }>(
    'SELECT DISTINCT evaluated_state FROM platform_health_evaluations',
  );
  const frozen = [
    'healthy', 'degraded', 'restricted', 'suspected_distribution_anomaly',
    'suspected_automation_risk', 'authorization_blocked', 'publishing_blocked',
    'quota_limited', 'human_review_required',
  ];
  for (const row of states.rows) {
    assert.ok(frozen.includes(row.evaluated_state), `state '${row.evaluated_state}' is one of the frozen nine`);
  }
  // The CHECK fence rejects an unknown state outright.
  const fixtureAgencyId = await currentAgencyId(aliceClientId);
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO platform_health_evaluations
           (platform_health_evaluation_id, agency_id, client_id, social_account_id, platform_id,
            evaluated_state, confidence, uncertainty, reason_codes, vocabulary_version,
            baseline_version, recorded_actor, recorded_via, correlation_id, created_at)
         VALUES ($1, $2, $3, $5, $4, 'shadow-banned', 'low', 'x', '[]'::jsonb, 'ph-vocab-v1',
                 'ph-baseline-v1', 'test', 'test', 'c', now())`,
        ['99999999-9999-4999-8999-999999999999', fixtureAgencyId, aliceClientId, 'reference-social', mainAccountId],
      ),
    (error: unknown) => error instanceof Error && /evaluated_state/.test(error.message),
    'an unknown state (the shadow-ban synonym) is rejected by the CHECK fence',
  );
});

// ---------------------------------------------------------------------------
// The route discipline battery (uniform 404s, authorization, isolation)
// ---------------------------------------------------------------------------

test('MKT-066: the route discipline — uniform 404s, the owner|admin POST gate, the authority-field rejection, client isolation', async () => {
  // Malformed + foreign account ids are the uniform 404.
  const malformed = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/not-a-uuid/evaluations`,
    { token: alice.token, body: {} },
  );
  assert.equal(malformed.status, 404);
  const foreign = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${'00000000-0000-4000-8000-000000000000'}/evaluations`,
    { token: alice.token, body: {} },
  );
  assert.equal(foreign.status, 404);
  // Bob cannot evaluate Alice's account through his own client (uniform 404).
  const crossTenant = await apiCall(
    port(),
    `/api/clients/${bobClientId}/platform-health/accounts/${mainAccountId}/evaluations`,
    { token: bob.token, body: {} },
  );
  assert.equal(crossTenant.status, 404);
  // Anonymous calls fail closed at the authenticator.
  const anonymous = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${mainAccountId}/evaluations`,
    { body: {} },
  );
  assert.equal(anonymous.status, 401);
  // An authority-shaped body field is rejected (the evaluation input has
  // NO signal/state/claim channel — smuggling a verdict is a 422).
  const smuggled = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${mainAccountId}/evaluations`,
    { token: alice.token, body: { state: 'restricted', reasonCodes: ['platform_confirmed_restriction_signal'] } },
  );
  assert.equal(smuggled.status, 422, JSON.stringify(smuggled.body));
  // The single-evaluation read 404s for Bob (client isolation).
  const list = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/platform-health/accounts/${mainAccountId}/evaluations`,
    { token: alice.token },
  );
  const newest = (list.body['evaluations'] as Record<string, unknown>[]).at(-1)!;
  const bobRead = await apiCall(
    port(),
    `/api/platform-health/evaluations/${newest['evaluationId'] as string}`,
    { token: bob.token },
  );
  assert.equal(bobRead.status, 404);
  // Bob's client listing carries no Alice evaluations.
  const bobList = await apiCall(port(), `/api/clients/${bobClientId}/platform-health`, {
    token: bob.token,
  });
  assert.equal(bobList.status, 200);
  assert.equal((bobList.body['evaluations'] as unknown[]).length, 0);
});

test('MKT-066: the module-level list surfaces resolve ownership honestly', async () => {
  const tail = await ph().listEvaluationsForAccount(aliceClientId, mainAccountId);
  assert.ok(tail.length >= 3);
  await assert.rejects(
    () => ph().listEvaluationsForAccount(aliceClientId, '00000000-0000-4000-8000-000000000000'),
    (error: unknown) => error instanceof Error && error.name === 'NotFoundError',
    'an unknown account is the uniform 404',
  );
  const clientTail = await ph().listEvaluationsForClient(aliceClientId);
  assert.ok(clientTail.length >= tail.length);
});

// ---------------------------------------------------------------------------
// The DB backstops (append-only, scope fences)
// ---------------------------------------------------------------------------

test('MKT-066: evaluations are APPEND-ONLY — UPDATE and DELETE are rejected by the DB triggers', async () => {
  const existing = await pool().query<{ platform_health_evaluation_id: string }>(
    'SELECT platform_health_evaluation_id FROM platform_health_evaluations LIMIT 1',
  );
  const id = existing.rows[0]!.platform_health_evaluation_id;
  await assert.rejects(
    () =>
      pool().query('UPDATE platform_health_evaluations SET evaluated_state = $1 WHERE platform_health_evaluation_id = $2', [
        'healthy',
        id,
      ]),
    (error: unknown) => error instanceof Error && /append-only/.test(error.message),
  );
  await assert.rejects(
    () => pool().query('DELETE FROM platform_health_evaluations WHERE platform_health_evaluation_id = $1', [id]),
    (error: unknown) => error instanceof Error && /append-only/.test(error.message),
  );
});

test('MKT-066: the citation links are scope-fenced same-Client (the cross-client evidence link is rejected)', async () => {
  const evaluation = await pool().query<{ platform_health_evaluation_id: string; client_id: string }>(
    'SELECT platform_health_evaluation_id, client_id FROM platform_health_evaluations LIMIT 1',
  );
  const evaluationId = evaluation.rows[0]!.platform_health_evaluation_id;
  // An evidence record of ANOTHER client (Bob's fixture creates none —
  // use a fabricated uuid: the FK anchor rejects the dangling reference).
  await assert.rejects(
    () =>
      pool().query(
        'INSERT INTO platform_health_evaluation_evidence (platform_health_evaluation_id, evidence_id, position) VALUES ($1, $2, 1)',
        [evaluationId, '00000000-0000-4000-8000-000000000000'],
      ),
    (error: unknown) => error instanceof Error,
    'the FK anchor rejects a dangling evidence reference',
  );
  // The same-client scope fence: an evidence record of Bob's client
  // cannot be cited by an Alice evaluation.
  const bobEvidence = await pool().query<{ evidence_id: string }>(
    `INSERT INTO evidence (evidence_id, client_id, class, source_system, source_ref,
                           observed_at, content, quality, recorded_actor, recorded_via,
                           correlation_id, recorded_at)
     VALUES (gen_random_uuid(), $1, 'source_fact', 'bob', 'bob/1', now(),
             '{"kind":"bob-fixture"}'::jsonb, 'C', 'test', 'test', 'bob-corr', now())
     RETURNING evidence_id`,
    [bobClientId],
  );
  await assert.rejects(
    () =>
      pool().query(
        'INSERT INTO platform_health_evaluation_evidence (platform_health_evaluation_id, evidence_id, position) VALUES ($1, $2, 1)',
        [evaluationId, bobEvidence.rows[0]!.evidence_id],
      ),
    (error: unknown) => error instanceof Error && /crosses a client boundary/.test(error.message),
    'the same-Client evidence scope fence rejects the cross-client citation',
  );
});
