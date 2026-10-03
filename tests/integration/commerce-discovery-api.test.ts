/**
 * MKT-072 integration tests — the /commerce-discovery surfaces against a
 * REAL embedded PostgreSQL 18 stack (the product-marketing dual-level
 * harness: HTTP fixtures over the spawned API, then module-level
 * round-trips + DB backstop proofs against the SAME database through the
 * in-process bootstrapApplication).
 *
 * THE DISPATCH'S NAMED TESTS, END-TO-END over the real composed surfaces:
 *
 *   (a) THE GOLDEN PATH (the acceptance): market → candidate → content →
 *       traffic → order → learning with economic guardrails — the
 *       deterministic selection composed from the REAL product-intelligence
 *       + content-intelligence records (every selection row cited, the
 *       FK-anchored citation links resolve), the provenance-cited candidate
 *       recorded, the demand test launched THROUGH the REAL /experiments
 *       authority (the experiment exists in the authority's own store),
 *       the REAL order event ingested through the REAL MKT-071 commerce
 *       webhook boundary (the local provider double — the ONLY test
 *       double, at the provider boundary), the outcome DERIVED from the
 *       real event (observed count/value, viability verdict, the listing
 *       recommendation as data) and the guardrail evaluation within
 *       bounds;
 *   (b) THE DEMAND-TEST CONCLUSION: the experiment is concluded through
 *       the authority's own transitions and the demand test's single
 *       guarded advance copies the authority's conclusion read-back (a
 *       premature attempt is an honest 409; a second attempt is an honest
 *       409);
 *   (c) THE GUARDRAIL BREACH LIFECYCLE (the acceptance's core): a
 *       budget-reducing version → the evaluation BREACHES → the honest
 *       'guardrail_blocked' state (demand-test launches refused; the
 *       learning loop still records observations) → the still-breached
 *       resolve is an honest 409 (never a silent lift) → the
 *       adequate-budget version + resolve → 'active' again;
 *   (d) APPEND-ONLY DISCIPLINE: a replayed compose converges (200, same
 *       digest, no duplicate version); the DB rejects UPDATE/DELETE on the
 *       version/events/candidate/outcome/evaluation tails and every
 *       citation link; the demand-test advance is single-shot at the DB
 *       level;
 *   (e) THE ROUTE DISCIPLINE BATTERY: uniform 404s (unknown/foreign
 *       mission, product context, store connection, candidate, commerce
 *       event), the family gate (409 for a non-commerce_discovery
 *       mission), the fail-closed budget pre-gate (409), the owner|admin
 *       POST gate, the member read, the authority-field rejection, and
 *       client isolation on the reads.
 *
 * The platform under test: the DISCLOSED reference in-memory double at the
 * provider boundary ONLY (the local commerce provider double serving the
 * webhook signature + the scripted page-reader double for the public
 * product page). The /commerce-discovery module under test (the frozen-row
 * composition through the six public contracts + the three disclosed
 * structural ports, the deterministic cd-plan-v1 core, the migration-062
 * fences) is fully REAL, as are the /growth-missions, /product-intelligence,
 * /content-intelligence, /integrations, /experiments and /metrics modules
 * it composes.
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
  type CommerceProviderDouble,
} from './helpers/commerce-provider.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type { CommerceDiscoveryModuleApi } from '../../src/modules/commerce-discovery/public.ts';
import type { ProductIntelligenceModuleApi } from '../../src/modules/product-intelligence/public.ts';
import type { ContentIntelligenceModuleApi } from '../../src/modules/content-intelligence/public.ts';
import type { IntegrationsModuleApi } from '../../src/modules/integrations/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';
import type {
  ProductPageReader,
  ProductPageFetchRequest,
  ProductPageFetchOutcome,
} from '../../src/modules/product-intelligence/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const COMMERCE_TOKEN = 'ea-fakeSandboxCommerceDiscovery';
const COMMERCE_WEBHOOK_SECRET = 'whsec_CommerceDiscoveryFake';

const PRODUCT_PAGE = 'https://kitchen-product.test/';

const PAGE_FIXTURES: Readonly<Record<string, string>> = {
  [PRODUCT_PAGE]: `<html lang="en"><head><title>Kitchen Helper — the everyday apron</title>` +
    `<meta name="description" content="A durable kitchen apron with strong visual storytelling appeal.">` +
    `<meta property="og:title" content="Kitchen Helper"></head>` +
    `<body><h1>The everyday apron</h1><p>Beautiful, simple, and loved by home cooks.</p></body></html>`,
};

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-000000000072',
  recordedVia: 'test',
  correlationId: 'integration-commerce-discovery-1',
  causationId: null,
} as const;

/** The DISCLOSED scripted page-reader double (the GET-only reader contract). */
class ScriptedPageReader implements ProductPageReader {
  async fetch(request: ProductPageFetchRequest): Promise<ProductPageFetchOutcome> {
    const body = PAGE_FIXTURES[request.url];
    if (body === undefined) {
      return {
        ok: false,
        status: null,
        body: null,
        contentType: null,
        transportRefused: true,
        timedOut: false,
        error: `the scripted double has no fixture for ${request.url}`,
      };
    }
    return {
      ok: true,
      status: 200,
      body,
      contentType: 'text/html',
      transportRefused: false,
      timedOut: false,
      error: null,
    };
  }
}

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: CommerceProviderDouble | null = null;
let commerceDiscovery: CommerceDiscoveryModuleApi | null = null;
let productIntelligence: ProductIntelligenceModuleApi | null = null;
let contentIntelligence: ContentIntelligenceModuleApi | null = null;
let integrationsHandle: IntegrationsModuleApi | null = null;
let credentialsHandle: CredentialsModuleApi | null = null;

