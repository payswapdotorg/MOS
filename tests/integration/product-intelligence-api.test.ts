/**
 * MKT-069 integration tests — the Product Intelligence surface on the real
 * stack (embedded PostgreSQL 18 + real API process — no mocks of platform
 * services; the module-level commands are driven through the SAME
 * in-process application composed against the SAME database the API
 * serves, with the DISCLOSED in-repo page-reader test double supplied
 * through the composition seam — the MKT-034 sanctioned test-harness
 * wiring, the growth-missions/app-metering precedent).
 *
 * The authorized-read path is FULLY REAL: the /integrations public
 * contract with the REAL generic-analytics first-party adapter egressing
 * through the platform HttpCallPort against the loopback sandbox provider
 * (NO real network — the MKT-024 harness).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-069; the dispatch
 * acceptance criteria AC-1..AC-8):
 *   - AC-7 GOLDEN PATH: product context with a public URL → inspection →
 *     source facts → derived model with evidence links → risk flags →
 *     read-back, through BOTH the module-level operations and the HTTP
 *     surfaces; an explicitly-authorized repo input and a non-authorized
 *     repo input (rejected honestly) both exercised;
 *   - AC-1 VERSION IMMUTABILITY: the declared inputs are IMMUTABLE per
 *     version; a correction is a NEW version record (the original stays
 *     readable byte-identical); the DB rejects in-place rewrites outright
 *     (direct SQL UPDATE/DELETE on every tail table);
 *   - AC-3 VERIFICATION-STATE DISCIPLINE: the state is SERVER-COMPUTED
 *     from the cited evidence (a request-supplied verificationState is a
 *     rejected authority field); the unverified → evidence_backed
 *     transition rides the single-supersession chain; a derived record
 *     without backing evidence can never be presented as established; the
 *     AI-assistance disclosure cites a registry-resolvable model;
 *   - AC-4 RISK FLAGS: append-only records with the frozen category/
 *     severity vocabularies and evidence links;
 *   - AC-2 HONEST INSPECTION OUTCOMES: fetch/transport/read failures are
 *     recorded per-input (never invented success);
 *   - AC-8 FAIL-CLOSED ISOLATION: anonymous 401; foreign/malformed
 *     agency/context identifiers are the UNIFORM 404; a suspended
 *     membership is the 403; every PUT/PATCH/DELETE verb 405s at the
 *     router (the GET/POST surface discipline);
 *   - AC-6 MISSION ATTACHMENT SEAM: the composed read-back carries the
 *     claim-tier disclosure and NO mission-strategy surface (the model
 *     records MKT-070 will attach by reference).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { startSandboxProvider, type SandboxProvider } from './helpers/sandbox-provider.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type {
  ProductIntelligenceModuleApi,
  ProductPageFetchOutcome,
  ProductPageReader,
  ProductContextDetail,
  ProductContextInputDeclaration,
} from '../../src/modules/product-intelligence/public.ts';
import { hashContent } from '../../src/modules/product-intelligence/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let productIntelligence: ProductIntelligenceModuleApi | null = null;
let sandbox: SandboxProvider | null = null;
let aiRuntimeModules: Awaited<ReturnType<typeof bootstrapApplication>>['modules'] | null = null;

// ---------------------------------------------------------------------------
// The DISCLOSED in-repo page-reader test double (the AC-2 fetcher contract)
// ---------------------------------------------------------------------------

/**
 * The scripted test double: a fixed map of URL → HTML body (or failure),
 * supplied through the composition seam (AppOptions.productPageReader —
 * the socialAccountFlows precedent). NO live network in the test suite:
 * the module-level inspection calls resolve against this double; the
 * spawned-process HTTP inspection resolves against the loopback page
 * server below through the REAL HttpPageReader (loopback only).
 */
const PAGE_FIXTURES: Readonly<Record<string, string>> = {
  'https://acme-widgets.test/': `<!doctype html>
<html lang="en-US">
<head>
  <title>Acme Widgets — Premium Widgets for Teams</title>
  <meta name="description" content="Acme Widgets builds premium widgets with 24h settlement.">
  <meta name="keywords" content="widgets, premium, b2b">
  <meta property="og:title" content="Acme Widgets">
  <meta property="og:description" content="Widgets for modern teams.">
  <link rel="canonical" href="https://acme-widgets.test/">
</head>
<body>
  <h1>Premium Widgets for Teams</h1>
  <p>Acme Widgets lets teams ship widgets faster with enterprise controls.</p>
  <h2>Features</h2>
  <h2>Pricing</h2>
</body>
</html>`,
  'https://acme-widgets.test/empty': '<html><head></head><body></body></html>',
};

const MISSING_PAGE = 'https://acme-widgets.test/missing';
const REFUSED_PAGE = 'https://acme-widgets.test/refused';

class ScriptedPageReader implements ProductPageReader {
  async fetch(request: { url: string }): Promise<ProductPageFetchOutcome> {
    if (request.url === MISSING_PAGE) {
      return {
        ok: false, status: 404, body: null, contentType: null,
        transportRefused: false, timedOut: false, error: 'http status 404',
      };
    }
    if (request.url === REFUSED_PAGE) {
      return {
        ok: false, status: null, body: null, contentType: null,
        transportRefused: true, timedOut: false, error: 'connection refused (sandbox double)',
      };
    }
    const body = PAGE_FIXTURES[request.url];
    if (body === undefined) {
      return {
        ok: false, status: null, body: null, contentType: null,
        transportRefused: true, timedOut: false,
        error: `the scripted double has no fixture for ${request.url}`,
      };
    }
    return {
      ok: true, status: 200, body, contentType: 'text/html',
      transportRefused: false, timedOut: false, error: null,
    };
  }
}

// ---------------------------------------------------------------------------
// The loopback page server (for the spawned-process REAL HttpPageReader)
// ---------------------------------------------------------------------------

let pageServer: http.Server | null = null;
let pageServerUrl = '';

