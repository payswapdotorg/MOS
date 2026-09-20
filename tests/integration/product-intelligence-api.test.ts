/**
 * MKT-069 integration tests — the Product Intelligence surface on the real
 * stack (embedded PostgreSQL 18 + real API process; the
 * growth-missions/social-accounts precedent).
 *
 * Provider-boundary doubles (the DISCLOSED test-double discipline — the
 * social-accounts oauth-provider precedent; NO live network in the test
 * suite):
 *   - the FETCHER double: a deterministic URL→content map through the
 *     AppOptions.productSourceFetcher composition seam (the inspection
 *     pipeline under test is fully real);
 *   - the INTEGRATIONS/AI-RUNTIME port doubles at the module boundary for
 *     the module-level authorized-read + ai-assistance positive paths
 *     (repo/workspace-capable adapters and routed model calls arrive with
 *     later Work Items — the module composes the ports, which the real
 *     public contracts satisfy in production);
 *   - the LOCAL loopback fixture-page server for the PRODUCTION-fetcher
 *     HTTP inspection path (http loopback is the HttpCallPort's disclosed
 *     local allowance) + the DISCLOSED LOCAL oauth provider double for
 *     the REAL CRM integration connect probe (the social-accounts
 *     precedent — a test double at the provider boundary ONLY).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-069; the dispatch
 * acceptance criteria AC-1..AC-8):
 *   - AC-7 GOLDEN PATH: product context with public URL → inspection →
 *     source facts → derived model with evidence links → risk flags →
 *     read-back, through BOTH the module-level operations and the HTTP
 *     surfaces; an explicitly-authorized repo input AND a non-authorized
 *     repo input (rejected honestly) both exercised;
 *   - AC-1 VERSION IMMUTABILITY: the declared content is stored verbatim;
 *     a correction is a NEW version record; the DB rejects in-place
 *     rewrites outright (direct SQL on every table);
 *   - AC-2 INSPECTION DISCIPLINE: failed fetch/read fails the whole
 *     inspection (all-or-nothing, nothing persists); an unchanged source
 *     never re-appends (the honest conflict); every fact carries FULL
 *     provenance (source URL, fetched-at, extractor identity, content
 *     hash, extraction notes);
 *   - AC-3 DERIVED-MODEL DISCIPLINE: verification states are
 *     server-derived (unverified without backing; evidence_backed with);
 *     hypotheses stay hypotheses; repetition is rejected; evidence
 *     citations validate through /evidence; the ai-assistance disclosure
 *     cross-checks through /ai-runtime;
 *   - AC-8 FAIL-CLOSED ISOLATION: anonymous 401; foreign/malformed ≡
 *     unknown 404; suspended membership 403; cross-agency fact/evidence
 *     linkage rejected.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { startLocalOAuthProvider, type LocalOAuthProvider } from './helpers/oauth-provider.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import { createProductIntelligenceModule } from '../../src/modules/product-intelligence/public.ts';
import type {
  ProductIntelligenceAiRuntimePort,
  ProductIntelligenceIntegrationsPort,
  ProductIntelligenceModuleApi,
  ProductSourceFetcher,
} from '../../src/modules/product-intelligence/public.ts';
import type { EvidenceModuleApi } from '../../src/modules/evidence/public.ts';
import type { ProductContextDeclaration } from '../../src/modules/product-intelligence/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const CRM_SECRET_HANDLE = 'product-intelligence-test-crm-key';
const CRM_SECRET_MATERIAL = JSON.stringify({
  accessToken: 'sandbox-crm-bearer-fixture-material',
});

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let productIntelligence: ProductIntelligenceModuleApi | null = null;
let piWithDoubles: ProductIntelligenceModuleApi | null = null;
let evidenceModule: EvidenceModuleApi | null = null;
let oauthProvider: LocalOAuthProvider | null = null;

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

// ---------------------------------------------------------------------------
// The disclosed provider-boundary doubles
// ---------------------------------------------------------------------------

/** The deterministic fetcher double (the URL→content map; NO live network). */
function createFetcherDouble(fixtures: ReadonlyMap<string, string>): ProductSourceFetcher {
  return {
    async fetch(url) {
      const body = fixtures.get(url);
      return {
        url,
        ok: body !== undefined,
        status: body === undefined ? 404 : 200,
        contentType: body === undefined ? null : 'text/html; charset=utf-8',
        body: body ?? null,
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}

/** One authorized-record shape served by the integrations double. */
interface StubRecord {
  readonly providerRecordId: string;
  readonly data: Record<string, unknown>;
  readonly sourceTimestamp: string | null;
  readonly etag: string | null;
  readonly sourceVersion: string | null;
}

/** A configurable /integrations port double (authorized reads). */
function createIntegrationsDouble(
  connections: Map<string, { agencyId: string; status: string; records: StubRecord[] }>,
): ProductIntelligenceIntegrationsPort {
  return {
    async resolveConnectionOwnership(connectionId) {
      const connection = connections.get(connectionId);
      if (connection === undefined) return null;
      return {
        scope: { agencyId: connection.agencyId, clientId: 'client-of-connection', connectionId },
        connection: {
          connectionId,
          clientId: 'client-of-connection',
          agencyId: connection.agencyId,
          status: connection.status,
        },
      };
    },
    async executeRead(input) {
      const connection = connections.get(input.connectionId);
      if (connection === undefined) {
        return { ok: false, records: [], error: 'unknown connection' };
      }
      return { ok: true, records: connection.records, error: null };
    },
  };
}

/** A configurable /ai-runtime port double (selection-decision lookups). */
function createAiRuntimeDouble(
  decisions: Map<string, { agencyId: string; chosenModelRegistryId: string }>,
): ProductIntelligenceAiRuntimePort {
  return {
    async getSelectionDecision(selectionId) {
      const decision = decisions.get(selectionId);
      if (decision === undefined) return null;
      return {
        selectionId,
        agencyId: decision.agencyId,
        chosenModelRegistryId: decision.chosenModelRegistryId,
      };
    },
  };
}

/** The loopback fixture-page server (the production-fetcher HTTP path). */
async function startFixturePageServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const page = `<!doctype html><html><head><title>Fixture Product</title>
<meta name="description" content="The loopback fixture product page.">
</head><body><h1>Fixture Product</h1><p>Served from the test process.</p>
<a href="/pricing">Pricing</a></body></html>`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/product.html`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
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

/** JSON-null-stripping serializer (nulls ride the module inputs, not the DTOs). */
function jsonBody(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || entry === undefined) continue;
    if (Array.isArray(entry)) {
      out[key] = entry.map((item) =>
        typeof item === 'object' && item !== null ? jsonBody(item) : item,
      );
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
let ownerB: Principal = null as unknown as Principal;
let collaboratorA: User | null = null;
let fixtureServer: { url: string; stop: () => Promise<void> } | null = null;
const stubConnections = new Map<string, { agencyId: string; status: string; records: StubRecord[] }>();
const stubDecisions = new Map<string, { agencyId: string; chosenModelRegistryId: string }>();
const PUBLIC_PAGE_URL = 'https://payswap-fixture.example.com/product';
const FETCHER_FIXTURES = new Map<string, string>([
  [
    PUBLIC_PAGE_URL,
    `<!doctype html><html><head><title>PaySwap Pro — Crypto Payments</title>
<meta name="description" content="Accept crypto payments at checkout with no volatility.">
</head><body><h1>Accept crypto payments</h1>
<h2>Automatic fiat settlement</h2>
<p>PaySwap Pro lets online stores accept stablecoin payments.</p>
<a href="/pricing">Pricing</a></body></html>`,
  ],
]);

before(async () => {
  stack = await bootStack('product_intelligence');
  // The CRED-001 secret-handle fixture (the extensions-api/social-accounts
  // precedent): the credential authority resolves a REAL handle in the fs
  // secret backend; only the reference id ever lands in the connection row.
  fs.writeFileSync(`${stack.env.secretsDir}/${CRM_SECRET_HANDLE}.secret`, CRM_SECRET_MATERIAL, {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-034/social-accounts
  // precedent): the SAME application composed IN-PROCESS against the SAME
  // database the API serves — with the DISCLOSED fetcher double through
  // the AppOptions composition seam.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({
    productSourceFetcher: createFetcherDouble(FETCHER_FIXTURES),
  });
  productIntelligence = core.modules.productIntelligence;
  evidenceModule = core.modules.evidence;

  ownerA = await makeAgencyOwner('pi-owner-a@marketingos.test');
  ownerB = await makeAgencyOwner('pi-owner-b@marketingos.test');
  collaboratorA = await makeUser('pi-collab-a@marketingos.test', 'collab-password-123');
  const admin = await adminToken();
  const join = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/memberships`, {
    token: admin,
    body: { userId: collaboratorA.userId, role: 'agency_operator' },
  });
  assert.equal(join.status, 201, JSON.stringify(join.body));

  // A SECOND module instance with the port doubles (the authorized-read +
  // ai-assistance positive paths; the ports the real public contracts
  // satisfy in production) — the module under test is fully real, sharing
  // the same database.
  piWithDoubles = createProductIntelligenceModule({
    db: core.services.db,
    clock: core.services.clock,
    ids: core.services.ids,
    agencies: core.modules.agencies,
    evidence: core.modules.evidence,
    aiRuntime: createAiRuntimeDouble(stubDecisions),
    integrations: createIntegrationsDouble(stubConnections),
    fetcher: createFetcherDouble(FETCHER_FIXTURES),
  });

  fixtureServer = await startFixturePageServer();
  // The loopback fixture page is ALSO registered in the double's map (the
  // module-level instances serve the same fixture content deterministically).
  FETCHER_FIXTURES.set(
    fixtureServer.url,
    `<!doctype html><html><head><title>Fixture Product</title>
<meta name="description" content="The loopback fixture product page.">
</head><body><h1>Fixture Product</h1><p>Served from the test process.</p>
<a href="/pricing">Pricing</a></body></html>`,
  );
  oauthProvider = await startLocalOAuthProvider();

  // The policy allowances are declared ONCE per agency (the policies
  // active-version fence — the social-accounts precedent); the CRM
  // connection fixtures below consume them.
  await allowAll(ownerA, 'network');
  await allowAll(ownerA, 'secrets');
});

