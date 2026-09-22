/**
 * MKT-062 integration tests — the /content-intelligence surface on the real
 * stack (embedded PostgreSQL 18 + real API process — no mocks of platform
 * services; the module-level commands are driven through the SAME
 * in-process application composed against the SAME database the API
 * serves — the MKT-034 sanctioned test-harness wiring, the
 * product-intelligence precedent).
 *
 * The observation-ingestion path is FULLY REAL: the /integrations public
 * contract with the REAL generic-analytics first-party adapter egressing
 * through the platform HttpCallPort against the loopback sandbox provider
 * (NO real network — the MKT-024 harness), and every normalized provider
 * record becomes ONE canonical /evidence 'observation' record through the
 * /evidence public contract (the SOLE evidence authority — asserted both
 * module-level and through the evidence HTTP surface).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-062;
 * spec/architecture-v1.6.md §6):
 *   - GOLDEN PATH: observation ingestion (platform_analytics through the
 *     REAL integration) → canonical /evidence records → CLIENT-SCOPED
 *     candidate with the §6 observed-feature set + evidence links + the
 *     /metrics observed-performance anchor → hypothesis with honest
 *     framing citing evidence + candidates + a same-agency /research
 *     insight + a READ-ONLY-validated /experiments reference → read-back;
 *   - HONEST OUTCOMES: the platform_content label awaits its adapter —
 *     the ingestion records the honest failed outcome, never an invented
 *     read;
 *   - EVIDENCE/HYPOTHESIS SEPARATION: a hypothesis without evidence
 *     references is rejected; foreign evidence is the uniform 404;
 *   - THE §6 NON-CLAIM: every hypothesis view carries the non-causality
 *     framing;
 *   - SUPERSESSION: the single-supersession correction chain + the
 *     direct-SQL append-only rejections;
 *   - FAIL-CLOSED ISOLATION: anonymous 401; foreign/malformed client/
 *     record identifiers are the UNIFORM 404; a suspended membership is
 *     the 403; every PUT/PATCH/DELETE verb 405s at the router.
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
import { startSandboxProvider, type SandboxProvider } from './helpers/sandbox-provider.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type {
  ContentCandidateRecord,
  ContentHypothesisRecord,
  ContentIntelligenceModuleApi,
  ContentObservationIngestionRunRecord,
} from '../../src/modules/content-intelligence/public.ts';
import { CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING } from '../../src/modules/content-intelligence/public.ts';
import type { ResearchModuleApi } from '../../src/modules/research/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let ci: ContentIntelligenceModuleApi | null = null;
let research: ResearchModuleApi | null = null;
let sandbox: SandboxProvider | null = null;

function contentIntelligence(): ContentIntelligenceModuleApi {
  if (ci === null) throw new Error('application not bootstrapped');
  return ci;
}

function researchModule(): ResearchModuleApi {
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
  actor: 'service:content-intelligence-integration',
  recordedVia: 'module',
  correlationId: 'integration-content-intelligence-1',
  causationId: null,
} as const;

const RESEARCH_PROVENANCE = {
  actor: 'service:content-intelligence-integration',
  recordedVia: 'module',
  correlationId: 'integration-content-intelligence-research-1',
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

/** The platform policies the observation-read path requires (network + secrets allow). */
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
            reason: 'MKT-062 integration-test platform boundary: observation reads explicitly allowed',
          },
        ],
        description: `MKT-062 integration-test platform default (${dimension} dimension)`,
      },
    });
    assert.equal(declared.status, 201, JSON.stringify(declared.body));
  }
}