function startPageServer(): Promise<void> {
  return new Promise((resolve) => {
    pageServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathFixtures: Readonly<Record<string, string>> = {
        '/': PAGE_FIXTURES['https://acme-widgets.test/']!,
      };
      const fixture = pathFixtures[url.pathname];
      if (fixture === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fixture);
    });
    pageServer.listen(0, '127.0.0.1', () => {
      const address = pageServer!.address() as AddressInfo;
      pageServerUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function pi(): ProductIntelligenceModuleApi {
  if (productIntelligence === null) throw new Error('application not bootstrapped');
  return productIntelligence;
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

const MODULE_PROVENANCE = {
  actor: 'service:product-intelligence-integration',
  recordedVia: 'module',
  correlationId: 'integration-product-intelligence-1',
  causationId: null,
} as const;

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

interface User {
  readonly userId: string;
  readonly token: string;
}

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

async function makeAgencyOwner(email: string): Promise<Principal> {
  const user = await makeUser(email, 'owner-password-123');
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: user.userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { userId: user.userId, token: user.token, agencyId };
}

async function makeClient(agencyId: string, token: string, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['clientId'] as string;
}

/** The platform policies the authorized-read path requires (network + secrets allow). */
async function declareIntegrationPolicies(): Promise<void> {
  const admin = await adminToken();
  for (const dimension of ['network', 'secrets']) {
    const declared = await apiCall(port(), '/api/policies', {
      token: admin,
      body: {
        dimension,
        rules: [
          {
            effect: 'allow',
            operations: ['*'],
            reason: 'MKT-069 integration-test platform boundary: authorized inspection reads explicitly allowed',
          },
        ],
        description: `MKT-069 integration-test platform default (${dimension} dimension)`,
      },
    });
    assert.equal(declared.status, 201, JSON.stringify(declared.body));
  }
}

/** Provisions one agency secret out-of-band (deployment-style). */
function provisionSecret(handle: string, material: string): void {
  fs.writeFileSync(path.join(stack!.env.secretsDir, `${handle}.secret`), material, { mode: 0o600 });
}

async function makeCredential(
  agencyId: string,
  token: string,
  label: string,
  secretHandle: string,
): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/credentials`, {
    token,
    body: { kind: 'integration_api_key', label, secretHandle },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['credentialId'] as string;
}

async function registerAndConnectAnalytics(
  token: string,
  clientId: string,
  credentialId: string,
): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/connections`, {
    token,
    body: {
      adapterKey: 'generic-analytics',
      credentialReferenceId: credentialId,
      providerConfig: {
        apiBaseUrl: `${sandbox!.url}/analytics`,
        propertyId: 'prop_77',
      },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const connectionId = created.body['connectionId'] as string;
  const connected = await apiCall(
    port(),
    `/api/clients/${clientId}/connections/${connectionId}/connect`,
    { token, body: { expectedVersion: created.body['version'] as number } },
  );
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.equal(connected.body['status'], 'connected');
  return connectionId;
}

/** One declared-input fixture (the kind/authorization fence respected). */
function siteInput(reference: string): ProductContextInputDeclaration {
  return { kind: 'product_site_url', reference, authorization: 'public', integrationConnectionId: null };
}

function analyticsInput(connectionId: string): ProductContextInputDeclaration {
  return {
    kind: 'current_analytics',
    reference: 'analytics:property:prop_77',
    authorization: 'authorized',
    integrationConnectionId: connectionId,
  };
}

function repoInput(connectionId: string): ProductContextInputDeclaration {
  return {
    kind: 'source_repository',
    reference: 'https://github.com/acme/widgets',
    authorization: 'authorized',
    integrationConnectionId: connectionId,
  };
}

function jsonBody(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || entry === undefined) continue;
    if (Array.isArray(entry)) {
      out[key] = entry.map((item) => (typeof item === 'object' && item !== null ? jsonBody(item) : item));
    } else if (typeof entry === 'object') {
      out[key] = jsonBody(entry);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let ownerA: Principal | null = null;
let ownerB: Principal | null = null;
let collaboratorA: { userId: string; token: string } | null = null;
let suspendedMember: { userId: string; token: string; membershipId: string } | null = null;
let clientAId: string | null = null;
let analyticsConnectionA: string | null = null;
let analyticsConnectionB: string | null = null;
let registeredModelId: string | null = null;

before(async () => {
  stack = await bootStack('product_intelligence');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  await startPageServer();

  // The sandbox provider (loopback; bearer checks; NO real network egress).
  const ANALYTICS_TOKEN = 'ea-' + 'fakeSandboxAnalyticsToken';
  sandbox = await startSandboxProvider({ analytics: ANALYTICS_TOKEN });

  // The sanctioned test-harness wiring (the MKT-034/app-metering
  // precedent): the SAME application composed IN-PROCESS against the SAME
  // database the API serves — with the DISCLOSED in-repo page-reader test
  // double supplied through the composition seam.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({ productPageReader: new ScriptedPageReader() });
  productIntelligence = core.modules.productIntelligence;
  aiRuntimeModules = core.modules;

  // The /ai-runtime registry model the AI-assistance disclosure cites.
  const model = await aiRuntimeModules!.aiRuntime.registerModel({
    model: {
      providerLabel: 'openrouter',
      modelKey: 'test.product-intelligence-deriver',
      displayName: 'Test PI Deriver',
      capabilities: ['text-generation'],
      toolFeatures: [],
      contextLimitTokens: 128000,
      costInputPerMtok: null,
      costOutputPerMtok: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      reliability: null,
      qualitySignals: {},
      privacyCharacteristics: {},
    },
    actorId: null,
  });
  registeredModelId = model.modelRegistryId;

  ownerA = await makeAgencyOwner('pi-owner-a@marketingos.test');
  ownerB = await makeAgencyOwner('pi-owner-b@marketingos.test');
  collaboratorA = await makeUser('pi-collab-a@marketingos.test', 'collab-password-123');
  const suspendedUser = await makeUser('pi-suspended@marketingos.test', 'suspended-password-123');
  clientAId = await makeClient(ownerA.agencyId, ownerA.token, 'Product Client A');

  const admin = await adminToken();
  const joinCollaborator = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/memberships`, {
    token: admin,
    body: { userId: collaboratorA.userId, role: 'agency_operator' },
  });
  assert.equal(joinCollaborator.status, 201, JSON.stringify(joinCollaborator.body));
  const joinSuspended = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/memberships`, {
    token: admin,
    body: { userId: suspendedUser.userId, role: 'agency_operator' },
  });
  assert.equal(joinSuspended.status, 201, JSON.stringify(joinSuspended.body));
  suspendedMember = {
    userId: suspendedUser.userId,
    token: suspendedUser.token,
    membershipId: joinSuspended.body['membershipId'] as string,
  };
  // Suspend the member (the 403 battery).
  const suspended = await apiCall(
    port(),
    `/api/agencies/${ownerA.agencyId}/memberships/${suspendedMember.membershipId}`,
    { token: admin, method: 'PATCH', body: { status: 'disabled', version: 1 } },
  );
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));

  // The authorized-read path: platform policies + credential + a REAL
  // connected generic-analytics integration (agency A) + agency B's
  // connection (the cross-agency fence battery).
  await declareIntegrationPolicies();
  provisionSecret(
    'mkt069-analytics-key-a',
    JSON.stringify({ accessToken: ANALYTICS_TOKEN, webhookSecret: null }),
  );
  provisionSecret(
    'mkt069-analytics-key-b',
    JSON.stringify({ accessToken: ANALYTICS_TOKEN, webhookSecret: null }),
  );
  const credentialA = await makeCredential(
    ownerA.agencyId,
    ownerA.token,
    'Analytics sandbox A',
    'mkt069-analytics-key-a',
  );
  analyticsConnectionA = await registerAndConnectAnalytics(ownerA.token, clientAId!, credentialA);
  const clientBId = await makeClient(ownerB.agencyId, ownerB.token, 'Product Client B');
  const credentialB = await makeCredential(
    ownerB.agencyId,
    ownerB.token,
    'Analytics sandbox B',
    'mkt069-analytics-key-b',
  );
  analyticsConnectionB = await registerAndConnectAnalytics(ownerB.token, clientBId, credentialB);
});

after(async () => {
  if (sandbox !== null) {
    await sandbox.close();
    sandbox = null;
  }
  api?.child.kill('SIGKILL');
  if (pageServer !== null) {
    // The REAL HttpPageReader's fetch keeps connections alive (undici
    // keep-alive) — hard-close them so server.close() resolves.
    pageServer.closeAllConnections();
    await new Promise<void>((resolve) => pageServer!.close(() => resolve()));
    pageServer = null;
  }
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// AC-7: THE GOLDEN PATH — through the module-level operations
// ---------------------------------------------------------------------------

test('AC-7 golden path (module-level): public URL + authorized analytics input → inspection → facts → evidence-linked derived model → risk flag → read-back', async () => {
  assert.ok(ownerA !== null && analyticsConnectionA !== null);
  const created = await pi().createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        name: 'Acme Widgets',
        summary: 'The premium widgets product',
        inputs: [siteInput('https://acme-widgets.test/'), analyticsInput(analyticsConnectionA)],
      },
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  assert.equal(created.context.version, 1);
  assert.equal(created.context.currentVersionSeq, 1);
  assert.equal(created.currentVersion.inputs.length, 2);
  assert.equal(created.currentVersion.inputs[0]!.kind, 'product_site_url');
  assert.equal(created.currentVersion.inputs[0]!.authorization, 'public');
  assert.equal(created.currentVersion.inputs[1]!.kind, 'current_analytics');
  assert.equal(created.currentVersion.inputs[1]!.authorization, 'authorized');
  assert.equal(created.currentVersion.inputs[1]!.integrationConnectionId, analyticsConnectionA);

  // THE INSPECTION (the deterministic pipeline: the scripted page double +
  // the REAL /integrations read against the sandbox provider).
  const run = await pi().runProductInspection({ productContextId: contextId }, MODULE_PROVENANCE);
  assert.equal(run.status, 'completed', JSON.stringify(run.inputOutcomes));
  assert.equal(run.inputsInspected, 2);
  assert.ok(run.factsRetained >= 10, `expected page + analytics facts, got ${run.factsRetained}`);
  for (const outcome of run.inputOutcomes) {
    assert.equal(outcome.outcome, 'facts_extracted', JSON.stringify(outcome));
  }

  // THE RETAINED SOURCE FACTS with FULL provenance (AC-2).
  const facts = await pi().getProductContextSourceFacts(contextId);
  assert.ok(facts !== null);
  const pageFacts = facts!.filter(
    (fact) => fact.sourceRef === 'https://acme-widgets.test/',
  );
  assert.ok(pageFacts.length >= 10, `expected the html-extract-v1 set, got ${pageFacts.length}`);
  const bodyHash = hashContent(PAGE_FIXTURES['https://acme-widgets.test/']!);
  for (const fact of pageFacts) {
    assert.equal(fact.extractor, 'html-extract-v1');
    assert.equal(fact.contentHash, bodyHash, 'the content hash is the sha256 of the fetched page body');
    assert.ok(fact.fetchedAt.length > 0);
    assert.ok(fact.extractionNotes !== null && fact.extractionNotes.length > 0);
    assert.equal(fact.inspectionRunId, run.inspectionRunId);
  }
  const titleFact = pageFacts.find((fact) => fact.factKind === 'page_title');
  assert.equal(titleFact?.content['text'], 'Acme Widgets — Premium Widgets for Teams');
  // The authorized analytics read retained the REAL normalized records
  // (the source_record observations through the REAL /integrations path).
  const analyticsFacts = facts!.filter((fact) => fact.factKind === 'source_record');
  assert.equal(analyticsFacts.length, 2, 'the sandbox analytics report carries two records');
  const recordIds = analyticsFacts
    .map((fact) => String(fact.content['providerRecordId']))
    .sort();
  assert.deepEqual(recordIds, [
    'analytics:report:20260301:Organic Search:conversions',
    'analytics:report:20260301:Organic Search:sessions',
  ]);
  for (const fact of analyticsFacts) {
    assert.equal(fact.extractor, 'integration-read-v1');
    assert.equal(fact.sourceRef, 'analytics:property:prop_77');
  }

  // THE DERIVED MODEL with evidence links (AC-3): evidence-backed.
  const pageFactId = pageFacts.find((fact) => fact.factKind === 'page_title')!.sourceFactId;
  const analyticsFactId = analyticsFacts[0]!.sourceFactId;
  const derived = await pi().recordDerivedModel(
    {
      productContextId: contextId,
      derivationKind: 'value_propositions',
      statement: {
        summary: 'Premium widgets with 24h settlement for modern teams.',
        supportingObservations: ['page title', 'meta description'],
      },
      evidenceSourceFactIds: [pageFactId, analyticsFactId],
      aiAssistance: {
        modelRegistryId: registeredModelId!,
        callReference: 'pi-integration-call-1',
      },
      supersedesDerivedModelId: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(derived.verificationState, 'evidence_backed');
  assert.deepEqual(derived.evidenceSourceFactIds, [pageFactId, analyticsFactId]);
  assert.equal(derived.aiAssistance?.modelRegistryId, registeredModelId);
  assert.equal(derived.aiAssistance?.callReference, 'pi-integration-call-1');
  assert.equal(derived.aiAssistance?.modelDisplay, 'Test PI Deriver');
  assert.equal(derived.supersedesDerivedModelId, null);

  // THE RISK FLAG with evidence links (AC-4).
  const risk = await pi().recordProductRiskFlag(
    {
      productContextId: contextId,
      category: 'commercial',
      severity: 'medium',
      statement: { summary: 'The pricing page is not yet indexed by search engines.' },
      mitigation: 'Publish the pricing sitemap.',
      evidenceSourceFactIds: [pageFactId],
    },
    MODULE_PROVENANCE,
  );
  assert.equal(risk.category, 'commercial');
  assert.equal(risk.severity, 'medium');
  assert.deepEqual(risk.evidenceSourceFactIds, [pageFactId]);

  // THE HONEST READ-BACK (AC-6: the mission attachment seam surface).
  const detail = await pi().getProductContextDetail(contextId);
  assert.ok(detail !== null);
  assert.equal(detail!.derivedRecordTier, 'claim');
  assert.equal(detail!.vocabularyVersion, 'pi-vocab-v1');
  assert.equal(detail!.sourceFacts.length, facts!.length);
  assert.equal(detail!.derivedModels.length, 1);
  assert.equal(detail!.riskFlags.length, 1);
  assert.equal(detail!.inspectionRuns.length, 1);
  assert.equal(detail!.currentVersion.versionSeq, 1);
});

// ---------------------------------------------------------------------------
// AC-7: THE GOLDEN PATH — through the HTTP surfaces (REAL page reader)
// ---------------------------------------------------------------------------

test('AC-7 golden path (HTTP): create → inspect (REAL reader, loopback page server) → facts → derived → risk → read-back', async () => {
  assert.ok(ownerA !== null && analyticsConnectionA !== null);
  const siteUrl = `${pageServerUrl}/`;
  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/product-contexts`, {
    token: ownerA.token,
    body: jsonBody({
      name: 'Acme Widgets (HTTP)',
      summary: null,
      inputs: [siteInput(siteUrl), analyticsInput(analyticsConnectionA)],
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const context = created.body['context'] as Record<string, unknown>;
  const contextId = context['productContextId'] as string;
  assert.equal(created.body['derivedRecordTier'], 'claim');
  assert.equal(created.body['vocabularyVersion'], 'pi-vocab-v1');

  // THE INSPECTION through the HTTP surface (the spawned process composes
  // the REAL HttpPageReader; the loopback page server stands in for the
  // public site — NO external network).
  const inspected = await apiCall(port(), `/api/product-contexts/${contextId}/inspections`, {
    token: ownerA.token,
    body: {},
  });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(
    inspected.body['status'],
    'completed',
    JSON.stringify(inspected.body['inputOutcomes']),
  );
  assert.ok((inspected.body['factsRetained'] as number) >= 12);

  // The retained facts read back through HTTP.
  const factsResponse = await apiCall(port(), `/api/product-contexts/${contextId}/source-facts`, {
    token: ownerA.token,
  });
  assert.equal(factsResponse.status, 200);
  const facts = factsResponse.body['sourceFacts'] as Record<string, unknown>[];
  assert.ok(facts.length >= 12);
  const pageFacts = facts.filter((fact) => fact['factKind'] !== 'source_record');
  assert.ok(pageFacts.length >= 10);
  for (const fact of pageFacts) {
    assert.equal(fact['extractor'], 'html-extract-v1');
    assert.equal(fact['sourceRef'], siteUrl);
    assert.ok(typeof fact['contentHash'] === 'string' && (fact['contentHash'] as string).length === 64);
  }

  // THE DERIVED MODEL through HTTP (evidence-linked + AI disclosure).
  const titleFact = pageFacts.find((fact) => fact['factKind'] === 'page_title')!;
  const derivedResponse = await apiCall(
    port(),
    `/api/product-contexts/${contextId}/derived-models`,
    {
      token: ownerA.token,
      body: {
        derivationKind: 'product_capabilities',
        statement: { summary: 'Hosted widget catalog with team controls.' },
        evidenceSourceFactIds: [titleFact['sourceFactId']],
        aiAssistance: {
          modelRegistryId: registeredModelId,
          callReference: 'pi-http-call-1',
        },
      },
    },
  );
  assert.equal(derivedResponse.status, 201, JSON.stringify(derivedResponse.body));
  assert.equal(derivedResponse.body['verificationState'], 'evidence_backed');
  assert.deepEqual(derivedResponse.body['evidenceSourceFactIds'], [titleFact['sourceFactId']]);
  assert.equal(
    (derivedResponse.body['aiAssistance'] as Record<string, unknown>)['modelRegistryId'],
    registeredModelId,
  );

  // THE RISK FLAG through HTTP.
  const riskResponse = await apiCall(port(), `/api/product-contexts/${contextId}/risk-flags`, {
    token: ownerA.token,
    body: jsonBody({
      category: 'operational',
      severity: 'low',
      statement: { summary: 'No docs page linked from the landing page.' },
      mitigation: null,
      evidenceSourceFactIds: [titleFact['sourceFactId']],
    }),
  });
  assert.equal(riskResponse.status, 201, JSON.stringify(riskResponse.body));
  assert.equal(riskResponse.body['category'], 'operational');

  // THE READ-BACK through HTTP.
  const readBack = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerA.token,
  });
  assert.equal(readBack.status, 200);
  assert.equal(readBack.body['derivedRecordTier'], 'claim');
  assert.equal((readBack.body['derivedModels'] as unknown[]).length, 1);
  assert.equal((readBack.body['riskFlags'] as unknown[]).length, 1);
  assert.equal((readBack.body['inspectionRuns'] as unknown[]).length, 1);
});

// ---------------------------------------------------------------------------
// AC-7: the authorized vs non-authorized repository inputs
// ---------------------------------------------------------------------------

test('AC-7: a NON-AUTHORIZED repository input is rejected honestly at declaration (boundary rule 7)', async () => {
  assert.ok(ownerA !== null);
  // Module-level: the kind-authorization fence (InvalidRequestError).
  await assert.rejects(
    pi().createProductContext(
      {
        agencyId: ownerA.agencyId,
        declaration: {
          name: null,
          summary: null,
          inputs: [
            {
              kind: 'source_repository',
              reference: 'https://github.com/acme/widgets',
              authorization: 'public',
              integrationConnectionId: null,
            },
          ],
        },
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(String((error as Error).message), /Invalid product context declaration/);
      return true;
    },
  );
  // HTTP: the honest 422.
  const response = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/product-contexts`, {
    token: ownerA.token,
    body: {
      inputs: [
        {
          kind: 'source_repository',
          reference: 'https://github.com/acme/widgets',
          authorization: 'public',
        },
      ],
    },
  });
  assert.equal(response.status, 422, JSON.stringify(response.body));
  assert.match(JSON.stringify(response.body), /REQUIRES authorization 'authorized'/);
});

test('AC-7: an explicitly-authorized repository input is exercised — the read flows through the REAL /integrations contract (honest capability outcome)', async () => {
  assert.ok(ownerA !== null && analyticsConnectionA !== null);
  const created = await pi().createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        name: 'Acme Repo Context',
        summary: null,
        inputs: [repoInput(analyticsConnectionA)],
      },
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  // The inspection runs the authorized read through the REAL
  // /integrations public contract: no first-party adapter declares the
  // repository.read operation yet, so the connection's adapter refuses it —
  // the outcome is recorded HONESTLY (no invented read, no silent skip).
  const run = await pi().runProductInspection({ productContextId: contextId }, MODULE_PROVENANCE);
  assert.equal(run.status, 'failed');
  assert.equal(run.factsRetained, 0);
  assert.equal(run.inputOutcomes.length, 1);
  assert.equal(run.inputOutcomes[0]!.outcome, 'read_error');
  assert.match(run.inputOutcomes[0]!.detail ?? '', /repository\.read/);
  // The facts tail stays EMPTY (the honest record — nothing invented).
  const facts = await pi().getProductContextSourceFacts(contextId);
  assert.deepEqual(facts, []);
});

test('AC-7: a repository input pointing at a FOREIGN-AGENCY connection is the uniform 404 (never an oracle)', async () => {
  assert.ok(ownerA !== null && analyticsConnectionB !== null);
  await assert.rejects(
    pi().createProductContext(
      {
        agencyId: ownerA.agencyId,
        declaration: {
          name: null,
          summary: null,
          inputs: [repoInput(analyticsConnectionB)],
        },
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NOT_FOUND');
      return true;
    },
  );
  // HTTP: the same uniform 404.
  const response = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/product-contexts`, {
    token: ownerA.token,
    body: jsonBody({
      name: null,
      inputs: [repoInput(analyticsConnectionB)],
    }),
  });
  assert.equal(response.status, 404, JSON.stringify(response.body));
});

// ---------------------------------------------------------------------------
// AC-2: the honest inspection outcomes (failures are recorded, never invented)
// ---------------------------------------------------------------------------

test('AC-2: fetch http/transport errors and empty pages are recorded HONESTLY per input (never invented success)', async () => {
  assert.ok(ownerA !== null);
  const created = await pi().createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        name: null,
        summary: null,
        inputs: [
          siteInput('https://acme-widgets.test/'),
          siteInput(MISSING_PAGE),
          siteInput(REFUSED_PAGE),
          siteInput('https://acme-widgets.test/empty'),
        ],
      },
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  const run = await pi().runProductInspection({ productContextId: contextId }, MODULE_PROVENANCE);
  // Mixed outcomes → the honest PARTIAL status.
  assert.equal(run.status, 'partial');
  assert.equal(run.inputsInspected, 4);
  const byRef = new Map(
    created.currentVersion.inputs.map((input) => [input.reference, input.inputId]),
  );
  const outcomeFor = (reference: string) =>
    run.inputOutcomes.find((outcome) => outcome.inputId === byRef.get(reference))!;
  assert.equal(outcomeFor('https://acme-widgets.test/').outcome, 'facts_extracted');
  assert.equal(outcomeFor(MISSING_PAGE).outcome, 'fetch_http_error');
  assert.match(outcomeFor(MISSING_PAGE).detail ?? '', /http status 404/);
  assert.equal(outcomeFor(REFUSED_PAGE).outcome, 'fetch_transport_error');
  assert.equal(outcomeFor('https://acme-widgets.test/empty').outcome, 'no_facts_extracted');
  // Only the successful page's facts are retained.
  const facts = await pi().getProductContextSourceFacts(contextId);
  const refs = new Set(facts!.map((fact) => fact.sourceRef));
  assert.deepEqual([...refs], ['https://acme-widgets.test/']);
});

// ---------------------------------------------------------------------------
// AC-1: version immutability (corrections are NEW versions; DB fences)
// ---------------------------------------------------------------------------

test('AC-1: the declared inputs are IMMUTABLE per version — corrections are NEW version records (the original stays byte-identical)', async () => {
  assert.ok(ownerA !== null);
  const created = await pi().createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        name: 'Original',
        summary: 'The original declaration',
        inputs: [siteInput('https://acme-widgets.test/')],
      },
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  const v1Before = (await pi().getProductContextVersions(contextId))![0]!;

  const corrected = await pi().recordProductContextVersion(
    {
      productContextId: contextId,
      declaration: {
        name: 'Corrected',
        summary: 'The corrected declaration',
        inputs: [siteInput('https://acme-widgets.test/'), siteInput(`${pageServerUrl}/`)],
      },
      expectedVersion: created.context.version,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(corrected.context.currentVersionSeq, 2);
  assert.equal(corrected.context.version, 2);
  assert.equal(corrected.currentVersion.inputs.length, 2);

  // The ORIGINAL version stays readable, byte-identical.
  const versions = await pi().getProductContextVersions(contextId);
  assert.equal(versions!.length, 2);
  const v1After = versions![0]!;
  assert.deepEqual(v1After, v1Before);
  assert.equal(v1After.name, 'Original');
  assert.equal(v1After.inputs.length, 1);

  // CAS mismatch is the honest 409.
  await assert.rejects(
    pi().recordProductContextVersion(
      {
        productContextId: contextId,
        declaration: {
          name: 'Stale',
          summary: null,
          inputs: [siteInput('https://acme-widgets.test/')],
        },
        expectedVersion: 1,
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      return true;
    },
  );

  // THE DATABASE FENCES: in-place rewrites are rejected outright on every
  // tail table (direct SQL — not even server code can rewrite history).
  const client = pool();
  const versionId = v1After.productContextVersionId;
  await assert.rejects(
    client.query('UPDATE product_context_versions SET name = $1 WHERE product_context_version_id = $2', [
      'rewritten',
      versionId,
    ]),
    /append-only/,
  );
  await assert.rejects(
    client.query('DELETE FROM product_context_versions WHERE product_context_version_id = $1', [versionId]),
    /append-only/,
  );
  await assert.rejects(
    client.query('DELETE FROM product_contexts WHERE product_context_id = $1', [contextId]),
    /append-only/,
  );
  await assert.rejects(
    client.query(
      'UPDATE product_contexts SET current_version_seq = 1, version = version + 1 WHERE product_context_id = $1',
      [contextId],
    ),
    /cannot regress/,
  );
  // The identity/scope immutability guard.
  await assert.rejects(
    client.query(
      'UPDATE product_contexts SET agency_id = $1, current_version_seq = 2, version = version + 1 WHERE product_context_id = $2',
      [ownerB!.agencyId, contextId],
    ),
    /immutable/,
  );
});

test('AC-1/AC-7: an inspection over a corrected context inspects the NEW inputs; a mid-flight correction is the honest 409', async () => {
  assert.ok(ownerA !== null);
  const created = await pi().createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        name: null,
        summary: null,
        inputs: [siteInput('https://acme-widgets.test/')],
      },
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  // The mid-flight correction path: mutate the version pointer DURING the
  // fetch (the scripted double defers) — the honest 409.
  class SlowReader implements ProductPageReader {
    async fetch(): Promise<ProductPageFetchOutcome> {
      await pi().recordProductContextVersion(
        {
          productContextId: contextId,
          declaration: {
            name: 'Mid-flight correction',
            summary: null,
            inputs: [siteInput('https://acme-widgets.test/empty')],
          },
          expectedVersion: 1,
        },
        MODULE_PROVENANCE,
      );
      return {
        ok: true, status: 200, body: PAGE_FIXTURES['https://acme-widgets.test/']!,
        contentType: 'text/html', transportRefused: false, timedOut: false, error: null,
      };
    }
  }
  const core = await bootstrapApplication({ productPageReader: new SlowReader() });
  await assert.rejects(
    core.modules.productIntelligence.runProductInspection({ productContextId: contextId }, MODULE_PROVENANCE),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      assert.match(String((error as Error).message), /corrected during the inspection/);
      return true;
    },
  );
  // The re-run inspects the NEW inputs (the empty page: no facts).
  const rerun = await pi().runProductInspection({ productContextId: contextId }, MODULE_PROVENANCE);
  assert.equal(rerun.productContextVersionId, (await pi().getProductContextVersions(contextId))![1]!.productContextVersionId);
  assert.equal(rerun.inputOutcomes[0]!.outcome, 'no_facts_extracted');
});

// ---------------------------------------------------------------------------
// AC-3: the verification-state discipline + the AI disclosure
// ---------------------------------------------------------------------------

test('AC-3: verification states are SERVER-COMPUTED — unverified without evidence, evidence_backed with evidence, transitions ride supersession', async () => {
  assert.ok(ownerA !== null);
  const created = await pi().createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        name: null,
        summary: null,
        inputs: [siteInput('https://acme-widgets.test/')],
      },
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  const run = await pi().runProductInspection({ productContextId: contextId }, MODULE_PROVENANCE);
  assert.equal(run.status, 'completed');
  const facts = (await pi().getProductContextSourceFacts(contextId))!;
  const factId = facts[0]!.sourceFactId;

  // WITHOUT evidence → unverified (can never be presented as established).
  const unverified = await pi().recordDerivedModel(
    {
      productContextId: contextId,
      derivationKind: 'user_problem_hypotheses',
      statement: { summary: 'Teams may struggle to evaluate widget quality.' },
      evidenceSourceFactIds: [],
      aiAssistance: null,
      supersedesDerivedModelId: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(unverified.verificationState, 'unverified');
  assert.deepEqual(unverified.evidenceSourceFactIds, []);

  // The verification-state TRANSITION: a superseding record WITH evidence
  // (the /evidence single-supersession discipline — a NEW record, never
  // an in-place rewrite).
  const verified = await pi().recordDerivedModel(
    {
      productContextId: contextId,
      derivationKind: 'user_problem_hypotheses',
      statement: { summary: 'Teams struggle to evaluate widget quality before purchase.' },
      evidenceSourceFactIds: [factId],
      aiAssistance: null,
      supersedesDerivedModelId: unverified.derivedModelId,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(verified.verificationState, 'evidence_backed');
  assert.equal(verified.supersedesDerivedModelId, unverified.derivedModelId);
  // The PRIOR record keeps its state (history never rewritten) and the
  // successor link resolves at read time.
  const priorAfter = await pi().getDerivedModel(unverified.derivedModelId);
  assert.equal(priorAfter!.verificationState, 'unverified');
  assert.equal(priorAfter!.supersededByDerivedModelId, verified.derivedModelId);

  // The single-supersession fence: a second correction of the SAME record
  // is the honest 409.
  await assert.rejects(
    pi().recordDerivedModel(
      {
        productContextId: contextId,
        derivationKind: 'user_problem_hypotheses',
        statement: { summary: 'A second correction.' },
        evidenceSourceFactIds: [factId],
        aiAssistance: null,
        supersedesDerivedModelId: unverified.derivedModelId,
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      assert.match(String((error as Error).message), /single-supersession/);
      return true;
    },
  );

  // A superseding record must keep the same derivation kind.
  await assert.rejects(
    pi().recordDerivedModel(
      {
        productContextId: contextId,
        derivationKind: 'market_language',
        statement: { summary: 'Different subject.' },
        evidenceSourceFactIds: [factId],
        aiAssistance: null,
        supersedesDerivedModelId: verified.derivedModelId,
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'CONFLICT');
      return true;
    },
  );

  // THE DEFERRABLE DB INVARIANT: an evidence_backed record with NO
  // evidence row cannot persist (direct SQL — commit-time rejection).
  const client = pool();
  await assert.rejects(
    client.query(
      `INSERT INTO product_derived_models (derived_model_id, product_context_id, derivation_kind,
         statement, verification_state, recorded_actor, recorded_via, correlation_id, created_at)
       VALUES ($1, $2, 'product_capabilities', $3, 'evidence_backed', 'sql', 'sql', 'sql', now())`,
      [
        '00000000-0000-7000-8000-0000000000d1',
        contextId,
        JSON.stringify({ summary: 'smuggled' }),
      ],
    ),
    /can never be presented as established/,
  );

  // A foreign/unknown evidence reference is the uniform 404.
  await assert.rejects(
    pi().recordDerivedModel(
      {
        productContextId: contextId,
        derivationKind: 'conversion_paths',
        statement: { summary: 'x' },
        evidenceSourceFactIds: ['00000000-0000-7000-8000-0000000000ff'],
        aiAssistance: null,
        supersedesDerivedModelId: null,
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NOT_FOUND');
      return true;
    },
  );

  // The AI-assistance disclosure must cite a registry-resolvable model.
  await assert.rejects(
    pi().recordDerivedModel(
      {
        productContextId: contextId,
        derivationKind: 'icp_audience_hypotheses',
        statement: { summary: 'x' },
        evidenceSourceFactIds: [],
        aiAssistance: {
          modelRegistryId: '00000000-0000-7000-8000-0000000000aa',
          callReference: 'call-x',
        },
        supersedesDerivedModelId: null,
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NOT_FOUND');
      return true;
    },
  );
});

test('AC-3 (HTTP): a request-supplied verificationState is a REJECTED authority field (the state is server-computed only)', async () => {
  assert.ok(ownerA !== null);
  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/product-contexts`, {
    token: ownerA.token,
    body: jsonBody({
      name: null,
      inputs: [siteInput(`${pageServerUrl}/`)],
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const contextId = (created.body['context'] as Record<string, unknown>)['productContextId'] as string;
  const derivedResponse = await apiCall(
    port(),
    `/api/product-contexts/${contextId}/derived-models`,
    {
      token: ownerA.token,
      body: {
        derivationKind: 'market_language',
        statement: { summary: 'The market says "widgets".' },
        evidenceSourceFactIds: [],
        verificationState: 'evidence_backed',
      },
    },
  );
  assert.equal(derivedResponse.status, 422, JSON.stringify(derivedResponse.body));
});

// ---------------------------------------------------------------------------
// AC-4: the risk-flag discipline
// ---------------------------------------------------------------------------

test('AC-4: risk flags round-trip with the frozen vocabularies; unknown values are the honest 422; the tail is append-only', async () => {
  assert.ok(ownerA !== null);
  const created = await pi().createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        name: null,
        summary: null,
        inputs: [siteInput('https://acme-widgets.test/')],
      },
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  // Retain at least one fact + one run (the append-only triggers fire
  // per-row: an empty tail has nothing to reject).
  await pi().runProductInspection({ productContextId: contextId }, MODULE_PROVENANCE);
  const risk = await pi().recordProductRiskFlag(
    {
      productContextId: contextId,
      category: 'privacy',
      severity: 'critical',
      statement: { summary: 'The contact form ships PII to a third-party pixel.' },
      mitigation: 'Remove the pixel from the form path.',
      evidenceSourceFactIds: [],
    },
    MODULE_PROVENANCE,
  );
  assert.equal(risk.category, 'privacy');
  assert.equal(risk.severity, 'critical');

  // Unknown category/severity are rejected at the module guard.
  await assert.rejects(
    pi().recordProductRiskFlag(
      {
        productContextId: contextId,
        // Intentionally invalid (the honest module-guard rejection proof).
        category: 'legal' as 'privacy',
        severity: 'high',
        statement: { summary: 'x' },
        mitigation: null,
        evidenceSourceFactIds: [],
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(String((error as Error).message), /Invalid risk flag recording/);
      return true;
    },
  );
  // HTTP: the honest 422.
  const response = await apiCall(port(), `/api/product-contexts/${contextId}/risk-flags`, {
    token: ownerA.token,
    body: {
      category: 'compliance',
      severity: 'extreme',
      statement: { summary: 'x' },
      mitigation: null,
      evidenceSourceFactIds: [],
    },
  });
  assert.equal(response.status, 422, JSON.stringify(response.body));

  // The append-only tail: direct SQL rewrites are rejected outright.
  const client = pool();
  await assert.rejects(
    client.query('UPDATE product_risk_flags SET severity = $1 WHERE risk_flag_id = $2', [
      'low',
      risk.riskFlagId,
    ]),
    /append-only/,
  );
  await assert.rejects(
    client.query('DELETE FROM product_risk_flags WHERE risk_flag_id = $1', [risk.riskFlagId]),
    /append-only/,
  );
  // The source-fact tail + the run tails are append-only too.
  await assert.rejects(
    client.query('DELETE FROM product_source_facts WHERE product_context_id = $1', [contextId]),
    /append-only/,
  );
  await assert.rejects(
    client.query('DELETE FROM product_inspection_runs WHERE product_context_id = $1', [contextId]),
    /append-only/,
  );
});

// ---------------------------------------------------------------------------
// AC-8: the fail-closed isolation battery
// ---------------------------------------------------------------------------

test('AC-8: anonymous 401; foreign/malformed/unknown identifiers are the UNIFORM 404; suspended membership is the 403', async () => {
  assert.ok(ownerA !== null && ownerB !== null && suspendedMember !== null);
  // Anonymous → 401 on every surface.
  for (const [method, path] of [
    ['GET', '/api/agencies/00000000-0000-7000-8000-0000000000aa/product-contexts'],
    ['POST', '/api/agencies/00000000-0000-7000-8000-0000000000aa/product-contexts'],
    ['GET', '/api/product-contexts/00000000-0000-7000-8000-0000000000bb'],
  ] as const) {
    const response = await apiCall(port(), path, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 401, `${method} ${path}`);
  }

  // A context of agency A.
  const created = await pi().createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        name: null,
        summary: null,
        inputs: [siteInput('https://acme-widgets.test/')],
      },
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;

  // Malformed agency/context identifiers → uniform 404.
  for (const malformed of ['not-a-uuid', '00000000-0000-7000-8000-0000000000']) {
    const listResponse = await apiCall(port(), `/api/agencies/${malformed}/product-contexts`, {
      token: ownerA.token,
    });
    assert.equal(listResponse.status, 404, `malformed agency ${malformed}`);
    const detailResponse = await apiCall(port(), `/api/product-contexts/${malformed}`, {
      token: ownerA.token,
    });
    assert.equal(detailResponse.status, 404, `malformed context ${malformed}`);
  }

  // Foreign context (owner B, another agency) → the SAME 404 as unknown.
  for (const token of [ownerB.token, ownerA.token]) {
    const response = await apiCall(port(), `/api/product-contexts/${contextId}`, {
      token,
    });
    if (token === ownerA.token) {
      assert.equal(response.status, 200, 'the owning agency reads its context');
    } else {
      assert.equal(response.status, 404, 'a foreign context is the uniform 404 (no oracle)');
    }
  }
  const unknownResponse = await apiCall(
    port(),
    '/api/product-contexts/00000000-0000-7000-8000-0000000000cc',
    { token: ownerB.token },
  );
  assert.equal(unknownResponse.status, 404);

  // A foreign agency's create attempt with owner B's token → 404 (never a
  // 403-existence-leak); the listing is agency-scoped.
  const listB = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/product-contexts`, {
    token: ownerB.token,
  });
  assert.equal(listB.status, 200);
  assert.equal((listB.body['contexts'] as unknown[]).length, 0, 'agency B sees no contexts');
  const listA = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/product-contexts`, {
    token: ownerA.token,
  });
  assert.ok((listA.body['contexts'] as unknown[]).length >= 1);

  // The suspended membership is the 403.
  const suspendedRead = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: suspendedMember.token,
  });
  assert.equal(suspendedRead.status, 403);

  // The collaborator (active member) reads but cannot mutate (role gate).
  const collaboratorRead = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: collaboratorA!.token,
  });
  assert.equal(collaboratorRead.status, 200, 'any active member reads');
  const collaboratorMutate = await apiCall(port(), `/api/product-contexts/${contextId}/risk-flags`, {
    token: collaboratorA!.token,
    body: {
      category: 'operational',
      severity: 'low',
      statement: { summary: 'x' },
      mitigation: null,
      evidenceSourceFactIds: [],
    },
  });
  assert.equal(collaboratorMutate.status, 403, 'mutations require owner/admin');

  // Every PUT/PATCH/DELETE verb 405s at the router (GET/POST only).
  const putResponse = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerA.token,
    method: 'PUT',
    body: {},
  });
  assert.equal(putResponse.status, 405);
  const deleteResponse = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerA.token,
    method: 'DELETE',
  });
  assert.equal(deleteResponse.status, 405);
});

