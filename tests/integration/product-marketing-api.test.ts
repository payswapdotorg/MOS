/**
 * MKT-070 integration tests — the /product-marketing surfaces against a
 * REAL embedded PostgreSQL 18 stack (the platform-health dual-level
 * harness: HTTP fixtures over the spawned API, then module-level
 * round-trips + DB backstop proofs against the SAME database through the
 * in-process bootstrapApplication).
 *
 * THE DISPATCH'S NAMED TESTS, END-TO-END over the real composed surfaces:
 *
 *   (a) THE ACCEPTANCE: two product URL/code contexts → two different
 *       auditable plans — the platform portfolio AND the metric plan
 *       change, and the influencing records are VISIBLE (the FK-anchored
 *       citation links resolve to the real seeded records: the product
 *       inputs/facts/models, the platform-health evaluations behind the
 *       mix, the research insights attached BY REFERENCE, the
 *       experiment-analysis results and the content hypotheses);
 *   (b) A health-blocked account changes the mix WITH the verdict cited:
 *       the instagram account's platform-CONFIRMED restricted evaluation
 *       excludes it from every portfolio (the cited evaluation id
 *       FK-resolves);
 *   (c) FABRICATION RESISTANCE (the negative test): a citation link to a
 *       nonexistent record is rejected by the DB FK, a cross-client
 *       citation is rejected by the scope fence, and the module surfaces
 *       the uniform 404 for a foreign product context;
 *   (d) APPEND-ONLY DISCIPLINE: a replayed compose converges (no
 *       duplicate version — 200, same digest), a changed product context
 *       appends a NEW version with the REQUIRED reason (the correction
 *       path — never an in-place rewrite; the DB rejects UPDATE/DELETE on
 *       the version tail and the citation links);
 *   (e) The route discipline battery: uniform 404s (unknown/foreign
 *       mission, product context, research session, workspace), the
 *       family gate (409 for a non-product_marketing mission), the
 *       terminal-mission freeze (409), the owner|admin POST gate, the
 *       authority-field rejection, and client isolation on the reads.
 *
 * The platform under test: the DISCLOSED reference in-memory doubles at
 * the provider boundaries ONLY (the local OAuth provider + the reference
 * social adapters keyed 'youtube'/'tiktok'/'instagram' — the seam
 * override; the scripted page-reader double for the public product/research
 * pages). The /product-marketing module under test (the frozen-row
 * composition through the five public contracts, the deterministic
 * pm-plan-v1 core, the migration-060 fences) is fully REAL.
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
import type { ProductMarketingModuleApi } from '../../src/modules/product-marketing/public.ts';
import type { ProductIntelligenceModuleApi } from '../../src/modules/product-intelligence/public.ts';
import type { ResearchModuleApi } from '../../src/modules/research/public.ts';
import type { SocialAccountsModuleApi } from '../../src/modules/social-accounts/public.ts';
import type { IntegrationsModuleApi } from '../../src/modules/integrations/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';
import type { PlatformHealthModuleApi } from '../../src/modules/platform-health/public.ts';
import type { ExperimentAnalysisModuleApi } from '../../src/modules/experiment-analysis/public.ts';
import type {
  ProductPageReader,
  ProductPageFetchRequest,
  ProductPageFetchOutcome,
} from '../../src/modules/product-intelligence/public.ts';
import type { ResearchPageReader } from '../../src/modules/research/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'product-marketing-pipe-key';
const YOUTUBE_KEY = 'youtube';
const TIKTOK_KEY = 'tiktok';
const INSTAGRAM_KEY = 'instagram';

const CONSUMER_PAGE = 'https://consumer-product.test/';
const DEVTOOL_PAGE = 'https://devtool.test/';
const RESEARCH_PAGE = 'https://widgets-weekly.test/report';

const PAGE_FIXTURES: Readonly<Record<string, string>> = {
  [CONSUMER_PAGE]: `<html lang="en"><head><title>Consumer Product — the everyday helper</title>` +
    `<meta name="description" content="A consumer product with broad appeal and strong visual storytelling.">` +
    `<meta property="og:title" content="Consumer Product"></head>` +
    `<body><h1>The everyday helper</h1><p>Beautiful, simple, and loved by everyone.</p></body></html>`,
  [DEVTOOL_PAGE]: `<html lang="en"><head><title>DevTool — the developer platform</title>` +
    `<meta name="description" content="A developer tool with a public API and source repositories.">` +
    `<meta property="og:title" content="DevTool"></head>` +
    `<body><h1>The developer platform</h1><p>APIs, CLI, and integrations for engineering teams.</p></body></html>`,
  [RESEARCH_PAGE]: `<html lang="en"><head><title>Widget content trends 2026</title>` +
    `<meta name="description" content="The observed content-format trends for widgets."></head>` +
    `<body><h1>Widget content trends</h1><p>Short-form video and visual explainers grew fastest.</p></body></html>`,
};

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-000000000070',
  recordedVia: 'test',
  correlationId: 'integration-product-marketing-1',
  causationId: null,
} as const;

const FULL_SCOPES = ['account:read', 'content:read', 'analytics:read', 'content:write'];

/** The DISCLOSED scripted page-reader double (both GET-only reader contracts). */
class ScriptedPageReader implements ProductPageReader, ResearchPageReader {
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
let provider: LocalOAuthProvider | null = null;
let youtubeAdapter: ReferenceSocialAdapter | null = null;
let tiktokAdapter: ReferenceSocialAdapter | null = null;
let instagramAdapter: ReferenceSocialAdapter | null = null;
let productMarketing: ProductMarketingModuleApi | null = null;
let productIntelligence: ProductIntelligenceModuleApi | null = null;
let researchModule: ResearchModuleApi | null = null;
let socialAccounts: SocialAccountsModuleApi | null = null;
let integrationsHandle: IntegrationsModuleApi | null = null;
let credentialsHandle: CredentialsModuleApi | null = null;
let platformHealth: PlatformHealthModuleApi | null = null;
let experimentAnalysis: ExperimentAnalysisModuleApi | null = null;

function pm(): ProductMarketingModuleApi {
  if (productMarketing === null) throw new Error('application not booted');
  return productMarketing;
}
function pi(): ProductIntelligenceModuleApi {
  if (productIntelligence === null) throw new Error('application not booted');
  return productIntelligence;
}
function rs(): ResearchModuleApi {
  if (researchModule === null) throw new Error('application not booted');
  return researchModule;
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
function ph(): PlatformHealthModuleApi {
  if (platformHealth === null) throw new Error('application not booted');
  return platformHealth;
}
function ea(): ExperimentAnalysisModuleApi {
  if (experimentAnalysis === null) throw new Error('application not booted');
  return experimentAnalysis;
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
    body: { name: `Agency ${email} ${userSeq}`, ownerUserId: userId },
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
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['clientId'] as string;
}

async function makeWorkspace(principal: Principal, clientId: string): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: principal.token,
    body: { name: `Pursuit Workspace ${clientId.slice(0, 8)}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
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
  assert.equal(created.status, 201, JSON.stringify(created.body));
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
      productContext: { name: 'Planned Product', url: 'https://planned.example', summary: 'The declared product context.' },
      marketContext: { audience: 'the declared audience', geography: 'global', summary: 'The declared market context.' },
      targetMetrics: [],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const missionId = (created.body['mission'] as Record<string, unknown>)['missionId'] as string;
  const goalOne = await makeGoal(token, clientId, `${objective} — primary goal`);
  const goalTwo = await makeGoal(token, clientId, `${objective} — secondary goal`);
  for (const goalId of [goalOne, goalTwo]) {
    const mapped = await apiCall(port(), `/api/growth-missions/${missionId}/goal-mappings`, {
      token,
      body: { goalId },
    });
    assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
  }
  return missionId;
}

async function currentAgencyOfClient(clientId: string): Promise<string> {
  const row = await pool().query<{ agency_id: string }>(
    'SELECT agency_id FROM clients WHERE client_id = $1',
    [clientId],
  );
  return row.rows[0]!.agency_id;
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
    label: `pm_pipe_${clientId.slice(0, 8)}_${connectionSeq}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection({
    clientId,
    adapterKey,
    credentialReferenceId: credential.credentialId,
    providerConfig: { apiBaseUrl: provider!.url },
  }, PROVENANCE);
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
    displayIdentity: `pm:${options.accountId}`,
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

let evidenceSeq = 0;
async function makeEvidence(token: string, clientId: string): Promise<string> {
  evidenceSeq += 1;
  const created = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'source_fact',
      sourceSystem: 'product-marketing-test',
      sourceRef: `fixture/pm/${evidenceSeq}`,
      observedAt: '2026-09-01T10:30:00.000Z',
      content: { kind: 'plan-citation', seq: evidenceSeq },
      quality: 'C',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['evidenceId'] as string;
}

// ---------------------------------------------------------------------------
// Boot + fixtures
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let aliceWorkspaceId: string;
let bob: Principal;
let bobClientId: string;
let bobWorkspaceId: string;

/** The consumer product context (the URL context — rich marketing evidence). */
let consumerContextId: string;
/** The dev-tool product context (the CODE context — thin, risk-flagged). */
let devToolContextId: string;
/** The authorized connection the source_repository input cites (honest read). */
let repoConnectionId: string;
let researchSessionId: string;
const researchInsightIds: string[] = [];
let youtubeAccountId: string;
let tiktokAccountId: string;
let instagramAccountId: string;
let youtubeEvaluationId: string;
let tiktokEvaluationId: string;
let instagramEvaluationId: string;
let experimentId: string;
let analysisId: string;
let allocationRecommendationId: string;
let contentHypothesisId: string;
let missionAId: string;
let missionBId: string;
let missionAPlanVersionOne: string;

before(async () => {
  stack = await bootStack('product_marketing');
  const fs = await import('node:fs');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startLocalOAuthProvider();
  youtubeAdapter = createReferenceSocialAdapter({ adapterKey: YOUTUBE_KEY });
  tiktokAdapter = createReferenceSocialAdapter({ adapterKey: TIKTOK_KEY });
  instagramAdapter = createReferenceSocialAdapter({ adapterKey: INSTAGRAM_KEY });
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const scriptedReader = new ScriptedPageReader();
  const core = await bootstrapApplication({
    integrationAdapters: [
      createReferenceIntegrationStub(YOUTUBE_KEY),
      createReferenceIntegrationStub(TIKTOK_KEY),
      createReferenceIntegrationStub(INSTAGRAM_KEY),
    ],
    socialAccountFlows: [
      createLocalOAuthFlow(provider, { adapterKey: YOUTUBE_KEY, secretsDir: stack.env.secretsDir }),
      createLocalOAuthFlow(provider, { adapterKey: TIKTOK_KEY, secretsDir: stack.env.secretsDir }),
      createLocalOAuthFlow(provider, { adapterKey: INSTAGRAM_KEY, secretsDir: stack.env.secretsDir }),
    ],
    socialPlatformAdapters: [youtubeAdapter, tiktokAdapter, instagramAdapter],
    productPageReader: scriptedReader,
    researchPageReader: scriptedReader,
  });
  productMarketing = core.modules.productMarketing;
  productIntelligence = core.modules.productIntelligence;
  researchModule = core.modules.research;
  socialAccounts = core.modules.socialAccounts;
  integrationsHandle = core.modules.integrations;
  credentialsHandle = core.modules.credentials;
  platformHealth = core.modules.platformHealth;
  experimentAnalysis = core.modules.experimentAnalysis;

  // --- The pursuit tenant (Alice) + the isolation tenant (Bob). ---
  alice = await makeAgencyOwner('alice@productmarketing.test');
  aliceClientId = await makeClient(alice);
  aliceWorkspaceId = await makeWorkspace(alice, aliceClientId);
  await allowAll(alice, 'network');
  await allowAll(alice, 'secrets');
  bob = await makeAgencyOwner('bob@productmarketing.test');
  bobClientId = await makeClient(bob);
  bobWorkspaceId = await makeWorkspace(bob, bobClientId);

  // --- The social accounts with REAL platform-health evaluations. ---
  const youtubeConnection = await makePlatformConnection(alice, aliceClientId, YOUTUBE_KEY);
  const tiktokConnection = await makePlatformConnection(alice, aliceClientId, TIKTOK_KEY);
  const instagramConnection = await makePlatformConnection(alice, aliceClientId, INSTAGRAM_KEY);
  youtubeAccountId = await connectAccount(aliceClientId, youtubeConnection, { accountId: 'pm-yt-1', scopes: FULL_SCOPES });
  tiktokAccountId = await connectAccount(aliceClientId, tiktokConnection, { accountId: 'pm-tt-1', scopes: FULL_SCOPES });
  instagramAccountId = await connectAccount(aliceClientId, instagramConnection, { accountId: 'pm-ig-1', scopes: FULL_SCOPES });

  // The instagram account's platform-CONFIRMED restriction: one restricted
  // publish attempt through the REAL 056 submit contract.
  instagramAdapter!.setNextSubmitState('restricted');
  await social().submitPublish(
    instagramAccountId,
    {
      idempotencyKey: 'pm-restricted-1',
      request: {
        contentType: 'reference-post',
        payload: { title: 'product marketing fixture' },
        mediaAssets: [],
        attribution: {},
        scheduledFor: null,
      },
    },
    PROVENANCE,
  );

  const youtubeEvaluation = await ph().evaluateAccountHealth(
    { clientId: aliceClientId, socialAccountId: youtubeAccountId },
    PROVENANCE,
  );
  youtubeEvaluationId = youtubeEvaluation.evaluation.evaluationId;
  assert.equal(youtubeEvaluation.evaluation.evaluatedState, 'healthy');
  const tiktokEvaluation = await ph().evaluateAccountHealth(
    { clientId: aliceClientId, socialAccountId: tiktokAccountId },
    PROVENANCE,
  );
  tiktokEvaluationId = tiktokEvaluation.evaluation.evaluationId;
  assert.equal(tiktokEvaluation.evaluation.evaluatedState, 'healthy');
  const instagramEvaluation = await ph().evaluateAccountHealth(
    { clientId: aliceClientId, socialAccountId: instagramAccountId },
    PROVENANCE,
  );
  instagramEvaluationId = instagramEvaluation.evaluation.evaluationId;
  assert.equal(instagramEvaluation.evaluation.evaluatedState, 'restricted');

  // --- The consumer product context (URL context, rich evidence). ---
  const consumerContext = await pi().createProductContext(
    {
      agencyId: alice.agencyId,
      declaration: {
        name: 'Consumer Product',
        summary: 'A consumer product with a public site.',
        inputs: [
          { kind: 'product_site_url', reference: CONSUMER_PAGE, authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    PROVENANCE,
  );
  consumerContextId = consumerContext.context.productContextId;
  await pi().runProductInspection({ productContextId: consumerContextId }, PROVENANCE);
  const consumerFacts = (await pi().getProductContextSourceFacts(consumerContextId))!;
  const consumerFactIds = consumerFacts.map((fact) => fact.sourceFactId);
  assert.ok(consumerFactIds.length >= 5);
  // The evidence-backed derived models (the influence signals).
  for (const [kind, count] of [
    ['content_worthy_features', 3],
    ['market_language', 2],
    ['value_propositions', 1],
    ['icp_audience_hypotheses', 1],
    ['commercial_metrics', 1],
  ] as const) {
    for (let index = 0; index < count; index++) {
      await pi().recordDerivedModel(
        {
          productContextId: consumerContextId,
          derivationKind: kind,
          statement: { summary: `${kind} observation ${index + 1} for the consumer product.` },
          evidenceSourceFactIds: [consumerFactIds[index % consumerFactIds.length]!],
          aiAssistance: null,
          supersedesDerivedModelId: null,
        },
        PROVENANCE,
      );
    }
  }
  // One UNVERIFIED model: present, disclosed, never influencing (§7).
  await pi().recordDerivedModel(
    {
      productContextId: consumerContextId,
      derivationKind: 'commercial_metrics',
      statement: { summary: 'A speculative commercial metric with no cited evidence.' },
      evidenceSourceFactIds: [],
      aiAssistance: null,
      supersedesDerivedModelId: null,
    },
    PROVENANCE,
  );

  // --- The dev-tool product context (CODE context, risk-flagged). ---
  repoConnectionId = await makePlatformConnection(alice, aliceClientId, YOUTUBE_KEY);
  const devToolContext = await pi().createProductContext(
    {
      agencyId: alice.agencyId,
      declaration: {
        name: 'DevTool',
        summary: 'A developer tool with a public site and an authorized source repository.',
        inputs: [
          { kind: 'product_site_url', reference: DEVTOOL_PAGE, authorization: 'public', integrationConnectionId: null },
          { kind: 'source_repository', reference: 'https://source.example/devtool', authorization: 'authorized', integrationConnectionId: repoConnectionId },
        ],
      },
    },
    PROVENANCE,
  );
  devToolContextId = devToolContext.context.productContextId;
  await pi().runProductInspection({ productContextId: devToolContextId }, PROVENANCE);
  const devToolFacts = (await pi().getProductContextSourceFacts(devToolContextId))!;
  assert.ok(devToolFacts.length >= 5);
  await pi().recordDerivedModel(
    {
      productContextId: devToolContextId,
      derivationKind: 'content_worthy_features',
      statement: { summary: 'The API reference pages are content-worthy for developers.' },
      evidenceSourceFactIds: [devToolFacts[0]!.sourceFactId],
      aiAssistance: null,
      supersedesDerivedModelId: null,
    },
    PROVENANCE,
  );
  await pi().recordProductRiskFlag(
    {
      productContextId: devToolContextId,
      category: 'compliance',
      severity: 'high',
      statement: { summary: 'The repository input requires license review before marketing claims.' },
      mitigation: 'Review the LICENSE before publishing derived claims.',
      evidenceSourceFactIds: [devToolFacts[0]!.sourceFactId],
    },
    PROVENANCE,
  );

  // --- The research session (attached BY REFERENCE — the MKT-069 seam). ---
  const researchSession = await rs().createResearchSession(
    {
      agencyId: alice.agencyId,
      declaration: {
        topic: 'Consumer product content trends 2026',
        focus: 'Which formats grow fastest?',
        sources: [
          { kind: 'web_page', reference: RESEARCH_PAGE, authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    PROVENANCE,
  );
  researchSessionId = researchSession.session.researchSessionId;
  await rs().runResearch({ researchSessionId }, PROVENANCE);
  const researchDetail = await rs().getResearchSessionDetail(researchSessionId);
  const researchFactIds = researchDetail!.sourceFacts.slice(0, 2).map((fact) => fact.sourceFactId);
  for (const index of [0, 1]) {
    const insight = await rs().recordResearchInsight(
      {
        researchSessionId,
        derivationKind: 'trend_observation',
        statement: { summary: `Evidence-backed trend observation ${index + 1} for the niche.` },
        evidenceSourceFactIds: researchFactIds,
        aiAssistance: null,
        supersedesResearchInsightId: null,
      },
      PROVENANCE,
    );
    researchInsightIds.push(insight.researchInsightId);
  }
  assert.equal(researchInsightIds.length, 2);

  // --- The experiment-analysis evidence chain (the informed plan basis). ---
  const experimentCreated = await apiCall(port(), `/api/clients/${aliceClientId}/experiments`, {
    token: alice.token,
    body: {
      hypothesis: 'Short-form video posts increase engagement rate',
      decisionTarget: 'Whether to shift the content mix toward short-form video',
      populationUnit: 'post',
      treatment: 'short-form video posts',
      comparison: 'image posts',
      assignmentMethod: 'random assignment per post',
      designType: 'randomized',
      primaryMetric: { name: 'engagement_rate_pm', dimensions: { platform: 'tiktok' } },
      guardrails: [],
      analysisMethod: 'two-sample means comparison',
      stopCriteria: 'stop after 30 observations per arm',
      minimumEvidenceRequirement: 'A — randomized experiment',
      uncertaintyRepresentation: 'interval',
    },
  });
  assert.equal(experimentCreated.status, 201, JSON.stringify(experimentCreated.body));
  experimentId = experimentCreated.body['experimentId'] as string;
  for (let index = 0; index < 30; index++) {
    const day = String((index % 20) + 1).padStart(2, '0');
    for (const [arm, base] of [['treatment', 3], ['comparison', 1]] as const) {
      const created = await apiCall(port(), `/api/clients/${aliceClientId}/metrics`, {
        token: alice.token,
        body: {
          metricName: 'engagement_rate_pm',
          dimensions: { platform: 'tiktok', arm },
          value: base + (index % 3) * 0.1,
          unit: 'ratio',
          sourceSystem: 'product-marketing-test',
          sourceRef: `fixture/pm-obs/${arm}/${index}`,
          observedAt: `2026-09-${day}T10:00:00.000Z`,
          quality: 'ok',
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }
  }
  const analysisEvidence = await makeEvidence(alice.token, aliceClientId);
  const analysis = await ea().recordExperimentAnalysis(
    {
      clientId: aliceClientId,
      workspaceId: null,
      experimentId,
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-10-01T00:00:00.000Z',
      uncertaintyLevel: null,
      minObservationsPerArm: null,
      practicalThreshold: { value: 1, source: 'declared_input', description: null },
      declaredConfounders: ['posting-time overlap'],
      declaredLimitations: [],
      evidenceRefs: [analysisEvidence],
    },
    PROVENANCE,
  );
  analysisId = analysis.analysisId;
  const allocation = await ea().recordAllocationRecommendation(
    {
      clientId: aliceClientId,
      workspaceId: null,
      experimentId,
      analysisId,
      arms: [
        { armKey: 'strategy_mix_v1', kind: 'strategy_variant', capacity: 100, sampleSize: 30, mean: 3, variance: 1 },
        { armKey: 'current_mix', kind: 'strategy_variant', capacity: 100, sampleSize: 30, mean: 1, variance: 1 },
      ],
      explorationFloor: null,
    },
    PROVENANCE,
  );
  allocationRecommendationId = allocation.recommendationId;

  // --- The content hypothesis (the content-strategy basis). ---
  const hypothesisEvidence = await makeEvidence(alice.token, aliceClientId);
  const hypothesis = await core.modules.contentIntelligence.recordContentHypothesis(
    {
      clientId: aliceClientId,
      workspaceId: null,
      hypothesisKind: 'format_hypothesis',
      statement: { summary: 'Short-form explainers may outperform for this audience — an input, not a conclusion.' },
      evidenceIds: [hypothesisEvidence],
      candidateIds: [],
      researchInsightIds: [],
      experimentId: null,
      supersedesContentHypothesisId: null,
    },
    PROVENANCE,
  );
  contentHypothesisId = hypothesis.contentHypothesisId;

  // --- The two missions (the acceptance pair). ---
  missionAId = await makeMission(alice.token, 'Grow qualified traffic for the consumer product', 'product_marketing', aliceClientId);
  missionBId = await makeMission(alice.token, 'Grow developer adoption for the DevTool platform', 'product_marketing', aliceClientId);
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
// (a) THE ACCEPTANCE — two product contexts → two different auditable
//     plans, over the REAL HTTP surface
// ---------------------------------------------------------------------------

test('MKT-070 (a): THE ACCEPTANCE — the consumer URL context and the dev-tool CODE context produce two different auditable plans', async () => {
  // --- Plan ONE: the consumer product context (+ the attached research). ---
  const planOne = await apiCall(port(), `/api/growth-missions/${missionAId}/product-marketing/plan`, {
    token: alice.token,
    body: {
      productContextId: consumerContextId,
      pursuitWorkspaceId: aliceWorkspaceId,
      researchSessionId,
      reason: 'initial plan for the consumer product context',
    },
  });
  assert.equal(planOne.status, 201, JSON.stringify(planOne.body));
  const planOneBody = planOne.body as Record<string, unknown>;
  const versionOneBody = planOneBody['currentVersion'] as Record<string, unknown>;
  missionAPlanVersionOne = versionOneBody['planVersionId'] as string;

  const portfolioOne = versionOneBody['platformPortfolio'] as Record<string, unknown>[];
  assert.equal(portfolioOne.length, 3, 'all three evaluated accounts appear in the portfolio');
  const youtubeOne = portfolioOne.find((entry) => entry['platformId'] === 'youtube')!;
  const tiktokOne = portfolioOne.find((entry) => entry['platformId'] === 'tiktok')!;
  const instagramOne = portfolioOne.find((entry) => entry['platformId'] === 'instagram')!;
  // (b) rides along: the RESTRICTED account is excluded with the verdict cited.
  assert.equal(instagramOne['inclusion'], 'excluded');
  assert.equal(instagramOne['weightShareBps'], 0);
  assert.ok(String(instagramOne['rationale']).includes('restricted'));
  // The health verdict evaluation IS cited on the excluded entry (the
  // FK-anchored evidence basis — not prose).
  const instagramCitations = (instagramOne['citations'] as { kind: string; refId: string }[]);
  assert.ok(
    instagramCitations.some(
      (citation) => citation.kind === 'platform_health_evaluation' && citation.refId === instagramEvaluationId,
    ),
    'the excluded entry cites the restricted verdict evaluation',
  );
  // The rich consumer evidence promotes BOTH healthy platforms to primary.
  assert.equal(youtubeOne['inclusion'], 'primary');
  assert.equal(tiktokOne['inclusion'], 'primary');
  const shareTotal = portfolioOne.reduce((sum, entry) => sum + (entry['weightShareBps'] as number), 0);
  assert.equal(shareTotal, 10000);

  // The metric plan wires the mission's goals BY REFERENCE.
  const metricPlanOne = versionOneBody['metricPlan'] as Record<string, unknown>[];
  assert.equal(metricPlanOne.length, 4);
  const visitsOne = metricPlanOne.find((metric) => metric['metric'] === 'qualified_site_visits')!;
  assert.ok((visitsOne['targetValue'] as number) > 0);
  const goalRefs = visitsOne['goalRefs'] as string[];
  const missionOne = await apiCall(port(), `/api/growth-missions/${missionAId}`, { token: alice.token });
  const mappedGoals = ((missionOne.body as Record<string, unknown>)['goalMappings'] as Record<string, unknown>[])
    .map((mapping) => mapping['goalId'] as string);
  assert.deepEqual([...goalRefs].sort(), [...mappedGoals].sort());

  // The content strategy + disclosures.
  const strategyOne = versionOneBody['contentStrategy'] as Record<string, unknown>;
  assert.equal(strategyOne['profile'], 'broad_reach_visual');
  assert.ok(String(planOneBody['attributionDisclosure']).includes('attribution is distinct from causality'));
  assert.ok(String(planOneBody['experimentDisclosure']).includes('creates no experiment'));
  const experimentOne = versionOneBody['experimentPlan'] as Record<string, unknown>;
  assert.equal(experimentOne['boundedBy'], 'growth-operator');
  assert.ok(String(experimentOne['rationale']).includes('positive'));

  // THE INFLUENCING RECORDS ARE VISIBLE: the citation links FK-resolve to
  // the real seeded records.
  const citationsOne = planOneBody['citations'] as { kind: string; refId: string }[];
  const kindsOne = new Set(citationsOne.map((citation) => citation.kind));
  for (const expected of [
    'product_input',
    'product_source_fact',
    'product_derived_model',
    'platform_health_evaluation',
    'research_insight',
    'experiment_analysis',
    'allocation_recommendation',
    'content_hypothesis',
  ]) {
    assert.ok(kindsOne.has(expected), `the plan cites ${expected} records`);
  }
  assert.ok(citationsOne.some((c) => c.kind === 'platform_health_evaluation' && c.refId === youtubeEvaluationId));
  assert.ok(citationsOne.some((c) => c.kind === 'platform_health_evaluation' && c.refId === tiktokEvaluationId));
  assert.ok(citationsOne.some((c) => c.kind === 'platform_health_evaluation' && c.refId === instagramEvaluationId));
  for (const insightId of researchInsightIds) {
    assert.ok(citationsOne.some((c) => c.kind === 'research_insight' && c.refId === insightId));
  }
  assert.ok(citationsOne.some((c) => c.kind === 'experiment_analysis' && c.refId === analysisId));
  assert.ok(citationsOne.some((c) => c.kind === 'allocation_recommendation' && c.refId === allocationRecommendationId));
  assert.ok(citationsOne.some((c) => c.kind === 'content_hypothesis' && c.refId === contentHypothesisId));
  // The UNVERIFIED model is never cited (the §7 tier).
  const unverified = await pool().query<{ derived_model_id: string }>(
    `SELECT derived_model_id FROM product_derived_models
      WHERE product_context_id = $1 AND verification_state = 'unverified'`,
    [consumerContextId],
  );
  assert.equal(unverified.rows.length, 1);
  assert.ok(!citationsOne.some((c) => c.refId === unverified.rows[0]!.derived_model_id));

  // The DB citation links exist and FK-resolve (the evidence basis is real).
  const linkCount = await pool().query<{ count: string }>(
    `SELECT (SELECT count(*) FROM product_marketing_plan_cited_product_inputs
              WHERE product_marketing_plan_version_id = $1)
            + (SELECT count(*) FROM product_marketing_plan_cited_product_facts
              WHERE product_marketing_plan_version_id = $1)
            + (SELECT count(*) FROM product_marketing_plan_cited_product_models
              WHERE product_marketing_plan_version_id = $1)
            + (SELECT count(*) FROM product_marketing_plan_cited_research_insights
              WHERE product_marketing_plan_version_id = $1)
            + (SELECT count(*) FROM product_marketing_plan_cited_platform_health_evaluations
              WHERE product_marketing_plan_version_id = $1)
            + (SELECT count(*) FROM product_marketing_plan_cited_experiment_analyses
              WHERE product_marketing_plan_version_id = $1)
            + (SELECT count(*) FROM product_marketing_plan_cited_allocation_recommendations
              WHERE product_marketing_plan_version_id = $1)
            + (SELECT count(*) FROM product_marketing_plan_cited_content_hypotheses
              WHERE product_marketing_plan_version_id = $1) AS count`,
    [missionAPlanVersionOne],
  );
  assert.equal(Number(linkCount.rows[0]!.count), citationsOne.length);

  // --- Plan TWO: the dev-tool CODE context (a DIFFERENT product context). ---
  const planTwo = await apiCall(port(), `/api/growth-missions/${missionBId}/product-marketing/plan`, {
    token: alice.token,
    body: {
      productContextId: devToolContextId,
      pursuitWorkspaceId: aliceWorkspaceId,
      researchSessionId: null,
      reason: 'initial plan for the dev-tool code context',
    },
  });
  assert.equal(planTwo.status, 201, JSON.stringify(planTwo.body));
  const planTwoBody = planTwo.body as Record<string, unknown>;
  const versionTwoBody = planTwoBody['currentVersion'] as Record<string, unknown>;

  // THE TWO PLANS DIFFER: different digests, different portfolio tiers,
  // different scores, different metric plans, different strategies.
  const portfolioTwo = versionTwoBody['platformPortfolio'] as Record<string, unknown>[];
  const youtubeTwo = portfolioTwo.find((entry) => entry['platformId'] === 'youtube')!;
  const tiktokTwo = portfolioTwo.find((entry) => entry['platformId'] === 'tiktok')!;
  // The code context: youtube (long_video ×1.1) outscores tiktok
  // (short_video ×0.7) and takes the single primary slot.
  assert.equal(youtubeTwo['inclusion'], 'primary');
  assert.equal(tiktokTwo['inclusion'], 'secondary');
  assert.ok((youtubeTwo['score'] as number) > (tiktokTwo['score'] as number));
  assert.notEqual(youtubeOne['inclusion'], youtubeTwo['inclusion'] !== 'primary' ? 'primary' : 'x');
  assert.ok((youtubeOne['weightShareBps'] as number) !== (youtubeTwo['weightShareBps'] as number));

  const metricPlanTwo = versionTwoBody['metricPlan'] as Record<string, unknown>[];
  const visitsTwo = metricPlanTwo.find((metric) => metric['metric'] === 'qualified_site_visits')!;
  assert.ok((visitsOne['targetValue'] as number) > (visitsTwo['targetValue'] as number));

  const strategyTwo = versionTwoBody['contentStrategy'] as Record<string, unknown>;
  assert.equal(strategyTwo['profile'], 'technical_authority');

  const digestOne = versionOneBody['inputDigest'];
  const digestTwo = versionTwoBody['inputDigest'];
  assert.notEqual(digestOne, digestTwo);

  // The dev-tool plan cites the CODE input + the risk flag.
  const citationsTwo = planTwoBody['citations'] as { kind: string; refId: string }[];
  const codeInputs = await pool().query<{ input_id: string }>(
    `SELECT input_id FROM product_context_inputs pci
      JOIN product_context_versions pcv ON pcv.product_context_version_id = pci.product_context_version_id
     WHERE pcv.product_context_id = $1 AND pci.kind = 'source_repository'`,
    [devToolContextId],
  );
  assert.equal(codeInputs.rows.length, 1);
  assert.ok(citationsTwo.some((c) => c.kind === 'product_input' && c.refId === codeInputs.rows[0]!.input_id));
  assert.ok(citationsTwo.some((c) => c.kind === 'product_risk_flag'));
});

// ---------------------------------------------------------------------------
// (b) The health-blocked account — the verdict evaluation cited + FK-resolved
// ---------------------------------------------------------------------------

test('MKT-070 (b): the restricted account exclusion cites the platform-health verdict evaluation (FK-resolved)', async () => {
  const detail = await pm().getProductMarketingPlanDetail(missionAId);
  assert.ok(detail !== null);
  const instagramEntry = detail!.currentVersion.platformPortfolio.find(
    (entry) => entry.platformId === 'instagram',
  )!;
  assert.equal(instagramEntry.inclusion, 'excluded');
  assert.equal(instagramEntry.evaluationId, instagramEvaluationId);
  // The cited evaluation FK-resolves to the REAL restricted verdict.
  const verdict = await pool().query<{ evaluated_state: string; social_account_id: string }>(
    `SELECT evaluated_state, social_account_id FROM platform_health_evaluations
      WHERE platform_health_evaluation_id = $1`,
    [instagramEntry.evaluationId],
  );
  assert.equal(verdict.rows[0]!.evaluated_state, 'restricted');
  assert.equal(verdict.rows[0]!.social_account_id, instagramAccountId);
});

// ---------------------------------------------------------------------------
// (c) FABRICATION RESISTANCE — the negative test
// ---------------------------------------------------------------------------

test('MKT-070 (c): a citation link to a NONEXISTENT record is rejected (fabrication cannot persist)', async () => {
  const fakeId = '99999999-9999-4999-8999-999999999999';
  // The scope-consistency trigger fires BEFORE the FK constraint: a
  // nonexistent record resolves to NULL scope → the boundary rejection
  // (either the scope fence or the FK violation — both are hard
  // rejections, nothing persists).
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO product_marketing_plan_cited_platform_health_evaluations
           (product_marketing_plan_version_id, platform_health_evaluation_id, position)
         VALUES ($1, $2, 1)`,
        [missionAPlanVersionOne, fakeId],
      ),
    (error: unknown) => {
      assert.ok(
        error instanceof Error &&
          (/crosses the client boundary/.test(error.message) || /violates foreign key/.test(error.message)),
      );
      return true;
    },
  );
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO product_marketing_plan_cited_product_models
           (product_marketing_plan_version_id, derived_model_id, position)
         VALUES ($1, $2, 1)`,
        [missionAPlanVersionOne, fakeId],
      ),
    (error: unknown) => {
      assert.ok(
        error instanceof Error &&
          (/crosses the product-context boundary/.test(error.message) || /violates foreign key/.test(error.message)),
      );
      return true;
    },
  );
});

test('MKT-070 (c): a CROSS-CLIENT citation is rejected by the scope fence (never a traversal oracle)', async () => {
  // Bob evaluates one of HIS accounts; Alice's plan may not cite it.
  await allowAll(bob, 'network');
  await allowAll(bob, 'secrets');
  const bobConnection = await makePlatformConnection(bob, bobClientId, YOUTUBE_KEY);
  const bobAccountId = await connectAccount(bobClientId, bobConnection, { accountId: 'pm-bob-1', scopes: FULL_SCOPES });
  const bobEvaluation = await ph().evaluateAccountHealth(
    { clientId: bobClientId, socialAccountId: bobAccountId },
    PROVENANCE,
  );
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO product_marketing_plan_cited_platform_health_evaluations
           (product_marketing_plan_version_id, platform_health_evaluation_id, position)
         VALUES ($1, $2, 1)`,
        [missionAPlanVersionOne, bobEvaluation.evaluation.evaluationId],
      ),
    (error: unknown) => {
      assert.ok(
        error instanceof Error && /crosses the client boundary/.test(error.message),
        `expected the client scope fence, got: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    },
  );
});

test('MKT-070 (c): a foreign product context is the uniform 404 (the module surfaces it honestly)', async () => {
  const bobContext = await pi().createProductContext(
    {
      agencyId: bob.agencyId,
      declaration: {
        name: "Bob's Product",
        summary: null,
        inputs: [
          { kind: 'product_site_url', reference: DEVTOOL_PAGE, authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    PROVENANCE,
  );
  const composed = await apiCall(port(), `/api/growth-missions/${missionAId}/product-marketing/plan`, {
    token: alice.token,
    body: {
      productContextId: bobContext.context.productContextId,
      pursuitWorkspaceId: aliceWorkspaceId,
      researchSessionId: null,
      reason: 'attempting a foreign product context',
    },
  });
  assert.equal(composed.status, 404);
  // And the module-level surface refuses it too.
  await assert.rejects(
    () =>
      pm().composeProductMarketingPlan(
        {
          missionId: missionAId,
          productContextId: bobContext.context.productContextId,
          pursuitWorkspaceId: aliceWorkspaceId,
          researchSessionId: null,
          reason: 'module-level foreign context attempt',
        },
        PROVENANCE,
      ),
    /not found/i,
  );
});

// ---------------------------------------------------------------------------
// (d) APPEND-ONLY DISCIPLINE — replay convergence + the NEW-version correction
// ---------------------------------------------------------------------------

test('MKT-070 (d): a replayed compose CONVERGES (no duplicate version — 200, same digest)', async () => {
  const before = await pm().getProductMarketingPlanDetail(missionAId);
  const replay = await apiCall(port(), `/api/growth-missions/${missionAId}/product-marketing/plan`, {
    token: alice.token,
    body: {
      productContextId: consumerContextId,
      pursuitWorkspaceId: aliceWorkspaceId,
      researchSessionId,
      reason: 'replayed compose — the same observable world',
    },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  const after = await pm().getProductMarketingPlanDetail(missionAId);
  assert.equal(after!.versions.length, before!.versions.length);
  assert.equal(after!.currentVersion.inputDigest, before!.currentVersion.inputDigest);
  assert.equal(after!.plan.currentVersionSeq, before!.plan.currentVersionSeq);
});

test('MKT-070 (d): a changed product context appends a NEW version with the reason (never an in-place rewrite)', async () => {
  const correction = await apiCall(port(), `/api/growth-missions/${missionAId}/product-marketing/plan`, {
    token: alice.token,
    body: {
      productContextId: devToolContextId,
      pursuitWorkspaceId: aliceWorkspaceId,
      researchSessionId: null,
      reason: 'correction: the product context changed to the dev-tool code context',
    },
  });
  assert.equal(correction.status, 201, JSON.stringify(correction.body));
  const detail = await pm().getProductMarketingPlanDetail(missionAId);
  assert.ok(detail !== null);
  assert.equal(detail!.plan.currentVersionSeq, 2);
  assert.equal(detail!.versions.length, 2);
  // Version 1 stays intact (append-only history).
  assert.equal(detail!.versions[0]!.versionSeq, 1);
  assert.equal(detail!.versions[0]!.reason, 'initial plan for the consumer product context');
  assert.equal(detail!.currentVersion.reason, 'correction: the product context changed to the dev-tool code context');
  // The NEW version is the code-context plan (the same mission's plan
  // changed with the product context — the acceptance on one plan).
  assert.equal(detail!.currentVersion.contentStrategy.profile, 'technical_authority');
  assert.notEqual(
    detail!.currentVersion.inputDigest,
    detail!.versions[0]!.inputDigest,
  );
  // The version tail read surface.
  const versions = await apiCall(port(), `/api/growth-missions/${missionAId}/product-marketing/plan/versions`, {
    token: alice.token,
  });
  assert.equal(versions.status, 200);
  assert.equal((versions.body['versions'] as unknown[]).length, 2);
});

test('MKT-070 (d): the DB rejects UPDATE/DELETE on the version tail and the citation links (append-only backstops)', async () => {
  const plan = await pm().getProductMarketingPlan(missionAId);
  assert.ok(plan !== null);
  const versionId = (await pm().getProductMarketingPlanDetail(missionAId))!.currentVersion.planVersionId;
  await assert.rejects(
    () =>
      pool().query(
        `UPDATE product_marketing_plan_versions SET reason = 'rewritten' WHERE product_marketing_plan_version_id = $1`,
        [versionId],
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error && /append-only/.test(error.message));
      return true;
    },
  );
  await assert.rejects(
    () =>
      pool().query(`DELETE FROM product_marketing_plan_versions WHERE product_marketing_plan_version_id = $1`, [versionId]),
    (error: unknown) => {
      assert.ok(error instanceof Error && /append-only/.test(error.message));
      return true;
    },
  );
  await assert.rejects(
    () =>
      pool().query(
        `DELETE FROM product_marketing_plan_cited_platform_health_evaluations
          WHERE product_marketing_plan_version_id = $1`,
        [versionId],
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error && /append-only/.test(error.message));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (e) The route discipline battery
// ---------------------------------------------------------------------------

test('MKT-070 (e): uniform 404s for unknown/foreign identifiers (no existence oracle)', async () => {
  const unknownMission = await apiCall(port(), '/api/growth-missions/00000000-0000-4000-8000-000000000000/product-marketing/plan', {
    token: alice.token,
    body: { productContextId: consumerContextId, pursuitWorkspaceId: aliceWorkspaceId, researchSessionId: null, reason: 'x' },
  });
  assert.equal(unknownMission.status, 404);

  // A foreign mission (Bob's) is indistinguishable from an unknown one.
  const bobMission = await makeMission(bob.token, "Bob's mission", 'product_marketing', bobClientId);
  const foreignMission = await apiCall(port(), `/api/growth-missions/${bobMission}/product-marketing/plan`, {
    token: alice.token,
    body: { productContextId: consumerContextId, pursuitWorkspaceId: aliceWorkspaceId, researchSessionId: null, reason: 'x' },
  });
  assert.equal(foreignMission.status, 404);

  // Unknown product context / workspace / research session.
  const unknownContext = await apiCall(port(), `/api/growth-missions/${missionBId}/product-marketing/plan`, {
    token: alice.token,
    body: { productContextId: '00000000-0000-4000-8000-000000000001', pursuitWorkspaceId: aliceWorkspaceId, researchSessionId: null, reason: 'x' },
  });
  assert.equal(unknownContext.status, 404);
  const unknownWorkspace = await apiCall(port(), `/api/growth-missions/${missionBId}/product-marketing/plan`, {
    token: alice.token,
    body: { productContextId: devToolContextId, pursuitWorkspaceId: '00000000-0000-4000-8000-000000000002', researchSessionId: null, reason: 'x' },
  });
  assert.equal(unknownWorkspace.status, 404);
  const unknownResearch = await apiCall(port(), `/api/growth-missions/${missionBId}/product-marketing/plan`, {
    token: alice.token,
    body: { productContextId: devToolContextId, pursuitWorkspaceId: aliceWorkspaceId, researchSessionId: '00000000-0000-4000-8000-000000000003', reason: 'x' },
  });
  assert.equal(unknownResearch.status, 404);

  // A foreign WORKSPACE (Bob's) is the uniform 404.
  const foreignWorkspace = await apiCall(port(), `/api/growth-missions/${missionBId}/product-marketing/plan`, {
    token: alice.token,
    body: { productContextId: devToolContextId, pursuitWorkspaceId: bobWorkspaceId, researchSessionId: null, reason: 'x' },
  });
  assert.equal(foreignWorkspace.status, 404);

  // A mission with NO plan yet reads as the uniform 404.
  const missionC = await makeMission(alice.token, 'A third product marketing mission', 'product_marketing', aliceClientId);
  const noPlan = await apiCall(port(), `/api/growth-missions/${missionC}/product-marketing/plan`, { token: alice.token });
  assert.equal(noPlan.status, 404);
});

test('MKT-070 (e): the family gate (409 for a non-product_marketing mission) and the terminal-mission freeze (409)', async () => {
  const audienceMission = await makeMission(alice.token, 'Grow the audience', 'audience_growth', aliceClientId);
  const familyGate = await apiCall(port(), `/api/growth-missions/${audienceMission}/product-marketing/plan`, {
    token: alice.token,
    body: { productContextId: consumerContextId, pursuitWorkspaceId: aliceWorkspaceId, researchSessionId: null, reason: 'wrong family' },
  });
  assert.equal(familyGate.status, 409);
  assert.ok(JSON.stringify(familyGate.body).includes('product_marketing'));

  // A TERMINAL mission's plan history is frozen.
  const terminalMission = await makeMission(alice.token, 'A stopped product marketing mission', 'product_marketing', aliceClientId);
  const activated = await apiCall(port(), `/api/growth-missions/${terminalMission}/status`, {
    token: alice.token,
    body: { status: 'active', reason: 'activation', version: 1 },
  });
  assert.equal(activated.status, 200);
  const stopped = await apiCall(port(), `/api/growth-missions/${terminalMission}/status`, {
    token: alice.token,
    body: { status: 'stopped_by_user', reason: 'the operator stopped it', version: 2 },
  });
  assert.equal(stopped.status, 200);
  const frozen = await apiCall(port(), `/api/growth-missions/${terminalMission}/product-marketing/plan`, {
    token: alice.token,
    body: { productContextId: consumerContextId, pursuitWorkspaceId: aliceWorkspaceId, researchSessionId: null, reason: 'terminal attempt' },
  });
  assert.equal(frozen.status, 409);
});

test('MKT-070 (e): the owner|admin POST gate, the authority-field rejection and client isolation', async () => {
  // A member WITHOUT the owner/admin role cannot compose.
  const admin = await adminToken();
  userSeq += 1;
  const memberCreate = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email: `member${userSeq}@productmarketing.test`, displayName: 'Member' },
  });
  const memberId = memberCreate.body['userId'] as string;
  await apiCall(port(), `/api/users/${memberId}/credential`, { token: admin, body: { password: 'member-pass-123' } });
  const memberLogin = await apiCall(port(), '/api/auth/login', {
    body: { email: `member${userSeq}@productmarketing.test`, password: 'member-pass-123' },
  });
  const memberToken = memberLogin.body['token'] as string;
  const invited = await apiCall(port(), `/api/agencies/${alice.agencyId}/memberships`, {
    token: alice.token,
    body: { userId: memberId, role: 'agency_operator' },
  });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const memberCompose = await apiCall(port(), `/api/growth-missions/${missionBId}/product-marketing/plan`, {
    token: memberToken,
    body: { productContextId: consumerContextId, pursuitWorkspaceId: aliceWorkspaceId, researchSessionId: null, reason: 'member attempt' },
  });
  assert.equal(memberCompose.status, 403);
  // ...but the member CAN read (any active member).
  const memberRead = await apiCall(port(), `/api/growth-missions/${missionAId}/product-marketing/plan`, {
    token: memberToken,
  });
  assert.equal(memberRead.status, 200);

  // Every authority-shaped field is rejected on the compose surface.
  const authorityInjection = await apiCall(port(), `/api/growth-missions/${missionBId}/product-marketing/plan`, {
    token: alice.token,
    body: {
      productContextId: consumerContextId,
      pursuitWorkspaceId: aliceWorkspaceId,
      researchSessionId: null,
      reason: 'attempting to inject a portfolio',
      platformPortfolio: [{ platformId: 'youtube', inclusion: 'primary' }],
    },
  });
  assert.equal(authorityInjection.status, 422);
  assert.ok(JSON.stringify(authorityInjection.body).includes('platformPortfolio'));

  // Bob cannot read Alice's plan (the uniform 404 — client/agency isolation).
  const foreignRead = await apiCall(port(), `/api/growth-missions/${missionAId}/product-marketing/plan`, {
    token: bob.token,
  });
  assert.equal(foreignRead.status, 404);
});
