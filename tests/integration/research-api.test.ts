/**
 * MKT-062 integration tests — the /research surface on the real stack
 * (embedded PostgreSQL 18 + real API process — no mocks of platform
 * services; the module-level commands are driven through the SAME
 * in-process application composed against the SAME database the API
 * serves, with the DISCLOSED in-repo page-reader test double supplied
 * through the composition seam — the MKT-034 sanctioned test-harness
 * wiring, the product-intelligence precedent).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-062;
 * spec/architecture-v1.6.md §7):
 *   - GOLDEN PATH: research session with a public web source → research
 *     pass → retained source facts with FULL provenance → evidence-linked
 *     insight with the AI-assistance disclosure → read-back, through BOTH
 *     the module-level operations and the HTTP surfaces;
 *   - PROVENANCE PRESERVATION: every retained fact carries the source
 *     reference, fetched-at, extractor identity, content hash and
 *     extraction notes;
 *   - HONEST OUTCOMES: fetch http/transport errors, empty pages and
 *     authorized reads over operations no adapter declares are recorded
 *     per-source (never invented success);
 *   - VERSION IMMUTABILITY: the declared sources are IMMUTABLE per
 *     version; a correction is a NEW version record; the DB rejects
 *     in-place rewrites outright;
 *   - CLAIM DISCIPLINE (§7: "Model output is a claim unless backed by
 *     evidence"): the verification state is SERVER-COMPUTED; the
 *     unverified → evidence_backed transition rides the
 *     single-supersession chain; the DB deferred invariant rejects a
 *     forged evidence_backed row without evidence;
 *   - FAIL-CLOSED ISOLATION: anonymous 401; foreign/malformed agency/
 *     session identifiers are the UNIFORM 404; a suspended membership is
 *     the 403; every PUT/PATCH/DELETE verb 405s at the router.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
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
  ResearchModuleApi,
  ResearchPageFetchOutcome,
  ResearchPageReader,
  ResearchSessionDetail,
} from '../../src/modules/research/public.ts';
import { hashResearchContent } from '../../src/modules/research/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let research: ResearchModuleApi | null = null;
let sandbox: SandboxProvider | null = null;

// ---------------------------------------------------------------------------
// The DISCLOSED in-repo page-reader test double (the fetcher contract)
// ---------------------------------------------------------------------------

const PAGE_FIXTURES: Readonly<Record<string, string>> = {
  'https://widgets-weekly.test/report': `<!doctype html>
<html lang="en-US">
<head>
  <title>Widgets Weekly — the 2026 trend report</title>
  <meta name="description" content="Widget content trends for 2026.">
  <meta name="keywords" content="widgets, trends, 2026">
  <meta property="og:title" content="Widgets Weekly">
  <meta property="og:description" content="The trend report.">
  <link rel="canonical" href="https://widgets-weekly.test/report">
</head>
<body>
  <h1>The 2026 widget trend report</h1>
  <p>Short-form widget content is growing fastest in Q1.</p>
  <h2>Formats</h2>
  <h3>Timing</h3>
</body>
</html>`,
  'https://widgets-weekly.test/empty': '<html><head></head><body></body></html>',
};

const MISSING_PAGE = 'https://widgets-weekly.test/missing';
const REFUSED_PAGE = 'https://widgets-weekly.test/refused';

class ScriptedResearchPageReader implements ResearchPageReader {
  async fetch(request: { url: string }): Promise<ResearchPageFetchOutcome> {
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
// The loopback page server (for the spawned-process REAL reader)
// ---------------------------------------------------------------------------

let pageServer: http.Server | null = null;
let pageServerUrl = '';

function startPageServer(): Promise<void> {
  return new Promise((resolve) => {
    pageServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathFixtures: Readonly<Record<string, string>> = {
        '/report': PAGE_FIXTURES['https://widgets-weekly.test/report']!,
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

function rs(): ResearchModuleApi {
  if (research === null) throw new Error('application not bootstrapped');
  return research;
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
  actor: 'service:research-integration',
  recordedVia: 'module',
  correlationId: 'integration-research-1',
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
            reason: 'MKT-062 integration-test platform boundary: authorized research reads explicitly allowed',
          },
        ],
        description: `MKT-062 integration-test platform default (${dimension} dimension)`,
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

async function makeClient(agencyId: string, token: string, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['clientId'] as string;
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

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let ownerA: Principal | null = null;
let ownerB: Principal | null = null;
let collaboratorA: { userId: string; token: string } | null = null;
let suspendedMember: { userId: string; token: string; membershipId: string } | null = null;
let registeredModelId: string | null = null;
let analyticsConnectionA: string | null = null;

before(async () => {
  stack = await bootStack('research');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  await startPageServer();
  sandbox = await startSandboxProvider({ analytics: 'ea-fakeSandboxAnalyticsToken' });

  // The sanctioned test-harness wiring: the SAME application composed
  // IN-PROCESS against the SAME database the API serves — with the
  // DISCLOSED in-repo page-reader test double supplied through the
  // composition seam.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({ researchPageReader: new ScriptedResearchPageReader() });
  research = core.modules.research;

  // The /ai-runtime registry model the AI-assistance disclosure cites.
  const model = await core.modules.aiRuntime.registerModel({
    model: {
      providerLabel: 'openrouter',
      modelKey: 'test.research-deriver',
      displayName: 'Test Research Deriver',
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

  ownerA = await makeAgencyOwner('rs-owner-a@marketingos.test');
  ownerB = await makeAgencyOwner('rs-owner-b@marketingos.test');
  collaboratorA = await makeUser('rs-collab-a@marketingos.test', 'collab-password-123');
  const suspendedUser = await makeUser('rs-suspended@marketingos.test', 'suspended-password-123');

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
  const suspended = await apiCall(
    port(),
    `/api/agencies/${ownerA.agencyId}/memberships/${suspendedMember.membershipId}`,
    { token: admin, method: 'PATCH', body: { status: 'disabled', version: 1 } },
  );
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));

  // The authorized-read path: platform policies + credential + a REAL
  // connected generic-analytics integration (the MKT-069 harness
  // precedent) — the research module's repository.read operation over it
  // records the honest read_error outcome (no adapter declares the label).
  await declareIntegrationPolicies();
  const ANALYTICS_TOKEN = 'ea-fakeSandboxAnalyticsToken';
  provisionSecret(
    'mkt062-research-analytics-key-a',
    JSON.stringify({ accessToken: ANALYTICS_TOKEN, webhookSecret: null }),
  );
  const clientAId = await makeClient(ownerA.agencyId, ownerA.token, 'Research Client A');
  const credentialA = await makeCredential(
    ownerA.agencyId,
    ownerA.token,
    'Analytics sandbox research A',
    'mkt062-research-analytics-key-a',
  );
  analyticsConnectionA = await registerAndConnectAnalytics(ownerA.token, clientAId, credentialA);
});

after(async () => {
  if (sandbox !== null) {
    await sandbox.close();
    sandbox = null;
  }
  api?.child.kill('SIGKILL');
  if (pageServer !== null) {
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
// THE GOLDEN PATH — through the module-level operations
// ---------------------------------------------------------------------------

test('AC-1/AC-7 golden path (module-level): public web source → research pass → facts with FULL provenance → evidence-linked insight with AI disclosure → read-back', async () => {
  assert.ok(ownerA !== null && registeredModelId !== null);
  const created = await rs().createResearchSession(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        topic: 'Widget content trends 2026',
        focus: 'Which content formats grow fastest in the widgets niche?',
        sources: [
          { kind: 'web_page', reference: 'https://widgets-weekly.test/report', authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    MODULE_PROVENANCE,
  );
  const sessionId = created.session.researchSessionId;
  assert.equal(created.session.version, 1);
  assert.equal(created.session.currentVersionSeq, 1);
  assert.equal(created.currentVersion.sources.length, 1);
  assert.equal(created.currentVersion.sources[0]!.kind, 'web_page');
  assert.equal(created.currentVersion.sources[0]!.authorization, 'public');

  // THE RESEARCH PASS: the deterministic fetch/extract pipeline.
  const run = await rs().runResearch({ researchSessionId: sessionId }, MODULE_PROVENANCE);
  assert.equal(run.status, 'completed');
  assert.equal(run.sourcesInspected, 1);
  assert.ok(run.factsRetained >= 8, `the deterministic extractor retained the head + headings + excerpt observations (got ${run.factsRetained})`);
  assert.equal(run.sourceOutcomes.length, 1);
  assert.equal(run.sourceOutcomes[0]!.outcome, 'facts_extracted');

  // THE RETAINED FACTS with FULL provenance (§7).
  const detail = (await rs().getResearchSessionDetail(sessionId)) as ResearchSessionDetail;
  assert.equal(detail.derivedRecordTier, 'claim');
  assert.equal(detail.vocabularyVersion, 'rs-vocab-v1');
  const facts = detail.sourceFacts;
  assert.ok(facts.length >= 8);
  const titleFact = facts.find((fact) => fact.factKind === 'page_title')!;
  assert.equal(titleFact.sourceRef, 'https://widgets-weekly.test/report');
  assert.ok(titleFact.fetchedAt.length > 0);
  assert.equal(titleFact.extractor, 'research-html-extract-v1');
  // The CONTENT HASH is the sha256 of the fetched material.
  assert.equal(
    titleFact.contentHash,
    hashResearchContent(PAGE_FIXTURES['https://widgets-weekly.test/report']!),
  );
  assert.ok(titleFact.extractionNotes !== null && titleFact.extractionNotes.length > 0);
  assert.ok(titleFact.provenance.recordedAt.length > 0);

  // THE EVIDENCE-LINKED INSIGHT with the AI-assistance disclosure.
  const evidenceIds = facts.slice(0, 2).map((fact) => fact.sourceFactId);
  const insight = await rs().recordResearchInsight(
    {
      researchSessionId: sessionId,
      derivationKind: 'trend_observation',
      statement: { summary: 'Short-form widget content appears to be growing fastest in Q1 across the observed sources.' },
      evidenceSourceFactIds: evidenceIds,
      aiAssistance: { modelRegistryId: registeredModelId, callReference: 'call-rs-1' },
      supersedesResearchInsightId: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(insight.verificationState, 'evidence_backed');
  assert.deepEqual(insight.evidenceSourceFactIds, evidenceIds);
  assert.equal(insight.aiAssistance?.modelRegistryId, registeredModelId);
  assert.equal(insight.aiAssistance?.callReference, 'call-rs-1');
  assert.ok((insight.aiAssistance?.modelDisplay ?? '').length > 0);
  assert.equal(insight.supersededByResearchInsightId, null);

  // An insight WITHOUT evidence is born unverified — a claim, never
  // established (§7).
  const unverified = await rs().recordResearchInsight(
    {
      researchSessionId: sessionId,
      derivationKind: 'market_note',
      statement: { summary: 'A speculative market note with no cited evidence.' },
      evidenceSourceFactIds: [],
      aiAssistance: null,
      supersedesResearchInsightId: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(unverified.verificationState, 'unverified');
  assert.deepEqual(unverified.evidenceSourceFactIds, []);

  // THE READ-BACK composes the full honest view.
  const readBack = (await rs().getResearchSessionDetail(sessionId)) as ResearchSessionDetail;
  assert.equal(readBack.insights.length, 2);
  assert.equal(readBack.runs.length, 1);
  assert.equal(readBack.versions.length, 1);
});

// ---------------------------------------------------------------------------
// AC-2: honest outcomes (failures are recorded, never invented)
// ---------------------------------------------------------------------------

test('AC-2: fetch http/transport errors, empty pages and adapter-less authorized reads are recorded HONESTLY per source (never invented success)', async () => {
  assert.ok(ownerA !== null && analyticsConnectionA !== null);
  const created = await rs().createResearchSession(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        topic: null,
        focus: null,
        sources: [
          { kind: 'web_page', reference: MISSING_PAGE, authorization: 'public', integrationConnectionId: null },
          { kind: 'news', reference: REFUSED_PAGE, authorization: 'public', integrationConnectionId: null },
          { kind: 'web_page', reference: 'https://widgets-weekly.test/empty', authorization: 'public', integrationConnectionId: null },
          { kind: 'connected_repository', reference: 'https://github.com/acme/widgets', authorization: 'authorized', integrationConnectionId: analyticsConnectionA! },
        ],
      },
    },
    MODULE_PROVENANCE,
  );
  const sessionId = created.session.researchSessionId;
  const run = await rs().runResearch({ researchSessionId: sessionId }, MODULE_PROVENANCE);
  assert.equal(run.status, 'partial');
  assert.equal(run.sourcesInspected, 4);
  assert.equal(run.factsRetained, 0);
  // The per-source outcomes are matched by SOURCE ID (the outcome rows
  // share the same created_at tick, so their storage order is not the
  // declaration order).
  const sourceByPosition = new Map(
    created.currentVersion.sources.map((source) => [source.position, source]),
  );
  const outcomeFor = (position: number) =>
    run.sourceOutcomes.find((outcome) => outcome.sourceId === sourceByPosition.get(position)!.sourceId)!;
  assert.equal(outcomeFor(1).outcome, 'fetch_http_error');
  assert.equal(outcomeFor(2).outcome, 'fetch_transport_error');
  assert.equal(outcomeFor(3).outcome, 'no_facts_extracted');
  // The repository.read label awaits its adapter: the honest read_error
  // capability outcome, never an invented read.
  assert.equal(outcomeFor(4).outcome, 'read_error');
  assert.ok((outcomeFor(4).detail ?? '').includes('repository.read'));

  // All-error sessions report failed.
  const failedSession = await rs().createResearchSession(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        topic: null,
        focus: null,
        sources: [
          { kind: 'web_page', reference: MISSING_PAGE, authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    MODULE_PROVENANCE,
  );
  const failedRun = await rs().runResearch(
    { researchSessionId: failedSession.session.researchSessionId },
    MODULE_PROVENANCE,
  );
  assert.equal(failedRun.status, 'failed');
});

// ---------------------------------------------------------------------------
// AC-1: version immutability (corrections are NEW version records)
// ---------------------------------------------------------------------------

test('AC-1: the declared sources are IMMUTABLE per version — corrections are NEW version records; the DB rejects rewrites; CAS 409', async () => {
  assert.ok(ownerA !== null);
  const created = await rs().createResearchSession(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        topic: 'v1 topic',
        focus: null,
        sources: [
          { kind: 'web_page', reference: 'https://widgets-weekly.test/report', authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    MODULE_PROVENANCE,
  );
  const sessionId = created.session.researchSessionId;

  const corrected = await rs().recordResearchSessionVersion(
    {
      researchSessionId: sessionId,
      declaration: {
        topic: 'v2 topic (corrected)',
        focus: 'A refined focus question.',
        sources: [
          { kind: 'documentation', reference: 'https://docs.widgets.test/guide', authorization: 'public', integrationConnectionId: null },
        ],
      },
      expectedVersion: 1,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(corrected.session.version, 2);
  assert.equal(corrected.session.currentVersionSeq, 2);
  assert.equal(corrected.currentVersion.topic, 'v2 topic (corrected)');
  // The ORIGINAL version stays readable byte-identical.
  const v1 = corrected.versions.find((version) => version.versionSeq === 1)!;
  assert.equal(v1.topic, 'v1 topic');
  assert.equal(v1.sources[0]!.reference, 'https://widgets-weekly.test/report');

  // A stale CAS token is the honest 409.
  await assert.rejects(
    () =>
      rs().recordResearchSessionVersion(
        {
          researchSessionId: sessionId,
          declaration: {
            topic: 'v3 stale',
            focus: null,
            sources: [
              { kind: 'web_page', reference: 'https://docs.widgets.test/x', authorization: 'public', integrationConnectionId: null },
            ],
          },
          expectedVersion: 1,
        },
        MODULE_PROVENANCE,
      ),
    /version mismatch/,
  );

  // The DB rejects in-place rewrites of the version tail outright.
  const versionId = v1.researchSessionVersionId;
  await assert.rejects(
    () =>
      pool().query('UPDATE research_session_versions SET topic = $1 WHERE research_session_version_id = $2', [
        'forged',
        versionId,
      ]),
    /append-only/,
  );
  await assert.rejects(
    () =>
      pool().query('DELETE FROM research_session_versions WHERE research_session_version_id = $1', [
        versionId,
      ]),
    /append-only/,
  );
  // The session record itself is never deleted.
  await assert.rejects(
    () => pool().query('DELETE FROM research_sessions WHERE research_session_id = $1', [sessionId]),
    /cannot be deleted/,
  );
});

// ---------------------------------------------------------------------------
// AC-3: the claim discipline (server-computed verification + supersession)
// ---------------------------------------------------------------------------

test('AC-3: verification states are SERVER-COMPUTED; the unverified → evidence_backed transition rides the single-supersession chain; the DB invariant rejects forged rows', async () => {
  assert.ok(ownerA !== null);
  const created = await rs().createResearchSession(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        topic: null,
        focus: null,
        sources: [
          { kind: 'web_page', reference: 'https://widgets-weekly.test/report', authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    MODULE_PROVENANCE,
  );
  const sessionId = created.session.researchSessionId;
  await rs().runResearch({ researchSessionId: sessionId }, MODULE_PROVENANCE);
  const detail = (await rs().getResearchSessionDetail(sessionId)) as ResearchSessionDetail;
  const factId = detail.sourceFacts[0]!.sourceFactId;

  // Born unverified (no cited evidence).
  const first = await rs().recordResearchInsight(
    {
      researchSessionId: sessionId,
      derivationKind: 'topic_synthesis',
      statement: { summary: 'An initial unbacked synthesis.' },
      evidenceSourceFactIds: [],
      aiAssistance: null,
      supersedesResearchInsightId: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(first.verificationState, 'unverified');

  // The correction: a NEW evidence-backed record superseding the prior.
  const second = await rs().recordResearchInsight(
    {
      researchSessionId: sessionId,
      derivationKind: 'topic_synthesis',
      statement: { summary: 'A corrected synthesis citing the retained evidence.' },
      evidenceSourceFactIds: [factId],
      aiAssistance: null,
      supersedesResearchInsightId: first.researchInsightId,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(second.verificationState, 'evidence_backed');
  assert.equal(second.supersedesResearchInsightId, first.researchInsightId);

  // Double supersession is the honest 409 (the single-supersession fence).
  await assert.rejects(
    () =>
      rs().recordResearchInsight(
        {
          researchSessionId: sessionId,
          derivationKind: 'topic_synthesis',
          statement: { summary: 'A second correction.' },
          evidenceSourceFactIds: [factId],
          aiAssistance: null,
          supersedesResearchInsightId: first.researchInsightId,
        },
        MODULE_PROVENANCE,
      ),
    /single-supersession fence/,
  );

  // The prior record is superseded at read time.
  const prior = (await rs().getResearchInsight(first.researchInsightId))!;
  assert.equal(prior.supersededByResearchInsightId, second.researchInsightId);

  // A FOREIGN source fact id is the uniform 404 (never an oracle).
  await assert.rejects(
    () =>
      rs().recordResearchInsight(
        {
          researchSessionId: sessionId,
          derivationKind: 'market_note',
          statement: { summary: 'Citing a foreign fact.' },
          evidenceSourceFactIds: ['99999999-9999-9999-9999-999999999999'],
          aiAssistance: null,
          supersedesResearchInsightId: null,
        },
        MODULE_PROVENANCE,
      ),
    /source fact/,
  );

  // THE DEFERRABLE DB INVARIANT: a forged evidence_backed row without
  // evidence cannot commit.
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO research_insights (research_insight_id, research_session_id, derivation_kind,
                                          statement, verification_state, supersedes_research_insight_id,
                                          recorded_actor, recorded_via, correlation_id, created_at)
         VALUES ($1, $2, 'market_note', '{"summary": "forged"}', 'evidence_backed', NULL, 'forged', 'sql', 'forged', now())`,
        ['88888888-8888-8888-8888-888888888888', sessionId],
      ),
    /can never be presented as established/,
  );

  // A forged evidence link across sessions cannot persist either.
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO research_insight_evidence (research_insight_id, source_fact_id, position)
         VALUES ($1, $2, 1)`,
        [second.researchInsightId, '99999999-9999-9999-9999-999999999999'],
      ),
    /crosses a research session boundary|violates foreign key/,
  );
});

// ---------------------------------------------------------------------------
// AC-7 (HTTP): the golden path through the spawned API + the REAL reader
// ---------------------------------------------------------------------------

test('AC-7 golden path (HTTP): the REAL ResearchHttpPageReader serves the spawned-process research pass over the loopback page server', async () => {
  assert.ok(ownerA !== null);
  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/research-sessions`, {
    token: ownerA.token,
    body: {
      topic: 'HTTP golden path',
      focus: 'Does the REAL reader fetch the loopback page?',
      sources: [
        { kind: 'web_page', reference: `${pageServerUrl}/report`, authorization: 'public' },
      ],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sessionId = (created.body['session'] as Record<string, unknown>)['researchSessionId'] as string;

  const run = await apiCall(port(), `/api/research-sessions/${sessionId}/runs`, {
    token: ownerA.token,
    body: {},
  });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body['status'], 'completed');
  assert.ok((run.body['factsRetained'] as number) >= 8);

  // The facts carry FULL provenance through the HTTP surface.
  const facts = await apiCall(port(), `/api/research-sessions/${sessionId}/facts`, {
    token: ownerA.token,
  });
  assert.equal(facts.status, 200);
  const factList = facts.body['sourceFacts'] as Record<string, unknown>[];
  const titleFact = factList.find((fact) => fact['factKind'] === 'page_title')!;
  assert.equal(titleFact['extractor'], 'research-html-extract-v1');
  assert.match(String(titleFact['contentHash']), /^[0-9a-f]{64}$/);

  // The read-back carries the claim-tier disclosure.
  const detail = await apiCall(port(), `/api/research-sessions/${sessionId}`, {
    token: ownerA.token,
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.body['derivedRecordTier'], 'claim');

  // The insight POST with a request-supplied verificationState is the 422
  // (the state is SERVER-COMPUTED — a rejected authority field).
  const firstFactId = factList[0]!['sourceFactId'] as string;
  const rejected = await apiCall(port(), `/api/research-sessions/${sessionId}/insights`, {
    token: ownerA.token,
    body: {
      derivationKind: 'trend_observation',
      statement: { summary: 'An honest synthesis.' },
      evidenceSourceFactIds: [firstFactId],
      verificationState: 'evidence_backed',
    },
  });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.body));

  const insight = await apiCall(port(), `/api/research-sessions/${sessionId}/insights`, {
    token: ownerA.token,
    body: {
      derivationKind: 'trend_observation',
      statement: { summary: 'An honest synthesis over the HTTP-read facts.' },
      evidenceSourceFactIds: [firstFactId],
    },
  });
  assert.equal(insight.status, 201, JSON.stringify(insight.body));
  assert.equal(insight.body['verificationState'], 'evidence_backed');
});

// ---------------------------------------------------------------------------
// AC-8: fail-closed isolation
// ---------------------------------------------------------------------------

test('AC-8: anonymous 401; foreign/malformed/unknown identifiers are the UNIFORM 404; a suspended membership is the 403; PUT/DELETE 405', async () => {
  assert.ok(ownerA !== null && ownerB !== null && suspendedMember !== null);
  // Anonymous calls fail closed at the authenticator.
  const anonymous = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/research-sessions`, {
    body: { sources: [{ kind: 'web_page', reference: 'https://a.test/', authorization: 'public' }] },
  });
  assert.equal(anonymous.status, 401);

  // Create one session in agency A.
  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/research-sessions`, {
    token: ownerA.token,
    body: {
      topic: 'isolation',
      sources: [{ kind: 'web_page', reference: 'https://widgets-weekly.test/report', authorization: 'public' }],
    },
  });
  assert.equal(created.status, 201);
  const sessionId = (created.body['session'] as Record<string, unknown>)['researchSessionId'] as string;

  // A foreign owner sees the uniform 404 (no cross-agency oracle).
  const foreign = await apiCall(port(), `/api/research-sessions/${sessionId}`, {
    token: ownerB.token,
  });
  assert.equal(foreign.status, 404);
  // Malformed and unknown identifiers are indistinguishable.
  for (const badId of ['not-a-uuid', '99999999-9999-9999-9999-999999999999']) {
    const malformed = await apiCall(port(), `/api/research-sessions/${badId}`, {
      token: ownerA.token,
    });
    assert.equal(malformed.status, 404);
    const foreignAgency = await apiCall(port(), `/api/agencies/${badId}/research-sessions`, {
      token: ownerA.token,
    });
    assert.equal(foreignAgency.status, 404);
  }

  // A suspended membership is the 403.
  const suspended = await apiCall(port(), `/api/research-sessions/${sessionId}`, {
    token: suspendedMember.token,
  });
  assert.equal(suspended.status, 403);

  // Every non-GET/POST verb 405s at the router.
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const verb = await apiCall(port(), `/api/research-sessions/${sessionId}`, {
      token: ownerA.token,
      method,
      body: {},
    });
    assert.equal(verb.status, 405);
  }

  // An agency_operator may read but not mutate (the owner|admin fence).
  assert.ok(collaboratorA !== null);
  const read = await apiCall(port(), `/api/research-sessions/${sessionId}`, {
    token: collaboratorA.token,
  });
  assert.equal(read.status, 200);
  const mutate = await apiCall(port(), `/api/research-sessions/${sessionId}/runs`, {
    token: collaboratorA.token,
    body: {},
  });
  assert.equal(mutate.status, 403);
});

// ---------------------------------------------------------------------------
// AC-8: the module-level cross-agency fence
// ---------------------------------------------------------------------------

test('AC-8 (module-level): a foreign agency session is the uniform null — never an oracle; append-only fact tails reject direct SQL', async () => {
  assert.ok(ownerB !== null);
  const sessions = await rs().listResearchSessionsForAgency(ownerB.agencyId);
  assert.ok(Array.isArray(sessions));

  // Foreign resolution is indistinguishable from unknown.
  assert.equal(await rs().resolveResearchSessionOwnership('99999999-9999-9999-9999-999999999999'), null);
  assert.equal(await rs().getResearchSessionDetail('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), null);

  // The fact tail is append-only even against direct SQL (a REAL fact row
  // — the row-level triggers fire on matched rows).
  const created = await rs().createResearchSession(
    {
      agencyId: ownerB.agencyId,
      declaration: {
        topic: null,
        focus: null,
        sources: [
          { kind: 'web_page', reference: 'https://widgets-weekly.test/report', authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    MODULE_PROVENANCE,
  );
  const sessionId = created.session.researchSessionId;
  await rs().runResearch({ researchSessionId: sessionId }, MODULE_PROVENANCE);
  const detail = (await rs().getResearchSessionDetail(sessionId)) as ResearchSessionDetail;
  const factId = detail.sourceFacts[0]!.sourceFactId;
  await assert.rejects(
    () =>
      pool().query('UPDATE research_source_facts SET source_ref = $1 WHERE research_source_fact_id = $2', [
        'https://forged.test/',
        factId,
      ]),
    /append-only/,
  );
  await assert.rejects(
    () =>
      pool().query('DELETE FROM research_source_facts WHERE research_source_fact_id = $1', [
        factId,
      ]),
    /append-only/,
  );
});