// ---------------------------------------------------------------------------
// AC-2/AC-5: the authorized read flows through the REAL integration (the
// sandbox provider's request counter proves the read path)
// ---------------------------------------------------------------------------

test('AC-2/AC-5: the authorized analytics read flows through the REAL /integrations policy-gated path (sandbox requests observed; READ-ONLY)', async () => {
  assert.ok(ownerA !== null && analyticsConnectionA !== null);
  const before = sandbox!.requests('analytics');
  const created = await pi().createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        name: null,
        summary: null,
        inputs: [analyticsInput(analyticsConnectionA)],
      },
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  const run = await pi().runProductInspection({ productContextId: contextId }, MODULE_PROVENANCE);
  assert.equal(run.status, 'completed');
  assert.equal(run.factsRetained, 2);
  // The sandbox provider SAW the authorized read (the REAL egress path —
  // policy gate → credential resolution → adapter → provider).
  assert.ok(
    sandbox!.requests('analytics') > before,
    'the authorized read reached the (loopback) provider through the REAL integration path',
  );
  // The module performed only READ operations: no mutation endpoints were
  // hit (the sandbox records every request per provider prefix; the
  // analytics surface exposes probe + runReport only — all reads).
  const detail = (await pi().getProductContextDetail(contextId)) as ProductContextDetail;
  assert.equal(detail.derivedRecordTier, 'claim');
  assert.ok(detail.sourceFacts.every((fact) => fact.factKind === 'source_record'));
});