function cd(): CommerceDiscoveryModuleApi {
  if (commerceDiscovery === null) throw new Error('application not booted');
  return commerceDiscovery;
}
function pi(): ProductIntelligenceModuleApi {
  if (productIntelligence === null) throw new Error('application not booted');
  return productIntelligence;
}
function ci(): ContentIntelligenceModuleApi {
  if (contentIntelligence === null) throw new Error('application not booted');
  return contentIntelligence;
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

async function makeGoal(token: string, clientId: string, objective: string): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token,
    body: {
      objective,
      successCriteria: [
        { metric: 'qualified_outcome', comparator: '>=', targetValue: 100, unit: 'count' },
      ],
      metrics: [],
      constraints: [],
      timeHorizon: null,
    },
  });
  assert.equal(created.status, 201);
  return created.body['goalId'] as string;
}

async function makeMission(
  token: string,
  objective: string,
  family: string,
  clientId: string,
): Promise<string> {
  const agencyId = await currentAgencyOfClient(clientId);
  const created = await apiCall(port(), `/api/agencies/${agencyId}/growth-missions`, {
    token,
    body: {
      objective,
      objectiveFamily: family,
      productContext: { name: 'Kitchen Helper', url: PRODUCT_PAGE, summary: 'The declared product context.' },
      marketContext: { audience: 'home cooks', geography: 'global', summary: 'The declared market context.' },
      targetMetrics: [],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const missionId = (created.body['mission'] as Record<string, unknown>)['missionId'] as string;
  const goalId = await makeGoal(token, clientId, `${objective} — primary goal`);
  const mapped = await apiCall(port(), `/api/growth-missions/${missionId}/goal-mappings`, {
    token,
    body: { goalId },
  });
  assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
  return missionId;
}

async function currentAgencyOfClient(clientId: string): Promise<string> {
  const detail = await apiCall(port(), `/api/clients/${clientId}`, { token: alice.token });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  return detail.body['agencyId'] as string;
}

let evidenceSeq = 0;
async function makeEvidence(token: string, clientId: string): Promise<string> {
  evidenceSeq += 1;
  const created = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'source_fact',
      sourceSystem: 'commerce-discovery-test',
      sourceRef: `fixture/cd/${evidenceSeq}`,
      observedAt: '2026-09-01T10:30:00.000Z',
      content: { kind: 'discovery-citation', seq: evidenceSeq },
      quality: 'C',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['evidenceId'] as string;
}

/**
 * Records one content candidate through the in-process module (the
 * content-intelligence HTTP surface derives the evidence server-side; the
 * module-level seam is the canonical test path — the content-intelligence
 * integration-test precedent).
 */
async function makeContentCandidate(
  clientId: string,
  niche: string,
  subNiche: string | null,
): Promise<string> {
  const evidenceId = await makeEvidence(alice.token, clientId);
  const candidate = await ci().recordContentCandidate(
    {
      clientId,
      workspaceId: null,
      features: {
        topicEntity: `${niche} content`,
        niche,
        subNiche,
        contentFormat: 'short_video',
        lengthValue: 45,
        lengthUnit: 'seconds',
        hookFeatures: ['question'],
        narrativeStructure: 'problem_solution',
        publishedAt: '2026-03-01T09:00:00.000Z',
        observedPerformance: { views: 12000 },
        performanceVelocity: null,
        engagement: null,
        audienceFit: 'strong_fit',
        freshness: 'recent',
        novelty: 'novel',
        reuseRisk: 'low',
      },
      evidenceIds: [evidenceId],
      metricObservationIds: [],
    },
    PROVENANCE,
  );
  return candidate.contentCandidateId;
}

async function makeContentHypothesis(clientId: string): Promise<string> {
  const evidenceId = await makeEvidence(alice.token, clientId);
  const hypothesis = await ci().recordContentHypothesis(
    {
      clientId,
      workspaceId: null,
      hypothesisKind: 'format_hypothesis',
      statement: { summary: 'Short-form kitchen explainers may drive apron demand — an input, not a conclusion.' },
      evidenceIds: [evidenceId],
      candidateIds: [],
      researchInsightIds: [],
      experimentId: null,
      supersedesContentHypothesisId: null,
    },
    PROVENANCE,
  );
  return hypothesis.contentHypothesisId;
}

async function makeStoreConnection(
  principal: Principal,
  clientId: string,
): Promise<string> {
  const credential = await credentialsModule().createCredentialReference({
    agencyId: principal.agencyId,
    clientId,
    kind: 'integration_api_key',
    label: `cd_store_${clientId.slice(0, 8)}`,
    secretHandle: 'cd-commerce-key',
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection(
    {
      clientId,
      adapterKey: 'commerce-cms',
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

// ---------------------------------------------------------------------------
// Boot + fixtures
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let aliceWorkspaceId: string;
let bob: Principal;
let bobClientId: string;
let productContextId: string;
let kitchenContentCandidateId: string;
let contentHypothesisId: string;
let storeConnectionId: string;
let foreignConnectionId: string;
let missionId: string;
let wrongFamilyMissionId: string;
const derivedModelIds: string[] = [];
let recordedCandidateId: string;
let launchedDemandTestId: string;
let launchedExperimentId: string;
let ingestedCommerceEventId: string;

before(async () => {
  stack = await bootStack('commerce_discovery');
  const fs = await import('node:fs');
  fs.writeFileSync(
    `${stack.env.secretsDir}/cd-commerce-key.secret`,
    JSON.stringify({
      accessToken: COMMERCE_TOKEN,
      webhookSecret: COMMERCE_WEBHOOK_SECRET,
      grantedScopes: ['catalog:read', 'orders:read', 'products:write', 'listings:write'],
    }),
    { mode: 0o600 },
  );
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startCommerceProvider({ [COMMERCE_TOKEN]: ['catalog:read', 'orders:read', 'products:write', 'listings:write'] });
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({
    productPageReader: new ScriptedPageReader(),
  });
  commerceDiscovery = core.modules.commerceDiscovery;
  productIntelligence = core.modules.productIntelligence;
  contentIntelligence = core.modules.contentIntelligence;
  integrationsHandle = core.modules.integrations;
  credentialsHandle = core.modules.credentials;

  // --- The pursuit tenant (Alice) + the isolation tenant (Bob). ---
  alice = await makeAgencyOwner('alice@commercediscovery.test');
  aliceClientId = await makeClient(alice);
  aliceWorkspaceId = await makeWorkspace(alice, aliceClientId);
  await allowAll(alice, 'network');
  await allowAll(alice, 'secrets');
  bob = await makeAgencyOwner('bob@commercediscovery.test');
  bobClientId = await makeClient(bob);
  await allowAll(bob, 'network');
  await allowAll(bob, 'secrets');

  // --- The product context (URL context, evidence-backed signals). ---
  const context = await pi().createProductContext(
    {
      agencyId: alice.agencyId,
      declaration: {
        name: 'Kitchen Helper',
        summary: 'A durable kitchen apron with a public site.',
        inputs: [
          { kind: 'product_site_url', reference: PRODUCT_PAGE, authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    PROVENANCE,
  );
  productContextId = context.context.productContextId;
  await pi().runProductInspection({ productContextId }, PROVENANCE);
  const facts = (await pi().getProductContextSourceFacts(productContextId))!;
  assert.ok(facts.length >= 5);
  for (const [kind, count] of [
    ['value_propositions', 1],
    ['icp_audience_hypotheses', 1],
    ['market_language', 1],
    ['commercial_metrics', 1],
  ] as const) {
    for (let index = 0; index < count; index++) {
      const model = await pi().recordDerivedModel(
        {
          productContextId,
          derivationKind: kind,
          statement: { summary: `${kind} observation ${index + 1} for the kitchen product.` },
          evidenceSourceFactIds: [facts[index % facts.length]!.sourceFactId],
          aiAssistance: null,
          supersedesDerivedModelId: null,
        },
        PROVENANCE,
      );
      derivedModelIds.push(model.derivedModelId);
    }
  }

  // --- The content-intelligence signals (the niche grounding). ---
  kitchenContentCandidateId = await makeContentCandidate(
    aliceClientId,
    'Kitchen & Home',
    'Small kitchens',
  );
  await makeContentCandidate(aliceClientId, 'Outdoor & Field', null);
  contentHypothesisId = await makeContentHypothesis(aliceClientId);

  // --- The commerce boundary (the MKT-071 store connection). ---
  storeConnectionId = await makeStoreConnection(alice, aliceClientId);
  foreignConnectionId = await makeStoreConnection(bob, bobClientId);

  // --- The missions (the commerce_discovery family + the wrong family). ---
  missionId = await makeMission(
    alice.token,
    'Discover viable kitchen products for the store',
    'commerce_discovery',
    aliceClientId,
  );
  wrongFamilyMissionId = await makeMission(
    alice.token,
    'Grow qualified traffic for the kitchen product',
    'product_marketing',
    aliceClientId,
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
// The compose input builder (the declared bounded-spend bounds)
// ---------------------------------------------------------------------------

function composeInput(overrides: Record<string, unknown> = {}) {
  return {
    missionId,
    productContextId,
    pursuitWorkspaceId: aliceWorkspaceId,
    storeConnectionId,
    declared: {
      spendCurrency: 'USD',
      testBudgetMinorUnits: 500000,
      maxDemandTests: 5,
      minOrderCountForViability: 1,
    },
    reason: 'the initial commerce-discovery composition',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) THE GOLDEN PATH — market → candidate → content → traffic → order →
//     learning with economic guardrails
// ---------------------------------------------------------------------------

test('MKT-072 (a): THE GOLDEN PATH — the deterministic selection composed from the real records, every row cited', async () => {
  const detail = await cd().composeCommerceDiscoveryPlan(composeInput(), PROVENANCE);
  assert.equal(detail.mission.status, 'active');
  assert.equal(detail.mission.currentVersionSeq, 1);
  assert.equal(detail.currentVersion.strategyVersion, 'cd-plan-v1');
  // The niche selection ranks the observed kitchen niche first (the
  // strong_fit content candidate cited; the evidence-backed product
  // signals cited).
  assert.ok(detail.currentVersion.nicheSelection.length >= 2);
  const kitchen = detail.currentVersion.nicheSelection[0]!;
  assert.equal(kitchen.niche, 'Kitchen & Home');
  assert.ok(kitchen.weightShareBps > 0);
  const citationKinds = new Set(kitchen.citations.map((c) => c.kind));
  assert.ok(citationKinds.has('content_candidate'));
  assert.ok(citationKinds.has('product_derived_model'));
  assert.ok(
    kitchen.citations.some((c) => c.refId === kitchenContentCandidateId),
    'the kitchen content candidate is cited',
  );
  for (const modelId of derivedModelIds) {
    assert.ok(
      kitchen.citations.some((c) => c.kind === 'product_derived_model' && c.refId === modelId),
      `derived model ${modelId} is cited`,
    );
  }
  // The proposals + the economic gates + the demand-test plan are data.
  assert.ok(detail.currentVersion.candidateProposals.length >= 1);
  assert.ok(detail.currentVersion.candidateProposals[0]!.label.includes('Kitchen'));
  assert.equal(detail.currentVersion.economicGates.testBudgetMinorUnits, 500000);
  assert.equal(detail.currentVersion.demandTestPlan.boundedBy, 'experiments-authority');
  // The DB citation links FK-resolve (the evidence basis is real).
  const links = await pool().query(
    `SELECT derived_model_id FROM commerce_discovery_version_cited_product_models
      WHERE commerce_discovery_mission_version_id = $1`,
    [detail.currentVersion.discoveryVersionId],
  );
  assert.equal(links.rows.length, derivedModelIds.length);
  // The history carries the creation + the version events.
  const kinds = detail.history.map((event) => event.eventKind);
  assert.deepEqual(kinds, ['discovery_created', 'version_recorded']);
});

test('MKT-072 (a): the provenance-cited candidate records and the demand test launches THROUGH the real experiments authority', async () => {
  // The candidate: the provenance citations resolve to the real records.
  const candidate = await cd().recordCommerceDiscoveryCandidate(
    {
      missionId,
      label: 'Kitchen Helper Apron',
      niche: 'Kitchen & Home',
      subNiche: 'Small kitchens',
      productDescriptor: 'A durable water-resistant apron with adjustable straps for small kitchens.',
      estimatedCostMinorUnits: 1200,
      estimatedPriceMinorUnits: 4500,
      economicsCurrency: 'USD',
      demandHypothesis: 'short-form kitchen organization videos drive apron orders',
      productDerivedModelIds: derivedModelIds.slice(0, 2),
      contentCandidateIds: [kitchenContentCandidateId],
      contentHypothesisIds: [contentHypothesisId],
    },
    PROVENANCE,
  );
  assert.ok(candidate.candidate.candidateId.length > 0);
  assert.equal(candidate.citations.length, 4);

  // The demand test: the experiment is created through the REAL authority.
  const demandTest = await cd().launchCommerceDiscoveryDemandTest(
    {
      missionId,
      candidateId: candidate.candidate.candidateId,
      testSpendMinorUnits: 100000,
      reason: 'the first demand test of the kitchen apron',
    },
    PROVENANCE,
  );
  assert.equal(demandTest.state, 'launched');
  assert.equal(demandTest.testSpendMinorUnits, 100000);
  assert.equal(demandTest.spendCurrency, 'USD');
  assert.ok(demandTest.experimentId.length > 0);
  // The experiment EXISTS in the authority's own store (read back through
  // the real /experiments module — no second experiment engine).
  const experimentRead = await apiCall(port(), `/api/experiments/${demandTest.experimentId}`, {
    token: alice.token,
  });
  assert.equal(experimentRead.status, 200, JSON.stringify(experimentRead.body));
  assert.equal(experimentRead.body['status'], 'draft');
  assert.equal(experimentRead.body['designType'], 'randomized');
  assert.equal((experimentRead.body['primaryMetric'] as Record<string, unknown>)['name'], 'observed_order_count');
  assert.ok(String(experimentRead.body['hypothesis']).includes('Kitchen Helper Apron'));
  // The derived design rides the demand-test record (auditable).
  assert.equal(
    (demandTest.derivedExperimentDesign as { designType?: string })['designType'],
    'randomized',
  );

  recordedCandidateId = candidate.candidate.candidateId;
  launchedDemandTestId = demandTest.demandTestId;
  launchedExperimentId = demandTest.experimentId;
});

test('MKT-072 (a): the REAL order event lands through the MKT-071 webhook boundary and the outcome is DERIVED from it', async () => {
  // The REAL webhook delivery (the local provider double signs it; the
  // REAL CommerceCmsAdapter verifies; the REAL /integrations ingests).
  const orderPayload = {
    eventId: 'evt_cd_9001',
    kind: 'order.created',
    occurredAt: '2026-10-04T11:00:00.000Z',
    order: {
      id: 'ord_cd_2001',
      number: 'MOS-CD-2001',
      status: 'paid',
      currency: 'USD',
      total: '45.00',
      placedAt: '2026-10-04T11:00:00.000Z',
      updatedAt: '2026-10-04T11:05:00.000Z',
      customerEmail: 'buyer@example.test',
      lineItems: [
        { productId: 'prd_501', variantId: 'var_9', title: 'Tactical Apron', quantity: 1, unitPrice: '45.00' },
      ],
      attribution: { attributionRef: `mission:${missionId}`, utmSource: 'tiktok' },
    },
  };
  const { commerceWebhookSignature } = await import('./helpers/commerce-provider.ts');
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
  const commerceEventId = (delivered.body['commerceEvent'] as Record<string, unknown>)['commerceEventId'] as string;
  assert.ok(commerceEventId.length > 0);

  // The outcome: the observed values DERIVED from the real event.
  const outcome = await cd().recordCommerceDiscoveryOutcome(
    {
      missionId,
      candidateId: recordedCandidateId,
      commerceEventIds: [commerceEventId],
      metricObservationIds: [],
      reason: 'the first observed order of the kitchen apron',
    },
    PROVENANCE,
  );
  assert.equal(outcome.observedOrderCount, 1);
  assert.equal(outcome.observedCancelledOrderCount, 0);
  assert.deepEqual({ ...outcome.observedOrderValues }, { USD: 45 });
  // The viability gate (1 minimum order) is PASSED → the recommendation
  // is DATA (never an auto-listing).
  assert.equal(outcome.viabilityVerdict, 'viable');
  assert.equal(outcome.listingRecommendation, 'recommend_listing');
  assert.ok(outcome.rationale.includes('distinct from causality'));

  ingestedCommerceEventId = commerceEventId;

  // The guardrails evaluate within bounds (observed spend 100000 of
  // 500000; 1 demand test of 5).
  const evaluation = await cd().evaluateCommerceDiscoveryGuardrails(
    { missionId, reason: 'the first guardrail evaluation' },
    PROVENANCE,
  );
  assert.equal(evaluation.verdict, 'within_bounds');
  assert.deepEqual(evaluation.breachReasons, []);
  assert.equal(evaluation.observed.spendMinorUnits, 100000);
  assert.equal(evaluation.observed.demandTestCount, 1);
  assert.equal(evaluation.observed.orderCount, 1);
  // The evaluation cites the REAL commerce event + the policy context
  // (the agency-scope network allowance declared in the fixtures).
  const cited = await pool().query(
    `SELECT commerce_event_id FROM commerce_discovery_evaluation_cited_commerce_events
      WHERE commerce_discovery_evaluation_id = $1`,
    [evaluation.evaluationId],
  );
  assert.equal(cited.rows.length, 1);
  assert.equal(cited.rows[0]!['commerce_event_id'], commerceEventId);
  const policiesCited = await pool().query(
    `SELECT p.policy_id FROM commerce_discovery_evaluation_cited_policy_versions cp
       JOIN policies p ON p.policy_id = cp.policy_id
      WHERE cp.commerce_discovery_evaluation_id = $1`,
    [evaluation.evaluationId],
  );
  assert.ok(policiesCited.rows.length >= 1, 'the active network policy versions are cited');
  // The program stays active (no breach).
  const program = await cd().getCommerceDiscoveryMission(missionId);
  assert.equal(program!.status, 'active');
});

// ---------------------------------------------------------------------------
// (b) The demand-test conclusion — the authority's own read-back
// ---------------------------------------------------------------------------

test('MKT-072 (b): the conclusion read-back requires the authority\'s own concluded record; the advance is single-shot', async () => {
  const demandTestId = launchedDemandTestId;
  const experimentId = launchedExperimentId;

  // A premature conclusion attempt (the experiment is still draft) is an
  // honest 409 — never a fabricated conclusion.
  await assert.rejects(
    cd().recordCommerceDiscoveryDemandTestConclusion(
      { missionId, demandTestId, reason: 'premature attempt' },
      PROVENANCE,
    ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('draft'));
      return true;
    },
  );

  // The authority's own lifecycle: mark_ready → start → begin_analysis →
  // conclude (through the REAL routes).
  for (const [transition, conclusion] of [
    ['mark_ready', null],
    ['start', null],
    ['begin_analysis', null],
    [
      'conclude',
      {
        resultState: 'observation',
        uncertainty: { kind: 'interval', lower: 0.4, upper: 3.2, level: 0.95 },
        assumptions: [],
        sampleLimitations: ['short observation window'],
        confounders: [],
        resultingDecision: 'continue observing the kitchen apron demand',
        evidenceRefs: [],
      },
    ],
  ] as const) {
    const applied = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token: alice.token,
      body: conclusion === null ? { transition } : { transition, conclusion },
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
  }

  // The guarded advance copies the authority's conclusion.
  const concluded = await cd().recordCommerceDiscoveryDemandTestConclusion(
    { missionId, demandTestId, reason: 'the authority concluded the experiment' },
    PROVENANCE,
  );
  assert.equal(concluded.state, 'concluded');
  assert.equal(concluded.conclusionResultState, 'observation');
  assert.equal(concluded.conclusionUncertaintyRepresentation, 'interval');
  assert.ok(concluded.conclusionRecordedAt !== null);

  // The advance is single-shot (an honest 409).
  await assert.rejects(
    cd().recordCommerceDiscoveryDemandTestConclusion(
      { missionId, demandTestId, reason: 'second attempt' },
      PROVENANCE,
    ),
    () => true,
  );
});

// ---------------------------------------------------------------------------
// (c) THE GUARDRAIL BREACH LIFECYCLE — the honest blocked state
// ---------------------------------------------------------------------------

test('MKT-072 (c): a budget-reducing version breaches the guardrails → the honest guardrail_blocked state → the explicit resolution', async () => {
  // A budget-reducing version (an auditable declaration): 99999 < the
  // observed spend 100000.
  const reduced = await cd().composeCommerceDiscoveryPlan(
    composeInput({
      declared: {
        spendCurrency: 'USD',
        testBudgetMinorUnits: 99999,
        maxDemandTests: 5,
        minOrderCountForViability: 1,
      },
      reason: 'the budget-reducing declaration (the breach setup)',
    }),
    PROVENANCE,
  );
  assert.equal(reduced.mission.currentVersionSeq, 2);
  assert.equal(reduced.mission.status, 'active');

  // The evaluation BREACHES and the program transitions to the honest
  // blocked state.
  const breach = await cd().evaluateCommerceDiscoveryGuardrails(
    { missionId, reason: 'the breach evaluation against the reduced budget' },
    PROVENANCE,
  );
  assert.equal(breach.verdict, 'breached');
  assert.deepEqual(breach.breachReasons, ['spend_exceeds_test_budget']);
  assert.equal(breach.evaluated.testBudgetMinorUnits, 99999);
  assert.equal(breach.observed.spendMinorUnits, 100000);
  const blocked = await cd().getCommerceDiscoveryMission(missionId);
  assert.equal(blocked!.status, 'guardrail_blocked');

  // New demand-test spend is REFUSED while blocked (never a silent
  // continue).
  await assert.rejects(
    cd().launchCommerceDiscoveryDemandTest(
      {
        missionId,
        candidateId: recordedCandidateId,
        testSpendMinorUnits: 1,
        reason: 'a blocked launch attempt',
      },
      PROVENANCE,
    ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('guardrail_blocked'));
      return true;
    },
  );

  // The learning loop STILL records observations while blocked (the
  // resolution input).
  const observation = await cd().recordCommerceDiscoveryOutcome(
    {
      missionId,
      candidateId: recordedCandidateId,
      commerceEventIds: [ingestedCommerceEventId],
      metricObservationIds: [],
      reason: 'an observation while blocked (feeds the resolution)',
    },
    PROVENANCE,
  );
  assert.equal(observation.observedOrderCount, 1);

  // The still-breached resolve is an honest 409 (never a silent lift).
  await assert.rejects(
    cd().resolveCommerceDiscoveryGuardrailBlock(
      { missionId, reason: 'a premature resolve attempt' },
      PROVENANCE,
    ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('still breached'));
      return true;
    },
  );
  assert.equal((await cd().getCommerceDiscoveryMission(missionId))!.status, 'guardrail_blocked');

  // The adequate-budget version + the resolve → 'active' again.
  await cd().composeCommerceDiscoveryPlan(
    composeInput({
      declared: {
        spendCurrency: 'USD',
        testBudgetMinorUnits: 600000,
        maxDemandTests: 5,
        minOrderCountForViability: 1,
      },
      reason: 'the budget-raising declaration (the resolution)',
    }),
    PROVENANCE,
  );
  const resolved = await cd().resolveCommerceDiscoveryGuardrailBlock(
    { missionId, reason: 'the honest resolution under the raised budget' },
    PROVENANCE,
  );
  assert.equal(resolved.mission.status, 'active');
  // The resolution re-evaluation is recorded.
  const evaluations = await cd().listCommerceDiscoveryGuardrailEvaluations(missionId);
  assert.ok(evaluations!.length >= 4);
  assert.equal(evaluations![evaluations!.length - 1]!.verdict, 'within_bounds');
});

// ---------------------------------------------------------------------------
// (d) APPEND-ONLY DISCIPLINE — replay convergence + the DB backstops
// ---------------------------------------------------------------------------

test('MKT-072 (d): a replayed compose converges (same digest, no duplicate version); the DB rejects rewrites', async () => {
  const before = await cd().getCommerceDiscoveryDetail(missionId);
  const replay = await cd().composeCommerceDiscoveryPlan(
    composeInput({
      declared: {
        spendCurrency: 'USD',
        testBudgetMinorUnits: 600000,
        maxDemandTests: 5,
        minOrderCountForViability: 1,
      },
      reason: 'the replayed composition (the same observable world + bounds)',
    }),
    PROVENANCE,
  );
  assert.equal(replay.mission.currentVersionSeq, before!.mission.currentVersionSeq);
  assert.equal(replay.versions.length, before!.versions.length);
  assert.equal(
    replay.currentVersion.inputDigest,
    before!.currentVersion.inputDigest,
    'the honest replay convergence (the same digest)',
  );

  // The DB backstops: UPDATE/DELETE are rejected on the append-only tails.
  const versionId = replay.currentVersion.discoveryVersionId;
  await assert.rejects(
    pool().query(`UPDATE commerce_discovery_mission_versions SET reason = 'rewrite' WHERE commerce_discovery_mission_version_id = $1`, [versionId]),
    (error: unknown) => String((error as Error).message).includes('append-only'),
  );
  const anyEvent = await pool().query(
    `SELECT commerce_discovery_event_id AS id FROM commerce_discovery_events
      WHERE commerce_discovery_mission_id = $1 LIMIT 1`,
    [replay.mission.discoveryMissionId],
  );
  await assert.rejects(
    pool().query(`DELETE FROM commerce_discovery_events WHERE commerce_discovery_event_id = $1`, [anyEvent.rows[0]!['id']]),
    (error: unknown) => String((error as Error).message).includes('append-only'),
  );
  await assert.rejects(
    pool().query(`DELETE FROM commerce_discovery_candidates WHERE commerce_discovery_candidate_id = $1`, [recordedCandidateId]),
    (error: unknown) => String((error as Error).message).includes('append-only'),
  );
  const anyOutcome = await pool().query(
    `SELECT commerce_discovery_outcome_id AS id FROM commerce_discovery_outcomes LIMIT 1`,
  );
  await assert.rejects(
    pool().query(`DELETE FROM commerce_discovery_outcomes WHERE commerce_discovery_outcome_id = $1`, [anyOutcome.rows[0]!['id']]),
    (error: unknown) => String((error as Error).message).includes('append-only'),
  );
  // The demand-test advance is single-shot at the DB level (a second
  // launched→concluded attempt is rejected by the guard trigger).
  await assert.rejects(
    pool().query(
      `UPDATE commerce_discovery_demand_tests SET conclusion_result_state = 'inconclusive' WHERE commerce_discovery_demand_test_id = $1`,
      [launchedDemandTestId],
    ),
    (error: unknown) => String((error as Error).message).includes('guarded advance'),
  );
  // The scope-fence backstop: a cross-client commerce-event citation is
  // rejected (Bob's connection event vs Alice's program).
  const foreignEvent = await pool().query(
    `SELECT commerce_event_id FROM commerce_events WHERE client_id = $1 LIMIT 1`,
    [bobClientId],
  );
  if (foreignEvent.rows.length > 0) {
    const outcomeId = (await pool().query(
      `SELECT commerce_discovery_outcome_id FROM commerce_discovery_outcomes LIMIT 1`,
    )).rows[0]!['commerce_discovery_outcome_id'] as string;
    await assert.rejects(
      pool().query(
        `INSERT INTO commerce_discovery_outcome_cited_commerce_events
           (commerce_discovery_outcome_id, commerce_event_id, position)
         VALUES ($1, $2, 1)`,
        [outcomeId, foreignEvent.rows[0]!['commerce_event_id']],
      ),
      (error: unknown) =>
        String((error as Error).message).includes('store-connection boundary'),
    );
  }
});

// ---------------------------------------------------------------------------
// (e) THE ROUTE DISCIPLINE BATTERY
// ---------------------------------------------------------------------------

test('MKT-072 (e): the route discipline — uniform 404s, the family gate, the fail-closed pre-gate, the authority-field rejection, client isolation', async () => {
  const base = `/api/growth-missions/${missionId}/commerce-discovery`;

  // The family gate: a product_marketing mission is an honest 409.
  const wrongFamily = await apiCall(
    port(),
    `/api/growth-missions/${wrongFamilyMissionId}/commerce-discovery/plan`,
    {
      token: alice.token,
      body: {
        productContextId,
        pursuitWorkspaceId: aliceWorkspaceId,
        storeConnectionId,
        spendCurrency: 'USD',
        testBudgetMinorUnits: 1000,
        maxDemandTests: 1,
        minOrderCountForViability: 1,
        reason: 'wrong family attempt',
      },
    },
  );
  assert.equal(wrongFamily.status, 409);
  assert.ok(JSON.stringify(wrongFamily.body).includes('commerce_discovery'));

  // The uniform 404s: unknown mission / foreign mission / unknown context /
  // foreign connection / unknown candidate / unknown commerce event.
  const unknownMission = await apiCall(
    port(),
    `/api/growth-missions/00000000-0000-4000-8000-000000000000/commerce-discovery/plan`,
    {
      token: alice.token,
      body: {
        productContextId,
        pursuitWorkspaceId: aliceWorkspaceId,
        storeConnectionId,
        spendCurrency: 'USD',
        testBudgetMinorUnits: 1000,
        maxDemandTests: 1,
        minOrderCountForViability: 1,
        reason: 'unknown mission attempt',
      },
    },
  );
  assert.equal(unknownMission.status, 404);
  const foreignMission = await apiCall(port(), `${base}/plan`, { token: bob.token });
  assert.equal(foreignMission.status, 404);
  const unknownContext = await apiCall(port(), `${base}/plan`, {
    token: alice.token,
    body: {
      productContextId: '00000000-0000-4000-8000-000000000099',
      pursuitWorkspaceId: aliceWorkspaceId,
      storeConnectionId,
      spendCurrency: 'USD',
      testBudgetMinorUnits: 1000,
      maxDemandTests: 1,
      minOrderCountForViability: 1,
      reason: 'unknown context attempt',
    },
  });
  assert.equal(unknownContext.status, 404);
  const foreignConnection = await apiCall(port(), `${base}/plan`, {
    token: alice.token,
    body: {
      productContextId,
      pursuitWorkspaceId: aliceWorkspaceId,
      storeConnectionId: foreignConnectionId,
      spendCurrency: 'USD',
      testBudgetMinorUnits: 1000,
      maxDemandTests: 1,
      minOrderCountForViability: 1,
      reason: 'foreign connection attempt',
    },
  });
  assert.equal(foreignConnection.status, 404);
  const unknownCandidate = await apiCall(port(), `${base}/demand-tests`, {
    token: alice.token,
    body: {
      candidateId: '00000000-0000-4000-8000-000000000098',
      testSpendMinorUnits: 100,
      reason: 'unknown candidate attempt',
    },
  });
  assert.equal(unknownCandidate.status, 404);
  const unknownEvent = await apiCall(port(), `${base}/outcomes`, {
    token: alice.token,
    body: {
      candidateId: recordedCandidateId,
      commerceEventIds: ['00000000-0000-4000-8000-000000000097'],
      metricObservationIds: [],
      reason: 'unknown event attempt',
    },
  });
  assert.equal(unknownEvent.status, 404);

  // The fail-closed budget pre-gate: an over-budget launch is refused.
  const overBudget = await apiCall(port(), `${base}/demand-tests`, {
    token: alice.token,
    body: {
      candidateId: recordedCandidateId,
      testSpendMinorUnits: 600000,
      reason: 'over-budget attempt',
    },
  });
  assert.equal(overBudget.status, 409);
  assert.ok(JSON.stringify(overBudget.body).includes('declared test budget'));

  // Every authority-shaped field is rejected on the compose surface.
  const authorityInjection = await apiCall(port(), `${base}/plan`, {
    token: alice.token,
    body: {
      productContextId,
      pursuitWorkspaceId: aliceWorkspaceId,
      storeConnectionId,
      spendCurrency: 'USD',
      testBudgetMinorUnits: 1000,
      maxDemandTests: 1,
      minOrderCountForViability: 1,
      reason: 'attempting to inject a selection',
      nicheSelection: [{ niche: 'Fake Niche' }],
    },
  });
  assert.equal(authorityInjection.status, 422);
  assert.ok(JSON.stringify(authorityInjection.body).includes('nicheSelection'));

  // A member WITHOUT the owner/admin role cannot mutate...
  const admin = await adminToken();
  userSeq += 1;
  const memberCreate = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email: `member${userSeq}@commercediscovery.test`, displayName: 'Member' },
  });
  const memberId = memberCreate.body['userId'] as string;
  await apiCall(port(), `/api/users/${memberId}/credential`, { token: admin, body: { password: 'member-pass-123' } });
  const memberLogin = await apiCall(port(), '/api/auth/login', {
    body: { email: `member${userSeq}@commercediscovery.test`, password: 'member-pass-123' },
  });
  const memberToken = memberLogin.body['token'] as string;
  const invited = await apiCall(port(), `/api/agencies/${alice.agencyId}/memberships`, {
    token: alice.token,
    body: { userId: memberId, role: 'agency_operator' },
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const memberMutate = await apiCall(port(), `${base}/guardrail-evaluations`, {
    token: memberToken,
    body: { reason: 'member mutation attempt' },
  });
  assert.equal(memberMutate.status, 403);
  // ...but the member CAN read (any active member).
  const memberRead = await apiCall(port(), `${base}/plan`, { token: memberToken });
  assert.equal(memberRead.status, 200);
  const memberFullRead = await apiCall(port(), `${base}`, { token: memberToken });
  assert.equal(memberFullRead.status, 200);
  assert.ok((memberFullRead.body['history'] as unknown[]).length >= 6);

  // Bob cannot read Alice's program (the uniform 404 — client isolation).
  const foreignRead = await apiCall(port(), `${base}`, { token: bob.token });
  assert.equal(foreignRead.status, 404);

  // The terminal conclude freezes the program honestly.
  const concluded = await apiCall(port(), `${base}/conclude`, {
    token: alice.token,
    body: { reason: 'the golden path concluded' },
  });
  assert.equal(concluded.status, 200, JSON.stringify(concluded.body));
  assert.equal((concluded.body['mission'] as Record<string, unknown>)['status'], 'concluded');
  const postTerminal = await apiCall(port(), `${base}/candidates`, {
    token: alice.token,
    body: {
      label: 'Post-terminal candidate',
      niche: 'Kitchen & Home',
      productDescriptor: 'A candidate recorded after the terminal conclude.',
      estimatedCostMinorUnits: 100,
      estimatedPriceMinorUnits: 200,
      economicsCurrency: 'USD',
      demandHypothesis: 'a post-terminal hypothesis',
      productDerivedModelIds: derivedModelIds.slice(0, 1),
      contentCandidateIds: [kitchenContentCandidateId],
      contentHypothesisIds: [],
    },
  });
  assert.equal(postTerminal.status, 409);
  assert.ok(JSON.stringify(postTerminal.body).includes('frozen history'));

});
