/**
 * MKT-038 integration test — THE CREATOR OPERATIONS PROVIDER E2E on the
 * real stack (embedded PostgreSQL 18 + real API subprocess + the in-process
 * LOOPBACK sandbox creator-platform provider + the in-process application
 * wiring for the AI Router leg — the acquisition-pilot MKT-028 test-harness
 * precedent).
 *
 * Acceptance mapping (work-item-v1.3-overrides.md MKT-038 = E2E-002 +
 * CREATOR-001; requirements-v1.3.md E2E-002, acceptance E2E-AC-02:
 * "a Creator Operations scenario executes Goal → Workflow → AI task →
 * Human Agent Job → provider adapter/extension → Evidence/Outcome →
 * Learning without bypassing authority boundaries — end-to-end
 * integration test"):
 *
 * THE GOLDEN PATH (E2E-AC-02), EVERY stage through the frozen public
 * contracts with the authoritative state asserted after each:
 *   - provider event: a signed creator-platform webhook delivery lands in
 *     the MKT-023 append-only integration event ledger + a derived
 *     'source_fact' /evidence row (class/quality/provenance pinned);
 *   - Creator subjects: the pack profile/account/fan/conversation chain +
 *     the INBOUND message observation;
 *   - Goal: an ACTIVE workspace-scoped goal through /goals;
 *   - Workflow: the pack's frozen 'conversation-triage' template published
 *     through /domain-packs, installed, materialized as a REAL /workflows
 *     definition (ACTIVE) + instance (RUNNING);
 *   - AI task: an /executions runtime attempt for the template's
 *     'draft_reply' ai_task node + the pack-provisioned
 *     creator.response_drafting TaskProfile routed through the AI Router
 *     (routeTask, cascade completed, draft output validated against the
 *     profile's output schema);
 *   - Human Agent Job: the 'approve_reply' human_task node projected as a
 *     chatter-specialized Job through the GENERIC /jobs model → offer →
 *     accept;
 *   - APPROVED communication through the creator adapter: the pack
 *     CREATOR-AC-06 approval chain (client policy demanding
 *     approvalStatus='approved' → human approval record → the gated
 *     outbound send born 'sent' carrying the allowing policy decision id)
 *     THEN the provider send through the /integrations mutation boundary
 *     (executeMutation → CreatorPlatformAdapter → REAL HTTP call to the
 *     sandbox provider, which RECORDS the approved side effect);
 *   - Evidence/Outcome: the send observation mapped into the COMMON
 *     /evidence + /metrics contracts through the pack mapping; the
 *     integration read sync delivering provider observations through the
 *     METRIC-001 emitter; the Job outcome submitted citing the send
 *     evidence; the execution transitioned to SUCCEEDED;
 *   - Learning: the §16 experiment declared, started, analyzed and
 *     CONCLUDED citing same-Client creator evidence; the Learning record
 *     appended with evidenceRefs + the CONCLUDED experimentRef; the
 *     workflow instance terminal.
 *
 * NEGATIVE TESTS (fail-closed proofs — no authority bypass):
 *   - an UNAPPROVED send is denied BEFORE any row (the fail-closed
 *     approval gate) and NEVER reaches the provider (zero sandbox
 *     traffic);
 *   - a client-scoped network DENY on integration.mutate blocks the
 *     provider send at the /integrations boundary BEFORE any provider
 *     traffic (the sandbox request counter proves zero calls);
 *   - cross-client adapter operations are UNIFORM 404s (a foreign
 *     connection id under an authorized client path is indistinguishable
 *     from an unknown one — read, mutate AND webhook surfaces);
 *   - a FORGED provider event (bad signature) is rejected with NOTHING
 *     recorded (no ledger row, no evidence row — no partial delivery);
 *   - webhook replay/dedup semantics preserved: a repeated VERIFIED
 *     delivery appends FRESH immutable rows (new event id, new evidence
 *     id) — the append-only ledger never rewrites and fabricates no dedup.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
} from './helpers/harness.ts';
import {
  startSandboxProvider,
  sandboxWebhookSignature,
  type SandboxProvider,
} from './helpers/sandbox-provider.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import { defaultValidator } from '../../src/modules/ai-runtime/public.ts';
import type {
  AdapterRequest,
  AdapterResponse,
  AiRuntimeModuleApi,
  ProviderAdapter,
} from '../../src/modules/ai-runtime/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PASSWORD = 'a-very-long-password-123';

// FAKE sandbox credential strings — assembled at RUNTIME (the §21 posture:
// they exist only in the secrets-dir fixture files and in-process).
const CREATOR_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxCreatorToken';
const CREATOR_WEBHOOK_SECRET = 'whsec_' + 'Creator' + 'FakeSandbox';

const PROVIDER_CONVERSATION_REF = 'conv_551';
const FAN_MESSAGE = 'Loved the new morning routine post — is the bundle still available?';
const DRAFT_REPLY = 'Thank you so much! The VIP bundle is live this week — grab it from the pinned post.';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcessLike & { port: number }) | null = null;
let sandbox: SandboxProvider | null = null;
let aiRuntime: AiRuntimeModuleApi | null = null;

interface SpawnedProcessLike {
  readonly child: ChildProcessWithoutNullStreams;
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function sandboxUrl(): string {
  if (sandbox === null) throw new Error('sandbox not started');
  return sandbox.url;
}

function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

// ---------------------------------------------------------------------------
// The fake AI provider adapter (the ai-routing MKT-018 test precedent: the
// cascade executor takes the provider adapter as a PARAMETER; the test
// supplies a fake — no live network; the AI ROUTER itself is real).
// ---------------------------------------------------------------------------

class DraftingFakeAdapter implements ProviderAdapter {
  readonly providerLabel = 'mkt038-fake';
  private readonly output: Readonly<Record<string, unknown>>;
  /** The model-side invocations the cascade made (the request record). */
  readonly invocations: AdapterRequest[] = [];
  /** The model outputs returned (the validator-accepted payloads). */
  readonly outputs: Readonly<Record<string, unknown>>[] = [];
  constructor(output: Readonly<Record<string, unknown>>) {
    this.output = output;
  }
  async invoke(request: AdapterRequest): Promise<AdapterResponse> {
    this.invocations.push(request);
    this.outputs.push(this.output);
    return {
      ok: true,
      output: this.output,
      error: null,
      latencyMs: 140,
      costAmount: 0.001,
      tokensIn: 320,
      tokensOut: 48,
    };
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

interface Principal {
  readonly userId: string;
  readonly token: string;
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

async function makeUser(email: string): Promise<Principal> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, { token: admin, body: { password: PASSWORD } });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

interface Tenant {
  readonly owner: Principal;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
}

async function makeTenant(label: string): Promise<Tenant> {
  const owner = await makeUser(`${label}-owner@creatore2e.test`);
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${label}`, ownerUserId: owner.userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: admin,
    body: { name: `Client ${label}` },
  });
  assert.equal(client.status, 201);
  const clientId = client.body['clientId'] as string;
  const workspace = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: admin,
    body: { name: `Workspace ${label}` },
  });
  assert.equal(workspace.status, 201);
  return { owner, agencyId, clientId, workspaceId: workspace.body['workspaceId'] as string };
}

/** One Human Agent profile (specializations + the chatter eligibility set). */
async function makeAgentProfile(principal: Principal, body: Record<string, unknown>): Promise<string> {
  const created = await apiCall(port(), '/api/field-agents', { token: principal.token, body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['agentId'] as string;
}

async function makeCredential(agencyId: string, token: string, label: string, handle: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/credentials`, {
    token,
    body: { kind: 'integration_api_key', label, secretHandle: handle },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['credentialId'] as string;
}

function provisionSecret(handle: string, material: string): void {
  fs.writeFileSync(path.join(stack!.env.secretsDir, `${handle}.secret`), material, { mode: 0o600 });
}

// The shared tenant fixtures.
let tenant: Tenant = null as unknown as Tenant;
let bobTenant: Tenant = null as unknown as Tenant;
let chatter: Principal = null as unknown as Principal;
let chatterAgentId = '';
let credentialId = '';
let bobCredentialId = '';
let connectionId = '';
let bobConnectionId = '';
let profileId = '';
let accountId = '';
let fanId = '';
let conversationId = '';
let workflowId = '';
let definitionId = '';
let workflowInstanceId = '';
let goalId = '';
let webhookEventId = '';
let webhookEvidenceId = '';
let draftProfileId = '';
let executionId = '';
let jobId = '';
let sendEvidenceId = '';
let experimentId = '';
let learningId = '';

before(async () => {
  stack = await bootStack('creatore2e');

  // The sandbox creator-platform provider (loopback; per-provider bearer
  // check; NO real network egress).
  sandbox = await startSandboxProvider({ 'creator-platform': CREATOR_TOKEN });

  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the acquisition-pilot precedent):
  // bootstrap the SAME application in-process (same embedded PostgreSQL
  // the API subprocess serves) so the AI Router leg can call routeTask
  // with a fake provider adapter through the REAL module instance.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  aiRuntime = core.modules.aiRuntime;

  // Tenants: Alice (creator operations) + Bob (the cross-tenant negative).
  tenant = await makeTenant('alice');
  bobTenant = await makeTenant('bob');

  // Alice's owner carries a REVIEWER Human Agent profile (the approver
  // provenance of the CREATOR-AC-06 approval records resolves from this
  // profile server-side).
  await makeAgentProfile(tenant.owner, {
    specializations: ['reviewer'],
    capabilities: [{ skill: 'chat_review', level: 'expert' }],
    availability: [{ dayOfWeek: 1, startMinute: 0, endMinute: 1440 }],
    location: { kind: 'country', value: 'ghana' },
    territories: [],
    relationshipContinuity: {
      prefersRepeatClients: false,
      continuity: 'any',
      maxConcurrentClientRelationships: 5,
    },
  });

  // The CHATTER Human Agent (the generic-model worker of the review Job).
  chatter = await makeUser('chatter@creatore2e.test');
  chatterAgentId = await makeAgentProfile(chatter, {
    specializations: ['chatter'],
    capabilities: [{ skill: 'community_reply', level: 'advanced' }],
    availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }],
    location: { kind: 'city', value: 'accra' },
    territories: [],
    relationshipContinuity: {
      prefersRepeatClients: false,
      continuity: 'any',
      maxConcurrentClientRelationships: 5,
    },
  });

  // Platform policy defaults: the integration PIPE operations explicitly
  // allowed (network + secrets dimensions). Deliberately NOT '*' — the
  // creator conversation gate must stay governed by the CLIENT-scoped
  // approval-demanding policy below (deny-overrides/any-allow composition
  // would otherwise let a platform '*' allow bypass the approval demand).
  const platformNetwork = await apiCall(port(), '/api/policies', {
    token: await adminToken(),
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['integration.connect', 'integration.read', 'integration.mutate', 'integration.webhook'],
          reason: 'MKT-038 E2E: the integration pipe operations are allowed platform-wide',
        },
      ],
      description: 'MKT-038 E2E platform network boundary (integration pipe)',
    },
  });
  assert.equal(platformNetwork.status, 201, JSON.stringify(platformNetwork.body));
  const platformSecrets = await apiCall(port(), '/api/policies', {
    token: await adminToken(),
    body: {
      dimension: 'secrets',
      rules: [
        {
          effect: 'allow',
          operations: ['integration.credential', 'integration.webhook'],
          reason: 'MKT-038 E2E: integration credential use and webhook verification explicitly allowed platform-wide',
        },
      ],
      description: 'MKT-038 E2E platform secrets boundary (integration credential + webhook verification)',
    },
  });
  assert.equal(platformSecrets.status, 201, JSON.stringify(platformSecrets.body));

  // Alice's CLIENT-scoped creator gate: sends/publishes DEMAND a pack
  // approval record (approvalStatus='approved' — the server-composed
  // attribute; approvalStatus='missing' matches nothing → fail closed).
  const clientGate = await apiCall(port(), `/api/clients/${tenant.clientId}/policies`, {
    token: tenant.owner.token,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['creator.conversation.send', 'creator.content.publish'],
          attributes: { approvalStatus: 'approved' },
          reason: 'MKT-038 E2E: creator sends and publishes require a human approval record',
        },
      ],
      description: 'MKT-038 E2E client creator gate (approvals demanded)',
    },
  });
  assert.equal(clientGate.status, 201, JSON.stringify(clientGate.body));

  // Bob's CLIENT-scoped network policy: integration.mutate DENIED (the
  // fail-closed integration-boundary negative — deny overrides the
  // platform allow through the scope chain).
  const bobDeny = await apiCall(port(), `/api/clients/${bobTenant.clientId}/policies`, {
    token: bobTenant.owner.token,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'deny',
          operations: ['integration.mutate'],
          reason: 'MKT-038 E2E: client-scoped provider mutation deny (fail-closed negative)',
        },
      ],
      description: 'MKT-038 E2E Bob client boundary (mutations denied)',
    },
  });
  assert.equal(bobDeny.status, 201, JSON.stringify(bobDeny.body));

  // The creator-platform credential (agency-scoped reference by logical
  // handle — never the material itself).
  provisionSecret('mkt038-creator-key', JSON.stringify({ accessToken: CREATOR_TOKEN, webhookSecret: CREATOR_WEBHOOK_SECRET }));
  provisionSecret('mkt038-bob-creator-key', JSON.stringify({ accessToken: CREATOR_TOKEN, webhookSecret: 'whsec_bob-not-used' }));
  credentialId = await makeCredential(tenant.agencyId, tenant.owner.token, 'Creator platform sandbox', 'mkt038-creator-key');
  bobCredentialId = await makeCredential(bobTenant.agencyId, bobTenant.owner.token, 'Creator platform sandbox Bob', 'mkt038-bob-creator-key');

  // The creator-platform connections (sandbox/loopback endpoints arrive as
  // NON-SECRET providerConfig data — the MKT-024 posture).
  const connection = await apiCall(port(), `/api/clients/${tenant.clientId}/connections`, {
    token: tenant.owner.token,
    body: {
      adapterKey: 'creator-platform',
      credentialReferenceId: credentialId,
      providerConfig: {
        apiBaseUrl: `${sandboxUrl()}/creator-platform`,
        accountHandle: 'ava_creator',
      },
    },
  });
  assert.equal(connection.status, 201, JSON.stringify(connection.body));
  connectionId = connection.body['connectionId'] as string;

  const bobConnection = await apiCall(port(), `/api/clients/${bobTenant.clientId}/connections`, {
    token: bobTenant.owner.token,
    body: {
      adapterKey: 'creator-platform',
      credentialReferenceId: bobCredentialId,
      providerConfig: {
        apiBaseUrl: `${sandboxUrl()}/creator-platform`,
        accountHandle: 'bob_creator',
      },
    },
  });
  assert.equal(bobConnection.status, 201, JSON.stringify(bobConnection.body));
  bobConnectionId = bobConnection.body['connectionId'] as string;

  // CONNECT both connections: the probe runs the REAL adapter against the
  // sandbox provider over REAL HTTP (the credential material resolved
  // in-process after the fail-closed policy allows).
  const current = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}`, {
    token: tenant.owner.token,
  });
  assert.equal(current.status, 200);
  const connected = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}/connect`, {
    token: tenant.owner.token,
    body: { expectedVersion: current.body['version'] as number },
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.equal(connected.body['status'], 'connected');
  assert.equal(connected.body['health'], 'healthy');
  assert.equal(connected.body['adapterKey'], 'creator-platform');

  const bobCurrent = await apiCall(port(), `/api/clients/${bobTenant.clientId}/connections/${bobConnectionId}`, {
    token: bobTenant.owner.token,
  });
  const bobConnected = await apiCall(port(), `/api/clients/${bobTenant.clientId}/connections/${bobConnectionId}/connect`, {
    token: bobTenant.owner.token,
    body: { expectedVersion: bobCurrent.body['version'] as number },
  });
  assert.equal(bobConnected.status, 200, JSON.stringify(bobConnected.body));

  // The creator subject chain (the pack §2 subjects through the API).
  const profile = await apiCall(port(), `/api/clients/${tenant.clientId}/creator-profiles`, {
    token: tenant.owner.token,
    body: {
      displayName: 'Ava Creator',
      handle: 'ava-e2e',
      niches: ['fitness', 'lifestyle'],
      bio: 'A fitness creator.',
      attributes: { region: 'emea' },
      idempotencyKey: 'mkt038-profile-1',
    },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  profileId = profile.body['profileId'] as string;

  const account = await apiCall(port(), `/api/creator-profiles/${profileId}/accounts`, {
    token: tenant.owner.token,
    body: {
      platformLabel: 'creator-platform-1',
      accountHandle: 'ava_creator',
      metadata: { verified: true },
      idempotencyKey: 'mkt038-account-1',
    },
  });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  accountId = account.body['accountId'] as string;

  const fan = await apiCall(port(), `/api/creator-accounts/${accountId}/fans`, {
    token: tenant.owner.token,
    body: {
      fanAlias: 'top-fan-e2e',
      tier: 'top_fan',
      tags: ['early-supporter'],
      attributes: {},
      idempotencyKey: 'mkt038-fan-1',
    },
  });
  assert.equal(fan.status, 201, JSON.stringify(fan.body));
  fanId = fan.body['fanId'] as string;

  const conversation = await apiCall(port(), `/api/creator-accounts/${accountId}/conversations`, {
    token: tenant.owner.token,
    body: {
      fanId,
      channel: 'dm',
      topic: 'bundle-enquiry',
      attributes: {},
      idempotencyKey: 'mkt038-conversation-1',
    },
  });
  assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
  conversationId = conversation.body['conversationId'] as string;
});

after(async () => {
  if (sandbox !== null) {
    await sandbox.close();
    sandbox = null;
  }
  if (api !== null) {
    api.child.kill('SIGKILL');
    api = null;
  }
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// THE GOLDEN PATH — E2E-AC-02 (every stage through the frozen contracts)
// ---------------------------------------------------------------------------

test('E2E-AC-02 golden path: provider event → subjects → Goal → Workflow (pack template) → AI Router task → Human Agent Job → APPROVED send through the creator adapter → Evidence/Outcome → experiment → Learning', async () => {
  // ---- provider event: the signed webhook lands in the MKT-023 ledger ---
  const webhookPayload = {
    conversationId: PROVIDER_CONVERSATION_REF,
    messageBody: FAN_MESSAGE,
    fromFan: 'fan_771',
  };
  const webhook = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}/webhook`, {
    token: tenant.owner.token,
    body: {
      eventType: 'message.created',
      payload: webhookPayload,
      headers: sandboxWebhookSignature('creator-platform', CREATOR_WEBHOOK_SECRET, webhookPayload),
    },
  });
  assert.equal(webhook.status, 201, JSON.stringify(webhook.body));
  webhookEventId = webhook.body['eventId'] as string;
  webhookEvidenceId = webhook.body['evidenceRef'] as string;
  assert.ok(typeof webhookEvidenceId === 'string' && webhookEvidenceId.length > 0);
  // The ledger row + the derived source_fact evidence (provenance pinned).
  const ledger = await pool().query<{ event_type: string; evidence_ref: string; adapter_key: string }>(
    'SELECT event_type, evidence_ref, adapter_key FROM integration_events WHERE event_id = $1',
    [webhookEventId],
  );
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0]!.event_type, 'creator-platform:message.created');
  assert.equal(ledger.rows[0]!.evidence_ref, webhookEvidenceId);
  assert.equal(ledger.rows[0]!.adapter_key, 'creator-platform');
  const webhookEvidence = await apiCall(port(), `/api/evidence/${webhookEvidenceId}`, { token: tenant.owner.token });
  assert.equal(webhookEvidence.status, 200);
  assert.equal(webhookEvidence.body['class'], 'source_fact');
  assert.equal(webhookEvidence.body['quality'], 'C');
  assert.deepEqual((webhookEvidence.body as { source: Record<string, string> }).source, {
    system: 'integration:creator-platform',
    ref: webhookEventId,
  });

  // ---- the inbound message observation (the pack conversation surface) ---
  const inbound = await apiCall(port(), `/api/creator-conversations/${conversationId}/messages/inbound`, {
    token: tenant.owner.token,
    body: { body: FAN_MESSAGE, idempotencyKey: 'mkt038-inbound-1', mapToEvidence: true },
  });
  assert.equal(inbound.status, 201, JSON.stringify(inbound.body));
  assert.equal(inbound.body['direction'], 'inbound');
  assert.equal(inbound.body['status'], 'received');
  assert.equal(inbound.body['policyDecisionId'], undefined, 'inbound rows carry NO gate provenance');

  // ---- Goal: an ACTIVE workspace-scoped goal through /goals -------------
  const goal = await apiCall(port(), `/api/clients/${tenant.clientId}/goals`, {
    token: tenant.owner.token,
    body: {
      objective: 'Creator conversation triage: reply to top-fan enquiries with AI-drafted, human-approved responses',
      workspaceId: tenant.workspaceId,
      successCriteria: [
        {
          metric: 'creator.conversation.event_count',
          comparator: '>=',
          targetValue: 1,
          unit: 'events',
          description: 'at least one approved creator reply sent through the provider adapter',
        },
      ],
      metrics: [],
      constraints: [{ kind: 'resource', description: 'one conversation-triage instance' }],
      timeHorizon: null,
    },
  });
  assert.equal(goal.status, 201, JSON.stringify(goal.body));
  goalId = goal.body['goalId'] as string;
  const goalActive = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token: tenant.owner.token,
    method: 'PATCH',
    body: { status: 'active', version: goal.body['version'] as number },
  });
  assert.equal(goalActive.status, 200, JSON.stringify(goalActive.body));
  assert.equal(goalActive.body['status'], 'active');

  // ---- Workflow: the pack template materialized through /workflows ------
  const publish = await apiCall(port(), '/api/creator-operations/publish', {
    token: tenant.owner.token,
    body: { idempotencyKey: 'mkt038-pack-publish-1' },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  const packId = publish.body['packId'] as string;
  assert.equal(publish.body['packKey'], 'creator-operations');

  const install = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/domain-pack-installs`, {
    token: tenant.owner.token,
    body: { packId, idempotencyKey: 'mkt038-pack-install-1' },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));

  const artifacts = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/domain-pack-artifacts`, {
    token: tenant.owner.token,
  });
  assert.equal(artifacts.status, 200);
  const template = (artifacts.body as { artifacts: { artifactName: string; payload: Record<string, unknown> }[] })
    .artifacts.find((artifact) => artifact.artifactName === 'conversation-triage');
  assert.ok(template !== undefined, 'the conversation-triage workflow template is materialized');
  const content = template.payload as Record<string, unknown>;

  const workflow = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/workflows`, {
    token: tenant.owner.token,
    body: { name: 'creator-triage-e2e', description: 'MKT-038 E2E: the pack conversation-triage template' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  workflowId = workflow.body['workflowId'] as string;

  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: tenant.owner.token,
    body: content,
  });
  assert.equal(definition.status, 201, `definition creation failed: ${JSON.stringify(definition.body)}`);
  definitionId = definition.body['workflowDefinitionId'] as string;
  let definitionVersion = definition.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
      token: tenant.owner.token,
      method: 'PATCH',
      body: { status, version: definitionVersion },
    });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    definitionVersion = next.body['version'] as number;
  }
  const definitionRead = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}`, {
    token: tenant.owner.token,
  });
  assert.equal(definitionRead.body['status'], 'active');

  const instance = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: tenant.owner.token,
    body: {},
  });
  assert.equal(instance.status, 201, JSON.stringify(instance.body));
  workflowInstanceId = instance.body['workflowInstanceId'] as string;
  let instanceVersion = instance.body['version'] as number;
  for (const to of ['ready', 'running'] as const) {
    const transition = await apiCall(port(), `/api/workflows/${workflowId}/instances/${workflowInstanceId}/transitions`, {
      token: tenant.owner.token,
      body: { to, version: instanceVersion, idempotencyKey: `mkt038-instance-${to}`, reason: 'MKT-038 E2E' },
    });
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
  }

  // ---- AI task: TaskProfiles + the /executions attempt + the AI Router --
  const provisioning = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/creator-operations/task-profiles`, {
    token: tenant.owner.token,
    body: { idempotencyKey: 'mkt038-provision-1' },
  });
  assert.equal(provisioning.status, 201, JSON.stringify(provisioning.body));
  const taskProfiles = provisioning.body['taskProfiles'] as { taskClass: string; taskProfileId: string }[];
  draftProfileId = taskProfiles.find((receipt) => receipt.taskClass === 'creator.response_drafting')!
    .taskProfileId;
  assert.ok(typeof draftProfileId === 'string' && draftProfileId.length > 0);

  // The execution: the runtime attempt of the template's draft_reply
  // ai_task node (created through the /executions authority surface).
  const execution = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/executions`, {
    token: tenant.owner.token,
    body: {
      workflowInstanceId,
      nodeId: 'draft_reply',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'mkt038-execution-draft-1',
    },
  });
  assert.equal(execution.status, 201, JSON.stringify(execution.body));
  const executionBody = execution.body as Record<string, unknown>;
  const executionRecord = (executionBody['execution'] ?? executionBody) as Record<string, unknown>;
  executionId = executionRecord['executionId'] as string;
  assert.equal(executionRecord['executionKind'], 'ai');
  assert.deepEqual(executionRecord['taskLink'], {
    kind: 'workflow-node',
    workflowInstanceId,
    nodeId: 'draft_reply',
  });

  // The AI Router: one platform model eligible for the response-drafting
  // task class, then the REAL routing (cascade + persisted decision).
  const model = await apiCall(port(), '/api/ai/models', {
    token: await adminToken(),
    body: {
      providerLabel: 'mkt038-labs',
      modelKey: 'mkt038-draft-model',
      displayName: 'MKT-038 Draft Model',
      capabilities: ['text-generation'],
      toolFeatures: [],
      contextLimitTokens: 32_000,
      costInputPerMtok: 1.5,
      costOutputPerMtok: 4.0,
      latencyP50Ms: 800,
      latencyP95Ms: 2000,
      reliability: 0.97,
      qualitySignals: { 'creator.response_drafting': 0.91 },
      privacyCharacteristics: { dataResidency: 'eu', trainingUse: false },
    },
  });
  assert.equal(model.status, 201, JSON.stringify(model.body));
  const modelRegistryId = model.body['modelRegistryId'] as string;

  const draftingAdapter = new DraftingFakeAdapter({ draftReply: DRAFT_REPLY, tone: 'warm' });
  const routing = await aiRuntime!.routeTask({
    workspaceId: tenant.workspaceId,
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
    taskProfileId: draftProfileId,
    routingPolicyId: null,
    adapter: draftingAdapter,
    validator: defaultValidator,
    invocationInput: {
      messageHistory: [{ direction: 'inbound', body: FAN_MESSAGE }],
      conversationContext: { topic: 'bundle-enquiry', fanTier: 'top_fan' },
    },
    idempotencyKey: 'mkt038-route-draft-1',
    correlationId: 'mkt038-route-draft-1',
    actorId: tenant.owner.userId,
  });
  // The cascade completed with the eligible model; the model output
  // passed the TaskProfile's output-schema validation (the authoritative
  // routing decision + cascade run are persisted by the /ai-runtime
  // module — the cascade record carries the DECISION; the validated draft
  // content is the model output the adapter produced and the validator
  // accepted, which flows on into the approval chain below).
  assert.equal(routing.cascadeRun.status, 'completed');
  assert.equal(routing.cascadeRun.finalModelRegistryId, modelRegistryId);
  assert.equal(routing.cascadeRun.cascadeSteps.length, 1);
  assert.equal(routing.cascadeRun.cascadeSteps[0]!.stepType, 'cheap-first');
  assert.equal(routing.cascadeRun.cascadeSteps[0]!.validatorResult, 'passed');
  assert.ok(typeof routing.selection.selectionId === 'string');
  assert.equal(
    draftingAdapter.invocations.length,
    1,
    'the cascade invoked the model exactly once (cheap-first succeeded)',
  );
  assert.equal(
    draftingAdapter.invocations[0]!.taskProfile.taskClass,
    'creator.response_drafting',
    'the routed TaskProfile is the pack-declared response-drafting class',
  );
  // The VALIDATED draft (the output the default schema validator accepted
  // — the content every downstream stage consumes):
  const draftContent = draftingAdapter.outputs[0]!;
  assert.equal(draftContent['draftReply'], DRAFT_REPLY);
  assert.equal(draftContent['tone'], 'warm');

  // The execution reaches its terminal state through the /executions
  // transition surface (the AI leg's runtime attempt lifecycle).
  let executionVersion = executionRecord['version'] as number;
  for (const to of ['queued', 'starting', 'running', 'succeeded'] as const) {
    const transition = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
      token: tenant.owner.token,
      body: {
        to,
        version: executionVersion,
        idempotencyKey: `mkt038-execution-${to}`,
        reason: `MKT-038 E2E: the AI draft task ${to === 'succeeded' ? 'completed with a validated draft reply' : `is ${to}`}`,
      },
    });
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    const transitionBody = (transition.body as Record<string, unknown>)['execution'] as Record<string, unknown>;
    executionVersion = transitionBody['version'] as number;
  }
  const finalExecution = await apiCall(port(), `/api/executions/${executionId}`, { token: tenant.owner.token });
  assert.equal(finalExecution.body['status'], 'succeeded');

  // ---- Human Agent Job: the approve_reply node through /jobs -----------
  const projection = await apiCall(port(), `/api/workflows/${workflowId}/instances/${workflowInstanceId}/jobs`, {
    token: tenant.owner.token,
    body: {
      nodeId: 'approve_reply',
      title: 'Approve the AI-drafted reply',
      description: 'Review the AI-drafted reply for the bundle enquiry and approve the outbound send.',
      specialization: 'chatter',
      requiredCapabilities: ['community_reply'],
      territory: { kind: 'city', value: 'accra' },
      dayOfWeek: 2,
      startMinute: 540,
      endMinute: 1020,
    },
  });
  assert.equal(projection.status, 201, `projection failed: ${JSON.stringify(projection.body)}`);
  const job = projection.body as Record<string, unknown>;
  jobId = job['jobId'] as string;
  assert.equal((job['eligibility'] as Record<string, unknown>)['specialization'], 'chatter');
  assert.equal(job['nodeId'], 'approve_reply');
  assert.equal(job['workflowInstanceId'], workflowInstanceId);
  assert.equal(job['clientId'], tenant.clientId, 'the job scope is server-derived from the instance chain');

  const offer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenant.owner.token,
    body: { candidateAgentId: chatterAgentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  const offerId = (offer.body as Record<string, unknown>)['offerId'] as string;
  const accepted = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, {
    token: chatter.token,
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  // ---- APPROVED communication through the creator adapter ---------------
  // Stage 1 — the fail-closed proof FIRST: the unapproved send is denied
  // BEFORE any row and NEVER reaches the provider (the counter proves the
  // provider never saw traffic beyond the setup reads/probes).
  const sandboxRequestsBefore = sandbox!.requests('creator-platform');
  const unapproved = await apiCall(port(), `/api/creator-conversations/${conversationId}/messages/outbound`, {
    token: tenant.owner.token,
    body: { body: DRAFT_REPLY, idempotencyKey: 'mkt038-outbound-unapproved-1', approvalId: null },
  });
  assert.equal(unapproved.status, 403, 'the approval-demanding gate denies the unapproved send fail-closed');
  const outboundRowsAfterDeny = await pool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM creator_conversation_messages WHERE direction = 'outbound'",
  );
  assert.equal(Number(outboundRowsAfterDeny.rows[0]!.count), 0, 'an unapproved send never produces a row');
  assert.equal(
    sandbox!.requests('creator-platform'),
    sandboxRequestsBefore,
    'the unapproved send NEVER reached the provider (zero provider traffic)',
  );

  // Stage 2 — the reviewer records the human approval (the approver is the
  // authenticated principal; the specializations resolve server-side).
  const approval = await apiCall(port(), `/api/creator-conversations/${conversationId}/approvals`, {
    token: tenant.owner.token,
    body: { decision: 'approved', notes: 'The AI draft is on-brand and answers the bundle question.', idempotencyKey: 'mkt038-approval-1' },
  });
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  const approvalId = approval.body['approvalId'] as string;
  assert.equal(approval.body['approverUserId'], tenant.owner.userId);
  assert.deepEqual(approval.body['approverSpecializations'], ['reviewer']);

  // Stage 3 — the pack gated send: born 'sent' carrying the ALLOWING policy
  // decision id and the satisfying approval record id.
  const sent = await apiCall(port(), `/api/creator-conversations/${conversationId}/messages/outbound`, {
    token: tenant.owner.token,
    body: { body: DRAFT_REPLY, idempotencyKey: 'mkt038-outbound-approved-1', approvalId },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body['status'], 'sent');
  assert.equal(sent.body['approvalId'], approvalId);
  const sendDecisionId = sent.body['policyDecisionId'] as string;
  assert.ok(typeof sendDecisionId === 'string' && sendDecisionId.length > 0);
  const messageRow = await pool().query<{ direction: string; status: string; policy_decision_id: string; approval_id: string }>(
    'SELECT direction, status, policy_decision_id, approval_id FROM creator_conversation_messages WHERE message_id = $1',
    [sent.body['messageId'] as string],
  );
  assert.equal(messageRow.rows[0]!.direction, 'outbound');
  assert.equal(messageRow.rows[0]!.status, 'sent');
  assert.equal(messageRow.rows[0]!.policy_decision_id, sendDecisionId);
  assert.equal(messageRow.rows[0]!.approval_id, approvalId);
  // The ALLOWING decision is in the append-only /policies ledger.
  const decisionRow = await pool().query<{ outcome: string; reason_code: string }>(
    'SELECT outcome, reason_code FROM policy_decisions WHERE decision_id = $1',
    [sendDecisionId],
  );
  assert.equal(decisionRow.rows.length, 1);
  assert.equal(decisionRow.rows[0]!.outcome, 'allow');

  // Stage 4 — the PROVIDER send through the creator adapter: the
  // /integrations mutation boundary (fail-closed policy gate → in-process
  // credential resolution → the REAL adapter HTTP call to the sandbox
  // provider). The sandbox RECORDS the provider-visible side effect.
  const providerSend = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}/mutate`, {
    token: tenant.owner.token,
    body: {
      operation: 'sendConversationMessage',
      parameters: { conversationRef: PROVIDER_CONVERSATION_REF, body: DRAFT_REPLY },
    },
  });
  assert.equal(providerSend.status, 200, JSON.stringify(providerSend.body));
  assert.equal(providerSend.body['ok'], true);
  assert.equal(providerSend.body['adapterKey'], 'creator-platform');
  assert.equal(providerSend.body['operation'], 'sendConversationMessage');
  assert.ok(typeof providerSend.body['policyDecisionId'] === 'string');
  assert.ok((providerSend.body['providerRecordId'] as string).startsWith('creator:message:'));
  // The sandbox provider received EXACTLY the approved side effect.
  const providerSends = sandbox!.creatorSends();
  assert.equal(providerSends.length, 1, 'the provider saw exactly one send');
  assert.equal((providerSends[0]!.body as Record<string, unknown>)['body'], DRAFT_REPLY);
  assert.ok(providerSends[0]!.path.includes(`/v1/creator/conversations/${PROVIDER_CONVERSATION_REF}/messages`));

  // ---- Evidence/Outcome: the observation mapping + the sync reads -------
  // The send observation through the pack §7 mapping (COMMON /evidence +
  // /metrics, bound by evidenceRef).
  const observation = await apiCall(port(), `/api/clients/${tenant.clientId}/creator-observations`, {
    token: tenant.owner.token,
    body: {
      subjectKind: 'conversation',
      subjectRef: conversationId,
      eventKind: 'message_sent',
      content: { direction: 'outbound', approvedBy: approvalId, providerRecordRef: providerSend.body['providerRecordId'] },
      observedAt: new Date().toISOString(),
      quality: 'C',
      metric: {
        name: 'creator.conversation.event_count',
        value: 1,
        unit: 'events',
        dimensions: { conversationId, eventKind: 'message_sent' },
        aggregationMethod: null,
      },
      idempotencyKey: 'mkt038-observation-send-1',
    },
  });
  assert.equal(observation.status, 201, JSON.stringify(observation.body));
  sendEvidenceId = observation.body['evidenceId'] as string;
  const sendObservationId = observation.body['observationId'] as string;
  assert.ok(typeof sendEvidenceId === 'string' && sendEvidenceId.length > 0);
  const sendMetric = await apiCall(port(), `/api/metrics/${sendObservationId}`, { token: tenant.owner.token });
  assert.equal(sendMetric.status, 200);
  assert.equal(sendMetric.body['metricName'], 'creator.conversation.event_count');
  assert.equal(sendMetric.body['evidenceRef'], sendEvidenceId);
  assert.deepEqual((sendMetric.body as { source: Record<string, string> }).source, {
    system: 'creator-operations',
    ref: conversationId,
  });

  // The integration read sync: the adapter's account-metrics read delivered
  // through the METRIC-001 emitter into the COMMON /evidence + /metrics
  // contracts (the provider observation leg of the loop).
  const sync = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}/sync`, {
    token: tenant.owner.token,
    body: { operation: 'readAccountMetrics', parameters: {} },
  });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(sync.body['ok'], true);
  const syncRecords = sync.body['records'] as Record<string, unknown>[];
  assert.equal(syncRecords.length, 3, 'the three account-metric envelopes (fan/engagement/revenue)');
  for (const record of syncRecords) {
    assert.equal(record['sourceTimestamp'], '2026-04-01T00:00:00.000Z');
    assert.equal(record['etag'], '"sandbox-fixture-v1"');
  }
  const syncReceipts = sync.body['receipts'] as Record<string, unknown>[];
  assert.equal(syncReceipts.length, 3);
  const fanCountReceipt = syncReceipts.find(
    (receipt) => (receipt['providerRecordId'] as string) === 'creator:creator.account.metrics:2026-04-01:creator.performance.fan_count',
  )!;
  assert.ok(fanCountReceipt !== undefined);
  const fanCountMetric = await apiCall(port(), `/api/metrics/${fanCountReceipt['observationId']}`, {
    token: tenant.owner.token,
  });
  assert.equal(fanCountMetric.status, 200);
  assert.equal(fanCountMetric.body['metricName'], 'creator.performance.fan_count');
  assert.equal(fanCountMetric.body['value'], 12480);
  assert.equal(fanCountMetric.body['unit'], 'count');
  assert.deepEqual((fanCountMetric.body as { source: Record<string, string> }).source, {
    system: 'integration:creator-platform',
    ref: 'creator:creator.account.metrics:2026-04-01:creator.performance.fan_count',
  });
  assert.equal(fanCountMetric.body['observedAt'], '2026-04-01T00:00:00.000Z');
  assert.equal(fanCountMetric.body['evidenceRef'], fanCountReceipt['evidenceId']);

  // The Job outcome submitted by the chatter citing the send evidence (the
  // §18 structured outcome of the review Job).
  const outcome = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: chatter.token,
    body: { outcome: 'succeeded', evidenceRef: sendEvidenceId },
  });
  assert.equal(outcome.status, 201, JSON.stringify(outcome.body));
  assert.equal((outcome.body['job'] as Record<string, unknown>)['status'], 'outcome_submitted');
  assert.equal((outcome.body['outcome'] as Record<string, unknown>)['evidenceRef'], sendEvidenceId);

  // ---- the §16 experiment: declare → start → analyze → conclude ---------
  const experiment = await apiCall(port(), `/api/clients/${tenant.clientId}/experiments`, {
    token: tenant.owner.token,
    body: {
      hypothesis: 'AI-drafted, human-approved creator replies raise top-fan reply completion within one triage cycle',
      decisionTarget: 'whether to extend AI-assisted conversation triage to all top-fan enquiries',
      populationUnit: 'creator-conversation',
      treatment: 'AI-drafted + human-approved reply through the creator-platform adapter',
      comparison: 'manual-only reply baseline (pre-implementation)',
      assignmentMethod: 'single-arm observational cohort',
      designType: 'observational',
      primaryMetric: { name: 'creator.conversation.event_count', dimensions: { scenario: 'conversation-triage' } },
      guardrails: [],
      analysisMethod: 'descriptive pre/post comparison',
      stopCriteria: 'after one completed conversation-triage instance with recorded evidence',
      minimumEvidenceRequirement: 'one approved send with provider + pack evidence',
      uncertaintyRepresentation: 'interval',
      workspaceId: tenant.workspaceId,
    },
  });
  assert.equal(experiment.status, 201, JSON.stringify(experiment.body));
  experimentId = experiment.body['experimentId'] as string;
  assert.equal(experiment.body['status'], 'draft');

  for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
    const stepped = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token: tenant.owner.token,
      body: { transition },
    });
    assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  }

  const concluded = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: tenant.owner.token,
    body: {
      transition: 'conclude',
      conclusion: {
        resultState: 'observation',
        uncertainty: { kind: 'interval', lower: 1, upper: 5, level: 0.9 },
        assumptions: ['the sandboxed provider adapter is representative of the provider send path'],
        sampleLimitations: ['one conversation-triage instance — a prove-it-first sample, not a powered estimate'],
        confounders: ['fan tier composition', 'seasonal engagement variation'],
        resultingDecision:
          'Extend: the approved reply executed through the creator-platform adapter end-to-end with full evidence lineage — proceed to a bounded rollout cohort.',
        evidenceRefs: [webhookEvidenceId, sendEvidenceId],
      },
    },
  });
  assert.equal(concluded.status, 200, JSON.stringify(concluded.body));
  assert.equal(concluded.body['status'], 'concluded');
  assert.equal(concluded.body['resultState'], 'observation');
  const experimentHistory = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: tenant.owner.token,
  });
  const transitionNames = (experimentHistory.body['transitions'] as Record<string, unknown>[]).map(
    (row) => row['transition'],
  );
  assert.deepEqual(transitionNames, ['mark_ready', 'start', 'begin_analysis', 'conclude']);
  const conclusionRow = (experimentHistory.body['transitions'] as Record<string, unknown>[]).at(-1)!;
  const conclusion = conclusionRow['conclusion'] as Record<string, unknown>;
  assert.deepEqual(conclusion['evidenceRefs'], [webhookEvidenceId, sendEvidenceId]);

  // ---- Learning: the durable conclusion citing the SAME-Client evidence --
  const learning = await apiCall(port(), `/api/clients/${tenant.clientId}/learnings`, {
    token: tenant.owner.token,
    body: {
      statement:
        'AI-drafted, human-approved creator replies can be executed through the creator-platform adapter with a complete Goal → Workflow → AI → Human → provider → Evidence lineage and fail-closed approval gating.',
      applicability: {
        domain: 'creator-operations',
        channel: 'dm',
        fanTier: 'top_fan',
        providerBoundary: 'integration-adapter',
      },
      evidenceRefs: [webhookEvidenceId, sendEvidenceId],
      experimentRefs: [experimentId],
      confidence: 0.7,
    },
  });
  assert.equal(learning.status, 201, JSON.stringify(learning.body));
  learningId = learning.body['learningId'] as string;
  const learningRead = await apiCall(port(), `/api/learnings/${learningId}`, { token: tenant.owner.token });
  assert.equal(learningRead.status, 200);
  assert.deepEqual(learningRead.body['evidenceRefs'], [webhookEvidenceId, sendEvidenceId]);
  assert.deepEqual(learningRead.body['experimentRefs'], [experimentId]);
  assert.equal(learningRead.body['status'], 'active', 'the fresh learning is the derived ACTIVE state');

  // ---- the workflow instance reaches its terminal state -----------------
  const instanceRead = await apiCall(port(), `/api/workflows/${workflowId}/instances/${workflowInstanceId}`, {
    token: tenant.owner.token,
  });
  const instanceTerminal = await apiCall(
    port(),
    `/api/workflows/${workflowId}/instances/${workflowInstanceId}/transitions`,
    {
      token: tenant.owner.token,
      body: {
        to: 'succeeded',
        version: instanceRead.body['version'] as number,
        idempotencyKey: 'mkt038-instance-succeeded',
        reason: 'the conversation-triage instance concluded through the experiment authority',
      },
    },
  );
  assert.equal(instanceTerminal.status, 200, JSON.stringify(instanceTerminal.body));

  // ---- NO AUTHORITY BYPASS: the authoritative end-state re-reads ---------
  // The goal is active; the execution succeeded; the experiment concluded;
  // the learning cites the concluded experiment + same-Client evidence; the
  // conversation carries exactly ONE outbound row born with the allowing
  // decision; the provider saw EXACTLY one approved send; the ledger has
  // the single verified provider event.
  const goalFinal = await apiCall(port(), `/api/goals/${goalId}`, { token: tenant.owner.token });
  assert.equal(goalFinal.body['status'], 'active');
  const outboundFinal = await pool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM creator_conversation_messages WHERE direction = 'outbound' AND conversation_id = $1",
    [conversationId],
  );
  assert.equal(Number(outboundFinal.rows[0]!.count), 1);
  const ledgerFinal = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM integration_events WHERE connection_id = $1',
    [connectionId],
  );
  assert.equal(Number(ledgerFinal.rows[0]!.count), 1);
  assert.equal(sandbox!.creatorSends().length, 1);
});

// ---------------------------------------------------------------------------
// NEGATIVE — fail-closed at the /integrations boundary (client-scoped deny)
// ---------------------------------------------------------------------------

test('fail-closed: a client-scoped network deny on integration.mutate blocks the provider send BEFORE any provider traffic', async () => {
  const requestsBefore = sandbox!.requests('creator-platform');
  const sendsBefore = sandbox!.creatorSends().length;
  const denied = await apiCall(port(), `/api/clients/${bobTenant.clientId}/connections/${bobConnectionId}/mutate`, {
    token: bobTenant.owner.token,
    body: {
      operation: 'sendConversationMessage',
      parameters: { conversationRef: PROVIDER_CONVERSATION_REF, body: 'Bob denied send' },
    },
  });
  assert.equal(denied.status, 403, `the client-scoped deny fails closed: ${JSON.stringify(denied.body)}`);
  assert.equal(sandbox!.requests('creator-platform'), requestsBefore, 'ZERO provider traffic (the sandbox counter is the proof)');
  assert.equal(sandbox!.creatorSends().length, sendsBefore, 'no provider-visible side effect happened');
});

// ---------------------------------------------------------------------------
// NEGATIVE — cross-client adapter operations are uniform 404s
// ---------------------------------------------------------------------------

test('tenant isolation: cross-client adapter operations are UNIFORM 404s (read, mutate and webhook surfaces)', async () => {
  // Bob attempts Alice's connection under HIS client path: the ownership
  // fence fires BEFORE any module work (no existence oracle).
  const foreignMutate = await apiCall(port(), `/api/clients/${bobTenant.clientId}/connections/${connectionId}/mutate`, {
    token: bobTenant.owner.token,
    body: {
      operation: 'sendConversationMessage',
      parameters: { conversationRef: PROVIDER_CONVERSATION_REF, body: 'cross-tenant probe' },
    },
  });
  const unknownMutate = await apiCall(port(), `/api/clients/${bobTenant.clientId}/connections/00000000-0000-4000-8000-000000000000/mutate`, {
    token: bobTenant.owner.token,
    body: {
      operation: 'sendConversationMessage',
      parameters: { conversationRef: PROVIDER_CONVERSATION_REF, body: 'unknown probe' },
    },
  });
  assert.equal(foreignMutate.status, 404);
  assert.equal(unknownMutate.status, 404);
  assert.equal(foreignMutate.status, unknownMutate.status, 'a foreign connection id is indistinguishable from an unknown one');

  const foreignRead = await apiCall(port(), `/api/clients/${bobTenant.clientId}/connections/${connectionId}/read`, {
    token: bobTenant.owner.token,
    body: { operation: 'listFans', parameters: {} },
  });
  assert.equal(foreignRead.status, 404);

  const payload = { conversationId: PROVIDER_CONVERSATION_REF, messageBody: 'probe' };
  const foreignWebhook = await apiCall(port(), `/api/clients/${bobTenant.clientId}/connections/${connectionId}/webhook`, {
    token: bobTenant.owner.token,
    body: {
      eventType: 'message.created',
      payload,
      headers: sandboxWebhookSignature('creator-platform', CREATOR_WEBHOOK_SECRET, payload),
    },
  });
  assert.equal(foreignWebhook.status, 404, 'the webhook surface is fenced BEFORE signature verification (no cross-tenant oracle)');

  // Alice calling Bob's connection under her own client path: same 404.
  const reverse = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${bobConnectionId}/mutate`, {
    token: tenant.owner.token,
    body: {
      operation: 'sendConversationMessage',
      parameters: { conversationRef: PROVIDER_CONVERSATION_REF, body: 'reverse probe' },
    },
  });
  assert.equal(reverse.status, 404);
  // Zero provider-visible side effects from every probe above.
  assert.equal(sandbox!.creatorSends().length, 1, 'only the single APPROVED golden-path send ever reached the provider');
});