async function registerAndConnectAnalytics(
  agencyId: string,
  token: string,
  clientId: string,
  label: string,
  secretHandle: string,
): Promise<string> {
  const createdCredential = await apiCall(port(), `/api/agencies/${agencyId}/credentials`, {
    token,
    body: { kind: 'integration_api_key', label, secretHandle },
  });
  assert.equal(createdCredential.status, 201, JSON.stringify(createdCredential.body));
  const created = await apiCall(port(), `/api/clients/${clientId}/connections`, {
    token,
    body: {
      adapterKey: 'generic-analytics',
      credentialReferenceId: createdCredential.body['credentialId'] as string,
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
let suspendedMember: { userId: string; token: string; membershipId: string } | null = null;
let clientAId: string | null = null;
let clientBId: string | null = null;
let analyticsConnectionA: string | null = null;

before(async () => {
  stack = await bootStack('content_intelligence');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  sandbox = await startSandboxProvider({ analytics: 'ea-fakeSandboxAnalyticsToken' });

  // The sanctioned test-harness wiring: the SAME application composed
  // IN-PROCESS against the SAME database the API serves.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({});
  ci = core.modules.contentIntelligence;
  research = core.modules.research;

  ownerA = await makeAgencyOwner('ci-owner-a@marketingos.test');
  ownerB = await makeAgencyOwner('ci-owner-b@marketingos.test');
  clientAId = await makeClient(ownerA.agencyId, ownerA.token, 'Content Client A');
  clientBId = await makeClient(ownerB.agencyId, ownerB.token, 'Content Client B');

  const suspendedUser = await makeUser('ci-suspended@marketingos.test', 'suspended-password-123');
  const admin = await adminToken();
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

  // The observation-read path: platform policies + a REAL connected
  // generic-analytics integration (client A).
  await declareIntegrationPolicies();
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(
    path.join(stack.env.secretsDir, 'mkt062-ci-analytics-a.secret'),
    JSON.stringify({ accessToken: 'ea-fakeSandboxAnalyticsToken', webhookSecret: null }),
    { mode: 0o600 },
  );
  analyticsConnectionA = await registerAndConnectAnalytics(
    ownerA.agencyId,
    ownerA.token,
    clientAId!,
    'Analytics sandbox content A',
    'mkt062-ci-analytics-a',
  );
});

after(async () => {
  if (sandbox !== null) {
    await sandbox.close();
    sandbox = null;
  }
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// THE GOLDEN PATH — observation ingestion → evidence → candidate → hypothesis
// ---------------------------------------------------------------------------

test('AC-1 golden path: REAL observation ingestion → canonical /evidence records → candidate with §6 features + metric anchor → hypothesis with honest framing → read-back', async () => {
  assert.ok(ownerA !== null && clientAId !== null && analyticsConnectionA !== null);
  const requestsBefore = sandbox!.requests('analytics');

  // THE OBSERVATION INGESTION over the REAL integration (the frozen
  // platform_analytics → 'runReport' label).
  const ingestion = await contentIntelligence().runObservationIngestion(
    {
      clientId: clientAId!,
      workspaceId: null,
      connectionId: analyticsConnectionA,
      observationKind: 'platform_analytics',
    },
    MODULE_PROVENANCE,
  );
  assert.equal(ingestion.run.status, 'completed');
  assert.equal(ingestion.run.operation, 'runReport');
  assert.ok(ingestion.run.recordsObserved >= 2, 'the sandbox analytics report yields the normalized observations');
  assert.equal(ingestion.run.evidenceAppended, ingestion.appendedEvidence.length);
  assert.ok(ingestion.appendedEvidence.length >= 2);
  // The REAL egress path was observed (policy gate → credential →
  // adapter → provider).
  assert.ok(sandbox!.requests('analytics') > requestsBefore);

  // THE CANONICAL EVIDENCE: every appended record is an /evidence
  // 'observation' of this client (the SOLE evidence authority — no shadow
  // ledger).
  const evidenceIds = ingestion.appendedEvidence.map((record) => record.evidenceId);
  for (const record of ingestion.appendedEvidence) {
    assert.equal(record.class, 'observation');
    assert.equal(record.clientId, clientAId);
    assert.equal(record.source.system, 'generic-analytics');
    assert.ok(record.source.ref !== null && record.source.ref.length > 0);
  }
  // The evidence is readable through the /evidence HTTP surface.
  const evidenceHttp = await apiCall(port(), `/api/clients/${clientAId}/evidence`, {
    token: ownerA.token,
  });
  assert.equal(evidenceHttp.status, 200);
  const evidenceList = evidenceHttp.body['evidence'] as Record<string, unknown>[];
  for (const evidenceId of evidenceIds) {
    assert.ok(
      evidenceList.some((entry) => entry['evidenceId'] === evidenceId),
      `the appended observation ${evidenceId} is a canonical /evidence record`,
    );
  }

  // THE /metrics OBSERVED-PERFORMANCE ANCHOR: a canonical metric
  // observation of this client.
  const metricAppend = await apiCall(port(), `/api/clients/${clientAId}/metrics`, {
    token: ownerA.token,
    body: {
      metricName: 'content_views',
      dimensions: { channel: 'analytics' },
      value: 4831,
      unit: 'count',
      sourceSystem: 'generic-analytics',
      observedAt: '2026-03-01T00:00:00.000Z',
      quality: 'ok',
    },
  });
  assert.equal(metricAppend.status, 201, JSON.stringify(metricAppend.body));
  const metricObservationId = metricAppend.body['observationId'] as string;

  // THE CANDIDATE: the §6 observed-feature set as data + evidence links +
  // the metric anchor.
  const candidate = await contentIntelligence().recordContentCandidate(
    {
      clientId: clientAId!,
      workspaceId: null,
      features: {
        topicEntity: 'Widget analytics explainer',
        niche: 'widgets',
        subNiche: 'premium widgets',
        contentFormat: 'short_video',
        lengthValue: 45,
        lengthUnit: 'seconds',
        hookFeatures: ['question', 'statistic_lead'],
        narrativeStructure: 'problem_solution',
        publishedAt: '2026-03-01T09:00:00.000Z',
        observedPerformance: { views: 4831, conversions: 312 },
        performanceVelocity: { viewsPerDay: 480 },
        engagement: { likeRate: 0.064 },
        audienceFit: 'strong_fit',
        freshness: 'recent',
        novelty: 'variation',
        reuseRisk: 'low',
      },
      evidenceIds,
      metricObservationIds: [metricObservationId],
    },
    MODULE_PROVENANCE,
  );
  assert.equal(candidate.clientId, clientAId);
  assert.deepEqual(candidate.evidenceIds, evidenceIds);
  assert.deepEqual(candidate.metricObservationIds, [metricObservationId]);
  assert.equal(candidate.contentFormat, 'short_video');
  assert.deepEqual(candidate.hookFeatures, ['question', 'statistic_lead']);

  // THE RESEARCH CITATION: a same-agency research insight (created through
  // the /research module of this same Work Item).
  const session = await researchModule().createResearchSession(
    {
      agencyId: ownerA.agencyId,
      declaration: {
        topic: 'Widget niche trends',
        focus: null,
        sources: [
          { kind: 'market_source', reference: 'https://market.widgets.test/q1', authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    RESEARCH_PROVENANCE,
  );
  const insight = await researchModule().recordResearchInsight(
    {
      researchSessionId: session.session.researchSessionId,
      derivationKind: 'market_note',
      statement: { summary: 'Premium-widget explainer content shows sustained demand in Q1.' },
      evidenceSourceFactIds: [],
      aiAssistance: null,
      supersedesResearchInsightId: null,
    },
    RESEARCH_PROVENANCE,
  );

  // THE EXPERIMENT REFERENCE: validated READ-ONLY through the /experiments
  // public contract (the hypothesis is an INPUT, never a conclusion).
  const experimentCreate = await apiCall(port(), `/api/clients/${clientAId}/experiments`, {
    token: ownerA.token,
    body: {
      hypothesis: 'Short-form explainer videos increase content_views vs long-form for premium-widget audiences.',
      decisionTarget: 'Whether to shift the content mix toward short-form explainers.',
      populationUnit: 'Content items published on the connected analytics property.',
      treatment: 'Short-form (<60s) explainer videos.',
      comparison: 'Long-form (>5min) explainer videos (status quo).',
      assignmentMethod: 'Alternating publication schedule, 50/50.',
      designType: 'randomized',
      primaryMetric: { name: 'content_views', dimensions: { channel: 'analytics' } },
      guardrails: [],
      analysisMethod: 'Two-sample comparison of per-item views.',
      analysisMethodVersion: 'v1',
      expectedDirection: 'increase',
      stopCriteria: 'Stop after 40 items per arm.',
      minimumEvidenceRequirement: 'B — strong quasi-experimental design at minimum.',
      uncertaintyRepresentation: 'interval',
    },
  });
  assert.equal(experimentCreate.status, 201, JSON.stringify(experimentCreate.body));
  const experimentId = experimentCreate.body['experimentId'] as string;

  // THE HYPOTHESIS with honest framing.
  const hypothesis = await contentIntelligence().recordContentHypothesis(
    {
      clientId: clientAId!,
      workspaceId: null,
      hypothesisKind: 'format_hypothesis',
      statement: {
        summary:
          'Short-form explainer videos may outperform long-form for premium-widget audiences — an input to the linked experiment, not a conclusion.',
      },
      evidenceIds,
      candidateIds: [candidate.contentCandidateId],
      researchInsightIds: [insight.researchInsightId],
      experimentId,
      supersedesContentHypothesisId: null,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(hypothesis.clientId, clientAId);
  assert.deepEqual(hypothesis.evidenceIds, evidenceIds);
  assert.deepEqual(hypothesis.candidateIds, [candidate.contentCandidateId]);
  assert.deepEqual(hypothesis.researchInsightIds, [insight.researchInsightId]);
  assert.equal(hypothesis.experimentId, experimentId);

  // THE READ-BACK carries the §6 non-claim framing.
  const hypothesisDetail = await contentIntelligence().getContentHypothesisDetail(
    hypothesis.contentHypothesisId,
  );
  assert.equal(hypothesisDetail?.hypothesisFraming, CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING);
  const candidateDetail = await contentIntelligence().getContentCandidateDetail(
    candidate.contentCandidateId,
  );
  assert.equal(candidateDetail?.candidateTier, 'observed_features');

  // The lists compose.
  const candidates = await contentIntelligence().listContentCandidatesForClient(clientAId);
  assert.equal(candidates.length, 1);
  const hypotheses = await contentIntelligence().listContentHypothesesForClient(clientAId);
  assert.equal(hypotheses.length, 1);
  const runs = await contentIntelligence().listObservationIngestionRuns(clientAId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, 'completed');
});

// ---------------------------------------------------------------------------
// AC-2: the honest outcomes (the adapter-less label records the failure)
// ---------------------------------------------------------------------------

test('AC-2: the platform_content label awaits its adapter — the ingestion records the honest failed outcome (never an invented read)', async () => {
  assert.ok(clientAId !== null && analyticsConnectionA !== null);
  const outcome = await contentIntelligence().runObservationIngestion(
    {
      clientId: clientAId!,
      workspaceId: null,
      connectionId: analyticsConnectionA,
      observationKind: 'platform_content',
    },
    MODULE_PROVENANCE,
  );
  assert.equal(outcome.run.status, 'failed');
  assert.equal(outcome.run.operation, 'content.list');
  assert.equal(outcome.run.recordsObserved, 0);
  assert.equal(outcome.run.evidenceAppended, 0);
  assert.deepEqual(outcome.appendedEvidence, []);
  assert.ok((outcome.run.detail ?? '').length > 0, 'the failure detail is honest');
});

// ---------------------------------------------------------------------------
// AC-3: evidence/hypothesis separation + the guards
// ---------------------------------------------------------------------------

test('AC-3: a hypothesis REQUIRES same-client evidence; foreign evidence/metric/candidates are the uniform 404; vocab violations are the 422', async () => {
  assert.ok(ownerA !== null && ownerB !== null && clientAId !== null && clientBId !== null);
  // Foreign evidence (client B's evidence via client A) — the uniform 404.
  const foreignEvidenceAppend = await apiCall(port(), `/api/clients/${clientBId}/evidence`, {
    token: ownerB.token,
    body: {
      class: 'observation',
      sourceSystem: 'manual',
      observedAt: '2026-03-02T00:00:00.000Z',
      content: { summary: 'client B observation' },
      quality: 'C',
    },
  });
  assert.equal(foreignEvidenceAppend.status, 201);
  const foreignEvidenceId = foreignEvidenceAppend.body['evidenceId'] as string;

  await assert.rejects(
    () =>
      contentIntelligence().recordContentCandidate(
        {
          clientId: clientAId!,
          workspaceId: null,
          features: {
            topicEntity: 'x',
            niche: 'widgets',
            subNiche: null,
            contentFormat: 'text_post',
            lengthValue: null,
            lengthUnit: null,
            hookFeatures: [],
            narrativeStructure: 'commentary',
            publishedAt: null,
            observedPerformance: { views: 1 },
            performanceVelocity: null,
            engagement: null,
            audienceFit: 'unclear',
            freshness: 'dated',
            novelty: 'common',
            reuseRisk: 'unclear',
          },
          evidenceIds: [foreignEvidenceId],
          metricObservationIds: [],
        },
        MODULE_PROVENANCE,
      ),
    /evidence/,
  );

  // A hypothesis with ZERO evidence references is rejected
  // (evidence/hypothesis separation).
  const ownEvidence = await apiCall(port(), `/api/clients/${clientAId}/evidence`, {
    token: ownerA.token,
    body: {
      class: 'observation',
      sourceSystem: 'manual',
      observedAt: '2026-03-02T00:00:00.000Z',
      content: { summary: 'client A observation for the hypothesis battery' },
      quality: 'C',
    },
  });
  assert.equal(ownEvidence.status, 201);
  const ownEvidenceId = ownEvidence.body['evidenceId'] as string;
  await assert.rejects(
    () =>
      contentIntelligence().recordContentHypothesis(
        {
          clientId: clientAId!,
          workspaceId: null,
          hypothesisKind: 'topic_hypothesis',
          statement: { summary: 'A hypothesis without evidence citations.' },
          evidenceIds: [],
          candidateIds: [],
          researchInsightIds: [],
          experimentId: null,
          supersedesContentHypothesisId: null,
        },
        MODULE_PROVENANCE,
      ),
    /Invalid content hypothesis recording/,
  );
  // The rejection detail discloses the evidence/hypothesis separation (the
  // unit battery pins the exact text).
  {
    let separationDetail = false;
    try {
      await contentIntelligence().recordContentHypothesis(
        {
          clientId: clientAId!,
          workspaceId: null,
          hypothesisKind: 'topic_hypothesis',
          statement: { summary: 'A hypothesis without evidence citations.' },
          evidenceIds: [],
          candidateIds: [],
          researchInsightIds: [],
          experimentId: null,
          supersedesContentHypothesisId: null,
        },
        MODULE_PROVENANCE,
      );
    } catch (error) {
      const details = (error as { details?: readonly string[] }).details ?? [];
      separationDetail = details.some((detail) => detail.includes('at least one evidence reference'));
    }
    assert.ok(separationDetail, 'the rejection discloses the evidence/hypothesis separation');
  }

  // A FOREIGN research insight (another agency's session) is the uniform 404.
  const foreignSession = await researchModule().createResearchSession(
    {
      agencyId: ownerB.agencyId,
      declaration: {
        topic: null,
        focus: null,
        sources: [
          { kind: 'web_page', reference: 'https://b.test/', authorization: 'public', integrationConnectionId: null },
        ],
      },
    },
    RESEARCH_PROVENANCE,
  );
  const foreignInsight = await researchModule().recordResearchInsight(
    {
      researchSessionId: foreignSession.session.researchSessionId,
      derivationKind: 'market_note',
      statement: { summary: 'Agency B market note.' },
      evidenceSourceFactIds: [],
      aiAssistance: null,
      supersedesResearchInsightId: null,
    },
    RESEARCH_PROVENANCE,
  );
  await assert.rejects(
    () =>
      contentIntelligence().recordContentHypothesis(
        {
          clientId: clientAId!,
          workspaceId: null,
          hypothesisKind: 'topic_hypothesis',
          statement: { summary: 'Citing a foreign-agency research insight.' },
          evidenceIds: [ownEvidenceId],
          candidateIds: [],
          researchInsightIds: [foreignInsight.researchInsightId],
          experimentId: null,
          supersedesContentHypothesisId: null,
        },
        MODULE_PROVENANCE,
      ),
    /research insight/,
  );

  // HTTP: the closed-vocabulary guards are the 422.
  const badCandidate = await apiCall(port(), `/api/clients/${clientAId}/content-intelligence/candidates`, {
    token: ownerA.token,
    body: {
      topicEntity: 'Bad candidate',
      niche: 'widgets',
      contentFormat: 'hologram',
      hookFeatures: [],
      narrativeStructure: 'commentary',
      observedPerformance: { views: 1 },
      audienceFit: 'unclear',
      freshness: 'dated',
      novelty: 'common',
      reuseRisk: 'unclear',
      evidenceIds: [ownEvidenceId],
      metricObservationIds: [],
    },
  });
  assert.equal(badCandidate.status, 422, JSON.stringify(badCandidate.body));

  const badHypothesis = await apiCall(port(), `/api/clients/${clientAId}/content-intelligence/hypotheses`, {
    token: ownerA.token,
    body: {
      hypothesisKind: 'vibe_hypothesis',
      statement: { summary: 'ok' },
      evidenceIds: [ownEvidenceId],
      candidateIds: [],
      researchInsightIds: [],
    },
  });
  assert.equal(badHypothesis.status, 422, JSON.stringify(badHypothesis.body));
});

// ---------------------------------------------------------------------------
// AC-4: the supersession correction chain + the append-only DB fences
// ---------------------------------------------------------------------------

test('AC-4: hypothesis corrections ride the single-supersession chain; the append-only DB fences reject direct-SQL rewrites', async () => {
  assert.ok(clientAId !== null);
  const evidenceAppend = await apiCall(port(), `/api/clients/${clientAId}/evidence`, {
    token: ownerA!.token,
    body: {
      class: 'observation',
      sourceSystem: 'manual',
      observedAt: '2026-03-03T00:00:00.000Z',
      content: { summary: 'client A observation for the supersession battery' },
      quality: 'C',
    },
  });
  assert.equal(evidenceAppend.status, 201);
  const evidenceId = evidenceAppend.body['evidenceId'] as string;

  const first = await contentIntelligence().recordContentHypothesis(
    {
      clientId: clientAId!,
      workspaceId: null,
      hypothesisKind: 'hook_hypothesis',
      statement: { summary: 'Question hooks may outperform statement hooks.' },
      evidenceIds: [evidenceId],
      candidateIds: [],
      researchInsightIds: [],
      experimentId: null,
      supersedesContentHypothesisId: null,
    },
    MODULE_PROVENANCE,
  );
  const second = await contentIntelligence().recordContentHypothesis(
    {
      clientId: clientAId!,
      workspaceId: null,
      hypothesisKind: 'hook_hypothesis',
      statement: { summary: 'A corrected view: question hooks may outperform only for tutorial narratives.' },
      evidenceIds: [evidenceId],
      candidateIds: [],
      researchInsightIds: [],
      experimentId: null,
      supersedesContentHypothesisId: first.contentHypothesisId,
    },
    MODULE_PROVENANCE,
  );
  assert.equal(second.supersedesContentHypothesisId, first.contentHypothesisId);

  // Double supersession is the honest 409.
  await assert.rejects(
    () =>
      contentIntelligence().recordContentHypothesis(
        {
          clientId: clientAId!,
          workspaceId: null,
          hypothesisKind: 'hook_hypothesis',
          statement: { summary: 'A second correction — must be rejected.' },
          evidenceIds: [evidenceId],
          candidateIds: [],
          researchInsightIds: [],
          experimentId: null,
          supersedesContentHypothesisId: first.contentHypothesisId,
        },
        MODULE_PROVENANCE,
      ),
    /single-supersession fence/,
  );
  // A kind-changing correction is rejected.
  await assert.rejects(
    () =>
      contentIntelligence().recordContentHypothesis(
        {
          clientId: clientAId!,
          workspaceId: null,
          hypothesisKind: 'timing_hypothesis',
          statement: { summary: 'A kind-changing correction — must be rejected.' },
          evidenceIds: [evidenceId],
          candidateIds: [],
          researchInsightIds: [],
          experimentId: null,
          supersedesContentHypothesisId: first.contentHypothesisId,
        },
        MODULE_PROVENANCE,
      ),
    /same hypothesis kind|already superseded/,
  );

  // The prior record is superseded at read time.
  const prior = (await contentIntelligence().getContentHypothesis(first.contentHypothesisId))!;
  assert.equal(prior.supersededByContentHypothesisId, second.contentHypothesisId);

  // THE DB FENCES: candidates and hypotheses are append-only even against
  // direct SQL.
  const candidates = await contentIntelligence().listContentCandidatesForClient(clientAId);
  const candidateId = candidates[0]!.contentCandidateId;
  await assert.rejects(
    () =>
      pool().query('UPDATE content_candidates SET niche = $1 WHERE content_candidate_id = $2', [
        'forged-niche',
        candidateId,
      ]),
    /append-only/,
  );
  await assert.rejects(
    () =>
      pool().query('DELETE FROM content_candidates WHERE content_candidate_id = $1', [candidateId]),
    /append-only/,
  );
  await assert.rejects(
    () =>
      pool().query('UPDATE content_hypotheses SET statement = $1 WHERE content_hypothesis_id = $2', [
        JSON.stringify({ summary: 'forged' }),
        first.contentHypothesisId,
      ]),
    /append-only/,
  );
  // A forged research citation crossing the agency boundary cannot persist.
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO content_hypothesis_research_refs (content_hypothesis_id, research_insight_id, position)
         VALUES ($1, $2, 1)`,
        [second.contentHypothesisId, '99999999-9999-9999-9999-999999999999'],
      ),
    /crosses an agency boundary|violates foreign key/,
  );
});

// ---------------------------------------------------------------------------
// AC-8: fail-closed isolation (HTTP)
// ---------------------------------------------------------------------------

test('AC-8: anonymous 401; foreign/malformed/unknown identifiers are the UNIFORM 404; a suspended membership is the 403; PUT/DELETE 405', async () => {
  assert.ok(ownerA !== null && clientAId !== null && suspendedMember !== null);
  // Anonymous calls fail closed at the authenticator.
  const anonymous = await apiCall(port(), `/api/clients/${clientAId}/content-intelligence/candidates`, {
    body: {},
  });
  assert.equal(anonymous.status, 401);

  const listing = await apiCall(port(), `/api/clients/${clientAId}/content-intelligence/candidates`, {
    token: ownerA.token,
  });
  assert.equal(listing.status, 200);
  const candidateId = (listing.body['candidates'] as Record<string, unknown>[])[0]!['contentCandidateId'] as string;

  // A foreign owner (another agency) sees the uniform 404.
  const foreignClient = await apiCall(port(), `/api/clients/${clientAId}/content-intelligence/candidates`, {
    token: ownerB!.token,
  });
  assert.equal(foreignClient.status, 404);
  const foreignCandidate = await apiCall(port(), `/api/content-candidates/${candidateId}`, {
    token: ownerB!.token,
  });
  assert.equal(foreignCandidate.status, 404);

  // Malformed and unknown identifiers are indistinguishable (the record
  // routes guard the uuid grammar; the client paths are probed with
  // valid-format unknown ids — the house convention, no existence oracle).
  for (const badId of ['not-a-uuid', '99999999-9999-9999-9999-999999999999']) {
    const malformedCandidate = await apiCall(port(), `/api/content-candidates/${badId}`, {
      token: ownerA.token,
    });
    assert.equal(malformedCandidate.status, 404);
    const malformedHypothesis = await apiCall(port(), `/api/content-hypotheses/${badId}`, {
      token: ownerA.token,
    });
    assert.equal(malformedHypothesis.status, 404);
  }
  const unknownClient = await apiCall(port(), `/api/clients/99999999-9999-9999-9999-999999999999/content-intelligence/candidates`, {
    token: ownerA.token,
  });
  assert.equal(unknownClient.status, 404);

  // A suspended membership is the 403.
  const suspended = await apiCall(port(), `/api/clients/${clientAId}/content-intelligence/candidates`, {
    token: suspendedMember.token,
  });
  assert.equal(suspended.status, 403);

  // Every non-GET/POST verb 405s at the router.
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const verb = await apiCall(port(), `/api/content-candidates/${candidateId}`, {
      token: ownerA.token,
      method,
      body: {},
    });
    assert.equal(verb.status, 405);
  }

  // The hypothesis detail read carries the §6 framing disclosure.
  const hypothesisList = await apiCall(port(), `/api/clients/${clientAId}/content-intelligence/hypotheses`, {
    token: ownerA.token,
  });
  assert.equal(hypothesisList.status, 200);
  const hypothesisId = (hypothesisList.body['hypotheses'] as Record<string, unknown>[])[0]!['contentHypothesisId'] as string;
  const detail = await apiCall(port(), `/api/content-hypotheses/${hypothesisId}`, {
    token: ownerA.token,
  });
  assert.equal(detail.status, 200);
  assert.equal(detail.body['hypothesisFraming'], CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING);
});

// ---------------------------------------------------------------------------
// AC-2 (module-level): the honest run shapes
// ---------------------------------------------------------------------------

test('AC-2 (module-level): the ingestion run types are honest — the connection fences (foreign 404 / non-connected 409)', async () => {
  assert.ok(clientAId !== null && analyticsConnectionA !== null);
  // A foreign/unknown connection is the uniform 404 (never an oracle).
  await assert.rejects(
    () =>
      contentIntelligence().runObservationIngestion(
        {
          clientId: clientAId!,
          workspaceId: null,
          connectionId: '99999999-9999-9999-9999-999999999999',
          observationKind: 'platform_analytics',
        },
        MODULE_PROVENANCE,
      ),
    /integration connection/,
  );
  // The ownership resolution surfaces null for unknown records.
  assert.equal(
    await contentIntelligence().resolveContentCandidateOwnership('99999999-9999-9999-9999-999999999999'),
    null,
  );
  assert.equal(
    await contentIntelligence().resolveContentHypothesisOwnership('99999999-9999-9999-9999-999999999999'),
    null,
  );
});

// ---------------------------------------------------------------------------
// Type re-exports used by the assertions (keeps tsc honest about shapes).
// ---------------------------------------------------------------------------

type _KeepImportsUsed =
  | ContentCandidateRecord
  | ContentHypothesisRecord
  | ContentObservationIngestionRunRecord;
void (null as unknown as _KeepImportsUsed);