after(async () => {
  await fixtureServer?.stop();
  await oauthProvider?.close();
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Declaration fixtures
// ---------------------------------------------------------------------------

function publicInputDeclaration(url: string) {
  return {
    inputKind: 'public_site_url' as const,
    reference: url,
    authorizationState: 'public' as const,
    authorizationRef: null,
    notes: null,
  };
}

function authorizedRepoInputDeclaration(authorizationRef: string) {
  return {
    inputKind: 'source_code_repository_url' as const,
    reference: 'https://github.com/payswapdotorg/MOS',
    authorizationState: 'explicitly_authorized' as const,
    authorizationRef,
    notes: 'the explicitly authorized repository',
  };
}

function contextDeclaration(
  inputs: ReadonlyArray<ProductContextDeclaration['inputs'][number]>,
): ProductContextDeclaration {
  return {
    name: 'PaySwap Pro',
    summary: 'The crypto payments product',
    inputs,
  };
}

/**
 * Wires the stub authorized-read + ai-disclosure fixtures for an agency:
 * the stub connection is ANCHORED to a REAL connected integration row
 * (the FK anchor requires a real /integrations connection; the double
 * serves the records the real repo/workspace adapters will serve later).
 */
async function wireStubAuthorization(principal: Principal): Promise<{
  readonly connectionId: string;
  readonly selectionId: string;
  readonly modelId: string;
}> {
  const client = await makeClient(principal.agencyId, principal.token, `PI Stub Client ${crmConnectionCounter + 1}`);
  const { connectionId } = await makeConnectedCrmConnection(principal, client);
  const selectionId = '22222222-3333-4444-8555-666666666666';
  const modelId = '33333333-4444-5555-8666-777777777777';
  stubConnections.set(connectionId, {
    agencyId: principal.agencyId,
    status: 'connected',
    records: [
      {
        providerRecordId: 'repo:README.md',
        data: { path: 'README.md', language: 'markdown', contentPreview: '# MOS — the marketing operating system' },
        sourceTimestamp: '2026-01-01T00:00:00.000Z',
        etag: 'readme-v1',
        sourceVersion: '0bad0ff',
      },
      {
        providerRecordId: 'repo:package.json',
        data: { path: 'package.json', language: 'json', contentPreview: '{"name":"marketingos"}' },
        sourceTimestamp: '2026-01-01T00:00:00.000Z',
        etag: 'package-v1',
        sourceVersion: '0bad0ff',
      },
    ],
  });
  stubDecisions.set(selectionId, { agencyId: principal.agencyId, chosenModelRegistryId: modelId });
  return { connectionId, selectionId, modelId };
}

/** Declares an AGENCY policy version allowing every operation on a dimension. */
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

let crmConnectionCounter = 0;

/**
 * Creates a CRM credential reference + registers + CONNECTS the integration
 * (the social-accounts fixture; the agency policy allowances must already
 * be declared — the policies active-version fence).
 */
async function makeConnectedCrmConnection(
  principal: Principal,
  clientId: string,
): Promise<{ connectionId: string }> {
  crmConnectionCounter += 1;
  const credential = await apiCall(port(), `/api/agencies/${principal.agencyId}/credentials`, {
    token: principal.token,
    body: {
      kind: 'integration_api_key',
      label: `product_intelligence_crm_key_${crmConnectionCounter}`,
      secretHandle: CRM_SECRET_HANDLE,
    },
  });
  assert.equal(credential.status, 201, JSON.stringify(credential.body));
  const credentialId = credential.body['credentialId'] as string;

  const registered = await apiCall(port(), `/api/clients/${clientId}/connections`, {
    token: principal.token,
    body: {
      adapterKey: 'crm',
      credentialReferenceId: credentialId,
      providerConfig: { apiBaseUrl: oauthProvider!.url },
    },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const connectionId = registered.body['connectionId'] as string;

  const connected = await apiCall(
    port(),
    `/api/clients/${clientId}/connections/${connectionId}/connect`,
    { token: principal.token, body: { expectedVersion: 1 } },
  );
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  return { connectionId };
}

// ---------------------------------------------------------------------------
// AC-7: THE GOLDEN PATH — module-level (public URL + authorized repo input)
// ---------------------------------------------------------------------------

test('AC-7 golden path (module): public URL → inspection → source facts → derived models with evidence links → risk flags → read-back', async () => {
  assert.ok(ownerA !== null);
  const owner: Principal = ownerA;
  const { connectionId, selectionId, modelId } = await wireStubAuthorization(owner);

  // 1. CREATE the context with a PUBLIC input + an EXPLICITLY-AUTHORIZED
  //    repo input (the authorization resolves through the integrations
  //    port — unknown/foreign would be the uniform 404).
  const created = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([
        publicInputDeclaration(PUBLIC_PAGE_URL),
        authorizedRepoInputDeclaration(connectionId),
      ]),
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  assert.equal(created.context.version, 1);
  assert.equal(created.context.currentVersionSeq, 1);
  assert.equal(created.context.agencyId, ownerA.agencyId);
  assert.equal(created.currentVersion.name, 'PaySwap Pro');
  assert.equal(created.inputs.length, 2);
  assert.equal(created.inputs[0]!.authorizationState, 'public');
  assert.equal(created.inputs[0]!.authorizationRef, null);
  assert.equal(created.inputs[1]!.authorizationState, 'explicitly_authorized');
  assert.equal(created.inputs[1]!.authorizationRef, connectionId);
  assert.equal(created.vocabularyVersion, 'pi-vocab-v1');
  assert.equal(created.inspectionCapability, 'source-inspection:fetch-read-only');

  // 2. INSPECT (read-only; deterministic fetch + authorized read).
  const inspected = await piWithDoubles!.inspectProductContext(
    { productContextId: contextId, expectedVersion: 1 },
    MODULE_PROVENANCE,
  );
  // 3 facts: the public page (site extractor) + 2 authorized records.
  assert.equal(inspected.sourceFacts.length, 3);
  const siteFact = inspected.sourceFacts.find((fact) => fact.sourceUrl === PUBLIC_PAGE_URL)!;
  assert.ok(siteFact !== undefined);
  assert.equal(siteFact.extractor, 'site-page-extractor-v1');
  assert.match(siteFact.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(siteFact.fetchedAt.length > 0);
  assert.ok(siteFact.extractionNotes!.includes('content-type='));
  const observation = siteFact.observation as Record<string, unknown>;
  assert.equal(observation['title'], 'PaySwap Pro — Crypto Payments');
  assert.equal(
    observation['metaDescription'],
    'Accept crypto payments at checkout with no volatility.',
  );
  assert.ok((observation['headings'] as string[]).includes('Accept crypto payments'));
  // The authorized facts carry the record identities verbatim.
  const repoFacts = inspected.sourceFacts.filter(
    (fact) => fact.extractor === 'integration-record-extractor-v1',
  );
  assert.equal(repoFacts.length, 2);
  assert.ok(
    repoFacts.some(
      (fact) => (fact.observation as Record<string, unknown>)['providerRecordId'] === 'repo:README.md',
    ),
  );
  // Full provenance on every fact (AC-2).
  for (const fact of inspected.sourceFacts) {
    assert.ok(fact.provenance.actor.length > 0);
    assert.ok(fact.provenance.recordedAt.length > 0);
  }

  // 3. DERIVED MODELS with evidence links: an evidence_backed capability
  //    (backed by the site fact), an unverified hypothesis and an
  //    ai-assisted value proposition.
  const capability = await piWithDoubles!.recordDerivedModel(
    {
      productContextId: contextId,
      derivationKind: 'product_capability',
      statement:
        'The product accepts stablecoin payments at checkout with automatic fiat settlement.',
      detail: { capability: 'crypto-checkout' },
      sourceFactIds: [siteFact.sourceFactId],
      evidenceCitations: [],
      aiAssistance: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(capability.verificationState, 'evidence_backed');
  assert.equal(capability.hypothesis, false);
  assert.deepEqual(capability.sourceFactIds, [siteFact.sourceFactId]);

  const hypothesis = await piWithDoubles!.recordDerivedModel(
    {
      productContextId: contextId,
      derivationKind: 'icp_audience_hypothesis',
      statement:
        'The primary audience may be mid-size online stores already selling internationally.',
      detail: null,
      sourceFactIds: [],
      evidenceCitations: [],
      aiAssistance: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(hypothesis.verificationState, 'unverified');
  assert.equal(hypothesis.hypothesis, true, 'an ICP hypothesis is BORN a hypothesis');

  const aiAssisted = await piWithDoubles!.recordDerivedModel(
    {
      productContextId: contextId,
      derivationKind: 'value_proposition',
      statement: 'Accept crypto without volatility exposure.',
      detail: null,
      sourceFactIds: [siteFact.sourceFactId],
      evidenceCitations: [],
      aiAssistance: { modelIdentity: modelId, callReference: selectionId },
    },
    MODULE_PROVENANCE,
  );
  assert.equal(aiAssisted.verificationState, 'evidence_backed');
  assert.deepEqual(aiAssisted.aiAssistance, { modelIdentity: modelId, callReference: selectionId });

  // 4. A RISK FLAG with the same evidence-backing discipline.
  const risk = await piWithDoubles!.recordRiskFlag(
    {
      productContextId: contextId,
      riskKind: 'compliance',
      severity: 'medium',
      statement: 'The marketing page implies financial-return claims that may need review.',
      sourceFactIds: [siteFact.sourceFactId],
      evidenceCitations: [],
      aiAssistance: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(risk.riskKind, 'compliance');
  assert.equal(risk.severity, 'medium');
  assert.deepEqual(risk.sourceFactIds, [siteFact.sourceFactId]);

  // 5. THE HONEST READ-BACK (module): the composed view carries everything.
  const readBack = await pi().getProductContextDetail(contextId);
  assert.ok(readBack !== null);
  assert.equal(readBack.sourceFacts.length, 3);
  assert.equal(readBack.derivedModels.length, 3);
  assert.equal(readBack.riskFlags.length, 1);
  assert.equal(readBack.derivedModels[0]!.statement, capability.statement);
  assert.equal(readBack.inspectionCapability, 'source-inspection:fetch-read-only');

  // The same durable state reads back through the HTTP surface (the
  // shared database — the module-level records are the API's records).
  const httpRead = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerA.token,
  });
  assert.equal(httpRead.status, 200);
  const httpContext = httpRead.body['context'] as Record<string, unknown>;
  assert.equal(httpContext['productContextId'], contextId);
  const httpDerived = httpRead.body['derivedModels'] as Record<string, unknown>[];
  assert.equal(httpDerived.length, 3);
  assert.equal(httpDerived[1]!['hypothesis'], true);
  assert.equal(httpDerived[1]!['verificationState'], 'unverified');
});

test('AC-7 golden path (HTTP): the PRODUCTION-fetcher inspection over the loopback fixture server (no live network) + the HTTP derived/risk/read-back round trip', async () => {
  assert.ok(ownerA !== null);
  // CREATE over HTTP with a PUBLIC loopback fixture input.
  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/product-contexts`, {
    token: ownerA.token,
    body: jsonBody({
      name: 'Fixture Product',
      summary: 'The loopback fixture product.',
      inputs: [publicInputDeclaration(fixtureServer!.url)],
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const contextId = (created.body['context'] as Record<string, unknown>)['productContextId'] as string;

  // INSPECT over HTTP: the SPAWNED API process uses the PRODUCTION
  // HttpCallPort fetcher — the loopback fixture server is the disclosed
  // local allowance (the oauth-provider precedent).
  const inspected = await apiCall(port(), `/api/product-contexts/${contextId}/inspection`, {
    token: ownerA.token,
    body: { version: 1 },
  });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  const facts = inspected.body['sourceFacts'] as Record<string, unknown>[];
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!['extractor'], 'site-page-extractor-v1');
  const observation = facts[0]!['observation'] as Record<string, unknown>;
  assert.equal(observation['title'], 'Fixture Product');

  // DERIVED + RISK over HTTP (evidence links to the HTTP-inspected fact).
  const sourceFactId = facts[0]!['sourceFactId'] as string;
  const derived = await apiCall(port(), `/api/product-contexts/${contextId}/derived-models`, {
    token: ownerA.token,
    body: jsonBody({
      derivationKind: 'product_capability',
      statement: 'The fixture product serves a public product page.',
      detail: null,
      sourceFactIds: [sourceFactId],
      evidenceCitations: [],
      aiAssistance: null,
    }),
  });
  assert.equal(derived.status, 201, JSON.stringify(derived.body));
  assert.equal(derived.body['verificationState'], 'evidence_backed');
  assert.equal(derived.body['hypothesis'], false);

  const risk = await apiCall(port(), `/api/product-contexts/${contextId}/risk-flags`, {
    token: ownerA.token,
    body: jsonBody({
      riskKind: 'operational',
      severity: 'low',
      statement: 'The fixture page is served from the test process only.',
      sourceFactIds: [sourceFactId],
      evidenceCitations: [],
      aiAssistance: null,
    }),
  });
  assert.equal(risk.status, 201, JSON.stringify(risk.body));

  // The complete read-back through the HTTP surface (AC-7 round trip).
  const readBack = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerA.token,
  });
  assert.equal(readBack.status, 200);
  assert.equal((readBack.body['sourceFacts'] as unknown[]).length, 1);
  assert.equal((readBack.body['derivedModels'] as unknown[]).length, 1);
  assert.equal((readBack.body['riskFlags'] as unknown[]).length, 1);
  assert.equal(readBack.body['inspectionCapability'], 'source-inspection:fetch-read-only');
  assert.equal(readBack.body['vocabularyVersion'], 'pi-vocab-v1');

  // The HTTP mutation verbs 405 (GET/POST only — the surface discipline).
  const put = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerA.token,
    method: 'PUT',
    body: {},
  });
  assert.equal(put.status, 405);
  const del = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerA.token,
    method: 'DELETE',
  });
  assert.equal(del.status, 405);

  // The version correction over HTTP (a NEW version, never a rewrite).
  const corrected = await apiCall(port(), `/api/product-contexts/${contextId}/versions`, {
    token: ownerA.token,
    body: jsonBody({
      name: 'Fixture Product (renamed)',
      summary: 'The corrected summary.',
      inputs: [publicInputDeclaration(fixtureServer!.url)],
      version: 1,
    }),
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  const versionsList = await apiCall(port(), `/api/product-contexts/${contextId}/versions`, {
    token: ownerA.token,
  });
  const versions = versionsList.body['versions'] as Record<string, unknown>[];
  assert.equal(versions.length, 2);
  assert.equal(versions[0]!['name'], 'Fixture Product');
  assert.equal(versions[1]!['name'], 'Fixture Product (renamed)');
});

// ---------------------------------------------------------------------------
// AC-7: the authorized vs NON-AUTHORIZED repo inputs (both exercised)
// ---------------------------------------------------------------------------

test('AC-7 authorized input: the real /integrations path validates the authorization; the non-authorized repo input is rejected honestly', async () => {
  assert.ok(ownerA !== null);
  const clientA = await makeClient(ownerA.agencyId, ownerA.token, 'PI Client A');

  // The NON-AUTHORIZED repo input: an explicitly-authorized input whose
  // authorization reference resolves to NOTHING — the uniform 404 at
  // declaration time (module-level, port double) AND over HTTP (the REAL
  // /integrations module resolves nothing).
  const bogusRef = '99999999-9999-4999-8999-999999999999';
  await assert.rejects(
    piWithDoubles!.createProductContext(
      {
        agencyId: ownerA.agencyId,
        declaration: contextDeclaration([authorizedRepoInputDeclaration(bogusRef)]),
      },
      MODULE_PROVENANCE,
    ),
    (error: unknown) => {
      assert.match(String((error as Error).message), /not found/i);
      return true;
    },
  );
  const httpRejected = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/product-contexts`, {
    token: ownerA.token,
    body: jsonBody(contextDeclaration([authorizedRepoInputDeclaration(bogusRef)])),
  });
  assert.equal(httpRejected.status, 404, JSON.stringify(httpRejected.body));
  // Nothing persisted: no context input carries the bogus reference.
  const leftover = await pool().query(
    `SELECT count(*)::int AS count FROM product_context_inputs WHERE authorization_ref = $1`,
    [bogusRef],
  );
  assert.equal(leftover.rows[0]!.count, 0, 'the non-authorized input never persisted');

  // THE AUTHORIZED INPUT against the REAL /integrations boundary: a REAL
  // connected CRM connection of the same agency authorizes the repo input
  // (the connection registry resolves it — the module validates the
  // authorization through the public contract; no provider read happens
  // for the declaration itself).
  const { connectionId } = await makeConnectedCrmConnection(ownerA, clientA);
  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/product-contexts`, {
    token: ownerA.token,
    body: jsonBody(contextDeclaration([authorizedRepoInputDeclaration(connectionId)])),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const contextId = (created.body['context'] as Record<string, unknown>)['productContextId'] as string;

  // The INSPECTION over HTTP (the REAL integrations read): the CRM
  // adapter declares no 'source.read' capability — the read fails
  // HONESTLY (all-or-nothing; nothing persists). This is the disclosed
  // production posture until repo/workspace-capable adapters land
  // (MKT-062/071 territory); the positive authorized-read path is proven
  // module-level against the port contract (the golden path above).
  const inspected = await apiCall(port(), `/api/product-contexts/${contextId}/inspection`, {
    token: ownerA.token,
    body: { version: 1 },
  });
  assert.equal(inspected.status, 422, JSON.stringify(inspected.body));
  const afterFailedInspection = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerA.token,
  });
  assert.equal(
    (afterFailedInspection.body['sourceFacts'] as unknown[]).length,
    0,
    'the failed inspection persisted nothing (all-or-nothing)',
  );

  // The module-level positive path for the SAME authorization shape: the
  // port double serves the records (the port the real adapters will
  // satisfy) — proving the authorized read pipeline end-to-end, including
  // the non-connected honest refusal.
  stubConnections.set(connectionId, {
    agencyId: ownerA.agencyId,
    status: 'connected',
    records: [
      {
        providerRecordId: 'repo:src/main.ts',
        data: { path: 'src/main.ts', language: 'typescript' },
        sourceTimestamp: null,
        etag: null,
        sourceVersion: 'rev1',
      },
    ],
  });
  const moduleCreated = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([authorizedRepoInputDeclaration(connectionId)]),
    },
    MODULE_PROVENANCE,
  );
  const inspectedModule = await piWithDoubles!.inspectProductContext(
    { productContextId: moduleCreated.context.productContextId, expectedVersion: 1 },
    MODULE_PROVENANCE,
  );
  assert.equal(inspectedModule.sourceFacts.length, 1);
  assert.equal(inspectedModule.sourceFacts[0]!.extractor, 'integration-record-extractor-v1');

  // A NON-CONNECTED authorization is an honest conflict at inspection
  // time (the authorization is not live).
  stubConnections.get(connectionId)!.status = 'registered';
  const declaredSuspended = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([authorizedRepoInputDeclaration(connectionId)]),
    },
    MODULE_PROVENANCE,
  );
  await assert.rejects(
    piWithDoubles!.inspectProductContext(
      { productContextId: declaredSuspended.context.productContextId, expectedVersion: 1 },
      MODULE_PROVENANCE,
    ),
    /registered|connected/i,
  );
  stubConnections.get(connectionId)!.status = 'connected';
});

// ---------------------------------------------------------------------------
// AC-1: version immutability (the correction path + the DB triggers)
// ---------------------------------------------------------------------------

test('AC-1 version immutability: corrections are NEW version records; direct SQL rewrites are rejected outright on every table', async () => {
  assert.ok(ownerA !== null);
  const created = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([publicInputDeclaration(PUBLIC_PAGE_URL)]),
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  await piWithDoubles!.inspectProductContext(
    { productContextId: contextId, expectedVersion: 1 },
    MODULE_PROVENANCE,
  );
  const facts = (await pi().getSourceFacts(contextId))!;
  const factId = facts[0]!.sourceFactId;
  await piWithDoubles!.recordDerivedModel(
    {
      productContextId: contextId,
      derivationKind: 'market_language',
      statement: 'The market language names stablecoins and fiat settlement.',
      detail: null,
      sourceFactIds: [factId],
      evidenceCitations: [],
      aiAssistance: null,
    },
    MODULE_PROVENANCE,
  );
  await piWithDoubles!.recordRiskFlag(
    {
      productContextId: contextId,
      riskKind: 'commercial',
      severity: 'low',
      statement: 'Pricing is not visible on the inspected page.',
      sourceFactIds: [],
      evidenceCitations: [],
      aiAssistance: null,
    },
    MODULE_PROVENANCE,
  );

  // The correction path: a NEW version.
  const corrected = await piWithDoubles!.recordProductContextVersion(
    {
      productContextId: contextId,
      declaration: {
        name: 'PaySwap Pro (renamed)',
        summary: 'The corrected summary.',
        inputs: [publicInputDeclaration(PUBLIC_PAGE_URL)],
      },
      expectedVersion: 1,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(corrected.context.currentVersionSeq, 2);
  assert.equal(corrected.context.version, 2);
  // BOTH versions stay readable; v1 is byte-identical.
  const versions = (await pi().getProductContextVersions(contextId))!;
  assert.equal(versions.length, 2);
  assert.equal(versions[0]!.versionSeq, 1);
  assert.equal(versions[0]!.name, 'PaySwap Pro');
  assert.equal(versions[0]!.summary, 'The crypto payments product');
  assert.equal(versions[1]!.versionSeq, 2);
  assert.equal(versions[1]!.name, 'PaySwap Pro (renamed)');
  // The v1 facts/derived/risk records survive the correction (history is
  // never erased — the ledgers are context-wide).
  const detailAfter = await pi().getProductContextDetail(contextId);
  assert.equal(detailAfter!.sourceFacts.length, 1);
  assert.equal(detailAfter!.derivedModels.length, 1);
  assert.equal(detailAfter!.riskFlags.length, 1);
  // The current version's inputs are the corrected declaration's.
  assert.equal(detailAfter!.inputs.length, 1);
  assert.equal(detailAfter!.currentVersion.name, 'PaySwap Pro (renamed)');

  // The DB rejects in-place rewrites outright (direct SQL).
  await assert.rejects(
    pool().query(
      `UPDATE product_context_versions SET name = 'hacked' WHERE product_context_id = $1`,
      [contextId],
    ),
    /append-only/,
  );
  await assert.rejects(
    pool().query(`DELETE FROM product_context_versions WHERE product_context_id = $1`, [contextId]),
    /append-only/,
  );
  await assert.rejects(
    pool().query(`UPDATE product_context_inputs SET reference = 'https://hacked.example.com'`),
    /append-only/,
  );
  await assert.rejects(pool().query(`DELETE FROM product_context_inputs`), /append-only/);
  await assert.rejects(
    pool().query(`UPDATE product_source_facts SET content_hash = '${'0'.repeat(64)}'`),
    /append-only/,
  );
  await assert.rejects(pool().query(`DELETE FROM product_source_facts`), /append-only/);
  await assert.rejects(
    pool().query(`UPDATE product_derived_models SET statement = 'hacked'`),
    /append-only/,
  );
  await assert.rejects(pool().query(`DELETE FROM product_derived_models`), /append-only/);
  await assert.rejects(
    pool().query(`UPDATE product_risk_flags SET severity = 'high'`),
    /append-only/,
  );
  await assert.rejects(pool().query(`DELETE FROM product_risk_flags`), /append-only/);
  await assert.rejects(
    pool().query(`DELETE FROM product_contexts WHERE product_context_id = $1`, [contextId]),
    /cannot be deleted/,
  );
  // The context-record guard: identity/scope immutable, CAS must advance
  // by exactly one, the pointer never regresses.
  await assert.rejects(
    pool().query(`UPDATE product_contexts SET agency_id = $2 WHERE product_context_id = $1`, [
      contextId,
      ownerB.agencyId,
    ]),
    /immutable/,
  );
  await assert.rejects(
    pool().query(
      `UPDATE product_contexts SET version = version + 2 WHERE product_context_id = $1`,
      [contextId],
    ),
    /exactly one/,
  );
  await assert.rejects(
    pool().query(
      `UPDATE product_contexts SET current_version_seq = 1, version = version + 1 WHERE product_context_id = $1`,
      [contextId],
    ),
    /cannot regress/,
  );
});

// ---------------------------------------------------------------------------
// AC-2: inspection discipline (all-or-nothing + the unchanged-source fence)
// ---------------------------------------------------------------------------

test('AC-2 inspection discipline: a failed fetch fails the whole inspection honestly (nothing persists); an unchanged source never re-appends', async () => {
  assert.ok(ownerA !== null);
  const created = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([
        publicInputDeclaration(PUBLIC_PAGE_URL),
        publicInputDeclaration('https://missing-fixture.example.com/missing'),
      ]),
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  // The second URL has no fixture: the fetch fails → the WHOLE inspection
  // fails (all-or-nothing) — not even the fetchable input's fact persists.
  await assert.rejects(
    piWithDoubles!.inspectProductContext(
      { productContextId: contextId, expectedVersion: 1 },
      MODULE_PROVENANCE,
    ),
    /could not be fetched/,
  );
  assert.equal((await pi().getSourceFacts(contextId))!.length, 0);

  // A single-input context: the first inspection appends; the identical
  // re-inspection conflicts honestly (the unchanged-source fence).
  const single = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([publicInputDeclaration(PUBLIC_PAGE_URL)]),
    },
    MODULE_PROVENANCE,
  );
  await piWithDoubles!.inspectProductContext(
    { productContextId: single.context.productContextId, expectedVersion: 1 },
    MODULE_PROVENANCE,
  );
  await assert.rejects(
    piWithDoubles!.inspectProductContext(
      { productContextId: single.context.productContextId, expectedVersion: 1 },
      MODULE_PROVENANCE,
    ),
    /duplicate key|unchanged/i,
  );
  assert.equal((await pi().getSourceFacts(single.context.productContextId))!.length, 1);

  // A CHANGED source appends a NEW fact (the fence keys on content hash).
  FETCHER_FIXTURES.set(
    PUBLIC_PAGE_URL,
    `${FETCHER_FIXTURES.get(PUBLIC_PAGE_URL)!}<!-- the page changed -->`,
  );
  const reInspected = await piWithDoubles!.inspectProductContext(
    { productContextId: single.context.productContextId, expectedVersion: 1 },
    MODULE_PROVENANCE,
  );
  assert.equal(reInspected.sourceFacts.length, 2);
});

// ---------------------------------------------------------------------------
// AC-3: derived-model discipline (evidence citations, ai disclosure)
// ---------------------------------------------------------------------------

/** Appends one canonical /evidence source_fact under a Client (the real evidence authority). */
async function appendEvidenceForClient(clientId: string): Promise<{ evidenceId: string }> {
  const record = await evidenceModule!.appendEvidence(
    {
      clientId,
      workspaceId: null,
      class: 'source_fact',
      source: { system: 'product-intelligence-integration', ref: 'fixture-evidence-1' },
      observedAt: new Date().toISOString(),
      content: { note: 'a canonical evidence observation for citation validation' },
      contentRef: null,
      quality: 'C',
      confidence: null,
      supersedesEvidenceId: null,
    },
    MODULE_PROVENANCE,
  );
  return { evidenceId: record.evidenceId };
}

test('AC-3 derived-model discipline: /evidence citations validate through the evidence authority; the ai-assistance disclosure is cross-checked; foreign backing fails closed', async () => {
  assert.ok(ownerA !== null);
  const clientA = await makeClient(ownerA.agencyId, ownerA.token, 'PI Evidence Client');
  const created = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([publicInputDeclaration(PUBLIC_PAGE_URL)]),
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;

  // A CANONICAL /evidence record under the SAME agency (the real evidence
  // module through the in-process application): cited as backing.
  const evidenceRecord = await appendEvidenceForClient(clientA);
  const cited = await piWithDoubles!.recordDerivedModel(
    {
      productContextId: contextId,
      derivationKind: 'commercial_metric',
      statement: 'Checkout conversion rate is the metric to optimize.',
      detail: { metric: 'checkout_conversion_rate' },
      sourceFactIds: [],
      evidenceCitations: [evidenceRecord.evidenceId],
      aiAssistance: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(cited.verificationState, 'evidence_backed');
  assert.deepEqual(cited.evidenceCitations, [evidenceRecord.evidenceId]);

  // A CROSS-AGENCY evidence citation → the uniform 404 (no oracle).
  const clientB = await makeClient(ownerB.agencyId, ownerB.token, 'PI Foreign Evidence Client');
  const foreignEvidence = await appendEvidenceForClient(clientB);
  await assert.rejects(
    piWithDoubles!.recordDerivedModel(
      {
        productContextId: contextId,
        derivationKind: 'commercial_metric',
        statement: 'A foreign-cited metric statement.',
        detail: null,
        sourceFactIds: [],
        evidenceCitations: [foreignEvidence.evidenceId],
        aiAssistance: null,
      },
      MODULE_PROVENANCE,
    ),
    /not found/i,
  );

  // A FOREIGN source-fact reference → the uniform 404.
  const otherContext = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([publicInputDeclaration(fixtureServer!.url)]),
    },
    MODULE_PROVENANCE,
  );
  await piWithDoubles!.inspectProductContext(
    { productContextId: otherContext.context.productContextId, expectedVersion: 1 },
    MODULE_PROVENANCE,
  );
  const otherFacts = (await pi().getSourceFacts(otherContext.context.productContextId))!;
  await assert.rejects(
    piWithDoubles!.recordDerivedModel(
      {
        productContextId: contextId,
        derivationKind: 'product_capability',
        statement: 'A statement citing another context fact.',
        detail: null,
        sourceFactIds: [otherFacts[0]!.sourceFactId],
        evidenceCitations: [],
        aiAssistance: null,
      },
      MODULE_PROVENANCE,
    ),
    /not found/i,
  );

  // The ai-assistance disclosure cross-check: a MISMATCHED model identity
  // is an honest conflict; an unknown call reference is the uniform 404.
  const { selectionId, modelId } = await wireStubAuthorization(ownerA);
  await assert.rejects(
    piWithDoubles!.recordDerivedModel(
      {
        productContextId: contextId,
        derivationKind: 'value_proposition',
        statement: 'An ai-assisted statement with a mismatched disclosure.',
        detail: null,
        sourceFactIds: [],
        evidenceCitations: [],
        aiAssistance: { modelIdentity: 'not-the-chosen-model', callReference: selectionId },
      },
      MODULE_PROVENANCE,
    ),
    /mismatch/i,
  );
  await assert.rejects(
    piWithDoubles!.recordDerivedModel(
      {
        productContextId: contextId,
        derivationKind: 'value_proposition',
        statement: 'An ai-assisted statement with an unknown call reference.',
        detail: null,
        sourceFactIds: [],
        evidenceCitations: [],
        aiAssistance: {
          modelIdentity: modelId,
          callReference: '88888888-8888-4888-8888-888888888888',
        },
      },
      MODULE_PROVENANCE,
    ),
    /not found/i,
  );
  // Over HTTP the same unknown call reference is the honest 404 (the REAL
  // /ai-runtime resolves nothing).
  const httpAi = await apiCall(port(), `/api/product-contexts/${contextId}/derived-models`, {
    token: ownerA.token,
    body: jsonBody({
      derivationKind: 'value_proposition',
      statement: 'An HTTP ai-assisted statement with an unknown call reference.',
      detail: null,
      sourceFactIds: [],
      evidenceCitations: [],
      aiAssistance: {
        modelIdentity: modelId,
        callReference: '88888888-8888-4888-8888-888888888888',
      },
    }),
  });
  assert.equal(httpAi.status, 404, JSON.stringify(httpAi.body));

  // REPETITION NEVER PROMOTES (AC-3): the identical derived statement is
  // rejected — restating it with the SAME backing citation changes
  // nothing (the presence of backing never converts a restatement into
  // new evidence).
  await assert.rejects(
    piWithDoubles!.recordDerivedModel(
      {
        productContextId: contextId,
        derivationKind: 'commercial_metric',
        statement: 'Checkout conversion rate is the metric to optimize.',
        detail: null,
        sourceFactIds: [],
        evidenceCitations: [evidenceRecord.evidenceId],
        aiAssistance: null,
      },
      MODULE_PROVENANCE,
    ),
    /never become facts by repetition|already exists/i,
  );
});

// ---------------------------------------------------------------------------
// AC-8: the fail-closed isolation battery
// ---------------------------------------------------------------------------

test('AC-8 fail-closed isolation: anonymous 401; foreign ≡ unknown ≡ malformed 404; suspended membership 403; the operator reads but cannot mutate', async () => {
  assert.ok(ownerA !== null && collaboratorA !== null);
  const collab: User = collaboratorA;
  const created = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([publicInputDeclaration(PUBLIC_PAGE_URL)]),
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;

  // Anonymous calls fail closed 401.
  const anonymous = await apiCall(port(), `/api/product-contexts/${contextId}`);
  assert.equal(anonymous.status, 401);

  // The uniform 404: foreign (owner B), unknown and malformed identifiers
  // are indistinguishable.
  const foreign = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerB.token,
  });
  assert.equal(foreign.status, 404);
  const unknown = await apiCall(
    port(),
    `/api/product-contexts/00000000-0000-4000-8000-000000000000`,
    { token: ownerA.token },
  );
  assert.equal(unknown.status, 404);
  const malformed = await apiCall(port(), `/api/product-contexts/not-a-uuid`, {
    token: ownerA.token,
  });
  assert.equal(malformed.status, 404);
  const foreignList = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/product-contexts`, {
    token: ownerA.token,
  });
  assert.equal(foreignList.status, 404);
  const foreignCreate = await apiCall(
    port(),
    `/api/agencies/${ownerB.agencyId}/product-contexts`,
    {
      token: ownerA.token,
      body: jsonBody(contextDeclaration([publicInputDeclaration(PUBLIC_PAGE_URL)])),
    },
  );
  assert.equal(foreignCreate.status, 404);

  // The collaborator (active operator membership) READS but cannot mutate.
  const read = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: collaboratorA.token,
  });
  assert.equal(read.status, 200);
  const forbiddenCreate = await apiCall(
    port(),
    `/api/agencies/${ownerA.agencyId}/product-contexts`,
    {
      token: collaboratorA.token,
      body: jsonBody(contextDeclaration([publicInputDeclaration(PUBLIC_PAGE_URL)])),
    },
  );
  assert.equal(forbiddenCreate.status, 403);

  // A suspended membership is the 403 (the agencies membership surface —
  // the growth-missions battery pattern: disable by membershipId + CAS).
  const admin = await adminToken();
  const memberships = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/memberships`, {
    token: admin,
  });
  const collaboratorMembership = (
    memberships.body['memberships'] as Record<string, unknown>[]
  ).find((entry) => entry['userId'] === collab.userId)!;
  assert.ok(collaboratorMembership !== undefined, 'the collaborator membership resolves');
  const disabled = await apiCall(
    port(),
    `/api/agencies/${ownerA.agencyId}/memberships/${collaboratorMembership['membershipId'] as string}`,
    {
      token: admin,
      method: 'PATCH',
      body: { status: 'disabled', version: collaboratorMembership['version'] as number },
    },
  );
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  const suspendedRead = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: collab.token,
  });
  assert.equal(suspendedRead.status, 403, 'a suspended membership is the 403');
  // Restore for later batteries.
  const restored = await apiCall(
    port(),
    `/api/agencies/${ownerA.agencyId}/memberships/${collaboratorMembership['membershipId'] as string}`,
    {
      token: admin,
      method: 'PATCH',
      body: { status: 'active', version: disabled.body['version'] as number },
    },
  );
  assert.equal(restored.status, 200);
  // The owner is unaffected (the suspension is membership-scoped).
  const ownerStillReads = await apiCall(port(), `/api/product-contexts/${contextId}`, {
    token: ownerA.token,
  });
  assert.equal(ownerStillReads.status, 200);
});

// ---------------------------------------------------------------------------
// AC-6: the mission attachment seam (read surface only)
// ---------------------------------------------------------------------------

test('AC-6 mission attachment seam: the read surface exposes the model records by canonical reference (no mission-strategy logic exists)', async () => {
  assert.ok(ownerA !== null);
  const created = await piWithDoubles!.createProductContext(
    {
      agencyId: ownerA.agencyId,
      declaration: contextDeclaration([publicInputDeclaration(PUBLIC_PAGE_URL)]),
    },
    MODULE_PROVENANCE,
  );
  const contextId = created.context.productContextId;
  await piWithDoubles!.inspectProductContext(
    { productContextId: contextId, expectedVersion: 1 },
    MODULE_PROVENANCE,
  );
  const facts = (await pi().getSourceFacts(contextId))!;
  await piWithDoubles!.recordDerivedModel(
    {
      productContextId: contextId,
      derivationKind: 'conversion_path',
      statement: 'Ad click → product page → checkout.',
      detail: null,
      sourceFactIds: [facts[0]!.sourceFactId],
      evidenceCitations: [],
      aiAssistance: null,
    },
    MODULE_PROVENANCE,
  );

  // The read surface MKT-070 will attach BY REFERENCE: the ownership
  // resolution + the ledgers, all GET-only over HTTP.
  const ownership = await pi().resolveProductContextOwnership(contextId);
  assert.ok(ownership !== null);
  assert.equal(ownership.scope.kind, 'product-context');
  assert.equal(ownership.scope.agencyId, ownerA.agencyId);
  assert.equal(ownership.agency.status, 'active');

  const derivedList = await apiCall(port(), `/api/product-contexts/${contextId}/derived-models`, {
    token: ownerA.token,
  });
  assert.equal(derivedList.status, 200);
  assert.equal((derivedList.body['derivedModels'] as unknown[]).length, 1);
  const factList = await apiCall(port(), `/api/product-contexts/${contextId}/source-facts`, {
    token: ownerA.token,
  });
  assert.equal((factList.body['sourceFacts'] as unknown[]).length, 1);
  const riskList = await apiCall(port(), `/api/product-contexts/${contextId}/risk-flags`, {
    token: ownerA.token,
  });
  assert.equal(riskList.status, 200);
  assert.equal((riskList.body['riskFlags'] as unknown[]).length, 0);
  const agencyList = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/product-contexts`, {
    token: ownerA.token,
  });
  assert.ok((agencyList.body['productContexts'] as unknown[]).length >= 1);
});