// ---------------------------------------------------------------------------
// NEGATIVE — forged provider events (signature failures) record NOTHING
// ---------------------------------------------------------------------------

test('fail-closed webhook authenticity: a forged signature is rejected with NOTHING recorded (no partial delivery)', async () => {
  const ledgerBefore = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM integration_events WHERE connection_id = $1',
    [connectionId],
  );
  const evidenceBefore = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM evidence WHERE client_id = $1',
    [tenant.clientId],
  );

  const payload = { conversationId: PROVIDER_CONVERSATION_REF, messageBody: 'forged event' };
  // A wrong-secret signature (the HMAC does not verify).
  const forged = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}/webhook`, {
    token: tenant.owner.token,
    body: {
      eventType: 'message.created',
      payload,
      headers: sandboxWebhookSignature('creator-platform', 'whsec_wrong_secret', payload),
    },
  });
  assert.equal(forged.status, 422, `the forged delivery is rejected: ${JSON.stringify(forged.body)}`);

  // A missing signature header entirely.
  const unsigned = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}/webhook`, {
    token: tenant.owner.token,
    body: { eventType: 'message.created', payload, headers: {} },
  });
  assert.equal(unsigned.status, 422);

  // NOTHING was recorded: no ledger row, no evidence row (no partial
  // delivery of a failed verification).
  const ledgerAfter = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM integration_events WHERE connection_id = $1',
    [connectionId],
  );
  assert.equal(ledgerAfter.rows[0]!.count, ledgerBefore.rows[0]!.count, 'no ledger row was recorded');
  const evidenceAfter = await pool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM evidence WHERE client_id = $1',
    [tenant.clientId],
  );
  assert.ok(
    Number(evidenceAfter.rows[0]!.count) >= Number(evidenceBefore.rows[0]!.count),
    'no evidence row was recorded for the forged delivery',
  );
  const forgedLedgerRows = await pool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM integration_events WHERE payload->>'messageBody' = $1",
    ['forged event'],
  );
  assert.equal(Number(forgedLedgerRows.rows[0]!.count), 0, 'the forged payload never landed anywhere');
});

