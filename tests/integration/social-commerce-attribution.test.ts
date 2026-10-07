/**
 * MKT-073 integration tests — the /social-commerce-attribution surfaces
 * against a REAL embedded PostgreSQL 18 stack (the commerce-discovery
 * harness: HTTP fixtures over the spawned API, then module-level
 * round-trips + DB backstop proofs against the SAME database through the
 * in-process bootstrapApplication).
 *
 * THE ACCEPTANCE, END-TO-END over the real composed surfaces:
 *
 *   (a) THE GOLDEN PATH: construction → provider-boundary crossing →
 *       THE REAL MKT-071 WEBHOOK ORDER LANDING → THE JOIN — the stable
 *       attribution id minted ONCE (deterministic), carried VERBATIM by
 *       the constructed link, the attachments (THE TRANSFORMATION EXTENDS
 *       THE SURVIVAL CHAIN — original + derived identities) and the
 *       provider-boundary crossing (THE EXACT FIELD recorded, the single
 *       guarded echoed/dropped advance); the REAL order lands through the
 *       MKT-071 commerce webhook boundary with the reference riding the
 *       attribution passthrough VERBATIM; the outcome is verified by the
 *       co-occurrence matcher (the UNIVERSAL attributionRef carrier + the
 *       mechanism-specific utmContent field) — never a caller-asserted
 *       match — carrying the CHECK-fenced co-occurrence note and the
 *       evidence/metrics flowback citation;
 *   (b) THE IDEMPOTENT CONVERGENCE: the same canonical inputs converge on
 *       the SAME reference row (no re-minting, no id swap; the identity
 *       digest is the fence) and the same construction inputs converge on
 *       the SAME construction row (the input digest is the fence);
 *   (c) THE SURVIVAL-CHAIN FENCE at the DB level: a dropped-original
 *       attachment is INEXPRESSIBLE (the sca_carried_refs_valid CHECK);
 *   (d) THE APPEND-ONLY DB BACKSTOPS: UPDATE/DELETE rejected on the four
 *       append-only families; the guarded advances are single-shot;
 *   (e) THE 23514 PROBE: a causal-claiming outcome row is INEXPRESSIBLE
 *       (the co_occurrence_note CHECK fence — a valid FK chain otherwise);
 *   (f) THE NO-VERIFIED-MATCH 409: the co-occurrence is NOT evidenced →
 *       the outcome row stays inexpressible (never caller-asserted);
 *   (g) THE FIRST-PARTY CONVERSION EVENTS + THE ORDER-TRUTH FENCE: a
 *       store visit matching through the MECHANISM-SPECIFIC utmContent
 *       field; an 'order' kind honestly refused at the guard; a non-order
 *       commerce event citation honestly refused (orders come from the
 *       real commerce boundary ONLY);
 *   (h) THE UNIFORM 404s + TENANT ISOLATION (no existence oracle);
 *   (i) THE RETIREMENT ADVANCE (single-shot; a retired reference accepts
 *       no new linkage; history stays readable);
 *   (j) THE HONEST 'unavailable' MECHANISM (a platform that offers no
 *       attribution mechanism builds nothing — the 409 + the DB double
 *       fence; never a fabricated link).
 *
 * The platform under test: the DISCLOSED reference in-memory double at
 * the provider boundary ONLY (the local commerce provider double serving
 * the webhook signature). The /social-commerce-attribution module under
 * test (the deterministic sca-contract/sca-link/sca-match cores, the
 * migration-069 fences) is fully REAL, as are the /growth-missions,
 * /workspaces, /clients, /credentials, /policies and /integrations
 * modules it composes — the module is wired IN-TEST exactly as the
 * composition root will wire it at the TL's promotion (the wiring block
 * below IS the promotion demonstration).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
  startCommerceProvider,
  commerceWebhookSignature,
  type CommerceProviderDouble,
} from './helpers/commerce-provider.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import {
  createSocialCommerceAttributionModule,
  SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE,
  SOCIAL_ATTRIBUTION_REF_PATTERN,
  type SocialCommerceAttributionModuleApi,
} from '../../src/modules/social-commerce-attribution/public.ts';
import { ConflictError, InvalidRequestError, NotFoundError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const COMMERCE_TOKEN = 'ea-fakeSandboxSocialCommerceAttribution';
const COMMERCE_WEBHOOK_SECRET = 'whsec_SocialCommerceAttributionFake';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-000000000073',
  recordedVia: 'test',
  correlationId: 'integration-social-commerce-attribution-1',
  causationId: null,
} as const;

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: CommerceProviderDouble | null = null;
let attribution: SocialCommerceAttributionModuleApi | null = null;

function sca(): SocialCommerceAttributionModuleApi {
  if (attribution === null) throw new Error('application not booted');
  return attribution;
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
// The shared fixtures (the commerce-discovery precedent)
// ---------------------------------------------------------------------------

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
    body: { name: `Agency ${email.split('@')[0]} ${userSeq}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { userId, token: login.body['token'] as string, agencyId };
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

let clientSeq = 0;
async function makeClient(principal: Principal): Promise<string> {
  clientSeq += 1;
  const created = await apiCall(port(), `/api/agencies/${principal.agencyId}/clients`, {
    token: principal.token,
    body: { name: `Client ${principal.agencyId.slice(0, 8)} ${clientSeq}` },
  });
  assert.equal(created.status, 201);
  return created.body['clientId'] as string;
}

async function makeWorkspace(principal: Principal, clientId: string): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: principal.token,
    body: { name: `Pursuit Workspace ${clientId.slice(0, 8)}` },
  });
  assert.equal(created.status, 201);
  return created.body['workspaceId'] as string;
}

async function makeMission(
  token: string,
  objective: string,
  agencyId: string,
): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/growth-missions`, {
    token,
    body: {
      objective,
      objectiveFamily: 'product_marketing',
      productContext: { name: 'Kitchen Helper', url: 'https://kitchen-product.test/', summary: 'The declared product context.' },
      marketContext: { audience: 'home cooks', geography: 'global', summary: 'The declared market context.' },
      targetMetrics: [],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body['mission'] as Record<string, unknown>)['missionId'] as string;
}

// ---------------------------------------------------------------------------
// Boot + fixtures
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let aliceWorkspaceId: string;
let bob: Principal;
let bobClientId: string;
let storeConnectionId: string;
let bobConnectionId: string;
let missionId: string;

before(async () => {
  stack = await bootStack('social_commerce_attribution');
  const fs = await import('node:fs');
  fs.writeFileSync(
    `${stack.env.secretsDir}/sca-commerce-key.secret`,
    JSON.stringify({
      accessToken: COMMERCE_TOKEN,
      webhookSecret: COMMERCE_WEBHOOK_SECRET,
      grantedScopes: ['catalog:read', 'orders:read'],
    }),
    { mode: 0o600 },
  );
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startCommerceProvider({ [COMMERCE_TOKEN]: ['catalog:read', 'orders:read'] });
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();

  // -------------------------------------------------------------------------
  // THE COMPOSITION-ROOT WIRING DEMONSTRATION (byte-exact — the TL's
  // promotion block): the module deps are the platform ports (db, clock,
  // ids) + the three declared structural ports over the REAL public
  // contract instances —
  //   missions: growthMissions (the frozen-row /growth-missions direction,
  //             READ-ONLY through the narrow port),
  //   workspaces: the resolveWorkspaceOwnership wrapper (the DISCLOSED
  //             off-matrix pursuit-scope port — the MKT-070/MKT-072
  //             precedent, the canonical workspace → client → agency
  //             chain),
  //   commerceEvents: integrations (the frozen-row /integrations direction
  //             through the narrow commerce-event port — the LAB-013
  //             Arena-port precedent).
  // -------------------------------------------------------------------------
  const attributionPursuitScope = {
    resolveWorkspace: async (workspaceId: string) => {
      const ownership = await core.modules.workspaces.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) return null;
      return {
        workspaceId: ownership.scope.workspaceId,
        clientId: ownership.scope.clientId,
        agencyId: ownership.scope.agencyId,
        status: ownership.workspace.status,
      };
    },
  };
  attribution = createSocialCommerceAttributionModule({
    db: core.services.db,
    clock: core.services.clock,
    ids: core.services.ids,
    missions: core.modules.growthMissions,
    workspaces: attributionPursuitScope,
    commerceEvents: core.modules.integrations,
  });

  // --- The pursuit tenant (Alice) + the isolation tenant (Bob). ---
  alice = await makeAgencyOwner('alice@socialcommerceattribution.test');
  aliceClientId = await makeClient(alice);
  aliceWorkspaceId = await makeWorkspace(alice, aliceClientId);
  await allowAll(alice, 'network');
  await allowAll(alice, 'secrets');
  bob = await makeAgencyOwner('bob@socialcommerceattribution.test');
  bobClientId = await makeClient(bob);
  await allowAll(bob, 'network');
  await allowAll(bob, 'secrets');

  // --- The commerce boundary (the MKT-071 store connections). ---
  const credentials = core.modules.credentials;
  const integrations = core.modules.integrations;
  const aliceCredential = await credentials.createCredentialReference({
    agencyId: alice.agencyId,
    clientId: aliceClientId,
    kind: 'integration_api_key',
    label: `sca_store_${aliceClientId.slice(0, 8)}`,
    secretHandle: 'sca-commerce-key',
    actorId: null,
  });
  const aliceRegistered = await integrations.registerConnection(
    {
      clientId: aliceClientId,
      adapterKey: 'commerce-cms',
      credentialReferenceId: aliceCredential.credentialId,
      providerConfig: { apiBaseUrl: provider!.url },
    },
    PROVENANCE,
  );
  const aliceConnected = await integrations.connectConnection(
    { connectionId: aliceRegistered.connectionId, expectedVersion: 1 },
    PROVENANCE,
  );
  assert.equal(aliceConnected.status, 'connected');
  storeConnectionId = aliceRegistered.connectionId;
  const bobCredential = await credentials.createCredentialReference({
    agencyId: bob.agencyId,
    clientId: bobClientId,
    kind: 'integration_api_key',
    label: `sca_store_${bobClientId.slice(0, 8)}`,
    secretHandle: 'sca-commerce-key',
    actorId: null,
  });
  const bobRegistered = await integrations.registerConnection(
    {
      clientId: bobClientId,
      adapterKey: 'commerce-cms',
      credentialReferenceId: bobCredential.credentialId,
      providerConfig: { apiBaseUrl: provider!.url },
    },
    PROVENANCE,
  );
  const bobConnected = await integrations.connectConnection(
    { connectionId: bobRegistered.connectionId, expectedVersion: 1 },
    PROVENANCE,
  );
  assert.equal(bobConnected.status, 'connected');
  bobConnectionId = bobRegistered.connectionId;

  // --- The mission (the spine the references are scoped to). ---
  missionId = await makeMission(
    alice.token,
    'Market the kitchen apron through social content and attribute the orders',
    alice.agencyId,
  );
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
// The reference input builders
// ---------------------------------------------------------------------------

function referenceInput(overrides: Record<string, unknown> = {}) {
  return {
    missionId,
    pursuitWorkspaceId: aliceWorkspaceId,
    mechanism: 'utm_parameters' as const,
    purpose: 'link the kitchen-apron short-video experiment to the store',
    creationContext: {
      contentRef: 'ca:apron:1',
      experimentArm: 'arm-b-short-video',
      distributionPlan: 'cpd-plan-91',
    },
    ...overrides,
  };
}

let mintedReferenceId = '';
let mintedAttributionRef = '';
let mintedIdentityDigest = '';
let constructionId = '';
let constructedLink = '';
let storeVisitConversionId = '';
let orderConversionEventId = '';
let orderCommerceEventId = '';
let outcomeId = '';

// ---------------------------------------------------------------------------
// (a) THE GOLDEN PATH
// ---------------------------------------------------------------------------

test('MKT-073 (a): THE GOLDEN PATH I — the reference is MINTED deterministically (the mission scoped through the REAL growth-missions port; the stable id grammar)', async () => {
  const reference = await sca().createAttributionReference(referenceInput(), PROVENANCE);
  assert.equal(reference.missionId, missionId);
  assert.equal(reference.mechanism, 'utm_parameters');
  assert.equal(reference.status, 'active');
  assert.equal(reference.contractVersion, 'sca-contract-v1');
  assert.equal(reference.vocabularyVersion, 'sca-vocab-v1');
  // THE STABLE ATTRIBUTION ID: 'sca-' + 16 lowercase hex, minted ONCE.
  assert.match(reference.attributionRef, SOCIAL_ATTRIBUTION_REF_PATTERN);
  assert.equal(reference.identityDigest.length, 64);
  assert.equal(reference.attributionRef, `sca-${reference.identityDigest.slice(0, 16)}`);
  assert.ok(reference.provenance.recordedAt.length > 0);
  mintedReferenceId = reference.attributionReferenceId;
  mintedAttributionRef = reference.attributionRef;
  mintedIdentityDigest = reference.identityDigest;
});

test('MKT-073 (a): THE GOLDEN PATH II — the link construction is the deterministic pure formula (the UTM tuple with the reference riding utm_content)', async () => {
  const construction = await sca().constructAttributionLink(
    {
      attributionReferenceId: mintedReferenceId,
      construction: {
        mechanism: 'utm_parameters',
        attributionRef: mintedAttributionRef,
        missionId,
        baseUrl: 'https://store.example.test/products/apron',
      },
    },
    PROVENANCE,
  );
  // The deterministic UTM tuple: utm_source=mos, utm_medium=social,
  // utm_campaign=<campaign id>, utm_content=<THE STABLE ID VERBATIM>.
  const campaign = `sca-${missionId.replace(/-/g, '').slice(0, 8)}-${mintedAttributionRef.slice(4)}`;
  assert.equal(
    construction.constructedLink,
    `https://store.example.test/products/apron?utm_source=mos&utm_medium=social&utm_campaign=${campaign}&utm_content=${mintedAttributionRef}`,
  );
  assert.equal(construction.matchField, 'utmContent');
  assert.equal(construction.matchValue, mintedAttributionRef);
  assert.equal(construction.constructionVersion, 'sca-link-v1');
  assert.equal(construction.inputDigest.length, 64);
  constructionId = construction.linkConstructionId;
  constructedLink = construction.constructedLink;
});

test('MKT-073 (a): THE GOLDEN PATH III — THE TRANSFORMATION EXTENDS THE SURVIVAL CHAIN (the original + every derived identity; append-extended per transformation)', async () => {
  // The first transformation carries the reference: the chain cites the
  // ORIGINAL identity AND the derived one.
  const first = await sca().recordAttributionAttachment(
    {
      attributionReferenceId: mintedReferenceId,
      carrierKind: 'content_transformation',
      carrierRef: 'cpd-destination-transform-44',
      originalContentRef: 'ca:apron:1',
      carriedContentRefs: ['ca:apron:1', 'ca:apron:2'],
      reason: 'the short-video transform carried the reference',
    },
    PROVENANCE,
  );
  assert.equal(first.originalContentRef, 'ca:apron:1');
  assert.deepEqual([...first.carriedContentRefs], ['ca:apron:1', 'ca:apron:2']);
  // The SECOND transformation EXTENDS the chain as a NEW append-only
  // record (the id survives the cross-platform distribution chain — the
  // original is still carried).
  const second = await sca().recordAttributionAttachment(
    {
      attributionReferenceId: mintedReferenceId,
      carrierKind: 'content_transformation',
      carrierRef: 'cpd-destination-transform-45',
      originalContentRef: 'ca:apron:1',
      carriedContentRefs: ['ca:apron:1', 'ca:apron:2', 'ca:apron:3'],
      reason: 'the vertical-crop transform extended the survival chain',
    },
    PROVENANCE,
  );
  assert.deepEqual([...second.carriedContentRefs], ['ca:apron:1', 'ca:apron:2', 'ca:apron:3']);
  const attachments = await sca().listAttachmentsForReference(mintedReferenceId);
  assert.equal(attachments!.length, 2);
});

test('MKT-073 (a): THE GOLDEN PATH IV — the provider-boundary crossing records the EXACT field (born dispatched; the single guarded advance to echoed)', async () => {
  const crossing = await sca().recordProviderBoundaryCrossing(
    {
      attributionReferenceId: mintedReferenceId,
      linkConstructionId: constructionId,
      providerKey: 'tiktok',
      payloadField: 'link_params.utm_content',
      dispatchedValue: mintedAttributionRef,
    },
    PROVENANCE,
  );
  // THE EXACT FIELD the reference rode in the provider payload.
  assert.equal(crossing.providerKey, 'tiktok');
  assert.equal(crossing.payloadField, 'link_params.utm_content');
  assert.equal(crossing.dispatchedValue, mintedAttributionRef);
  assert.equal(crossing.crossingState, 'dispatched');
  assert.equal(crossing.echoValue, null);
  // The provider returned the reference — the echo recorded VERBATIM.
  const echoed = await sca().advanceProviderBoundaryCrossing(
    {
      crossingId: crossing.crossingId,
      toState: 'echoed',
      echoValue: mintedAttributionRef,
      reason: 'the provider echoed the reference through its link params',
    },
    PROVENANCE,
  );
  assert.equal(echoed.crossingState, 'echoed');
  assert.equal(echoed.echoValue, mintedAttributionRef);
  assert.ok(echoed.echoObservedAt !== null);
  // The advance is SINGLE-SHOT (a second attempt is an honest 409).
  await assert.rejects(
    sca().advanceProviderBoundaryCrossing(
      {
        crossingId: crossing.crossingId,
        toState: 'dropped',
        echoValue: null,
        reason: 'a second attempt',
      },
      PROVENANCE,
    ),
    ConflictError,
  );
});

test('MKT-073 (a): THE GOLDEN PATH V — the honest dropped crossing (the provider dropped the reference — never fabricated into an echo)', async () => {
  const crossing = await sca().recordProviderBoundaryCrossing(
    {
      attributionReferenceId: mintedReferenceId,
      linkConstructionId: constructionId,
      providerKey: 'x',
      payloadField: 'share.attribution_ref',
      dispatchedValue: mintedAttributionRef,
    },
    PROVENANCE,
  );
  // A dropped advance REQUIRES the honest null echo (the guard refuses
  // a fabricated echo value first).
  await assert.rejects(
    sca().advanceProviderBoundaryCrossing(
      {
        crossingId: crossing.crossingId,
        toState: 'dropped',
        echoValue: mintedAttributionRef,
        reason: 'the fabricated echo attempt',
      },
      PROVENANCE,
    ),
    InvalidRequestError,
  );
  const dropped = await sca().advanceProviderBoundaryCrossing(
    {
      crossingId: crossing.crossingId,
      toState: 'dropped',
      echoValue: null,
      reason: 'the provider dropped the reference from its payload',
    },
    PROVENANCE,
  );
  assert.equal(dropped.crossingState, 'dropped');
  assert.equal(dropped.echoValue, null);
  const crossings = await sca().listProviderCrossingsForReference(mintedReferenceId);
  assert.equal(crossings!.length, 2);
});

test('MKT-073 (a): THE GOLDEN PATH VI — the REAL order lands through the MKT-071 commerce webhook boundary with the reference riding the attribution passthrough VERBATIM', async () => {
  // The REAL webhook delivery (the local provider double signs it; the
  // REAL CommerceCmsAdapter verifies; the REAL /integrations ingests).
  const orderPayload = {
    eventId: 'evt_sca_7001',
    kind: 'order.created',
    occurredAt: '2026-10-06T11:00:00.000Z',
    order: {
      id: 'ord_sca_2001',
      number: 'MOS-SCA-2001',
      status: 'paid',
      currency: 'USD',
      total: '45.00',
      placedAt: '2026-10-06T11:00:00.000Z',
      updatedAt: '2026-10-06T11:05:00.000Z',
      customerEmail: 'buyer@example.test',
      lineItems: [
        { productId: 'prd_501', variantId: 'var_9', title: 'Tactical Apron', quantity: 1, unitPrice: '45.00' },
      ],
      attribution: { attributionRef: mintedAttributionRef, utmSource: 'tiktok' },
    },
  };
  const delivered = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/connections/${storeConnectionId}/webhook`,
    {
      token: alice.token,
      body: {
        eventType: 'order.created',
        payload: orderPayload,
        headers: commerceWebhookSignature(COMMERCE_WEBHOOK_SECRET, orderPayload),
      },
    },
  );
  assert.equal(delivered.status, 201, JSON.stringify(delivered.body));
  assert.equal(delivered.body['duplicate'], false);
  orderCommerceEventId = (delivered.body['commerceEvent'] as Record<string, unknown>)['commerceEventId'] as string;
  assert.ok(orderCommerceEventId.length > 0);
});

test('MKT-073 (a): THE GOLDEN PATH VII — the order conversion event cites the REAL commerce event (the order truth through the commerce-event port; the passthrough VERBATIM)', async () => {
  const conversion = await sca().recordOrderConversionEvent(
    {
      pursuitWorkspaceId: aliceWorkspaceId,
      commerceEventId: orderCommerceEventId,
    },
    PROVENANCE,
  );
  assert.equal(conversion.conversionKind, 'order');
  assert.equal(conversion.eventSource, 'order_webhook');
  assert.equal(conversion.commerceEventId, orderCommerceEventId);
  assert.ok(conversion.storeConnectionId !== null);
  // The observed reference fields are the commerce event's attribution
  // passthrough VERBATIM (the co-occurrence matcher runs over them).
  assert.deepEqual({ ...conversion.observedFields }, {
    attributionRef: mintedAttributionRef,
    utmSource: 'tiktok',
  });
  orderConversionEventId = conversion.conversionEventId;
});

test('MKT-073 (a): THE GOLDEN PATH VIII — THE JOIN (the co-occurrence matcher verifies through the UNIVERSAL attributionRef carrier; the CHECK-fenced note + the flowback read model)', async () => {
  const outcome = await sca().recordAttributionOutcome(
    {
      conversionEventId: orderConversionEventId,
      attributionReferenceId: mintedReferenceId,
    },
    PROVENANCE,
  );
  // The provider returned the reference's OWN stable id through its own
  // attribution field — the survival proof across the provider boundary.
  assert.equal(outcome.matchedField, 'attributionRef');
  assert.equal(outcome.matchedValue, mintedAttributionRef);
  assert.equal(outcome.mechanism, 'utm_parameters');
  assert.equal(outcome.linkConstructionId, constructionId);
  // The match provenance: which id matched, on which field, observed
  // when, by which source.
  assert.equal((outcome.matchProvenance as Record<string, unknown>)['matchedId'], mintedAttributionRef);
  assert.equal((outcome.matchProvenance as Record<string, unknown>)['matchedField'], 'attributionRef');
  assert.equal((outcome.matchProvenance as Record<string, unknown>)['observedBy'], 'order_webhook');
  assert.equal((outcome.matchProvenance as Record<string, unknown>)['matcherVersion'], 'sca-match-v1');
  // THE CHECK-FENCED CO-OCCURRENCE NOTE (never a causal claim).
  assert.equal(outcome.coOccurrenceNote, SOCIAL_ATTRIBUTION_CO_OCCURRENCE_NOTE);
  assert.equal(outcome.coOccurrenceNote, 'co-occurrence evidence only — never causal proof');
  outcomeId = outcome.attributionOutcomeId;
  // THE EVIDENCE/METRICS FLOWBACK READ MODEL (the cited projection —
  // this module writes neither /metrics nor /evidence tables).
  const readModel = await sca().listAttributionOutcomeReadModel(aliceClientId);
  assert.equal(readModel.length, 1);
  const row = readModel[0]!;
  assert.equal(row.outcomeId, outcomeId);
  assert.equal(row.attributionReference.attributionRef, mintedAttributionRef);
  assert.equal(row.attributionReference.missionId, missionId);
  assert.equal(row.conversionEvent.conversionKind, 'order');
  assert.equal(row.conversionEvent.commerceEventId, orderCommerceEventId);
  assert.equal(row.coOccurrenceNote, 'co-occurrence evidence only — never causal proof');
  // The mission's outcomes list the same join.
  const forMission = await sca().listAttributionOutcomesForMission(missionId);
  assert.equal(forMission!.length, 1);
});

// ---------------------------------------------------------------------------
// (b) The idempotent convergence
// ---------------------------------------------------------------------------

test('MKT-073 (b): the idempotent convergence — the same canonical inputs converge on the SAME reference (no re-minting, no id swap)', async () => {
  const replay = await sca().createAttributionReference(referenceInput(), PROVENANCE);
  assert.equal(replay.attributionReferenceId, mintedReferenceId);
  assert.equal(replay.attributionRef, mintedAttributionRef);
  assert.equal(replay.identityDigest, mintedIdentityDigest);
  // The DB holds EXACTLY ONE row for the identity digest (the
  // idempotence fence — no silent duplicate, no silent rewrite).
  const rows = await pool().query(
    'SELECT count(*)::int AS n FROM social_attribution_references WHERE identity_digest = $1',
    [mintedIdentityDigest],
  );
  assert.equal(rows.rows[0]!['n'], 1);
  // The construction replay converges the same way (the input digest is
  // the fence).
  const replayed = await sca().constructAttributionLink(
    {
      attributionReferenceId: mintedReferenceId,
      construction: {
        mechanism: 'utm_parameters',
        attributionRef: mintedAttributionRef,
        missionId,
        baseUrl: 'https://store.example.test/products/apron',
      },
    },
    PROVENANCE,
  );
  assert.equal(replayed.linkConstructionId, constructionId);
  assert.equal(replayed.constructedLink, constructedLink);
  const constructions = await sca().listLinkConstructionsForReference(mintedReferenceId);
  assert.equal(constructions!.length, 1);
});

// ---------------------------------------------------------------------------
// (c) The survival-chain fence at the DB level
// ---------------------------------------------------------------------------

test('MKT-073 (c): THE SURVIVAL-CHAIN FENCE at the DB level — a dropped-original attachment is INEXPRESSIBLE (the sca_carried_refs_valid CHECK)', async () => {
  const scope = await pool().query(
    'SELECT agency_id, client_id, workspace_id FROM social_attribution_references WHERE attribution_reference_id = $1',
    [mintedReferenceId],
  );
  const row = scope.rows[0]!;
  await assert.rejects(
    pool().query(
      `INSERT INTO social_attribution_attachments
         (attachment_id, attribution_reference_id, agency_id, client_id, workspace_id,
          carrier_kind, carrier_ref, original_content_ref, carried_content_refs, reason,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'content_transformation', 'cpd-dropped-original-probe',
               'ca:apron:1', $6::jsonb, 'the dropped-original chain',
               'probe', 'probe', 'probe-sca', NULL, now())`,
      [
        '11111111-1111-4111-8111-111111111111',
        mintedReferenceId,
        row['agency_id'],
        row['client_id'],
        row['workspace_id'],
        JSON.stringify(['ca:apron:2']),
      ],
    ),
    (error: unknown) => {
      // The CHECK fence rejects the row (a check_violation).
      assert.equal((error as { code?: string }).code, '23514');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (d) The append-only DB backstops
// ---------------------------------------------------------------------------

test('MKT-073 (d): the append-only DB backstops — UPDATE/DELETE rejected on the four families; the reference identity is immutable', async () => {
  // The constructions reject UPDATE.
  await assert.rejects(
    pool().query(
      'UPDATE social_attribution_link_constructions SET constructed_link = $1 WHERE link_construction_id = $2',
      ['https://fabricated.example.test/', constructionId],
    ),
    (error: unknown) => {
      assert.ok(
        String((error as Error).message).includes('append-only'),
        `the append-only trigger rejects the UPDATE (got: ${(error as Error).message})`,
      );
      return true;
    },
  );
  // The outcomes reject DELETE.
  await assert.rejects(
    pool().query('DELETE FROM social_attribution_outcomes WHERE attribution_outcome_id = $1', [outcomeId]),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('never rewritten'));
      return true;
    },
  );
  // The reference identity/scope/citation is immutable (a sideways
  // UPDATE is rejected by the guard; only the retirement advance is
  // legal — proven by the module below).
  await assert.rejects(
    pool().query(
      'UPDATE social_attribution_references SET purpose = $1 WHERE attribution_reference_id = $2',
      ['a silently rewritten purpose', mintedReferenceId],
    ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('immutable'));
      return true;
    },
  );
  // The conversion events reject UPDATE.
  await assert.rejects(
    pool().query(
      'UPDATE social_attribution_conversion_events SET observed_fields = \'{"fabricated": "fields"}\'::jsonb WHERE conversion_event_id = $1',
      [orderConversionEventId],
    ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('append-only'));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (e) THE 23514 PROBE — the causal-separation discipline at the DB level
// ---------------------------------------------------------------------------

test('MKT-073 (e): THE 23514 PROBE — a causal-claiming outcome row is INEXPRESSIBLE (the co_occurrence_note CHECK fence over a valid FK chain)', async () => {
  // A valid FK chain: the REAL conversion event, reference and
  // construction rows from the golden path — ONLY the note differs.
  const scope = await pool().query(
    `SELECT r.agency_id, r.client_id, r.workspace_id
       FROM social_attribution_references r
      WHERE r.attribution_reference_id = $1`,
    [mintedReferenceId],
  );
  const row = scope.rows[0]!;
  await assert.rejects(
    pool().query(
      `INSERT INTO social_attribution_outcomes
         (attribution_outcome_id, conversion_event_id, attribution_reference_id,
          link_construction_id, agency_id, client_id, workspace_id,
          mechanism, matched_field, matched_value, match_provenance,
          co_occurrence_note, flowback_citation,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               'utm_parameters', 'attributionRef', $8, '{"probe": true}'::jsonb,
               'the campaign CAUSED the order', '{"probe": true}'::jsonb,
               'probe', 'probe', 'probe-sca', NULL, now())`,
      [
        '22222222-2222-4222-8222-222222222222',
        orderConversionEventId,
        mintedReferenceId,
        constructionId,
        row['agency_id'],
        row['client_id'],
        row['workspace_id'],
        mintedAttributionRef,
      ],
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, '23514');
      assert.ok(
        String((error as Error).message).includes('co_occurrence_note'),
        'the failing CHECK is the co-occurrence-note fence',
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (f) The no-verified-match 409
// ---------------------------------------------------------------------------

test('MKT-073 (f): the no-verified-match 409 — the co-occurrence is NOT evidenced (the outcome row stays inexpressible; never a caller-asserted match)', async () => {
  // A first-party store visit carrying NO reference fields.
  const visit = await sca().recordFirstPartyConversionEvent(
    {
      pursuitWorkspaceId: aliceWorkspaceId,
      conversionKind: 'store_visit',
      subjectRef: 'session-no-ref',
      occurredAt: '2026-10-06T12:00:00.000Z',
      observedFields: { landingRoute: '/products/apron', utmSource: 'tiktok' },
    },
    PROVENANCE,
  );
  assert.equal(visit.conversionKind, 'store_visit');
  assert.equal(visit.eventSource, 'first_party_event');
  assert.equal(visit.commerceEventId, null);
  // NO verified match → the honest 409 (the co-occurrence is NOT
  // evidenced).
  await assert.rejects(
    sca().recordAttributionOutcome(
      {
        conversionEventId: visit.conversionEventId,
        attributionReferenceId: mintedReferenceId,
      },
      PROVENANCE,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.ok(String((error as Error).message).includes('NOT evidenced'));
      return true;
    },
  );
  // No outcome row exists for the visit.
  const outcomes = await sca().listAttributionOutcomesForReference(mintedReferenceId);
  assert.equal(outcomes!.length, 1, 'only the golden-path outcome exists');
});

// ---------------------------------------------------------------------------
// (g) The first-party conversion events + the order-truth fence
// ---------------------------------------------------------------------------

test('MKT-073 (g): the first-party conversion matching through the MECHANISM-SPECIFIC utmContent field + THE ORDER-TRUTH FENCE (orders come from the real commerce boundary ONLY)', async () => {
  // A store visit whose observed fields carry the constructed link's
  // match contract (utmContent = the stable id) — the mechanism-specific
  // match path.
  const visit = await sca().recordFirstPartyConversionEvent(
    {
      pursuitWorkspaceId: aliceWorkspaceId,
      conversionKind: 'store_visit',
      subjectRef: 'session-9f2',
      occurredAt: '2026-10-06T12:30:00.000Z',
      observedFields: { utmContent: mintedAttributionRef, utmSource: 'tiktok' },
    },
    PROVENANCE,
  );
  storeVisitConversionId = visit.conversionEventId;
  const outcome = await sca().recordAttributionOutcome(
    {
      conversionEventId: storeVisitConversionId,
      attributionReferenceId: mintedReferenceId,
    },
    PROVENANCE,
  );
  assert.equal(outcome.matchedField, 'utmContent');
  assert.equal(outcome.matchedValue, mintedAttributionRef);
  assert.equal((outcome.matchProvenance as Record<string, unknown>)['observedBy'], 'first_party_event');

  // THE ORDER-TRUTH FENCE at the guard: an 'order' kind is honestly
  // refused on the first-party channel.
  await assert.rejects(
    sca().recordFirstPartyConversionEvent(
      {
        pursuitWorkspaceId: aliceWorkspaceId,
        conversionKind: 'order' as never,
        observedFields: { attributionRef: mintedAttributionRef },
      },
      PROVENANCE,
    ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(String((error as Error).message).includes('order-truth fence'));
      return true;
    },
  );

  // THE ORDER-TRUTH FENCE at the commerce boundary: a NON-ORDER commerce
  // event cannot back an order conversion (the real webhook ingests a
  // product.updated event for the same store).
  const productPayload = {
    eventId: 'evt_sca_7002',
    kind: 'product.updated',
    occurredAt: '2026-10-06T12:45:00.000Z',
    product: { id: 'prd_501', title: 'Tactical Apron', status: 'active' },
  };
  const delivered = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/connections/${storeConnectionId}/webhook`,
    {
      token: alice.token,
      body: {
        eventType: 'product.updated',
        payload: productPayload,
        headers: commerceWebhookSignature(COMMERCE_WEBHOOK_SECRET, productPayload),
      },
    },
  );
  assert.equal(delivered.status, 201, JSON.stringify(delivered.body));
  const productEventId = (delivered.body['commerceEvent'] as Record<string, unknown>)['commerceEventId'] as string;
  await assert.rejects(
    sca().recordOrderConversionEvent(
      {
        pursuitWorkspaceId: aliceWorkspaceId,
        commerceEventId: productEventId,
      },
      PROVENANCE,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.ok(String((error as Error).message).includes('order-kind commerce event only'));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (h) The uniform 404s + tenant isolation
// ---------------------------------------------------------------------------

test('MKT-073 (h): the uniform 404s + tenant isolation (unknown/foreign mission, workspace, reference — no existence oracle)', async () => {
  // An unknown mission is the uniform 404.
  await assert.rejects(
    sca().createAttributionReference(
      referenceInput({ missionId: '33333333-3333-4333-8333-333333333333' }),
      PROVENANCE,
    ),
    NotFoundError,
  );
  // An unknown workspace is the uniform 404.
  await assert.rejects(
    sca().createAttributionReference(
      referenceInput({ pursuitWorkspaceId: '44444444-4444-4444-8444-444444444444' }),
      PROVENANCE,
    ),
    NotFoundError,
  );
  // A workspace of ANOTHER agency than the mission is the uniform 404
  // (a foreign pursuit scope is not a traversal oracle).
  const bobWorkspace = await apiCall(port(), `/api/clients/${bobClientId}/workspaces`, {
    token: bob.token,
    body: { name: `Bob Pursuit ${bobClientId.slice(0, 8)}` },
  });
  assert.equal(bobWorkspace.status, 201);
  await assert.rejects(
    sca().createAttributionReference(
      referenceInput({ pursuitWorkspaceId: bobWorkspace.body['workspaceId'] as string }),
      PROVENANCE,
    ),
    NotFoundError,
  );
  // An unknown reference resolves to null (the append-only history is
  // readable, the unknown is null — never an oracle).
  assert.equal(await sca().getAttributionReference('55555555-5555-4555-8555-555555555555'), null);
  assert.equal(await sca().listLinkConstructionsForReference('55555555-5555-4555-8555-555555555555'), null);
  // A commerce event of ANOTHER client cannot back a conversion (the
  // real order through BOB's store connection).
  const bobOrderPayload = {
    eventId: 'evt_sca_7101',
    kind: 'order.created',
    occurredAt: '2026-10-06T13:00:00.000Z',
    order: {
      id: 'ord_sca_2101',
      status: 'paid',
      currency: 'USD',
      total: '10.00',
      lineItems: [{ productId: 'prd_501', quantity: 1, unitPrice: '10.00' }],
      attribution: { attributionRef: mintedAttributionRef },
    },
  };
  const bobDelivered = await apiCall(
    port(),
    `/api/clients/${bobClientId}/connections/${bobConnectionId}/webhook`,
    {
      token: bob.token,
      body: {
        eventType: 'order.created',
        payload: bobOrderPayload,
        headers: commerceWebhookSignature(COMMERCE_WEBHOOK_SECRET, bobOrderPayload),
      },
    },
  );
  assert.equal(bobDelivered.status, 201, JSON.stringify(bobDelivered.body));
  const bobCommerceEventId = (bobDelivered.body['commerceEvent'] as Record<string, unknown>)['commerceEventId'] as string;
  await assert.rejects(
    sca().recordOrderConversionEvent(
      {
        pursuitWorkspaceId: aliceWorkspaceId,
        commerceEventId: bobCommerceEventId,
      },
      PROVENANCE,
    ),
    NotFoundError,
  );
  // Tenant isolation on the client-scoped reads: Bob sees nothing.
  assert.deepEqual(await sca().listConversionEventsForClient(bobClientId), []);
  assert.deepEqual(await sca().listAttributionOutcomeReadModel(bobClientId), []);
  assert.deepEqual(await sca().listAttributionReferencesForClient(bobClientId), []);
});

// ---------------------------------------------------------------------------
// (i) The retirement advance
// ---------------------------------------------------------------------------

test('MKT-073 (i): the retirement advance is single-shot (a retired reference accepts no new linkage; the history stays readable)', async () => {
  const retired = await sca().retireAttributionReference(
    {
      attributionReferenceId: mintedReferenceId,
      reason: 'the experiment concluded — the reference is retired',
    },
    PROVENANCE,
  );
  assert.equal(retired.status, 'retired');
  assert.ok(retired.retiredReason !== null);
  // The advance is SINGLE-SHOT (a second attempt is an honest 409).
  await assert.rejects(
    sca().retireAttributionReference(
      {
        attributionReferenceId: mintedReferenceId,
        reason: 'a second attempt',
      },
      PROVENANCE,
    ),
    ConflictError,
  );
  // A retired reference accepts NO new linkage (the construction and
  // the attachment are refused — history stays readable).
  await assert.rejects(
    sca().constructAttributionLink(
      {
        attributionReferenceId: mintedReferenceId,
        construction: {
          mechanism: 'utm_parameters',
          attributionRef: mintedAttributionRef,
          missionId,
          baseUrl: 'https://store.example.test/products/apron',
        },
      },
      PROVENANCE,
    ),
    ConflictError,
  );
  await assert.rejects(
    sca().recordAttributionAttachment(
      {
        attributionReferenceId: mintedReferenceId,
        carrierKind: 'content_transformation',
        carrierRef: 'cpd-destination-transform-46',
        originalContentRef: 'ca:apron:1',
        carriedContentRefs: ['ca:apron:1', 'ca:apron:4'],
        reason: 'the post-retirement attachment attempt',
      },
      PROVENANCE,
    ),
    ConflictError,
  );
  // The history + outcomes stay readable.
  const reference = await sca().getAttributionReference(mintedReferenceId);
  assert.equal(reference!.status, 'retired');
  const attachments = await sca().listAttachmentsForReference(mintedReferenceId);
  assert.equal(attachments!.length, 2);
  const outcomes = await sca().listAttributionOutcomesForReference(mintedReferenceId);
  assert.ok(outcomes!.length >= 2);
});

// ---------------------------------------------------------------------------
// (j) The honest 'unavailable' mechanism
// ---------------------------------------------------------------------------

test('MKT-073 (j): the honest unavailable mechanism — a platform that offers no attribution mechanism builds nothing (the 409 + the DB double fence; never a fabricated link)', async () => {
  const unavailable = await sca().createAttributionReference(
    referenceInput({
      mechanism: 'unavailable' as const,
      purpose: 'the platform offers no attribution mechanism for this action',
      creationContext: { contentRef: 'ca:apron:9' },
    }),
    PROVENANCE,
  );
  assert.equal(unavailable.mechanism, 'unavailable');
  assert.equal(unavailable.status, 'active');
  assert.match(unavailable.attributionRef, SOCIAL_ATTRIBUTION_REF_PATTERN);
  // The module refuses to construct a link on it — the honest 409
  // (never a fabricated link).
  await assert.rejects(
    sca().constructAttributionLink(
      {
        attributionReferenceId: unavailable.attributionReferenceId,
        construction: {
          mechanism: 'unavailable' as never,
          attributionRef: unavailable.attributionRef,
          missionId,
        },
      },
      PROVENANCE,
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.ok(String((error as Error).message).includes('UNAVAILABLE'));
      return true;
    },
  );
  // The DB double fence: a direct INSERT of a construction on the
  // unavailable reference is rejected by the trigger.
  const scope = await pool().query(
    'SELECT agency_id, client_id, workspace_id FROM social_attribution_references WHERE attribution_reference_id = $1',
    [unavailable.attributionReferenceId],
  );
  const row = scope.rows[0]!;
  await assert.rejects(
    pool().query(
      `INSERT INTO social_attribution_link_constructions
         (link_construction_id, attribution_reference_id, agency_id, client_id, workspace_id,
          construction_version, mechanism, construction_input, input_digest,
          constructed_link, match_field, match_value,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'sca-link-v1', 'unavailable',
               '{}'::jsonb, $6, 'never-built', 'attributionRef', 'never-built',
               'probe', 'probe', 'probe-sca', NULL, now())`,
      [
        '66666666-6666-4666-8666-666666666666',
        unavailable.attributionReferenceId,
        row['agency_id'],
        row['client_id'],
        row['workspace_id'],
        '0'.repeat(64),
      ],
    ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('UNAVAILABLE'));
      return true;
    },
  );
});