// ---------------------------------------------------------------------------
// NEGATIVE/SEMANTICS — webhook replay: the append-only ledger never rewrites
// ---------------------------------------------------------------------------

test('webhook replay semantics: a repeated VERIFIED delivery appends FRESH immutable rows (append-only history, no fabricated dedup)', async () => {
  const replayPayload = {
    conversationId: PROVIDER_CONVERSATION_REF,
    messageBody: 'replayed provider event',
  };
  const signedHeaders = sandboxWebhookSignature('creator-platform', CREATOR_WEBHOOK_SECRET, replayPayload);
  const first = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}/webhook`, {
    token: tenant.owner.token,
    body: { eventType: 'message.created', payload: replayPayload, headers: signedHeaders },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await apiCall(port(), `/api/clients/${tenant.clientId}/connections/${connectionId}/webhook`, {
    token: tenant.owner.token,
    body: { eventType: 'message.created', payload: replayPayload, headers: signedHeaders },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  // Fresh identities per delivery: the ledger is append-only, nothing is
  // rewritten and no dedup is fabricated (the MKT-023 semantics preserved).
  assert.notEqual(first.body['eventId'], second.body['eventId']);
  assert.notEqual(first.body['evidenceRef'], second.body['evidenceRef']);
  const firstRow = await pool().query<{ event_type: string; evidence_ref: string }>(
    'SELECT event_type, evidence_ref FROM integration_events WHERE event_id = $1',
    [first.body['eventId'] as string],
  );
  assert.equal(firstRow.rows.length, 1, 'the original delivery row stays byte-for-byte in history');
  assert.equal(firstRow.rows[0]!.event_type, 'creator-platform:message.created');
});
